/**
 * Pure helpers for "unfollow alerts": the periodic background follower check.
 * Scheduling, the scan itself and the notification API live in the service worker.
 */
import type { Account, WatchState } from "./types";

export const WATCH_ALARM = "xff-watch";
export const MAX_UNSEEN = 200;

export function emptyWatch(): WatchState {
  return { owner: null, unseenLeft: [], unseenNew: 0, running: false };
}

export function clampIntervalHours(h: number, allowed: number[]): number {
  if (allowed.includes(h)) return h;
  return allowed.reduce((best, x) => (Math.abs(x - h) < Math.abs(best - h) ? x : best), allowed[0]!);
}

/** Fold the result of a completed followers scan into the watch state. */
export function recordCheck(
  prev: WatchState,
  result: { added: string[]; removed: string[] },
  now: number,
  intervalHours: number,
): WatchState {
  // A handle that left again moves to the front instead of being duplicated (or trimmed off the end).
  const removed = new Set(result.removed);
  const left = [...result.removed, ...prev.unseenLeft.filter((h) => !removed.has(h))].slice(0, MAX_UNSEEN);
  return {
    ...prev,
    running: false,
    lastRunAt: now,
    nextRunAt: now + intervalHours * 3600_000,
    unseenLeft: left,
    unseenNew: prev.unseenNew + result.added.length,
  };
}

export function recordFailure(prev: WatchState, error: string, now: number, intervalHours: number): WatchState {
  return { ...prev, running: false, lastRunAt: now, nextRunAt: now + intervalHours * 3600_000, lastError: error };
}

export function markSeen(prev: WatchState): WatchState {
  return { ...prev, unseenLeft: [], unseenNew: 0 };
}

/** Text for the extension icon badge: empty when nothing is unseen, "99+" beyond two digits. */
export function badgeText(unseenLeft: number): string {
  if (unseenLeft <= 0) return "";
  return unseenLeft > 99 ? "99+" : String(unseenLeft);
}

const displayName = (a: Account | undefined, handle: string) => (a?.name?.trim() ? a.name.trim() : `@${handle}`);

/** Title and body for the desktop notification about a batch of unfollows. */
export function notificationText(
  removed: string[],
  accounts: Record<string, Pick<Account, "name" | "handle">>,
  added = 0,
): { title: string; message: string } {
  const n = removed.length;
  const names = removed.slice(0, 3).map((h) => displayName(accounts[h] as Account | undefined, h));
  const rest = n - names.length;
  const who = rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(names.length === 2 ? " and " : ", ");
  const title = n === 1 ? "1 person unfollowed you" : `${n} people unfollowed you`;
  const message = added > 0 ? `${who}. ${added} new follower${added === 1 ? "" : "s"}.` : who;
  return { title, message };
}
