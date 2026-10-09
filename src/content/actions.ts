import type { ActionKind, ActionResult } from "../shared/types";
import { SEL, TEXT, readToastText } from "./selectors";
import { rand, sleep, waitFor, waitUntilGone } from "./wait";

function cleanText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function primaryColumn(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SEL.primaryColumn);
}

function profileHeader(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`${SEL.primaryColumn} ${SEL.profileUserName}`);
}

function headerShowsHandle(handle: string): boolean {
  const h = profileHeader();
  return !!h && cleanText(h.textContent).toLowerCase().includes(`@${handle}`);
}

function findMenuItemByText(re: RegExp): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(SEL.menuItem)) {
    if (re.test(cleanText(el.textContent))) return el;
  }
  return null;
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
}

function rateLimitCheck(): ActionResult | null {
  const toast = readToastText();
  if (toast && TEXT.rateLimited.test(toast)) {
    return { ok: false, reason: `X responded: "${toast}"`, rateLimited: true };
  }
  return null;
}

/**
 * Performs one action on the profile page that is currently loaded in this tab.
 * The service worker navigates here first; we only verify, click and confirm.
 */
export async function performAction(action: ActionKind, handle: string): Promise<ActionResult> {
  const header = await waitFor(() => (headerShowsHandle(handle) ? profileHeader() : null), 12000);
  if (!header) {
    const body = cleanText(primaryColumn()?.textContent);
    if (TEXT.accountGone.test(body)) return { ok: false, reason: "account unavailable (suspended, deleted or protected)" };
    if (profileHeader()) return { ok: false, reason: "a different profile loaded" };
    return { ok: false, reason: "profile did not load" };
  }
  await sleep(rand(400, 900));
  const result = action === "remove" ? await removeFollower() : await unfollow();
  return rateLimitCheck() ?? result;
}

async function removeFollower(): Promise<ActionResult> {
  const col = primaryColumn()!;
  const indicator = () => col.querySelector(SEL.followIndicator);
  if (!indicator()) return { ok: true, reason: "no longer follows you" };

  const more = await waitFor(() => col.querySelector<HTMLElement>(SEL.userActions), 5000);
  if (!more) return { ok: false, reason: "more-actions button not found" };
  more.click();
  const menu = await waitFor(() => document.querySelector(SEL.menu), 4000);
  if (!menu) return { ok: false, reason: "menu did not open" };
  await sleep(rand(250, 600));
  const item = document.querySelector<HTMLElement>(SEL.removeFollowerItem) ?? findMenuItemByText(TEXT.removeFollower);
  if (!item) {
    pressEscape();
    return { ok: false, reason: "'Remove this follower' not in menu (X layout changed?)" };
  }
  item.click();
  const confirm = await waitFor(() => document.querySelector<HTMLElement>(SEL.confirmButton), 4000);
  if (!confirm) return { ok: false, reason: "confirmation dialog missing" };
  await sleep(rand(300, 700));
  confirm.click();
  const gone = await waitUntilGone(indicator, 8000);
  return gone ? { ok: true } : { ok: false, reason: "X did not confirm the removal" };
}

async function unfollow(): Promise<ActionResult> {
  const col = primaryColumn()!;
  const scope = () => col.querySelector<HTMLElement>(SEL.placementTracking) ?? col;
  const unfollowBtn = await waitFor(() => scope().querySelector<HTMLElement>(SEL.unfollowButton), 5000);
  if (!unfollowBtn) {
    if (scope().querySelector(SEL.followButton)) return { ok: true, reason: "already not following" };
    return { ok: false, reason: "follow state button not found" };
  }
  unfollowBtn.click();
  const confirm = await waitFor(() => document.querySelector<HTMLElement>(SEL.confirmButton), 4000);
  if (!confirm) return { ok: false, reason: "confirmation dialog missing" };
  await sleep(rand(300, 700));
  confirm.click();
  const done = await waitFor(() => (scope().querySelector(SEL.followButton) && !scope().querySelector(SEL.unfollowButton) ? true : null), 8000);
  return done ? { ok: true } : { ok: false, reason: "X did not confirm the unfollow" };
}
