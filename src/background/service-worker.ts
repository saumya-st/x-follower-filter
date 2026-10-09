import type { AiEstimate, AppState, Broadcast, ContentRequest, PanelRequest } from "../shared/messages";
import type { Account, AiRunProgress, ListKind, PageInfo, Queue, QueueItem, ScanProgress, ScanSnapshot, Settings } from "../shared/types";
import { AI_BATCH_SIZE, ANTHROPIC_ORIGIN } from "../shared/defaults";
import { applyScanDiff } from "../shared/history";
import { addToQueue, clearFinished, nextQueued, removeQueued } from "../shared/queue";
import { hashText, normalizeHandle } from "../shared/rules";
import {
  deleteSnapshot, getAiLabels, getHistory, getQueue, getSettings, getSnapshot, listSnapshots, mergeAccounts, removeAccounts,
  saveAiLabels, saveHistory, saveQueue, saveSettings, saveSnapshot, snapshotKey,
} from "../shared/storage";
import { classifyBatch, costUsd, countBatchTokens, describeError, estimateOutputTokens, makeClient } from "./claude";
import {
  ALARM_CLOSE_WORKER, ALARM_RESUME, closeWorkerTab, focusWorkerTab, forgetTab, isContentAlive, isWorkerTab, kick, notifyReady,
  onWorkerTabClosed, pageByTab, recoverOnStartup, requestPause, sendToTab, setWorkerHooks, waitForReady,
} from "./worker";

const X_URL_RE = /^https:\/\/(x|twitter)\.com\//;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// ---------- in-memory state (rebuilt lazily after the worker is restarted) ----------

const snapshotCache = new Map<string, ScanSnapshot>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Account map as it stood before the current scan started, per snapshot key (for diffing). */
const preScanAccounts = new Map<string, Record<string, Account>>();
let scanProgress: ScanProgress | null = null;
let scanTabId: number | null = null;
let aiProgress: AiRunProgress | null = null;
let aiCancel = false;

function broadcast(msg: Broadcast): void {
  chrome.runtime.sendMessage(msg).catch(() => { /* no panel open */ });
}

async function loadSnapshot(owner: string, list: ListKind, create = false): Promise<ScanSnapshot | null> {
  const key = snapshotKey(owner, list);
  const cached = snapshotCache.get(key);
  if (cached) return cached;
  let s = await getSnapshot(owner, list);
  if (!s && create) {
    s = { owner, list, startedAt: Date.now(), updatedAt: Date.now(), complete: false, accounts: {} };
  }
  if (s) snapshotCache.set(key, s);
  return s;
}

function scheduleSave(s: ScanSnapshot, delay = 1500): void {
  const key = snapshotKey(s.owner, s.list);
  const t = saveTimers.get(key);
  if (t) clearTimeout(t);
  saveTimers.set(key, setTimeout(() => { saveTimers.delete(key); void saveSnapshot(s); }, delay));
}

async function flushSave(s: ScanSnapshot): Promise<void> {
  const key = snapshotKey(s.owner, s.list);
  const t = saveTimers.get(key);
  if (t) { clearTimeout(t); saveTimers.delete(key); }
  await saveSnapshot(s);
}

// ---------- queue hooks ----------

setWorkerHooks({
  broadcast: (queue, finished) => broadcast({ type: "QUEUE_UPDATED", queue, ...(finished ? { finished } : {}) }),
  onActionDone: async (item: QueueItem) => {
    const s = await loadSnapshot(item.owner, item.list);
    if (!s) return;
    removeAccounts(s, [item.handle], true);
    scheduleSave(s, 500);
  },
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_RESUME) {
    void (async () => {
      const q = await getQueue();
      if (q.status === "capped") {
        q.status = nextQueued(q) ? "running" : "idle";
        delete q.cappedUntil;
        await saveQueue(q);
      }
      kick();
    })();
  } else if (alarm.name === ALARM_CLOSE_WORKER) {
    void (async () => {
      const q = await getQueue();
      if (q.status === "idle" && !nextQueued(q)) await closeWorkerTab();
    })();
  }
});

void recoverOnStartup();

// ---------- tab helpers for scans ----------

async function findXTab(): Promise<chrome.tabs.Tab> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id != null && active.url && X_URL_RE.test(active.url) && !isWorkerTab(active.id)) return active;
  const all = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  const live = all.find((t) => t.id != null && !isWorkerTab(t.id));
  if (live) return live;
  const created = await chrome.tabs.create({ url: "https://x.com/home", active: true });
  await waitForReady(created.id!, 30000);
  return created;
}

async function ensureOnList(tabId: number, owner: string, list: ListKind): Promise<void> {
  const page = await sendToTab<PageInfo>(tabId, { type: "GET_PAGE_INFO" }).catch(() => null);
  if (page && page.owner === owner && page.list === list) return;
  const waiter = waitForReady(tabId, 30000);
  await chrome.tabs.update(tabId, { url: `https://x.com/${owner}/${list}` });
  await waiter;
  await new Promise((r) => setTimeout(r, 2000));
}

async function loggedInHandle(tabId: number): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const page = await sendToTab<PageInfo>(tabId, { type: "GET_PAGE_INFO" }).catch(() => null);
    if (page?.loggedInHandle) return page.loggedInHandle;
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("Could not detect your X account. Make sure you are logged in on x.com, then try again.");
}

// ---------- content script messages ----------

async function handleContent(msg: ContentRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  switch (msg.type) {
    case "CS_READY": {
      notifyReady(tabId, msg.page);
      if (!isWorkerTab(tabId)) broadcast({ type: "PAGE_INFO", page: msg.page });
      return { ok: true };
    }
    case "SCAN_BATCH": {
      const s = await loadSnapshot(msg.owner, msg.list, true);
      if (!s) return;
      mergeAccounts(s, msg.accounts as Account[]);
      scheduleSave(s);
      scanProgress = msg.progress;
      scanTabId = tabId;
      broadcast({ type: "SCAN_PROGRESS", progress: msg.progress });
      return { ok: true };
    }
    case "SCAN_FINISHED": {
      const s = await loadSnapshot(msg.owner, msg.list, true);
      if (s) {
        const key = snapshotKey(msg.owner, msg.list);
        if (msg.progress.complete) {
          s.complete = true;
          const before = preScanAccounts.get(key) ?? {};
          const scanned = Object.values(s.accounts).filter((a) => a.lastSeen >= s.startedAt).map((a) => a.handle);
          const history = await getHistory(msg.owner, msg.list);
          const r = applyScanDiff(s, history, scanned, before);
          await saveHistory(msg.owner, msg.list, r.history);
        }
        preScanAccounts.delete(key);
        await flushSave(s);
      }
      scanProgress = { ...msg.progress, running: false };
      broadcast({ type: "SCAN_PROGRESS", progress: scanProgress });
      broadcast({ type: "STATE_CHANGED" });
      return { ok: true };
    }
    case "WORKER_PAUSE_REQUEST": {
      requestPause();
      const q = await getQueue();
      q.status = "paused";
      await saveQueue(q);
      broadcast({ type: "QUEUE_UPDATED", queue: q });
      return { ok: true };
    }
  }
}

// ---------- panel / options messages ----------

async function getState(): Promise<AppState> {
  const [settings, queue, snapshots, hasPerm] = await Promise.all([
    getSettings(),
    getQueue(),
    listSnapshots(),
    chrome.permissions.contains({ origins: [ANTHROPIC_ORIGIN] }),
  ]);
  let page: PageInfo | null = null;
  try {
    const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (tab?.id != null && tab.url && X_URL_RE.test(tab.url) && !isWorkerTab(tab.id)) {
      page = pageByTab.get(tab.id) ?? (await sendToTab<PageInfo>(tab.id, { type: "GET_PAGE_INFO" }).catch(() => null));
    }
    if (!page) {
      // Any other x.com tab we know about (not the worker).
      for (const [id, p] of pageByTab) if (!isWorkerTab(id) && p.loggedInHandle) { page = p; break; }
    }
  } catch { /* ignore */ }
  return { page, scan: scanProgress, queue, ai: aiProgress, settings, snapshots, hasAnthropicPermission: hasPerm };
}

async function startScan(list: ListKind): Promise<{ ok: boolean; error?: string }> {
  if (scanProgress?.running) return { ok: false, error: "A scan is already running." };
  const tab = await findXTab();
  const tabId = tab.id!;
  if (!(await isContentAlive(tabId))) {
    await chrome.tabs.reload(tabId);
    await waitForReady(tabId, 30000);
  }
  const me = await loggedInHandle(tabId);
  await ensureOnList(tabId, me, list);
  const s = (await loadSnapshot(me, list, true))!;
  preScanAccounts.set(snapshotKey(me, list), { ...s.accounts });
  s.startedAt = Date.now();
  scanTabId = tabId;
  scanProgress = { owner: me, list, scanned: Object.keys(s.accounts).length, newThisRun: 0, idleRounds: 0, running: true, complete: false };
  await sendToTab(tabId, { type: "SCAN_START", list, known: Object.keys(s.accounts) });
  broadcast({ type: "SCAN_PROGRESS", progress: scanProgress });
  return { ok: true };
}

async function queueAdd(req: Extract<PanelRequest, { type: "QUEUE_ADD" }>) {
  const settings = await getSettings();
  const q = await getQueue();
  const r = addToQueue(q, req, { protectedHandles: settings.protectedHandles, self: req.owner });
  if (!req.preview && r.added > 0) {
    // Make sure the logged-in account owns this list before touching anything.
    let me: string | null = null;
    for (const [id, p] of pageByTab) if (!isWorkerTab(id) && p.loggedInHandle) { me = p.loggedInHandle; break; }
    if (me && me !== req.owner) {
      removeQueued(q, req.handles);
      return { ok: false, added: 0, skipped: 0, duplicates: 0, error: `You are logged in as @${me} but this list belongs to @${req.owner}.` };
    }
  }
  if (q.status === "idle" && r.added) q.status = "running";
  await saveQueue(q);
  broadcast({ type: "QUEUE_UPDATED", queue: q });
  if (r.added && q.status !== "paused") kick();
  return { ok: true, ...r };
}

async function updateQueue(fn: (q: Queue) => void): Promise<Queue> {
  const q = await getQueue();
  fn(q);
  await saveQueue(q);
  broadcast({ type: "QUEUE_UPDATED", queue: q });
  return q;
}

function batchesOf<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function aiTargets(owner: string, list: ListKind, handles: string[]): Promise<Account[]> {
  const s = await loadSnapshot(owner, list);
  if (!s) return [];
  return handles.map((h) => s.accounts[normalizeHandle(h)]).filter((a): a is Account => !!a);
}

async function aiEstimate(req: Extract<PanelRequest, { type: "AI_ESTIMATE" }>): Promise<AiEstimate> {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("Add your Anthropic API key in Options first.");
  const accounts = await aiTargets(req.owner, req.list, req.handles);
  const batches = batchesOf(accounts, AI_BATCH_SIZE);
  const client = makeClient(settings.apiKey);
  let inputTokens = 0;
  if (batches.length) {
    const sample = batches[0]!;
    const n = await countBatchTokens(client, settings.model, settings.labels, sample, settings.aiAllowOther);
    const perAccount = sample.length ? Math.max(0, n - 600) / sample.length : 0;
    inputTokens = batches.reduce((sum, b) => sum + 600 + Math.round(perAccount * b.length), 0);
  }
  const estOutputTokens = estimateOutputTokens(accounts.length);
  return { accounts: accounts.length, batches: batches.length, inputTokens, estOutputTokens, costUsd: costUsd(settings.model, inputTokens, estOutputTokens), model: settings.model };
}

async function aiRun(req: Extract<PanelRequest, { type: "AI_RUN" }>): Promise<{ ok: boolean; error?: string }> {
  if (aiProgress?.running) return { ok: false, error: "AI labelling is already running." };
  const settings = await getSettings();
  if (!settings.apiKey) return { ok: false, error: "Add your Anthropic API key in Options first." };
  const accounts = await aiTargets(req.owner, req.list, req.handles);
  const client = makeClient(settings.apiKey);
  const labels = await getAiLabels();
  aiCancel = false;
  aiProgress = { running: true, total: accounts.length, done: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  broadcast({ type: "AI_PROGRESS", progress: aiProgress });

  void (async () => {
    try {
      for (const batch of batchesOf(accounts, AI_BATCH_SIZE)) {
        if (aiCancel) break;
        let result;
        try {
          result = await classifyBatch(client, settings.model, settings.labels, batch, settings.aiAllowOther);
        } catch (e) {
          throw new Error(describeError(e));
        }
        const byHandle = new Map(result.results.map((r) => [normalizeHandle(r.handle), r]));
        const now = Date.now();
        for (const a of batch) {
          const r = byHandle.get(a.handle);
          if (!r) continue;
          labels[a.handle] = { label: r.label, confidence: r.confidence, bioHash: hashText(a.bio), model: result.model, at: now };
        }
        await saveAiLabels(labels);
        aiProgress = {
          ...aiProgress!,
          done: aiProgress!.done + batch.length,
          inputTokens: aiProgress!.inputTokens + result.inputTokens,
          outputTokens: aiProgress!.outputTokens + result.outputTokens,
        };
        aiProgress.costUsd = costUsd(settings.model, aiProgress.inputTokens, aiProgress.outputTokens);
        broadcast({ type: "AI_PROGRESS", progress: aiProgress });
      }
      aiProgress = { ...aiProgress!, running: false };
    } catch (e) {
      aiProgress = { ...aiProgress!, running: false, error: e instanceof Error ? e.message : String(e) };
    }
    broadcast({ type: "AI_PROGRESS", progress: aiProgress });
    broadcast({ type: "STATE_CHANGED" });
  })();

  return { ok: true };
}

async function handlePanel(msg: PanelRequest): Promise<unknown> {
  switch (msg.type) {
    case "GET_STATE": return getState();
    case "START_SCAN": return startScan(msg.list);
    case "STOP_SCAN": {
      if (scanTabId != null) await sendToTab(scanTabId, { type: "SCAN_STOP" }).catch(() => undefined);
      return { ok: true };
    }
    case "GET_SNAPSHOT": {
      const s = await loadSnapshot(msg.owner, msg.list);
      return s ? { ...s, accounts: { ...s.accounts } } : null;
    }
    case "CLEAR_SNAPSHOT": {
      snapshotCache.delete(snapshotKey(msg.owner, msg.list));
      await deleteSnapshot(msg.owner, msg.list);
      if (scanProgress && scanProgress.owner === msg.owner && scanProgress.list === msg.list) scanProgress = null;
      broadcast({ type: "STATE_CHANGED" });
      return { ok: true };
    }
    case "QUEUE_ADD": return queueAdd(msg);
    case "QUEUE_REMOVE": {
      await updateQueue((q) => { removeQueued(q, msg.handles); if (!nextQueued(q) && q.status === "running") q.status = "idle"; });
      return { ok: true };
    }
    case "QUEUE_PAUSE": {
      requestPause();
      await updateQueue((q) => { q.status = "paused"; });
      return { ok: true };
    }
    case "QUEUE_RESUME": {
      const q = await updateQueue((q) => { q.status = nextQueued(q) ? "running" : "idle"; delete q.lastError; delete q.cappedUntil; });
      if (nextQueued(q)) kick();
      return { ok: true };
    }
    case "QUEUE_CLEAR_DONE": {
      await updateQueue((q) => clearFinished(q));
      return { ok: true };
    }
    case "GET_QUEUE": return getQueue();
    case "FOCUS_WORKER_TAB": return { ok: await focusWorkerTab() };
    case "GET_SETTINGS": return getSettings();
    case "SAVE_SETTINGS": {
      await saveSettings(msg.settings as Settings);
      broadcast({ type: "STATE_CHANGED" });
      return { ok: true };
    }
    case "AI_ESTIMATE": return aiEstimate(msg);
    case "AI_RUN": return aiRun(msg);
    case "AI_CANCEL": {
      aiCancel = true;
      return { ok: true };
    }
    case "GET_AI_LABELS": return getAiLabels();
    case "OPEN_OPTIONS": {
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    }
  }
}

chrome.runtime.onMessage.addListener((msg: PanelRequest | ContentRequest, sender, sendResponse) => {
  const p = sender.tab ? handleContent(msg as ContentRequest, sender) : handlePanel(msg as PanelRequest);
  p.then((r) => sendResponse(r ?? { ok: true })).catch((e: unknown) => sendResponse({ __error: e instanceof Error ? e.message : String(e) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  onWorkerTabClosed(tabId);
  if (scanTabId === tabId && scanProgress?.running) {
    scanProgress = { ...scanProgress, running: false, error: "Tab closed." };
    broadcast({ type: "SCAN_PROGRESS", progress: scanProgress });
  }
});
