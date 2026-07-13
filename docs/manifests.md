# Manifests

Manifests are strict YAML or JSON with `version: 1` and a non-empty `jobs`
array. Extra fields are rejected.

```yaml
version: 1
concurrency: 2
budget:
  maxCalls: 4
  maxCostUsd: 1
  isUnpricedCallsAllowed: false
capabilities:
  fal:
    fal-ai/example-image:
      kinds: [image]
      outputFormats: [png]
jobs:
  - id: geometric-study
    kind: image
    provider: fal
    model: fal-ai/example-image
    promptFile: prompts/geometric-study.txt
    input:
      image_size: square
    variants: 2
    output:
      stem: geometric-study
      format: png
    post:
      - type: image-convert
        format: png
    qa:
      image:
        minWidth: 512
        minHeight: 512
        isAlphaRequired: false
        isDuplicateAllowed: false
```

## Jobs

Each job requires:

- `id`: safe local identifier.
- `kind`: `image` or `audio`.
- `provider` and `model`: must match a configured runtime provider and model
  capability.
- exactly one of `prompt` or a safe relative `promptFile`.
- `input`: provider-specific JSON values. Sensitive field names, secrets, and
  absolute local paths are rejected.
- `output.stem` and `output.format`.

`variants` is either a positive count or an array of `{ id, input }`. Variant
input shallowly overrides job input. The planner expands variants into stable
candidate IDs such as `geometric-study.1`.

Post steps are ordered. v0 supports `image-convert` with format, quality, and
background options, and `audio-convert` with format, sample rate, and channel
options.

## Capabilities and pricing

The CLI reads `capabilities.fal` to initialize its provider registry. Library
users can supply the same registry directly to `createFalProvider`. A priced
model adds:

```yaml
price:
  amountUsd: 0.01
  unit: call
  source: https://example.invalid/provider-pricing-record
  retrievedAt: 2026-01-01T00:00:00.000Z
```

That value is an illustrative schema example, not a fal.ai price. Maintain a
private, current capability source for real execution. No fal price table is
baked into this repository.

## QA profiles

Image gates can set minimum dimensions, alpha required, and duplicate allowed.
Audio gates can set minimum duration and maximum peak dBFS, clipped-sample
ratio, tail-energy ratio, and seam delta. Audit reports measurements even when
no threshold is configured. These are technical checks, not judgments of
meaning, aesthetics, usefulness, or semantic quality.
