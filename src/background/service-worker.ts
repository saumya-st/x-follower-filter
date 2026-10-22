import type { AiEstimate, AppState, Broadcast, ContentRequest, PanelRequest } from "../shared/messages";
import type { Account, AiRunProgress, ListKind, PageInfo, Queue, QueueItem, ScanProgress, ScanSnapshot, Settings, WatchState } from "../shared/types";
import { AI_BATCH_SIZE, ANTHROPIC_ORIGIN, WATCH_INTERVALS_H } from "../shared/defaults";
import { applyScanDiff } from "../shared/history";
import { WATCH_ALARM, badgeText, clampIntervalHours, markSeen, notificationText, recordCheck, recordFailure } from "../shared/watch";
import { addToQueue, clearFinished, nextQueued, removeQueued } from "../shared/queue";
import { hashText, normalizeHandle } from "../shared/rules";
import {
  deleteSnapshot, getAiLabels, getHistory, getQueue, getSettings, getSnapshot, getWatch, listSnapshots, mergeAccounts, removeAccounts,
  saveAiLabels, saveHistory, saveQueue, saveSettings, saveSnapshot, saveWatch, snapshotKey,
} from "../shared/storage";
import { classifyBatch, costUsd, countBatchTokens, describeError, estimateOutputTokens, makeClient } from "./claude";
import {
  ALARM_CLOSE_WORKER, ALARM_RESUME, closeWorkerTab, focusWorkerTab, forgetTab, isContentAlive, isWorkerTab, kick, notifyReady,
  onWorkerTabClosed, pageByTab, recoverOnStartup, requestPause, sendToTab, setWorkerHooks, waitForReady,
} from "./worker";

const X_URL_RE = /^https:\/\/(x|twitter)\.com\//;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void syncWatchSchedule();
});
chrome.runtime.onStartup.addListener(() => void syncWatchSchedule());

// ---------- in-memory state (rebuilt lazily after the worker is restarted) ----------

const snapshotCache = new Map<string, ScanSnapshot>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Account map as it stood before the current scan started, per snapshot key (for diffing). */
const preScanAccounts = new Map<string, Record<string, Account>>();
let scanProgress: ScanProgress | null = null;
let scanTabId: number | null = null;
/** Whether the running scan was started by the user or by the unfollow-alert watcher. */
let scanKind: "manual" | "watch" = "manual";
/** Small popup window the watcher scans in (null when idle). */
let watchWindowId: number | null = null;
let watchTabId: number | null = null;
let watchTimeout: ReturnType<typeof setTimeout> | null = null;
let watchKeepalive: ReturnType<typeof setInterval> | null = null;
const isWatchTab = (tabId: number | undefined) => tabId != null && tabId === watchTabId;
/** Tabs we drive ourselves (hidden worker + watch window); never treated as the user's tab. */
const isOurTab = (tabId: number | undefined) => isWorkerTab(tabId) || isWatchTab(tabId);
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
  } else if (alarm.name === WATCH_ALARM) {
    void runWatchCheck("alarm");
  }
});

void recoverOnStartup();
void recoverWatch();

// ---------- tab helpers for scans ----------

async function findXTab(): Promise<chrome.tabs.Tab> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id != null && active.url && X_URL_RE.test(active.url) && !isOurTab(active.id)) return active;
  const all = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  const live = all.find((t) => t.id != null && !isOurTab(t.id));
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
      if (!isOurTab(tabId)) broadcast({ type: "PAGE_INFO", page: msg.page });
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
      let diff: { added: string[]; removed: string[] } | null = null;
      if (s) {
        const key = snapshotKey(msg.owner, msg.list);
        if (msg.progress.complete) {
          s.complete = true;
          const before = preScanAccounts.get(key) ?? {};
          const scanned = Object.values(s.accounts).filter((a) => a.lastSeen >= s.startedAt).map((a) => a.handle);
          const history = await getHistory(msg.owner, msg.list);
          const r = applyScanDiff(s, history, scanned, before);
          await saveHistory(msg.owner, msg.list, r.history);
          diff = { added: r.added, removed: r.removed };
        }
        preScanAccounts.delete(key);
        await flushSave(s);
      }
      scanProgress = { ...msg.progress, running: false };
      const wasWatch = scanKind === "watch" && isWatchTab(tabId);
      broadcast({ type: "SCAN_PROGRESS", progress: scanProgress });
      broadcast({ type: "STATE_CHANGED" });
      if (wasWatch) await finishWatch(msg.owner, diff, msg.progress.error ?? (msg.progress.complete ? undefined : "The check was interrupted."));
      else if (diff && msg.list === "followers") await noteManualDiff(msg.owner, diff);
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
  const [settings, queue, snapshots, hasPerm, watch] = await Promise.all([
    getSettings(),
    getQueue(),
    listSnapshots(),
    chrome.permissions.contains({ origins: [ANTHROPIC_ORIGIN] }),
    getWatch(),
  ]);
  let page: PageInfo | null = null;
  try {
    const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (tab?.id != null && tab.url && X_URL_RE.test(tab.url) && !isOurTab(tab.id)) {
      page = pageByTab.get(tab.id) ?? (await sendToTab<PageInfo>(tab.id, { type: "GET_PAGE_INFO" }).catch(() => null));
    }
    if (!page) {
      // Any other x.com tab we know about (not ours).
      for (const [id, p] of pageByTab) if (!isOurTab(id) && p.loggedInHandle) { page = p; break; }
    }
  } catch { /* ignore */ }
  return { page, scan: scanProgress, queue, ai: aiProgress, settings, snapshots, hasAnthropicPermission: hasPerm, watch };
}

/** Kick off the content-script scanner in `tabId`, which must already be on `owner`'s `list` page. */
async function beginScan(tabId: number, owner: string, list: ListKind, kind: "manual" | "watch"): Promise<void> {
  const s = (await loadSnapshot(owner, list, true))!;
  preScanAccounts.set(snapshotKey(owner, list), { ...s.accounts });
  s.startedAt = Date.now();
  scanTabId = tabId;
  scanKind = kind;
  scanProgress = { owner, list, scanned: Object.keys(s.accounts).length, newThisRun: 0, idleRounds: 0, running: true, complete: false };
  await sendToTab(tabId, { type: "SCAN_START", list, known: Object.keys(s.accounts) });
  broadcast({ type: "SCAN_PROGRESS", progress: scanProgress });
}

async function startScan(list: ListKind): Promise<{ ok: boolean; error?: string }> {
  if (scanProgress?.running) return { ok: false, error: scanKind === "watch" ? "An automatic follower check is running. Wait for it to finish." : "A scan is already running." };
  const tab = await findXTab();
  const tabId = tab.id!;
  if (!(await isContentAlive(tabId))) {
    await chrome.tabs.reload(tabId);
    await waitForReady(tabId, 30000);
  }
  const me = await loggedInHandle(tabId);
  await ensureOnList(tabId, me, list);
  await beginScan(tabId, me, list, "manual");
  return { ok: true };
}

// ---------- unfollow alerts (periodic background follower check) ----------

const WATCH_SCAN_TIMEOUT_MS = 20 * 60_000;
const NOTIFICATION_ID = "xff-unfollow";

function broadcastWatch(w: WatchState): void {
  broadcast({ type: "WATCH_UPDATED", watch: w });
}

async function setBadge(w: WatchState): Promise<void> {
  const text = badgeText(w.unseenLeft.length);
  await chrome.action.setBadgeText({ text }).catch(() => undefined);
  if (text) await chrome.action.setBadgeBackgroundColor({ color: "#f4212e" }).catch(() => undefined);
}

const intervalHours = (settings: Settings) => clampIntervalHours(settings.watchIntervalHours, WATCH_INTERVALS_H);

/** Make the alarm match the settings. Called on install, startup and whenever settings are saved. */
async function syncWatchSchedule(): Promise<void> {
  const settings = await getSettings();
  const w = await getWatch();
  const existing = await chrome.alarms.get(WATCH_ALARM);
  if (!settings.watchEnabled) {
    if (existing) await chrome.alarms.clear(WATCH_ALARM);
    if (w.nextRunAt) { delete w.nextRunAt; await saveWatch(w); broadcastWatch(w); }
    await setBadge(w);
    return;
  }
  const period = intervalHours(settings) * 60;
  if (!existing || existing.periodInMinutes !== period) {
    // First automatic run after one full period; "Check now" in the panel runs one immediately.
    await chrome.alarms.create(WATCH_ALARM, { periodInMinutes: period, delayInMinutes: period });
    w.nextRunAt = Date.now() + period * 60_000;
    await saveWatch(w);
    broadcastWatch(w);
  }
  await setBadge(w);
}

/** Which account to watch: the one logged in somewhere, else the most recently scanned followers list. */
async function watchOwner(): Promise<string | null> {
  for (const [id, p] of pageByTab) if (!isOurTab(id) && p.loggedInHandle) return p.loggedInHandle;
  const snaps = (await listSnapshots()).filter((s) => s.list === "followers").sort((a, b) => b.updatedAt - a.updatedAt);
  return snaps[0]?.owner ?? null;
}

async function closeWatchWindow(): Promise<void> {
  if (watchTimeout) { clearTimeout(watchTimeout); watchTimeout = null; }
  if (watchKeepalive) { clearInterval(watchKeepalive); watchKeepalive = null; }
  const id = watchWindowId;
  watchWindowId = null;
  watchTabId = null;
  if (id != null) await chrome.windows.remove(id).catch(() => undefined);
}

async function runWatchCheck(reason: "alarm" | "manual"): Promise<{ ok: boolean; error?: string }> {
  const settings = await getSettings();
  if (reason === "alarm" && !settings.watchEnabled) return { ok: false, error: "Unfollow alerts are off." };
  if (scanProgress?.running) return { ok: false, error: "A scan is already running." };
  const q = await getQueue();
  if (q.status === "running") return { ok: false, error: "The action queue is running; the check will happen next time." };
  const owner = await watchOwner();
  let w = await getWatch();
  if (!owner) {
    w = recordFailure(w, "Scan your followers once from the panel first.", Date.now(), intervalHours(settings));
    await saveWatch(w);
    broadcastWatch(w);
    return { ok: false, error: w.lastError };
  }
  w = { ...w, owner, running: true };
  delete w.lastError;
  await saveWatch(w);
  broadcastWatch(w);

  try {
    // A small, unfocused window: X only loads more of the list while the page is rendering, which hidden tabs never do.
    const win = await chrome.windows.create({
      url: `https://x.com/${owner}/followers`, type: "popup", focused: false, width: 420, height: 640, left: 40, top: 40,
    });
    watchWindowId = win?.id ?? null;
    watchTabId = win?.tabs?.[0]?.id ?? null;
    if (watchTabId == null) throw new Error("Could not open the check window.");
    if (watchWindowId != null) { w.windowId = watchWindowId; await saveWatch(w); }
    await waitForReady(watchTabId, 30000);
    const me = await loggedInHandle(watchTabId);
    if (me.toLowerCase() !== owner.toLowerCase()) throw new Error(`Logged in as @${me}, but the watched list belongs to @${owner}.`);
    await new Promise((r) => setTimeout(r, 1500));
    watchKeepalive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20000);
    watchTimeout = setTimeout(() => void finishWatch(owner, null, "The check took too long and was stopped."), WATCH_SCAN_TIMEOUT_MS);
    await beginScan(watchTabId, owner, "followers", "watch");
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await finishWatch(owner, null, error);
    return { ok: false, error };
  }
}

/** Called once per check, whether it finished, failed or timed out. */
async function finishWatch(owner: string, diff: { added: string[]; removed: string[] } | null, error?: string): Promise<void> {
  if (scanProgress?.running && scanKind === "watch") scanProgress = { ...scanProgress, running: false, ...(error ? { error } : {}) };
  await closeWatchWindow();
  const settings = await getSettings();
  let w = await getWatch();
  const now = Date.now();
  if (error || !diff) {
    w = recordFailure(w, error ?? "The check did not complete.", now, intervalHours(settings));
  } else {
    w = recordCheck(w, diff, now, intervalHours(settings));
    delete w.lastError;
    if (diff.removed.length && settings.watchNotify) {
      const s = await loadSnapshot(owner, "followers");
      const { title, message } = notificationText(diff.removed, s?.departed ?? {}, diff.added.length);
      chrome.notifications.create(NOTIFICATION_ID, {
        type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message, priority: 1,
      }, () => void chrome.runtime.lastError);
    }
  }
  delete w.windowId;
  if (!settings.watchEnabled) delete w.nextRunAt;
  await saveWatch(w);
  await setBadge(w);
  broadcastWatch(w);
  broadcast({ type: "STATE_CHANGED" });
}

/** The worker was restarted while a check was running: its in-memory state is gone, so close the window and record a failure. */
async function recoverWatch(): Promise<void> {
  const w = await getWatch();
  if (!w.running) { await setBadge(w); return; }
  if (w.windowId != null) await chrome.windows.remove(w.windowId).catch(() => undefined);
  const settings = await getSettings();
  const next = recordFailure(w, "The check was interrupted.", Date.now(), intervalHours(settings));
  delete next.windowId;
  if (!settings.watchEnabled) delete next.nextRunAt;
  await saveWatch(next);
  await setBadge(next);
}

/** A manual scan from the panel also feeds the badge, so departures are never silently lost. */
async function noteManualDiff(owner: string, diff: { added: string[]; removed: string[] }): Promise<void> {
  if (!diff.added.length && !diff.removed.length) return;
  const settings = await getSettings();
  let w = await getWatch();
  w = recordCheck({ ...w, owner: w.owner ?? owner }, diff, Date.now(), intervalHours(settings));
  if (!settings.watchEnabled) delete w.nextRunAt;
  else { const a = await chrome.alarms.get(WATCH_ALARM); if (a?.scheduledTime) w.nextRunAt = a.scheduledTime; }
  await saveWatch(w);
  await setBadge(w);
  broadcastWatch(w);
}

chrome.notifications.onClicked.addListener((id) => {
  if (id !== NOTIFICATION_ID) return;
  chrome.notifications.clear(id);
  void (async () => {
    const tab = await findXTab();
    if (tab.id != null) await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
      await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
    }
  })();
});

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
      await syncWatchSchedule();
      broadcast({ type: "STATE_CHANGED" });
      return { ok: true };
    }
    case "GET_WATCH": return getWatch();
    case "WATCH_CHECK_NOW": return runWatchCheck("manual");
    case "WATCH_SEEN": {
      const w = markSeen(await getWatch());
      await saveWatch(w);
      await setBadge(w);
      broadcastWatch(w);
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
  if (isWatchTab(tabId) && scanProgress?.running && scanKind === "watch") {
    const owner = scanProgress.owner;
    watchTabId = null;
    void finishWatch(owner, null, "The check window was closed.");
    return;
  }
  if (scanTabId === tabId && scanProgress?.running) {
    scanProgress = { ...scanProgress, running: false, error: "Tab closed." };
    broadcast({ type: "SCAN_PROGRESS", progress: scanProgress });
  }
});
