/**
 * Interactive triage viewer — a zero-build local web UI served straight from
 * SQLite. Filter by severity / reachability / status, inspect the reachability
 * call chain, and mark findings confirmed / false-positive / won't-fix. Verdicts
 * persist to the `triage` table and can be exported as a baseline so suppressed
 * findings stop alerting on the next run.
 *
 * Binds to 127.0.0.1 only — this is a personal triage tool, not a service. The
 * client renders everything with DOM nodes + textContent (never innerHTML):
 * finding evidence comes from the audited, untrusted repo and can contain live
 * markup, so safe-by-construction DOM building is mandatory, not optional.
 */

import { baselineFromFindings } from "./baseline";
import { log } from "./logger";
import type { StateDB } from "./state";

type Json = any;

export interface ViewerFinding {
  finding_id: string;
  file: string;
  line_start: number;
  line_end: number;
  vuln_class: string;
  severity: string;
  confidence: number | null;
  validation_status: string | null;
  is_canonical: boolean;
  reachable: boolean;
  group_id: string | null;
  description: string;
  evidence: string;
  entry_points: Json[];
  call_chain: Json[];
  triage_status: string;
  triage_note: string | null;
}

/** Shape every finding the run produced for the viewer (joins traces + triage). */
export function buildViewerFindings(
  db: StateDB,
  runId: string,
): ViewerFinding[] {
  const triage = db.getTriage(runId);
  return db.getFindings(runId).map((f) => {
    const trace = db.getTrace(f.findingId);
    const t = triage[f.findingId];
    return {
      finding_id: f.findingId,
      file: f.file,
      line_start: f.lineStart,
      line_end: f.lineEnd,
      vuln_class: f.vulnClass,
      severity: f.severity,
      confidence: f.confidence,
      validation_status: f.validationStatus,
      is_canonical: f.isCanonical,
      reachable: Boolean(trace?.reachable),
      group_id: f.groupId,
      description: f.description,
      evidence: f.evidence,
      entry_points: trace?.entry_points ?? [],
      call_chain: trace?.call_chain ?? [],
      triage_status: t?.status ?? "new",
      triage_note: t?.note ?? null,
    };
  });
}

const VALID_STATUSES = new Set([
  "new",
  "confirmed",
  "false_positive",
  "wont_fix",
]);

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/**
 * Start the viewer. Returns a handle; the CLI keeps the process alive until
 * SIGINT, when `stop()` shuts the server down.
 */
export function serveViewer(
  db: StateDB,
  runId: string,
  opts: { port?: number; host?: string } = {},
): { url: string; stop: () => void } {
  const host = opts.host ?? "127.0.0.1";
  const run = db.getRun(runId);
  const repoPath = run?.repo_path ?? "";

  const server = Bun.serve({
    hostname: host,
    port: opts.port ?? 7878,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return new Response(page(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/findings") {
        const findings = buildViewerFindings(db, runId);
        return json({
          run_id: runId,
          repo_path: repoPath,
          counts: {
            total: findings.length,
            reachable: findings.filter((f) => f.reachable).length,
            confirmed: findings.filter(
              (f) => f.validation_status === "confirmed",
            ).length,
          },
          findings,
        });
      }

      if (url.pathname === "/api/triage" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as Json;
        if (!body?.finding_id || !VALID_STATUSES.has(body.status))
          return json(
            { error: "expected {finding_id, status}" },
            { status: 400 },
          );
        db.setTriage(runId, body.finding_id, body.status, body.note ?? null);
        return json({ ok: true });
      }

      // Build a baseline from everything triaged FP / won't-fix — the findings
      // you want suppressed on the next run.
      if (url.pathname === "/api/baseline") {
        const suppress = buildViewerFindings(db, runId).filter(
          (f) =>
            f.triage_status === "false_positive" ||
            f.triage_status === "wont_fix",
        );
        const baseline = baselineFromFindings(suppress, repoPath, runId);
        return json(baseline, {
          headers: {
            "content-type": "application/json",
            "content-disposition": 'attachment; filename="audit-baseline.json"',
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const reportedHost = host === "0.0.0.0" ? "localhost" : host;
  const url = `http://${reportedHost}:${server.port}`;
  log.success(`triage viewer at ${url}  (run ${runId}) — Ctrl-C to stop`);
  if (host !== "127.0.0.1" && host !== "localhost")
    log.warn(
      `viewer is bound to ${host} and has no authentication — anyone who can reach this host can read findings and change triage state`,
    );
  return { url, stop: () => server.stop(true) };
}

// Single-file UI. Vanilla JS, no build step, no external assets. The client
// builds the DOM with createElement + textContent — never innerHTML — so an
// XSS finding's evidence cannot execute inside the triage tool itself.
function page(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>audit — triage</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f17; --panel:#121826; --line:#1f2937;
    --fg:#e5e7eb; --dim:#9ca3af; --accent:#818cf8; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:12px 16px; border-bottom:1px solid var(--line);
    display:flex; gap:16px; align-items:center; flex-wrap:wrap; position:sticky; top:0; background:var(--bg); z-index:2; }
  h1 { font-size:15px; margin:0; font-weight:600; }
  .muted { color:var(--dim); }
  .filters { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  select, input[type=search] { background:var(--panel); color:var(--fg);
    border:1px solid var(--line); border-radius:6px; padding:5px 8px; }
  .layout { display:grid; grid-template-columns: 1fr 1fr; height:calc(100vh - 57px); }
  .list { overflow:auto; border-right:1px solid var(--line); }
  .detail { overflow:auto; padding:16px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); font-size:13px; }
  th { position:sticky; top:0; background:var(--panel); color:var(--dim); font-weight:500; }
  tr.row { cursor:pointer; }
  tr.row:hover { background:#0f1726; }
  tr.row.sel { background:#172033; }
  .pill { display:inline-block; padding:1px 7px; border-radius:999px; font-size:11px; font-weight:600; }
  .sev-critical{background:#7f1d1d;color:#fecaca}.sev-high{background:#7c2d12;color:#fed7aa}
  .sev-medium{background:#78350f;color:#fde68a}.sev-low{background:#1e3a5f;color:#bfdbfe}
  .sev-informational{background:#374151;color:#d1d5db}
  .reach { color:#34d399; font-weight:600; } .noreach { color:var(--dim); }
  .st-confirmed{color:#34d399}.st-false_positive{color:#f87171}.st-wont_fix{color:#fbbf24}.st-new{color:var(--dim)}
  code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre { background:#0f1726; border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; white-space:pre-wrap; }
  h3 { margin:16px 0 4px; font-size:13px; color:var(--dim); text-transform:uppercase; letter-spacing:.04em; }
  .chain li, .eps li { margin:2px 0; }
  .actions { margin:10px 0; }
  .actions button { background:var(--panel); color:var(--fg); border:1px solid var(--line);
    border-radius:6px; padding:6px 10px; cursor:pointer; margin-right:6px; }
  .actions button:hover { border-color:var(--accent); }
  .actions button.on { background:var(--accent); color:#0b0f17; border-color:var(--accent); }
  a.btn { color:var(--accent); text-decoration:none; border:1px solid var(--line); padding:5px 9px; border-radius:6px; }
</style>
</head>
<body>
<header>
  <h1>audit <span class="muted" id="runlabel"></span></h1>
  <div class="filters">
    <select id="sev"><option value="">all severities</option>
      <option>critical</option><option>high</option><option>medium</option>
      <option>low</option><option>informational</option></select>
    <select id="status"><option value="">all statuses</option>
      <option value="new">new</option><option value="confirmed">confirmed</option>
      <option value="false_positive">false positive</option><option value="wont_fix">won't fix</option></select>
    <label class="muted"><input type="checkbox" id="reach"/> reachable only</label>
    <input type="search" id="q" placeholder="filter text…" />
  </div>
  <div style="margin-left:auto" class="muted" id="counts"></div>
  <a class="btn" href="/api/baseline" download>Export baseline (suppressed)</a>
</header>
<div class="layout">
  <div class="list">
    <table><thead><tr><th>sev</th><th>class</th><th>file</th><th>reach</th><th>status</th></tr></thead>
    <tbody id="rows"></tbody></table>
  </div>
  <div class="detail" id="detail"></div>
</div>
<script>
let DATA = [], sel = null;
const $ = (s) => document.querySelector(s);

// Safe DOM builder — text always goes through textContent, never parsed as HTML.
function el(tag, opts = {}, kids = []) {
  const n = document.createElement(tag);
  if (opts.class) n.className = opts.class;
  if (opts.text != null) n.textContent = opts.text;
  if (opts.onclick) n.onclick = opts.onclick;
  if (opts.href) n.href = opts.href;
  for (const k of [].concat(kids)) if (k) n.appendChild(k);
  return n;
}
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

async function load() {
  const r = await fetch("/api/findings").then((x) => x.json());
  DATA = r.findings;
  $("#runlabel").textContent = r.run_id + " · " + r.repo_path;
  $("#counts").textContent =
    r.counts.total + " findings · " + r.counts.reachable + " reachable · " + r.counts.confirmed + " confirmed";
  render();
}
function filtered() {
  const sev = $("#sev").value, st = $("#status").value, reach = $("#reach").checked, q = $("#q").value.toLowerCase();
  return DATA.filter((f) =>
    (!sev || f.severity === sev) &&
    (!st || f.triage_status === st) &&
    (!reach || f.reachable) &&
    (!q || (f.file + " " + f.vuln_class + " " + f.description).toLowerCase().includes(q)));
}
function render() {
  const body = $("#rows");
  clear(body);
  const rows = filtered();
  if (!rows.length) {
    const td = el("td", { class: "muted", text: "no matches" });
    td.colSpan = 5; td.style.padding = "16px";
    body.appendChild(el("tr", {}, td));
    return;
  }
  for (const f of rows) {
    const sevTd = el("td", {}, el("span", { class: "pill sev-" + f.severity, text: f.severity }));
    const fileTd = el("td", {}, el("code", { text: f.file.split("/").slice(-2).join("/") + ":" + f.line_start }));
    const reachTd = el("td", { class: f.reachable ? "reach" : "noreach", text: f.reachable ? "✔" : "·" });
    const stTd = el("td", { class: "st-" + f.triage_status, text: f.triage_status.replace("_", " ") });
    const tr = el("tr", { class: "row" + (sel === f.finding_id ? " sel" : ""), onclick: () => showDetail(f.finding_id) },
      [sevTd, el("td", { text: f.vuln_class }), fileTd, reachTd, stTd]);
    body.appendChild(tr);
  }
}
function showDetail(id) {
  sel = id; render();
  const f = DATA.find((x) => x.finding_id === id);
  const d = $("#detail");
  clear(d);
  if (!f) { d.appendChild(el("p", { class: "muted", text: "Select a finding." })); return; }

  const head = el("p", {}, [
    el("span", { class: "pill sev-" + f.severity, text: f.severity }),
    document.createTextNode(" "),
    el("b", { text: " " + f.vuln_class + " " }),
    el("span", { class: f.reachable ? "reach" : "noreach", text: f.reachable ? "reachable" : "not reachable" }),
  ]);
  const loc = el("p", {}, el("code", { text: f.file + ":" + f.line_start + "-" + f.line_end +
    (f.confidence != null ? "  (confidence " + f.confidence + ")" : "") }));

  const mk = (s, label) =>
    el("button", { class: f.triage_status === s ? "on" : "", text: label, onclick: () => triage(id, s) });
  const actions = el("div", { class: "actions" }, [
    mk("confirmed", "✔ confirm"), mk("false_positive", "✕ false positive"),
    mk("wont_fix", "⊘ won't fix"), mk("new", "↺ reset"),
  ]);

  d.appendChild(head);
  d.appendChild(loc);
  d.appendChild(actions);
  d.appendChild(el("h3", { text: "Description" }));
  d.appendChild(el("p", { text: f.description }));
  d.appendChild(el("h3", { text: "Evidence" }));
  d.appendChild(el("pre", { text: f.evidence }));

  if (f.entry_points && f.entry_points.length) {
    d.appendChild(el("h3", { text: "Entry points" }));
    const ul = el("ul", { class: "eps" });
    for (const e of f.entry_points)
      ul.appendChild(el("li", {}, el("code", { text: (e.kind || "?") + " @ " + (e.location || "?") })));
    d.appendChild(ul);
  }
  if (f.call_chain && f.call_chain.length) {
    d.appendChild(el("h3", { text: "Call chain" }));
    const ol = el("ol", { class: "chain" });
    for (const c of f.call_chain)
      ol.appendChild(el("li", {}, el("code", { text: (c.file || "?") + ":" + c.line + " — " + (c.function || "?") + "()" })));
    d.appendChild(ol);
  }
}
async function triage(id, status) {
  await fetch("/api/triage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ finding_id: id, status }),
  });
  const f = DATA.find((x) => x.finding_id === id);
  if (f) f.triage_status = status;
  showDetail(id);
}
["#sev", "#status", "#reach", "#q"].forEach((s) => $(s).addEventListener("input", render));
load();
</script>
</body>
</html>`;
}
