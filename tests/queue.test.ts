import { describe, expect, it } from "vitest";
import { HOUR_MS, addToQueue, cappedUntil, clearFinished, emptyQueue, finishItem, nextQueued, queueCounts, recoverRunning, removeQueued } from "../src/shared/queue";

const req = (handles: string[], preview = false) => ({ owner: "me", list: "followers" as const, action: "remove" as const, handles, preview });

describe("addToQueue", () => {
  it("adds, dedupes and skips protected/self", () => {
    const q = emptyQueue();
    const r = addToQueue(q, req(["@A", "b", "me", "friend", "a"]), { protectedHandles: ["@Friend"], self: "me", now: 1 });
    expect(r).toEqual({ added: 2, skipped: 2, duplicates: 1 });
    expect(q.items.map((i) => [i.handle, i.status])).toEqual([["a", "queued"], ["b", "queued"], ["me", "skipped"], ["friend", "skipped"]]);
    expect(q.items[3]!.reason).toBe("protected");
  });
  it("treats the same handle with a different action as distinct", () => {
    const q = emptyQueue();
    addToQueue(q, req(["a"]), { protectedHandles: [] });
    const r = addToQueue(q, { ...req(["a"]), action: "unfollow", list: "following" }, { protectedHandles: [] });
    expect(r.added).toBe(1);
  });
});

describe("removeQueued / nextQueued", () => {
  it("only removes items that are still queued", () => {
    const q = emptyQueue();
    addToQueue(q, req(["a", "b"]), { protectedHandles: [] });
    q.items[0]!.status = "running";
    expect(removeQueued(q, ["a", "b"])).toBe(1);
    expect(q.items.map((i) => i.handle)).toEqual(["a"]);
    expect(nextQueued(q)).toBeUndefined();
  });
});

describe("finishItem + cap", () => {
  it("records action times only for real completed actions", () => {
    const q = emptyQueue();
    addToQueue(q, req(["a", "b"]), { protectedHandles: [] });
    addToQueue(q, req(["c"], true), { protectedHandles: [] });
    finishItem(q, q.items[0]!, true, undefined, 1000);
    finishItem(q, q.items[1]!, false, "nope", 2000);
    finishItem(q, q.items[2]!, true, "preview", 3000);
    expect(q.actionTimes).toEqual([1000]);
    expect(queueCounts(q)).toMatchObject({ done: 2, failed: 1, preview: 1, queued: 0 });
  });
  it("caps using a sliding one-hour window", () => {
    const q = emptyQueue();
    q.actionTimes = [0, 1000, 2000];
    expect(cappedUntil(q, 3, 5000)).toBe(HOUR_MS);
    expect(cappedUntil(q, 4, 5000)).toBeNull();
    expect(cappedUntil(q, 2, HOUR_MS + 500)).toBe(1000 + HOUR_MS); // oldest pruned; 2 left >= cap of 2
    expect(cappedUntil(q, 3, 3 * HOUR_MS)).toBeNull();
  });
});

describe("recoverRunning / clearFinished", () => {
  it("requeues running items after a restart", () => {
    const q = emptyQueue();
    addToQueue(q, req(["a"]), { protectedHandles: [] });
    q.items[0]!.status = "running";
    q.status = "running";
    expect(recoverRunning(q)).toBe(true);
    expect(q.items[0]!.status).toBe("queued");
    expect(q.status).toBe("idle");
  });
  it("clears finished items but keeps the live ones", () => {
    const q = emptyQueue();
    addToQueue(q, req(["a", "b", "c"]), { protectedHandles: [] });
    finishItem(q, q.items[0]!, true, undefined);
    finishItem(q, q.items[1]!, false, "x");
    q.lastError = "boom";
    clearFinished(q);
    expect(q.items.map((i) => i.handle)).toEqual(["c"]);
    expect(q.lastError).toBeUndefined();
  });
});
