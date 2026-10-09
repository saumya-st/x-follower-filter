import type { AppState, Broadcast } from "../../shared/messages";
import { sendToBackground } from "../../shared/messages";
import type { Account, ActionKind, AiRunProgress, Label, LabelHit, ListKind, Preset, Queue, ScanSnapshot, Settings } from "../../shared/types";
import type { AiLabelMap } from "../../shared/storage";
import { PRESETS, SPAM_LABEL_ID, UNDO_SECONDS } from "../../shared/defaults";
import { nonMutuals } from "../../shared/history";
import { queueCounts } from "../../shared/queue";
import { compileLabels, hashText, matchLabels, matchesQuery, type CompiledLabel } from "../../shared/rules";
import { botScore } from "../../shared/score";

type Tab = ListKind | "changes";

// ---------- DOM ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  who: $("who"), diffBadge: $("diffBadge"),
  tabFollowers: $<HTMLButtonElement>("tabFollowers"), tabFollowing: $<HTMLButtonElement>("tabFollowing"), tabChanges: $<HTMLButtonElement>("tabChanges"),
  cntFollowers: $("cntFollowers"), cntFollowing: $("cntFollowing"), scanInfo: $("scanInfo"), scanRow: $("scanRow"),
  btnScan: $<HTMLButtonElement>("btnScan"), btnStopScan: $<HTMLButtonElement>("btnStopScan"), scanBar: $("scanBar"),
  banner: $("banner"), filters: $("filters"), q: $<HTMLInputElement>("q"), presetChips: $("presetChips"), labelChips: $("labelChips"),
  fUnlabeled: $<HTMLInputElement>("fUnlabeled"), fFollowsYou: $<HTMLInputElement>("fFollowsYou"), fFollowsYouText: $("fFollowsYouText"),
  fNoBio: $<HTMLInputElement>("fNoBio"), fVerified: $<HTMLInputElement>("fVerified"), fNoAvatar: $<HTMLInputElement>("fNoAvatar"), fBots: $<HTMLInputElement>("fBots"),
  matchInfo: $("matchInfo"), btnAllShown: $<HTMLButtonElement>("btnAllShown"), btnSelectAll: $<HTMLButtonElement>("btnSelectAll"),
  btnClearSel: $<HTMLButtonElement>("btnClearSel"), btnExport: $<HTMLButtonElement>("btnExport"),
  list: $("list"), changes: $("changes"), queueBox: $("queueBox"),
  aiBox: $<HTMLDetailsElement>("aiBox"), aiSummary: $("aiSummary"), aiScope: $<HTMLSelectElement>("aiScope"),
  btnAiEstimate: $<HTMLButtonElement>("btnAiEstimate"), btnAiRun: $<HTMLButtonElement>("btnAiRun"), btnAiCancel: $<HTMLButtonElement>("btnAiCancel"),
  aiInfo: $("aiInfo"), aiBar: $("aiBar"), selRow: $("selRow"), selInfo: $("selInfo"), btnAct: $<HTMLButtonElement>("btnAct"),
  btnOptions: $<HTMLButtonElement>("btnOptions"), modalHost: $("modalHost"),
};

// ---------- state ----------
let state: AppState | null = null;
let settings: Settings | null = null;
let compiled: CompiledLabel[] = [];
let tab: Tab = "followers";
let owner: string | null = null;
let snapshots: Partial<Record<ListKind, ScanSnapshot | null>> = {};
let aiLabels: AiLabelMap = {};
let queue: Queue = { items: [], status: "idle", actionTimes: [] };
const activeLabels = new Set<string>();
let activePreset: string | null = null;
const selected = new Set<string>();
let rows: Row[] = [];
let rendered = 0;
const PAGE = 150;
let aiHandles: string[] = [];
const pending = new Map<string, { deadline: number; timer: ReturnType<typeof setTimeout>; tick: ReturnType<typeof setInterval>; action: ActionKind; list: ListKind }>();

interface Row {
  a: Account;
  hits: LabelHit[];
  ai: { label: string; confidence: number; stale: boolean } | null;
  bot: { score: number; reasons: string[] };
}

const fmt = (n: number) => n.toLocaleString();
const labelById = (id: string): Label | undefined => settings?.labels.find((l) => l.id === id);
const currentList = (): ListKind => (tab === "following" ? "following" : "followers");
const actionFor = (list: ListKind): ActionKind => (list === "followers" ? "remove" : "unfollow");
const verbFor = (action: ActionKind, n = 1) => (action === "remove" ? `Remove ${n === 1 ? "follower" : "followers"}` : "Unfollow");

function banner(text: string, kind: "error" | "ok" | "" = "", timeoutMs = 6000) {
  el.banner.hidden = false;
  el.banner.className = `notice ${kind}`;
  el.banner.textContent = text;
  if (timeoutMs) setTimeout(() => { if (el.banner.textContent === text) el.banner.hidden = true; }, timeoutMs);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

// ---------- data loading ----------
async function refreshState() {
  state = await sendToBackground({ type: "GET_STATE" });
  settings = state.settings;
  queue = state.queue;
  compiled = compileLabels(settings.labels);
  el.aiScope.value = settings.aiScope;
  const me = state.page?.loggedInHandle ?? null;
  owner = me ?? [...state.snapshots].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.owner ?? null;
  el.who.textContent = me ? `@${me}` : owner ? `Saved data for @${owner} (open x.com to scan)` : "Open x.com and log in, then scan.";
  await loadSnapshots();
  aiLabels = await sendToBackground({ type: "GET_AI_LABELS" });
  renderPresetChips();
  renderLabelChips();
  renderScan(state.scan);
  renderQueue(queue);
  renderAi(state.ai);
  recompute();
}

async function loadSnapshots() {
  if (!owner) { snapshots = {}; return; }
  const [f, g] = await Promise.all([
    sendToBackground({ type: "GET_SNAPSHOT", owner, list: "followers" }),
    sendToBackground({ type: "GET_SNAPSHOT", owner, list: "following" }),
  ]);
  snapshots = { followers: f, following: g };
  el.cntFollowers.textContent = f ? `(${fmt(Object.keys(f.accounts).length)})` : "";
  el.cntFollowing.textContent = g ? `(${fmt(Object.keys(g.accounts).length)})` : "";
  renderDiffBadge();
}

function renderDiffBadge() {
  const d = snapshots.followers?.lastDiff;
  if (!d || (!d.added.length && !d.removed.length)) { el.diffBadge.textContent = ""; return; }
  el.diffBadge.innerHTML = `<b class="up">+${fmt(d.added.length)}</b> / <b class="down">−${fmt(d.removed.length)}</b> followers since last scan`;
}

// ---------- chips ----------
function renderPresetChips() {
  el.presetChips.innerHTML = "";
  const list = currentList();
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
  for (const cb of [el.fUnlabeled, el.fFollowsYou, el.fNoBio, el.fVerified, el.fNoAvatar, el.fBots]) cb.checked = false;
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
  if (activePreset) { activePreset = null; renderPresetChips(); }
  recompute();
}

function renderLabelChips() {
  el.labelChips.innerHTML = "";
  const extra = [["other", "Other (AI)"], ["unknown", "Unknown (AI)"]] as const;
  const defs: { id: string; name: string; color: string; title?: string }[] = [
    ...(settings?.labels ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color })),
    ...extra.map(([id, name]) => ({ id, name, color: "#8b98a5", title: "AI-only label" })),
  ];
  for (const d of defs) {
    const c = document.createElement("span");
    c.className = `chip${activeLabels.has(d.id) ? " on" : ""}`;
    c.style.setProperty("--c", d.color);
    if (d.title) c.title = d.title;
    c.dataset.id = d.id;
    c.innerHTML = `<span class="dot"></span>${escapeHtml(d.name)} <span class="muted" data-count></span>`;
    c.addEventListener("click", () => { activeLabels.has(d.id) ? activeLabels.delete(d.id) : activeLabels.add(d.id); renderLabelChips(); manualFilterChange(); });
    el.labelChips.appendChild(c);
  }
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

function isBot(r: Row): boolean {
  return r.bot.score >= (settings?.botThreshold ?? 60);
}

function recompute() {
  if (tab === "changes") { renderChanges(); return; }
  const list = currentList();
  const snap = snapshots[list];
  const accounts = snap ? Object.values(snap.accounts) : [];
  const q = el.q.value;
  const all = accounts.map(buildRow);

  const counts = new Map<string, number>();
  for (const r of all) for (const id of rowLabels(r)) counts.set(id, (counts.get(id) ?? 0) + 1);
  el.labelChips.querySelectorAll<HTMLElement>(".chip").forEach((c) => {
    const n = counts.get(c.dataset.id ?? "") ?? 0;
    c.querySelector("[data-count]")!.textContent = n ? String(n) : "";
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

  el.matchInfo.textContent = `${fmt(rows.length)} of ${fmt(accounts.length)} ${list}`;
  el.fFollowsYouText.textContent = list === "followers" ? "Follows you" : "Doesn't follow back";
  el.scanInfo.textContent = snap
    ? `${fmt(accounts.length)} ${list} · ${snap.complete ? "complete" : "partial"} · ${new Date(snap.updatedAt).toLocaleString()}`
    : "Not scanned yet.";
  el.btnAllShown.textContent = `${list === "followers" ? "Remove" : "Unfollow"} all shown`;
  el.btnAllShown.disabled = rows.length === 0 || !owner;
  renderList(true);
  updateSelection();
  updateAiSummary();
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
    d.textContent = snapshots[currentList()] ? "No accounts match these filters." : `Click Scan to read your ${currentList()} list.`;
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

function renderRow(r: Row, list: ListKind): HTMLElement {
  const action = actionFor(list);
  const d = document.createElement("div");
  d.className = "rowitem";
  d.dataset.handle = r.a.handle;
  d.dataset.list = list;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = selected.has(r.a.handle);
  cb.addEventListener("change", () => { cb.checked ? selected.add(r.a.handle) : selected.delete(r.a.handle); d.classList.toggle("sel", cb.checked); updateSelection(); });
  const img = document.createElement("img");
  img.className = "avatar";
  img.loading = "lazy";
  img.alt = "";
  if (r.a.avatarUrl) img.src = r.a.avatarUrl;
  const body = document.createElement("div");
  const tags = r.hits.map((h) => { const l = labelById(h.labelId); return `<span class="tag" style="--c:${l?.color ?? "#888"}" title="matched: ${escapeHtml(h.terms.join(", "))}">${escapeHtml(l?.name ?? h.labelId)}</span>`; }).join("");
  const ai = r.ai ? `<span class="tag ai" style="--c:${labelById(r.ai.label)?.color ?? "#8b98a5"}" title="AI label · confidence ${(r.ai.confidence * 100).toFixed(0)}%${r.ai.stale ? " · bio changed since" : ""}">AI: ${escapeHtml(labelById(r.ai.label)?.name ?? r.ai.label)}${r.ai.stale ? " ?" : ""}</span>` : "";
  const badges = [
    isBot(r) ? `<span class="badge bot" title="${escapeHtml(r.bot.reasons.join(", "))}">bot ${r.bot.score}</span>` : "",
    r.a.followsYou ? `<span class="badge">follows you</span>` : (list === "following" ? `<span class="badge">no follow back</span>` : ""),
    r.a.verified ? `<span class="badge">verified</span>` : "",
    r.a.locked ? `<span class="badge">protected</span>` : "",
  ].join("");
  body.innerHTML = `
    <div class="name">${escapeHtml(r.a.name || r.a.handle)} <a class="handle" href="https://x.com/${encodeURIComponent(r.a.handle)}" target="_blank" rel="noreferrer">@${escapeHtml(r.a.handle)}</a></div>
    <div class="bio">${escapeHtml(r.a.bio) || '<span class="muted">(no bio)</span>'}</div>
    <div class="meta">${tags}${ai}${badges}</div>`;
  const act = document.createElement("div");
  act.className = "act";
  fillAction(act, d, r.a.handle, action, list);
  d.append(cb, img, body, act);
  d.classList.toggle("sel", cb.checked);
  d.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest("a, input, button")) return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event("change"));
  });
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
    b.className = "primary";
    b.textContent = `Undo ${Math.max(0, Math.ceil((p.deadline - Date.now()) / 1000))}`;
    b.addEventListener("click", () => cancelPending(handle));
    act.appendChild(b);
    const s = document.createElement("span");
    s.className = "status";
    s.textContent = action === "remove" ? "removing…" : "unfollowing…";
    act.appendChild(s);
  } else if (qs === "running") {
    row.classList.add("queued");
    const s = document.createElement("span");
    s.className = "status";
    s.textContent = "working…";
    act.appendChild(s);
  } else if (qs === "queued") {
    row.classList.add("queued");
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = "Queued ✕";
    b.title = "Remove from queue";
    b.addEventListener("click", () => void sendToBackground({ type: "QUEUE_REMOVE", handles: [handle] }));
    act.appendChild(b);
  } else {
    const b = document.createElement("button");
    b.className = "danger";
    b.textContent = action === "remove" ? "Remove" : "Unfollow";
    b.title = action === "remove" ? "Remove this follower (they are not notified)" : "Unfollow this account";
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
    el.matchInfo.textContent = `${fmt(rows.length)} of ${fmt(Object.keys(snap?.accounts ?? {}).length)} ${list}`;
    updateSelection();
  }
  const n = Object.keys(snap?.accounts ?? {}).length;
  (list === "followers" ? el.cntFollowers : el.cntFollowing).textContent = snap ? `(${fmt(n)})` : "";
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
      if (!r.ok) banner(r.error ?? "Could not queue.", "error");
    } catch (e) {
      banner(e instanceof Error ? e.message : String(e), "error");
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
  const host = el.modalHost;
  host.innerHTML = `
    <div class="modal-bg">
      <div class="modal">
        <h2>${escapeHtml(title)}</h2>
        <div class="small">${fmt(handles.length)} account${handles.length === 1 ? "" : "s"} will be ${action === "remove" ? "removed from your followers (they are not notified)" : "unfollowed"}, one at a time in a hidden background tab.</div>
        <div class="small muted">Limit: ${cap} actions per hour. Anything beyond that waits automatically. Protected accounts are skipped.</div>
        <label class="inline small"><input type="checkbox" id="mPreview" /> Preview only — don't actually ${action === "remove" ? "remove" : "unfollow"}</label>
        <div class="row" style="justify-content:flex-end">
          <button class="ghost" id="mCancel">Cancel</button>
          <button class="danger" id="mGo">${escapeHtml(verbFor(action, handles.length))} ${fmt(handles.length)}</button>
        </div>
      </div>
    </div>`;
  const close = () => (host.innerHTML = "");
  host.querySelector("#mCancel")!.addEventListener("click", close);
  host.querySelector(".modal-bg")!.addEventListener("click", (e) => { if (e.target === e.currentTarget) close(); });
  const preview = host.querySelector<HTMLInputElement>("#mPreview")!;
  preview.addEventListener("change", () => { host.querySelector("#mGo")!.textContent = preview.checked ? `Preview ${fmt(handles.length)}` : `${verbFor(action, handles.length)} ${fmt(handles.length)}`; });
  host.querySelector("#mGo")!.addEventListener("click", async () => {
    close();
    try {
      const r = await sendToBackground({ type: "QUEUE_ADD", owner: owner!, list, action, handles, preview: preview.checked });
      if (!r.ok) { banner(r.error ?? "Could not queue.", "error"); return; }
      const bits = [`Queued ${fmt(r.added)}`];
      if (r.skipped) bits.push(`${r.skipped} protected`);
      if (r.duplicates) bits.push(`${r.duplicates} already queued`);
      banner(bits.join(" · ") + (preview.checked ? " (preview)" : ""), "ok");
      selected.clear();
      renderList(true);
      updateSelection();
    } catch (e) {
      banner(e instanceof Error ? e.message : String(e), "error");
    }
  });
}

function updateSelection() {
  el.selInfo.textContent = `${fmt(selected.size)} selected`;
  const list = currentList();
  el.btnAct.textContent = `${list === "followers" ? "Remove" : "Unfollow"} selected${selected.size ? ` (${fmt(selected.size)})` : ""}`;
  el.btnAct.disabled = selected.size === 0 || !owner;
}

// ---------- scan / queue / ai rendering ----------
function renderScan(p: AppState["scan"]) {
  const running = !!p?.running;
  el.btnScan.hidden = running;
  el.btnStopScan.hidden = !running;
  el.scanBar.hidden = !running;
  el.tabFollowers.disabled = running;
  el.tabFollowing.disabled = running;
  if (p && running) {
    el.scanInfo.textContent = `Scanning ${p.list}… ${fmt(p.scanned)} accounts (${fmt(p.newThisRun)} new)`;
    (el.scanBar.firstElementChild as HTMLElement).style.width = `${Math.min(95, 20 + p.idleRounds * 7)}%`;
  } else if (p?.error) {
    banner(p.error, "error", 8000);
  }
}

function renderQueue(q: Queue) {
  queue = q;
  const c = queueCounts(q);
  const live = c.queued + c.running;
  const finished = c.done + c.failed + c.skipped;
  if (!live && !finished && q.status !== "paused" && !q.lastError) { el.queueBox.hidden = true; el.queueBox.innerHTML = ""; return; }
  el.queueBox.hidden = false;
  let statusText = "";
  if (q.status === "running") statusText = "Running";
  else if (q.status === "paused") statusText = "Paused";
  else if (q.status === "capped") statusText = `Hourly limit reached · resumes ${q.cappedUntil ? new Date(q.cappedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "soon"}`;
  else statusText = live ? "Starting…" : "Finished";
  const items = [...q.items].sort((a, b) => (b.finishedAt ?? b.at) - (a.finishedAt ?? a.at)).slice(0, 40);
  const listHtml = items.map((i) => {
    const r = i.status === "done" ? (i.preview ? "preview" : (i.reason ? `done · ${i.reason}` : "done")) : i.status === "failed" ? `failed · ${i.reason ?? ""}` : i.status === "skipped" ? `skipped · ${i.reason ?? ""}` : i.status;
    const x = i.status === "queued" ? `<button class="ghost sm" data-x="${escapeHtml(i.handle)}" title="Remove from queue">✕</button>` : "";
    return `<div class="qrow"><span class="mono">${i.action === "remove" ? "−" : "↩"} @${escapeHtml(i.handle)}</span><span class="r">${escapeHtml(r)} ${x}</span></div>`;
  }).join("");
  el.queueBox.innerHTML = `
    <div class="row between">
      <strong>Queue · ${escapeHtml(statusText)}</strong>
      <span class="small muted">${fmt(c.queued)} waiting · ${fmt(c.running)} working · ${fmt(c.done)} done${c.failed ? ` · ${fmt(c.failed)} failed` : ""}${c.skipped ? ` · ${fmt(c.skipped)} skipped` : ""}</span>
    </div>
    ${q.lastError ? `<div class="notice error small">${escapeHtml(q.lastError)}</div>` : ""}
    <div class="row">
      ${q.status === "running" || (q.status === "idle" && live) ? `<button class="sm" id="qPause">Pause</button>` : ""}
      ${q.status === "paused" || q.status === "capped" ? `<button class="sm primary" id="qResume">${q.status === "capped" ? "Resume now anyway" : "Resume"}</button>` : ""}
      ${finished ? `<button class="sm ghost" id="qClear">Clear finished</button>` : ""}
      ${q.workerTabId != null ? `<button class="sm ghost" id="qShow" title="Show the hidden background tab">Show worker tab</button>` : ""}
      <details class="small" style="margin-left:auto"><summary>${fmt(q.items.length)} items</summary><div class="qlist">${listHtml}</div></details>
    </div>`;
  el.queueBox.querySelector("#qPause")?.addEventListener("click", () => void sendToBackground({ type: "QUEUE_PAUSE" }));
  el.queueBox.querySelector("#qResume")?.addEventListener("click", () => void sendToBackground({ type: "QUEUE_RESUME" }));
  el.queueBox.querySelector("#qClear")?.addEventListener("click", () => void sendToBackground({ type: "QUEUE_CLEAR_DONE" }));
  el.queueBox.querySelector("#qShow")?.addEventListener("click", () => void sendToBackground({ type: "FOCUS_WORKER_TAB" }));
  el.queueBox.querySelectorAll<HTMLButtonElement>("[data-x]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); void sendToBackground({ type: "QUEUE_REMOVE", handles: [b.dataset.x!] }); }));
}

function renderAi(p: AiRunProgress | null) {
  const running = !!p?.running;
  el.btnAiCancel.hidden = !running;
  el.btnAiRun.disabled = running || aiHandles.length === 0;
  el.btnAiEstimate.disabled = running;
  el.aiBar.hidden = !running;
  if (p) {
    (el.aiBar.firstElementChild as HTMLElement).style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
    el.aiInfo.textContent = p.error
      ? `Error: ${p.error}`
      : `${running ? "Labelling" : "Labelled"} ${fmt(p.done)}/${fmt(p.total)} · ${fmt(p.inputTokens)} in / ${fmt(p.outputTokens)} out tokens · $${p.costUsd.toFixed(4)}`;
    if (p.error) el.aiBox.open = true;
  }
  if (state) state.ai = p;
}

function updateAiSummary() {
  const n = Object.values(snapshots[currentList()]?.accounts ?? {}).filter((a) => aiLabels[a.handle]).length;
  el.aiSummary.textContent = n ? `· ${fmt(n)} labelled` : "";
}

// ---------- changes tab ----------
function renderChanges() {
  const f = snapshots.followers, g = snapshots.following;
  el.changes.innerHTML = "";
  if (!f && !g) {
    el.changes.innerHTML = `<div class="empty">Scan your followers (and following) first. Changes appear after the second scan.</div>`;
    return;
  }
  const nm = nonMutuals(f?.accounts, g?.accounts);
  const sections: { title: string; hint: string; accounts: Account[]; list: ListKind; action: ActionKind | null; actionLabel?: string }[] = [];
  if (f) {
    const added = (f.lastDiff?.added ?? []).map((h) => f.accounts[h]).filter((a): a is Account => !!a);
    sections.push({ title: "New followers", hint: f.lastDiff ? `since ${new Date(f.lastDiff.previousAt).toLocaleDateString()}` : "needs two scans", accounts: added, list: "followers", action: "remove", actionLabel: "Remove all" });
    const departed = Object.values(f.departed ?? {}).sort((a, b) => b.departedAt - a.departedAt);
    const stillFollowed = g ? departed.filter((d) => d.handle in g.accounts) : [];
    sections.push({ title: "Unfollowed you", hint: stillFollowed.length ? `${stillFollowed.length} you still follow` : "", accounts: departed, list: "following", action: stillFollowed.length ? "unfollow" : null, actionLabel: `Unfollow back (${stillFollowed.length})` });
  }
  if (f && g) {
    sections.push({ title: "Not following you back", hint: "you follow them, they don't follow you", accounts: nm.notFollowingBack.map((h) => g.accounts[h]!), list: "following", action: "unfollow", actionLabel: "Unfollow all" });
    sections.push({ title: "You don't follow back", hint: "they follow you, you don't follow them", accounts: nm.fans.map((h) => f.accounts[h]!), list: "followers", action: "remove", actionLabel: "Remove all" });
  } else {
    el.changes.insertAdjacentHTML("beforeend", `<div class="section small muted">Scan both Followers and Following to see who doesn't follow back.</div>`);
  }
  for (const s of sections) {
    const sec = document.createElement("div");
    sec.className = "section";
    const head = document.createElement("h3");
    head.innerHTML = `<span>${escapeHtml(s.title)} <span class="muted small">${fmt(s.accounts.length)}${s.hint ? ` · ${escapeHtml(s.hint)}` : ""}</span></span>`;
    if (s.action && s.accounts.length) {
      const b = document.createElement("button");
      b.className = "danger sm";
      b.textContent = s.actionLabel ?? "Remove all";
      const targets = s.title === "Unfollowed you" && g ? s.accounts.filter((a) => a.handle in g.accounts) : s.accounts;
      b.addEventListener("click", () => openBulkDialog(targets.map((a) => a.handle), s.action!, s.list, `${s.actionLabel ?? "Remove all"}: ${s.title}`));
      head.appendChild(b);
    }
    sec.appendChild(head);
    if (!s.accounts.length) {
      sec.insertAdjacentHTML("beforeend", `<div class="small muted">Nothing here.</div>`);
    } else {
      const rowsEl = document.createElement("div");
      const show = s.accounts.slice(0, 100);
      for (const a of show) {
        const rowList: ListKind = s.title === "Unfollowed you" ? (g && a.handle in g.accounts ? "following" : "followers") : s.list;
        const row = renderRow(buildRow(a), rowList);
        if (s.title === "Unfollowed you" && !(g && a.handle in g.accounts)) row.querySelector(".act")!.innerHTML = `<span class="status">left ${new Date((a as { departedAt?: number }).departedAt ?? 0).toLocaleDateString()}</span>`;
        rowsEl.appendChild(row);
      }
      if (s.accounts.length > show.length) rowsEl.insertAdjacentHTML("beforeend", `<div class="small muted" style="padding:6px 0">…and ${fmt(s.accounts.length - show.length)} more. Use the ${s.list} tab with filters to see everyone.</div>`);
      sec.appendChild(rowsEl);
    }
    el.changes.appendChild(sec);
  }
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
}

function computeAiHandles(): string[] {
  const scope = el.aiScope.value;
  return rows.filter((r) => scope === "all" || (!r.hits.length && (!r.ai || r.ai.stale))).map((r) => r.a.handle);
}

function switchTab(t: Tab) {
  tab = t;
  for (const b of [el.tabFollowers, el.tabFollowing, el.tabChanges]) b.classList.toggle("on", b.dataset.tab === t);
  const changes = t === "changes";
  el.filters.hidden = changes;
  el.list.hidden = changes;
  el.changes.hidden = !changes;
  el.selRow.hidden = changes;
  el.aiBox.hidden = changes;
  el.scanRow.hidden = changes;
  selected.clear();
  activePreset = null;
  renderPresetChips();
  recompute();
}

// ---------- wiring ----------
el.tabFollowers.addEventListener("click", () => switchTab("followers"));
el.tabFollowing.addEventListener("click", () => switchTab("following"));
el.tabChanges.addEventListener("click", () => switchTab("changes"));
el.btnScan.addEventListener("click", async () => {
  el.btnScan.disabled = true;
  try {
    const r = await sendToBackground({ type: "START_SCAN", list: currentList() });
    if (!r.ok) banner(r.error ?? "Could not start scan.", "error");
  } catch (e) {
    banner(e instanceof Error ? e.message : String(e), "error");
  } finally {
    el.btnScan.disabled = false;
  }
});
el.btnStopScan.addEventListener("click", () => void sendToBackground({ type: "STOP_SCAN" }));
el.btnOptions.addEventListener("click", () => void sendToBackground({ type: "OPEN_OPTIONS" }));
let qTimer: ReturnType<typeof setTimeout> | undefined;
el.q.addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(manualFilterChange, 120); });
for (const cb of [el.fUnlabeled, el.fFollowsYou, el.fNoBio, el.fVerified, el.fNoAvatar, el.fBots]) cb.addEventListener("change", manualFilterChange);
el.btnSelectAll.addEventListener("click", () => { rows.forEach((r) => selected.add(r.a.handle)); renderList(true); updateSelection(); });
el.btnClearSel.addEventListener("click", () => { selected.clear(); renderList(true); updateSelection(); });
el.btnExport.addEventListener("click", exportCsv);
el.btnAllShown.addEventListener("click", () => {
  const list = currentList();
  openBulkDialog(rows.map((r) => r.a.handle), actionFor(list), list, `${list === "followers" ? "Remove" : "Unfollow"} all shown`);
});
el.btnAct.addEventListener("click", () => {
  const list = currentList();
  openBulkDialog([...selected], actionFor(list), list, `${list === "followers" ? "Remove" : "Unfollow"} selected`);
});
el.aiScope.addEventListener("change", () => { el.btnAiRun.disabled = true; el.aiInfo.textContent = ""; });
el.btnAiEstimate.addEventListener("click", async () => {
  if (!owner) return;
  aiHandles = computeAiHandles();
  if (!aiHandles.length) { el.aiInfo.textContent = "Nothing to label in the current view."; return; }
  if (!settings?.apiKey) {
    el.aiInfo.innerHTML = `Add your Anthropic API key in <a href="#" id="optLink">Options</a> first.`;
    el.aiInfo.querySelector("#optLink")?.addEventListener("click", (e) => { e.preventDefault(); void sendToBackground({ type: "OPEN_OPTIONS" }); });
    return;
  }
  el.btnAiEstimate.disabled = true;
  el.aiInfo.textContent = "Estimating…";
  try {
    const est = await sendToBackground({ type: "AI_ESTIMATE", owner, list: currentList(), handles: aiHandles });
    el.aiInfo.textContent = `${fmt(est.accounts)} accounts · ${est.batches} request${est.batches === 1 ? "" : "s"} · ~${fmt(est.inputTokens)} in / ~${fmt(est.estOutputTokens)} out tokens · ≈ $${est.costUsd.toFixed(4)} on ${est.model}`;
    el.btnAiRun.disabled = false;
  } catch (e) {
    el.aiInfo.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    el.btnAiEstimate.disabled = false;
  }
});
el.btnAiRun.addEventListener("click", async () => {
  if (!owner || !aiHandles.length) return;
  el.btnAiRun.disabled = true;
  try {
    const r = await sendToBackground({ type: "AI_RUN", owner, list: currentList(), handles: aiHandles });
    if (!r.ok) el.aiInfo.textContent = r.error ?? "Could not start.";
  } catch (e) {
    el.aiInfo.textContent = e instanceof Error ? e.message : String(e);
  }
});
el.btnAiCancel.addEventListener("click", () => void sendToBackground({ type: "AI_CANCEL" }));

chrome.runtime.onMessage.addListener((msg: Broadcast) => {
  switch (msg.type) {
    case "SCAN_PROGRESS":
      if (state) state.scan = msg.progress;
      renderScan(msg.progress);
      if (!msg.progress.running) void loadSnapshots().then(recompute);
      else if (msg.progress.scanned % 200 < 40) void loadSnapshots().then(recompute);
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
      const me = msg.page?.loggedInHandle;
      if (me && me !== owner) void refreshState();
      break;
    }
    case "STATE_CHANGED":
      void refreshState();
      break;
  }
});

void refreshState();
