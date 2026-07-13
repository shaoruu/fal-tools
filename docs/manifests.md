# Manifests

Manifests are closed YAML or JSON documents:

```yaml
version: 1
concurrency: 2
budget:
  maxCostUsd: 1
jobs:
  - id: sample-image
    kind: image
    provider: fal
    model: fal-ai/illustration-v0
    promptFile: prompts/shape.txt
    input:
      width: 512
      height: 512
    variants: 2
    output:
      stem: sample/shape
      format: png
    post:
      - type: resize
        width: 256
        height: 256
      - type: stripMetadata
    qa: qa/image.yaml
```

Exactly one of `prompt` and `promptFile` is required. Prompt files and QA files
must resolve beneath the manifest directory, including after symlink resolution.
The plan stores only `sha256:<digest>` for a prompt.

IDs use lowercase letters, digits, and hyphens. Variants expand
deterministically to IDs such as `sample-image.01`. Output files gain the same
zero-padded variant suffix.

Input is JSON data validated first by the repository schema and then by the
configured model schema. Secret-like keys, credentials, signed URLs, absolute
local paths, `file:` URLs, and an input-level `prompt` key are rejected.

Supported image post steps are `resize` and `stripMetadata`. Supported audio
steps are `trim` and `normalize`. Steps execute in manifest order. Output media
is always re-encoded locally, which removes source metadata.

QA profiles contain objective thresholds:

```yaml
version: 1
kind: image
checks:
  minWidth: 128
  minHeight: 128
  maxBboxPaddingRatio: 0.9
```

Image checks can include dimensions, alpha presence, and bounding-box padding.
Audio checks can include duration, peak, clipping ratio, tail-energy ratio, seam
delta, and quarter-energy ratio. Decode, content hash, and duplicate hash checks
always run.
