// promptfoo output transform: pull the JSON document out of the model's raw
// text so downstream assertions (is-json schema check, javascript) operate on
// clean JSON. The stage prompts demand "no markdown fence", but models
// occasionally wrap output anyway — this makes the eval robust to that without
// being lenient about the actual JSON shape (the schema assertion still runs).
module.exports = (output) => {
  const s = String(output).trim();
  // Strip a leading/trailing ```json ... ``` fence if present.
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenced ? fenced[1] : s;
  const i = body.indexOf("{");
  const j = body.lastIndexOf("}");
  return i !== -1 && j > i ? body.slice(i, j + 1) : body;
};
