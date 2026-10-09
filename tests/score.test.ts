import { describe, expect, it } from "vitest";
import { botScore } from "../src/shared/score";

const mk = (o: Partial<{ handle: string; name: string; bio: string; avatarUrl?: string }>) => ({
  handle: "ada_lovelace", name: "Ada Lovelace", bio: "Mathematician. Writes about engines.", avatarUrl: "https://pbs.twimg.com/profile_images/1/x.jpg", ...o,
});

describe("botScore", () => {
  it("gives a real-looking account a low score", () => {
    const s = botScore(mk({}));
    expect(s.score).toBe(0);
    expect(s.reasons).toEqual([]);
  });
  it("flags no bio + default avatar + numeric handle", () => {
    const s = botScore(mk({ bio: "", avatarUrl: "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png", handle: "john8372916", name: "John" }));
    expect(s.score).toBeGreaterThanOrEqual(60);
    expect(s.reasons).toEqual(expect.arrayContaining(["no bio", "default avatar", "handle ends in a long number"]));
  });
  it("adds spam points when the spam label matched", () => {
    expect(botScore(mk({}), true).score).toBe(25);
  });
  it("flags emoji-only bios and symbol names", () => {
    const s = botScore(mk({ bio: "🔥🔥🔥 https://t.co/abc", name: "1234 ***" }));
    expect(s.reasons).toContain("bio is only emojis/links");
    expect(s.reasons).toContain("name is mostly digits/symbols");
  });
  it("caps at 100", () => {
    const s = botScore(mk({ bio: "", avatarUrl: "default_profile", handle: "x1234567", name: "x1234567" }), true);
    expect(s.score).toBeLessThanOrEqual(100);
  });
});
