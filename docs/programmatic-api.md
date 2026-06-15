# Programmatic API

The CLI is the primary interface, but the pieces are exported from
[`src/index.ts`](../src/index.ts) for use from your own TypeScript (under Bun).

```ts
import {
  configureAuth,
  loadConfig,
  StateDB,
  runPipeline,
  runAgent,
  StageContext,
  extractJson,
  validateSchema,
} from "@usex/audit"; // or relative: "./src/index"
```

## Run the whole pipeline

```ts
import { configureAuth, loadConfig, StateDB, runPipeline, paths } from "@usex/audit";

configureAuth(); // throws AuthError if no usable auth

const db = new StateDB(paths.DB_PATH);
try {
  const reportPath = await runPipeline({
    repoPath: "/path/to/target",
    runId: "my-run",
    db,
    config: loadConfig(),
    maxCostUsd: 30,
    maxReconTasks: 15,
    // resume: true,
    // liveTarget: { url: "http://server.local:8888", credentials: { email, password } },
    // scopeNotes: "…verbatim text…",
  });
  console.log("report at", reportPath);
} finally {
  db.close();
}
```

`runPipeline` returns the path to `report.json` and throws `CostExceeded` /
`QuotaExhaustedError` for the abort cases (both resumable).

## Run a single agent

`runAgent` is the low-level wrapper (one streaming session + schema validation +
repair turn + retry/backoff):

```ts
import { runAgent } from "@usex/audit";

const result = await runAgent({
  stage: "recon",
  promptFile: "prompts/01-recon.md",
  userInput: { repo_path: "/path/to/target", max_tasks: 10 },
  schemaName: "recon_output.schema.json",
  schemaText: await Bun.file("schemas/recon_output.schema.json").text(),
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  model: "claude-opus-4-7",
  cwd: "/path/to/target",
  addDirs: ["/path/to/target"],
  artifactDir: "results/manual/recon",
  artifactName: "recon",
});

console.log(result.payload, result.costUsd, result.numTurns);
```

Throws:
- `AgentRunError` — output never matched the schema after repair attempts.
- `TransientAgentError` — transient API error after all backoff retries.
- `QuotaExhaustedError` — subscription quota exhausted (abort + resume later).

## Utilities

```ts
extractJson(text);                          // tolerant JSON extraction (bare/fenced/embedded)
validateSchema(payload, "finding.schema.json"); // → string[] of errors ([] = valid)
```

## Query run state

```ts
import { StateDB, paths } from "@usex/audit";

const db = new StateDB(paths.DB_PATH);
const findings = db.getReachableCanonicalFindings("my-run");
const cost = db.totalCost("my-run");
db.close();
```

See [State & artifacts](state-and-artifacts.md) for the full `StateDB` surface.

> This is a Bun package — it depends on `bun:sqlite` and other Bun-native APIs,
> so run it with Bun, not Node.
