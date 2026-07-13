# Contributing

Use Node.js 22 LTS and the pnpm version pinned in `package.json`. Before opening
a change, run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:inspect
```

Tests must use the explicit fake provider and synthetic fixtures. Never use a
real fal.ai credential or make live generation calls in automated tests. Do not
commit generated candidates, private prompts, provider payloads, signed URLs, or
local paths.

All commits must include a Developer Certificate of Origin sign-off:

```text
Signed-off-by: Contributor Name <contributor@example.invalid>
```

By signing off, you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/).
