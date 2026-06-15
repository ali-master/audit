/**
 * Auth setup for the Claude Agent SDK.
 *
 * Claude Code's authentication-precedence list
 * (https://code.claude.com/docs/en/authentication#authentication-precedence):
 *   1. Cloud provider creds (Bedrock / Vertex / Foundry)
 *   2. ANTHROPIC_AUTH_TOKEN (Bearer-token mode — LLM gateways)
 *   3. ANTHROPIC_API_KEY (metered Anthropic API)
 *   4. apiKeyHelper
 *   5. CLAUDE_CODE_OAUTH_TOKEN (long-lived subscription token)
 *   6. Subscription OAuth credentials from `claude login`
 *
 * This module supports five modes, picked in order: gateway, api_key
 * (opt-in), oauth_token, keychain_login, macos_keychain_login. Anything else
 * raises AuthError. The point is to scrub conflicting env vars so the SDK's
 * bundled CLI lands on the auth mode the operator actually intends.
 *
 * The Claude Agent SDK ships its own CLI binary, so a
 * missing `claude` on PATH is informational here, not fatal.
 */

import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthMode =
  | "gateway"
  | "api_key"
  | "oauth_token"
  | "keychain_login"
  | "macos_keychain_login";

export interface AuthStatus {
  authMode: AuthMode;
  apiKeyScrubbed: boolean;
  authTokenScrubbed: boolean;
  claudeCliPath: string | null;
  claudeCliVersion: string | null;
  credentialsFile: string | null;
  gatewayBaseUrl: string | null;
  gatewayModel: string | null;
}

export class AuthError extends Error {}

export const DEFAULT_CREDENTIALS_PATH = join(
  homedir(),
  ".claude",
  ".credentials.json",
);

export interface ConfigureAuthOptions {
  envFile?: string;
  allowApiKey?: boolean;
  /** Override for tests; defaults to ~/.claude/.credentials.json. */
  credentialsPath?: string;
  /** Override for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/** A non-empty BASE_URL that doesn't point at canonical Anthropic is a gateway. */
function isGatewayBase(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (!u) return false;
  return !u.includes("anthropic.com");
}

/**
 * Load .env, decide auth mode, scrub conflicting env vars accordingly.
 * Returns an AuthStatus describing what was picked; throws AuthError if no
 * usable auth path is available.
 */
export function configureAuth(opts: ConfigureAuthOptions = {}): AuthStatus {
  const { allowApiKey = false } = opts;
  const credentialsPath = opts.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
  const platform = opts.platform ?? process.platform;

  if (opts.envFile) {
    if (existsSync(opts.envFile))
      loadDotenv({ path: opts.envFile, quiet: true });
  } else {
    loadDotenv({ quiet: true });
  }

  const cliPath = Bun.which("claude");

  const apiKeyWasSet = "ANTHROPIC_API_KEY" in process.env;
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "";
  const authToken = (process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
  const gateway = isGatewayBase(baseUrl) && Boolean(authToken);

  let apiKeyScrubbed = false;
  let authTokenScrubbed = false;
  let credsFile: string | null = null;
  let mode: AuthMode;

  if (gateway) {
    // Gateway path: keep BASE_URL + AUTH_TOKEN, but drop ANTHROPIC_API_KEY
    // (rung 3 would outrank the gateway token).
    if (apiKeyWasSet) {
      delete process.env.ANTHROPIC_API_KEY;
      apiKeyScrubbed = true;
    }
    mode = "gateway";
  } else if (allowApiKey && apiKeyWasSet) {
    // Explicit API-key path (metered billing). Leave the key; scrub a stale
    // ANTHROPIC_AUTH_TOKEN so it can't outrank the key (rung 2 > rung 3).
    if ("ANTHROPIC_AUTH_TOKEN" in process.env) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      authTokenScrubbed = true;
    }
    mode = "api_key";
  } else {
    // Subscription paths: scrub both API-key vars so subscription OAuth wins.
    if (apiKeyWasSet) {
      delete process.env.ANTHROPIC_API_KEY;
      apiKeyScrubbed = true;
    }
    if ("ANTHROPIC_AUTH_TOKEN" in process.env) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      authTokenScrubbed = true;
    }

    const token = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
    credsFile = existsSync(credentialsPath) ? credentialsPath : null;
    if (token) {
      mode = "oauth_token";
    } else if (credsFile !== null) {
      mode = "keychain_login";
    } else if (platform === "darwin") {
      // Claude Code stores interactive /login credentials in the macOS
      // Keychain, not in ~/.claude/.credentials.json. Let the SDK use the
      // active Keychain-backed first-party login.
      mode = "macos_keychain_login";
    } else {
      const hint = apiKeyWasSet
        ? "\n\nNote: ANTHROPIC_API_KEY was set but ignored. To use metered API " +
          "billing, re-run with --allow-api-key (or set AUDIT_ALLOW_API_KEY=1)."
        : "";
      throw new AuthError(
        `No auth available. Pick one of:\n` +
          `  (a) Subscription OAuth (interactive): run \`claude login\`.\n` +
          `  (b) Subscription OAuth (headless): run \`claude setup-token\` and ` +
          `paste into .env as CLAUDE_CODE_OAUTH_TOKEN.\n` +
          `  (c) LLM gateway (OpenRouter / proxy): set ANTHROPIC_BASE_URL + ` +
          `ANTHROPIC_AUTH_TOKEN.\n` +
          `  (d) Direct Anthropic API key (metered): set ANTHROPIC_API_KEY and ` +
          `pass --allow-api-key.${hint}`,
      );
    }
  }

  let cliVersion: string | null = null;
  if (cliPath) {
    try {
      const out = Bun.spawnSync([cliPath, "--version"]);
      if (out.exitCode === 0) cliVersion = out.stdout.toString().trim();
    } catch {
      /* informational only */
    }
  }

  return {
    authMode: mode,
    apiKeyScrubbed,
    authTokenScrubbed,
    claudeCliPath: cliPath,
    claudeCliVersion: cliVersion,
    credentialsFile: credsFile,
    gatewayBaseUrl: mode === "gateway" ? baseUrl : null,
    gatewayModel:
      mode === "gateway" ? (process.env.ANTHROPIC_MODEL ?? null) : null,
  };
}
