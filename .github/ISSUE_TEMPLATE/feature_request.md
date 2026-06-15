---
name: Feature request
about: Suggest an improvement to the audit pipeline
title: "[feat] "
labels: enhancement
assignees: ''
---

**What problem does this solve?**
A clear and concise description of the gap. Ex. "Recon over-scopes tasks on
monorepos and burns budget on vendored code."

**Proposed solution**
What you'd like to happen. If it touches a specific stage, say which
(recon / hunt / validate / gapfill / dedupe / trace / feedback / report) and
whether it affects the prompt (`prompts/`), schema (`schemas/`), stage config
(`config/stages.yaml`), or the orchestrator.

**Area**
- [ ] New attack-class coverage / prompt tuning
- [ ] Schema change
- [ ] Cost / concurrency / budget controls
- [ ] Auth / model / gateway support
- [ ] Live-target reproduction
- [ ] Output / reporting format
- [ ] Developer experience (CLI, library API, docs)
- [ ] Other

**Alternatives considered**
Any other approaches you weighed.

**Additional context**
Links, references (e.g. a CWE, a paper, a framework idiom), or examples.
