import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  process.stdout.write(
    "CLI agent contract smoke tests passed without generation calls.\n",
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
