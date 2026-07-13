# Autonomous agent workflow

`fal-tools` is designed for coding and creative agents operating without a
terminal UI. Every command is one-shot and non-interactive. No command starts a
daemon, opens a login flow, watches files, or asks for confirmation.

## Stable machine contract

Use `--json` when a command has one result:

```json
{
  "command": "plan",
  "isSuccess": true,
  "result": {},
  "schemaVersion": 1
}
```

`run --jsonl` emits zero or more redacted log records followed by exactly one
result record. Each record occupies one line and has `schemaVersion: 1`.
`--json` suppresses progress logs so stdout remains one valid JSON document.

Machine errors are written to stderr:

```json
{
  "command": "run",
  "error": {
    "code": "BUDGET_EXCEEDED",
    "hint": "Raise the explicit hard ceiling or reduce the planned call graph.",
    "message": "planned calls exceed the hard max-calls budget"
  },
  "isSuccess": false,
  "schemaVersion": 1
}
```

Exit codes are stable for v0:

| Code | Meaning                                                           |
| ---: | ----------------------------------------------------------------- |
|    0 | Command completed and all required gates passed                   |
|    1 | General command failure                                           |
|    2 | Usage, manifest, path, secret, collision, or capability rejection |
|    3 | Pricing or hard-budget rejection                                  |
|    4 | Generation/run failure                                            |
|    5 | Objective QA gate failure                                         |
|    6 | Selection/export rejection                                        |
|    7 | Resume mismatch or active run lock                                |

## End-to-end sequence

An agent should keep private material under an ignored `.fal-tools` directory:

```sh
mkdir -p .fal-tools/private
cp examples/image.yaml .fal-tools/private/manifest.yaml
```

Before execution, replace the invented model entry with a reviewed fal.ai model,
supported formats, and current private pricing provenance. Never place a key in
the manifest; provide `FAL_KEY` only through the execution environment.

Discover the exact configured registry without contacting fal.ai:

```sh
fal-tools models .fal-tools/private/manifest.yaml --json
```

Dry-run the immutable graph. The agent should require `isSuccess: true`, inspect
`result.callCount`, and stop if `result.isPricingUnknown` is true unless its
task policy explicitly permits unpriced calls.

```sh
fal-tools plan .fal-tools/private/manifest.yaml --json
```

Execute with explicit ceilings. The call and known-cost counters are reserved
before submission, persisted in `run.json`, and retained across resume.

```sh
fal-tools run .fal-tools/private/manifest.yaml \
  --out .fal-tools/run-001 \
  --max-calls 2 \
  --max-cost 1 \
  --jsonl
```

If execution is interrupted, issue the same command with `--resume`. Do not
change the manifest, run directory, or ceilings.

Audit objective technical gates:

```sh
fal-tools audit .fal-tools/run-001/run.json --json
```

Exit code 5 means the audit completed but at least one candidate failed. The
agent should inspect `result.candidates`, never reinterpret a failed technical
gate as semantic approval, and choose only candidate IDs with `isPassed: true`.

Create a private selection:

```yaml
version: 1
candidates:
  - id: geometric-study.1
    as: geometric-study.png
```

Export only that explicit selection:

```sh
fal-tools export .fal-tools/private/selection.yaml \
  --from .fal-tools/run-001 \
  --to .fal-tools/exported \
  --json
```

Run workspaces and exports stay ignored by default. Moving an exported file into
a separate project is a deliberate downstream action outside `fal-tools`.
