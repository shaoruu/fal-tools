import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  if (plan.callCount !== 1 || plan.isPricingUnknown !== true) {
    throw new Error("CLI smoke plan did not match the expected result");
  }
  process.stdout.write(
    "CLI plan smoke test passed without generation calls.\n",
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
