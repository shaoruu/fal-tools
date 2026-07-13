import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";

import { assertSafeData, assertSafeRelativePath } from "./security.js";
import type {
  JsonObject,
  JsonValue,
  Manifest,
  PostStep,
  QaProfile,
} from "./types.js";

const maxDocumentBytes = 1024 * 1024;

const jsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string().max(100_000),
    z.array(jsonSchema).max(1_000),
    z.record(z.string().max(100), jsonSchema),
  ]),
);

const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string().max(100),
  jsonSchema,
);

const relativePathSchema = z
  .string()
  .max(240)
  .superRefine((value, context) => {
    try {
      assertSafeRelativePath(value, "path");
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid path",
      });
    }
  });

const postStepSchema: z.ZodType<PostStep> = z
  .object({
    type: z.string().min(1).max(100),
  })
  .catchall(jsonSchema);

const jobSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    kind: z.enum(["image", "audio"]),
    provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    model: z.string().min(1).max(200),
    prompt: z.string().min(1).max(100_000).optional(),
    promptFile: relativePathSchema.optional(),
    input: jsonObjectSchema.default({}),
    variants: z.number().int().min(1).max(100).default(1),
    output: z.strictObject({
      stem: relativePathSchema,
      format: z.string().regex(/^[a-z0-9]{2,8}$/),
    }),
    post: z.array(postStepSchema).max(20).default([]),
    qa: relativePathSchema,
  })
  .superRefine((job, context) => {
    if ((job.prompt === undefined) === (job.promptFile === undefined)) {
      context.addIssue({
        code: "custom",
        message: "exactly one of prompt or promptFile is required",
      });
    }
    try {
      assertSafeData(job.input);
      for (const step of job.post) {
        assertSafeData(step, "post");
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "unsafe input",
      });
    }
  });

export const manifestSchema = z
  .strictObject({
    version: z.literal(1),
    concurrency: z.number().int().min(1).max(32).default(2),
    budget: z
      .strictObject({
        maxCostUsd: z.number().positive(),
      })
      .optional(),
    jobs: z.array(jobSchema).min(1).max(1_000),
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const job of manifest.jobs) {
      if (ids.has(job.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate job id: ${job.id}`,
        });
      }
      ids.add(job.id);
    }
  });

export const qaProfileSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["image", "audio"]),
  checks: z.record(
    z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    z.union([z.boolean(), z.number()]),
  ),
});

export interface LoadedManifest {
  readonly baseDirectory: string;
  readonly manifest: Manifest;
  readonly sourcePath: string;
}

function parseDocumentValue(source: string, extension: string): JsonValue {
  if (Buffer.byteLength(source) > maxDocumentBytes) {
    throw new Error("document exceeds the 1 MiB limit");
  }

  if (extension === ".json") {
    return JSON.parse(source) as JsonValue;
  }
  if (extension !== ".yaml" && extension !== ".yml") {
    throw new Error("document must use .json, .yaml, or .yml");
  }

  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((entry) => entry.message).join("; "));
  }
  return document.toJS({ maxAliasCount: 0 }) as JsonValue;
}

export async function loadManifest(
  manifestPath: string,
): Promise<LoadedManifest> {
  const sourcePath = path.resolve(manifestPath);
  const source = await readFile(sourcePath, "utf8");
  const value = parseDocumentValue(
    source,
    path.extname(sourcePath).toLowerCase(),
  );
  return {
    baseDirectory: path.dirname(sourcePath),
    manifest: manifestSchema.parse(value) as Manifest,
    sourcePath,
  };
}

export async function loadQaProfile(profilePath: string): Promise<QaProfile> {
  const source = await readFile(profilePath, "utf8");
  const value = parseDocumentValue(
    source,
    path.extname(profilePath).toLowerCase(),
  );
  return qaProfileSchema.parse(value);
}

export async function loadSelection(selectionPath: string): Promise<JsonValue> {
  const source = await readFile(selectionPath, "utf8");
  return parseDocumentValue(source, path.extname(selectionPath).toLowerCase());
}
