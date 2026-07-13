import {
  access,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { imageAuditor } from "@fal-tools/image";

import {
  createPipeline,
  createRedactingLogger,
  loadRunLedger,
  type Clock,
  type GenerationProvider,
  type JsonObject,
  type Logger,
  type ModelCapability,
  type ProviderRequest,
  type ProviderResult,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const immediateClock: Clock = {
  now: () => new Date("2026-01-01T00:00:00.000Z"),
  sleep: () => Promise.resolve(),
};
const zeroPrice = {
  amountUsd: 0,
  retrievedAt: "2026-01-01T00:00:00.000Z",
  source: "https://example.invalid/pricing",
  unit: "call" as const,
};

class FakeProvider implements GenerationProvider {
  calls = 0;
  readonly #bytes: Uint8Array;
  readonly #capability: ModelCapability;
  readonly #isPermanentFailure: boolean;
  #transientFailures: number;

  constructor(
    options: {
      bytes?: Uint8Array;
      isPermanentFailure?: boolean;
      isPriced?: boolean;
      transientFailures?: number;
    } = {},
  ) {
    this.#bytes = options.bytes ?? new TextEncoder().encode("synthetic asset");
    this.#isPermanentFailure = options.isPermanentFailure ?? false;
    this.#transientFailures = options.transientFailures ?? 0;
    this.#capability = {
      kinds: ["image"],
      outputFormats: ["png"],
      ...(options.isPriced === false ? {} : { price: zeroPrice }),
    };
  }

  generate(request: ProviderRequest): Promise<ProviderResult> {
    void request;
    this.calls += 1;
    if (this.#isPermanentFailure) {
      return Promise.reject(new Error("permanent"));
    }
    if (this.#transientFailures > 0) {
      this.#transientFailures -= 1;
      return Promise.reject(new Error("transient"));
    }
    return Promise.resolve({
      bytes: this.#bytes,
      requestId: `request-${this.calls}`,
    });
  }

  getCapability(): ModelCapability {
    return this.#capability;
  }

  isTransientError(error: Error): boolean {
    return error.message === "transient";
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fal-tools-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function job(overrides: JsonObject = {}): JsonObject {
  return {
    id: "asset",
    input: {},
    kind: "image",
    model: "fal-ai/example-image",
    output: { format: "png", stem: "asset" },
    prompt: "A synthetic geometric shape",
    provider: "fal",
    ...overrides,
  };
}

async function writeManifest(
  directory: string,
  jobs: JsonObject[],
  extras: JsonObject = {},
): Promise<string> {
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({ jobs, version: 1, ...extras }),
    { mode: 0o600 },
  );
  return manifestPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("planning and safety", () => {
  it("creates an exact prompt-free call graph without generating", async () => {
    const directory = await temporaryDirectory();
    const provider = new FakeProvider();
    const prompt = "An invented blue polygon with three circles";
    const manifestPath = await writeManifest(directory, [
      job({ prompt, variants: 2 }),
    ]);
    const pipeline = createPipeline({
      clock: immediateClock,
      providers: { fal: provider },
    });

    const plan = await pipeline.plan({ manifestPath });

    expect(plan.callCount).toBe(2);
    expect(plan.calls.map((call) => call.candidateId)).toEqual([
      "asset.1",
      "asset.2",
    ]);
    expect(JSON.stringify(plan)).not.toContain(prompt);
    expect(plan.calls[0]?.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(provider.calls).toBe(0);
  });

  it("rejects output collisions", async () => {
    const directory = await temporaryDirectory();
    const manifestPath = await writeManifest(directory, [
      job({ id: "first" }),
      job({ id: "second" }),
    ]);
    const pipeline = createPipeline({
      clock: immediateClock,
      providers: { fal: new FakeProvider() },
    });

    await expect(pipeline.plan({ manifestPath })).rejects.toThrow(
      "output collision",
    );
  });

  it("keeps provider and post-processed formats distinct", async () => {
    const directory = await temporaryDirectory();
    const manifestPath = await writeManifest(directory, [
      job({
        post: [{ format: "jpeg", type: "image-convert" }],
      }),
    ]);
    const plan = await createPipeline({
      clock: immediateClock,
      providers: { fal: new FakeProvider() },
    }).plan({ manifestPath });

    expect(plan.calls[0]?.providerFormat).toBe("png");
    expect(plan.calls[0]?.output.format).toBe("jpeg");
  });

  it("rejects secrets and absolute machine paths", async () => {
    const directory = await temporaryDirectory();
    const secret = `${["api", "key"].join("_")}=${"x".repeat(24)}`;
    const secretManifest = await writeManifest(directory, [
      job({ input: { value: secret } }),
    ]);
    const pipeline = createPipeline({
      clock: immediateClock,
      providers: { fal: new FakeProvider() },
    });

    await expect(
      pipeline.plan({ manifestPath: secretManifest }),
    ).rejects.toThrow("secret-like");

    const pathManifest = await writeManifest(directory, [
      job({ input: { file: ["", "Users", "private", "asset.png"].join("/") } }),
    ]);
    await expect(pipeline.plan({ manifestPath: pathManifest })).rejects.toThrow(
      "absolute machine path",
    );
  });

  it("rejects unsafe and symlinked prompt files", async () => {
    const directory = await temporaryDirectory();
    const outsideDirectory = await temporaryDirectory();
    const outsidePrompt = path.join(outsideDirectory, "prompt.txt");
    await writeFile(outsidePrompt, "A harmless external prompt", {
      mode: 0o600,
    });
    await symlink(outsidePrompt, path.join(directory, "linked-prompt.txt"));
    const linkedJob = job();
    delete linkedJob.prompt;
    linkedJob.promptFile = "linked-prompt.txt";
    const pipeline = createPipeline({
      clock: immediateClock,
      providers: { fal: new FakeProvider() },
    });
    await expect(
      pipeline.plan({
        manifestPath: await writeManifest(directory, [linkedJob]),
      }),
    ).rejects.toThrow("outside its allowed directory");

    const privatePrompt = path.join(directory, "private-prompt.txt");
    const secret = `${["api", "key"].join("_")}=${"y".repeat(24)}`;
    await writeFile(privatePrompt, secret, { mode: 0o600 });
    const privateJob = job();
    delete privateJob.prompt;
    privateJob.promptFile = "private-prompt.txt";
    await expect(
      pipeline.plan({
        manifestPath: await writeManifest(directory, [privateJob]),
      }),
    ).rejects.toThrow("secret-like");
  });

  it("redacts credentials, prompt fields, and signed URLs from logs", () => {
    const records: JsonObject[] = [];
    const target: Logger = {
      debug: (message, fields) =>
        records.push({ fields: fields ?? {}, message }),
      error: (message, fields) =>
        records.push({ fields: fields ?? {}, message }),
      info: (message, fields) =>
        records.push({ fields: fields ?? {}, message }),
      warn: (message, fields) =>
        records.push({ fields: fields ?? {}, message }),
    };
    const logger = createRedactingLogger(target);
    const credential = ["fal", "key"].join("_") + "=" + "x".repeat(24);
    const signedUrl =
      "https://example.invalid/file?" +
      ["x-amz", "signature"].join("-") +
      "=abc";

    logger.info(`credential ${credential} ${signedUrl}`, {
      prompt: "private words",
      responseBody: "private response",
    });

    expect(JSON.stringify(records)).not.toContain("private words");
    expect(JSON.stringify(records)).not.toContain("private response");
    expect(JSON.stringify(records)).not.toContain(credential);
    expect(JSON.stringify(records)).not.toContain(signedUrl);

    logger.warn(`${credential} then ${credential}`);
    expect(JSON.stringify(records)).not.toContain(credential);
  });
});

describe("budgeted execution and recovery", () => {
  it("fails closed before calls when max-calls is exceeded", async () => {
    const directory = await temporaryDirectory();
    const provider = new FakeProvider();
    const manifestPath = await writeManifest(directory, [job({ variants: 2 })]);
    const pipeline = createPipeline({
      clock: immediateClock,
      providers: { fal: provider },
    });

    await expect(
      pipeline.run({
        manifestPath,
        maxCalls: 1,
        outDir: path.join(directory, "run"),
      }),
    ).rejects.toThrow("max-calls");
    expect(provider.calls).toBe(0);

    await expect(
      pipeline.run({
        manifestPath,
        maxCalls: Number.NaN,
        outDir: path.join(directory, "invalid"),
      }),
    ).rejects.toThrow("max-calls");
  });

  it("fails closed for unpriced calls unless explicitly allowed", async () => {
    const directory = await temporaryDirectory();
    const provider = new FakeProvider({ isPriced: false });
    const manifestPath = await writeManifest(directory, [job()]);
    const pipeline = createPipeline({
      clock: immediateClock,
      providers: { fal: provider },
    });

    await expect(
      pipeline.run({
        manifestPath,
        maxCalls: 1,
        outDir: path.join(directory, "blocked"),
      }),
    ).rejects.toThrow("pricing is UNKNOWN");
    expect(provider.calls).toBe(0);

    await pipeline.run({
      isUnpricedCallsAllowed: true,
      manifestPath,
      maxCalls: 1,
      outDir: path.join(directory, "allowed"),
    });
    expect(provider.calls).toBe(1);
  });

  it("reuses resume state and the content-addressed cache", async () => {
    const directory = await temporaryDirectory();
    const provider = new FakeProvider();
    const manifestPath = await writeManifest(directory, [job()]);
    const outDir = path.join(directory, "run");
    const pipeline = createPipeline({
      clock: immediateClock,
      providers: { fal: provider },
    });

    await pipeline.run({ manifestPath, maxCalls: 1, outDir });
    await pipeline.run({
      isResume: true,
      manifestPath,
      maxCalls: 1,
      outDir,
    });
    expect(provider.calls).toBe(1);

    await rm(path.join(outDir, "run.json"));
    await pipeline.run({ manifestPath, maxCalls: 1, outDir });
    expect(provider.calls).toBe(1);
  });

  it("rejects corrupted cache blobs", async () => {
    const directory = await temporaryDirectory();
    const provider = new FakeProvider();
    const manifestPath = await writeManifest(directory, [job()]);
    const outDir = path.join(directory, "run");
    const pipeline = createPipeline({
      clock: immediateClock,
      providers: { fal: provider },
    });
    const plan = await pipeline.plan({ manifestPath });
    await pipeline.run({ manifestPath, maxCalls: 1, outDir });
    const indexPath = path.join(
      outDir,
      ".fal-tools",
      "cache",
      "requests",
      `${plan.calls[0]?.cacheKey}.json`,
    );
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      blob: string;
    };
    await writeFile(
      path.join(outDir, ".fal-tools", "cache", index.blob),
      "corrupt",
      { mode: 0o600 },
    );
    await rm(path.join(outDir, "run.json"));

    await expect(
      pipeline.run({ manifestPath, maxCalls: 1, outDir }),
    ).rejects.toThrow("failed candidates");
    expect(provider.calls).toBe(1);
  });

  it("retries only transient failures", async () => {
    const directory = await temporaryDirectory();
    const transientProvider = new FakeProvider({ transientFailures: 2 });
    const manifestPath = await writeManifest(directory, [job()]);
    await createPipeline({
      clock: immediateClock,
      providers: { fal: transientProvider },
    }).run({
      manifestPath,
      maxCalls: 3,
      outDir: path.join(directory, "transient"),
    });
    expect(transientProvider.calls).toBe(3);

    const budgetedProvider = new FakeProvider({ transientFailures: 2 });
    await expect(
      createPipeline({
        clock: immediateClock,
        providers: { fal: budgetedProvider },
      }).run({
        manifestPath,
        maxCalls: 2,
        outDir: path.join(directory, "budgeted-retries"),
      }),
    ).rejects.toThrow("failed candidates");
    expect(budgetedProvider.calls).toBe(2);
    await expect(
      createPipeline({
        clock: immediateClock,
        providers: { fal: budgetedProvider },
      }).run({
        isResume: true,
        manifestPath,
        maxCalls: 2,
        outDir: path.join(directory, "budgeted-retries"),
      }),
    ).rejects.toThrow("failed candidates");
    expect(budgetedProvider.calls).toBe(2);

    const permanentProvider = new FakeProvider({ isPermanentFailure: true });
    await expect(
      createPipeline({
        clock: immediateClock,
        providers: { fal: permanentProvider },
      }).run({
        manifestPath,
        maxCalls: 1,
        outDir: path.join(directory, "permanent"),
      }),
    ).rejects.toThrow("failed candidates");
    expect(permanentProvider.calls).toBe(1);
  });
});

describe("objective QA and explicit export", () => {
  it("exports only explicitly selected candidates after QA passes", async () => {
    const directory = await temporaryDirectory();
    const imageBytes = await import("sharp").then(({ default: sharp }) =>
      sharp({
        create: {
          background: { alpha: 1, b: 255, g: 0, r: 0 },
          channels: 4,
          height: 4,
          width: 4,
        },
      })
        .png()
        .toBuffer(),
    );
    const provider = new FakeProvider({ bytes: imageBytes });
    const manifestPath = await writeManifest(directory, [
      job({
        qa: { image: { isDuplicateAllowed: true, minHeight: 4, minWidth: 4 } },
        variants: 2,
      }),
    ]);
    const outDir = path.join(directory, "run");
    const pipeline = createPipeline({
      auditors: { image: imageAuditor },
      clock: immediateClock,
      providers: { fal: provider },
    });
    await pipeline.run({ manifestPath, maxCalls: 2, outDir });
    const selectionPath = path.join(directory, "selection.json");
    await writeFile(
      selectionPath,
      JSON.stringify({
        candidates: [{ as: "chosen.png", id: "asset.1" }],
        version: 1,
      }),
      { mode: 0o600 },
    );
    await expect(
      pipeline.export({
        destinationDir: path.join(directory, "export"),
        runDir: outDir,
        selectionPath,
      }),
    ).rejects.toThrow("has not passed QA");

    const ledger = await pipeline.audit({
      runPath: path.join(outDir, "run.json"),
    });
    expect(
      ledger.candidates.every((candidate) => candidate.audit?.isPassed),
    ).toBe(true);
    await pipeline.export({
      destinationDir: path.join(directory, "export"),
      runDir: outDir,
      selectionPath,
    });

    await expect(
      access(path.join(directory, "export", "chosen.png")),
    ).resolves.toBe(undefined);
    const files = await readFile(path.join(directory, "export", "chosen.png"));
    expect(files).toEqual(imageBytes);
    const persisted = await loadRunLedger(path.join(outDir, "run.json"));
    expect(persisted.candidates).toHaveLength(2);
  });

  it("does not allow an audit override to weaken manifest QA", async () => {
    const directory = await temporaryDirectory();
    const imageBytes = await import("sharp").then(({ default: sharp }) =>
      sharp({
        create: {
          background: { alpha: 1, b: 0, g: 0, r: 255 },
          channels: 4,
          height: 4,
          width: 4,
        },
      })
        .png()
        .toBuffer(),
    );
    const manifestPath = await writeManifest(directory, [
      job({ qa: { image: { minWidth: 8 } } }),
    ]);
    const outDir = path.join(directory, "strict-run");
    const pipeline = createPipeline({
      auditors: { image: imageAuditor },
      clock: immediateClock,
      providers: { fal: new FakeProvider({ bytes: imageBytes }) },
    });
    await pipeline.run({ manifestPath, maxCalls: 1, outDir });
    const profilePath = path.join(directory, "weaker-profile.json");
    await writeFile(profilePath, JSON.stringify({ image: { minWidth: 1 } }), {
      mode: 0o600,
    });
    const ledger = await pipeline.audit({
      profilePath,
      runPath: path.join(outDir, "run.json"),
    });
    expect(ledger.candidates[0]?.audit?.isPassed).toBe(false);
    expect(ledger.candidates[0]?.audit?.profile.image?.minWidth).toBe(8);
  });
});
