/**
 * DOM waiting helpers that work in hidden/background tabs. Chrome throttles timers in hidden tabs
 * (and heavily after 5 minutes), but MutationObserver callbacks are not throttled, so we react to DOM
 * changes instead of polling and keep a single timer only for the deadline.
 */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const rand = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

export function waitFor<T>(pred: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const first = safe(pred);
    if (first) { resolve(first); return; }
    let finished = false;
    const finish = (v: T | null) => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(v);
    };
    const observer = new MutationObserver(() => {
      const v = safe(pred);
      if (v) finish(v);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  });
}

/** Resolves true when `pred()` becomes falsy, null on timeout. */
export function waitUntilGone(pred: () => unknown, timeoutMs: number): Promise<true | null> {
  return waitFor(() => (safe(pred) ? null : true), timeoutMs);
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
