import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  loadQaProfile,
  loadRunLedger,
  resolveContainedExisting,
  sha256,
  writeJsonAtomic,
} from "./io.js";
import type {
  AssetAuditors,
  AuditOptions,
  CandidateRecord,
  QaProfile,
  RunLedger,
} from "./types.js";

function minimum(
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

function maximum(
  first: number | undefined,
  second: number | undefined,
): number | undefined {
  if (first === undefined) {
    return second;
  }
  if (second === undefined) {
    return first;
  }
  return Math.max(first, second);
}

function combineProfiles(
  mandatory: QaProfile,
  supplemental: QaProfile,
): QaProfile {
  const image =
    mandatory.image === undefined && supplemental.image === undefined
      ? undefined
      : {
          isAlphaRequired:
            mandatory.image?.isAlphaRequired === true ||
            supplemental.image?.isAlphaRequired === true,
          isDuplicateAllowed:
            mandatory.image?.isDuplicateAllowed === true &&
            supplemental.image?.isDuplicateAllowed !== false,
          minHeight: maximum(
            mandatory.image?.minHeight,
            supplemental.image?.minHeight,
          ),
          minWidth: maximum(
            mandatory.image?.minWidth,
            supplemental.image?.minWidth,
          ),
        };
  const audio =
    mandatory.audio === undefined && supplemental.audio === undefined
      ? undefined
      : {
          maxClippedSampleRatio: minimum(
            mandatory.audio?.maxClippedSampleRatio,
            supplemental.audio?.maxClippedSampleRatio,
          ),
          maxPeakDbfs: minimum(
            mandatory.audio?.maxPeakDbfs,
            supplemental.audio?.maxPeakDbfs,
          ),
          maxSeamDelta: minimum(
            mandatory.audio?.maxSeamDelta,
            supplemental.audio?.maxSeamDelta,
          ),
          maxTailEnergyRatio: minimum(
            mandatory.audio?.maxTailEnergyRatio,
            supplemental.audio?.maxTailEnergyRatio,
          ),
          minDurationSeconds: maximum(
            mandatory.audio?.minDurationSeconds,
            supplemental.audio?.minDurationSeconds,
          ),
        };
  return {
    ...(audio === undefined ? {} : { audio }),
    ...(image === undefined ? {} : { image }),
  };
}

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
  if (ledger.status !== "completed" || ledger.failures.length > 0) {
    throw new Error("only completed, failure-free runs can be audited");
  }
  const overrideProfile =
    options.profilePath === undefined
      ? undefined
      : await loadQaProfile(options.profilePath);

  for (const candidate of ledger.candidates) {
    const auditor = auditors[candidate.kind];
    if (auditor === undefined) {
      throw new Error(`no ${candidate.kind} auditor is configured`);
    }
    const filePath = await resolveContainedExisting(runDir, candidate.file);
    const bytes = await readFile(filePath);
    if (sha256(bytes) !== candidate.contentHash) {
      throw new Error(
        `candidate integrity check failed: ${candidate.candidateId}`,
      );
    }
    const profile =
      overrideProfile === undefined
        ? (candidate.qa ?? {})
        : candidate.qa === undefined
          ? overrideProfile
          : combineProfiles(candidate.qa, overrideProfile);
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
