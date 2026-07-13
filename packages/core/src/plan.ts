import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  loadManifest,
  resolveContainedExisting,
  sha256,
} from "./io.js";
import { assertPublicSafe } from "./security.js";
import type {
  Clock,
  JsonObject,
  JsonValue,
  Manifest,
  ManifestJob,
  PipelinePlan,
  PlannedCall,
  Price,
  Providers,
  Variant,
} from "./types.js";

function expandVariants(job: ManifestJob): Variant[] {
  if (job.variants === undefined) {
    return [{ id: "1" }];
  }
  if (typeof job.variants === "number") {
    return Array.from({ length: job.variants }, (_, index) => ({
      id: String(index + 1),
    }));
  }
  const ids = new Set(job.variants.map((variant) => variant.id));
  if (ids.size !== job.variants.length) {
    throw new Error(`job ${job.id} contains duplicate variant IDs`);
  }
  return job.variants;
}

function mergeInput(
  base: JsonObject,
  variant: JsonObject | undefined,
): JsonObject {
  return { ...base, ...variant };
}

function validatePostSteps(job: ManifestJob): void {
  for (const step of job.post ?? []) {
    if (
      (job.kind === "image" && step.type !== "image-convert") ||
      (job.kind === "audio" && step.type !== "audio-convert")
    ) {
      throw new Error(
        `job ${job.id} has a post step for a different asset kind`,
      );
    }
  }
}

function finalFormat(job: ManifestJob): string {
  const lastFormat = [...(job.post ?? [])]
    .reverse()
    .find((step) => step.format !== undefined)?.format;
  return lastFormat ?? job.output.format;
}

async function promptDigest(
  job: ManifestJob,
  manifestDirectory: string,
): Promise<string> {
  if (job.prompt !== undefined) {
    return sha256(job.prompt);
  }
  const promptPath = await resolveContainedExisting(
    manifestDirectory,
    job.promptFile ?? "",
  );
  if ((await stat(promptPath)).size > 1024 * 1024) {
    throw new Error(`prompt file exceeds the 1 MiB limit for job ${job.id}`);
  }
  const prompt = await readFile(promptPath, "utf8");
  assertPublicSafe(prompt, `jobs.${job.id}.promptFile`);
  return sha256(prompt);
}

function validateCapability(
  job: ManifestJob,
  providers: Providers,
  format: string,
): Price | null {
  const provider = providers[job.provider];
  if (provider === undefined) {
    throw new Error(`provider ${job.provider} is not configured`);
  }
  const capability = provider.getCapability(job.model);
  if (capability === undefined) {
    throw new Error(
      `model ${job.model} is not in the provider capability registry`,
    );
  }
  if (!capability.kinds.includes(job.kind)) {
    throw new Error(`model ${job.model} does not support ${job.kind}`);
  }
  if (!capability.outputFormats.includes(format)) {
    throw new Error(`model ${job.model} does not support ${format} output`);
  }
  if (capability.price === undefined) {
    return null;
  }
  const runtimePrice = JSON.parse(JSON.stringify(capability.price)) as {
    amountUsd?: JsonValue;
    retrievedAt?: JsonValue;
    source?: JsonValue;
    unit?: JsonValue;
  };
  if (
    runtimePrice.unit !== "call" ||
    typeof runtimePrice.amountUsd !== "number" ||
    !Number.isFinite(runtimePrice.amountUsd) ||
    runtimePrice.amountUsd < 0 ||
    typeof runtimePrice.source !== "string" ||
    runtimePrice.source.trim() === "" ||
    typeof runtimePrice.retrievedAt !== "string" ||
    !Number.isFinite(Date.parse(runtimePrice.retrievedAt))
  ) {
    throw new Error(`model ${job.model} has invalid pricing provenance`);
  }
  assertPublicSafe(runtimePrice.source, `pricing.${job.model}.source`);
  return {
    amountUsd: runtimePrice.amountUsd,
    retrievedAt: runtimePrice.retrievedAt,
    source: runtimePrice.source,
    unit: "call",
  };
}

export async function createPlan(
  manifestPath: string,
  providers: Providers,
  clock: Clock,
): Promise<{ manifest: Manifest; plan: PipelinePlan }> {
  const manifest = await loadManifest(manifestPath);
  const manifestDirectory = path.dirname(path.resolve(manifestPath));
  const calls: PlannedCall[] = [];
  const outputs = new Set<string>();
  const candidateIds = new Set<string>();

  for (const job of manifest.jobs) {
    validatePostSteps(job);
    const promptHash = await promptDigest(job, manifestDirectory);
    const format = finalFormat(job);
    const price = validateCapability(job, providers, job.output.format);
    const costUsd = price?.amountUsd ?? null;
    for (const variant of expandVariants(job)) {
      const candidateId = `${job.id}.${variant.id}`;
      if (candidateIds.has(candidateId)) {
        throw new Error(`candidate ID collision: ${candidateId}`);
      }
      candidateIds.add(candidateId);
      const outputName = `${job.output.stem}.${variant.id}.${format}`;
      const normalizedOutputName = outputName.toLocaleLowerCase("en-US");
      if (outputs.has(normalizedOutputName)) {
        throw new Error(`output collision: ${outputName}`);
      }
      outputs.add(normalizedOutputName);
      const input = mergeInput(job.input, variant.input);
      const callSeed = {
        candidateId,
        format,
        input,
        jobId: job.id,
        kind: job.kind,
        maxAttempts: 3,
        model: job.model,
        post: job.post ?? [],
        price,
        promptHash,
        providerFormat: job.output.format,
        provider: job.provider,
        variantId: variant.id,
      };
      calls.push({
        cacheKey: sha256(canonicalJson(callSeed)),
        candidateId,
        costUsd,
        input,
        jobId: job.id,
        kind: job.kind,
        maxAttempts: 3,
        model: job.model,
        output: { format, stem: job.output.stem },
        post: job.post ?? [],
        price,
        providerFormat: job.output.format,
        ...(job.promptFile === undefined ? {} : { promptFile: job.promptFile }),
        promptHash,
        provider: job.provider,
        ...(job.qa === undefined ? {} : { qa: job.qa }),
        variantId: variant.id,
      });
    }
  }

  if (
    manifest.budget?.maxCalls !== undefined &&
    calls.length > manifest.budget.maxCalls
  ) {
    throw new Error("planned calls exceed the manifest maxCalls budget");
  }

  const estimatedCostUsd = calls.reduce(
    (total, call) => total + (call.costUsd ?? 0),
    0,
  );
  if (
    manifest.budget?.maxCostUsd !== undefined &&
    estimatedCostUsd > manifest.budget.maxCostUsd
  ) {
    throw new Error(
      "known planned cost exceeds the manifest maxCostUsd budget",
    );
  }

  const manifestHash = sha256(canonicalJson(manifest));
  const planSeed = {
    calls,
    manifestHash,
    version: 1,
  };
  const plan: PipelinePlan = {
    callCount: calls.length,
    calls,
    createdAt: clock.now().toISOString(),
    estimatedCostUsd,
    isPricingUnknown: calls.some((call) => call.costUsd === null),
    manifestHash,
    planHash: sha256(canonicalJson(planSeed)),
    version: 1,
  };
  return { manifest, plan };
}
