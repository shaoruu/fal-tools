# fal-tools

`fal-tools` is a private-first, product-agnostic toolkit for manifest-driven
fal.ai media generation. It plans an exact call graph before spending, executes
within hard budgets, records prompt hashes instead of prompt text, performs
objective media checks, and exports only explicit QA-passing selections.

This repository is an initial v0. The interfaces are intentionally small and may
change before a public release.

## Requirements

- Node.js 22 or newer
- pnpm 11
- `ffmpeg` and `ffprobe` on `PATH` for audio processing and auditing
- `FAL_KEY` in the runtime environment only when executing fal.ai calls

FFmpeg is never bundled. Image support installs `sharp` and its separately
licensed native dependencies.

## Commands

```sh
pnpm install
pnpm build

pnpm fal-tools plan examples/image.yaml
pnpm fal-tools plan examples/image.yaml --json
pnpm fal-tools run path/to/private-manifest.yaml --out .fal-tools/run-001 --max-calls 4 --max-cost 1
pnpm fal-tools audit .fal-tools/run-001/run.json --profile examples/qa-image.yaml
pnpm fal-tools export examples/selection.yaml --from .fal-tools/run-001 --to path/to/destination
```

Run directories are candidate workspaces, not product export destinations. They
contain `plan.json`, `run.json`, ignored candidates, and an ignored local cache.
Export is a separate, explicit operation.

## Library

```ts
import { createPipeline } from "@fal-tools/core";
import { createFalProvider } from "@fal-tools/provider-fal";

const fal = createFalProvider({ capabilities });
const pipeline = createPipeline({
  providers: { fal },
  logger,
  clock,
});

const plan = await pipeline.plan({ manifestPath });
const ledger = await pipeline.run({
  manifestPath,
  maxCalls: 4,
  maxCostUsd: 1,
  outDir: ".fal-tools/run-001",
});
```

Callers can supply the image/audio processors and auditors from
`@fal-tools/image` and `@fal-tools/audio`. The CLI wires them by default.

## Safety defaults

- Absolute paths, parent traversal, sensitive field names, and secret-like
  values are rejected.
- Pricing must come from a configured capability registry with a source and
  retrieval timestamp. Missing pricing is displayed as `UNKNOWN`; execution
  fails unless the manifest or library caller explicitly allows unpriced calls.
- Prompt content exists only in memory during planning/execution. Plans and
  ledgers retain SHA-256 digests.
- Provider responses, headers, signed URLs, and prompt text are excluded from
  logs and provenance.
- Only transient provider failures are retried, at most three attempts.
- No generated binary belongs in the repository or npm package.

See [architecture](docs/architecture.md), [manifest format](docs/manifests.md),
[provider integration](docs/providers.md), [security model](docs/security.md),
and [publishing](docs/publishing.md).

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:smoke
pnpm pack:inspect
```

Install the repository hook with `git config core.hooksPath .githooks` when no
existing hook manager is in use. If one is already configured, invoke
`.githooks/pre-commit` from that manager.

Licensed under Apache-2.0.
