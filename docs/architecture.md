# Architecture

## Package boundaries

- `@fal-tools/core` owns schemas, path and content safety, immutable call-graph
  planning, budgets, bounded execution, retries, local cache/resume, provenance,
  audit orchestration, and selected export.
- `@fal-tools/provider-fal` owns the current `@fal-ai/client` queue lifecycle,
  capability registry, transient error classification, and media download.
- `@fal-tools/image` owns sharp-based image conversion and objective image
  measurements.
- `@fal-tools/audio` owns external ffmpeg/ffprobe invocation and objective audio
  measurements.
- `fal-tools` composes those packages into the CLI and re-exports the public
  library surface.

Core depends on provider, processor, auditor, logger, and clock interfaces. This
keeps generation policy testable with a fake provider and avoids importing
native media dependencies into consumers that do not need them.

## Data flow

1. `plan` parses a strict YAML/JSON manifest, rejects unsafe content, hashes the
   prompt, validates registered model capabilities and output names, expands
   variants, and produces a deterministic plan hash. It makes no provider call.
2. `run` repeats planning, checks hard call/cost ceilings before work, and
   executes the immutable calls under bounded concurrency. Provider output is
   processed into a local cache and materialized in the candidate directory.
   Attempt/cost reservations are persisted before submission and survive resume.
3. `audit` verifies candidate hashes before invoking an objective kind-specific
   auditor. Results are added to `run.json`.
4. `export` verifies the ledger, required QA pass, source hash, explicit
   candidate ID, safe relative destination, and no-overwrite behavior.

Plans and ledgers intentionally omit prompt text, provider response bodies,
headers, download URLs, credentials, and absolute paths.

## Candidate lifecycle

A run directory has this local-only convention:

```text
run-directory/
  plan.json
  run.json
  candidates/
  .fal-tools/cache/
```

Candidates are reviewable local artifacts, not package or repository content.
The request index key covers provider/model, kind, validated input, prompt
digest, variant, pricing snapshot, provider/output formats, and ordered post
steps. Media blobs are stored by their content hash, and cache indexes are
verified before reuse. Resume requires the same stored plan and verifies
completed candidate hashes. A separate selection document is required to export.

## Non-goals

v0 has no hosted service, authentication flow, daemon, watch mode, UI, cloud
store, telemetry, product preset, semantic-quality scoring, or bundled model
weights. It does not bundle FFmpeg.
