// Harness registry: how to drive each agent CLI headlessly, one turn at a time.
//
// A harness entry is two argv templates — `first` for the opening turn and
// `next` for turns that resume a session — plus how to parse the output.
// Placeholders: {prompt} (the turn's prompt), {session} (the stored session id,
// `next` only). Built-ins can be overridden or extended in
// ~/.board/harnesses.json (same shape, merged over the defaults).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./store";

export interface Harness {
  first: string[];
  next: string[];
  /** "claude-json": parse stdout as claude --output-format json ({result, session_id}).
   *  "claude-stream-json": NDJSON from claude --output-format stream-json --verbose;
   *    tool_use events stream live, the final {type:"result"} line carries {result, session_id}.
   *  "kimi-text": raw stdout minus kimi's bullet prefix and resume trailer.
   *  "text": reply is raw stdout; session continuity is the CLI's own (e.g. per-cwd). */
  output: "claude-json" | "claude-stream-json" | "kimi-text" | "text";
}

const BUILTINS: Record<string, Harness> = {
  claude: {
    first: ["claude", "-p", "{prompt}", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
    next: ["claude", "-p", "{prompt}", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--resume", "{session}"],
    output: "claude-stream-json",
  },
  kimi: {
    // kimi's prompt mode rejects --auto/--yolo; it is non-interactive on its own.
    // -c continues the previous session for the working directory (= this worktree).
    first: ["kimi", "-p", "{prompt}"],
    next: ["kimi", "-p", "{prompt}", "-c"],
    output: "kimi-text",
  },
  // Placeholder — flags unverified (hermes isn't installed here). Override in
  // ~/.board/harnesses.json if yours differ.
  hermes: {
    first: ["hermes", "-p", "{prompt}"],
    next: ["hermes", "-p", "{prompt}", "--continue"],
    output: "text",
  },
};

export function loadHarnesses(): Record<string, Harness> {
  const userFile = join(dataDir, "harnesses.json");
  if (!existsSync(userFile)) return { ...BUILTINS };
  try {
    return { ...BUILTINS, ...JSON.parse(readFileSync(userFile, "utf8")) };
  } catch (e) {
    console.error(`ignoring invalid ${userFile}: ${e}`);
    return { ...BUILTINS };
  }
}

export function buildArgv(harness: Harness, prompt: string, session: string | null): string[] {
  const template = session ? harness.next : harness.first;
  return template.map((part) =>
    part.replace("{prompt}", prompt).replace("{session}", session ?? ""),
  );
}

/** Returns [replyText, sessionId|null]. */
export function parseOutput(harness: Harness, stdout: string): [string, string | null] {
  if (harness.output === "claude-stream-json") {
    // The reply is the last NDJSON event: {type:"result", result, session_id}.
    for (const line of stdout.trim().split("\n").reverse()) {
      try {
        const event = JSON.parse(line);
        if (event.type === "result") {
          return [String(event.result ?? "").trim(), event.session_id ?? null];
        }
      } catch {
        // interleaved non-JSON noise; keep scanning
      }
    }
    return [stdout.trim(), null];
  }
  if (harness.output === "claude-json") {
    try {
      const parsed = JSON.parse(stdout);
      return [String(parsed.result ?? "").trim(), parsed.session_id ?? null];
    } catch {
      return [stdout.trim(), null]; // fall back to raw text
    }
  }
  if (harness.output === "kimi-text") {
    const cleaned = stdout
      .split("\n")
      .filter((line) => !/^To resume this session:/.test(line.trim()))
      .join("\n")
      .trim()
      .replace(/^•\s*/, "");
    return [cleaned, null];
  }
  return [stdout.trim(), null];
}

// --- live activity ---------------------------------------------------------

export interface Activity {
  tool: string;
  detail: string;
}

const ACTIVITY_DETAIL_MAX = 80;

/** One human-readable line for a tool_use input: its primary argument, flattened. */
function summarizeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const o = input as Record<string, unknown>;
  const primary =
    o.command ?? o.file_path ?? o.pattern ?? o.query ?? o.url ?? o.prompt ?? o.description;
  const text = typeof primary === "string" ? primary : JSON.stringify(o);
  return text.replace(/\s+/g, " ").trim().slice(0, ACTIVITY_DETAIL_MAX);
}

/**
 * Activities in one stdout line, emitted while a turn is still running.
 * Purely informational: the final reply always comes from parseOutput on the
 * full buffer, so a missed or garbled line here can't break a turn.
 */
export function activitiesFromLine(harness: Harness, line: string): Activity[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (harness.output === "claude-stream-json") {
    try {
      const event = JSON.parse(trimmed);
      if (event.type !== "assistant") return []; // ignore init/result/rate_limit/etc.
      const blocks: any[] = event.message?.content ?? [];
      return blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ tool: String(b.name ?? "tool"), detail: summarizeInput(b.input) }));
    } catch {
      return [];
    }
  }

  if (harness.output === "kimi-text") {
    // Progress and the final reply share stdout; bullets are progress. The
    // resume trailer marks the tail — parseOutput handles the real reply.
    if (/^To resume this session:/.test(trimmed)) return [];
    if (!trimmed.startsWith("•")) return [];
    return [{ tool: "kimi", detail: trimmed.replace(/^•\s*/, "").slice(0, ACTIVITY_DETAIL_MAX) }];
  }

  return [];
}
