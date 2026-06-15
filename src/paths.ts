/**
 * Filesystem anchors for the harness. Resolved from this module's location
 * (via import.meta.url) rather than process.cwd(), so the CLI works no
 * matter which directory it is invoked from — including when it has been
 * `cd`'d into a target repo.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <root>/src/paths.ts, so the project root is one level up.
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(SRC_DIR, "..");

export const PROMPTS = join(REPO_ROOT, "prompts");
export const SCHEMAS = join(REPO_ROOT, "schemas");
export const CONFIG_DIR = join(REPO_ROOT, "config");
export const RESULTS = join(REPO_ROOT, "results");
export const WORK = join(REPO_ROOT, "work");
export const DB_PATH = join(REPO_ROOT, "state.db");
