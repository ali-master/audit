/**
 * Modern, streaming-friendly logger.
 *
 * Design goals:
 *  - Informational output goes to **stdout**; only warnings/errors go to
 *    **stderr**. (Previously everything went to stderr, which many terminals
 *    render in red — making normal pipeline output look like failures.)
 *  - Timestamps are 24-hour and in the device's local timezone.
 *  - A single pinned "live" line streams what each stage is doing in real time,
 *    keeping all of a stage's progress on one self-updating line. Permanent log
 *    lines scroll above it; the live line stays glued to the bottom.
 *
 * Dependency-light — only `chalk` for colour, plus raw ANSI for the live line.
 */

import chalk from "chalk";

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

// ---------------------------------------------------------------------------
// Palette — a calm, modern truecolor set. Falls back gracefully when the
// terminal lacks colour support (chalk handles the downgrade).
// ---------------------------------------------------------------------------
const c = {
  ts: (s: string) => chalk.hex("#6b7280")(s), // slate-500
  tag: (s: string) => chalk.hex("#818cf8")(s), // indigo-400
  stage: (s: string) => chalk.hex("#38bdf8")(s), // sky-400
  info: (s: string) => chalk.hex("#38bdf8")(s),
  success: (s: string) => chalk.hex("#34d399")(s), // emerald-400
  warn: (s: string) => chalk.hex("#fbbf24")(s), // amber-400
  error: (s: string) => chalk.hex("#f87171")(s), // red-400
  dim: (s: string) => chalk.dim(s),
  detail: (s: string) => chalk.hex("#9ca3af")(s), // gray-400
};

const glyph = {
  info: "›",
  success: "✔",
  warn: "⚠",
  error: "✖",
  debug: "·",
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const isTTY = Boolean(process.stdout.isTTY);

// ---------------------------------------------------------------------------
// 24-hour, local-timezone timestamp.
// ---------------------------------------------------------------------------
function rawTime(): string {
  return new Date().toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function stamp(): string {
  return c.ts(rawTime());
}

/** Current terminal width, with a sane fallback for odd/unsized streams. */
function columns(): number {
  const cols = process.stdout.columns;
  return cols && cols > 0 ? cols : 80;
}

/**
 * Pull a leading `[tag]` (the run id) out of a message and render it as a
 * coloured pill, then accent the first "stage:" word. Keeps every existing
 * call site (`log.info("[runId] hunt: ...")`) looking modern with no churn.
 */
function decorate(msg: string): string {
  let rest = msg;
  let pill = "";
  const m = /^\[([^\]]+)\]\s*/.exec(msg);
  if (m) {
    pill = `${c.dim("[")}${c.tag(m[1])}${c.dim("]")} `;
    rest = msg.slice(m[0].length);
  }
  // Accent a leading "word:" or "word " stage marker.
  rest = rest.replace(/^([a-z][\w-]*)([: ])/i, (_, w, sep) => c.stage(w) + sep);
  return pill + rest;
}

// ---------------------------------------------------------------------------
// Live line (spinner) management. Only one is active at a time; stages run
// sequentially at the orchestrator level, so a single pinned line is enough.
// ---------------------------------------------------------------------------
let active: Spinner | null = null;

/** Emit a permanent line, cooperating with any active live line. */
function emit(stream: NodeJS.WriteStream, line: string): void {
  if (active && isTTY) {
    stream.write(`\r\x1B[2K${line}\n`);
    active.render();
  } else {
    stream.write(`${line}\n`);
  }
}

class Spinner {
  private frame = 0;
  private detail = "";
  private done = 0;
  private readonly total: number | null;
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly title: string,
    opts?: { total?: number; detail?: string },
  ) {
    this.total = opts?.total ?? null;
    this.detail = opts?.detail ?? "";
    if (isTTY) {
      process.stdout.write("\x1B[?25l"); // hide cursor
      this.timer = setInterval(() => this.tick(), 80);
      this.timer.unref?.();
      this.render();
    } else {
      // Non-interactive: announce the stage start as a plain line.
      const head = this.total !== null ? ` (0/${this.total})` : "";
      process.stdout.write(`${stamp()} ${c.stage(this.title)}${head}\n`);
    }
  }

  private tick(): void {
    this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
    this.render();
  }

  private elapsed(): string {
    const s = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
  }

  /** Redraw the live line in place. */
  render(): void {
    if (!isTTY || active !== this) return;

    // Compute everything as plain text first so we can truncate to the
    // terminal width. If the line is allowed to exceed the width the terminal
    // soft-wraps it onto extra rows, and our in-place redraw (`\r` + erase-
    // line) only clears the *last* row — leaving every wrapped row stuck on
    // screen. That is what floods the output. Clamping the detail (the only
    // unbounded segment) guarantees a single-row line that redraws cleanly.
    const frame = SPINNER_FRAMES[this.frame];
    const time = rawTime();
    const counterText =
      this.total !== null ? ` ${this.done}/${this.total}` : "";
    const elapsedText = ` · ${this.elapsed()}`;

    // Fixed width: "<time> <frame> <title><counter>" + " <detail>" + "<elapsed>".
    const fixed =
      time.length +
      1 +
      frame.length +
      1 +
      this.title.length +
      counterText.length;
    const budget = columns() - fixed - elapsedText.length - 1; // -1: space before detail

    let detail = this.detail;
    if (!detail || budget <= 1) {
      detail = "";
    } else if (detail.length > budget) {
      detail = `${detail.slice(0, budget - 1)}…`;
    }

    const detailPart = detail ? ` ${c.detail(detail)}` : "";
    process.stdout.write(
      `\r\x1B[2K${c.ts(time)} ${c.info(frame)} ${c.stage(this.title)}` +
        `${c.dim(counterText)}${detailPart}${c.dim(elapsedText)}`,
    );
  }

  /** Replace the streaming detail text shown on the live line. */
  update(detail: string): void {
    this.detail = detail;
    this.render();
  }

  /** Mark one unit of work complete; optionally update the detail. */
  step(detail?: string): void {
    this.done++;
    if (detail !== undefined) this.detail = detail;
    this.render();
  }

  private settle(
    color: (s: string) => string,
    mark: string,
    summary: string,
  ): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (active === this) active = null;
    if (isTTY) {
      process.stdout.write("\r\x1B[2K"); // wipe the live line
      process.stdout.write("\x1B[?25h"); // restore cursor
    }
    const elapsed = c.dim(`(${this.elapsed()})`);
    process.stdout.write(
      `${stamp()} ${color(mark)} ${decorate(summary)} ${elapsed}\n`,
    );
  }

  succeed(summary: string): void {
    this.settle(c.success, glyph.success, summary);
  }

  fail(summary: string): void {
    this.settle(c.error, glyph.error, summary);
  }

  warn(summary: string): void {
    this.settle(c.warn, glyph.warn, summary);
  }

  /** Stop without a final summary line. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (active === this) active = null;
    if (isTTY) process.stdout.write("\r\x1B[2K\x1B[?25h");
  }
}

/** Handle returned to stages for driving their live line. */
export interface StageHandle {
  /** Replace the streaming detail (e.g. the agent's current tool call). */
  readonly update: (detail: string) => void;
  /** Increment the progress counter; optionally set the detail. */
  readonly step: (detail?: string) => void;
  /** Finish on a green success summary. */
  readonly succeed: (summary: string) => void;
  /** Finish on a red failure summary. */
  readonly fail: (summary: string) => void;
  /** Finish on an amber warning summary. */
  readonly warn: (summary: string) => void;
  /** Stop the line without committing a summary. */
  readonly stop: () => void;
  /** Convenience sink to hand to the agent runner for live streaming. */
  readonly onActivity: (detail: string) => void;
}

export const log = {
  /**
   * Emit a raw line to stdout with no timestamp/glyph/decoration, cooperating
   * with any active live line. For tabular and machine-facing output (tables,
   * stats, the rendered report) that should not carry log chrome.
   */
  print(msg = ""): void {
    emit(process.stdout, msg);
  },
  info(msg: string): void {
    emit(process.stdout, `${stamp()} ${c.info(glyph.info)} ${decorate(msg)}`);
  },
  success(msg: string): void {
    emit(
      process.stdout,
      `${stamp()} ${c.success(glyph.success)} ${decorate(msg)}`,
    );
  },
  warn(msg: string): void {
    emit(process.stderr, `${stamp()} ${c.warn(glyph.warn)} ${c.warn(msg)}`);
  },
  error(...args: any[]): void {
    const text = args
      .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
      .join(" ");
    emit(process.stderr, `${stamp()} ${c.error(glyph.error)} ${c.error(text)}`);
  },
  debug(msg: string): void {
    if (verbose)
      emit(process.stdout, `${stamp()} ${c.dim(glyph.debug)} ${c.dim(msg)}`);
  },

  /**
   * Begin a live, single-line stage indicator. Subsequent `info`/`warn`/etc.
   * lines scroll above it; the live line stays pinned to the bottom until
   * `succeed`/`fail`/`warn`/`stop` is called.
   */
  stage(
    title: string,
    opts?: { total?: number; detail?: string },
  ): StageHandle {
    // Only one live line at a time — retire any previous one.
    active?.stop();
    const sp = new Spinner(title, opts);
    active = sp;
    return {
      update: (d) => sp.update(d),
      step: (d) => sp.step(d),
      succeed: (s) => sp.succeed(s),
      fail: (s) => sp.fail(s),
      warn: (s) => sp.warn(s),
      stop: () => sp.stop(),
      onActivity: (d) => sp.update(d),
    };
  },
};
