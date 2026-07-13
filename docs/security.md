# Security model

## Private-first data handling

Manifests and prompts should remain outside version control. `.gitignore`
excludes environment files, private manifests, run workspaces, raw assets,
candidates, generated files, outputs, and caches. Only small text or synthetic
fixtures are permitted.

The parser rejects:

- absolute POSIX, Windows, and file-URL paths;
- parent-directory traversal;
- secret-like values, bearer credentials, private keys, and signed URLs;
- sensitive input field names associated with credentials, prompts, headers,
  environment values, or response content;
- extra schema fields.

Inline prompts are allowed for sanitized examples and private local manifests.
Prompt files must be relative to the manifest and remain contained in its
directory. Plans and ledgers retain only SHA-256 prompt digests.

## Logging and provenance

The pipeline wraps every logger. Sensitive key names, credential-like text,
environment values, prompt data, response data, and URLs with query strings are
redacted. Provider failures are recorded with coarse error codes rather than
messages or payloads.

`plan.json` records the immutable call graph, capability-derived cost, prompt
digest, and plan digest. `run.json` records candidate-relative paths, content
hashes, optional provider request IDs, sizes, status, and objective audit
results. Neither file stores a local machine path.

## Local and CI controls

The committed pre-commit hook runs repository content checks, a binary and
100-KiB file guard, private-path checks, local-path checks, configurable
forbidden-name checks, Gitleaks when installed, and verified-only TruffleHog
when installed. Existing hook managers should invoke the committed hook rather
than replacing their hooks path.

CI repeats content checks and runs dedicated Gitleaks and verified-only
TruffleHog jobs. Packed tarballs are inspected against package `files`
allowlists. GitHub secret scanning and push protection still require manual
administrator enablement; see `SECURITY.md`.

## Media dependencies

Image processing is isolated in `@fal-tools/image`. It uses sharp, which is
Apache-2.0, and sharp uses separately distributed libvips under
LGPL-2.1-or-later. Release packages do not bundle either project into generated
JavaScript.

Audio processing invokes `ffmpeg` and `ffprobe` from `PATH`. Availability and
the license obligations of a locally installed FFmpeg build are the operator's
responsibility. `fal-tools` never downloads or bundles FFmpeg.
