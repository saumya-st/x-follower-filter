import type {
  Account, ActionKind, ActionResult, AiRunProgress, ListKind, PageInfo, Queue, ScanProgress, ScanSnapshot, Settings, WatchState,
} from "./types";
import type { AiLabelMap } from "./storage";

/** Panel / options -> service worker. */
export type PanelRequest =
  | { type: "GET_STATE" }
  | { type: "START_SCAN"; list: ListKind }
  | { type: "STOP_SCAN" }
  | { type: "GET_SNAPSHOT"; owner: string; list: ListKind }
  | { type: "CLEAR_SNAPSHOT"; owner: string; list: ListKind }
  | { type: "QUEUE_ADD"; owner: string; list: ListKind; action: ActionKind; handles: string[]; preview: boolean }
  | { type: "QUEUE_REMOVE"; handles: string[] }
  | { type: "QUEUE_PAUSE" }
  | { type: "QUEUE_RESUME" }
  | { type: "QUEUE_CLEAR_DONE" }
  | { type: "GET_QUEUE" }
  | { type: "FOCUS_WORKER_TAB" }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; settings: Settings }
  | { type: "AI_ESTIMATE"; owner: string; list: ListKind; handles: string[] }
  | { type: "AI_RUN"; owner: string; list: ListKind; handles: string[] }
  | { type: "AI_CANCEL" }
  | { type: "GET_AI_LABELS" }
  | { type: "OPEN_OPTIONS" }
  | { type: "GET_WATCH" }
  | { type: "WATCH_CHECK_NOW" }
  | { type: "WATCH_SEEN" };

/** Content script -> service worker. */
export type ContentRequest =
  | { type: "CS_READY"; page: PageInfo }
  | { type: "SCAN_BATCH"; owner: string; list: ListKind; accounts: Account[]; progress: ScanProgress }
  | { type: "SCAN_FINISHED"; owner: string; list: ListKind; progress: ScanProgress }
  | { type: "WORKER_PAUSE_REQUEST" };

/** Service worker -> content script. */
export type ContentCommand =
  | { type: "PING" }
  | { type: "GET_PAGE_INFO" }
  | { type: "SCAN_START"; list: ListKind; known: string[] }
  | { type: "SCAN_STOP" }
  | { type: "JOB_STEP"; action: ActionKind; handle: string }
  | { type: "WORKER_STATUS"; text: string };

/** Broadcasts from the service worker that the panel listens for. */
export type Broadcast =
  | { type: "STATE_CHANGED" }
  | { type: "SCAN_PROGRESS"; progress: ScanProgress }
  | { type: "QUEUE_UPDATED"; queue: Queue; finished?: { handle: string; list: ListKind; ok: boolean } }
  | { type: "AI_PROGRESS"; progress: AiRunProgress }
  | { type: "PAGE_INFO"; page: PageInfo | null }
  | { type: "WATCH_UPDATED"; watch: WatchState };

export interface AppState {
  page: PageInfo | null;
  scan: ScanProgress | null;
  queue: Queue;
  ai: AiRunProgress | null;
  settings: Settings;
  snapshots: { owner: string; list: ListKind; count: number; updatedAt: number }[];
  hasAnthropicPermission: boolean;
  watch: WatchState;
}

export type AiEstimate = {
  accounts: number;
  batches: number;
  inputTokens: number;
  estOutputTokens: number;
  costUsd: number;
  model: string;
};

export type OkResponse = { ok: boolean; error?: string };

export type ResponseFor<T extends PanelRequest> =
  T extends { type: "GET_STATE" } ? AppState :
  T extends { type: "GET_SNAPSHOT" } ? ScanSnapshot | null :
  T extends { type: "GET_SETTINGS" } ? Settings :
  T extends { type: "GET_QUEUE" } ? Queue :
  T extends { type: "QUEUE_ADD" } ? OkResponse & { added: number; skipped: number; duplicates: number } :
  T extends { type: "AI_ESTIMATE" } ? AiEstimate :
  T extends { type: "GET_AI_LABELS" } ? AiLabelMap :
  T extends { type: "GET_WATCH" } ? WatchState :
  OkResponse;

export type StepResponse = ActionResult;

export function sendToBackground<T extends PanelRequest>(req: T): Promise<ResponseFor<T>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else if (res && typeof res === "object" && "__error" in res) reject(new Error(String((res as { __error: string }).__error)));
      else resolve(res as ResponseFor<T>);
    });
  });
}

export function sendFromContent(req: ContentRequest): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(req, (res) => {
        void chrome.runtime.lastError; // swallow "receiving end does not exist"
        resolve(res);
      });
    } catch {
      resolve(undefined);
    }
  });
}
