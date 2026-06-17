# Scope notes

Targets often have intentionally-loose-by-design surfaces that aren't bugs —
plaintext API keys that are a feature, test-only endpoints, anonymous analytics
ingest. Put them in a text file and pass it in; the notes are appended verbatim
to **every** stage's input, and Recon / Hunt / Validate honor the exclusions.

```bash
cd /path/to/target
audit run --scope-notes target_scope.md
```

## Example `target_scope.md`

```markdown
- Mailpit (port 1025) is test-only; ignore.
- Plaintext API keys in the database are a required feature.
- Don't flag rate-limit absence on anonymous /ping endpoints.
- Only consider critical/high severity.
```

## How it's applied

- The file's contents are passed as `scope_notes` in each agent's input
  (alongside the live-target block, if any).
- **Recon** won't emit tasks against excluded components or attack classes.
- **Hunt** emits zero findings for an excluded class/region and explains in
  `gaps_observed`.
- **Validate** will **reject** a finding that falls under an exclusion, citing
  the scope rule.

Keep the notes short and specific. They're authoritative additional rules, so
over-broad exclusions will suppress real findings.
