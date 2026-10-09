/**
 * Every X DOM selector lives here. When X changes its markup this is the only file to repair.
 * Prefer data-testid attributes: they are far more stable than class names.
 */
import type { Account, ListKind, PageInfo } from "../shared/types";
import { normalizeHandle } from "../shared/rules";

export const SEL = {
  primaryColumn: '[data-testid="primaryColumn"]',
  userCell: '[data-testid="UserCell"]',
  followIndicator: '[data-testid="userFollowIndicator"]',
  verifiedIcon: 'svg[data-testid="icon-verified"]',
  lockIcon: 'svg[data-testid="icon-lock"]',
  avatarImg: 'img[src*="profile_images"]',
  progressBar: '[role="progressbar"]',
  retryButton: 'button[role="button"]',
  profileNavLink: 'a[data-testid="AppTabBar_Profile_Link"]',
  accountSwitcher: '[data-testid="SideNav_AccountSwitcher_Button"]',
  // Profile page
  profileUserName: '[data-testid="UserName"]',
  userActions: '[data-testid="userActions"]',
  placementTracking: '[data-testid="placementTracking"]',
  unfollowButton: '[data-testid$="-unfollow"]',
  followButton: '[data-testid$="-follow"]',
  menu: '[role="menu"]',
  menuItem: '[role="menuitem"]',
  removeFollowerItem: '[data-testid="removeFollower"]',
  confirmButton: '[data-testid="confirmationSheetConfirm"]',
  cancelButton: '[data-testid="confirmationSheetCancel"]',
  toast: '[data-testid="toast"]',
  emptyState: '[data-testid="emptyState"]',
} as const;

export const TEXT = {
  removeFollower: /remove (this )?follower/i,
  rateLimited: /rate limit|too many requests|try again later|something went wrong/i,
  accountGone: /account doesn.t exist|account suspended|this account.s posts are protected/i,
  followsYou: /follows you/i,
  buttonLabels: /^(follow|following|follow back|unfollow|pending|blocked|follows you|click to (un)?follow)$/i,
} as const;

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const LIST_ROUTE_RE = /^\/([A-Za-z0-9_]{1,15})\/(followers|following|verified_followers|followers_you_follow)\/?$/;

export function parseListRoute(pathname: string): { owner: string; list: ListKind } | null {
  const m = LIST_ROUTE_RE.exec(pathname);
  if (!m) return null;
  const owner = normalizeHandle(m[1]!);
  const seg = m[2]!;
  const list: ListKind = seg === "following" ? "following" : "followers";
  return { owner, list };
}

export function listUrl(owner: string, list: ListKind): string {
  return `https://x.com/${owner}/${list}`;
}

export function profileUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

export function getLoggedInHandle(): string | null {
  const a = document.querySelector<HTMLAnchorElement>(SEL.profileNavLink);
  if (!a) return null;
  const path = new URL(a.href, location.origin).pathname.replace(/^\//, "");
  return HANDLE_RE.test(path) ? normalizeHandle(path) : null;
}

export function getPageInfo(): PageInfo {
  const route = parseListRoute(location.pathname);
  return {
    url: location.href,
    owner: route?.owner ?? null,
    list: route?.list ?? null,
    loggedInHandle: getLoggedInHandle(),
  };
}

function handleFromHref(href: string): string | null {
  let path: string;
  try {
    path = new URL(href, location.origin).pathname;
  } catch {
    return null;
  }
  const seg = path.replace(/^\//, "").split("/")[0] ?? "";
  if (!HANDLE_RE.test(seg)) return null;
  if (["home", "explore", "search", "i", "settings", "messages", "notifications", "compose"].includes(seg.toLowerCase())) return null;
  return normalizeHandle(seg);
}

function cleanText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Parses one follower/following list cell. Returns null when the handle cannot be determined.
 * Strategy: handle from the "@handle" link, name from the non-@ link to the same profile,
 * bio from the remaining dir="auto" text block; innerText line-diff as a fallback for the bio.
 */
export function parseUserCell(cell: Element): Omit<Account, "firstSeen" | "lastSeen"> | null {
  const links = Array.from(cell.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'));
  let handle: string | null = null;
  for (const a of links) {
    const t = cleanText(a.textContent);
    if (t.startsWith("@")) {
      const h = handleFromHref(a.href);
      if (h && normalizeHandle(t) === h) { handle = h; break; }
    }
  }
  if (!handle) {
    for (const a of links) {
      const h = handleFromHref(a.href);
      if (h) { handle = h; break; }
    }
  }
  if (!handle) return null;

  let name = "";
  for (const a of links) {
    if (handleFromHref(a.href) !== handle) continue;
    const t = cleanText(a.textContent);
    if (t && !t.startsWith("@") && !a.querySelector("img")) { name = t; break; }
  }

  const followsYou = !!cell.querySelector(SEL.followIndicator);
  const verified = !!cell.querySelector(SEL.verifiedIcon);
  const locked = !!cell.querySelector(SEL.lockIcon);
  const avatarUrl = cell.querySelector<HTMLImageElement>(SEL.avatarImg)?.src;

  // Structural bio extraction.
  let bio = "";
  const candidates = Array.from(cell.querySelectorAll<HTMLElement>('div[dir="auto"]')).filter((d) => {
    if (d.closest("a, button")) return false;
    if (d.closest(SEL.followIndicator)) return false;
    if (d.querySelector(`a[href="/${handle}"]`)) return false; // the name/handle row
    const t = cleanText(d.textContent);
    if (!t || t === name || normalizeHandle(t) === handle) return false;
    if (TEXT.buttonLabels.test(t) || TEXT.followsYou.test(t) && t.length < 12) return false;
    return true;
  });
  if (candidates.length) {
    // Outermost candidate with the longest text is the bio block (inner spans are its children).
    const outer = candidates.filter((d) => !candidates.some((o) => o !== d && o.contains(d)));
    bio = outer.map((d) => cleanText(d.innerText || d.textContent)).sort((a, b) => b.length - a.length)[0] ?? "";
  }
  if (!bio) {
    // Fallback: cell innerText minus the lines we can account for.
    const lines = ((cell as HTMLElement).innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const rest = lines.filter((l) => l !== name && normalizeHandle(l) !== handle && !TEXT.buttonLabels.test(l) && !TEXT.followsYou.test(l));
    bio = rest.join(" ");
  }

  return { handle, name, bio, followsYou, verified, locked, avatarUrl };
}

export function findRetryButton(): HTMLButtonElement | null {
  for (const b of document.querySelectorAll<HTMLButtonElement>(SEL.retryButton)) {
    if (/^retry$/i.test(cleanText(b.textContent))) return b;
  }
  return null;
}

export function readToastText(): string {
  return cleanText(document.querySelector(SEL.toast)?.textContent);
}
