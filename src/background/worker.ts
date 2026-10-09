/**
 * Hidden worker tab + queue runner. The service worker owns the loop and the pacing; the content script
 * in the worker tab performs exactly one action per request. Navigation is a real page load via
 * chrome.tabs.update, which sidesteps X's SPA router and Chrome's background-timer throttling.
 */
import type { ContentCommand, StepResponse } from "../shared/messages";
import type { PageInfo, Queue, QueueItem } from "../shared/types";
import { WORKER_IDLE_CLOSE_MIN } from "../shared/defaults";
import { cappedUntil, finishItem, nextQueued, pruneActionTimes, recoverRunning } from "../shared/queue";
import { getQueue, getSettings, saveQueue } from "../shared/storage";

export const ALARM_RESUME = "xff-resume";
export const ALARM_CLOSE_WORKER = "xff-close-worker";

export interface WorkerHooks {
  broadcast: (queue: Queue, finished?: { handle: string; list: QueueItem["list"]; ok: boolean }) => void;
  onActionDone: (item: QueueItem) => Promise<void>;
}

let hooks: WorkerHooks = { broadcast: () => undefined, onActionDone: async () => undefined };
export function setWorkerHooks(h: WorkerHooks): void {
  hooks = h;
}

// ---------- tab readiness (shared with scans) ----------

const readyWaiters = new Map<number, Array<() => void>>();
export const pageByTab = new Map<number, PageInfo>();

export function notifyReady(tabId: number, page: PageInfo): void {
  pageByTab.set(tabId, page);
  const waiters = readyWaiters.get(tabId);
  if (waiters?.length) {
    readyWaiters.delete(tabId);
    waiters.forEach((f) => f());
  }
}

export function forgetTab(tabId: number): void {
  pageByTab.delete(tabId);
  readyWaiters.delete(tabId);
}

export function waitForReady(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      readyWaiters.set(tabId, (readyWaiters.get(tabId) ?? []).filter((f) => f !== done));
      reject(new Error("The X page did not finish loading."));
    }, timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    readyWaiters.set(tabId, [...(readyWaiters.get(tabId) ?? []), done]);
  });
}

export async function sendToTab<T = unknown>(tabId: number, cmd: ContentCommand): Promise<T> {
  return (await chrome.tabs.sendMessage(tabId, cmd)) as T;
}

export async function isContentAlive(tabId: number): Promise<boolean> {
  try {
    const r = await sendToTab<{ ok: boolean }>(tabId, { type: "PING" });
    return !!r?.ok;
  } catch {
    return false;
  }
}

// ---------- worker tab ----------

let workerTabId: number | null = null;

export function isWorkerTab(tabId: number | undefined): boolean {
  return tabId != null && tabId === workerTabId;
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

export async function ensureWorkerTab(): Promise<number> {
  const q = await getQueue();
  const candidate = workerTabId ?? q.workerTabId ?? null;
  if (candidate != null && (await tabExists(candidate)) && (await isContentAlive(candidate))) {
    workerTabId = candidate;
    return candidate;
  }
  const tab = await chrome.tabs.create({ url: "https://x.com/home", active: false });
  workerTabId = tab.id!;
  const fresh = await getQueue();
  fresh.workerTabId = workerTabId;
  await saveQueue(fresh);
  await waitForReady(workerTabId, 30000);
  return workerTabId;
}

export async function closeWorkerTab(): Promise<void> {
  const q = await getQueue();
  const id = workerTabId ?? q.workerTabId;
  if (id != null && (await tabExists(id))) await chrome.tabs.remove(id).catch(() => undefined);
  workerTabId = null;
  if (q.workerTabId != null) {
    delete q.workerTabId;
    await saveQueue(q);
  }
}

export async function focusWorkerTab(): Promise<boolean> {
  const q = await getQueue();
  const id = workerTabId ?? q.workerTabId;
  if (id == null || !(await tabExists(id))) return false;
  const tab = await chrome.tabs.get(id);
  await chrome.tabs.update(id, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  return true;
}

export function onWorkerTabClosed(tabId: number): void {
  if (tabId === workerTabId) workerTabId = null;
}

// ---------- runner loop ----------

let loopRunning = false;
let pauseRequested = false;
let keepalive: ReturnType<typeof setInterval> | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

function startKeepalive(): void {
  if (keepalive) return;
  keepalive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20000);
}
function stopKeepalive(): void {
  if (keepalive) clearInterval(keepalive);
  keepalive = null;
}

/** Interruptible pause: sleeps in 500 ms slices so Pause takes effect quickly. */
async function pacedSleep(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !pauseRequested) await sleep(Math.min(500, until - Date.now()));
}

export function requestPause(): void {
  pauseRequested = true;
}

/** Start the loop if it is not already running. Safe to call often. */
export function kick(): void {
  if (loopRunning) return;
  void runLoop();
}

async function scheduleWorkerClose(): Promise<void> {
  const settings = await getSettings();
  if (settings.keepWorkerTab) return;
  chrome.alarms.create(ALARM_CLOSE_WORKER, { delayInMinutes: WORKER_IDLE_CLOSE_MIN });
}

async function runLoop(): Promise<void> {
  loopRunning = true;
  pauseRequested = false;
  startKeepalive();
  try {
    for (;;) {
      const q = await getQueue();
      if (pauseRequested || q.status === "paused") {
        q.status = "paused";
        await saveQueue(q);
        hooks.broadcast(q);
        break;
      }
      const settings = await getSettings();
      const item = nextQueued(q);
      if (!item) {
        q.status = "idle";
        delete q.cappedUntil;
        await saveQueue(q);
        hooks.broadcast(q);
        await scheduleWorkerClose();
        break;
      }

      if (item.preview) {
        finishItem(q, item, true, "preview");
        q.status = nextQueued(q) ? "running" : "idle";
        await saveQueue(q);
        hooks.broadcast(q);
        continue;
      }

      const capUntil = cappedUntil(q, settings.maxPerHour);
      if (capUntil) {
        q.status = "capped";
        q.cappedUntil = capUntil;
        await saveQueue(q);
        hooks.broadcast(q);
        chrome.alarms.create(ALARM_RESUME, { when: capUntil + 1000 });
        break;
      }

      item.status = "running";
      q.status = "running";
      delete q.lastError;
      await saveQueue(q);
      hooks.broadcast(q);

      let res: StepResponse;
      try {
        const tabId = await ensureWorkerTab();
        await sendToTab(tabId, { type: "WORKER_STATUS", text: `Opening @${item.handle}…` }).catch(() => undefined);
        const ready = waitForReady(tabId, 30000);
        await chrome.tabs.update(tabId, { url: `https://x.com/${item.handle}` });
        await ready;
        await sleep(rand(900, 1600));
        res = await Promise.race([
          sendToTab<StepResponse>(tabId, { type: "JOB_STEP", action: item.action, handle: item.handle }),
          sleep(45000).then((): StepResponse => ({ ok: false, reason: "timed out waiting for X" })),
        ]);
        if (!res || typeof res.ok !== "boolean") res = { ok: false, reason: "no response from the worker tab" };
      } catch (e) {
        res = { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }

      // Re-read: the user may have edited the queue while we were clicking.
      const fresh = await getQueue();
      pruneActionTimes(fresh);
      finishItem(fresh, item, res.ok, res.reason);
      if (res.ok) await hooks.onActionDone({ ...item, status: "done" });
      if (res.rateLimited) {
        fresh.status = "paused";
        fresh.lastError = `${res.reason ?? "X rate limit"} — paused to protect your account. Resume in a while.`;
        await saveQueue(fresh);
        hooks.broadcast(fresh, { handle: item.handle, list: item.list, ok: res.ok });
        break;
      }
      fresh.status = nextQueued(fresh) ? "running" : "idle";
      await saveQueue(fresh);
      hooks.broadcast(fresh, { handle: item.handle, list: item.list, ok: res.ok });

      if (nextQueued(fresh)) await pacedSleep(rand(settings.minDelayMs, settings.maxDelayMs));
    }
  } finally {
    loopRunning = false;
    stopKeepalive();
  }
}

/** Called once when the service worker starts: put interrupted items back and continue if there is work. */
export async function recoverOnStartup(): Promise<void> {
  const q = await getQueue();
  if (recoverRunning(q)) await saveQueue(q);
  if (q.workerTabId != null && (await tabExists(q.workerTabId))) workerTabId = q.workerTabId;
  if (q.status !== "paused" && nextQueued(q)) {
    if (q.status === "capped" && q.cappedUntil && q.cappedUntil > Date.now()) {
      chrome.alarms.create(ALARM_RESUME, { when: q.cappedUntil + 1000 });
      return;
    }
    kick();
  }
}
