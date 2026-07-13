# Security policy

## Reporting

Please report suspected vulnerabilities through GitHub private vulnerability
reporting. Do not open a public issue containing credentials, signed URLs,
private prompts, provider responses, generated assets, or personal data.

Security fixes are supported for the latest published minor release.

## Credential handling

`FAL_KEY` is read only when a fal request begins. It is not accepted in
manifests or provider configuration, and it is excluded from plans, cache keys,
ledgers, and logs. `.env` files are ignored; `.env.example` contains no value.

Do not attach `run.json` without reviewing it. The ledger is deliberately
allowlisted, but local policy may classify model names, hashes, or measurements
as sensitive.

## Repository controls

Maintainers should enable GitHub secret scanning, push protection, private
vulnerability reporting, branch protection, required CI checks, signed release
tags, and npm trusted publishing. Fork CI does not require repository secrets
and never calls fal.ai.

The repository CI runs gitleaks, verified-only TruffleHog, dependency review on
pull requests, package-content inspection, and local leak guards. Tool outages
must not be bypassed for a release; rerun the check or verify the equivalent
scanner output before publishing.

## Scope boundaries

This project does not provide hosted services, authentication flows, telemetry,
daemons, or cloud artifact storage. `ffmpeg` and `ffprobe` are external
executables discovered on `PATH`. `sharp` is optional and its binary/libvips
license material must remain present in an installation.
