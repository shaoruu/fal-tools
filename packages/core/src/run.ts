import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import pLimit from "p-limit";

import {
  assertNoSymlinkComponents,
  loadRunLedger,
  resolveContained,
  resolveContainedExisting,
  sha256,
  writeJsonAtomic,
} from "./io.js";
import { createPlan } from "./plan.js";
import { assertPublicSafe } from "./security.js";
import type {
  AssetProcessors,
  CandidateRecord,
  Clock,
  JsonObject,
  Logger,
  Manifest,
  PipelinePlan,
  PlannedCall,
  Providers,
  RunLedger,
  RunOptions,
} from "./types.js";

type ExecutionBudget = {
  maxCalls: number;
  maxCostUsd?: number;
  usedCalls: number;
  usedCostUsd: number;
};

type CacheIndex = {
  blob: string;
  cacheKey: string;
  contentHash: string;
  requestId?: string;
  version: 1;
};

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
): ExecutionBudget {
  const maxCalls = effectiveLimit(options.maxCalls, manifest.budget?.maxCalls);
  if (
    maxCalls === undefined ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls <= 0 ||
    plan.callCount > maxCalls
  ) {
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
  if (
    maxCostUsd !== undefined &&
    (!Number.isFinite(maxCostUsd) ||
      maxCostUsd < 0 ||
      plan.estimatedCostUsd > maxCostUsd)
  ) {
    throw new Error("known planned cost exceeds the hard max-cost budget");
  }
  return {
    maxCalls,
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    usedCalls: 0,
    usedCostUsd: 0,
  };
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
          await resolveContainedExisting(
            path.dirname(path.resolve(manifestPath)),
            call.promptFile,
          ),
          "utf8",
        );
  assertPublicSafe(prompt, `jobs.${call.jobId}.prompt`);
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
  budget: ExecutionBudget,
): Promise<{ bytes: Uint8Array; requestId?: string }> {
  const provider = providers[call.provider];
  if (provider === undefined) {
    throw new Error(`provider unavailable for ${call.candidateId}`);
  }
  for (let attempt = 1; attempt <= call.maxAttempts; attempt += 1) {
    const attemptCostUsd = call.price?.amountUsd ?? 0;
    if (budget.usedCalls >= budget.maxCalls) {
      throw new Error("hard max-calls budget exhausted before retry");
    }
    if (
      budget.maxCostUsd !== undefined &&
      budget.usedCostUsd + attemptCostUsd > budget.maxCostUsd
    ) {
      throw new Error("hard max-cost budget exhausted before retry");
    }
    budget.usedCalls += 1;
    budget.usedCostUsd += attemptCostUsd;
    try {
      const result = await provider.generate({
        input: call.input,
        kind: call.kind,
        model: call.model,
        outputFormat: call.providerFormat,
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
      if (!isTransient || attempt === call.maxAttempts) {
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
  outDir: string,
  requestId?: string,
): Promise<CandidateRecord> {
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await assertNoSymlinkComponents(outDir, candidatePath);
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

async function readCache(
  cacheRoot: string,
  indexPath: string,
  call: PlannedCall,
): Promise<{ blobPath: string; requestId?: string } | undefined> {
  if (!(await isFilePresent(indexPath))) {
    return undefined;
  }
  const parsed = JSON.parse(await readFile(indexPath, "utf8")) as JsonObject;
  if (
    parsed.version !== 1 ||
    parsed.cacheKey !== call.cacheKey ||
    typeof parsed.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.contentHash) ||
    typeof parsed.blob !== "string" ||
    (parsed.requestId !== undefined && typeof parsed.requestId !== "string")
  ) {
    throw new Error(`cache metadata is invalid for ${call.candidateId}`);
  }
  const blobPath = await resolveContainedExisting(cacheRoot, parsed.blob);
  if (sha256(await readFile(blobPath)) !== parsed.contentHash) {
    throw new Error(`cache integrity check failed for ${call.candidateId}`);
  }
  return {
    blobPath,
    ...(typeof parsed.requestId === "string"
      ? { requestId: parsed.requestId }
      : {}),
  };
}

async function writeCache(
  cacheRoot: string,
  indexPath: string,
  call: PlannedCall,
  bytes: Uint8Array,
  requestId?: string,
): Promise<string> {
  const contentHash = sha256(bytes);
  const blob = path.posix.join("blobs", `${contentHash}.${call.output.format}`);
  const blobPath = resolveContained(cacheRoot, blob);
  await mkdir(path.dirname(blobPath), { recursive: true });
  await mkdir(path.dirname(indexPath), { recursive: true });
  await assertNoSymlinkComponents(cacheRoot, blobPath);
  await assertNoSymlinkComponents(cacheRoot, indexPath);
  try {
    await writeFile(blobPath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST" ||
      sha256(await readFile(blobPath)) !== contentHash
    ) {
      throw error;
    }
  }
  const index: CacheIndex = {
    blob,
    cacheKey: call.cacheKey,
    contentHash,
    ...(requestId === undefined ? {} : { requestId }),
    version: 1,
  };
  await writeJsonAtomic(indexPath, index);
  return blobPath;
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
  budget: ExecutionBudget,
): Promise<CandidateRecord> {
  const cacheRoot = path.join(outDir, ".fal-tools", "cache");
  await mkdir(cacheRoot, { recursive: true });
  await assertNoSymlinkComponents(outDir, cacheRoot);
  const indexPath = path.join(cacheRoot, "requests", `${call.cacheKey}.json`);
  const candidatePath = path.join(
    outDir,
    "candidates",
    `${call.output.stem}.${call.variantId}.${call.output.format}`,
  );
  const cached = await readCache(cacheRoot, indexPath, call);
  if (cached !== undefined) {
    logger.info("using content-addressed cache", {
      candidateId: call.candidateId,
    });
    return materializeCandidate(
      call,
      cached.blobPath,
      candidatePath,
      outDir,
      cached.requestId,
    );
  }

  const prompt = await loadPrompt(manifest, manifestPath, call);
  const generated = await generateWithRetry(
    call,
    prompt,
    providers,
    clock,
    logger,
    budget,
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
  const blobPath = await writeCache(
    cacheRoot,
    indexPath,
    call,
    bytes,
    generated.requestId,
  );
  return materializeCandidate(
    call,
    blobPath,
    candidatePath,
    outDir,
    generated.requestId,
  );
}

async function isCandidateIntact(
  candidate: CandidateRecord,
  outDir: string,
): Promise<boolean> {
  try {
    const filePath = await resolveContainedExisting(outDir, candidate.file);
    return sha256(await readFile(filePath)) === candidate.contentHash;
  } catch {
    return false;
  }
}

async function assertStoredPlan(
  planPath: string,
  expectedPlanHash: string,
): Promise<void> {
  const stored = JSON.parse(await readFile(planPath, "utf8")) as {
    planHash?: string;
  };
  if (stored.planHash !== expectedPlanHash) {
    throw new Error("stored plan does not match the immutable plan");
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
  const budget = assertBudgets(manifest, plan, options);
  const outDir = path.resolve(options.outDir);
  const ledgerPath = path.join(outDir, "run.json");
  const planPath = path.join(outDir, "plan.json");
  await mkdir(outDir, { recursive: true });
  if ((await lstat(outDir)).isSymbolicLink()) {
    throw new Error("run directory cannot be a symlink");
  }
  const isLedgerPresent = await isFilePresent(ledgerPath);
  const isPlanPresent = await isFilePresent(planPath);
  if (isLedgerPresent && options.isResume !== true) {
    throw new Error("run directory already contains a ledger; use --resume");
  }
  if (isPlanPresent) {
    await assertStoredPlan(planPath, plan.planHash);
  } else {
    await writeJsonAtomic(planPath, plan);
  }

  let ledger: RunLedger;
  if (options.isResume === true && isLedgerPresent) {
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
            budget,
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
