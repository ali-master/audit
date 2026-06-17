/**
 * Diff-aware scanning. Computes the set of changed files for PR / incremental
 * runs so Recon can scope its task queue to "what this branch touched" instead
 * of re-scanning the whole repo on every run.
 *
 *   --base <ref>   PR mode: everything this branch introduced relative to the
 *                  merge-base with <ref>  (git `<ref>...HEAD`).
 *   --since <ref>  Incremental: every change between <ref> and HEAD
 *                  (git `<ref>..HEAD`).
 *
 * The result is fed to Recon as `changed_files`; the recon prompt expands from
 * those seeds to their immediate blast radius (callers / callees / importers).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

function git(
  repoPath: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", "-C", repoPath, ...args]);
  return {
    ok: p.exitCode === 0,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

/** True when `repoPath` is inside a git work tree. */
export function isGitRepo(repoPath: string): boolean {
  return git(repoPath, ["rev-parse", "--is-inside-work-tree"]).ok;
}

export interface DiffSpec {
  /** PR mode — diff against the merge-base with this ref (`<ref>...HEAD`). */
  base?: string | null;
  /** Incremental — diff this ref directly against HEAD (`<ref>..HEAD`). */
  since?: string | null;
}

export interface ChangedFilesResult {
  /** Repo-relative, posix-separated paths that still exist on disk. */
  files: string[];
  mode: "base" | "since";
  ref: string;
  /** The git revision range used (for logging). */
  range: string;
  /** Changed paths that no longer exist (deleted / renamed away). */
  dropped: number;
}

/**
 * Resolve the changed-file set for a diff spec. Throws on a missing git ref or
 * a failed `git diff` so the CLI can surface a clean error.
 */
export function changedFiles(
  repoPath: string,
  spec: DiffSpec,
): ChangedFilesResult {
  if (spec.base && spec.since)
    throw new Error("--base and --since are mutually exclusive");
  const ref = spec.base ?? spec.since;
  if (!ref) throw new Error("changedFiles requires --base or --since");
  const mode: "base" | "since" = spec.base ? "base" : "since";
  // Three-dot for PR mode (merge-base); two-dot for a plain range.
  const range = mode === "base" ? `${ref}...HEAD` : `${ref}..HEAD`;

  if (
    !git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok
  )
    throw new Error(
      `git ref ${JSON.stringify(ref)} does not resolve in ${repoPath}`,
    );

  // --diff-filter=d excludes deleted files (we cannot scan what is gone).
  const res = git(repoPath, ["diff", "--name-only", "--diff-filter=d", range]);
  if (!res.ok)
    throw new Error(`git diff failed for ${range}: ${res.stderr.trim()}`);

  const all = res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const files: string[] = [];
  let dropped = 0;
  for (const rel of all) {
    if (existsSync(join(repoPath, rel))) files.push(rel);
    else dropped++;
  }
  return { files, mode, ref, range, dropped };
}
