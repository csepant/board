// Git worktree management: each spawned agent works on its own branch
// (board/<name>) in its own worktree under ~/.board/worktrees/<room>/<name>,
// so parallel agents can never clobber each other's edits. Merging back into
// the human's tree is an explicit /merge.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./store";

export interface GitResult {
  ok: boolean;
  out: string;
}

export function git(dir: string, ...args: string[]): GitResult {
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = (proc.stdout.toString() + proc.stderr.toString()).trim();
  return { ok: proc.exitCode === 0, out };
}

export function worktreePath(room: string, agent: string): string {
  return join(dataDir, "worktrees", room, agent);
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/** Create (or reuse) the agent's worktree. Throws with a human-readable reason. */
export function ensureWorktree(projectDir: string, room: string, agent: string): WorktreeInfo {
  if (!git(projectDir, "rev-parse", "--is-inside-work-tree").ok) {
    throw new Error(`${projectDir} is not a git repository — run \`git init && git add -A && git commit\` first`);
  }
  if (!git(projectDir, "rev-parse", "HEAD").ok) {
    throw new Error(`${projectDir} has no commits yet — make an initial commit first`);
  }

  const path = worktreePath(room, agent);
  const branch = `board/${agent}`;

  if (existsSync(path) && git(path, "rev-parse", "--is-inside-work-tree").ok) {
    return { path, branch }; // reuse existing worktree (agent restart)
  }

  git(projectDir, "worktree", "prune");
  const branchExists = git(projectDir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok;
  const add = branchExists
    ? git(projectDir, "worktree", "add", path, branch)
    : git(projectDir, "worktree", "add", path, "-b", branch);
  if (!add.ok) throw new Error(`could not create worktree: ${add.out}`);
  return { path, branch };
}

export interface AgentDiff {
  stat: string;
  diff: string;
  /** Uncommitted changes in the agent's worktree (not part of the diff). */
  dirty: string;
}

/** Diff the agent's branch (plus working tree) against its merge-base with the project's HEAD. */
export function diffWorktree(projectDir: string, room: string, agent: string): AgentDiff {
  const path = worktreePath(room, agent);
  if (!existsSync(path)) throw new Error(`no worktree for ${agent}`);
  const head = git(projectDir, "rev-parse", "HEAD");
  if (!head.ok) throw new Error(head.out);
  const base = git(path, "merge-base", "HEAD", head.out);
  if (!base.ok) throw new Error(base.out);
  return {
    stat: git(path, "diff", "--stat", base.out).out,
    diff: git(path, "diff", base.out).out,
    dirty: git(path, "status", "--short").out,
  };
}

/** Merge the agent's branch into the project's current branch. */
export function mergeAgentBranch(projectDir: string, agent: string): GitResult {
  return git(projectDir, "merge", "--no-edit", `board/${agent}`);
}
