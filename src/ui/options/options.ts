import { ANTHROPIC_ORIGIN, DEFAULT_LABELS, MODELS, WATCH_INTERVALS_H } from "../../shared/defaults";
import { sendToBackground } from "../../shared/messages";
import { normalizeHandle } from "../../shared/rules";
import { clearAllData } from "../../shared/storage";
import { clampIntervalHours } from "../../shared/watch";
import type { Label, Settings } from "../../shared/types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  status: $("status"), labels: $("labels"), addLabel: $<HTMLButtonElement>("addLabel"), resetLabels: $<HTMLButtonElement>("resetLabels"),
  apiKey: $<HTMLInputElement>("apiKey"), model: $<HTMLSelectElement>("model"), aiAllowOther: $<HTMLInputElement>("aiAllowOther"),
  grantPerm: $<HTMLButtonElement>("grantPerm"), permStatus: $("permStatus"), pricing: $("pricing"),
  minDelay: $<HTMLInputElement>("minDelay"), maxDelay: $<HTMLInputElement>("maxDelay"), maxPerHour: $<HTMLInputElement>("maxPerHour"),
  botThreshold: $<HTMLInputElement>("botThreshold"), botThresholdVal: $("botThresholdVal"), keepWorkerTab: $<HTMLInputElement>("keepWorkerTab"),
  watchEnabled: $<HTMLInputElement>("watchEnabled"), watchInterval: $<HTMLSelectElement>("watchInterval"), watchNotify: $<HTMLInputElement>("watchNotify"),
  protected: $<HTMLTextAreaElement>("protected"), clearData: $<HTMLButtonElement>("clearData"), save: $<HTMLButtonElement>("save"),
};

let settings: Settings;
let labels: Label[] = [];

function slug(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "label";
  let id = base, i = 2;
  while (taken.has(id)) id = `${base}-${i++}`;
  return id;
}

function renderLabels() {
  el.labels.innerHTML = "";
  labels.forEach((l, idx) => {
    const row = document.createElement("div");
    row.className = "label-row";
    row.style.marginBottom = "12px";
    row.innerHTML = `
      <input type="color" value="${l.color}" title="Colour" />
      <input type="text" value="${escapeHtml(l.name)}" placeholder="Label name" />
      <input type="text" value="${escapeHtml(l.hint ?? "")}" placeholder="Hint for the AI (optional)" />
      <button class="sm danger">Remove</button>
      <textarea class="kw" placeholder="keyword, another keyword, multi word phrase">${escapeHtml(l.keywords.join(", "))}</textarea>`;
    const [color, name, hint] = Array.from(row.querySelectorAll("input")) as HTMLInputElement[];
    const kw = row.querySelector("textarea")!;
    color!.addEventListener("input", () => (l.color = color!.value));
    name!.addEventListener("input", () => (l.name = name!.value));
    hint!.addEventListener("input", () => (l.hint = hint!.value || undefined));
    kw.addEventListener("input", () => (l.keywords = splitList(kw.value)));
    row.querySelector("button")!.addEventListener("click", () => { labels.splice(idx, 1); renderLabels(); });
    el.labels.appendChild(row);
  });
}

function splitList(s: string): string[] {
  return Array.from(new Set(s.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)));
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function renderPricing() {
  const m = MODELS.find((x) => x.id === el.model.value);
  if (!m) { el.pricing.textContent = ""; return; }
  const per1k = ((1000 * 140 * m.inputPerM) + (1000 * 22 * m.outputPerM)) / 1_000_000;
  el.pricing.textContent = `${m.name}: $${m.inputPerM}/M input, $${m.outputPerM}/M output tokens. Labelling 1,000 accounts costs roughly $${per1k.toFixed(2)}.${m.supportsFallback ? "" : " No server-side refusal fallback on this model."}`;
}

function syncWatchInputs() {
  el.watchInterval.disabled = el.watchNotify.disabled = !el.watchEnabled.checked;
}

async function refreshPerm() {
  const has = await chrome.permissions.contains({ origins: [ANTHROPIC_ORIGIN] });
  el.permStatus.textContent = has ? "Granted." : "Not granted (needed for AI labelling).";
  el.grantPerm.hidden = has;
}

function flash(text: string, ok = true) {
  el.status.textContent = text;
  el.status.style.color = ok ? "var(--ok)" : "var(--danger)";
  setTimeout(() => (el.status.textContent = ""), 3000);
}

async function load() {
  settings = await sendToBackground({ type: "GET_SETTINGS" });
  labels = structuredClone(settings.labels);
  renderLabels();
  el.model.innerHTML = MODELS.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  if (!MODELS.some((m) => m.id === settings.model)) el.model.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(settings.model)}">${escapeHtml(settings.model)}</option>`);
  el.model.value = settings.model;
  el.apiKey.value = settings.apiKey;
  el.aiAllowOther.checked = settings.aiAllowOther;
  el.minDelay.value = String(Math.round(settings.minDelayMs / 1000));
  el.maxDelay.value = String(Math.round(settings.maxDelayMs / 1000));
  el.maxPerHour.value = String(settings.maxPerHour);
  el.botThreshold.value = String(settings.botThreshold);
  el.botThresholdVal.textContent = String(settings.botThreshold);
  el.keepWorkerTab.checked = settings.keepWorkerTab;
  el.watchInterval.innerHTML = WATCH_INTERVALS_H.map((h) => `<option value="${h}">${h < 24 ? `Every ${h} hours` : h === 24 ? "Once a day" : `Every ${h / 24} days`}</option>`).join("");
  el.watchEnabled.checked = settings.watchEnabled;
  el.watchInterval.value = String(clampIntervalHours(settings.watchIntervalHours, WATCH_INTERVALS_H));
  el.watchNotify.checked = settings.watchNotify;
  syncWatchInputs();
  el.protected.value = settings.protectedHandles.map((h) => `@${h}`).join("\n");
  renderPricing();
  await refreshPerm();
}

async function save() {
  const taken = new Set<string>();
  const cleaned: Label[] = [];
  for (const l of labels) {
    const name = l.name.trim();
    if (!name) continue;
    const keepId = /^[a-z0-9-]+$/.test(l.id) && !taken.has(l.id);
    const id = keepId ? l.id : slug(name, taken);
    taken.add(id);
    cleaned.push({ ...l, id, name, keywords: l.keywords.map((k) => k.trim()).filter(Boolean) });
  }
  const min = Math.max(2, Number(el.minDelay.value) || 4);
  const max = Math.max(min, Number(el.maxDelay.value) || 9);
  const next: Settings = {
    ...settings,
    labels: cleaned,
    apiKey: el.apiKey.value.trim(),
    model: el.model.value,
    aiAllowOther: el.aiAllowOther.checked,
    minDelayMs: min * 1000,
    maxDelayMs: max * 1000,
    maxPerHour: Math.max(1, Math.min(500, Number(el.maxPerHour.value) || 60)),
    botThreshold: Math.max(30, Math.min(90, Number(el.botThreshold.value) || 60)),
    keepWorkerTab: el.keepWorkerTab.checked,
    watchEnabled: el.watchEnabled.checked,
    watchIntervalHours: clampIntervalHours(Number(el.watchInterval.value), WATCH_INTERVALS_H),
    watchNotify: el.watchNotify.checked,
    protectedHandles: splitList(el.protected.value).map(normalizeHandle).filter(Boolean),
  };
  await sendToBackground({ type: "SAVE_SETTINGS", settings: next });
  settings = next;
  labels = structuredClone(next.labels);
  renderLabels();
  el.minDelay.value = String(min);
  el.maxDelay.value = String(max);
  flash("Saved.");
}

el.addLabel.addEventListener("click", () => {
  labels.push({ id: slug("new-label", new Set(labels.map((l) => l.id))), name: "", color: "#64748b", keywords: [] });
  renderLabels();
  (el.labels.lastElementChild?.querySelectorAll("input")[1] as HTMLInputElement | undefined)?.focus();
});
el.resetLabels.addEventListener("click", () => {
  if (!confirm("Replace your labels with the default set?")) return;
  labels = structuredClone(DEFAULT_LABELS);
  renderLabels();
});
el.model.addEventListener("change", renderPricing);
el.watchEnabled.addEventListener("change", syncWatchInputs);
el.botThreshold.addEventListener("input", () => (el.botThresholdVal.textContent = el.botThreshold.value));
el.grantPerm.addEventListener("click", async () => {
  const ok = await chrome.permissions.request({ origins: [ANTHROPIC_ORIGIN] });
  await refreshPerm();
  flash(ok ? "Permission granted." : "Permission declined.", ok);
});
el.clearData.addEventListener("click", async () => {
  if (!confirm("Delete every scanned list, scan history, the action queue and all AI labels stored by this extension? Settings are kept.")) return;
  await clearAllData();
  flash("Data deleted.");
});
el.save.addEventListener("click", () => void save());

void load();
