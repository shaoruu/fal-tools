# Publishing

Packages use explicit npm `files` allowlists and npm provenance. Publishing is
performed only by the release workflow from a reviewed tag.

Before tagging:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:smoke
pnpm pack:inspect
pnpm notices
pnpm sbom
```

Review every tarball listing and the generated SPDX-style notice report. The
SBOM and notices are release artifacts. Never add generated candidates or
private manifests to release artifacts.

The image package declares `sharp` as optional. npm may install platform
packages containing libvips. Those packages retain their own license files and
are represented in the SBOM and third-party report. Do not copy libvips into
fal-tools tarballs.

The audio package invokes system `ffmpeg` and `ffprobe`; neither executable nor
its libraries are npm package content. Operators are responsible for the license
terms of their chosen system distribution.

Maintainers must configure npm trusted publishing, a protected `release`
environment, required CI checks, GitHub secret scanning and push protection, and
signed tags. The workflow requests only `contents: read` and `id-token: write`
permissions for publication.
