/**
 * SQLite-backed run state. JSONL artifacts in results/ are the source of
 * truth for raw agent output; this DB is the queryable index used for
 * orchestration, resume, and reporting. Backed by
 * Bun's built-in `bun:sqlite` (no external driver needed).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// One statement per array entry so we can apply them with db.run() (which
// prepares a single statement at a time).
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    started_at REAL NOT NULL,
    finished_at REAL,
    status TEXT NOT NULL DEFAULT 'running'
  )`,
  `CREATE TABLE IF NOT EXISTS recon_outputs (
    run_id TEXT PRIMARY KEY,
    raw_json TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    source TEXT NOT NULL,
    attack_class TEXT NOT NULL,
    scope_hint TEXT NOT NULL,
    target_files TEXT NOT NULL,
    rationale TEXT,
    priority INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'pending',
    raw_json TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS findings (
    finding_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    file TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    vuln_class TEXT NOT NULL,
    severity TEXT NOT NULL,
    description TEXT NOT NULL,
    evidence TEXT NOT NULL,
    poc_succeeded INTEGER DEFAULT 0,
    confidence REAL,
    raw_json TEXT NOT NULL,
    validation_status TEXT,
    validation_json TEXT,
    group_id TEXT,
    is_canonical INTEGER DEFAULT 0,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS traces (
    finding_id TEXT PRIMARY KEY,
    reachable INTEGER NOT NULL,
    confidence REAL,
    rationale TEXT,
    raw_json TEXT NOT NULL,
    FOREIGN KEY (finding_id) REFERENCES findings(finding_id)
  )`,
  `CREATE TABLE IF NOT EXISTS dedupe_groups (
    group_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    canonical_finding_id TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS costs (
    cost_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    ref_id TEXT,
    usd REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER,
    num_turns INTEGER,
    duration_ms INTEGER,
    created_at REAL NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    ref_id TEXT,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at REAL NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_validation ON findings(validation_status)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_group ON findings(group_id)`,
  `CREATE INDEX IF NOT EXISTS idx_costs_run_stage ON costs(run_id, stage)`,
];

type Json = any;

export interface RunRow {
  run_id: string;
  repo_path: string;
  started_at: number;
  finished_at: number | null;
  status: string;
}

export interface Task {
  taskId: string;
  runId: string;
  source: string;
  attackClass: string;
  scopeHint: string;
  targetFiles: string[];
  rationale: string;
  priority: number;
  status: string;
  rawJson: Json;
}

export interface Finding {
  findingId: string;
  taskId: string;
  runId: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  vulnClass: string;
  severity: string;
  description: string;
  evidence: string;
  pocSucceeded: boolean;
  confidence: number | null;
  rawJson: Json;
  validationStatus: string | null;
  validationJson: Json | null;
  groupId: string | null;
  isCanonical: boolean;
}

export interface ResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ResultMessageLike {
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: ResultUsage;
}

/** Seconds-since-epoch float, Unix epoch seconds. */
function now(): number {
  return Date.now() / 1000;
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export class StateDB {
  private readonly db: Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL");
    for (const stmt of SCHEMA_STATEMENTS) this.db.run(stmt);
  }

  /** Escape hatch for the few orchestration queries that need raw SQL. */
  get raw(): Database {
    return this.db;
  }

  // ---------- runs ----------

  createRun(repoPath: string, runId?: string): string {
    const id = runId ?? `run_${shortId()}`;
    this.db.run(
      "INSERT INTO runs (run_id, repo_path, started_at, status) VALUES (?, ?, ?, ?)",
      [id, repoPath, now(), "running"],
    );
    return id;
  }

  finishRun(runId: string, status = "completed"): void {
    this.db.run(
      "UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ?",
      [status, now(), runId],
    );
  }

  getRun(runId: string): RunRow | null {
    return (
      (this.db
        .query("SELECT * FROM runs WHERE run_id = ?")
        .get(runId) as RunRow) ?? null
    );
  }

  listRuns(): RunRow[] {
    return this.db
      .query("SELECT * FROM runs ORDER BY started_at DESC")
      .all() as RunRow[];
  }

  /** Mark a resumed run back to 'running' and clear its finish time. */
  reopenRun(runId: string): void {
    this.db.run(
      "UPDATE runs SET status = 'running', finished_at = NULL WHERE run_id = ?",
      [runId],
    );
  }

  // ---------- recon ----------

  saveReconOutput(runId: string, payload: Json): void {
    this.db.run(
      "INSERT OR REPLACE INTO recon_outputs (run_id, raw_json) VALUES (?, ?)",
      [runId, JSON.stringify(payload)],
    );
  }

  getReconOutput(runId: string): Json | null {
    const row = this.db
      .query("SELECT raw_json FROM recon_outputs WHERE run_id = ?")
      .get(runId) as { raw_json: string } | undefined;
    return row ? JSON.parse(row.raw_json) : null;
  }

  // ---------- tasks ----------

  addTask(runId: string, task: Json): void {
    const t = now();
    this.db.run(
      `INSERT OR IGNORE INTO tasks
        (task_id, run_id, source, attack_class, scope_hint, target_files,
         rationale, priority, status, raw_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        task.task_id,
        runId,
        task.source ?? "recon",
        task.attack_class,
        task.scope_hint,
        JSON.stringify(task.target_files),
        task.rationale ?? "",
        Number(task.priority ?? 3),
        JSON.stringify(task),
        t,
        t,
      ],
    );
  }

  getPendingTasks(runId: string): Task[] {
    const rows = this.db
      .query(
        "SELECT * FROM tasks WHERE run_id = ? AND status = 'pending' ORDER BY priority, created_at",
      )
      .all(runId) as Json[];
    return rows.map(rowToTask);
  }

  getAllTasks(runId: string): Task[] {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at")
      .all(runId) as Json[];
    return rows.map(rowToTask);
  }

  updateTaskStatus(taskId: string, status: string): void {
    this.db.run(
      "UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?",
      [status, now(), taskId],
    );
  }

  /**
   * Flip 'running' and 'failed' tasks back to 'pending' so a resumed run
   * re-attempts interrupted/failed work. Returns the number of tasks reset.
   */
  resetIncompleteTasks(runId: string): number {
    const res = this.db.run(
      "UPDATE tasks SET status = 'pending', updated_at = ? WHERE run_id = ? AND status IN ('running', 'failed')",
      [now(), runId],
    );
    return res.changes;
  }

  // ---------- findings ----------

  addFinding(runId: string, taskId: string, finding: Json): void {
    const poc = finding.poc ?? {};
    this.db.run(
      `INSERT OR IGNORE INTO findings
        (finding_id, task_id, run_id, file, line_start, line_end,
         vuln_class, severity, description, evidence, poc_succeeded,
         confidence, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finding.finding_id,
        taskId,
        runId,
        finding.file,
        finding.line_start,
        finding.line_end,
        finding.vuln_class,
        finding.severity,
        finding.description,
        finding.evidence_snippet,
        poc.succeeded ? 1 : 0,
        finding.confidence ?? null,
        JSON.stringify(finding),
      ],
    );
  }

  getFindings(
    runId: string,
    opts: { validationStatus?: string; canonicalOnly?: boolean } = {},
  ): Finding[] {
    let sql = "SELECT * FROM findings WHERE run_id = ?";
    const args: Json[] = [runId];
    if (opts.validationStatus !== undefined) {
      sql += " AND validation_status = ?";
      args.push(opts.validationStatus);
    }
    if (opts.canonicalOnly) sql += " AND is_canonical = 1";
    const rows = this.db.query(sql).all(...args) as Json[];
    return rows.map(rowToFinding);
  }

  getUnvalidatedFindings(runId: string): Finding[] {
    const rows = this.db
      .query(
        "SELECT * FROM findings WHERE run_id = ? AND validation_status IS NULL",
      )
      .all(runId) as Json[];
    return rows.map(rowToFinding);
  }

  setFindingValidation(findingId: string, status: string, payload: Json): void {
    this.db.run(
      "UPDATE findings SET validation_status = ?, validation_json = ? WHERE finding_id = ?",
      [status, JSON.stringify(payload), findingId],
    );
  }

  assignFindingGroup(
    findingId: string,
    groupId: string,
    isCanonical: boolean,
  ): void {
    this.db.run(
      "UPDATE findings SET group_id = ?, is_canonical = ? WHERE finding_id = ?",
      [groupId, isCanonical ? 1 : 0, findingId],
    );
  }

  // ---------- traces ----------

  addTrace(findingId: string, payload: Json): void {
    this.db.run(
      `INSERT OR REPLACE INTO traces
        (finding_id, reachable, confidence, rationale, raw_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        findingId,
        payload.reachable ? 1 : 0,
        payload.confidence ?? null,
        payload.rationale ?? "",
        JSON.stringify(payload),
      ],
    );
  }

  getTrace(findingId: string): Json | null {
    const row = this.db
      .query("SELECT raw_json FROM traces WHERE finding_id = ?")
      .get(findingId) as { raw_json: string } | undefined;
    return row ? JSON.parse(row.raw_json) : null;
  }

  getReachableCanonicalFindings(
    runId: string,
  ): Array<{ finding: Finding; trace: Json }> {
    const out: Array<{ finding: Finding; trace: Json }> = [];
    for (const f of this.getFindings(runId, {
      validationStatus: "confirmed",
      canonicalOnly: true,
    })) {
      const tr = this.getTrace(f.findingId);
      if (tr && tr.reachable) out.push({ finding: f, trace: tr });
    }
    return out;
  }

  // ---------- dedupe ----------

  addDedupeGroup(runId: string, group: Json): void {
    this.db.run(
      `INSERT OR REPLACE INTO dedupe_groups
        (group_id, run_id, root_cause, canonical_finding_id, raw_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        group.group_id,
        runId,
        group.root_cause,
        group.canonical_finding_id,
        JSON.stringify(group),
      ],
    );
  }

  // ---------- costs ----------

  recordCost(
    runId: string,
    stage: string,
    refId: string | null,
    resultMsg: ResultMessageLike,
  ): void {
    const usage = resultMsg.usage ?? {};
    this.db.run(
      `INSERT INTO costs
        (run_id, stage, ref_id, usd, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, num_turns, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        stage,
        refId,
        resultMsg.total_cost_usd ?? null,
        usage.input_tokens ?? null,
        usage.output_tokens ?? null,
        usage.cache_read_input_tokens ?? null,
        usage.cache_creation_input_tokens ?? null,
        resultMsg.num_turns ?? null,
        resultMsg.duration_ms ?? null,
        now(),
      ],
    );
  }

  totalCost(runId: string): number {
    const row = this.db
      .query(
        "SELECT COALESCE(SUM(usd), 0) AS total FROM costs WHERE run_id = ?",
      )
      .get(runId) as { total: number } | undefined;
    return row ? Number(row.total) : 0;
  }

  // ---------- artifacts ----------

  addArtifact(
    runId: string,
    stage: string,
    refId: string | null,
    kind: string,
    path: string,
  ): void {
    this.db.run(
      `INSERT INTO artifacts (run_id, stage, ref_id, kind, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, stage, refId, kind, path, now()],
    );
  }

  artifactCount(runId: string, stage: string): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND stage = ?",
      )
      .get(runId, stage) as { c: number } | undefined;
    return row ? Number(row.c) : 0;
  }

  close(): void {
    this.db.close();
  }
}

function rowToTask(r: Json): Task {
  return {
    taskId: r.task_id,
    runId: r.run_id,
    source: r.source,
    attackClass: r.attack_class,
    scopeHint: r.scope_hint,
    targetFiles: JSON.parse(r.target_files),
    rationale: r.rationale ?? "",
    priority: r.priority,
    status: r.status,
    rawJson: JSON.parse(r.raw_json),
  };
}

function rowToFinding(r: Json): Finding {
  return {
    findingId: r.finding_id,
    taskId: r.task_id,
    runId: r.run_id,
    file: r.file,
    lineStart: r.line_start,
    lineEnd: r.line_end,
    vulnClass: r.vuln_class,
    severity: r.severity,
    description: r.description,
    evidence: r.evidence,
    pocSucceeded: Boolean(r.poc_succeeded),
    confidence: r.confidence,
    rawJson: JSON.parse(r.raw_json),
    validationStatus: r.validation_status,
    validationJson: r.validation_json ? JSON.parse(r.validation_json) : null,
    groupId: r.group_id,
    isCanonical: Boolean(r.is_canonical),
  };
}
