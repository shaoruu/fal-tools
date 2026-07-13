# Architecture

The dependency graph points inward:

```text
cli -> provider-fal, image, audio, core
provider-fal -> core
image -> core
audio -> core
core -> no workspace package
```

`core` owns schemas, immutable call plans, budgets, retries, cache/resume,
ledgers, QA gating, and export policy. `provider-fal` is the only package that
uses `@fal-ai/client` or reads `FAL_KEY`. `image` and `audio` implement local,
objective media operations. The CLI composes those packages.

## Lifecycle

1. `plan` parses a closed manifest, reads prompt and QA files beneath the
   manifest directory, validates model capabilities and configured prices,
   hashes prompts, expands variants into exact call IDs, and detects
   case-insensitive output collisions.
2. `run` recreates that plan, enforces call and cost ceilings, executes with
   bounded concurrency, retries only failures explicitly marked transient,
   processes bytes locally, and writes a content-addressed cache plus
   `run.json`.
3. `audit` verifies hashes and performs technical media measurements. It does
   not infer aesthetic, semantic, brand, or subjective quality.
4. `export` verifies selected candidate IDs, passing audits, content hashes,
   destination containment, and filename uniqueness before copying.

Plans never contain prompt text. Ledgers never contain prompt text, provider
request IDs, URLs, headers, response payloads, credentials, or absolute paths.
Candidate bytes live only under the ignored run work directory.

Cache entries are keyed by the model, provider, sanitized input, prompt hash,
variant, output format, and ordered post steps. Resume verifies artifact length
and SHA-256 before reuse. Failed or partial entries are not reused.
