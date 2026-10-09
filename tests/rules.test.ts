import { describe, expect, it } from "vitest";
import { compileKeyword, compileLabels, hashText, matchLabels, matchesQuery, normalize, normalizeHandle } from "../src/shared/rules";
import { DEFAULT_LABELS } from "../src/shared/defaults";

const acct = (bio: string, name = "Name", handle = "handle") => ({ bio, name, handle });

describe("normalize", () => {
  it("folds fancy unicode fonts and case", () => {
    expect(normalize("𝐒𝐨𝐟𝐭𝐰𝐚𝐫𝐞 𝐄𝐧𝐠𝐢𝐧𝐞𝐞𝐫")).toBe("software engineer");
    expect(normalize("  Crypto   TRADER ")).toBe("crypto trader");
  });
  it("strips combining accents", () => {
    expect(normalize("développeur")).toBe("developpeur");
  });
});

describe("compileKeyword", () => {
  it("matches whole words only", () => {
    const re = compileKeyword("dev");
    expect(re.test("indie dev here")).toBe(true);
    expect(re.test("developer")).toBe(false);
    expect(re.test("devops")).toBe(false);
    expect(re.test("web-dev")).toBe(true);
  });
  it("handles multi-word phrases with flexible separators", () => {
    const re = compileKeyword("machine learning");
    expect(re.test("i do machine-learning")).toBe(true);
    expect(re.test("machine   learning eng")).toBe(true);
    expect(re.test("machinelearning")).toBe(true);
  });
  it("handles terms with symbols like 18+ and c++", () => {
    expect(compileKeyword("18+").test("18+ only")).toBe(true);
    expect(compileKeyword("18+").test("I am 18")).toBe(false);
    expect(compileKeyword("c++").test("c++ programmer")).toBe(true);
    expect(compileKeyword("#buildinpublic").test("#buildinpublic daily")).toBe(true);
  });
  it("is emoji safe", () => {
    expect(compileKeyword("meme").test("🤡 meme lord 🤡")).toBe(true);
    expect(compileKeyword("ai").test("🤖ai🤖")).toBe(true);
  });
});

describe("matchLabels", () => {
  const compiled = compileLabels(DEFAULT_LABELS);
  it("labels a tech bio", () => {
    const hits = matchLabels(acct("Senior software engineer @ startup. Rust + TypeScript."), compiled);
    expect(hits.map((h) => h.labelId)).toContain("tech");
    expect(hits.find((h) => h.labelId === "tech")!.terms).toEqual(expect.arrayContaining(["engineer", "software", "typescript", "rust", "startup"]));
  });
  it("labels crypto and marketing bios", () => {
    expect(matchLabels(acct("Bitcoin maxi. DeFi degen."), compiled).map((h) => h.labelId)).toEqual(["crypto"]);
    expect(matchLabels(acct("Helping creators grow your audience. DM for coaching."), compiled).map((h) => h.labelId)).toEqual(["marketing"]);
  });
  it("uses the display name and handle too", () => {
    expect(matchLabels(acct("", "Meme Daily", "memes4u"), compiled).map((h) => h.labelId)).toContain("fun");
  });
  it("returns nothing for an unrelated bio", () => {
    expect(matchLabels(acct("Mum of two. Loves hiking and baking."), compiled)).toEqual([]);
  });
  it("does not false-positive on substrings", () => {
    // "ai" must not match inside "Spain", "aim"; "eth" must not match "Ethel".
    expect(matchLabels(acct("Living in Spain, aiming high. Ethel.", "", ""), compiled)).toEqual([]);
  });
});

describe("matchesQuery", () => {
  it("ANDs words across handle, name and bio", () => {
    const a = acct("Building things with rust", "Ada", "ada_dev");
    expect(matchesQuery(a, "rust ada")).toBe(true);
    expect(matchesQuery(a, "rust python")).toBe(false);
    expect(matchesQuery(a, "")).toBe(true);
  });
});

describe("helpers", () => {
  it("normalizes handles", () => {
    expect(normalizeHandle("@Some_User ")).toBe("some_user");
  });
  it("hashes deterministically", () => {
    expect(hashText("hello")).toBe(hashText("hello"));
    expect(hashText("hello")).not.toBe(hashText("hello!"));
    expect(hashText("")).toHaveLength(16);
  });
});
