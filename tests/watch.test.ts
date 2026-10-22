import { describe, expect, it } from "vitest";
import { badgeText, clampIntervalHours, emptyWatch, markSeen, notificationText, recordCheck, recordFailure, MAX_UNSEEN } from "../src/shared/watch";

const H = 3600_000;

describe("recordCheck", () => {
  it("accumulates unseen departures newest first and schedules the next run", () => {
    const w0 = { ...emptyWatch(), owner: "me", unseenLeft: ["old"], unseenNew: 1, lastError: "boom" };
    const w1 = recordCheck(w0, { added: ["x", "y"], removed: ["a", "b"] }, 1000, 12);
    expect(w1.unseenLeft).toEqual(["a", "b", "old"]);
    expect(w1.unseenNew).toBe(3);
    expect(w1.lastRunAt).toBe(1000);
    expect(w1.nextRunAt).toBe(1000 + 12 * H);
    expect(w1.running).toBe(false);
  });
  it("does not duplicate a handle already unseen and caps the list", () => {
    const many = Array.from({ length: MAX_UNSEEN + 10 }, (_, i) => `h${i}`);
    const w = recordCheck({ ...emptyWatch(), unseenLeft: ["h0"] }, { added: [], removed: many }, 1, 6);
    expect(w.unseenLeft).toHaveLength(MAX_UNSEEN);
    expect(w.unseenLeft.filter((h) => h === "h0")).toHaveLength(1);
  });
  it("moves a handle that left again to the front", () => {
    const w = recordCheck({ ...emptyWatch(), unseenLeft: ["a", "b"] }, { added: [], removed: ["b"] }, 1, 6);
    expect(w.unseenLeft).toEqual(["b", "a"]);
  });
});

describe("recordFailure / markSeen", () => {
  it("keeps unseen counts on failure and clears them when seen", () => {
    const w = recordFailure({ ...emptyWatch(), unseenLeft: ["a"], unseenNew: 2, running: true }, "not logged in", 50, 3);
    expect(w).toMatchObject({ running: false, lastError: "not logged in", lastRunAt: 50, nextRunAt: 50 + 3 * H, unseenLeft: ["a"], unseenNew: 2 });
    expect(markSeen(w)).toMatchObject({ unseenLeft: [], unseenNew: 0, lastError: "not logged in" });
  });
});

describe("badgeText", () => {
  it("formats counts", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(7)).toBe("7");
    expect(badgeText(150)).toBe("99+");
  });
});

describe("clampIntervalHours", () => {
  it("snaps to the nearest allowed value", () => {
    expect(clampIntervalHours(12, [3, 6, 12, 24])).toBe(12);
    expect(clampIntervalHours(10, [3, 6, 12, 24])).toBe(12);
    expect(clampIntervalHours(0, [3, 6, 12, 24])).toBe(3);
  });
});

describe("notificationText", () => {
  const acc = { a: { handle: "a", name: "Ava" }, b: { handle: "b", name: "  " }, c: { handle: "c", name: "Cy" }, d: { handle: "d", name: "Dee" } };
  it("names up to three people, falling back to the handle", () => {
    expect(notificationText(["a"], acc)).toEqual({ title: "1 person unfollowed you", message: "Ava" });
    expect(notificationText(["a", "b"], acc)).toEqual({ title: "2 people unfollowed you", message: "Ava and @b" });
    expect(notificationText(["a", "b", "c", "d"], acc)).toEqual({ title: "4 people unfollowed you", message: "Ava, @b, Cy and 1 more" });
  });
  it("mentions new followers when there are any", () => {
    expect(notificationText(["a"], acc, 3).message).toBe("Ava. 3 new followers.");
  });
});
