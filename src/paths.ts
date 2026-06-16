/**
 * Filesystem anchors for the harness. Resolved from this module's location
 * (via import.meta.url) rather than process.cwd(), so the CLI works no
 * matter which directory it is invoked from — including when it has been
 * `cd`'d into a target repo.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This module lives at <root>/src/paths.ts (and, when bundled, at <root>/dist/),
// so the package root — where the shipped, read-only assets live — is one level
// up from here. Resolving via import.meta.url (not cwd) keeps these assets
// findable no matter where `audit` is invoked from, including a global install.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT: string = join(MODULE_DIR, "..");

// Shipped, read-only assets: resolved relative to the install location.
export const PROMPTS: string = join(REPO_ROOT, "prompts");
export const SCHEMAS: string = join(REPO_ROOT, "schemas");
export const CONFIG_DIR: string = join(REPO_ROOT, "config");

// Runtime writes (scan state + artifacts): anchored to the directory the tool is
// run from — the repo being audited — NOT the install location. A global install
// lives in a shared/read-only package dir, so writing there would mix every
// project's state into one place. Override with AUDIT_DATA_DIR when needed.
// resolve() keeps absolute AUDIT_DATA_DIR values as-is and resolves relative
// ones against cwd; with no override it falls back to cwd itself.
const DATA_DIR = process.env.AUDIT_DATA_DIR?.trim()
  ? resolve(process.env.AUDIT_DATA_DIR.trim())
  : process.cwd();
export const RESULTS: string = join(DATA_DIR, "results");
export const WORK: string = join(DATA_DIR, "work");
export const DB_PATH: string = join(DATA_DIR, "state.db");
