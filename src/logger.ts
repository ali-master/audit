/**
 * Tiny leveled logger. Emits
 * timestamped lines on stderr, with `debug` gated behind a
 * verbose flag. Kept dependency-light — just chalk for colour.
 */

import chalk from "chalk";

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

function formatMessage(...args: any[]): string {
  return args
    .map((arg) =>
      typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg),
    )
    .join(" ");
}

function stamp(): string {
  return chalk.dim(`[${new Date().toLocaleTimeString()}]`);
}

export const log = {
  info(msg: string): void {
    console.error(`${stamp()} ${msg}`);
  },
  warn(msg: string): void {
    console.error(`${stamp()} ${chalk.yellow(msg)}`);
  },
  error(...args: any[]): void {
    console.error(
      `${stamp()} ${chalk.red(args[0])}`,
      chalk.red(formatMessage(...args)),
    );
  },
  debug(msg: string): void {
    if (verbose) console.error(`${stamp()} ${chalk.dim(msg)}`);
  },
};
