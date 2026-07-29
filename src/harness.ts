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
   *  "kimi-text": raw stdout minus kimi's bullet prefix and resume trailer.
   *  "text": reply is raw stdout; session continuity is the CLI's own (e.g. per-cwd). */
  output: "claude-json" | "kimi-text" | "text";
}

const BUILTINS: Record<string, Harness> = {
  claude: {
    first: ["claude", "-p", "{prompt}", "--output-format", "json", "--dangerously-skip-permissions"],
    next: ["claude", "-p", "{prompt}", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{session}"],
    output: "claude-json",
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
