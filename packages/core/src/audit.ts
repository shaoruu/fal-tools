import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadQaProfile } from "./manifest.js";
import { sha256 } from "./security.js";
import type {
  AssetInspector,
  AuditRecord,
  QaCheck,
  RunLedger,
} from "./types.js";

export interface AuditOptions {
  readonly inspectors: Partial<Record<"audio" | "image", AssetInspector>>;
  readonly profilePath?: string;
}

async function writeLedger(filePath: string, ledger: RunLedger): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

export async function auditRun(
  runPath: string,
  options: AuditOptions,
): Promise<RunLedger> {
  const resolvedRunPath = path.resolve(runPath);
  const runRoot = path.dirname(resolvedRunPath);
  const ledger = JSON.parse(
    await readFile(resolvedRunPath, "utf8"),
  ) as RunLedger;
  const overrideProfile =
    options.profilePath === undefined
      ? undefined
      : await loadQaProfile(options.profilePath);
  const duplicateCounts = new Map<string, number>();
  for (const candidate of ledger.candidates) {
    duplicateCounts.set(
      candidate.contentHash,
      (duplicateCounts.get(candidate.contentHash) ?? 0) + 1,
    );
  }

  const audits: AuditRecord[] = [];
  for (const candidate of ledger.candidates) {
    const inspector = options.inspectors[candidate.kind];
    if (inspector === undefined) {
      throw new Error(`no ${candidate.kind} inspector is configured`);
    }
    const profile = overrideProfile ?? candidate.qaProfile;
    if (profile.kind !== candidate.kind) {
      throw new Error(`QA profile does not match ${candidate.id}`);
    }
    const candidatePath = path.resolve(runRoot, candidate.path);
    const relative = path.relative(runRoot, candidatePath);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`candidate path escapes the run: ${candidate.id}`);
    }
    const bytes = await readFile(candidatePath);
    const checks: QaCheck[] = [
      {
        id: "contentHash",
        measured: sha256(bytes),
        passed: sha256(bytes) === candidate.contentHash,
      },
      {
        id: "duplicateHash",
        measured: duplicateCounts.get(candidate.contentHash) ?? 0,
        passed: (duplicateCounts.get(candidate.contentHash) ?? 0) === 1,
      },
    ];
    const inspected = await inspector.inspect(candidatePath, profile);
    checks.push(...inspected.checks);
    audits.push({
      candidateId: candidate.id,
      checks,
      measurements: inspected.measurements,
      passed: checks.every((check) => check.passed),
    });
  }

  const updated: RunLedger = {
    ...ledger,
    audits,
  };
  await mkdir(runRoot, { recursive: true });
  await writeLedger(resolvedRunPath, updated);
  return updated;
}
