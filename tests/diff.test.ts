/** Diff-aware scanning tests against a throwaway git repo. */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { changedFiles, isGitRepo } from "../src/diff";

let dir: string;

function git(args: string[]): void {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
}

function write(rel: string, body: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-diff-"));
  git(["init", "-q", "-b", "main"]);
  write("a.ts", "export const a = 1;\n");
  write("b.ts", "export const b = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("diff", () => {
  test("isGitRepo true inside a repo, false outside", () => {
    expect(isGitRepo(dir)).toBe(true);
    const empty = mkdtempSync(join(tmpdir(), "audit-nogit-"));
    expect(isGitRepo(empty)).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });

  test("--since lists files changed between a ref and HEAD", () => {
    git(["branch", "before"]);
    write("a.ts", "export const a = 2;\n"); // modify
    write("c.ts", "export const c = 3;\n"); // add
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "work"]);

    const res = changedFiles(dir, { since: "before" });
    expect(res.mode).toBe("since");
    expect(new Set(res.files)).toEqual(new Set(["a.ts", "c.ts"]));
  });

  test("--base uses the merge-base (only this branch's changes)", () => {
    // Branch off, then advance main independently; --base main must NOT
    // report main-only changes — only what the feature branch introduced.
    git(["checkout", "-q", "-b", "feature"]);
    write("feature.ts", "export const f = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "feature work"]);

    git(["checkout", "-q", "main"]);
    write("main-only.ts", "export const m = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "main work"]);

    git(["checkout", "-q", "feature"]);
    const res = changedFiles(dir, { base: "main" });
    expect(res.files).toEqual(["feature.ts"]);
  });

  test("drops deleted files from the changed set", () => {
    git(["branch", "before"]);
    git(["rm", "-q", "b.ts"]);
    git(["commit", "-q", "-m", "remove b"]);
    const res = changedFiles(dir, { since: "before" });
    expect(res.files).not.toContain("b.ts");
  });

  test("rejects an unknown ref and conflicting flags", () => {
    expect(() => changedFiles(dir, { since: "no-such-ref" })).toThrow();
    expect(() => changedFiles(dir, { base: "main", since: "main" })).toThrow();
  });
});
