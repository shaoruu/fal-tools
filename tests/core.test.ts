import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  createPipeline,
  ProviderFailure,
  redactMessage,
  type AssetInspector,
  type AssetProcessor,
  type Clock,
  type GenerationProvider,
  type GenerationRequest,
  type JsonObject,
  type Logger,
  type ModelCapability,
} from "../packages/core/src/index.js";
import { FakeProvider } from "../packages/core/src/testing.js";

const inputSchema: z.ZodType<JsonObject> = z.record(z.string(), z.json());
const zeroPrice = {
  currency: "USD" as const,
  perCallMicros: 0,
  source: "synthetic fixture",
  timestamp: "2026-07-13T00:00:00.000Z",
};
const identityProcessor: AssetProcessor = {
  process(request) {
    return Promise.resolve(request.input);
  },
};
const passingInspector: AssetInspector = {
  inspect() {
    return Promise.resolve({
      checks: [{ id: "decode", passed: true }],
      measurements: { width: 1, height: 1 },
    });
  },
};
const logger: Logger = {
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};
const clock: Clock = {
  now: () => new Date("2026-07-13T00:00:00.000Z"),
  sleep: () => Promise.resolve(),
};

interface FixtureOptions {
  readonly budget?: number;
  readonly input?: JsonObject;
  readonly jobs?: readonly JsonObject[];
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly variants?: number;
}

async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "fal-tools-test-"));
  await writeFile(
    path.join(directory, "qa.json"),
    JSON.stringify({ version: 1, kind: "image", checks: {} }),
  );
  if (
    options.promptFile !== undefined &&
    !path.isAbsolute(options.promptFile)
  ) {
    await writeFile(
      path.join(directory, options.promptFile),
      options.prompt ?? "synthetic prompt",
    );
  }
  const defaultJob: JsonObject = {
    id: "fixture",
    kind: "image",
    provider: "fake",
    model: "fixture/model",
    ...(options.promptFile === undefined
      ? { prompt: options.prompt ?? "synthetic prompt" }
      : { promptFile: options.promptFile }),
    input: options.input ?? {},
    variants: options.variants ?? 1,
    output: { stem: "fixture", format: "png" },
    post: [],
    qa: "qa.json",
  };
  const manifest: JsonObject = {
    version: 1,
    concurrency: 2,
    ...(options.budget === undefined
      ? {}
      : { budget: { maxCostUsd: options.budget } }),
    jobs: options.jobs ?? [defaultJob],
  };
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { directory, manifestPath };
}

function pipeline(provider: GenerationProvider, inspector = passingInspector) {
  return createPipeline({
    providers: { fake: provider },
    processors: { image: identityProcessor },
    inspectors: { image: inspector },
    logger,
    clock,
  });
}

describe("planning safety", () => {
  it("fails closed when configured cost exceeds the manifest budget", async () => {
    const files = await fixture({ budget: 1 });
    const provider = new FakeProvider({
      pricing: { ...zeroPrice, perCallMicros: 2_000_000 },
    });
    await expect(pipeline(provider).plan(files.manifestPath)).rejects.toThrow(
      "budget",
    );
    expect(provider.calls).toHaveLength(0);
  });

  it("requires explicit opt-in for unpriced calls", async () => {
    const files = await fixture();
    const provider = new FakeProvider();
    await expect(pipeline(provider).plan(files.manifestPath)).rejects.toThrow(
      "UNKNOWN",
    );
    const plan = await pipeline(provider).plan(files.manifestPath, {
      isAllowUnpriced: true,
    });
    expect(plan.estimatedCostMicros).toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });

  it("hashes prompt text without placing it in the plan", async () => {
    const prompt = "invented private runtime wording";
    const files = await fixture({
      prompt,
      promptFile: "prompt.txt",
    });
    const plan = await pipeline(new FakeProvider({ pricing: zeroPrice })).plan(
      files.manifestPath,
    );
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(prompt);
    expect(plan.calls[0]?.promptHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      redactMessage(
        [
          "Bearer abcdefghijklmnop at https:",
          "//example.invalid/file?",
          "to",
          "ken=value",
        ].join(""),
      ),
    ).not.toContain("abcdefghijklmnop");
  });

  it("rejects absolute paths and secret fields", async () => {
    const absolute = await fixture({ promptFile: "/tmp/prompt.txt" });
    await expect(
      pipeline(new FakeProvider({ pricing: zeroPrice })).plan(
        absolute.manifestPath,
      ),
    ).rejects.toThrow("relative path");

    const secret = await fixture({
      input: { api_key: "x" },
    });
    await expect(
      pipeline(new FakeProvider({ pricing: zeroPrice })).plan(
        secret.manifestPath,
      ),
    ).rejects.toThrow("not allowed");
  });

  it("expands an immutable graph and rejects output collisions", async () => {
    const first: JsonObject = {
      id: "first",
      kind: "image",
      provider: "fake",
      model: "fixture/model",
      prompt: "first synthetic prompt",
      input: {},
      variants: 1,
      output: { stem: "same", format: "png" },
      post: [],
      qa: "qa.json",
    };
    const second: JsonObject = {
      ...first,
      id: "second",
      prompt: "second synthetic prompt",
    };
    const files = await fixture({ jobs: [first, second] });
    await expect(
      pipeline(new FakeProvider({ pricing: zeroPrice })).plan(
        files.manifestPath,
      ),
    ).rejects.toThrow("collision");
  });
});

describe("execution", () => {
  it("refuses a call before dispatch when the command budget is exhausted", async () => {
    const files = await fixture();
    const provider = new FakeProvider({
      pricing: { ...zeroPrice, perCallMicros: 500_000 },
    });
    const ledger = await pipeline(provider).run(files.manifestPath, {
      outDirectory: path.join(files.directory, "budgeted"),
      maxCalls: 1,
      maxCostUsd: 0.1,
    });
    expect(provider.calls).toHaveLength(0);
    expect(ledger.failures[0]?.message).toContain("budget");
  });

  it("resumes from verified content-addressed cache", async () => {
    const files = await fixture();
    const provider = new FakeProvider({ pricing: zeroPrice });
    const runDirectory = path.join(files.directory, "run");
    const first = await pipeline(provider).run(files.manifestPath, {
      outDirectory: runDirectory,
      maxCalls: 1,
    });
    expect(first.candidates).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);

    const resumed = await pipeline(provider).run(files.manifestPath, {
      outDirectory: runDirectory,
      maxCalls: 1,
      isResume: true,
    });
    expect(resumed.candidates).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  it("retries only explicitly transient provider failures", async () => {
    const files = await fixture();
    const transient = new FakeProvider({
      pricing: zeroPrice,
      failuresBeforeSuccess: 1,
    });
    const completed = await pipeline(transient).run(files.manifestPath, {
      outDirectory: path.join(files.directory, "transient"),
      maxCalls: 2,
    });
    expect(completed.callAttempts).toBe(2);
    expect(completed.candidates).toHaveLength(1);

    const permanent: GenerationProvider = {
      name: "fake",
      getModel(): ModelCapability {
        return { kind: "image", inputSchema, pricing: zeroPrice };
      },
      generate() {
        return Promise.reject(
          new ProviderFailure({
            code: "fixture_permanent",
            isTransient: false,
            message: "synthetic permanent failure",
          }),
        );
      },
    };
    const failed = await pipeline(permanent).run(files.manifestPath, {
      outDirectory: path.join(files.directory, "permanent"),
      maxCalls: 3,
    });
    expect(failed.callAttempts).toBe(1);
    expect(failed.failures[0]?.code).toBe("fixture_permanent");
  });
});

describe("audit and export", () => {
  it("gates export on QA and copies only selected candidate IDs", async () => {
    const files = await fixture({ variants: 2 });
    const provider: GenerationProvider = {
      name: "fake",
      getModel(): ModelCapability {
        return { kind: "image", inputSchema, pricing: zeroPrice };
      },
      generate(request: GenerationRequest) {
        return Promise.resolve({
          bytes: new TextEncoder().encode(`synthetic:${request.callId}`),
          mediaType: "image/png",
        });
      },
    };
    const runDirectory = path.join(files.directory, "run");
    await pipeline(provider).run(files.manifestPath, {
      outDirectory: runDirectory,
      maxCalls: 2,
    });
    const failingInspector: AssetInspector = {
      inspect() {
        return Promise.resolve({
          checks: [{ id: "decode", passed: false }],
          measurements: {},
        });
      },
    };
    await pipeline(provider, failingInspector).audit(
      path.join(runDirectory, "run.json"),
    );
    const selectionPath = path.join(files.directory, "selection.json");
    await writeFile(
      selectionPath,
      JSON.stringify({
        version: 1,
        candidates: [{ id: "fixture.01", to: "chosen.png" }],
      }),
    );
    await expect(
      pipeline(provider).export(
        selectionPath,
        runDirectory,
        path.join(files.directory, "blocked"),
      ),
    ).rejects.toThrow("required QA");

    await pipeline(provider).audit(path.join(runDirectory, "run.json"));
    const destination = path.join(files.directory, "exported");
    const result = await pipeline(provider).export(
      selectionPath,
      runDirectory,
      destination,
    );
    expect(result.exported).toEqual([
      { candidateId: "fixture.01", path: "chosen.png" },
    ]);
    expect(await readFile(path.join(destination, "chosen.png"), "utf8")).toBe(
      "synthetic:fixture.01",
    );
    await expect(
      readFile(path.join(destination, "fixture-02.png")),
    ).rejects.toThrow();
  });
});
