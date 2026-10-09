import type { ContentCommand } from "../shared/messages";
import { sendFromContent } from "../shared/messages";
import { performAction } from "./actions";
import { Overlay } from "./overlay";
import { Scanner } from "./scraper";
import { getPageInfo } from "./selectors";

declare global {
  interface Window {
    __xffLoaded?: boolean;
  }
}

if (!window.__xffLoaded) {
  window.__xffLoaded = true;
  boot();
}

function boot(): void {
  let isWorker = false;

  const overlay = new Overlay({
    onPause: () => { if (isWorker) void sendFromContent({ type: "WORKER_PAUSE_REQUEST" }); },
    onResume: () => { /* resume happens from the panel */ },
    onStop: () => {
      if (scanner.isRunning()) scanner.stop();
      if (isWorker) void sendFromContent({ type: "WORKER_PAUSE_REQUEST" });
    },
  });

  const scanner = new Scanner({
    onBatch: (accounts, progress) => {
      overlay.status(`Scanning ${progress.list}: ${progress.scanned} accounts (${progress.newThisRun} new)`);
      void sendFromContent({ type: "SCAN_BATCH", owner: progress.owner, list: progress.list, accounts, progress });
    },
    onFinished: (progress) => {
      overlay.status(progress.error ? `Scan stopped: ${progress.error}` : `Scan ${progress.complete ? "complete" : "stopped"}: ${progress.scanned} accounts`);
      overlay.hide(4000);
      void sendFromContent({ type: "SCAN_FINISHED", owner: progress.owner, list: progress.list, progress });
    },
  });

  chrome.runtime.onMessage.addListener((msg: ContentCommand, _sender, sendResponse) => {
    switch (msg.type) {
      case "PING":
        sendResponse({ ok: true });
        return;
      case "GET_PAGE_INFO":
        sendResponse(getPageInfo());
        return;
      case "SCAN_START":
        overlay.show("Starting scan…");
        overlay.setControls(true);
        overlay.setPaused(false);
        void scanner.start(msg.list, msg.known);
        sendResponse({ ok: true });
        return;
      case "SCAN_STOP":
        scanner.stop();
        sendResponse({ ok: true });
        return;
      case "WORKER_STATUS":
        isWorker = true;
        overlay.show(msg.text);
        overlay.setControls(false);
        sendResponse({ ok: true });
        return;
      case "JOB_STEP": {
        isWorker = true;
        overlay.show(`${msg.action === "remove" ? "Removing follower" : "Unfollowing"} @${msg.handle}…`);
        overlay.setControls(false);
        performAction(msg.action, msg.handle)
          .then((res) => {
            overlay.status(res.ok ? "Done. Waiting for the next one…" : `Skipped: ${res.reason ?? "unknown"}`);
            sendResponse(res);
          })
          .catch((e: unknown) => sendResponse({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
        return true; // async response
      }
    }
    return undefined;
  });

  // Announce ourselves (the service worker waits for this after navigating a tab) and keep it informed
  // about SPA route changes.
  let lastUrl = "";
  const announce = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    void sendFromContent({ type: "CS_READY", page: getPageInfo() });
  };
  announce();
  setInterval(announce, 1000);
}
