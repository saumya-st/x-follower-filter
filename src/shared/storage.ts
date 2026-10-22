import type { Account, AiLabel, ListKind, Queue, ScanHistoryEntry, ScanSnapshot, Settings, WatchState } from "./types";
import { emptyWatch } from "./watch";
import { DEFAULT_SETTINGS } from "./defaults";
import { emptyQueue } from "./queue";

const SETTINGS_KEY = "settings";
const QUEUE_KEY = "queue";
const AI_KEY = "aiLabels";
const WATCH_KEY = "watch";

export function snapshotKey(owner: string, list: ListKind): string {
  return `snapshot:${owner.toLowerCase()}:${list}`;
}
export function historyKey(owner: string, list: ListKind): string {
  return `history:${owner.toLowerCase()}:${list}`;
}

export async function getSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = (r[SETTINGS_KEY] ?? {}) as Partial<Settings> & { maxPerSession?: number };
  const merged: Settings = { ...DEFAULT_SETTINGS, ...stored };
  // v0.1 -> v0.2 migration: per-session cap became per-hour cap.
  if (stored.maxPerHour == null && typeof stored.maxPerSession === "number") merged.maxPerHour = stored.maxPerSession;
  return merged;
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

export async function getSnapshot(owner: string, list: ListKind): Promise<ScanSnapshot | null> {
  const key = snapshotKey(owner, list);
  const r = await chrome.storage.local.get(key);
  return (r[key] as ScanSnapshot | undefined) ?? null;
}

export async function saveSnapshot(s: ScanSnapshot): Promise<void> {
  await chrome.storage.local.set({ [snapshotKey(s.owner, s.list)]: s });
}

export async function deleteSnapshot(owner: string, list: ListKind): Promise<void> {
  await chrome.storage.local.remove([snapshotKey(owner, list), historyKey(owner, list)]);
}

export async function listSnapshots(): Promise<{ owner: string; list: ListKind; count: number; updatedAt: number }[]> {
  const all = await chrome.storage.local.get(null);
  const out: { owner: string; list: ListKind; count: number; updatedAt: number }[] = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith("snapshot:")) continue;
    const s = v as ScanSnapshot;
    out.push({ owner: s.owner, list: s.list, count: Object.keys(s.accounts).length, updatedAt: s.updatedAt });
  }
  return out;
}

export async function getHistory(owner: string, list: ListKind): Promise<ScanHistoryEntry[]> {
  const key = historyKey(owner, list);
  const r = await chrome.storage.local.get(key);
  return (r[key] as ScanHistoryEntry[] | undefined) ?? [];
}

export async function saveHistory(owner: string, list: ListKind, entries: ScanHistoryEntry[]): Promise<void> {
  await chrome.storage.local.set({ [historyKey(owner, list)]: entries });
}

/**
 * Merge a batch of freshly scraped accounts into a snapshot. Keeps firstSeen, updates everything else.
 * Returns the number of accounts not previously present.
 */
export function mergeAccounts(snapshot: ScanSnapshot, incoming: Account[], now = Date.now()): number {
  let added = 0;
  for (const a of incoming) {
    const prev = snapshot.accounts[a.handle];
    if (prev) {
      snapshot.accounts[a.handle] = { ...prev, ...a, firstSeen: prev.firstSeen, lastSeen: now };
    } else {
      snapshot.accounts[a.handle] = { ...a, firstSeen: now, lastSeen: now };
      added++;
    }
  }
  snapshot.updatedAt = now;
  return added;
}

export function removeAccounts(snapshot: ScanSnapshot, handles: string[], selfRemoved = false, now = Date.now()): void {
  for (const h of handles) {
    delete snapshot.accounts[h];
    if (selfRemoved) (snapshot.selfRemoved ??= {})[h] = now;
  }
  snapshot.updatedAt = now;
}

export async function getQueue(): Promise<Queue> {
  const r = await chrome.storage.local.get(QUEUE_KEY);
  return (r[QUEUE_KEY] as Queue | undefined) ?? emptyQueue();
}

export async function saveQueue(q: Queue): Promise<void> {
  await chrome.storage.local.set({ [QUEUE_KEY]: q });
}

export type AiLabelMap = Record<string, AiLabel>;

export async function getAiLabels(): Promise<AiLabelMap> {
  const r = await chrome.storage.local.get(AI_KEY);
  return (r[AI_KEY] as AiLabelMap | undefined) ?? {};
}

export async function saveAiLabels(map: AiLabelMap): Promise<void> {
  await chrome.storage.local.set({ [AI_KEY]: map });
}

export async function getWatch(): Promise<WatchState> {
  const r = await chrome.storage.local.get(WATCH_KEY);
  return { ...emptyWatch(), ...((r[WATCH_KEY] as Partial<WatchState> | undefined) ?? {}) };
}

export async function saveWatch(w: WatchState): Promise<void> {
  await chrome.storage.local.set({ [WATCH_KEY]: w });
}

export async function clearAllData(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k !== SETTINGS_KEY);
  await chrome.storage.local.remove(keys);
}
