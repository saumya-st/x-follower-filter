import { describe, expect, it } from "vitest";
import { buildSchema, buildSystemPrompt, buildUserMessage, costUsd, estimateOutputTokens, labelIds, requestParams } from "../src/background/claude";
import { DEFAULT_LABELS } from "../src/shared/defaults";

describe("claude request building", () => {
  it("includes every label id plus other/unknown", () => {
    const ids = labelIds(DEFAULT_LABELS, true);
    expect(ids).toEqual(expect.arrayContaining(["tech", "crypto", "other", "unknown"]));
    expect(labelIds(DEFAULT_LABELS, false)).not.toContain("other");
  });
  it("schema rejects labels outside the set and accepts valid output", () => {
    const schema = buildSchema(["tech", "other", "unknown"]);
    expect(schema.safeParse({ results: [{ handle: "a", label: "tech", confidence: 0.9 }] }).success).toBe(true);
    expect(schema.safeParse({ results: [{ handle: "a", label: "banana", confidence: 0.9 }] }).success).toBe(false);
    expect(schema.safeParse({ results: [{ handle: "a", label: "tech" }] }).success).toBe(false);
  });
  it("prompt mentions label hints and the user message carries handles", () => {
    const sys = buildSystemPrompt(DEFAULT_LABELS, true);
    expect(sys).toContain('"tech"');
    expect(sys).toContain("software, engineering");
    const user = buildUserMessage([{ handle: "ada", name: "Ada", bio: "math" }]);
    expect(user).toContain('"handle":"ada"');
  });
  it("only adds fallbacks for models that support it", () => {
    const accts = [{ handle: "a", name: "A", bio: "b" }];
    const opus = requestParams("claude-opus-5-5", DEFAULT_LABELS, accts, true).params as Record<string, unknown>;
    expect(opus.fallbacks).toBe("default");
    expect(opus.betas).toEqual(["server-side-fallback-2026-07-01"]);
    const haiku = requestParams("claude-haiku-5-5", DEFAULT_LABELS, accts, true).params as Record<string, unknown>;
    expect(haiku.fallbacks).toBeUndefined();
    expect(haiku.betas).toBeUndefined();
    expect((opus.output_config as { effort: string }).effort).toBe("low");
  });
  it("prices tokens per model", () => {
    expect(costUsd("claude-haiku-5-5", 1_000_000, 0)).toBeCloseTo(0.1);
    expect(costUsd("claude-opus-5-5", 1_000_000, 1_000_000)).toBeCloseTo(24);
    expect(estimateOutputTokens(10)).toBeGreaterThan(200);
  });
});
