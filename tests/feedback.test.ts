/** Feedback no-retest floor: never re-target an already-proven file. */

import { describe, expect, test } from "bun:test";
import { partitionRetests } from "../src/stages/feedback";

const proven = new Set(["services/import.py", "services/exporter.py"]);

const siblingTask = {
  task_id: "t_fb_1",
  attack_class: "zip_slip",
  target_files: ["services/backup.py"],
};
const retestTask = {
  task_id: "t_fb_2",
  attack_class: "zip_slip",
  target_files: ["services/import.py"], // the proven sink itself
};
const sweepTask = {
  task_id: "t_fb_3",
  attack_class: "command_injection",
  // bundles a proven file alongside a genuinely new one — still a re-test
  target_files: ["services/media.py", "services/exporter.py"],
};

describe("partitionRetests", () => {
  test("keeps a task that targets only new sibling files", () => {
    const { kept, dropped } = partitionRetests([siblingTask], proven);
    expect(kept.map((t) => t.task_id)).toEqual(["t_fb_1"]);
    expect(dropped).toHaveLength(0);
  });

  test("drops a task that re-targets the proven sink", () => {
    const { kept, dropped } = partitionRetests([retestTask], proven);
    expect(kept).toHaveLength(0);
    expect(dropped[0].task.task_id).toBe("t_fb_2");
    expect(dropped[0].offending).toEqual(["services/import.py"]);
  });

  test("drops a sweep task even when it also adds a new file (offending is reported)", () => {
    const { kept, dropped } = partitionRetests([sweepTask], proven);
    expect(kept).toHaveLength(0);
    expect(dropped[0].offending).toEqual(["services/exporter.py"]);
  });

  test("partitions a mixed batch, preserving order within each side", () => {
    const { kept, dropped } = partitionRetests(
      [siblingTask, retestTask, sweepTask],
      proven,
    );
    expect(kept.map((t) => t.task_id)).toEqual(["t_fb_1"]);
    expect(dropped.map((d) => d.task.task_id)).toEqual(["t_fb_2", "t_fb_3"]);
  });

  test("a task with no target_files is harmless and kept", () => {
    const { kept, dropped } = partitionRetests(
      [{ task_id: "t_fb_4", attack_class: "ssrf" }],
      proven,
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  test("empty proven set keeps everything (first run, nothing proven yet)", () => {
    const { kept, dropped } = partitionRetests(
      [siblingTask, retestTask, sweepTask],
      new Set<string>(),
    );
    expect(kept).toHaveLength(3);
    expect(dropped).toHaveLength(0);
  });
});
