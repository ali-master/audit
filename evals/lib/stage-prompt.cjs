// Shared promptfoo prompt function for audit pipeline stages.
//
// Keeps a single source of truth: the real stage instructions live in
// prompts/<stage>.md and are loaded verbatim as the system message. The test
// case supplies the stage's JSON input via the `input` var; we render it as the
// user turn. This means the eval exercises the EXACT prompt that ships.
//
// Config wires it up with:
//   prompts:
//     - file://../lib/stage-prompt.js
//   defaultTest:
//     vars:
//       stageFile: prompts/05-dedupe.md   # repo-root-relative
//
// Returns a JSON-encoded chat array so promptfoo routes system/user correctly
// to the anthropic:messages provider.

const fs = require("node:fs");
const path = require("node:path");

// Repo root = two levels up from evals/lib, so resolution is cwd-independent.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

module.exports = async function stagePrompt({ vars }) {
  const stageFile = vars.stageFile;
  if (!stageFile) {
    throw new Error(
      "stage-prompt.js: missing `stageFile` var (e.g. prompts/05-dedupe.md)",
    );
  }
  const abs = path.isAbsolute(stageFile)
    ? stageFile
    : path.join(REPO_ROOT, stageFile);
  const instructions = fs.readFileSync(abs, "utf8");

  const input =
    typeof vars.input === "string"
      ? vars.input
      : JSON.stringify(vars.input, null, 2);

  return JSON.stringify([
    { role: "system", content: instructions },
    {
      role: "user",
      content:
        `Here is your input JSON. Follow the instructions above and return ` +
        `ONLY the output JSON document (no prose, no markdown fence).\n\n` +
        `\`\`\`json\n${input}\n\`\`\``,
    },
  ]);
};
