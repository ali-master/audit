---
name: Bug report
about: Something in the audit pipeline didn't work as expected
title: "[bug] "
labels: bug
assignees: ''
---

**Describe the bug**
A clear and concise description of what went wrong.

**Which stage / command?**
- [ ] `auth-check`
- [ ] `run` (which stage: recon / hunt / validate / gapfill / dedupe / trace / feedback / report)
- [ ] `status`
- [ ] `report`
- [ ] library / programmatic use

**Command you ran**
```bash
bun run src/cli.ts run --repo ... --run-id ...
```

**What happened**
Paste the relevant log lines. If a stage failed schema validation, the
`results/<run-id>/<stage>/<id>.jsonl` artifact has the exact errors and the
agent's final output — please attach the relevant `schema_errors` /
`final_payload` lines (redact anything sensitive from the target repo).

**Expected behavior**
What you expected to happen instead.

**Environment**
- audit version: [e.g. 0.0.0 or commit hash]
- Bun version: [`bun --version`]
- OS: [e.g. macOS 15, Ubuntu 24.04]
- Auth mode reported by `audit auth-check`: [oauth_token / keychain_login / macos_keychain_login / gateway / api_key]
- `claude` CLI version (if installed): [`claude --version`]
- Model overrides / gateway in use? [e.g. default, OpenRouter, ANTHROPIC_MODEL=...]

**Target characteristics (no source needed)**
- Primary language(s): [e.g. Python, TypeScript, Go]
- Approx repo size / number of Hunt tasks Recon emitted:
- Live-target mode (`--target-url`) used? [yes/no]

**Additional context**
Anything else that helps reproduce — flags used (`--max-concurrency`,
`--max-recon-tasks`, `--scope-notes`), whether `--resume` was involved, etc.
