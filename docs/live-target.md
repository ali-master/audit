# Live-target reproduction

If the target has a running deployment, point the agents at it. Findings are
then confirmed against the live service instead of (or in addition to) static
analysis. This is **opt-in** — without `--target-url`, the pipeline is fully
static.

```bash
cd /path/to/target
audit run --run-id live \
  --max-concurrency 1 --max-cost-usd 30 \
  --target-url http://server.local:8888 \
  --target-creds email=admin@system.com \
  --target-creds password=changechangeme
```

## What changes when `--target-url` is set

| Stage | Behavior with a live target |
|-------|-----------------------------|
| Recon | Biases the task queue toward attack classes that benefit from runtime confirmation |
| Hunt | **Reproduces** each finding against the live service (curl / HTTP). A finding that doesn't reproduce is dropped |
| Validate | **Rejects** findings that don't reproduce against the live target |
| Trace | **Confirms** reachability with real HTTP round-trips, not just static tracing |

## Credentials

Repeat `--target-creds KEY=VALUE` for each pair. They're passed to every
relevant stage as a `credentials` object inside the agent's input, so agents can
log in before reproducing:

```bash
--target-creds email=admin@system.com --target-creds password=...
```

`--target-creds` without `--target-url` is ignored (with a warning).

## Network rules the agents follow

- Egress is restricted to the target host and local loopback (`127.0.0.1`). No
  other external hosts.
- "No fabrication": a finding that doesn't reproduce live is dropped or rejected
  depending on the stage.

## Safety

The agents send real requests to the URL you provide. Only point this at
systems you are authorized to test, and prefer a disposable/staging deployment.
See the [main README's safety section](../README.md#safety).
