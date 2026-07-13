import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync("artifacts", { recursive: true });
execFileSync(
  "corepack",
  [
    "pnpm",
    "sbom",
    "--sbom-format",
    "cyclonedx",
    "--lockfile-only",
    "--out",
    "artifacts/sbom.cdx.json",
  ],
  { stdio: "inherit" },
);
