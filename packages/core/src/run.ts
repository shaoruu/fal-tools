import {
  access,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import pLimit from "p-limit";

import {
  loadRunLedger,
  resolveContained,
  sha256,
  writeJsonAtomic,
} from "./io.js";
import { createPlan } from "./plan.js";
import type {
  AssetProcessors,
  CandidateRecord,
  Clock,
  Logger,
  Manifest,
  PipelinePlan,
  PlannedCall,
  Providers,
  RunLedger,
  RunOptions,
} from "./types.js";

async function isFilePresent(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function effectiveLimit(
  first: number | undefined,
  second: number | undefined,
): number | undefined {
  if (first === undefined) {
    return second;
  }
  if (second === undefined) {
    return first;
  }
  return Math.min(first, second);
}

function assertBudgets(
  manifest: Manifest,
  plan: PipelinePlan,
  options: RunOptions,
): void {
  const maxCalls = effectiveLimit(options.maxCalls, manifest.budget?.maxCalls);
  if (maxCalls === undefined || plan.callCount > maxCalls) {
    throw new Error("planned calls exceed the hard max-calls budget");
  }
  const isUnpricedCallsAllowed =
    options.isUnpricedCallsAllowed === true ||
    manifest.budget?.isUnpricedCallsAllowed === true;
  if (plan.isPricingUnknown && !isUnpricedCallsAllowed) {
    throw new Error(
      "pricing is UNKNOWN; explicitly allow unpriced calls to execute",
    );
  }
  const maxCostUsd = effectiveLimit(
    options.maxCostUsd,
    manifest.budget?.maxCostUsd,
  );
  if (maxCostUsd !== undefined && plan.estimatedCostUsd > maxCostUsd) {
    throw new Error("known planned cost exceeds the hard max-cost budget");
  }
}

function findPrompt(manifest: Manifest, call: PlannedCall): string {
  const job = manifest.jobs.find((entry) => entry.id === call.jobId);
  if (job?.prompt === undefined) {
    throw new Error(`inline prompt unavailable for ${call.candidateId}`);
  }
  return job.prompt;
}

async function loadPrompt(
  manifest: Manifest,
  manifestPath: string,
  call: PlannedCall,
): Promise<string> {
  const prompt =
    call.promptFile === undefined
      ? findPrompt(manifest, call)
      : await readFile(
          resolveContained(
            path.dirname(path.resolve(manifestPath)),
            call.promptFile,
          ),
          "utf8",
        );
  if (sha256(prompt) !== call.promptHash) {
    throw new Error(`prompt changed after planning for ${call.candidateId}`);
  }
  return prompt;
}

async function generateWithRetry(
  call: PlannedCall,
  prompt: string,
  providers: Providers,
  clock: Clock,
  logger: Logger,
): Promise<{ bytes: Uint8Array; requestId?: string }> {
  const provider = providers[call.provider];
  if (provider === undefined) {
    throw new Error(`provider unavailable for ${call.candidateId}`);
  }
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await provider.generate({
        input: call.input,
        kind: call.kind,
        model: call.model,
        outputFormat: call.output.format,
        prompt,
      });
      return {
        bytes: result.bytes,
        ...(result.requestId === undefined
          ? {}
          : { requestId: result.requestId }),
      };
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error("provider failure");
      const isTransient = provider.isTransientError(normalizedError);
      if (!isTransient || attempt === maxAttempts) {
        throw normalizedError;
      }
      logger.warn("transient provider failure; retrying", {
        attempt,
        candidateId: call.candidateId,
      });
      await clock.sleep(250 * 2 ** (attempt - 1));
    }
  }
  throw new Error("retry loop ended unexpectedly");
}

async function materializeCandidate(
  call: PlannedCall,
  sourcePath: string,
  candidatePath: string,
  requestId?: string,
): Promise<CandidateRecord> {
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await copyFile(sourcePath, candidatePath);
  const bytes = await readFile(candidatePath);
  const fileStats = await stat(candidatePath);
  return {
    cacheKey: call.cacheKey,
    candidateId: call.candidateId,
    contentHash: sha256(bytes),
    file: path.posix.join(
      "candidates",
      `${call.output.stem}.${call.variantId}.${call.output.format}`,
    ),
    jobId: call.jobId,
    kind: call.kind,
    ...(call.qa === undefined ? {} : { qa: call.qa }),
    ...(requestId === undefined ? {} : { requestId }),
    sizeBytes: fileStats.size,
    status: "completed",
    variantId: call.variantId,
  };
}

async function executeCall(
  call: PlannedCall,
  manifest: Manifest,
  manifestPath: string,
  outDir: string,
  providers: Providers,
  processors: AssetProcessors,
  clock: Clock,
  logger: Logger,
): Promise<CandidateRecord> {
  const cachePath = path.join(
    outDir,
    ".fal-tools",
    "cache",
    call.cacheKey,
    `asset.${call.output.format}`,
  );
  const candidatePath = path.join(
    outDir,
    "candidates",
    `${call.output.stem}.${call.variantId}.${call.output.format}`,
  );
  if (await isFilePresent(cachePath)) {
    logger.info("using content-addressed cache", {
      candidateId: call.candidateId,
    });
    return materializeCandidate(call, cachePath, candidatePath);
  }

  const prompt = await loadPrompt(manifest, manifestPath, call);
  const generated = await generateWithRetry(
    call,
    prompt,
    providers,
    clock,
    logger,
  );
  const processor = processors[call.kind];
  const bytes =
    call.post.length === 0
      ? generated.bytes
      : await (() => {
          if (processor === undefined) {
            throw new Error(`no ${call.kind} post processor is configured`);
          }
          return processor.process({
            bytes: generated.bytes,
            format: call.output.format,
            steps: call.post,
          });
        })();
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, bytes, { flag: "wx", mode: 0o600 }).catch(
    async (error) => {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    },
  );
  return materializeCandidate(
    call,
    cachePath,
    candidatePath,
    generated.requestId,
  );
}

async function isCandidateIntact(
  candidate: CandidateRecord,
  outDir: string,
): Promise<boolean> {
  try {
    const filePath = resolveContained(outDir, candidate.file);
    return sha256(await readFile(filePath)) === candidate.contentHash;
  } catch {
    return false;
  }
}

export async function runPlan(
  manifestPath: string,
  options: RunOptions,
  providers: Providers,
  processors: AssetProcessors,
  clock: Clock,
  logger: Logger,
): Promise<RunLedger> {
  const { manifest, plan } = await createPlan(manifestPath, providers, clock);
  assertBudgets(manifest, plan, options);
  const outDir = path.resolve(options.outDir);
  const ledgerPath = path.join(outDir, "run.json");
  const planPath = path.join(outDir, "plan.json");
  await mkdir(outDir, { recursive: true });
  await writeJsonAtomic(planPath, plan);

  let ledger: RunLedger;
  if (options.isResume === true && (await isFilePresent(ledgerPath))) {
    ledger = await loadRunLedger(ledgerPath);
    if (
      ledger.planHash !== plan.planHash ||
      ledger.manifestHash !== plan.manifestHash
    ) {
      throw new Error("resume ledger does not match the immutable plan");
    }
    ledger.status = "running";
    delete ledger.completedAt;
    const integrity = await Promise.all(
      ledger.candidates.map((candidate) =>
        isCandidateIntact(candidate, outDir),
      ),
    );
    ledger.candidates = ledger.candidates.filter(
      (_candidate, index) => integrity[index] === true,
    );
    ledger.failures = [];
  } else {
    ledger = {
      candidates: [],
      createdAt: clock.now().toISOString(),
      failures: [],
      manifestHash: plan.manifestHash,
      planHash: plan.planHash,
      status: "running",
      version: 1,
    };
  }
  await writeJsonAtomic(ledgerPath, ledger);

  const completedIds = new Set(
    ledger.candidates.map((candidate) => candidate.candidateId),
  );
  const calls = plan.calls.filter(
    (call) => !completedIds.has(call.candidateId),
  );
  const limit = pLimit(manifest.concurrency ?? 1);
  let writeQueue = Promise.resolve();
  const persist = (): Promise<void> => {
    writeQueue = writeQueue.then(() => writeJsonAtomic(ledgerPath, ledger));
    return writeQueue;
  };

  await Promise.all(
    calls.map((call) =>
      limit(async () => {
        try {
          const candidate = await executeCall(
            call,
            manifest,
            manifestPath,
            outDir,
            providers,
            processors,
            clock,
            logger,
          );
          ledger.candidates.push(candidate);
          await persist();
        } catch (error) {
          const provider = providers[call.provider];
          const normalizedError =
            error instanceof Error ? error : new Error("execution failure");
          ledger.failures.push({
            candidateId: call.candidateId,
            errorCode:
              provider?.isTransientError(normalizedError) === true
                ? "TRANSIENT_RETRIES_EXHAUSTED"
                : "PERMANENT_EXECUTION_ERROR",
            status: "failed",
          });
          logger.error("candidate generation failed", {
            candidateId: call.candidateId,
          });
          await persist();
        }
      }),
    ),
  );
  await writeQueue;

  ledger.status = ledger.failures.length === 0 ? "completed" : "failed";
  ledger.completedAt = clock.now().toISOString();
  ledger.candidates.sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId),
  );
  ledger.failures.sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId),
  );
  await writeJsonAtomic(ledgerPath, ledger);
  if (ledger.status === "failed") {
    throw new Error("run completed with failed candidates");
  }
  return ledger;
}
