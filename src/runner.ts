/**
 * Run one agent: open a streaming `query()` session, send a JSON input,
 * parse + schema-validate the final JSON output, and persist a JSONL
 * artifact of every message exchanged.
 *
 * Multi-turn runs in a single streaming session, so a schema-validation failure
 * is followed by a repair turn inside the same session. The SDK does
 * multi-turn via streaming input: we feed an AsyncIterable of user messages
 * (PromptQueue) and only push a repair message when validation fails.
 *
 * API-error handling: the CLI surfaces 529 Overloaded and quota-exhausted
 * errors as a result message with is_error=true. We detect this BEFORE schema
 * validation, classify it, and either retry with exponential backoff
 * (transient) or raise QuotaExhaustedError (terminal).
 */

import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKUserMessage,
  SDKMessage,
  PermissionMode,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import { validateSchema, extractJson } from "./jsonUtils";
import { log } from "./logger";

type Json = any;

export interface AgentResult {
  payload: Json;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
  durationMs: number | null;
  sessionId: string | null;
  artifactPath: string;
  repairUsed: boolean;
  rawResultMessage: Json;
}

/** Schema validation failed after repair attempts. */
export class AgentRunError extends Error {}
/** Transient API error (529 Overloaded, generic 5xx) — retry with backoff. */
export class TransientAgentError extends Error {}
/** Subscription quota exhausted — don't retry; abort into a resumable state. */
export class QuotaExhaustedError extends Error {}

const QUOTA_MARKERS = [
  "out of extra usage",
  "usage limit reached",
  "session limit",
  "your plan has no remaining",
];

const TRANSIENT_MARKERS = [
  "api error: 529",
  "overloaded",
  "api error: 503",
  "api error: 502",
  "api error: 504",
  "api error: 500",
  "rate_limit",
  "temporarily unavailable",
  "service unavailable",
];

type ErrCtor = new (msg: string) => Error;

function classifyApiError(text: string): { label: string; ctor: ErrCtor } {
  const t = (text || "").toLowerCase();
  if (QUOTA_MARKERS.some((m) => t.includes(m)))
    return { label: "quota_exhausted", ctor: QuotaExhaustedError };
  if (TRANSIENT_MARKERS.some((m) => t.includes(m)))
    return { label: "transient", ctor: TransientAgentError };
  // Default to transient — better to retry once than abort on a miss.
  return { label: "unknown_api_error", ctor: TransientAgentError };
}

/**
 * Push-based AsyncIterable of user messages. The SDK pulls one message,
 * runs a turn to completion, then awaits the next. We push the initial prompt
 * up front, push a repair prompt only if needed, and close() to end the
 * session.
 */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string): void {
    this.buffer.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

export interface RunAgentParams {
  stage: string;
  promptFile: string;
  userInput: Json;
  schemaName: string;
  schemaText: string;
  allowedTools: string[];
  model: string;
  cwd: string;
  addDirs?: string[];
  maxTurns?: number;
  permissionMode?: PermissionMode;
  artifactDir: string;
  artifactName: string;
  repairAttempts?: number;
  transientRetries?: number;
  transientBaseDelay?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one agent, retrying transient API errors with exponential backoff.
 * Raises QuotaExhaustedError (caller should abort), TransientAgentError (all
 * retries exhausted), or AgentRunError (output never matched the schema).
 */
export async function runAgent(params: RunAgentParams): Promise<AgentResult> {
  const transientRetries = params.transientRetries ?? 3;
  const baseDelay = params.transientBaseDelay ?? 30_000;
  let lastExc: Error | null = null;

  for (let attempt = 0; attempt <= transientRetries; attempt++) {
    try {
      return await runAgentOnce(params);
    } catch (e) {
      if (e instanceof QuotaExhaustedError) throw e;
      if (e instanceof TransientAgentError) {
        lastExc = e;
        if (attempt >= transientRetries) break;
        const delay = Math.min(baseDelay * 2 ** attempt, 240_000);
        log.warn(
          `[${params.stage}/${params.artifactName}] transient API error ` +
            `(attempt ${attempt + 1}/${transientRetries + 1}): ${String(e.message).slice(0, 160)} ` +
            `— retrying in ${Math.round(delay / 1000)}s`,
        );
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastExc ?? new TransientAgentError("exhausted transient retries");
}

async function runAgentOnce(params: RunAgentParams): Promise<AgentResult> {
  const {
    stage,
    promptFile,
    userInput,
    schemaName,
    schemaText,
    allowedTools,
    model,
    cwd,
    addDirs = [],
    maxTurns = 25,
    permissionMode = "acceptEdits",
    artifactDir,
    artifactName,
    repairAttempts = 1,
  } = params;

  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const artifactPath = join(artifactDir, `${artifactName}.jsonl`);
  writeFileSync(artifactPath, "");

  const write = (obj: Json) =>
    appendFileSync(artifactPath, `${JSON.stringify(obj)}\n`);

  // Append the literal schema body so the model never has to guess field
  // names — drastically reduces first-attempt schema failures.
  const systemPromptBase = await Bun.file(promptFile).text();
  const systemPrompt =
    `${systemPromptBase}\n\n# Output schema\n\n` +
    `Your output MUST validate against this JSON Schema. ` +
    `Pay attention to nested objects, required fields, and ` +
    `\`additionalProperties: false\`.\n\n` +
    `\`\`\`json\n${schemaText}\n\`\`\`\n`;

  const abort = new AbortController();
  const options: Options = {
    systemPrompt,
    allowedTools,
    model,
    maxTurns,
    cwd,
    additionalDirectories: addDirs,
    permissionMode,
    settingSources: [],
    abortController: abort,
    stderr: () => {
      /* swallow CLI stderr noise */
    },
  };

  const initialPrompt = JSON.stringify(userInput);

  write({ kind: "meta", stage, model, started_at: Date.now() / 1000 });
  write({ kind: "user", text: initialPrompt.slice(0, 50_000) });

  const promptQueue = new PromptQueue();
  promptQueue.push(initialPrompt);

  let lastText = "";
  let lastResult: Json = {};
  let repairUsed = false;

  try {
    const stream = query({
      prompt: promptQueue,
      options,
    }) as AsyncGenerator<SDKMessage>;

    const drained = await drainTurn(stream, write);
    lastText = drained.text;
    lastResult = drained.result;

    // Before schema validation: was this a real model response, or did the
    // CLI surface an API error as the result?
    if (lastResult.is_error) {
      const errText = errorText(lastResult, lastText);
      const { label, ctor } = classifyApiError(errText);
      write({
        kind: "api_error",
        classification: label,
        text: errText.slice(0, 1000),
      });
      // eslint-disable-next-line new-cap
      throw new ctor(
        `[${stage}/${artifactName}] ${label}: ${errText.trim().slice(0, 300)}`,
      );
    }

    let attempts = 0;
    let errors = validate(lastText, schemaName);
    while (errors.length > 0 && attempts < repairAttempts) {
      attempts++;
      repairUsed = true;
      const repairPrompt = buildRepairPrompt(errors, schemaName);
      write({ kind: "repair_request", text: repairPrompt.slice(0, 50_000) });
      promptQueue.push(repairPrompt);
      const r = await drainTurn(stream, write);
      lastText = r.text;
      lastResult = r.result;
      if (lastResult.is_error) {
        const errText = errorText(lastResult, lastText);
        const { label, ctor } = classifyApiError(errText);
        write({
          kind: "api_error_on_repair",
          classification: label,
          text: errText.slice(0, 1000),
        });
        // eslint-disable-next-line new-cap
        throw new ctor(
          `[${stage}/${artifactName}] ${label} on repair turn: ${errText.trim().slice(0, 300)}`,
        );
      }
      errors = validate(lastText, schemaName);
    }

    if (errors.length > 0) {
      write({ kind: "schema_errors", errors });
      throw new AgentRunError(
        `[${stage}/${artifactName}] schema validation failed after ${repairAttempts} ` +
          `repair attempts: ${JSON.stringify(errors.slice(0, 5))}`,
      );
    }

    const payload = extractJson(lastText);
    write({ kind: "final_payload", payload });

    const usage = lastResult.usage ?? {};
    return {
      payload,
      costUsd: lastResult.total_cost_usd ?? null,
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      cacheReadTokens: usage.cache_read_input_tokens ?? null,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? null,
      numTurns: lastResult.num_turns ?? null,
      durationMs: lastResult.duration_ms ?? null,
      sessionId: lastResult.session_id ?? null,
      artifactPath,
      repairUsed,
      rawResultMessage: lastResult,
    };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).toLowerCase();
    if (
      !(e instanceof AgentRunError) &&
      !(e instanceof TransientAgentError) &&
      !(e instanceof QuotaExhaustedError) &&
      (msg.includes("timeout") || msg.includes("initialize"))
    ) {
      throw new TransientAgentError(
        `[${stage}/${artifactName}] SDK init/timeout: ${e}`,
      );
    }
    throw e;
  } finally {
    promptQueue.close();
    abort.abort();
  }
}

interface TurnResult {
  text: string;
  result: Json;
}

/**
 * Consume the response stream until a 'result' message, writing each message
 * to the JSONL artifact and returning the last assistant text + result dict.
 */
async function drainTurn(
  stream: AsyncGenerator<SDKMessage>,
  write: (obj: Json) => void,
): Promise<TurnResult> {
  let lastAssistantText = "";
  let result: Json = {};

  for (;;) {
    const { value: msg, done } = await stream.next();
    if (done || !msg) break;
    write(serializeMessage(msg));
    if (msg.type === "assistant") {
      const blocks = (msg.message?.content ?? []) as Json[];
      lastAssistantText = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text as string)
        .join("");
    } else if (msg.type === "result") {
      result = resultToDict(msg);
      break;
    }
  }

  const text =
    lastAssistantText ||
    (typeof result.result === "string" ? result.result : "");
  return { text, result };
}

function validate(text: string, schemaName: string): string[] {
  let payload: unknown;
  try {
    payload = extractJson(text);
  } catch (e) {
    return [`json_extract: ${(e as Error).message}`];
  }
  return validateSchema(payload, schemaName);
}

function buildRepairPrompt(errors: string[], schemaName: string): string {
  const errBlock = errors
    .slice(0, 20)
    .map((e) => `- ${e}`)
    .join("\n");
  return (
    `Your previous output failed schema validation against \`${schemaName}\`. Errors:\n` +
    `${errBlock}\n\n` +
    "Re-emit the same response, fixing ONLY these errors. Output a single JSON " +
    "object — no prose, no markdown fence."
  );
}

function errorText(result: Json, fallback: string): string {
  if (Array.isArray(result.errors) && result.errors.length > 0)
    return result.errors.join("; ");
  if (typeof result.result === "string" && result.result) return result.result;
  return fallback;
}

function resultToDict(msg: Json): Json {
  return {
    subtype: msg.subtype,
    is_error: msg.is_error,
    duration_ms: msg.duration_ms,
    duration_api_ms: msg.duration_api_ms,
    num_turns: msg.num_turns,
    session_id: msg.session_id,
    stop_reason: msg.stop_reason,
    total_cost_usd: msg.total_cost_usd,
    usage: msg.usage,
    result: msg.result,
    errors: msg.errors,
    model_usage: msg.modelUsage,
  };
}

function serializeMessage(msg: Json): Json {
  if (msg.type === "assistant") {
    return {
      kind: "assistant",
      model: msg.message?.model,
      usage: msg.message?.usage,
      error: msg.error,
      content: (msg.message?.content ?? []).map(serializeBlock),
    };
  }
  if (msg.type === "result") {
    return { kind: "result", ...resultToDict(msg) };
  }
  return { kind: msg.type, ...msg };
}

function serializeBlock(b: Json): Json {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      return { type: "thinking", thinking: b.thinking };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: b.content,
        is_error: b.is_error,
      };
    default:
      return { type: b.type, ...b };
  }
}
