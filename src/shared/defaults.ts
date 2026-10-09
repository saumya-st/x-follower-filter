import type { Label, ModelPrice, Preset, Settings } from "./types";

export const DEFAULT_LABELS: Label[] = [
  {
    id: "tech",
    name: "Tech",
    color: "#3b82f6",
    keywords: [
      "developer", "dev", "engineer", "engineering", "software", "programmer", "coding", "code",
      "javascript", "typescript", "python", "rust", "golang", "react", "node", "frontend",
      "backend", "fullstack", "full-stack", "devops", "cloud", "aws", "open source", "oss",
      "github", "cto", "ai", "ml", "machine learning", "data scientist", "llm", "startup",
      "founder", "saas", "indie hacker", "building", "shipping",
    ],
    hint: "software, engineering, AI/ML, startups, builders",
  },
  {
    id: "crypto",
    name: "Crypto / Web3",
    color: "#f59e0b",
    keywords: [
      "crypto", "bitcoin", "btc", "ethereum", "eth", "web3", "nft", "defi", "solana", "sol",
      "blockchain", "airdrop", "token", "memecoin", "altcoin", "hodl", "degen", "dao", "wagmi",
      "trader", "forex", "signals",
    ],
    hint: "cryptocurrency, trading, NFTs, blockchain",
  },
  {
    id: "marketing",
    name: "Marketing / Growth",
    color: "#ec4899",
    keywords: [
      "marketing", "marketer", "growth", "seo", "ghostwriter", "copywriter", "copywriting",
      "personal brand", "branding", "agency", "lead gen", "funnel", "dm me", "dm for",
      "link in bio", "coach", "coaching", "mentor", "course", "masterclass", "10x", "6 figures",
      "7 figures", "passive income", "monetize", "grow your", "follow back", "f4f", "followback",
      "promo", "promotion", "shoutout",
    ],
    hint: "growth hacking, coaching, selling courses, follow-for-follow, promotion",
  },
  {
    id: "fun",
    name: "Fun / Memes",
    color: "#22c55e",
    keywords: [
      "meme", "memes", "shitpost", "shitposter", "comedy", "comedian", "funny", "humor", "humour",
      "jokes", "lol", "parody", "satire", "gamer", "gaming", "twitch", "streamer", "anime",
      "manga", "football", "soccer", "nba", "nfl", "cricket", "f1", "fan account", "stan",
    ],
    hint: "memes, comedy, gaming, sports fans, entertainment",
  },
  {
    id: "news",
    name: "News / Politics",
    color: "#8b5cf6",
    keywords: [
      "news", "journalist", "reporter", "editor", "correspondent", "breaking", "politics",
      "political", "policy", "activist", "campaign", "maga", "liberal", "conservative",
      "democrat", "republican", "election", "government", "minister", "parliament", "senator",
    ],
    hint: "journalism, news, politics, activism",
  },
  {
    id: "adult",
    name: "Adult / Spam",
    color: "#ef4444",
    keywords: [
      "onlyfans", "of link", "18+", "nsfw", "adult content", "spicy", "sugar daddy", "sugar baby",
      "escort", "cam", "snap me", "telegram me", "whatsapp me", "investment opportunity",
      "guaranteed profit", "recovery expert", "hacked account recovery", "binary options",
      "giveaway", "free money", "casino", "betting tips",
    ],
    hint: "adult content, scams, spam, suspicious contact requests",
  },
];

/** Label id whose keyword hits feed the bot score. */
export const SPAM_LABEL_ID = "adult";

export const PRESETS: Preset[] = [
  { id: "bots", name: "Likely bots", list: "both", flags: { likelyBot: true }, hint: "No bio, default avatar, numeric handles, spam keywords" },
  { id: "spam", name: "Spam & adult", list: "both", labels: ["adult"], hint: "Matches your Adult / Spam keywords" },
  { id: "crypto", name: "Crypto", list: "both", labels: ["crypto"], hint: "Crypto, NFT, forex, signals" },
  { id: "promo", name: "Promo / growth", list: "both", labels: ["marketing"], hint: "Coaches, follow-for-follow, lead gen" },
  { id: "nobio", name: "No bio", list: "both", flags: { noBio: true }, hint: "Empty bio" },
  { id: "nonmutual", name: "Not following back", list: "following", flags: { notFollowingBack: true }, hint: "You follow them, they don't follow you" },
];

export const MODELS: ModelPrice[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5 (default)", inputPerM: 4, outputPerM: 20, supportsFallback: true },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", inputPerM: 2, outputPerM: 10, supportsFallback: true },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5 (cheapest)", inputPerM: 0.1, outputPerM: 0.5, supportsFallback: false },
];

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "claude-opus-5-5",
  aiScope: "unlabeled",
  minDelayMs: 4000,
  maxDelayMs: 9000,
  maxPerHour: 60,
  protectedHandles: [],
  labels: DEFAULT_LABELS,
  aiAllowOther: true,
  botThreshold: 60,
  keepWorkerTab: false,
};

export const AI_BATCH_SIZE = 40;
export const ANTHROPIC_ORIGIN = "https://api.anthropic.com/*";
/** Seconds the per-row Remove button waits (with Undo) before queueing. */
export const UNDO_SECONDS = 5;
/** Idle minutes before the hidden worker tab is closed (unless keepWorkerTab). */
export const WORKER_IDLE_CLOSE_MIN = 2;
