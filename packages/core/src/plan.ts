import { readFile } from "node:fs/promises";

import {
  canonicalJson,
  assertSafePrompt,
  resolveContainedFile,
  sha256,
} from "./security.js";
import { loadManifest, loadQaProfile } from "./manifest.js";
import type {
  GenerationProvider,
  JsonObject,
  JsonValue,
  Manifest,
  PipelinePlan,
  PlanCall,
} from "./types.js";

export interface PlanOptions {
  readonly isAllowUnpriced?: boolean;
}

export interface PreparedPlan {
  readonly manifest: Manifest;
  readonly plan: PipelinePlan;
  readonly prompts: ReadonlyMap<string, string>;
}

function toMicros(usd: number): number {
  return Math.ceil(usd * 1_000_000);
}

function asJsonValue(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export async function preparePlan(
  manifestPath: string,
  providers: Readonly<Record<string, GenerationProvider>>,
  options: PlanOptions = {},
  createdAt = new Date().toISOString(),
): Promise<PreparedPlan> {
  const loaded = await loadManifest(manifestPath);
  const calls: PlanCall[] = [];
  const prompts = new Map<string, string>();
  const outputs = new Set<string>();
  const pricing = new Map<string, PipelinePlan["pricing"][number]>();
  let estimatedCostMicros = 0;
  let isFullyPriced = true;

  for (const job of loaded.manifest.jobs) {
    const provider = providers[job.provider];
    if (provider?.name !== job.provider) {
      throw new Error(`provider is not configured: ${job.provider}`);
    }
    const capability = provider.getModel(job.model);
    if (capability === undefined) {
      throw new Error(
        `model capability is not configured: ${job.provider}/${job.model}`,
      );
    }
    if (capability.kind !== job.kind) {
      throw new Error(`model ${job.model} does not support ${job.kind}`);
    }
    capability.inputSchema.parse(job.input);

    let prompt = job.prompt;
    if (prompt === undefined && job.promptFile !== undefined) {
      const promptPath = await resolveContainedFile(
        loaded.baseDirectory,
        job.promptFile,
      );
      prompt = await readFile(promptPath, "utf8");
    }
    if (
      prompt === undefined ||
      prompt.length === 0 ||
      prompt.length > 100_000
    ) {
      throw new Error(`job ${job.id} has an invalid prompt`);
    }
    assertSafePrompt(prompt);
    prompts.set(job.id, prompt);
    const promptHash = sha256(prompt);

    const profilePath = await resolveContainedFile(
      loaded.baseDirectory,
      job.qa,
    );
    const qaProfile = await loadQaProfile(profilePath);
    if (qaProfile.kind !== job.kind) {
      throw new Error(`QA profile kind does not match job ${job.id}`);
    }

    const quote = capability.pricing;
    pricing.set(`${job.provider}\0${job.model}`, {
      provider: job.provider,
      model: job.model,
      ...(quote === undefined ? {} : { quote }),
    });
    if (quote === undefined) {
      isFullyPriced = false;
      if (options.isAllowUnpriced !== true) {
        throw new Error(
          `pricing is UNKNOWN for ${job.provider}/${job.model}; explicitly enable unpriced calls to continue`,
        );
      }
    } else {
      if (
        quote.currency !== "USD" ||
        !Number.isSafeInteger(quote.perCallMicros) ||
        quote.perCallMicros < 0 ||
        Number.isNaN(Date.parse(quote.timestamp)) ||
        quote.source.length === 0
      ) {
        throw new Error(`invalid pricing metadata for ${job.model}`);
      }
      estimatedCostMicros += quote.perCallMicros * job.variants;
    }

    for (let variant = 1; variant <= job.variants; variant += 1) {
      const output = `${job.output.stem}-${String(variant).padStart(2, "0")}.${
        job.output.format
      }`;
      const collisionKey = output.toLocaleLowerCase("en-US");
      if (outputs.has(collisionKey)) {
        throw new Error(`output collision: ${output}`);
      }
      outputs.add(collisionKey);

      const id = `${job.id}.${String(variant).padStart(2, "0")}`;
      const cacheIdentity: JsonObject = {
        version: 1,
        id,
        provider: job.provider,
        model: job.model,
        kind: job.kind,
        input: job.input,
        promptHash,
        post: job.post,
        format: job.output.format,
      };
      calls.push({
        id,
        jobId: job.id,
        variant,
        provider: job.provider,
        model: job.model,
        kind: job.kind,
        input: job.input,
        promptHash,
        output,
        post: job.post,
        qaProfile,
        cacheKey: sha256(canonicalJson(cacheIdentity)),
        ...(quote === undefined
          ? {}
          : { estimatedCostMicros: quote.perCallMicros }),
      });
    }
  }

  if (
    loaded.manifest.budget !== undefined &&
    estimatedCostMicros > toMicros(loaded.manifest.budget.maxCostUsd)
  ) {
    throw new Error("planned cost exceeds the manifest budget");
  }

  const manifestHash = sha256(canonicalJson(asJsonValue(loaded.manifest)));
  const planSeed = {
    version: 1 as const,
    manifestHash,
    concurrency: loaded.manifest.concurrency,
    calls,
    pricing: [...pricing.values()],
    ...(isFullyPriced ? { estimatedCostMicros } : {}),
  };
  const plan: PipelinePlan = Object.freeze({
    ...planSeed,
    createdAt,
    id: sha256(canonicalJson(asJsonValue(planSeed))),
  });

  return { manifest: loaded.manifest, plan, prompts };
}
