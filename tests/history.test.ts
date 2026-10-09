import { describe, expect, it } from "vitest";
import { applyScanDiff, diffHandles, nonMutuals, pushHistory } from "../src/shared/history";
import type { Account, ScanSnapshot } from "../src/shared/types";

const mk = (handle: string): Account => ({ handle, name: handle, bio: "", followsYou: false, verified: false, locked: false, firstSeen: 1, lastSeen: 1 });
const snap = (handles: string[]): ScanSnapshot => ({
  owner: "me", list: "followers", startedAt: 1, updatedAt: 1, complete: true,
  accounts: Object.fromEntries(handles.map((h) => [h, mk(h)])),
});

describe("diffHandles", () => {
  it("finds added and removed", () => {
    expect(diffHandles(["a", "b", "c"], ["b", "c", "d"])).toEqual({ added: ["d"], removed: ["a"] });
  });
});

describe("pushHistory", () => {
  it("keeps only the last N entries", () => {
    let h = [] as { at: number; handles: string[] }[];
    for (let i = 0; i < 25; i++) h = pushHistory(h, { at: i, handles: [] }, 20);
    expect(h).toHaveLength(20);
    expect(h[0]!.at).toBe(5);
  });
});

describe("applyScanDiff", () => {
  it("records departed accounts and new ones", () => {
    const before = snap(["a", "b", "c"]).accounts;
    const s = snap(["b", "c", "d"]);
    const r = applyScanDiff(s, [{ at: 10, handles: ["a", "b", "c"] }], ["b", "c", "d"], before, 100);
    expect(r.added).toEqual(["d"]);
    expect(r.removed).toEqual(["a"]);
    expect(s.departed?.a).toMatchObject({ handle: "a", departedAt: 100 });
    expect(s.lastDiff).toMatchObject({ at: 100, previousAt: 10, added: ["d"], removed: ["a"] });
    expect(r.history).toHaveLength(2);
    expect(r.history[1]).toEqual({ at: 100, handles: ["b", "c", "d"] });
  });
  it("does not count accounts we removed ourselves as having left", () => {
    const before = snap(["a", "b"]).accounts;
    const s = snap(["b"]);
    s.selfRemoved = { a: 50 };
    const r = applyScanDiff(s, [{ at: 10, handles: ["a", "b"] }], ["b"], before, 100);
    expect(r.removed).toEqual([]);
    expect(s.departed?.a).toBeUndefined();
    expect(s.selfRemoved).toEqual({});
  });
  it("uses the pre-scan account map when there is no history yet", () => {
    const before = snap(["a", "b"]).accounts;
    const s = snap(["b", "c"]);
    const r = applyScanDiff(s, [], ["b", "c"], before, 100);
    expect(r.added).toEqual(["c"]);
    expect(r.removed).toEqual(["a"]);
  });
  it("un-departs someone who came back", () => {
    const s = snap(["a"]);
    s.departed = { a: { ...mk("a"), departedAt: 5 } };
    applyScanDiff(s, [{ at: 10, handles: [] }], ["a"], {}, 100);
    expect(s.departed.a).toBeUndefined();
  });
});

describe("nonMutuals", () => {
  it("splits non-followers-back and fans", () => {
    const followers = snap(["a", "b"]).accounts;
    const following = snap(["b", "c"]).accounts;
    expect(nonMutuals(followers, following)).toEqual({ notFollowingBack: ["c"], fans: ["a"] });
    expect(nonMutuals(undefined, following)).toEqual({ notFollowingBack: [], fans: [] });
  });
});
