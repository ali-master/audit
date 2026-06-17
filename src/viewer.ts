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
// XSS finding's evidence cannot execute inside the triage tool itself. (The
// embedded script therefore avoids template literals: a backtick or ${ would
// terminate the String.raw wrapper or interpolate at module-load time.)
function page(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>audit — triage</title>
<style>
  :root {
    color-scheme: dark;
    --bg:#080b12; --bg2:#0d1320; --panel:#111827; --panel2:#0f1726;
    --line:#1e293b; --line2:#273449; --fg:#e5e7eb; --dim:#94a3b8; --faint:#64748b;
    --accent:#818cf8; --accent2:#a78bfa;
    --crit:#f43f5e; --high:#fb923c; --med:#fbbf24; --low:#38bdf8; --info:#94a3b8;
    --ok:#34d399; --bad:#f87171; --warn:#fbbf24;
  }
  * { box-sizing: border-box; }
  html, body { height:100%; }
  body { margin:0; background:radial-gradient(1200px 600px at 80% -10%, #15213a 0%, var(--bg) 60%);
    color:var(--fg); display:flex; flex-direction:column; height:100vh; overflow:hidden;
    font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  ::-webkit-scrollbar { width:10px; height:10px; }
  ::-webkit-scrollbar-thumb { background:#243049; border-radius:8px; }

  header { flex:none; display:flex; align-items:center; gap:14px; flex-wrap:wrap;
    padding:12px 18px; border-bottom:1px solid var(--line);
    background:linear-gradient(90deg, rgba(129,140,248,.10), rgba(167,139,250,.02)); }
  .brand { font-size:16px; font-weight:700; letter-spacing:-.01em;
    background:linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .runlabel { color:var(--dim); font-size:12.5px; }
  .spacer { margin-left:auto; }
  .btn { color:var(--fg); text-decoration:none; border:1px solid var(--line2);
    background:var(--panel); padding:7px 12px; border-radius:8px; font-size:13px; cursor:pointer; transition:.15s; }
  .btn:hover { border-color:var(--accent); color:#fff; }
  .btn.accent { background:linear-gradient(90deg,var(--accent),var(--accent2)); border:0; color:#0b0f17; font-weight:600; }

  /* analytics dashboard */
  .dash { flex:none; padding:14px 18px; border-bottom:1px solid var(--line);
    display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; align-items:stretch; }
  .dash.collapsed { display:none; }
  .card { background:linear-gradient(180deg,var(--panel),var(--panel2)); border:1px solid var(--line);
    border-radius:12px; padding:12px 14px; }
  .card .k { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--faint); }
  .card .v { font-size:26px; font-weight:700; margin-top:2px; line-height:1.1; }
  .card .s { font-size:12px; color:var(--dim); margin-top:2px; }
  .card.span2 { grid-column:span 2; }
  .bars { display:flex; flex-direction:column; gap:6px; margin-top:8px; }
  .barrow { display:grid; grid-template-columns:80px 1fr 34px; gap:8px; align-items:center; font-size:12px; }
  .barrow .lbl { color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .barrow .lbl.clickable { cursor:pointer; }
  .barrow .lbl.clickable:hover { color:#fff; }
  .track { background:#0a0f1a; border:1px solid var(--line); border-radius:6px; height:9px; overflow:hidden; }
  .fill { height:100%; border-radius:6px; transition:width .35s ease; }
  .barrow .n { text-align:right; color:var(--dim); font-variant-numeric:tabular-nums; }
  .fill.crit{background:var(--crit)} .fill.high{background:var(--high)} .fill.med{background:var(--med)}
  .fill.low{background:var(--low)} .fill.info{background:var(--info)} .fill.accent{background:linear-gradient(90deg,var(--accent),var(--accent2))}

  /* toolbar */
  .toolbar { flex:none; display:flex; align-items:center; gap:10px; flex-wrap:wrap;
    padding:10px 18px; border-bottom:1px solid var(--line); background:rgba(13,19,32,.6); backdrop-filter:blur(6px); }
  .search { position:relative; flex:1 1 240px; min-width:200px; }
  .search input { width:100%; padding:8px 12px 8px 32px; }
  .search::before { content:"⌕"; position:absolute; left:11px; top:7px; color:var(--faint); font-size:15px; }
  select, input[type=search], input[type=text] { background:var(--panel); color:var(--fg);
    border:1px solid var(--line2); border-radius:8px; padding:7px 10px; font-size:13px; outline:none; }
  select:focus, input:focus { border-color:var(--accent); }
  .toggle { display:inline-flex; align-items:center; gap:6px; color:var(--dim); font-size:13px;
    border:1px solid var(--line2); border-radius:8px; padding:6px 10px; cursor:pointer; user-select:none; }
  .toggle input { accent-color:var(--accent); }
  .count { color:var(--faint); font-size:12.5px; margin-left:auto; white-space:nowrap; }

  /* main split */
  .layout { flex:1 1 auto; min-height:0; display:grid; grid-template-columns:minmax(420px,1.1fr) minmax(380px,1fr); }
  .list { overflow:auto; min-height:0; border-right:1px solid var(--line); }
  .detail { overflow:auto; min-height:0; padding:18px 20px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:middle; }
  th { position:sticky; top:0; z-index:1; background:#0c1220; color:var(--faint); font-weight:600;
    text-transform:uppercase; letter-spacing:.04em; font-size:11px; cursor:pointer; white-space:nowrap; }
  th:hover { color:var(--fg); }
  th .arrow { color:var(--accent); }
  tr.row { cursor:pointer; transition:background .1s; }
  tr.row:hover { background:#0e1626; }
  tr.row.sel { background:linear-gradient(90deg, rgba(129,140,248,.16), transparent); box-shadow:inset 2px 0 0 var(--accent); }

  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700;
    text-transform:uppercase; letter-spacing:.02em; }
  .sev-critical{background:rgba(244,63,94,.16);color:#fda4af;border:1px solid rgba(244,63,94,.35)}
  .sev-high{background:rgba(251,146,60,.16);color:#fed7aa;border:1px solid rgba(251,146,60,.35)}
  .sev-medium{background:rgba(251,191,36,.14);color:#fde68a;border:1px solid rgba(251,191,36,.3)}
  .sev-low{background:rgba(56,189,248,.14);color:#bae6fd;border:1px solid rgba(56,189,248,.3)}
  .sev-informational{background:rgba(148,163,184,.14);color:#cbd5e1;border:1px solid rgba(148,163,184,.3)}
  .reach { color:var(--ok); font-weight:700; } .noreach { color:var(--faint); }
  .tag { display:inline-block; font-size:11px; padding:2px 7px; border-radius:6px; border:1px solid var(--line2); color:var(--dim); }
  .tag.confirmed{color:var(--ok);border-color:rgba(52,211,153,.4)} .tag.false_positive{color:var(--bad);border-color:rgba(248,113,113,.4)}
  .tag.wont_fix{color:var(--warn);border-color:rgba(251,191,36,.4)} .tag.new{color:var(--faint)}
  .conf { display:inline-flex; align-items:center; gap:6px; font-variant-numeric:tabular-nums; color:var(--dim); }
  .conf .track { width:42px; }

  code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .detail code { color:#c7d2fe; }
  pre { background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:13px; overflow:auto; white-space:pre-wrap; font-size:12.5px; }
  h2.dt { font-size:16px; margin:0 0 4px; }
  h3 { margin:18px 0 6px; font-size:11px; color:var(--faint); text-transform:uppercase; letter-spacing:.06em; }
  .meta { color:var(--dim); font-size:13px; margin:2px 0 10px; }
  .chain { list-style:none; padding:0; margin:0; }
  .chain li { position:relative; padding:4px 0 4px 18px; font-size:12.5px; }
  .chain li::before { content:""; position:absolute; left:5px; top:11px; width:6px; height:6px; border-radius:50%; background:var(--accent); }
  .chain li:not(:last-child)::after { content:""; position:absolute; left:7.5px; top:17px; bottom:-4px; width:1px; background:var(--line2); }
  .eps { padding-left:18px; margin:0; }
  .eps li { font-size:12.5px; margin:2px 0; }
  .actions { display:flex; gap:8px; flex-wrap:wrap; margin:12px 0 4px; }
  .actions button { background:var(--panel); color:var(--fg); border:1px solid var(--line2);
    border-radius:8px; padding:7px 12px; cursor:pointer; font-size:13px; transition:.15s; }
  .actions button:hover { border-color:var(--accent); }
  .actions button.on { background:linear-gradient(90deg,var(--accent),var(--accent2)); color:#0b0f17; border:0; font-weight:600; }
  .empty { color:var(--faint); padding:40px 16px; text-align:center; }
  @media (max-width:900px){ .layout{grid-template-columns:1fr; grid-template-rows:1fr 1fr;} .list{border-right:0;border-bottom:1px solid var(--line);} }
</style>
</head>
<body>
<header>
  <span class="brand">audit</span>
  <span class="runlabel" id="runlabel"></span>
  <span class="spacer"></span>
  <button class="btn" id="dashtoggle">analytics</button>
  <a class="btn accent" href="/api/baseline" download>Export baseline</a>
</header>

<div class="dash" id="dash"></div>

<div class="toolbar">
  <div class="search"><input type="search" id="q" placeholder="search file, class, description…" /></div>
  <select id="sev"><option value="">all severities</option>
    <option>critical</option><option>high</option><option>medium</option><option>low</option><option>informational</option></select>
  <select id="status"><option value="">all statuses</option>
    <option value="new">new</option><option value="confirmed">confirmed</option>
    <option value="false_positive">false positive</option><option value="wont_fix">won't fix</option></select>
  <select id="cls"><option value="">all classes</option></select>
  <label class="toggle"><input type="checkbox" id="reach"/> reachable only</label>
  <label class="toggle"><input type="checkbox" id="canon"/> canonical only</label>
  <button class="btn" id="reset">reset</button>
  <span class="count" id="count"></span>
</div>

<div class="layout">
  <div class="list">
    <table><thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table>
  </div>
  <div class="detail" id="detail"><div class="empty">Select a finding to inspect its evidence and reachability.</div></div>
</div>

<script>
var DATA = [], sel = null;
var sortKey = "severity", sortDir = -1;
var SEV = ["critical","high","medium","low","informational"];
var SEVRANK = { critical:5, high:4, medium:3, low:2, informational:1 };
var SEVCLASS = { critical:"crit", high:"high", medium:"med", low:"low", informational:"info" };
var COLS = [
  { key:"severity", label:"sev" }, { key:"vuln_class", label:"class" },
  { key:"file", label:"file" }, { key:"confidence", label:"conf" },
  { key:"reachable", label:"reach" }, { key:"triage_status", label:"status" },
];
function $(s){ return document.querySelector(s); }

// Safe DOM builder — text always via textContent; never innerHTML.
function el(tag, opts, kids){
  opts = opts || {}; var n = document.createElement(tag);
  if (opts.class) n.className = opts.class;
  if (opts.text != null) n.textContent = opts.text;
  if (opts.onclick) n.onclick = opts.onclick;
  if (opts.href) n.href = opts.href;
  if (opts.title) n.title = opts.title;
  if (opts.style) for (var p in opts.style) n.style[p] = opts.style[p];
  var ch = [].concat(kids == null ? [] : kids);
  for (var i=0;i<ch.length;i++){ var k = ch[i];
    if (k == null || k === false) continue;
    n.appendChild(typeof k === "object" ? k : document.createTextNode(String(k))); }
  return n;
}
function clear(n){ while (n.firstChild) n.removeChild(n.firstChild); }
function shortFile(p){ var a = p.split("/"); return a.slice(-2).join("/"); }

async function load(){
  var r = await fetch("/api/findings").then(function(x){ return x.json(); });
  DATA = r.findings;
  $("#runlabel").textContent = r.run_id + "  ·  " + r.repo_path;
  // populate the class filter from the data actually present
  var classes = Array.from(new Set(DATA.map(function(f){ return f.vuln_class; }))).sort();
  var csel = $("#cls");
  classes.forEach(function(c){ csel.appendChild(el("option", { text:c })); });
  renderHead();
  renderAll();
}

function currentFilter(){
  var sev=$("#sev").value, st=$("#status").value, cls=$("#cls").value,
      reach=$("#reach").checked, canon=$("#canon").checked, q=$("#q").value.toLowerCase().trim();
  return DATA.filter(function(f){
    return (!sev || f.severity===sev) && (!st || f.triage_status===st) &&
      (!cls || f.vuln_class===cls) && (!reach || f.reachable) && (!canon || f.is_canonical) &&
      (!q || (f.file+" "+f.vuln_class+" "+f.description+" "+(f.finding_id||"")).toLowerCase().indexOf(q)>=0);
  });
}
function sortRows(rows){
  return rows.slice().sort(function(a,b){
    var x, y;
    if (sortKey==="severity"){ x=SEVRANK[a.severity]||0; y=SEVRANK[b.severity]||0; }
    else if (sortKey==="confidence"){ x=a.confidence==null?-1:a.confidence; y=b.confidence==null?-1:b.confidence; }
    else if (sortKey==="reachable"){ x=a.reachable?1:0; y=b.reachable?1:0; }
    else { x=(a[sortKey]||"")+""; y=(b[sortKey]||"")+""; return sortDir*x.localeCompare(y); }
    return x<y?-sortDir : x>y?sortDir : 0;
  });
}

function statCard(k, v, s){ return el("div",{class:"card"},[ el("div",{class:"k",text:k}), el("div",{class:"v",text:String(v)}), s?el("div",{class:"s",text:s}):null ]); }
function barRow(label, n, max, cls, onclick){
  var pct = max>0 ? Math.max(2, Math.round(n/max*100)) : 0;
  return el("div",{class:"barrow"},[
    el("div",{class:"lbl"+(onclick?" clickable":""), text:label, title:label, onclick:onclick||null}),
    el("div",{class:"track"},[ el("div",{class:"fill "+cls, style:{ width: pct+"%" }}) ]),
    el("div",{class:"n", text:String(n)}),
  ]);
}
function topEntries(rows, key, n){
  var m={}; rows.forEach(function(f){ var v=f[key]; m[v]=(m[v]||0)+1; });
  return Object.keys(m).map(function(k){ return [k, m[k]]; })
    .sort(function(a,b){ return b[1]-a[1]; }).slice(0, n||6);
}

function renderDash(rows){
  var d = $("#dash"); clear(d);
  var total = rows.length;
  var reachable = rows.filter(function(f){ return f.reachable; }).length;
  var confirmed = rows.filter(function(f){ return f.validation_status==="confirmed"; }).length;
  var triaged = rows.filter(function(f){ return f.triage_status!=="new"; }).length;
  var confs = rows.filter(function(f){ return f.confidence!=null; }).map(function(f){ return f.confidence; });
  var avg = confs.length ? (confs.reduce(function(a,b){return a+b;},0)/confs.length) : null;
  var crit = rows.filter(function(f){ return f.severity==="critical"||f.severity==="high"; }).length;

  var ofTotal = total===DATA.length ? null : "of "+DATA.length+" total";
  d.appendChild(statCard("findings", total, ofTotal));
  d.appendChild(statCard("critical + high", crit, total?Math.round(crit/total*100)+"% of shown":""));
  d.appendChild(statCard("reachable", reachable, total?Math.round(reachable/Math.max(1,total)*100)+"% reach the sink":""));
  d.appendChild(statCard("confirmed", confirmed, "by adversarial review"));
  d.appendChild(statCard("triaged", triaged + " / " + total, (total-triaged)+" left"));
  d.appendChild(statCard("avg confidence", avg==null?"—":avg.toFixed(2), confs.length+" scored"));

  // severity distribution — bars are clickable to filter by that severity
  var sevCard = el("div",{class:"card span2"},[ el("div",{class:"k",text:"severity distribution"}) ]);
  var sevBars = el("div",{class:"bars"});
  var sevMax = Math.max.apply(null, SEV.map(function(s){ return rows.filter(function(f){return f.severity===s;}).length; }).concat([1]));
  SEV.forEach(function(s){
    var n = rows.filter(function(f){ return f.severity===s; }).length;
    sevBars.appendChild(barRow(s, n, sevMax, SEVCLASS[s], function(){ $("#sev").value = $("#sev").value===s?"":s; renderAll(); }));
  });
  sevCard.appendChild(sevBars); d.appendChild(sevCard);

  // top vulnerability classes — clickable
  var clsTop = topEntries(rows, "vuln_class", 6);
  var clsCard = el("div",{class:"card span2"},[ el("div",{class:"k",text:"top vulnerability classes"}) ]);
  var clsBars = el("div",{class:"bars"});
  var clsMax = clsTop.length ? clsTop[0][1] : 1;
  clsTop.forEach(function(e){ clsBars.appendChild(barRow(e[0], e[1], clsMax, "accent", function(){ $("#cls").value = $("#cls").value===e[0]?"":e[0]; renderAll(); })); });
  if (!clsTop.length) clsBars.appendChild(el("div",{class:"s",text:"no findings"}));
  clsCard.appendChild(clsBars); d.appendChild(clsCard);

  // hottest files
  var fileTop = topEntries(rows, "file", 6);
  var fileCard = el("div",{class:"card span2"},[ el("div",{class:"k",text:"hottest files"}) ]);
  var fileBars = el("div",{class:"bars"});
  var fileMax = fileTop.length ? fileTop[0][1] : 1;
  fileTop.forEach(function(e){ fileBars.appendChild(barRow(shortFile(e[0]), e[1], fileMax, "accent")); });
  if (!fileTop.length) fileBars.appendChild(el("div",{class:"s",text:"no findings"}));
  fileCard.appendChild(fileBars); d.appendChild(fileCard);
}

function renderHead(){
  var h = $("#head"); clear(h);
  COLS.forEach(function(c){
    var arrow = sortKey===c.key ? el("span",{class:"arrow",text: sortDir<0?" ↓":" ↑"}) : null;
    h.appendChild(el("th",{ onclick:function(){ setSort(c.key); } }, arrow?[c.label, arrow]:[c.label]));
  });
}
function setSort(key){
  if (sortKey===key) sortDir = -sortDir;
  else { sortKey = key; sortDir = (key==="severity"||key==="confidence"||key==="reachable") ? -1 : 1; }
  renderHead(); renderTable(sortRows(currentFilter()));
}

function confCell(f){
  if (f.confidence==null) return el("span",{class:"conf",text:"—"});
  var pct = Math.round(f.confidence*100);
  return el("span",{class:"conf"},[ el("span",{class:"track",style:{height:"7px"}},[ el("div",{class:"fill accent",style:{width:pct+"%"}}) ]), el("span",{text:f.confidence.toFixed(2)}) ]);
}
function renderTable(rows){
  var body = $("#rows"); clear(body);
  if (!rows.length){ var td=el("td",{class:"empty",text:"no findings match the current filters"}); td.colSpan=COLS.length; body.appendChild(el("tr",{},[td])); return; }
  rows.forEach(function(f){
    var tr = el("tr",{ class:"row"+(sel===f.finding_id?" sel":""), onclick:function(){ showDetail(f.finding_id); } },[
      el("td",{},[ el("span",{class:"pill sev-"+f.severity, text:f.severity}) ]),
      el("td",{text:f.vuln_class}),
      el("td",{},[ el("code",{text:shortFile(f.file)+":"+f.line_start, title:f.file}) ]),
      el("td",{},[ confCell(f) ]),
      el("td",{class:f.reachable?"reach":"noreach", text:f.reachable?"✔":"·"}),
      el("td",{},[ el("span",{class:"tag "+f.triage_status, text:f.triage_status.replace("_"," ")}) ]),
    ]);
    body.appendChild(tr);
  });
}

function renderAll(){
  var rows = sortRows(currentFilter());
  renderDash(rows);
  renderTable(rows);
  $("#count").textContent = rows.length + " of " + DATA.length + " findings";
}

function showDetail(id){
  sel = id; renderTable(sortRows(currentFilter()));
  var f = DATA.find(function(x){ return x.finding_id===id; });
  var d = $("#detail"); clear(d);
  if (!f){ d.appendChild(el("div",{class:"empty",text:"Select a finding."})); return; }

  d.appendChild(el("h2",{class:"dt"},[ el("span",{class:"pill sev-"+f.severity, text:f.severity}), "  " + f.vuln_class ]));
  var bits = [ el("code",{text:f.file+":"+f.line_start+"-"+f.line_end}) ];
  bits.push("   ");
  bits.push(el("span",{class:f.reachable?"reach":"noreach", text:f.reachable?"● reachable":"○ not reachable"}));
  if (f.validation_status) bits.push(el("span",{class:"tag "+(f.validation_status==="confirmed"?"confirmed":"new"), text:"  "+f.validation_status}));
  if (f.confidence!=null) bits.push(el("span",{class:"conf"},["   conf ", el("span",{text:f.confidence.toFixed(2)})]));
  if (f.is_canonical) bits.push(el("span",{class:"tag", text:"  canonical"}));
  d.appendChild(el("div",{class:"meta"}, bits));

  var mk = function(s,label){ return el("button",{ class:f.triage_status===s?"on":"", text:label, onclick:function(){ triage(id,s); } }); };
  d.appendChild(el("div",{class:"actions"},[ mk("confirmed","✔ confirm"), mk("false_positive","✕ false positive"), mk("wont_fix","⊘ won't fix"), mk("new","↺ reset") ]));

  d.appendChild(el("h3",{text:"Description"}));
  d.appendChild(el("p",{text:f.description}));
  d.appendChild(el("h3",{text:"Evidence"}));
  d.appendChild(el("pre",{text:f.evidence}));

  if (f.entry_points && f.entry_points.length){
    d.appendChild(el("h3",{text:"Entry points"}));
    var ul = el("ul",{class:"eps"});
    f.entry_points.forEach(function(e){ ul.appendChild(el("li",{},[ el("code",{text:(e.kind||"?")+" @ "+(e.location||"?")}), e.controllable_by?el("span",{class:"tag",text:"  "+e.controllable_by}):null ])); });
    d.appendChild(ul);
  }
  if (f.call_chain && f.call_chain.length){
    d.appendChild(el("h3",{text:"Reachability call chain"}));
    var ol = el("ul",{class:"chain"});
    f.call_chain.forEach(function(c){ ol.appendChild(el("li",{},[ el("code",{text:(c.file||"?")+":"+c.line}), "  —  ", el("code",{text:(c.function||"?")+"()"}) ])); });
    d.appendChild(ol);
  }
}

async function triage(id, status){
  await fetch("/api/triage",{ method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ finding_id:id, status:status }) });
  var f = DATA.find(function(x){ return x.finding_id===id; });
  if (f) f.triage_status = status;
  renderAll(); showDetail(id);
}

// keyboard: j/k or arrows move the selection through the visible list
function move(delta){
  var rows = sortRows(currentFilter()); if (!rows.length) return;
  var i = rows.findIndex(function(f){ return f.finding_id===sel; });
  i = Math.max(0, Math.min(rows.length-1, (i<0?0:i+delta)));
  showDetail(rows[i].finding_id);
  var node = document.querySelector("tr.row.sel"); if (node) node.scrollIntoView({ block:"nearest" });
}
document.addEventListener("keydown", function(e){
  if (e.target && (e.target.tagName==="INPUT" || e.target.tagName==="SELECT")) return;
  if (e.key==="j" || e.key==="ArrowDown"){ e.preventDefault(); move(1); }
  else if (e.key==="k" || e.key==="ArrowUp"){ e.preventDefault(); move(-1); }
});

["#sev","#status","#cls","#reach","#canon","#q"].forEach(function(s){ $(s).addEventListener("input", renderAll); });
$("#reset").addEventListener("click", function(){ ["#sev","#status","#cls"].forEach(function(s){ $(s).value=""; }); $("#reach").checked=false; $("#canon").checked=false; $("#q").value=""; renderAll(); });
$("#dashtoggle").addEventListener("click", function(){ $("#dash").classList.toggle("collapsed"); });
load();
</script>
</body>
</html>`;
}
