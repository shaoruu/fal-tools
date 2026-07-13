import { constants as fsConstants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  loadRunLedger,
  loadSelection,
  resolveContained,
  resolveContainedExisting,
  sha256,
} from "./io.js";
import type { ExportOptions, RunLedger } from "./types.js";

async function isFilePresent(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadExportLedger(runPath: string): Promise<RunLedger> {
  try {
    return await loadRunLedger(runPath);
  } catch (error) {
    throw new Error("run ledger validation failed", { cause: error });
  }
}

async function loadExportSelection(
  selectionPath: string,
): ReturnType<typeof loadSelection> {
  try {
    return await loadSelection(selectionPath);
  } catch (error) {
    throw new Error("selection validation failed", { cause: error });
  }
}

export async function exportSelection(
  options: ExportOptions,
): Promise<string[]> {
  const runDir = path.resolve(options.runDir);
  const destinationDir = path.resolve(options.destinationDir);
  const selection = await loadExportSelection(options.selectionPath);
  const ledger = await loadExportLedger(path.join(runDir, "run.json"));
  if (ledger.status !== "completed" || ledger.failures.length > 0) {
    throw new Error("only completed, failure-free runs can be exported");
  }
  const selectedIds = new Set(selection.candidates.map((entry) => entry.id));
  if (selectedIds.size !== selection.candidates.length) {
    throw new Error("selection contains duplicate candidate IDs");
  }
  await mkdir(destinationDir, { recursive: true });
  if ((await lstat(destinationDir)).isSymbolicLink()) {
    throw new Error("export destination cannot be a symlink");
  }

  const normalizedDestinations = new Set<string>();
  const pending: { destinationPath: string; sourcePath: string }[] = [];
  for (const selected of selection.candidates) {
    const candidate = ledger.candidates.find(
      (entry) => entry.candidateId === selected.id,
    );
    if (candidate === undefined) {
      throw new Error(`selected candidate does not exist: ${selected.id}`);
    }
    if (candidate.audit?.isPassed !== true) {
      throw new Error(`selected candidate has not passed QA: ${selected.id}`);
    }
    const sourcePath = await resolveContainedExisting(runDir, candidate.file);
    if (sha256(await readFile(sourcePath)) !== candidate.contentHash) {
      throw new Error(`candidate integrity check failed: ${selected.id}`);
    }
    const destinationPath = resolveContained(destinationDir, selected.as);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await assertNoSymlinkComponents(destinationDir, destinationPath);
    const normalizedDestination = path
      .relative(destinationDir, destinationPath)
      .toLocaleLowerCase("en-US");
    if (normalizedDestinations.has(normalizedDestination)) {
      throw new Error(`selection destination collision: ${selected.as}`);
    }
    normalizedDestinations.add(normalizedDestination);
    if (await isFilePresent(destinationPath)) {
      throw new Error(`export destination already exists: ${selected.as}`);
    }
    pending.push({ destinationPath, sourcePath });
  }
  for (const entry of pending) {
    await copyFile(
      entry.sourcePath,
      entry.destinationPath,
      fsConstants.COPYFILE_EXCL,
    );
  }
  return pending.map((entry) => entry.destinationPath);
}
