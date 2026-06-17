#!/usr/bin/env bun
/**
 * Build standalone, single-file executables with `bun build --compile`, for
 * Homebrew (and direct download). Embeds the runtime assets first so the binary
 * needs no sibling files.
 *
 *   bun run build:binary            # current platform → dist-bin/<target>/audit
 *   bun run build:binary all        # every release target
 *   bun run build:binary darwin-arm64 linux-x64
 *
 * Each target produces dist-bin/<target>/audit, a release tarball
 * audit-<target>.tar.gz (containing a single `audit`), and its .sha256.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUTDIR = join(ROOT, "dist-bin");

// Bun cross-compile targets we publish. (Windows omitted — Homebrew is mac/linux.)
const ALL = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

function currentTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

async function run(cmd: string[]): Promise<void> {
  const p = Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`);
}

const args = process.argv.slice(2);
const targets = args.length
  ? args.includes("all")
    ? ALL
    : args
  : [currentTarget()];

// Always refresh the embedded asset snapshot so the binary is self-contained.
await run(["bun", "run", "scripts/embed-assets.ts"]);
rmSync(OUTDIR, { recursive: true, force: true });
mkdirSync(OUTDIR, { recursive: true });

for (const target of targets) {
  const stage = join(OUTDIR, target);
  mkdirSync(stage, { recursive: true });
  const bin = join(stage, "audit");

  console.log(`\n▸ compiling ${target}`);
  await run([
    "bun",
    "build",
    "--compile",
    "--minify",
    "--sourcemap=none",
    `--target=bun-${target}`,
    join(ROOT, "src", "cli.ts"),
    "--outfile",
    bin,
  ]);

  const tarball = `audit-${target}.tar.gz`;
  await run(["tar", "-czf", join(OUTDIR, tarball), "-C", stage, "audit"]);

  const bytes = new Uint8Array(await Bun.file(join(OUTDIR, tarball)).arrayBuffer());
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  writeFileSync(join(OUTDIR, `${tarball}.sha256`), `${sha}  ${tarball}\n`);
  console.log(`  → ${tarball}  sha256=${sha}`);
}

console.log(`\nbuilt ${targets.length} target(s) in dist-bin/`);
