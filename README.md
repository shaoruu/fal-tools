# fal-tools

Give this repo to your agent, set `FAL_KEY`, and tell it what assets you need.

`fal-tools` gives coding and creative agents a safe loop for fal.ai: plan first,
generate under a hard budget, run objective checks, select exact candidate IDs,
then export only approved assets.

## Start here

Requires Node.js 22+ and pnpm 11. Provide `FAL_KEY` through your shell or agent
secret store, never in a prompt or manifest.

```sh
corepack enable
pnpm install
pnpm build
test -n "$FAL_KEY"
```

Then give your agent this prompt:

```text
Use the fal-tools repo to generate a batch of four 1024×1024 editorial images
for: "geometric paper sculptures on warm neutral backgrounds."

Work only under .fal-tools/. Create a private v1 manifest using a current fal.ai
image model, its supported output format, and reviewed pricing with source and
retrieval timestamp.

First run `pnpm fal-tools models <manifest> --json` and
`pnpm fal-tools plan <manifest> --json`. Do not generate unless planning
succeeds, pricing is known, the call count is at most 4, and estimated cost is
at most $1.

Then run with `--max-calls 4 --max-cost 1 --jsonl`, audit the completed run,
inspect the objective checks, and create a selection file containing only
candidate IDs that passed. Export that explicit selection to
.fal-tools/exported with `--json`.

Never print or persist FAL_KEY, prompt text, signed URLs, provider responses, or
headers. Do not copy candidates or generated outputs into the repo.
```

No command prompts, opens a UI, starts a daemon, or watches files.

## The agent workflow

Assume the agent created `.fal-tools/private/image-batch.yaml` with a current,
reviewed fal model and pricing entry.

1. Discover exactly what the private manifest allows:

   ```sh
   pnpm fal-tools models .fal-tools/private/image-batch.yaml --json
   ```

2. Dry-run the immutable call graph. This makes zero generation calls:

   ```sh
   pnpm fal-tools plan .fal-tools/private/image-batch.yaml --json
   ```

   The agent checks `result.callCount`, `result.estimatedCostUsd`, and
   `result.isPricingUnknown` before continuing.

3. Generate into an ignored candidate workspace with hard lifetime ceilings:

   ```sh
   pnpm fal-tools run .fal-tools/private/image-batch.yaml \
     --out .fal-tools/run-001 \
     --max-calls 4 \
     --max-cost 1 \
     --jsonl
   ```

   If interrupted, the agent can repeat the exact command with `--resume`.
   Resume requires the original manifest, ledger, stored plan, and ceilings.

4. Audit objective technical properties:

   ```sh
   pnpm fal-tools audit .fal-tools/run-001/run.json --json
   ```

   Image checks cover dimensions, alpha, bounding box, and duplicate hashes.
   Audio checks cover decode, duration, peak, clipping, tail, seam, and
   quarter-energy measurements. These checks do not claim semantic quality.

5. After reviewing the audit result, the agent writes an explicit private
   selection:

   ```yaml
   version: 1
   candidates:
     - id: editorial-paper.1
       as: editorial-paper-primary.png
     - id: editorial-paper.3
       as: editorial-paper-alternate.png
   ```

6. Export only those passing candidate IDs:

   ```sh
   pnpm fal-tools export .fal-tools/private/selection.yaml \
     --from .fal-tools/run-001 \
     --to .fal-tools/exported \
     --json
   ```

Run directories remain candidate workspaces; generation never exports directly
to a product tree. Moving approved exports elsewhere is a separate downstream
action.

## Built for autonomous use

- `--json` emits one versioned result document.
- `run --jsonl` emits redacted events followed by one stdout result record on
  success or failure.
- Structured failures include stable codes, actionable hints, and deterministic
  exit categories.
- Calls and known cost are reserved before submission and persist across resume.
- Pricing must include a source and retrieval timestamp. Unpriced execution
  fails closed unless explicitly allowed.
- Absolute paths, traversal, secret-like content, unsafe symlinks, corrupt
  ledgers, and changed plans are rejected.
- Prompts are persisted as SHA-256 digests, not text.
- Generated binaries, private manifests, caches, candidates, and outputs are
  ignored repository content.

See the full [autonomous agent workflow](docs/agents.md).

## Examples and deeper docs

The committed [image](examples/image.yaml) and [audio](examples/audio.yaml)
manifests use invented model names and prompts. They are safe schema examples,
not executable model recommendations or a stale price table.

- [Manifest and QA format](docs/manifests.md)
- [Provider and pricing behavior](docs/providers.md)
- [Architecture and candidate lifecycle](docs/architecture.md)
- [Security model](docs/security.md)
- [Publishing checklist](docs/publishing.md)
- [Security reporting](SECURITY.md)

Audio processing and audit require user-installed `ffmpeg` and `ffprobe` on
`PATH`; fal-tools never bundles FFmpeg. Image support uses the separately
licensed `sharp` and libvips dependencies described in [NOTICE](NOTICE).

## Library API

```ts
import { createPipeline } from "@fal-tools/core";
import { createFalProvider } from "@fal-tools/provider-fal";

const fal = createFalProvider({ capabilities });
const pipeline = createPipeline({ providers: { fal }, logger, clock });

const plan = await pipeline.plan({ manifestPath });
const ledger = await pipeline.run({
  manifestPath,
  maxCalls: 4,
  maxCostUsd: 1,
  outDir: ".fal-tools/run-001",
});
```

Add image/audio processors and auditors from `@fal-tools/image` and
`@fal-tools/audio`; the CLI wires them by default.

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:smoke
pnpm pack:inspect
```

Licensed under Apache-2.0.
