import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODELS } from "../shared/defaults";
import type { Account, Label } from "../shared/types";

export const OTHER_LABEL = "other";
export const UNKNOWN_LABEL = "unknown";

export function makeClient(apiKey: string): Anthropic {
  // The key lives in chrome.storage.local and only ever travels to api.anthropic.com from the
  // extension's own service worker, so direct browser access is the intended deployment here.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
}

export function modelInfo(model: string) {
  return MODELS.find((m) => m.id === model) ?? { id: model, name: model, inputPerM: 4, outputPerM: 20, supportsFallback: false };
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const m = modelInfo(model);
  return (inputTokens * m.inputPerM + outputTokens * m.outputPerM) / 1_000_000;
}

export function labelIds(labels: Label[], allowOther: boolean): string[] {
  const ids = labels.map((l) => l.id);
  if (allowOther) ids.push(OTHER_LABEL);
  ids.push(UNKNOWN_LABEL);
  return Array.from(new Set(ids));
}

export function buildSchema(ids: string[]) {
  const labelEnum = z.enum(ids as [string, ...string[]]);
  return z.object({
    results: z.array(
      z.object({
        handle: z.string(),
        label: labelEnum,
        confidence: z.number(),
      }),
    ),
  });
}
export type ClassifyOutput = z.infer<ReturnType<typeof buildSchema>>;

export function buildSystemPrompt(labels: Label[], allowOther: boolean): string {
  const lines = labels.map((l) => `- "${l.id}" (${l.name})${l.hint ? `: ${l.hint}` : ""}${l.keywords.length ? ` — e.g. ${l.keywords.slice(0, 8).join(", ")}` : ""}`);
  return [
    "You categorise X (Twitter) accounts for a user who is tidying their follower and following lists.",
    "For each account you receive a handle, display name and bio. Pick exactly one label per account from this set:",
    ...lines,
    allowOther ? `- "${OTHER_LABEL}": a real, identifiable account that fits none of the labels above` : "",
    `- "${UNKNOWN_LABEL}": the bio is empty or too vague to tell`,
    "",
    "Judge by the bio first, then the display name, then the handle. Non-English bios are fine; read them in their language.",
    "confidence is a number from 0 to 1. Return one result for every handle you were given, in the same order, and never invent handles.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildUserMessage(accounts: Pick<Account, "handle" | "name" | "bio">[]): string {
  const payload = accounts.map((a) => ({ handle: a.handle, name: a.name, bio: a.bio }));
  return `Label these ${payload.length} accounts:\n\n${JSON.stringify(payload, null, 0)}`;
}

export interface BatchResult {
  results: ClassifyOutput["results"];
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export function requestParams(model: string, labels: Label[], accounts: Pick<Account, "handle" | "name" | "bio">[], allowOther: boolean) {
  const ids = labelIds(labels, allowOther);
  const schema = buildSchema(ids);
  const info = modelInfo(model);
  return {
    schema,
    params: {
      model,
      max_tokens: 4000,
      system: buildSystemPrompt(labels, allowOther),
      messages: [{ role: "user" as const, content: buildUserMessage(accounts) }],
      output_config: { effort: "low" as const, format: zodOutputFormat(schema) },
      ...(info.supportsFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    },
  };
}

export async function classifyBatch(
  client: Anthropic,
  model: string,
  labels: Label[],
  accounts: Pick<Account, "handle" | "name" | "bio">[],
  allowOther: boolean,
): Promise<BatchResult> {
  const { params } = requestParams(model, labels, accounts, allowOther);
  const response = await client.beta.messages.parse(params);
  if (response.stop_reason === "refusal") {
    const why = response.stop_details?.explanation ?? response.stop_details?.category ?? "no reason given";
    throw new Error(`Claude declined this batch (${why}).`);
  }
  if (response.stop_reason === "max_tokens") throw new Error("Claude's reply was cut off; try a smaller batch.");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Claude returned output that did not match the expected schema.");
  return {
    results: parsed.results,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: response.model,
  };
}

export async function countBatchTokens(
  client: Anthropic,
  model: string,
  labels: Label[],
  accounts: Pick<Account, "handle" | "name" | "bio">[],
  allowOther: boolean,
): Promise<number> {
  const { params } = requestParams(model, labels, accounts, allowOther);
  const r = await client.beta.messages.countTokens({ model: params.model, system: params.system, messages: params.messages });
  return r.input_tokens;
}

/** Rough output size: ~22 tokens per result row. */
export function estimateOutputTokens(accounts: number): number {
  return 30 + accounts * 22;
}

export function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Invalid Anthropic API key. Check it in Options.";
  if (e instanceof Anthropic.PermissionDeniedError) return "Your API key does not have access to this model.";
  if (e instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit. Wait a minute and try again.";
  if (e instanceof Anthropic.BadRequestError) return `Anthropic rejected the request: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Could not reach api.anthropic.com. Check your connection and that the extension has permission for api.anthropic.com (Options).";
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ""}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
