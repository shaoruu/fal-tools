import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  loadRunLedger,
  loadSelection,
  resolveContained,
  sha256,
} from "./io.js";
import type { ExportOptions } from "./types.js";

export async function exportSelection(
  options: ExportOptions,
): Promise<string[]> {
  const runDir = path.resolve(options.runDir);
  const destinationDir = path.resolve(options.destinationDir);
  const ledger = await loadRunLedger(path.join(runDir, "run.json"));
  const selection = await loadSelection(options.selectionPath);
  const selectedIds = new Set(selection.candidates.map((entry) => entry.id));
  if (selectedIds.size !== selection.candidates.length) {
    throw new Error("selection contains duplicate candidate IDs");
  }

  const exported: string[] = [];
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
    const sourcePath = resolveContained(runDir, candidate.file);
    if (sha256(await readFile(sourcePath)) !== candidate.contentHash) {
      throw new Error(`candidate integrity check failed: ${selected.id}`);
    }
    const destinationPath = resolveContained(destinationDir, selected.as);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    exported.push(destinationPath);
  }
  return exported;
}
