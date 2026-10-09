import type { ActionKind, ListKind, Queue, QueueItem } from "./types";
import { normalizeHandle } from "./rules";

export const HOUR_MS = 3_600_000;

export function emptyQueue(): Queue {
  return { items: [], status: "idle", actionTimes: [] };
}

export interface AddRequest {
  owner: string;
  list: ListKind;
  action: ActionKind;
  handles: string[];
  preview: boolean;
}

export interface AddOptions {
  protectedHandles: Iterable<string>;
  self?: string | null;
  now?: number;
}

/** Appends items, deduping against anything already queued or running. Protected/self handles are recorded as skipped. */
export function addToQueue(q: Queue, req: AddRequest, opts: AddOptions): { added: number; skipped: number; duplicates: number } {
  const now = opts.now ?? Date.now();
  const protectedSet = new Set(Array.from(opts.protectedHandles, normalizeHandle));
  const live = new Set(q.items.filter((i) => i.status === "queued" || i.status === "running").map((i) => `${i.action}:${i.handle}`));
  let added = 0, skipped = 0, duplicates = 0;
  for (const raw of req.handles) {
    const handle = normalizeHandle(raw);
    if (!handle) continue;
    const key = `${req.action}:${handle}`;
    if (live.has(key)) { duplicates++; continue; }
    const base: QueueItem = { handle, owner: req.owner, list: req.list, action: req.action, status: "queued", preview: req.preview, at: now };
    if (protectedSet.has(handle) || (opts.self && handle === normalizeHandle(opts.self))) {
      q.items.push({ ...base, status: "skipped", reason: handle === opts.self ? "that's you" : "protected", finishedAt: now });
      skipped++;
      continue;
    }
    q.items.push(base);
    live.add(key);
    added++;
  }
  return { added, skipped, duplicates };
}

/** Removes still-queued items for the given handles (used by Undo / cancel). Returns how many were removed. */
export function removeQueued(q: Queue, handles: string[]): number {
  const set = new Set(handles.map(normalizeHandle));
  const before = q.items.length;
  q.items = q.items.filter((i) => !(i.status === "queued" && set.has(i.handle)));
  return before - q.items.length;
}

export function nextQueued(q: Queue): QueueItem | undefined {
  return q.items.find((i) => i.status === "queued");
}

export function findRunning(q: Queue): QueueItem | undefined {
  return q.items.find((i) => i.status === "running");
}

/** After a service-worker restart nothing can still be running; put it back in line. */
export function recoverRunning(q: Queue): boolean {
  let changed = false;
  for (const i of q.items) if (i.status === "running") { i.status = "queued"; changed = true; }
  if (q.status === "running") { q.status = "idle"; changed = true; }
  return changed;
}

export function pruneActionTimes(q: Queue, now = Date.now()): void {
  q.actionTimes = q.actionTimes.filter((t) => now - t < HOUR_MS);
}

/** Returns the time the cap lifts, or null when another action is allowed now. */
export function cappedUntil(q: Queue, maxPerHour: number, now = Date.now()): number | null {
  pruneActionTimes(q, now);
  if (q.actionTimes.length < Math.max(1, maxPerHour)) return null;
  const oldest = Math.min(...q.actionTimes);
  return oldest + HOUR_MS;
}

export function clearFinished(q: Queue): void {
  q.items = q.items.filter((i) => i.status === "queued" || i.status === "running");
  if (q.status !== "paused" && q.status !== "capped") q.status = q.items.length ? q.status : "idle";
  delete q.lastError;
}

export function queueCounts(q: Queue) {
  const c = { queued: 0, running: 0, done: 0, failed: 0, skipped: 0, preview: 0 };
  for (const i of q.items) {
    if (i.status === "done" && i.preview) c.preview++;
    c[i.status]++;
  }
  return c;
}

export function finishItem(q: Queue, item: QueueItem, ok: boolean, reason: string | undefined, now = Date.now()): void {
  const target = q.items.find((i) => i.handle === item.handle && i.action === item.action && (i.status === "running" || i.status === "queued"));
  if (!target) return;
  target.status = ok ? "done" : "failed";
  if (reason) target.reason = reason; else delete target.reason;
  target.finishedAt = now;
  if (ok && !target.preview) q.actionTimes.push(now);
}
