import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  loadQaProfile,
  loadRunLedger,
  resolveContained,
  sha256,
  writeJsonAtomic,
} from "./io.js";
import type {
  AssetAuditors,
  AuditOptions,
  CandidateRecord,
  RunLedger,
} from "./types.js";

function findDuplicates(
  candidate: CandidateRecord,
  candidates: CandidateRecord[],
): string[] {
  return candidates
    .filter(
      (entry) =>
        entry.candidateId !== candidate.candidateId &&
        entry.contentHash === candidate.contentHash,
    )
    .map((entry) => entry.candidateId)
    .sort();
}

export async function auditRun(
  options: AuditOptions,
  auditors: AssetAuditors,
): Promise<RunLedger> {
  const runPath = path.resolve(options.runPath);
  const runDir = path.dirname(runPath);
  const ledger = await loadRunLedger(runPath);
  const overrideProfile =
    options.profilePath === undefined
      ? undefined
      : await loadQaProfile(options.profilePath);

  for (const candidate of ledger.candidates) {
    const auditor = auditors[candidate.kind];
    if (auditor === undefined) {
      throw new Error(`no ${candidate.kind} auditor is configured`);
    }
    const filePath = resolveContained(runDir, candidate.file);
    const bytes = await readFile(filePath);
    if (sha256(bytes) !== candidate.contentHash) {
      throw new Error(
        `candidate integrity check failed: ${candidate.candidateId}`,
      );
    }
    const profile = overrideProfile ?? candidate.qa ?? {};
    candidate.audit = await auditor.audit({
      candidate,
      duplicateCandidateIds: findDuplicates(candidate, ledger.candidates),
      filePath,
      profile,
    });
  }

  await writeJsonAtomic(runPath, ledger);
  return ledger;
}
