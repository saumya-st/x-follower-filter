import { describe, expect, it } from "vitest";
import { mergeAccounts, removeAccounts, snapshotKey } from "../src/shared/storage";
import type { Account, ScanSnapshot } from "../src/shared/types";

const mk = (handle: string, bio = "", extra: Partial<Account> = {}): Account => ({
  handle, name: handle, bio, followsYou: false, verified: false, locked: false, firstSeen: 0, lastSeen: 0, ...extra,
});

const empty = (): ScanSnapshot => ({ owner: "me", list: "followers", startedAt: 1, updatedAt: 1, complete: false, accounts: {} });

describe("mergeAccounts", () => {
  it("adds new accounts and counts them", () => {
    const s = empty();
    expect(mergeAccounts(s, [mk("a"), mk("b")], 100)).toBe(2);
    expect(Object.keys(s.accounts)).toEqual(["a", "b"]);
    expect(s.accounts.a!.firstSeen).toBe(100);
    expect(s.updatedAt).toBe(100);
  });
  it("keeps firstSeen but refreshes bio and lastSeen on re-scan", () => {
    const s = empty();
    mergeAccounts(s, [mk("a", "old bio")], 100);
    expect(mergeAccounts(s, [mk("a", "new bio", { followsYou: true })], 200)).toBe(0);
    expect(s.accounts.a).toMatchObject({ bio: "new bio", followsYou: true, firstSeen: 100, lastSeen: 200 });
  });
  it("removes accounts", () => {
    const s = empty();
    mergeAccounts(s, [mk("a"), mk("b"), mk("c")]);
    removeAccounts(s, ["b", "zzz"]);
    expect(Object.keys(s.accounts)).toEqual(["a", "c"]);
  });
  it("keys snapshots case-insensitively by owner", () => {
    expect(snapshotKey("MyName", "following")).toBe("snapshot:myname:following");
  });
});
