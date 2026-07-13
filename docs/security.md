# Security model

fal-tools treats manifests, provider responses, and media files as untrusted
inputs.

## Data minimization

- Credentials come only from `FAL_KEY` at request time.
- Prompt text is read at runtime and represented by SHA-256 in plans and
  ledgers.
- Provider URLs, request IDs, headers, logs, and response bodies are discarded.
- Structured logging uses allowlisted event fields and redacts error text.
- Run ledgers use relative candidate paths and objective metadata only.
- Package tarballs include compiled code and legal files through explicit
  `files` allowlists.

## Filesystem boundaries

Manifest paths reject absolute POSIX, Windows, UNC, home-relative, and `file:`
paths. Existing inputs are checked after realpath resolution to prevent symlink
escape. Export checks destination parents after directory creation and refuses
overwrites, path collisions, and `.git` destinations.

Run candidates and cache entries live under `.fal-tools` in the requested run
directory. They are local working data, not repository or package content. `run`
has no export behavior.

## Execution boundaries

Every provider attempt, including a retry, consumes the hard call counter and
configured per-call budget. Concurrency is bounded. Unpriced calls fail closed
unless the caller explicitly opts in. Media downloads and tool output are
bounded.

Audio commands invoke fixed `ffmpeg` and `ffprobe` argument arrays without a
shell. User data cannot provide executable names, switches, or filter
expressions. No binary is downloaded or bundled.

## Local checks

The pre-commit hook inspects staged paths and content for secrets, machine
paths, forbidden names, binaries, and large files. CI repeats whole-repository
checks and adds gitleaks, TruffleHog, dependency review, and packed-tarball
inspection. Hooks are defense in depth and do not replace review or server-side
push protection.
