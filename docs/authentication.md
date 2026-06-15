# Authentication

`audit` is billed to your **Claude subscription** by default — no metered API
key required. Auth is handled by [`src/auth.ts`](../src/auth.ts), which picks a
mode and scrubs conflicting environment variables so the SDK lands on the auth
path you actually intend.

Verify any time with:

```bash
bun run src/cli.ts auth-check
```

## Modes (in priority order)

| Mode | Triggered by | Notes |
|------|--------------|-------|
| `gateway` | `ANTHROPIC_BASE_URL` (non-anthropic.com) **and** `ANTHROPIC_AUTH_TOKEN` | OpenRouter / custom proxy. `ANTHROPIC_API_KEY` is scrubbed |
| `api_key` | `ANTHROPIC_API_KEY` **and** `--allow-api-key` (or `AUDIT_ALLOW_API_KEY=1`) | Metered Anthropic billing. A stale `ANTHROPIC_AUTH_TOKEN` is scrubbed |
| `oauth_token` | `CLAUDE_CODE_OAUTH_TOKEN` | Headless subscription token — best for CI |
| `keychain_login` | `~/.claude/.credentials.json` exists | From `claude login` |
| `macos_keychain_login` | macOS with no other auth | Uses the active Keychain-backed first-party login |

If none apply, `auth-check` / `run` exit with a clear error listing the options.

## Why scrubbing matters

Claude Code's precedence puts `ANTHROPIC_AUTH_TOKEN` (rung 2) and
`ANTHROPIC_API_KEY` (rung 3) **above** subscription OAuth (rungs 5–6). If you
have an API key exported for another tool, it would silently route `audit` to
metered billing. So by default the API key is removed from the environment and
subscription auth wins. Opt back in explicitly with `--allow-api-key`.

`auth-check` prints exactly what was scrubbed.

## Recipes

### Subscription (local dev)

```bash
claude login           # once
bun run src/cli.ts auth-check   # → "using macOS Keychain-backed Claude Code login" (or keychain_login)
```

### Subscription (CI / headless)

```bash
claude setup-token
echo "CLAUDE_CODE_OAUTH_TOKEN=<paste>" > .env
bun run src/cli.ts auth-check   # → "using CLAUDE_CODE_OAUTH_TOKEN"
```

### OpenRouter (or any Anthropic-compatible gateway)

```bash
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
export ANTHROPIC_API_KEY=""           # must be empty / unset
export ANTHROPIC_MODEL="anthropic/claude-sonnet-4-6"   # optional, forces all stages

bun run src/cli.ts auth-check         # → "using LLM gateway at https://openrouter.ai/api"
```

Per-stage model names in `config/stages.yaml` can be slash-prefixed
(`anthropic/claude-opus-4-7`) for gateways. Note: non-Claude models may produce
schema-compliant JSON less reliably; the repair turn still applies.

### Metered Anthropic API key

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
bun run src/cli.ts run --repo ./target --allow-api-key
```

### Cloud providers (Bedrock / Vertex / Foundry)

The Claude Agent SDK has first-class env flags (`CLAUDE_CODE_USE_BEDROCK=1`,
etc.) that outrank everything else. See the
[Claude Code auth docs](https://code.claude.com/docs/en/authentication).
