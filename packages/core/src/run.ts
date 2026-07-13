import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import pLimit from "p-limit";

import { preparePlan } from "./plan.js";
import { redactMessage, sha256 } from "./security.js";
import {
  ProviderFailure,
  type AssetProcessor,
  type CandidateRecord,
  type Clock,
  type FailedCallRecord,
  type GenerationProvider,
  type Logger,
  type PipelinePlan,
  type PlanCall,
  type RunLedger,
} from "./types.js";

const maxArtifactBytes = 100 * 1024 * 1024;
const maxAttemptsPerCall = 3;

export interface RunOptions {
  readonly isAllowUnpriced?: boolean;
  readonly isResume?: boolean;
  readonly maxCalls: number;
  readonly maxCostUsd?: number;
  readonly outDirectory: string;
}

export interface RunDependencies {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly processors: Partial<Record<"audio" | "image", AssetProcessor>>;
  readonly providers: Readonly<Record<string, GenerationProvider>>;
}

interface CacheMetadata {
  readonly byteLength: number;
  readonly contentHash: string;
  readonly mediaType: string;
}

function mediaTypeFor(format: string, fallback: string): string {
  const types: Readonly<Record<string, string>> = {
    flac: "audio/flac",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    png: "image/png",
    wav: "audio/wav",
    webp: "image/webp",
  };
  return types[format] ?? fallback;
}

async function readJsonFile<T extends object>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJsonAtomic(filePath: string, value: object): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

async function readCachedCandidate(
  root: string,
  call: PlanCall,
): Promise<CandidateRecord | undefined> {
  const cacheDirectory = path.join(
    root,
    ".fal-tools",
    "cache",
    call.cacheKey.slice("sha256:".length),
  );
  try {
    const metadata = await readJsonFile<CacheMetadata>(
      path.join(cacheDirectory, "metadata.json"),
    );
    const artifactPath = path.join(cacheDirectory, "artifact");
    const bytes = await readFile(artifactPath);
    if (
      bytes.byteLength !== metadata.byteLength ||
      sha256(bytes) !== metadata.contentHash
    ) {
      return undefined;
    }
    const candidatePath = path.join(
      root,
      ".fal-tools",
      "candidates",
      call.output,
    );
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await copyFile(artifactPath, candidatePath);
    return {
      id: call.id,
      jobId: call.jobId,
      variant: call.variant,
      kind: call.kind,
      output: call.output,
      path: path.relative(root, candidatePath).replaceAll(path.sep, "/"),
      cacheKey: call.cacheKey,
      contentHash: metadata.contentHash,
      byteLength: metadata.byteLength,
      mediaType: metadata.mediaType,
      qaProfile: call.qaProfile,
      status: "complete",
    };
  } catch {
    return undefined;
  }
}

async function saveCandidate(
  root: string,
  call: PlanCall,
  bytes: Uint8Array,
  mediaType: string,
): Promise<CandidateRecord> {
  const contentHash = sha256(bytes);
  const cacheDirectory = path.join(
    root,
    ".fal-tools",
    "cache",
    call.cacheKey.slice("sha256:".length),
  );
  await mkdir(cacheDirectory, { recursive: true });
  const artifactPath = path.join(cacheDirectory, "artifact");
  const metadataPath = path.join(cacheDirectory, "metadata.json");
  await writeFile(artifactPath, bytes, { mode: 0o600 });
  await writeJsonAtomic(metadataPath, {
    contentHash,
    byteLength: bytes.byteLength,
    mediaType,
  });

  const candidatePath = path.join(
    root,
    ".fal-tools",
    "candidates",
    call.output,
  );
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await copyFile(artifactPath, candidatePath);
  return {
    id: call.id,
    jobId: call.jobId,
    variant: call.variant,
    kind: call.kind,
    output: call.output,
    path: path.relative(root, candidatePath).replaceAll(path.sep, "/"),
    cacheKey: call.cacheKey,
    contentHash,
    byteLength: bytes.byteLength,
    mediaType,
    qaProfile: call.qaProfile,
    status: "complete",
  };
}

function effectiveBudgetMicros(
  plan: PipelinePlan,
  manifestBudgetUsd: number | undefined,
  commandBudgetUsd: number | undefined,
): number | undefined {
  const values = [manifestBudgetUsd, commandBudgetUsd]
    .filter((value): value is number => value !== undefined)
    .map((value) => Math.floor(value * 1_000_000));
  if (values.length === 0) {
    return undefined;
  }
  if (plan.estimatedCostMicros === undefined) {
    return Math.min(...values);
  }
  return Math.min(...values);
}

export async function runPipeline(
  manifestPath: string,
  options: RunOptions,
  dependencies: RunDependencies,
): Promise<RunLedger> {
  if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1) {
    throw new Error("maxCalls must be a positive integer");
  }

  const prepared = await preparePlan(
    manifestPath,
    dependencies.providers,
    options.isAllowUnpriced === undefined
      ? {}
      : { isAllowUnpriced: options.isAllowUnpriced },
    dependencies.clock.now().toISOString(),
  );
  if (prepared.plan.calls.length > options.maxCalls) {
    throw new Error("planned calls exceed the hard maxCalls limit");
  }

  const root = path.resolve(options.outDirectory);
  const ledgerPath = path.join(root, "run.json");
  await mkdir(root, { recursive: true });
  try {
    await stat(ledgerPath);
    if (options.isResume !== true) {
      throw new Error("run.json already exists; pass resume to reuse this run");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      !("code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }

  const previous =
    options.isResume === true
      ? await readJsonFile<RunLedger>(ledgerPath).catch(() => undefined)
      : undefined;
  if (previous !== undefined && previous.planId !== prepared.plan.id) {
    throw new Error("resume plan does not match the existing run");
  }

  let callAttempts = previous?.callAttempts ?? 0;
  let costMicros = previous?.costMicros ?? 0;
  const candidates = new Map<string, CandidateRecord>();
  const failures: FailedCallRecord[] = [];
  const budgetMicros = effectiveBudgetMicros(
    prepared.plan,
    prepared.manifest.budget?.maxCostUsd,
    options.maxCostUsd,
  );
  const limit = pLimit(prepared.plan.concurrency);

  const execute = async (call: PlanCall): Promise<void> => {
    if (options.isResume === true) {
      const cached = await readCachedCandidate(root, call);
      if (cached !== undefined) {
        candidates.set(call.id, cached);
        dependencies.logger.info("cache_hit", { callId: call.id });
        return;
      }
    }

    const provider = dependencies.providers[call.provider];
    const processor = dependencies.processors[call.kind];
    const prompt = prepared.prompts.get(call.jobId);
    if (
      provider === undefined ||
      processor === undefined ||
      prompt === undefined
    ) {
      throw new Error(`runtime dependency is missing for ${call.id}`);
    }

    for (let attempt = 1; attempt <= maxAttemptsPerCall; attempt += 1) {
      if (callAttempts >= options.maxCalls) {
        throw new Error("hard maxCalls limit reached");
      }
      const attemptCost = call.estimatedCostMicros ?? 0;
      if (
        budgetMicros !== undefined &&
        costMicros + attemptCost > budgetMicros
      ) {
        throw new Error("hard cost budget reached");
      }
      callAttempts += 1;
      costMicros += attemptCost;

      try {
        const generated = await provider.generate({
          callId: call.id,
          input: call.input,
          kind: call.kind,
          model: call.model,
          prompt,
        });
        if (generated.bytes.byteLength > maxArtifactBytes) {
          throw new ProviderFailure({
            code: "artifact_too_large",
            isTransient: false,
            message: "provider artifact exceeds 100 MiB",
          });
        }
        const format = call.output.split(".").at(-1) ?? "";
        const processed = await processor.process({
          input: generated.bytes,
          format,
          post: call.post,
        });
        const candidate = await saveCandidate(
          root,
          call,
          processed,
          mediaTypeFor(format, generated.mediaType),
        );
        candidates.set(call.id, candidate);
        dependencies.logger.info("call_complete", {
          callId: call.id,
          byteLength: processed.byteLength,
        });
        return;
      } catch (error) {
        const isRetryable =
          error instanceof ProviderFailure && error.isTransient;
        dependencies.logger.warn("call_attempt_failed", {
          callId: call.id,
          code:
            error instanceof ProviderFailure ? error.code : "local_processing",
          isRetryable,
        });
        if (!isRetryable || attempt === maxAttemptsPerCall) {
          throw error;
        }
        await dependencies.clock.sleep(250 * 2 ** (attempt - 1));
      }
    }
  };

  await Promise.all(
    prepared.plan.calls.map((call) =>
      limit(async () => {
        if (candidates.has(call.id)) {
          return;
        }
        try {
          await execute(call);
        } catch (error) {
          failures.push({
            id: call.id,
            status: "failed",
            code: error instanceof ProviderFailure ? error.code : "run_failed",
            message: redactMessage(
              error instanceof Error ? error.message : "run failed",
            ),
          });
        }
      }),
    ),
  );

  const ledger: RunLedger = {
    version: 1,
    runId: sha256(`${prepared.plan.id}:${prepared.plan.createdAt}`),
    planId: prepared.plan.id,
    startedAt: previous?.startedAt ?? prepared.plan.createdAt,
    completedAt: dependencies.clock.now().toISOString(),
    callAttempts,
    costMicros,
    candidates: [...candidates.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    failures: failures.sort((left, right) => left.id.localeCompare(right.id)),
    audits: previous?.audits ?? [],
  };
  await writeJsonAtomic(ledgerPath, ledger);
  return ledger;
}
