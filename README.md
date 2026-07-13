# fal-tools

`fal-tools` is a fal.ai-specific, product-agnostic toolkit for planning,
generating, auditing, and explicitly exporting media assets. It is designed for
reviewable local runs: prompts remain runtime inputs, candidate binaries stay in
ignored work directories, and only selected candidates that pass objective QA
can be exported.

This initial public version supports Node.js 22 LTS, strict ESM, TypeScript, and
pnpm workspaces.

## Install

```sh
corepack enable
pnpm install
pnpm build
```

`sharp` is an optional image dependency. Audio operations require `ffmpeg` and
`ffprobe` on `PATH`; no media executable is bundled.

## CLI

```sh
fal-tools plan manifest.yaml [--json] [--allow-unpriced]
fal-tools run manifest.yaml --out ./workdir/run-001 --max-calls 8
fal-tools audit ./workdir/run-001/run.json
fal-tools export selection.yaml --from ./workdir/run-001 --to ./release
```

Each manifest directory needs a `fal-tools.config.yaml` model registry. Prices
come from that reviewed provider configuration and include a source and
timestamp. Missing prices are shown as `UNKNOWN`; planning and execution stop
unless `--allow-unpriced` is explicitly supplied.

No command makes a generation call during `plan`. `run` requires a hard call
limit, stores candidates under `.fal-tools/candidates`, and never exports.

## Library

```ts
import { createPipeline } from "@fal-tools/core";
import { createFalProvider } from "@fal-tools/provider-fal";

const fal = createFalProvider({ models });
const pipeline = createPipeline({
  providers: { fal },
  logger,
  clock,
  processors,
  inspectors,
});

const plan = await pipeline.plan("manifest.yaml");
```

See [architecture](docs/architecture.md), [manifest format](docs/manifests.md),
[provider setup](docs/providers.md), [security model](docs/security.md), and
[publishing](docs/publishing.md). The [`examples`](examples) directory contains
only synthetic text fixtures and no generated media.

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:smoke
pnpm pack:inspect
```

Licensed under Apache-2.0. Contributions use the Developer Certificate of
Origin; see [CONTRIBUTING.md](CONTRIBUTING.md).
