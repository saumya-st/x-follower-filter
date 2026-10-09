import type { Account } from "./types";

export interface BotScore {
  score: number;
  reasons: string[];
}

const URL_RE = /https?:\/\/\S+|\b[\w-]+\.(com|net|org|io|co|xyz|gg|me|ly|app|tv)\b\S*/gi;
const EMOJI_OR_SYMBOL_RE = /[\p{Extended_Pictographic}\p{S}\p{P}\s️‍]/gu;

/**
 * Heuristic 0..100 "looks automated / low-effort" score from fields we can read off the follower list.
 * `spamHit` is whether the user's Adult/Spam keyword label matched.
 */
export function botScore(a: Pick<Account, "handle" | "name" | "bio" | "avatarUrl">, spamHit = false): BotScore {
  const reasons: string[] = [];
  let score = 0;
  const bio = a.bio.trim();
  const name = a.name.trim();
  const handle = a.handle;

  if (!bio) { score += 25; reasons.push("no bio"); }
  if ((a.avatarUrl ?? "").includes("default_profile")) { score += 25; reasons.push("default avatar"); }

  if (/\d{5,}$/.test(handle)) { score += 15; reasons.push("handle ends in a long number"); }
  else if (name && /\d{3,}$/.test(handle) && handle.replace(/\d+$/, "") === name.toLowerCase().replace(/[^a-z0-9_]/g, "")) {
    score += 15; reasons.push("handle is name + digits");
  }

  if (name) {
    const letters = (name.match(/\p{L}/gu) ?? []).length;
    if (letters / name.length < 0.5) { score += 10; reasons.push("name is mostly digits/symbols"); }
    else if (name.toLowerCase() === handle) { score += 10; reasons.push("name equals handle"); }
  }

  if (spamHit) { score += 25; reasons.push("spam/adult keywords"); }

  if (bio) {
    const stripped = bio.replace(URL_RE, "").replace(EMOJI_OR_SYMBOL_RE, "");
    if (!stripped) { score += 10; reasons.push("bio is only emojis/links"); }
  }

  return { score: Math.min(100, score), reasons };
}
