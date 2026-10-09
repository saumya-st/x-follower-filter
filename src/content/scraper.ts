import type { Account, ListKind, ScanProgress } from "../shared/types";
import { SEL, findRetryButton, parseListRoute, parseUserCell } from "./selectors";

const IDLE_ROUNDS_TO_FINISH = 10;
const MAX_RETRY_CLICKS = 5;

export interface ScannerCallbacks {
  onBatch: (accounts: Account[], progress: ScanProgress) => void;
  onFinished: (progress: ScanProgress) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);

export class Scanner {
  private running = false;
  private seen = new Set<string>();
  private newThisRun = 0;
  private idleRounds = 0;
  private retries = 0;
  private owner = "";
  private list: ListKind = "followers";

  constructor(private cb: ScannerCallbacks) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(list: ListKind, known: string[]): Promise<void> {
    const route = parseListRoute(location.pathname);
    if (!route || route.list !== list) {
      this.cb.onFinished(this.progress(false, `Open the ${list} page first (x.com/you/${list}).`));
      return;
    }
    if (this.running) return;
    this.running = true;
    this.owner = route.owner;
    this.list = list;
    this.seen = new Set(known);
    this.newThisRun = 0;
    this.idleRounds = 0;
    this.retries = 0;

    // Start from the top so nothing above the fold is missed.
    window.scrollTo({ top: 0 });
    await sleep(800);

    try {
      await this.loop();
    } catch (e) {
      this.running = false;
      this.cb.onFinished(this.progress(false, e instanceof Error ? e.message : String(e)));
      return;
    }
    const finished = this.running; // false if stop() was called
    this.running = false;
    this.cb.onFinished(this.progress(finished));
  }

  stop(): void {
    this.running = false;
  }

  private progress(complete: boolean, error?: string): ScanProgress {
    return {
      owner: this.owner,
      list: this.list,
      scanned: this.seen.size,
      newThisRun: this.newThisRun,
      idleRounds: this.idleRounds,
      running: this.running,
      complete,
      ...(error ? { error } : {}),
    };
  }

  private collect(): Account[] {
    const out: Account[] = [];
    const now = Date.now();
    const cells = document.querySelectorAll(SEL.userCell);
    for (const cell of cells) {
      const parsed = parseUserCell(cell);
      if (!parsed) continue;
      // Re-send accounts we knew from a previous scan too, so bios refresh; but only once per run.
      const key = parsed.handle;
      if ((cell as HTMLElement).dataset.xffSeen === "1") continue;
      (cell as HTMLElement).dataset.xffSeen = "1";
      if (!this.seen.has(key)) this.newThisRun++;
      this.seen.add(key);
      out.push({ ...parsed, firstSeen: now, lastSeen: now });
    }
    return out;
  }

  private async loop(): Promise<void> {
    let lastHeight = -1;
    while (this.running) {
      // Navigated away? Stop cleanly.
      const route = parseListRoute(location.pathname);
      if (!route || route.owner !== this.owner || route.list !== this.list) {
        throw new Error("Left the list page; scan stopped.");
      }

      const batch = this.collect();
      if (batch.length) {
        this.idleRounds = 0;
        this.cb.onBatch(batch, this.progress(false));
      } else {
        this.idleRounds++;
      }

      const retry = findRetryButton();
      if (retry && this.retries < MAX_RETRY_CLICKS) {
        this.retries++;
        retry.click();
        await sleep(rand(2500, 4000));
        continue;
      }

      const loading = !!document.querySelector(`${SEL.primaryColumn} ${SEL.progressBar}`);
      const se = document.scrollingElement ?? document.documentElement;
      const atBottom = se.scrollTop + window.innerHeight >= se.scrollHeight - 4;
      const heightChanged = se.scrollHeight !== lastHeight;
      lastHeight = se.scrollHeight;

      if (!loading && atBottom && !heightChanged && this.idleRounds >= IDLE_ROUNDS_TO_FINISH) break;
      if (loading) this.idleRounds = Math.min(this.idleRounds, IDLE_ROUNDS_TO_FINISH - 3);

      // Scroll roughly three quarters of a viewport so virtualised cells are never skipped.
      window.scrollBy({ top: Math.round(window.innerHeight * 0.75) });
      await sleep(loading ? rand(900, 1500) : rand(450, 850));
    }
  }
}
