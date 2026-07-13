import { constants } from "node:fs";
import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { loadSelection } from "./manifest.js";
import { assertSafeRelativePath, sha256 } from "./security.js";
import type { RunLedger, Selection } from "./types.js";

const selectionSchema = z
  .strictObject({
    version: z.literal(1),
    candidates: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z][a-z0-9-]{0,63}\.\d{2,3}$/),
          to: z.string().min(1).max(240),
        }),
      )
      .min(1)
      .max(1_000),
  })
  .superRefine((selection, context) => {
    const ids = new Set<string>();
    const outputs = new Set<string>();
    for (const candidate of selection.candidates) {
      try {
        assertSafeRelativePath(candidate.to, "selection destination");
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof Error ? error.message : "invalid destination",
        });
      }
      if (candidate.to.split(/[\\/]/u).includes(".git")) {
        context.addIssue({
          code: "custom",
          message: "selection destination must not target repository metadata",
        });
      }
      if (ids.has(candidate.id)) {
        context.addIssue({
          code: "custom",
          message: `candidate selected more than once: ${candidate.id}`,
        });
      }
      ids.add(candidate.id);
      const outputKey = candidate.to.toLocaleLowerCase("en-US");
      if (outputs.has(outputKey)) {
        context.addIssue({
          code: "custom",
          message: `export collision: ${candidate.to}`,
        });
      }
      outputs.add(outputKey);
    }
  });

export interface ExportResult {
  readonly exported: readonly {
    readonly candidateId: string;
    readonly path: string;
  }[];
}

export async function exportSelection(
  selectionPath: string,
  runDirectory: string,
  destination: string,
): Promise<ExportResult> {
  const selection = selectionSchema.parse(
    await loadSelection(selectionPath),
  ) as Selection;
  const runRoot = await realpath(path.resolve(runDirectory));
  const ledger = JSON.parse(
    await readFile(path.join(runRoot, "run.json"), "utf8"),
  ) as RunLedger;
  const destinationRoot = path.resolve(destination);
  await mkdir(destinationRoot, { recursive: true });
  const resolvedDestinationRoot = await realpath(destinationRoot);
  const exported: { candidateId: string; path: string }[] = [];

  for (const selected of selection.candidates) {
    const candidate = ledger.candidates.find(
      (entry) => entry.id === selected.id,
    );
    if (candidate === undefined) {
      throw new Error(`candidate does not exist: ${selected.id}`);
    }
    const audit = ledger.audits.find(
      (entry) => entry.candidateId === selected.id,
    );
    if (audit?.passed !== true) {
      throw new Error(`candidate has not passed required QA: ${selected.id}`);
    }

    const sourcePath = path.resolve(runRoot, candidate.path);
    const sourceRelative = path.relative(runRoot, sourcePath);
    if (
      sourceRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(sourceRelative)
    ) {
      throw new Error(`candidate path escapes the run: ${selected.id}`);
    }
    const bytes = await readFile(sourcePath);
    if (sha256(bytes) !== candidate.contentHash) {
      throw new Error(`candidate hash verification failed: ${selected.id}`);
    }

    const targetPath = path.resolve(resolvedDestinationRoot, selected.to);
    const targetRelative = path.relative(resolvedDestinationRoot, targetPath);
    if (
      targetRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(targetRelative)
    ) {
      throw new Error(`export path escapes the destination: ${selected.to}`);
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    const resolvedParent = await realpath(path.dirname(targetPath));
    const parentRelative = path.relative(
      resolvedDestinationRoot,
      resolvedParent,
    );
    if (
      parentRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(parentRelative)
    ) {
      throw new Error(`export parent escapes the destination: ${selected.to}`);
    }
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
    exported.push({
      candidateId: selected.id,
      path: selected.to.replaceAll("\\", "/"),
    });
  }

  return { exported };
}
