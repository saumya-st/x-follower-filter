export type ListKind = "followers" | "following";
export type ActionKind = "remove" | "unfollow";

export interface Account {
  /** Lowercase handle without the @. */
  handle: string;
  name: string;
  bio: string;
  followsYou: boolean;
  verified: boolean;
  /** Account is protected (lock icon). Not to be confused with the user's own protected list. */
  locked: boolean;
  avatarUrl?: string;
  firstSeen: number;
  lastSeen: number;
}

export interface DepartedAccount extends Account {
  departedAt: number;
}

export interface ScanDiff {
  at: number;
  previousAt: number;
  added: string[];
  removed: string[];
}

export interface ScanSnapshot {
  owner: string;
  list: ListKind;
  startedAt: number;
  updatedAt: number;
  complete: boolean;
  accounts: Record<string, Account>;
  /** Accounts that disappeared between two complete scans (followers who left / accounts you unfollowed elsewhere). */
  departed?: Record<string, DepartedAccount>;
  /** Handles we removed/unfollowed ourselves since the last complete scan; excluded from "left" diffs. */
  selfRemoved?: Record<string, number>;
  lastDiff?: ScanDiff;
}

export interface ScanHistoryEntry {
  at: number;
  handles: string[];
}

export interface Label {
  id: string;
  name: string;
  color: string;
  keywords: string[];
  /** Optional one-line hint fed to the AI classifier. */
  hint?: string;
}

export interface LabelHit {
  labelId: string;
  terms: string[];
}

export interface AiLabel {
  label: string;
  confidence: number;
  bioHash: string;
  model: string;
  at: number;
}

export type QueueItemStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface QueueItem {
  handle: string;
  owner: string;
  list: ListKind;
  action: ActionKind;
  status: QueueItemStatus;
  /** Preview items are never executed; they just show what would happen. */
  preview: boolean;
  reason?: string;
  at: number;
  finishedAt?: number;
}

export type QueueStatus = "idle" | "running" | "paused" | "capped";

export interface Queue {
  items: QueueItem[];
  status: QueueStatus;
  workerTabId?: number;
  /** Timestamps of real actions in the last hour (sliding cap). */
  actionTimes: number[];
  cappedUntil?: number;
  lastError?: string;
}

export interface PresetFlags {
  noBio?: boolean;
  likelyBot?: boolean;
  notFollowingBack?: boolean;
  noAvatar?: boolean;
  unlabeled?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  /** Which tab the preset appears on. */
  list: ListKind | "both";
  labels?: string[];
  flags?: PresetFlags;
  hint: string;
}

export interface Settings {
  apiKey: string;
  model: string;
  aiScope: "unlabeled" | "all";
  minDelayMs: number;
  maxDelayMs: number;
  /** Sliding one-hour cap on real actions. */
  maxPerHour: number;
  protectedHandles: string[];
  labels: Label[];
  /** Allow Claude to invent a label outside the user's set. */
  aiAllowOther: boolean;
  /** Bot score (0-100) at or above which an account is flagged. */
  botThreshold: number;
  /** Keep the hidden worker tab open after the queue drains. */
  keepWorkerTab: boolean;
  /** Unfollow alerts: periodically rescan followers in a small background window. */
  watchEnabled: boolean;
  /** Hours between automatic checks. */
  watchIntervalHours: number;
  /** Show a desktop notification when someone unfollowed. */
  watchNotify: boolean;
}

/** Persistent state of the unfollow-alert watcher. */
export interface WatchState {
  /** Account whose followers are watched (set when enabled). */
  owner: string | null;
  lastRunAt?: number;
  lastError?: string;
  /** When the next automatic check is due. */
  nextRunAt?: number;
  /** Handles that unfollowed since the user last looked at the Changes tab (newest first). */
  unseenLeft: string[];
  /** Number of new followers since the user last looked. */
  unseenNew: number;
  running: boolean;
  /** Window the running check scans in, so it can be closed if the service worker restarts mid-check. */
  windowId?: number;
}

export interface ScanProgress {
  owner: string;
  list: ListKind;
  scanned: number;
  newThisRun: number;
  idleRounds: number;
  running: boolean;
  complete: boolean;
  error?: string;
}

export interface PageInfo {
  url: string;
  owner: string | null;
  list: ListKind | null;
  loggedInHandle: string | null;
}

export interface AiRunProgress {
  running: boolean;
  total: number;
  done: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

export interface ModelPrice {
  id: string;
  name: string;
  inputPerM: number;
  outputPerM: number;
  supportsFallback: boolean;
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
  rateLimited?: boolean;
}
