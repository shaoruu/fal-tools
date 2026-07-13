import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "fal-tools-smoke-"),
);
try {
  const manifestPath = path.join(temporaryDirectory, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      capabilities: {
        fal: {
          "fal-ai/example-image": {
            kinds: ["image"],
            outputFormats: ["png"],
          },
        },
      },
      jobs: [
        {
          id: "sample",
          input: {},
          kind: "image",
          model: "fal-ai/example-image",
          output: { format: "png", stem: "sample" },
          prompt: "A geometric paper shape on a plain background",
          provider: "fal",
        },
      ],
      version: 1,
    }),
    { mode: 0o600 },
  );
  const output = execFileSync(
    process.execPath,
    ["packages/cli/dist/cli.js", "plan", manifestPath, "--json"],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  const plan = JSON.parse(output);
  if (
    plan.isSuccess !== true ||
    plan.command !== "plan" ||
    plan.result?.callCount !== 1 ||
    plan.result?.isPricingUnknown !== true
  ) {
    throw new Error("CLI smoke plan did not match the expected result");
  }
  const models = JSON.parse(
    execFileSync(
      process.execPath,
      ["packages/cli/dist/cli.js", "models", manifestPath, "--json"],
      { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
    ),
  );
  if (
    models.isSuccess !== true ||
    models.command !== "models" ||
    models.result?.models?.length !== 1
  ) {
    throw new Error("CLI model discovery did not return the registry");
  }
  const usage = spawnSync(
    process.execPath,
    ["packages/cli/dist/cli.js", "run", manifestPath, "--json"],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  const usageError = JSON.parse(usage.stderr);
  if (
    usage.status !== 2 ||
    usageError.isSuccess !== false ||
    usageError.error?.code !== "CLI_USAGE"
  ) {
    throw new Error("CLI usage errors did not use the stable machine contract");
  }
  const failedRun = spawnSync(
    process.execPath,
    [
      "packages/cli/dist/cli.js",
      "run",
      manifestPath,
      "--out",
      path.join(temporaryDirectory, "run"),
      "--max-calls",
      "1",
      "--jsonl",
    ],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  const failedRunLines = failedRun.stdout.trim().split("\n");
  const failedRunResult = JSON.parse(failedRunLines.at(-1));
  if (
    failedRun.status !== 3 ||
    failedRun.stderr !== "" ||
    failedRunResult.type !== "result" ||
    failedRunResult.isSuccess !== false ||
    failedRunResult.error?.code !== "PRICING_REQUIRED"
  ) {
    throw new Error(
      "CLI JSONL failures did not terminate with a result record",
    );
  }
  const missingManifest = spawnSync(
    process.execPath,
    [
      "packages/cli/dist/cli.js",
      "plan",
      path.join(temporaryDirectory, "missing.json"),
      "--json",
    ],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  const missingManifestError = JSON.parse(missingManifest.stderr);
  if (
    missingManifest.status !== 2 ||
    missingManifestError.error?.code !== "INPUT_REJECTED" ||
    missingManifest.stderr.includes(temporaryDirectory)
  ) {
    throw new Error(
      "CLI errors did not redact private paths deterministically",
    );
  }
  const malformedPath = path.join(temporaryDirectory, "malformed.json");
  await writeFile(malformedPath, "{", { mode: 0o600 });
  const malformed = spawnSync(
    process.execPath,
    ["packages/cli/dist/cli.js", "plan", malformedPath, "--json"],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  if (
    malformed.status !== 2 ||
    JSON.parse(malformed.stderr).error?.code !== "MANIFEST_INVALID"
  ) {
    throw new Error("Malformed manifests did not use the input exit category");
  }
  const malformedRunDirectory = path.join(temporaryDirectory, "malformed-run");
  await mkdir(malformedRunDirectory);
  const malformedRunPath = path.join(malformedRunDirectory, "run.json");
  await writeFile(malformedRunPath, "{", { mode: 0o600 });
  const malformedAudit = spawnSync(
    process.execPath,
    ["packages/cli/dist/cli.js", "audit", malformedRunPath, "--json"],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  if (
    malformedAudit.status !== 5 ||
    JSON.parse(malformedAudit.stderr).error?.code !== "AUDIT_LEDGER_INVALID"
  ) {
    throw new Error("Malformed audit ledgers did not use the QA exit category");
  }
  const malformedExport = spawnSync(
    process.execPath,
    [
      "packages/cli/dist/cli.js",
      "export",
      path.resolve("examples/selection.yaml"),
      "--from",
      malformedRunDirectory,
      "--to",
      path.join(temporaryDirectory, "export"),
      "--json",
    ],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  if (
    malformedExport.status !== 6 ||
    JSON.parse(malformedExport.stderr).error?.code !== "EXPORT_LEDGER_INVALID"
  ) {
    throw new Error(
      "Malformed export ledgers did not use the export exit category",
    );
  }
  const help = execFileSync(
    process.execPath,
    ["packages/cli/dist/cli.js", "--help"],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  if (
    !help.includes("Machine exit codes") ||
    !help.includes("Agent workflow")
  ) {
    throw new Error("CLI help omitted the agent workflow contract");
  }
  const bare = spawnSync(process.execPath, ["packages/cli/dist/cli.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  });
  if (bare.status !== 0 || !bare.stdout.includes("Usage: fal-tools")) {
    throw new Error("Bare CLI invocation did not provide help");
  }
  process.stdout.write(
    "CLI agent contract smoke tests passed without generation calls.\n",
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
