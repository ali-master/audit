/** Auth setup tests — env scrubbing + auth-mode selection. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthError, configureAuth } from "../src/auth";

const AUTH_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
];

let snapshot: Record<string, string | undefined>;
let dir: string;
let emptyEnv: string;
let noCreds: string;

beforeEach(() => {
  snapshot = {};
  for (const v of AUTH_VARS) {
    snapshot[v] = process.env[v];
    delete process.env[v];
  }
  dir = mkdtempSync(join(tmpdir(), "audit-auth-"));
  emptyEnv = join(dir, ".env");
  writeFileSync(emptyEnv, "");
  noCreds = join(dir, "no_creds.json");
});

afterEach(() => {
  for (const v of AUTH_VARS) {
    if (snapshot[v] === undefined) delete process.env[v];
    else process.env[v] = snapshot[v];
  }
  rmSync(dir, { recursive: true, force: true });
});

const base = () => ({
  envFile: emptyEnv,
  credentialsPath: noCreds,
  platform: "linux" as const,
});

describe("configureAuth — absence", () => {
  test("missing everything raises", () => {
    expect(() => configureAuth(base())).toThrow(AuthError);
  });
});

describe("configureAuth — default (allowApiKey=false)", () => {
  test("scrubs API key when OAuth present; subscription wins", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-test-token";
    process.env.ANTHROPIC_API_KEY = "sk-should-be-deleted";
    const status = configureAuth(base());
    expect(status.authMode).toBe("oauth_token");
    expect(status.apiKeyScrubbed).toBe(true);
    expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
  });

  test("API key alone (no opt-in) is scrubbed and raises with hint", () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-be-deleted";
    expect(() => configureAuth(base())).toThrow(/--allow-api-key/);
    expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
  });

  test("oauth token alone selects oauth_token mode", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-test-token";
    const status = configureAuth(base());
    expect(status.authMode).toBe("oauth_token");
    expect(status.apiKeyScrubbed).toBe(false);
  });

  test("keychain credentials file selects keychain_login", () => {
    const creds = join(dir, "creds.json");
    writeFileSync(creds, "{}");
    const status = configureAuth({ ...base(), credentialsPath: creds });
    expect(status.authMode).toBe("keychain_login");
    expect(status.credentialsFile).toBe(creds);
  });

  test("macOS with no creds falls through to macos_keychain_login", () => {
    const status = configureAuth({ ...base(), platform: "darwin" });
    expect(status.authMode).toBe("macos_keychain_login");
    expect(status.credentialsFile).toBeNull();
  });
});

describe("configureAuth — opt-in api_key mode", () => {
  test("api_key mode keeps the key in env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-fake";
    const status = configureAuth({ ...base(), allowApiKey: true });
    expect(status.authMode).toBe("api_key");
    expect(status.apiKeyScrubbed).toBe(false);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-fake");
  });

  test("api_key outranks oauth when opted in", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-fake";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-oauth-token";
    const status = configureAuth({ ...base(), allowApiKey: true });
    expect(status.authMode).toBe("api_key");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-fake");
  });

  test("api_key mode scrubs a stale auth token", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-fake";
    process.env.ANTHROPIC_AUTH_TOKEN = "stale-token-must-go";
    const status = configureAuth({ ...base(), allowApiKey: true });
    expect(status.authMode).toBe("api_key");
    expect(status.authTokenScrubbed).toBe(true);
    expect("ANTHROPIC_AUTH_TOKEN" in process.env).toBe(false);
  });

  test("allowApiKey with no key falls back to oauth", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-test-token";
    const status = configureAuth({ ...base(), allowApiKey: true });
    expect(status.authMode).toBe("oauth_token");
  });
});

describe("configureAuth — gateway mode", () => {
  test("OpenRouter base URL + auth token selects gateway, keeps token", () => {
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    process.env.ANTHROPIC_AUTH_TOKEN = "or-sk-xxx";
    process.env.ANTHROPIC_API_KEY = "should-be-deleted";
    const status = configureAuth(base());
    expect(status.authMode).toBe("gateway");
    expect(status.gatewayBaseUrl).toBe("https://openrouter.ai/api");
    expect(status.apiKeyScrubbed).toBe(true);
    expect(status.authTokenScrubbed).toBe(false);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("or-sk-xxx");
    expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
  });

  test("gateway outranks api_key even when opted in", () => {
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    process.env.ANTHROPIC_AUTH_TOKEN = "or-sk-xxx";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-fake";
    const status = configureAuth({ ...base(), allowApiKey: true });
    expect(status.authMode).toBe("gateway");
    expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
  });

  test("base URL without token does not trigger gateway", () => {
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    expect(() => configureAuth(base())).toThrow(AuthError);
  });

  test("anthropic.com base URL is not gateway; auth token scrubbed", () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    process.env.ANTHROPIC_AUTH_TOKEN = "should-be-scrubbed";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token";
    const status = configureAuth(base());
    expect(status.authMode).toBe("oauth_token");
    expect(status.authTokenScrubbed).toBe(true);
    expect("ANTHROPIC_AUTH_TOKEN" in process.env).toBe(false);
  });
});
