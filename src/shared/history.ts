import type { Account, DepartedAccount, ScanHistoryEntry, ScanSnapshot } from "./types";

export const MAX_HISTORY = 20;
export const MAX_DEPARTED = 500;

export function diffHandles(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  const p = new Set(prev), n = new Set(next);
  return {
    added: next.filter((h) => !p.has(h)),
    removed: prev.filter((h) => !n.has(h)),
  };
}

export function pushHistory(entries: ScanHistoryEntry[], entry: ScanHistoryEntry, max = MAX_HISTORY): ScanHistoryEntry[] {
  return [...entries, entry].slice(-max);
}

/**
 * Called after a complete scan. Compares with the previous complete scan, records the diff on the snapshot,
 * moves accounts that vanished (and that we did not remove ourselves) into `departed`.
 * `accountsBeforeScan` is the snapshot's account map as it stood before this scan started merging.
 */
export function applyScanDiff(
  snapshot: ScanSnapshot,
  history: ScanHistoryEntry[],
  scannedHandles: string[],
  accountsBeforeScan: Record<string, Account>,
  now = Date.now(),
): { history: ScanHistoryEntry[]; added: string[]; removed: string[] } {
  const prev = history[history.length - 1];
  const prevHandles = prev ? prev.handles : Object.keys(accountsBeforeScan);
  const { added, removed } = diffHandles(prevHandles, scannedHandles);
  const self = snapshot.selfRemoved ?? {};
  const left = removed.filter((h) => !(h in self));

  snapshot.departed ??= {};
  for (const h of left) {
    const a = accountsBeforeScan[h] ?? snapshot.accounts[h];
    if (a) snapshot.departed[h] = { ...a, departedAt: now } as DepartedAccount;
  }
  // Everything that is gone leaves the live map, however it left.
  for (const h of removed) delete snapshot.accounts[h];
  // Someone who came back is no longer departed.
  for (const h of scannedHandles) delete snapshot.departed[h];
  // Trim departed to the most recent N.
  const entries = Object.entries(snapshot.departed).sort((x, y) => y[1].departedAt - x[1].departedAt);
  if (entries.length > MAX_DEPARTED) snapshot.departed = Object.fromEntries(entries.slice(0, MAX_DEPARTED));

  snapshot.selfRemoved = {};
  snapshot.lastDiff = { at: now, previousAt: prev?.at ?? snapshot.startedAt, added, removed: left };
  return { history: pushHistory(history, { at: now, handles: scannedHandles }), added, removed: left };
}

export function nonMutuals(
  followers: Record<string, Account> | undefined,
  following: Record<string, Account> | undefined,
): { notFollowingBack: string[]; fans: string[] } {
  if (!followers || !following) return { notFollowingBack: [], fans: [] };
  const f = new Set(Object.keys(followers));
  const g = new Set(Object.keys(following));
  return {
    notFollowingBack: Object.keys(following).filter((h) => !f.has(h)),
    fans: Object.keys(followers).filter((h) => !g.has(h)),
  };
}
