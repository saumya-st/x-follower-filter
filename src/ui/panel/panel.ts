import type { AppState, Broadcast } from "../../shared/messages";
import { sendToBackground } from "../../shared/messages";
import type { Account, ActionKind, AiRunProgress, Label, LabelHit, ListKind, Preset, Queue, ScanSnapshot, Settings, WatchState } from "../../shared/types";
import type { AiLabelMap } from "../../shared/storage";
import { MODELS, PRESETS, SPAM_LABEL_ID, UNDO_SECONDS } from "../../shared/defaults";
import { nonMutuals } from "../../shared/history";
import { queueCounts } from "../../shared/queue";
import { compileLabels, hashText, matchLabels, matchesQuery, type CompiledLabel } from "../../shared/rules";
import { botScore } from "../../shared/score";

type Tab = ListKind | "changes";

// ---------- DOM ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  who: $("who"), whoText: $("whoText"), btnHelp: $<HTMLButtonElement>("btnHelp"), btnOptions: $<HTMLButtonElement>("btnOptions"),
  tabFollowers: $<HTMLButtonElement>("tabFollowers"), tabFollowing: $<HTMLButtonElement>("tabFollowing"), tabChanges: $<HTMLButtonElement>("tabChanges"),
  cntFollowers: $("cntFollowers"), cntFollowing: $("cntFollowing"), changesPip: $("changesPip"),
  toast: $("toast"),
  viewList: $("viewList"), viewChanges: $("viewChanges"),
  scanBar: $("scanBar"), scanInfo: $("scanInfo"), scanSub: $("scanSub"), btnScan: $<HTMLButtonElement>("btnScan"), btnStopScan: $<HTMLButtonElement>("btnStopScan"), scanProgress: $("scanProgress"),
  onboard: $("onboard"), onboardTitle: $("onboardTitle"), onboardText: $("onboardText"), stepLogin: $("stepLogin"), stepScan: $("stepScan"), btnScanBig: $<HTMLButtonElement>("btnScanBig"),
  toolbar: $("toolbar"), q: $<HTMLInputElement>("q"), btnFilters: $<HTMLButtonElement>("btnFilters"), filterCount: $("filterCount"),
  presetChips: $("presetChips"), drawer: $("drawer"), labelChips: $("labelChips"),
  fBots: $<HTMLInputElement>("fBots"), fUnlabeled: $<HTMLInputElement>("fUnlabeled"), fFollowsYou: $<HTMLInputElement>("fFollowsYou"), fFollowsYouText: $("fFollowsYouText"),
  fNoBio: $<HTMLInputElement>("fNoBio"), fNoAvatar: $<HTMLInputElement>("fNoAvatar"), fVerified: $<HTMLInputElement>("fVerified"),
  btnClearFilters: $<HTMLButtonElement>("btnClearFilters"), btnCloseDrawer: $<HTMLButtonElement>("btnCloseDrawer"),
  matchInfo: $("matchInfo"), btnResetFilters: $<HTMLButtonElement>("btnResetFilters"), btnSelectAll: $<HTMLButtonElement>("btnSelectAll"), btnMore: $<HTMLButtonElement>("btnMore"),
  list: $("list"), changes: $("changes"),
  aiStrip: $("aiStrip"), aiText: $("aiText"), btnAiCancel: $<HTMLButtonElement>("btnAiCancel"), btnAiDismiss: $<HTMLButtonElement>("btnAiDismiss"), aiBar: $("aiBar"),
  queueStrip: $("queueStrip"), queueText: $("queueText"), btnQueuePause: $<HTMLButtonElement>("btnQueuePause"), btnQueueResume: $<HTMLButtonElement>("btnQueueResume"), btnQueueDetails: $<HTMLButtonElement>("btnQueueDetails"),
  selBar: $("selBar"), selInfo: $("selInfo"), btnClearSel: $<HTMLButtonElement>("btnClearSel"), btnAct: $<HTMLButtonElement>("btnAct"),
  menuHost: $("menuHost"), modalHost: $("modalHost"),
};
const flagBoxes = () => [el.fBots, el.fUnlabeled, el.fFollowsYou, el.fNoBio, el.fNoAvatar, el.fVerified];

// ---------- state ----------
let state: AppState | null = null;
let settings: Settings | null = null;
let compiled: CompiledLabel[] = [];
let tab: Tab = "followers";
let owner: string | null = null;
let snapshots: Partial<Record<ListKind, ScanSnapshot | null>> = {};
let aiLabels: AiLabelMap = {};
let queue: Queue = { items: [], status: "idle", actionTimes: [] };
let aiProgress: AiRunProgress | null = null;
let aiDismissed = false;
const activeLabels = new Set<string>();
let activePreset: string | null = null;
const selected = new Set<string>();
let rows: Row[] = [];
let rendered = 0;
const PAGE = 150;
let changesOpen: string | null = null;
const pending = new Map<string, { deadline: number; timer: ReturnType<typeof setTimeout>; tick: ReturnType<typeof setInterval>; action: ActionKind; list: ListKind }>();

interface Row {
  a: Account;
  hits: LabelHit[];
  ai: { label: string; confidence: number; stale: boolean } | null;
  bot: { score: number; reasons: string[] };
}

// ---------- helpers ----------
const fmt = (n: number) => n.toLocaleString();
const labelById = (id: string): Label | undefined => settings?.labels.find((l) => l.id === id);
const currentList = (): ListKind => (tab === "following" ? "following" : "followers");
const actionFor = (list: ListKind): ActionKind => (list === "followers" ? "remove" : "unfollow");
const verb = (action: ActionKind) => (action === "remove" ? "Remove" : "Unfollow");
const loggedIn = () => state?.page?.loggedInHandle ?? null;

function until(ts: number): string {
  const s = (ts - Date.now()) / 1000;
  if (s < 60) return "soon";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} d`;
}

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, kind: "error" | "ok" | "" = "", ms = 5000) {
  el.toast.hidden = false;
  el.toast.className = `toast ${kind}`;
  el.toast.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

// ---------- modal / menu ----------
function openModal(html: string, cls = ""): HTMLElement {
  el.modalHost.innerHTML = `<div class="modal-bg"><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  const bg = el.modalHost.firstElementChild as HTMLElement;
  bg.addEventListener("click", (e) => { if (e.target === bg) closeModal(); });
  bg.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  (bg.querySelector<HTMLElement>("button.primary, button.danger, button") ?? bg).focus();
  return bg.firstElementChild as HTMLElement;
}
function closeModal() { el.modalHost.innerHTML = ""; }

function openMenu(anchor: HTMLElement, items: { label: string; hint?: string; disabled?: boolean; danger?: boolean; onClick: () => void }[]) {
  closeMenu();
  const m = document.createElement("div");
  m.className = "menu";
  for (const it of items) {
    const b = document.createElement("button");
    b.innerHTML = `<span>${escapeHtml(it.label)}</span>${it.hint ? `<span class="k">${escapeHtml(it.hint)}</span>` : ""}`;
    b.disabled = !!it.disabled;
    if (it.danger) b.style.color = "var(--danger)";
    b.addEventListener("click", () => { closeMenu(); it.onClick(); });
    m.appendChild(b);
  }
  el.menuHost.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8)}px`;
  m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8))}px`;
  setTimeout(() => document.addEventListener("pointerdown", onDocDown, { once: true }), 0);
}
function onDocDown(e: Event) { if (!(e.target as HTMLElement).closest(".menu")) closeMenu(); }
function closeMenu() { el.menuHost.innerHTML = ""; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); closeModal(); } });

// ---------- data loading ----------
async function refreshState() {
  state = await sendToBackground({ type: "GET_STATE" });
  settings = state.settings;
  queue = state.queue;
  aiProgress = state.ai;
  compiled = compileLabels(settings.labels);
  const me = loggedIn();
  owner = me ?? [...state.snapshots].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.owner ?? null;
  renderWho();
  await loadSnapshots();
  aiLabels = await sendToBackground({ type: "GET_AI_LABELS" });
  renderPresetChips();
  renderLabelChips();
  renderQueue(queue);
  renderAi(aiProgress);
  recompute();
}

async function loadSnapshots() {
  if (!owner) { snapshots = {}; renderCounts(); return; }
  const [f, g] = await Promise.all([
    sendToBackground({ type: "GET_SNAPSHOT", owner, list: "followers" }),
    sendToBackground({ type: "GET_SNAPSHOT", owner, list: "following" }),
  ]);
  snapshots = { followers: f, following: g };
  renderCounts();
}

function renderCounts() {
  const f = snapshots.followers, g = snapshots.following;
  el.cntFollowers.textContent = f ? fmt(Object.keys(f.accounts).length) : "";
  el.cntFollowing.textContent = g ? fmt(Object.keys(g.accounts).length) : "";
  const d = f?.lastDiff;
  el.changesPip.hidden = !((d && (d.added.length || d.removed.length)) || state?.watch?.unseenLeft.length);
}

function renderWho() {
  const me = loggedIn();
  el.who.className = `who ${me ? "ok" : owner ? "warn" : ""}`;
  el.whoText.textContent = me ? `@${me}` : owner ? `@${owner} · open x.com to scan or act` : "Not connected · open x.com and log in";
}

// ---------- filters ----------
function activeFlagCount(): number { return flagBoxes().filter((b) => b.checked).length; }
function hasFilters(): boolean { return activeLabels.size > 0 || activeFlagCount() > 0 || el.q.value.trim() !== ""; }

function renderPresetChips() {
  el.presetChips.innerHTML = "";
  const list = currentList();
  const all = document.createElement("span");
  all.className = `chip preset all${activePreset === null && !hasFilters() ? " on" : ""}`;
  all.textContent = "All";
  all.addEventListener("click", () => applyPreset(null));
  el.presetChips.appendChild(all);
  for (const p of PRESETS.filter((p) => p.list === "both" || p.list === list)) {
    const c = document.createElement("span");
    c.className = `chip preset${activePreset === p.id ? " on" : ""}`;
    c.title = p.hint;
    c.textContent = p.name;
    c.addEventListener("click", () => applyPreset(activePreset === p.id ? null : p));
    el.presetChips.appendChild(c);
  }
}

function applyPreset(p: Preset | null) {
  activeLabels.clear();
  for (const cb of flagBoxes()) cb.checked = false;
  el.q.value = "";
  activePreset = p?.id ?? null;
  if (p) {
    for (const id of p.labels ?? []) activeLabels.add(id);
    const f = p.flags ?? {};
    el.fNoBio.checked = !!f.noBio;
    el.fBots.checked = !!f.likelyBot;
    el.fNoAvatar.checked = !!f.noAvatar;
    el.fUnlabeled.checked = !!f.unlabeled;
    if (f.notFollowingBack && currentList() === "following") el.fFollowsYou.checked = true;
  }
  renderPresetChips();
  renderLabelChips();
  recompute();
}

function manualFilterChange() {
  if (activePreset) activePreset = null;
  renderPresetChips();
  recompute();
}

function renderLabelChips() {
  el.labelChips.innerHTML = "";
  const extra = [["other", "Other (AI)"], ["unknown", "Unknown (AI)"]] as const;
  const defs: { id: string; name: string; color: string; title?: string }[] = [
    ...(settings?.labels ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color })),
    ...extra.map(([id, name]) => ({ id, name, color: "#8b98a5", title: "Only assigned by the AI labeller" })),
  ];
  for (const d of defs) {
    const c = document.createElement("span");
    c.className = `chip${activeLabels.has(d.id) ? " on" : ""}`;
    c.style.setProperty("--c", d.color);
    if (d.title) c.title = d.title;
    c.dataset.id = d.id;
    c.innerHTML = `<span class="dot"></span>${escapeHtml(d.name)}<span class="n" data-count></span>`;
    c.addEventListener("click", () => { activeLabels.has(d.id) ? activeLabels.delete(d.id) : activeLabels.add(d.id); renderLabelChips(); manualFilterChange(); });
    el.labelChips.appendChild(c);
  }
}

function setDrawer(open: boolean) {
  el.drawer.hidden = !open;
  el.btnFilters.setAttribute("aria-expanded", String(open));
}

function clearFilters() {
  applyPreset(null);
}

// ---------- rows ----------
function buildRow(a: Account): Row {
  const hits = matchLabels(a, compiled);
  const ai = aiLabels[a.handle];
  return {
    a, hits,
    ai: ai ? { label: ai.label, confidence: ai.confidence, stale: ai.bioHash !== hashText(a.bio) } : null,
    bot: botScore(a, hits.some((h) => h.labelId === SPAM_LABEL_ID)),
  };
}

function rowLabels(r: Row): Set<string> {
  const s = new Set(r.hits.map((h) => h.labelId));
  if (r.ai) s.add(r.ai.label);
  return s;
}

function isBot(r: Row): boolean { return r.bot.score >= (settings?.botThreshold ?? 60); }

function recompute() {
  if (tab === "changes") { renderChanges(); return; }
  const list = currentList();
  const snap = snapshots[list];
  const scanningThis = !!state?.scan?.running && state.scan.list === list;
  renderScanBar();

  // Onboarding when there is nothing to show yet.
  const showOnboard = !snap && !scanningThis;
  el.onboard.hidden = !showOnboard;
  el.toolbar.hidden = showOnboard;
  el.list.hidden = showOnboard;
  if (showOnboard) { renderOnboard(list); updateSelection(); return; }

  const accounts = snap ? Object.values(snap.accounts) : [];
  const q = el.q.value;
  const all = accounts.map(buildRow);

  const counts = new Map<string, number>();
  for (const r of all) for (const id of rowLabels(r)) counts.set(id, (counts.get(id) ?? 0) + 1);
  el.labelChips.querySelectorAll<HTMLElement>(".chip").forEach((c) => {
    const n = counts.get(c.dataset.id ?? "") ?? 0;
    c.querySelector("[data-count]")!.textContent = n ? ` ${fmt(n)}` : "";
  });

  const nm = list === "following" ? new Set(nonMutuals(snapshots.followers?.accounts, snapshots.following?.accounts).notFollowingBack) : null;

  rows = all.filter((r) => {
    if (!matchesQuery(r.a, q)) return false;
    const labels = rowLabels(r);
    if (activeLabels.size && ![...activeLabels].some((id) => labels.has(id))) return false;
    if (el.fUnlabeled.checked && (r.hits.length || (r.ai && r.ai.label !== "unknown"))) return false;
    if (el.fFollowsYou.checked) {
      if (list === "followers" && !r.a.followsYou) return false;
      if (list === "following" && !(nm ? nm.has(r.a.handle) : !r.a.followsYou)) return false;
    }
    if (el.fNoBio.checked && r.a.bio.trim()) return false;
    if (el.fVerified.checked && !r.a.verified) return false;
    if (el.fNoAvatar.checked && !(r.a.avatarUrl ?? "").includes("default_profile")) return false;
    if (el.fBots.checked && !isBot(r)) return false;
    return true;
  });
  rows.sort((x, y) => (el.fBots.checked ? y.bot.score - x.bot.score : 0) || x.a.handle.localeCompare(y.a.handle));

  const present = new Set(accounts.map((a) => a.handle));
  for (const h of [...selected]) if (!present.has(h)) selected.delete(h);

  // Toolbar text
  const n = activeFlagCount() + activeLabels.size;
  el.filterCount.hidden = n === 0;
  el.filterCount.textContent = String(n);
  el.btnFilters.classList.toggle("active", n > 0);
  el.fFollowsYouText.textContent = list === "followers" ? "Follow you" : "Don't follow you back";
  const filtered = hasFilters();
  el.matchInfo.textContent = filtered ? `Showing ${fmt(rows.length)} of ${fmt(accounts.length)}` : `${fmt(accounts.length)} ${list}`;
  el.btnResetFilters.hidden = !filtered;
  renderPresetChips();
  renderList(true);
  updateSelection();
}

function renderOnboard(list: ListKind) {
  const me = loggedIn();
  const other = list === "followers" ? "following" : "followers";
  const haveOther = !!snapshots[other];
  el.onboardTitle.textContent = list === "followers" ? "Scan your followers" : "Scan who you follow";
  el.onboardText.textContent = haveOther
    ? `You have scanned your ${other}. Scanning ${list === "followers" ? "followers" : "following"} too unlocks the Changes tab's "not following back" views.`
    : `The extension opens your ${list} page on x.com and scrolls through it, the same way you would. Nothing is uploaded anywhere.`;
  el.stepLogin.className = me ? "done" : "current";
  el.stepScan.className = me ? "current" : "";
  el.btnScanBig.textContent = `Scan ${list}`;
  el.btnScanBig.disabled = !!state?.scan?.running;
}

function renderScanBar() {
  const list = currentList();
  const snap = snapshots[list];
  const p = state?.scan;
  const running = !!p?.running;
  const runningThis = running && p!.list === list;
  el.btnScan.hidden = running;
  el.btnStopScan.hidden = !runningThis;
  el.scanProgress.hidden = !runningThis;
  el.scanBar.hidden = !snap && !runningThis;
  if (runningThis && p) {
    el.scanInfo.textContent = `Scanning ${list}… ${fmt(p.scanned)} found`;
    el.scanSub.textContent = p.newThisRun ? `${fmt(p.newThisRun)} new this run · keep the x.com tab open` : "Keep the x.com tab open";
    el.scanProgress.classList.add("indeterminate");
  } else if (snap) {
    const n = Object.keys(snap.accounts).length;
    el.scanInfo.textContent = `${fmt(n)} ${list}${snap.complete ? "" : " (partial scan)"}`;
    el.scanSub.textContent = running ? `Scanning ${p!.list}…` : `Scanned ${ago(snap.updatedAt)}`;
    el.btnScan.textContent = "Rescan";
  } else {
    el.btnScan.textContent = "Scan";
  }
}

function renderList(reset: boolean) {
  if (reset) { el.list.innerHTML = ""; rendered = 0; }
  const frag = document.createDocumentFragment();
  const end = Math.min(rows.length, rendered + PAGE);
  for (let i = rendered; i < end; i++) frag.appendChild(renderRow(rows[i]!, currentList()));
  rendered = end;
  el.list.querySelector(".sentinel")?.remove();
  el.list.appendChild(frag);
  if (rows.length === 0) {
    const d = document.createElement("div");
    d.className = "empty";
    d.innerHTML = hasFilters()
      ? `<b>No matches</b><span>Nothing in your ${currentList()} list matches these filters.</span><button class="sm" id="emptyClear">Clear filters</button>`
      : `<b>Nothing here yet</b><span>The scan has not found any accounts.</span>`;
    d.querySelector("#emptyClear")?.addEventListener("click", clearFilters);
    el.list.appendChild(d);
  } else if (rendered < rows.length) {
    const s = document.createElement("div");
    s.className = "sentinel";
    el.list.appendChild(s);
    io.observe(s);
  }
}
const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) renderList(false); }, { root: null, rootMargin: "400px" });

function queueStateFor(handle: string, action: ActionKind): "queued" | "running" | null {
  const it = queue.items.find((i) => i.handle === handle && i.action === action && (i.status === "queued" || i.status === "running"));
  return it ? (it.status as "queued" | "running") : null;
}

function renderRow(r: Row, list: ListKind, opts: { selectable?: boolean } = {}): HTMLElement {
  const selectable = opts.selectable ?? true;
  const action = actionFor(list);
  const d = document.createElement("div");
  d.className = "rowitem";
  d.dataset.handle = r.a.handle;
  d.dataset.list = list;
  if (selectable) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(r.a.handle);
    cb.setAttribute("aria-label", `Select @${r.a.handle}`);
    cb.addEventListener("change", () => { cb.checked ? selected.add(r.a.handle) : selected.delete(r.a.handle); d.classList.toggle("sel", cb.checked); updateSelection(); });
    d.appendChild(cb);
    d.classList.toggle("sel", cb.checked);
  }
  const img = document.createElement("img");
  img.className = "avatar";
  img.loading = "lazy";
  img.alt = "";
  if (r.a.avatarUrl) img.src = r.a.avatarUrl;
  const body = document.createElement("div");
  body.className = "rbody";
  const tags = r.hits.map((h) => { const l = labelById(h.labelId); return `<span class="tag" style="--c:${l?.color ?? "#888"}" title="Matched: ${escapeHtml(h.terms.join(", "))}">${escapeHtml(l?.name ?? h.labelId)}</span>`; }).join("");
  const ai = r.ai ? `<span class="tag ai" style="--c:${labelById(r.ai.label)?.color ?? "#8b98a5"}" title="AI label · ${(r.ai.confidence * 100).toFixed(0)}% confident${r.ai.stale ? " · bio changed since" : ""}">AI: ${escapeHtml(labelById(r.ai.label)?.name ?? r.ai.label)}${r.ai.stale ? " ?" : ""}</span>` : "";
  const badges = [
    isBot(r) ? `<span class="badge bot" title="${escapeHtml(r.bot.reasons.join(", "))}">Likely bot · ${r.bot.score}</span>` : "",
    list === "following" ? (r.a.followsYou ? `<span class="badge ok">Follows you</span>` : `<span class="badge">No follow back</span>`) : "",
    r.a.verified ? `<span class="badge">Verified</span>` : "",
    r.a.locked ? `<span class="badge">Private</span>` : "",
  ].join("");
  body.innerHTML = `
    <div class="name"><b title="${escapeHtml(r.a.name || r.a.handle)}">${escapeHtml(r.a.name || r.a.handle)}</b> <a class="handle" href="https://x.com/${encodeURIComponent(r.a.handle)}" target="_blank" rel="noreferrer" title="Open profile">@${escapeHtml(r.a.handle)}</a></div>
    <div class="bio">${escapeHtml(r.a.bio) || '<span class="muted">No bio</span>'}</div>
    <div class="meta">${tags}${ai}${badges}</div>`;
  const bio = body.querySelector<HTMLElement>(".bio")!;
  if (r.a.bio.length > 90 || r.a.bio.includes("\n")) {
    bio.classList.add("clamped");
    bio.title = "Click to expand";
    bio.addEventListener("click", () => d.classList.toggle("open"));
  }
  const act = document.createElement("div");
  act.className = "act";
  fillAction(act, d, r.a.handle, action, list);
  d.append(img, body, act);
  return d;
}

function fillAction(act: HTMLElement, row: HTMLElement, handle: string, action: ActionKind, list: ListKind) {
  act.innerHTML = "";
  row.classList.remove("pending", "queued");
  const p = pending.get(handle);
  const qs = queueStateFor(handle, action);
  if (p) {
    row.classList.add("pending");
    const b = document.createElement("button");
    b.className = "undo";
    b.textContent = `Undo · ${Math.max(0, Math.ceil((p.deadline - Date.now()) / 1000))}`;
    b.addEventListener("click", () => cancelPending(handle));
    act.appendChild(b);
  } else if (qs === "running") {
    row.classList.add("queued");
    const s = document.createElement("span");
    s.className = "status";
    s.textContent = action === "remove" ? "Removing…" : "Unfollowing…";
    act.appendChild(s);
  } else if (qs === "queued") {
    row.classList.add("queued");
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = "Queued ✕";
    b.title = "Take out of the queue";
    b.addEventListener("click", () => void sendToBackground({ type: "QUEUE_REMOVE", handles: [handle] }));
    act.appendChild(b);
  } else {
    const b = document.createElement("button");
    b.className = "danger";
    b.textContent = verb(action);
    b.title = action === "remove" ? "Remove this follower. They are not notified. You get 5 seconds to undo." : "Unfollow this account. You get 5 seconds to undo.";
    b.disabled = !owner;
    b.addEventListener("click", () => startPending(handle, action, list));
    act.appendChild(b);
  }
}

function patchRow(handle: string) {
  document.querySelectorAll<HTMLElement>(`.rowitem[data-handle="${CSS.escape(handle)}"]`).forEach((row) => {
    const list = (row.dataset.list as ListKind) ?? currentList();
    const act = row.querySelector<HTMLElement>(".act");
    if (act) fillAction(act, row, handle, actionFor(list), list);
  });
}

function dropRow(handle: string, list: ListKind) {
  const snap = snapshots[list];
  if (snap) delete snap.accounts[handle];
  selected.delete(handle);
  document.querySelectorAll<HTMLElement>(`.rowitem[data-handle="${CSS.escape(handle)}"][data-list="${list}"]`).forEach((r) => r.remove());
  if (tab === list) {
    rows = rows.filter((r) => r.a.handle !== handle);
    rendered = Math.min(rendered, rows.length);
    const total = Object.keys(snap?.accounts ?? {}).length;
    el.matchInfo.textContent = hasFilters() ? `Showing ${fmt(rows.length)} of ${fmt(total)}` : `${fmt(total)} ${list}`;
    updateSelection();
  }
  renderCounts();
  renderScanBar();
}

// ---------- pending (undo) ----------
function startPending(handle: string, action: ActionKind, list: ListKind) {
  if (!owner || pending.has(handle)) return;
  const deadline = Date.now() + UNDO_SECONDS * 1000;
  const tick = setInterval(() => patchRow(handle), 250);
  const timer = setTimeout(async () => {
    clearInterval(tick);
    pending.delete(handle);
    try {
      const r = await sendToBackground({ type: "QUEUE_ADD", owner: owner!, list, action, handles: [handle], preview: false });
      if (!r.ok) toast(r.error ?? "Could not queue.", "error");
    } catch (e) {
      toast(errMsg(e), "error");
    }
    patchRow(handle);
  }, UNDO_SECONDS * 1000);
  pending.set(handle, { deadline, timer, tick, action, list });
  patchRow(handle);
}

function cancelPending(handle: string) {
  const p = pending.get(handle);
  if (!p) return;
  clearTimeout(p.timer);
  clearInterval(p.tick);
  pending.delete(handle);
  patchRow(handle);
}

// ---------- bulk ----------
function openBulkDialog(handles: string[], action: ActionKind, list: ListKind, title: string) {
  if (!owner || !handles.length) return;
  const cap = settings?.maxPerHour ?? 60;
  const n = handles.length;
  const what = action === "remove" ? `removed from your followers. They are not notified.` : `unfollowed.`;
  const hours = Math.ceil(n / cap);
  const modal = openModal(`
    <h2>${escapeHtml(title)}</h2>
    <p class="small"><b>${fmt(n)}</b> account${n === 1 ? "" : "s"} will be ${what}</p>
    <p class="small muted">This runs one account at a time in a hidden background tab, with a pause between each. At most ${cap} per hour${hours > 1 ? `, so this batch takes about ${hours} hours` : ""}. Your protected accounts are skipped. You can pause from the bar at the bottom.</p>
    <label class="inline small"><input type="checkbox" id="mPreview" /> Preview only. Walk through the list without changing anything.</label>
    <div class="actions">
      <button class="ghost" data-close>Cancel</button>
      <button class="danger solid" id="mGo">${verb(action)} ${fmt(n)}</button>
    </div>`);
  const preview = modal.querySelector<HTMLInputElement>("#mPreview")!;
  const go = modal.querySelector<HTMLButtonElement>("#mGo")!;
  preview.addEventListener("change", () => {
    go.textContent = preview.checked ? `Preview ${fmt(n)}` : `${verb(action)} ${fmt(n)}`;
    go.classList.toggle("solid", !preview.checked);
  });
  go.addEventListener("click", async () => {
    closeModal();
    try {
      const r = await sendToBackground({ type: "QUEUE_ADD", owner: owner!, list, action, handles, preview: preview.checked });
      if (!r.ok) { toast(r.error ?? "Could not queue.", "error"); return; }
      const bits = [`${fmt(r.added)} queued`];
      if (r.skipped) bits.push(`${r.skipped} protected, skipped`);
      if (r.duplicates) bits.push(`${r.duplicates} already queued`);
      toast(bits.join(" · ") + (preview.checked ? " (preview)" : ""), "ok");
      selected.clear();
      renderList(true);
      updateSelection();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  });
}

function updateSelection() {
  const list = currentList();
  const n = selected.size;
  el.selBar.hidden = tab === "changes" || n === 0;
  el.selInfo.textContent = `${fmt(n)} selected`;
  el.btnAct.textContent = `${verb(actionFor(list))} ${fmt(n)}`;
  el.btnAct.disabled = n === 0 || !owner;
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.a.handle));
  el.btnSelectAll.textContent = allSelected ? "Deselect all" : "Select all";
  el.btnSelectAll.disabled = rows.length === 0;
}

// ---------- queue strip ----------
function renderQueue(q: Queue) {
  queue = q;
  const c = queueCounts(q);
  const live = c.queued + c.running;
  const finished = c.done + c.failed + c.skipped;
  const show = live > 0 || finished > 0 || q.status === "paused" || !!q.lastError;
  el.queueStrip.hidden = !show;
  if (!show) return;
  let cls = "", text = "";
  const unit = (n: number, w: string) => `${fmt(n)} ${w}`;
  if (q.status === "capped") {
    cls = "paused";
    text = `Hourly limit reached · resumes ${q.cappedUntil ? new Date(q.cappedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "soon"} · ${unit(c.queued, "waiting")}`;
  } else if (q.status === "paused") {
    cls = "paused";
    text = `Paused · ${unit(c.queued, "waiting")}`;
  } else if (live) {
    cls = "running";
    text = `${unit(live, "to go")} · ${fmt(c.done)} done${c.failed ? ` · ${c.failed} failed` : ""}`;
  } else {
    cls = c.failed ? "error" : "finished";
    text = `${unit(c.done, "done")}${c.failed ? ` · ${c.failed} failed` : ""}${c.skipped ? ` · ${c.skipped} skipped` : ""}`;
  }
  if (q.lastError) { cls = "error"; text = q.lastError; }
  el.queueStrip.className = `strip queue ${cls}`;
  el.queueText.textContent = text;
  el.queueText.title = text;
  el.btnQueuePause.hidden = !(q.status === "running" || (q.status === "idle" && live));
  el.btnQueueResume.hidden = !(q.status === "paused" || q.status === "capped");
  el.btnQueueResume.textContent = q.status === "capped" ? "Resume anyway" : "Resume";
  el.btnQueueDetails.textContent = live ? "Details" : "Details";
  if (el.modalHost.querySelector(".qdetails")) openQueueDetails();
}

function openQueueDetails() {
  const q = queue;
  const c = queueCounts(q);
  const items = [...q.items].sort((a, b) => (b.finishedAt ?? b.at) - (a.finishedAt ?? a.at)).slice(0, 80);
  const rowsHtml = items.map((i) => {
    let r = "", cls = "";
    if (i.status === "done") { r = i.preview ? "preview" : (i.reason ? `done · ${i.reason}` : "done"); cls = "ok"; }
    else if (i.status === "failed") { r = `failed · ${i.reason ?? ""}`; cls = "fail"; }
    else if (i.status === "skipped") r = `skipped · ${i.reason ?? ""}`;
    else r = i.status === "running" ? "working…" : "waiting";
    const x = i.status === "queued" ? `<button class="icon sm" data-x="${escapeHtml(i.handle)}" title="Take out of the queue">✕</button>` : "";
    return `<div class="qrow"><span>${i.action === "remove" ? "Remove" : "Unfollow"} <b>@${escapeHtml(i.handle)}</b></span><span class="r ${cls}">${escapeHtml(r)}${x}</span></div>`;
  }).join("");
  const modal = openModal(`
    <h2>Queue</h2>
    <p class="small muted">${fmt(c.queued)} waiting · ${fmt(c.running)} working · ${fmt(c.done)} done${c.failed ? ` · ${fmt(c.failed)} failed` : ""}${c.skipped ? ` · ${fmt(c.skipped)} skipped` : ""}</p>
    ${q.lastError ? `<div class="notice error small">${escapeHtml(q.lastError)}</div>` : ""}
    <div class="qlist">${rowsHtml || '<div class="qrow muted">Empty</div>'}</div>
    <div class="actions" style="justify-content:space-between">
      <span class="row">
        ${c.done + c.failed + c.skipped ? `<button class="sm ghost" id="qClear">Clear finished</button>` : ""}
        ${q.workerTabId != null ? `<button class="sm ghost" id="qShow" title="Show the hidden tab doing the work">Show worker tab</button>` : ""}
      </span>
      <button class="sm" data-close>Close</button>
    </div>`, "qdetails");
  modal.querySelector("#qClear")?.addEventListener("click", () => void sendToBackground({ type: "QUEUE_CLEAR_DONE" }));
  modal.querySelector("#qShow")?.addEventListener("click", () => void sendToBackground({ type: "FOCUS_WORKER_TAB" }));
  modal.querySelectorAll<HTMLButtonElement>("[data-x]").forEach((b) => b.addEventListener("click", () => void sendToBackground({ type: "QUEUE_REMOVE", handles: [b.dataset.x!] })));
}

// ---------- AI ----------
function renderAi(p: AiRunProgress | null) {
  aiProgress = p;
  const running = !!p?.running;
  if (running) aiDismissed = false;
  const show = !!p && (running || !aiDismissed) && (p.total > 0 || !!p.error);
  el.aiStrip.hidden = !show;
  if (!show) return;
  el.btnAiCancel.hidden = !running;
  el.btnAiDismiss.hidden = running;
  el.aiBar.hidden = !running;
  (el.aiBar.firstElementChild as HTMLElement).style.width = `${p!.total ? (p!.done / p!.total) * 100 : 0}%`;
  el.aiText.textContent = p!.error
    ? `AI labelling failed: ${p!.error}`
    : `${running ? "Labelling" : "Labelled"} ${fmt(p!.done)} of ${fmt(p!.total)} · $${p!.costUsd.toFixed(4)}`;
  el.aiStrip.classList.toggle("error", !!p!.error);
}

async function openAiDialog() {
  if (!owner) return;
  const list = currentList();
  const inView = rows.length;
  const unl = rows.filter((r) => !r.hits.length && (!r.ai || r.ai.stale)).map((r) => r.a.handle);
  const allH = rows.map((r) => r.a.handle);
  const model = MODELS.find((m) => m.id === settings?.model)?.name ?? settings?.model ?? "";
  const modal = openModal(`
    <h2>Label with AI</h2>
    <p class="small muted">Sends the bios of the accounts currently shown to Claude with your own API key and assigns one of your categories to each. Nothing is removed or unfollowed by this step.</p>
    <label class="small">Which accounts
      <select id="mScope" style="margin-top:4px">
        <option value="unlabeled">Shown accounts with no category yet (${fmt(unl.length)})</option>
        <option value="all">All shown accounts (${fmt(inView)})</option>
      </select>
    </label>
    <dl class="kv" id="mEst"><dt>Model</dt><dd>${escapeHtml(model)}</dd><dt>Estimate</dt><dd class="muted">Calculating…</dd></dl>
    <div class="actions">
      <button class="ghost" data-close>Cancel</button>
      <button class="primary" id="mRun" disabled>Label</button>
    </div>`);
  const scope = modal.querySelector<HTMLSelectElement>("#mScope")!;
  scope.value = settings?.aiScope ?? "unlabeled";
  const est = modal.querySelector<HTMLElement>("#mEst")!;
  const run = modal.querySelector<HTMLButtonElement>("#mRun")!;
  let handles: string[] = [];
  const estimate = async () => {
    handles = scope.value === "all" ? allH : unl;
    run.disabled = true;
    run.textContent = `Label ${fmt(handles.length)}`;
    if (!handles.length) { est.innerHTML = `<dt>Estimate</dt><dd class="muted">Nothing to label in the current view.</dd>`; return; }
    if (!settings?.apiKey) {
      est.innerHTML = `<dt>API key</dt><dd>Add your Anthropic API key in <a href="#" id="mOpt">Settings</a> first.</dd>`;
      est.querySelector("#mOpt")?.addEventListener("click", (e) => { e.preventDefault(); closeModal(); void sendToBackground({ type: "OPEN_OPTIONS" }); });
      return;
    }
    est.innerHTML = `<dt>Model</dt><dd>${escapeHtml(model)}</dd><dt>Estimate</dt><dd class="muted">Calculating…</dd>`;
    try {
      const r = await sendToBackground({ type: "AI_ESTIMATE", owner: owner!, list, handles });
      est.innerHTML = `<dt>Model</dt><dd>${escapeHtml(model)}</dd><dt>Accounts</dt><dd>${fmt(r.accounts)} in ${r.batches} request${r.batches === 1 ? "" : "s"}</dd><dt>Tokens</dt><dd>~${fmt(r.inputTokens)} in · ~${fmt(r.estOutputTokens)} out</dd><dt>Cost</dt><dd><b>≈ $${r.costUsd.toFixed(4)}</b></dd>`;
      run.disabled = false;
    } catch (e) {
      est.innerHTML = `<dt>Estimate</dt><dd style="color:var(--danger)">${escapeHtml(errMsg(e))}</dd>`;
    }
  };
  scope.addEventListener("change", () => void estimate());
  run.addEventListener("click", async () => {
    run.disabled = true;
    try {
      const r = await sendToBackground({ type: "AI_RUN", owner: owner!, list, handles });
      if (!r.ok) { toast(r.error ?? "Could not start.", "error"); run.disabled = false; return; }
      closeModal();
    } catch (e) {
      toast(errMsg(e), "error");
      run.disabled = false;
    }
  });
  await estimate();
}

// ---------- changes tab ----------
interface Section { key: string; title: string; sub: string; accounts: Account[]; list: ListKind; action: ActionKind | null; actionLabel: string; tone?: "up" | "down"; targets?: Account[] }

function renderChanges() {
  const f = snapshots.followers, g = snapshots.following;
  const host = el.changes;
  host.innerHTML = "";
  if (!f && !g) {
    host.innerHTML = `<section class="onboard"><div class="onboard-icon">🔁</div><h2>See who comes and goes</h2><p class="muted">After you have scanned twice, this tab shows new followers, who unfollowed you, and who does not follow you back.</p><button class="primary lg" id="chScanF">Scan followers</button></section>`;
    host.querySelector("#chScanF")?.addEventListener("click", () => void startScan("followers"));
    return;
  }
  const nm = nonMutuals(f?.accounts, g?.accounts);
  const sections: Section[] = [];
  if (f) {
    const added = (f.lastDiff?.added ?? []).map((h) => f.accounts[h]).filter((a): a is Account => !!a);
    const departed = Object.values(f.departed ?? {}).sort((a, b) => b.departedAt - a.departedAt);
    const stillFollowed = g ? departed.filter((d) => d.handle in g.accounts) : [];
    const since = f.lastDiff ? `since ${ago(f.lastDiff.previousAt)}` : "needs a second scan";
    sections.push({ key: "new", title: "New followers", sub: since, accounts: added, list: "followers", action: "remove", actionLabel: "Remove all", tone: "up" });
    sections.push({ key: "left", title: "Unfollowed you", sub: f.lastDiff ? (stillFollowed.length ? `${fmt(stillFollowed.length)} you still follow` : "all time") : "needs a second scan", accounts: departed, list: "following", action: stillFollowed.length ? "unfollow" : null, actionLabel: `Unfollow back (${fmt(stillFollowed.length)})`, tone: "down", targets: stillFollowed });
  }
  if (f && g) {
    sections.push({ key: "notback", title: "Not following you back", sub: "you follow them", accounts: nm.notFollowingBack.map((h) => g.accounts[h]!), list: "following", action: "unfollow", actionLabel: "Unfollow all" });
    sections.push({ key: "fans", title: "You don't follow back", sub: "they follow you", accounts: nm.fans.map((h) => f.accounts[h]!), list: "followers", action: "remove", actionLabel: "Remove all" });
  }

  if (changesOpen === null) changesOpen = sections.find((s) => s.key === "left" && s.accounts.length)?.key ?? sections.find((s) => s.accounts.length)?.key ?? null;

  const tiles = document.createElement("div");
  tiles.className = "tiles";
  for (const s of sections) {
    const b = document.createElement("button");
    b.className = `tile${changesOpen === s.key ? " on" : ""}`;
    const sign = s.accounts.length && s.tone === "up" ? "+" : s.accounts.length && s.tone === "down" ? "−" : "";
    b.innerHTML = `<span class="num ${s.accounts.length ? s.tone ?? "" : ""}">${sign}${fmt(s.accounts.length)}</span><span class="lbl">${escapeHtml(s.title)}</span><span class="sub">${escapeHtml(s.sub)}</span>`;
    b.addEventListener("click", () => { changesOpen = changesOpen === s.key ? null : s.key; renderChanges(); });
    tiles.appendChild(b);
  }
  if (f && !g) {
    for (const [title, sub] of [["Not following you back", "scan Following to see"], ["You don't follow back", "scan Following to see"]]) {
      const b = document.createElement("button");
      b.className = "tile";
      b.disabled = true;
      b.innerHTML = `<span class="num">–</span><span class="lbl">${title}</span><span class="sub">${sub}</span>`;
      tiles.appendChild(b);
    }
  }
  host.appendChild(tiles);

  if (f && !g) {
    const card = document.createElement("div");
    card.className = "card hintcard";
    card.innerHTML = `<div class="small"><b>Scan who you follow</b> to see who does not follow you back, and to unfollow people who unfollowed you.</div><button class="sm primary" id="chScanG">Scan following</button>`;
    card.querySelector("#chScanG")?.addEventListener("click", () => void startScan("following"));
    host.appendChild(card);
  }

  const open = sections.find((s) => s.key === changesOpen);
  if (open) {
    const panel = document.createElement("div");
    panel.className = "cpanel";
    const head = document.createElement("div");
    head.className = "cpanel-head";
    head.innerHTML = `<h3>${escapeHtml(open.title)} <span class="muted small">${fmt(open.accounts.length)} · ${escapeHtml(open.sub)}</span></h3>`;
    const targets = open.targets ?? open.accounts;
    if (open.action && targets.length) {
      const b = document.createElement("button");
      b.className = "danger sm";
      b.textContent = open.actionLabel;
      b.disabled = !owner;
      b.addEventListener("click", () => openBulkDialog(targets.map((a) => a.handle), open.action!, open.list, `${open.actionLabel.replace(/ \(.*\)$/, "")}: ${open.title}`));
      head.appendChild(b);
    }
    panel.appendChild(head);
    if (!open.accounts.length) {
      panel.insertAdjacentHTML("beforeend", `<div class="empty"><b>Nothing here</b><span>${open.key === "new" || open.key === "left" ? (f?.lastDiff ? "No change since the previous scan." : "Rescan your followers later and the difference shows up here.") : "Everyone matches."}</span></div>`);
    } else {
      const show = open.accounts.slice(0, 100);
      for (const a of show) {
        const rowList: ListKind = open.key === "left" ? (g && a.handle in g.accounts ? "following" : "followers") : open.list;
        const row = renderRow(buildRow(a), rowList, { selectable: false });
        if (open.key === "left" && !(g && a.handle in g.accounts)) row.querySelector(".act")!.innerHTML = `<span class="status">left ${ago((a as { departedAt?: number }).departedAt ?? 0)}</span>`;
        panel.appendChild(row);
      }
      if (open.accounts.length > show.length) panel.insertAdjacentHTML("beforeend", `<div class="more">…and ${fmt(open.accounts.length - show.length)} more. Use the ${open.list} tab with filters to work through all of them.</div>`);
    }
    host.appendChild(panel);
  }

  host.appendChild(renderWatchCard());

  // Scan metadata
  const meta = document.createElement("div");
  meta.className = "card scanmeta";
  const running = state?.scan?.running ? state.scan.list : null;
  const line = (list: ListKind, s: ScanSnapshot | null | undefined) => {
    const left = s ? `<b>${fmt(Object.keys(s.accounts).length)}</b> ${list} · scanned ${ago(s.updatedAt)}` : `${list[0]!.toUpperCase()}${list.slice(1)} · not scanned`;
    const btn = running === list ? `<span class="muted">Scanning…</span>` : `<button class="sm ghost" data-scan="${list}" ${running ? "disabled" : ""}>${s ? "Rescan" : "Scan"}</button>`;
    return `<div class="line"><span>${left}</span>${btn}</div>`;
  };
  meta.innerHTML = line("followers", f) + line("following", g) + `<div class="small muted">Changes are computed between complete scans. Rescan regularly to keep this up to date.</div>`;
  meta.querySelectorAll<HTMLButtonElement>("[data-scan]").forEach((b) => b.addEventListener("click", () => void startScan(b.dataset.scan as ListKind)));
  host.appendChild(meta);
}

// ---------- unfollow alerts ----------
function renderWatchCard(): HTMLElement {
  const w = state?.watch;
  const card = document.createElement("div");
  card.className = "card watchcard";
  if (!settings?.watchEnabled || !w) {
    card.innerHTML = `<div class="small"><b>Unfollow alerts are off.</b> <span class="muted">Turn them on to rescan your followers every few hours and get a notification when someone leaves.</span></div><button class="sm" id="wSettings">Turn on in Settings</button>`;
    card.querySelector("#wSettings")?.addEventListener("click", () => void sendToBackground({ type: "OPEN_OPTIONS" }));
    return card;
  }
  const parts = [w.running ? "Checking now…" : w.lastRunAt ? `Last check ${ago(w.lastRunAt)}` : "No check yet"];
  if (!w.running && w.nextRunAt) parts.push(`next ${until(w.nextRunAt)}`);
  card.innerHTML = `<div class="small"><b>Unfollow alerts are on</b>${w.owner ? ` for @${escapeHtml(w.owner)}` : ""}. <span class="muted">${escapeHtml(parts.join(" · "))}</span></div>${w.lastError ? `<div class="small err">${escapeHtml(w.lastError)}</div>` : ""}<button class="sm ghost" id="wCheck" ${w.running || state?.scan?.running ? "disabled" : ""}>Check now</button>`;
  card.querySelector("#wCheck")?.addEventListener("click", async (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    try {
      const r = await sendToBackground({ type: "WATCH_CHECK_NOW" });
      if (!r.ok) toast(r.error ?? "Could not start the check.", "error");
      else toast("Checking your followers in a small background window…", "ok");
    } catch (err) { toast(errMsg(err), "error"); }
  });
  return card;
}

function markWatchSeen() {
  const w = state?.watch;
  if (w && (w.unseenLeft.length || w.unseenNew)) void sendToBackground({ type: "WATCH_SEEN" });
}

// ---------- help ----------
function openHelp() {
  openModal(`
    <h2>How it works</h2>
    <div class="help">
      <h3>1. Scan</h3>
      <p>With x.com open and logged in, press <b>Scan</b>. The extension scrolls through your followers (or following) page and remembers each account. Nothing is uploaded.</p>
      <h3>2. Filter</h3>
      <p><b>Quick views</b> are one-tap filters such as "Likely bots". <b>Filters</b> lets you combine categories (from bio keywords you can edit in Settings) with traits like "no bio".</p>
      <h3>3. Act</h3>
      <ul>
        <li><b>Remove</b> on a row acts on that one account after a 5 second <b>Undo</b> window.</li>
        <li>Tick boxes, then use the bar at the bottom for several at once. You get a confirmation with a <b>Preview only</b> option.</li>
        <li>Actions run slowly in a hidden background tab, with an hourly limit you can change in Settings. Pause any time.</li>
      </ul>
      <h3>Changes</h3>
      <p>After a second scan, the Changes tab shows new followers, who unfollowed you and who does not follow back. Turn on <b>Unfollow alerts</b> in Settings to rescan automatically every few hours and get notified when someone leaves.</p>
      <h3>Label with AI (optional)</h3>
      <p>Found under ⋯. Sends bios to Claude with your own API key to categorise accounts your keywords miss. Shows the cost before anything runs.</p>
    </div>
    <div class="actions"><button class="primary" data-close>Got it</button></div>`);
}

// ---------- actions ----------
function exportCsv() {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = ["handle,name,bio,follows_you,verified,labels,ai_label,ai_confidence,bot_score"];
  for (const r of rows) {
    lines.push([
      r.a.handle, r.a.name, r.a.bio, String(r.a.followsYou), String(r.a.verified),
      r.hits.map((h) => h.labelId).join("|"), r.ai?.label ?? "", r.ai ? r.ai.confidence.toFixed(2) : "", String(r.bot.score),
    ].map(esc).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${owner ?? "x"}-${currentList()}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Exported ${fmt(rows.length)} accounts.`, "ok");
}

async function startScan(list: ListKind) {
  if (state?.scan?.running) { toast("A scan is already running.", ""); return; }
  for (const b of [el.btnScan, el.btnScanBig]) b.disabled = true;
  try {
    const r = await sendToBackground({ type: "START_SCAN", list });
    if (!r.ok) toast(r.error ?? "Could not start the scan.", "error");
  } catch (e) {
    toast(errMsg(e), "error", 8000);
  } finally {
    for (const b of [el.btnScan, el.btnScanBig]) b.disabled = false;
  }
}

function switchTab(t: Tab) {
  tab = t;
  for (const b of [el.tabFollowers, el.tabFollowing, el.tabChanges]) b.classList.toggle("on", b.dataset.tab === t);
  const changes = t === "changes";
  el.viewList.hidden = changes;
  el.viewChanges.hidden = !changes;
  if (changes) markWatchSeen();
  selected.clear();
  activePreset = null;
  for (const cb of flagBoxes()) cb.checked = false;
  activeLabels.clear();
  el.q.value = "";
  setDrawer(false);
  renderLabelChips();
  recompute();
}

// ---------- wiring ----------
el.tabFollowers.addEventListener("click", () => switchTab("followers"));
el.tabFollowing.addEventListener("click", () => switchTab("following"));
el.tabChanges.addEventListener("click", () => switchTab("changes"));
el.btnScan.addEventListener("click", () => void startScan(currentList()));
el.btnScanBig.addEventListener("click", () => void startScan(currentList()));
el.btnStopScan.addEventListener("click", () => void sendToBackground({ type: "STOP_SCAN" }));
el.btnOptions.addEventListener("click", () => void sendToBackground({ type: "OPEN_OPTIONS" }));
el.btnHelp.addEventListener("click", openHelp);
el.btnFilters.addEventListener("click", () => setDrawer(!!el.drawer.hidden));
el.btnCloseDrawer.addEventListener("click", () => setDrawer(false));
el.btnClearFilters.addEventListener("click", clearFilters);
el.btnResetFilters.addEventListener("click", clearFilters);
let qTimer: ReturnType<typeof setTimeout> | undefined;
el.q.addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(manualFilterChange, 120); });
for (const cb of flagBoxes()) cb.addEventListener("change", manualFilterChange);
el.btnSelectAll.addEventListener("click", () => {
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.a.handle));
  if (allSelected) selected.clear(); else rows.forEach((r) => selected.add(r.a.handle));
  renderList(true);
  updateSelection();
});
el.btnClearSel.addEventListener("click", () => { selected.clear(); renderList(true); updateSelection(); });
el.btnAct.addEventListener("click", () => {
  const list = currentList();
  openBulkDialog([...selected], actionFor(list), list, `${verb(actionFor(list))} ${fmt(selected.size)} selected`);
});
el.btnMore.addEventListener("click", () => {
  const list = currentList();
  const labelled = Object.values(snapshots[list]?.accounts ?? {}).filter((a) => aiLabels[a.handle]).length;
  openMenu(el.btnMore, [
    { label: "Label with AI…", hint: labelled ? `${fmt(labelled)} labelled` : "", disabled: !owner || rows.length === 0, onClick: () => void openAiDialog() },
    { label: "Export shown as CSV", hint: fmt(rows.length), disabled: rows.length === 0, onClick: exportCsv },
    { label: `Rescan ${list}`, disabled: !!state?.scan?.running, onClick: () => void startScan(list) },
    { label: `Forget scanned ${list}`, danger: true, disabled: !owner || !snapshots[list], onClick: () => confirmForget(list) },
  ]);
});
el.btnQueuePause.addEventListener("click", () => void sendToBackground({ type: "QUEUE_PAUSE" }));
el.btnQueueResume.addEventListener("click", () => void sendToBackground({ type: "QUEUE_RESUME" }));
el.btnQueueDetails.addEventListener("click", openQueueDetails);
el.btnAiCancel.addEventListener("click", () => void sendToBackground({ type: "AI_CANCEL" }));
el.btnAiDismiss.addEventListener("click", () => { aiDismissed = true; renderAi(aiProgress); });

function confirmForget(list: ListKind) {
  const modal = openModal(`
    <h2>Forget scanned ${list}?</h2>
    <p class="small muted">Deletes the saved ${list} list and its change history from this browser. Nothing happens on X. You can scan again any time.</p>
    <div class="actions"><button class="ghost" data-close>Cancel</button><button class="danger solid" id="mForget">Forget</button></div>`);
  modal.querySelector("#mForget")?.addEventListener("click", async () => {
    closeModal();
    try {
      await sendToBackground({ type: "CLEAR_SNAPSHOT", owner: owner!, list });
      changesOpen = null;
      await loadSnapshots();
      recompute();
      toast(`Forgot your scanned ${list}.`, "ok");
    } catch (e) { toast(errMsg(e), "error"); }
  });
}

chrome.runtime.onMessage.addListener((msg: Broadcast) => {
  switch (msg.type) {
    case "SCAN_PROGRESS":
      if (state) state.scan = msg.progress;
      if (msg.progress.error) toast(msg.progress.error, "error", 8000);
      if (!msg.progress.running) { changesOpen = null; void loadSnapshots().then(recompute); }
      else if (msg.progress.scanned % 200 < 40) void loadSnapshots().then(recompute);
      else { renderScanBar(); if (tab === "changes") renderChanges(); else if (el.onboard && !el.onboard.hidden) recompute(); }
      break;
    case "QUEUE_UPDATED": {
      const prevLive = new Set(queue.items.filter((i) => i.status === "queued" || i.status === "running").map((i) => i.handle));
      renderQueue(msg.queue);
      const nowLive = new Set(msg.queue.items.filter((i) => i.status === "queued" || i.status === "running").map((i) => i.handle));
      for (const h of new Set([...prevLive, ...nowLive])) patchRow(h);
      if (msg.finished?.ok) {
        const it = msg.queue.items.find((i) => i.handle === msg.finished!.handle && i.status === "done");
        if (it && !it.preview) dropRow(msg.finished.handle, msg.finished.list);
      }
      break;
    }
    case "AI_PROGRESS":
      renderAi(msg.progress);
      if (!msg.progress.running) void sendToBackground({ type: "GET_AI_LABELS" }).then((m) => { aiLabels = m; recompute(); });
      break;
    case "PAGE_INFO": {
      const me = msg.page?.loggedInHandle ?? null;
      if (state) state.page = msg.page;
      if (me && me !== owner) void refreshState();
      else { renderWho(); if (tab !== "changes" && !el.onboard.hidden) renderOnboard(currentList()); }
      break;
    }
    case "STATE_CHANGED":
      void refreshState();
      break;
    case "WATCH_UPDATED":
      if (state) state.watch = msg.watch;
      renderCounts();
      if (tab === "changes") { renderChanges(); markWatchSeen(); }
      break;
  }
});

void refreshState();
