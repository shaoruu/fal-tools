import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import {
  manifestSchema,
  qaProfileSchema,
  runLedgerSchema,
  selectionSchema,
} from "./schema.js";
import { assertPublicSafe, assertSafeRelativePath } from "./security.js";
import type { JsonValue, Manifest, QaProfile, RunLedger } from "./types.js";

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function readStructuredFile(filePath: string): Promise<JsonValue> {
  const text = await readFile(filePath, "utf8");
  if (filePath.endsWith(".json")) {
    return JSON.parse(text) as JsonValue;
  }
  return parse(text) as JsonValue;
}

export async function loadManifest(manifestPath: string): Promise<Manifest> {
  const parsed = manifestSchema.parse(await readStructuredFile(manifestPath));
  for (const job of parsed.jobs) {
    assertPublicSafe(job.input, `jobs.${job.id}.input`);
    if (job.prompt !== undefined) {
      assertPublicSafe(job.prompt, `jobs.${job.id}.prompt`);
    }
    if (job.promptFile !== undefined) {
      assertSafeRelativePath(job.promptFile, `jobs.${job.id}.promptFile`);
    }
    assertPublicSafe(job.model, `jobs.${job.id}.model`);
    for (const variant of Array.isArray(job.variants) ? job.variants : []) {
      if (variant.input !== undefined) {
        assertPublicSafe(
          variant.input,
          `jobs.${job.id}.variants.${variant.id}.input`,
        );
      }
    }
  }
  return parsed;
}

export async function loadQaProfile(profilePath: string): Promise<QaProfile> {
  return qaProfileSchema.parse(await readStructuredFile(profilePath));
}

export async function loadRunLedger(runPath: string): Promise<RunLedger> {
  return runLedgerSchema.parse(await readStructuredFile(runPath));
}

export async function loadSelection(selectionPath: string): Promise<{
  candidates: { as: string; id: string }[];
  version: 1;
}> {
  const selection = selectionSchema.parse(
    await readStructuredFile(selectionPath),
  );
  for (const candidate of selection.candidates) {
    assertSafeRelativePath(candidate.as, `selection.${candidate.id}.as`);
  }
  return selection;
}

export function resolveContained(
  baseDir: string,
  relativePath: string,
): string {
  assertSafeRelativePath(relativePath, "path");
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, relativePath);
  if (
    resolved !== resolvedBase &&
    !resolved.startsWith(`${resolvedBase}${path.sep}`)
  ) {
    throw new Error("path escapes its allowed directory");
  }
  return resolved;
}

export async function resolveContainedExisting(
  baseDir: string,
  relativePath: string,
): Promise<string> {
  const resolved = resolveContained(baseDir, relativePath);
  const [realBase, realTarget] = await Promise.all([
    realpath(baseDir),
    realpath(resolved),
  ]);
  if (
    realTarget !== realBase &&
    !realTarget.startsWith(`${realBase}${path.sep}`)
  ) {
    throw new Error("path resolves outside its allowed directory");
  }
  return realTarget;
}

export async function assertNoSymlinkComponents(
  baseDir: string,
  targetPath: string,
): Promise<void> {
  const realBase = await realpath(baseDir);
  const relative = path.relative(realBase, path.resolve(targetPath));
  assertSafeRelativePath(relative, "path");
  let current = realBase;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("symlinked paths are not allowed");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: object,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_WRONLY |
    fsConstants.O_NOFOLLOW;
  const handle = await open(temporaryPath, flags, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
