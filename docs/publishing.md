# Publishing

Public release is intentionally disabled by process rather than by hidden code.
Before publishing:

1. Review every tracked file and the complete Git history for private names,
   paths, prompts, keys, customer data, generated assets, signed URLs, response
   content, and environment files.
2. Confirm GitHub secret scanning, push protection, dependency review, required
   checks, and private vulnerability reporting are enabled.
3. Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`,
   `pnpm test`, `pnpm build`, `pnpm test:smoke`, and `pnpm pack:inspect`.
4. Inspect every archive in `artifacts/packs` manually in addition to the
   automated allowlist.
5. Run Gitleaks over the full history and TruffleHog with verified findings
   only.
6. Generate `artifacts/sbom.cdx.json` with `pnpm sbom` and retain it with the
   release record.
7. Review `NOTICE`, package dependency licenses, sharp/libvips distribution, and
   the statement that FFmpeg is external.
8. Publish with npm provenance from the protected release workflow.

Every package has an explicit `files` allowlist. The package prepack step copies
the repository `LICENSE` and `NOTICE` into the package root. The inspection
script rejects content outside `dist`, package metadata, legal files, and the
package README.

The release workflow builds archives and an SBOM as reviewable artifacts. It
does not publish automatically; a maintainer must add a protected npm publish
job after completing the release review.
