# Security policy

## Reporting

Do not open a public issue for a suspected vulnerability or accidental
disclosure. Use GitHub's private vulnerability reporting feature for this
repository. Include affected versions, reproduction steps, impact, and a minimal
sanitized example. Never attach credentials, private prompts, generated customer
assets, signed URLs, or provider response payloads.

The maintainers will acknowledge a report, validate it against a clean
environment, and coordinate disclosure after a fix is available.

## Supported versions

Until the first stable release, only the latest commit on the default branch is
supported.

## Credential model

`fal-tools` reads fal.ai credentials through the current `@fal-ai/client`
runtime behavior. Credentials must come from the execution environment and must
never appear in manifests, command arguments, logs, provenance, fixtures, or
package contents. Use short-lived, least-privilege credentials where the
provider supports them.

Prompt text and provider responses are transient runtime data. Persisted plans
and ledgers contain prompt SHA-256 digests and sanitized request metadata only.

## Repository controls requiring manual enablement

Repository administrators must enable these GitHub settings:

1. Secret scanning for the entire history.
2. Push protection for contributors.
3. Private vulnerability reporting.
4. Dependabot security updates and dependency graph.
5. Branch protection requiring the CI, dependency review, Gitleaks,
   verified-only TruffleHog, and package inspection checks.
6. Signed or otherwise verified release provenance where supported.

Local and CI checks supplement these platform controls; they do not replace
them.
