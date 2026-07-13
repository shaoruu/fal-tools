import { z } from "zod";

export const jsonObjectSchema = z.record(z.string(), z.json());

const outputSchema = z
  .object({
    format: z.string().regex(/^[a-z0-9]+$/),
    stem: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
  })
  .strict();

const imagePostStepSchema = z
  .object({
    background: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    format: z.enum(["avif", "jpeg", "png", "webp"]).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    type: z.literal("image-convert"),
  })
  .strict();

const audioPostStepSchema = z
  .object({
    channels: z.number().int().min(1).max(8).optional(),
    format: z.enum(["flac", "mp3", "wav"]).optional(),
    sampleRate: z.number().int().min(8_000).max(192_000).optional(),
    type: z.literal("audio-convert"),
  })
  .strict();

const imageQaSchema = z
  .object({
    isAlphaRequired: z.boolean().optional(),
    isDuplicateAllowed: z.boolean().optional(),
    minHeight: z.number().int().positive().optional(),
    minWidth: z.number().int().positive().optional(),
  })
  .strict();

const audioQaSchema = z
  .object({
    maxClippedSampleRatio: z.number().min(0).max(1).optional(),
    maxPeakDbfs: z.number().max(0).optional(),
    maxSeamDelta: z.number().min(0).max(2).optional(),
    maxTailEnergyRatio: z.number().min(0).optional(),
    minDurationSeconds: z.number().positive().optional(),
  })
  .strict();

export const qaProfileSchema = z
  .object({
    audio: audioQaSchema.optional(),
    image: imageQaSchema.optional(),
  })
  .strict();

const variantSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
    input: jsonObjectSchema.optional(),
  })
  .strict();

const jobSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
    input: jsonObjectSchema.default({}),
    kind: z.enum(["audio", "image"]),
    model: z.string().min(1),
    output: outputSchema,
    post: z
      .array(z.union([imagePostStepSchema, audioPostStepSchema]))
      .optional(),
    prompt: z.string().min(1).optional(),
    promptFile: z.string().min(1).optional(),
    provider: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
    qa: qaProfileSchema.optional(),
    variants: z
      .union([
        z.number().int().min(1).max(1_000),
        z.array(variantSchema).min(1),
      ])
      .optional(),
  })
  .strict()
  .refine(
    (job) => (job.prompt === undefined) !== (job.promptFile === undefined),
    {
      message: "exactly one of prompt or promptFile is required",
    },
  );

export const manifestSchema = z
  .object({
    budget: z
      .object({
        isUnpricedCallsAllowed: z.boolean().optional(),
        maxCalls: z.number().int().positive().optional(),
        maxCostUsd: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    capabilities: z
      .record(
        z.string(),
        z.record(
          z.string(),
          z
            .object({
              kinds: z.array(z.enum(["audio", "image"])).min(1),
              outputFormats: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1),
              price: z
                .object({
                  amountUsd: z.number().nonnegative(),
                  retrievedAt: z.iso.datetime(),
                  source: z.string().min(1),
                  unit: z.literal("call"),
                })
                .strict()
                .optional(),
            })
            .strict(),
        ),
      )
      .optional(),
    concurrency: z.number().int().min(1).max(64).optional(),
    jobs: z.array(jobSchema).min(1),
    version: z.literal(1),
  })
  .strict();

export const selectionSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            as: z.string().min(1),
            id: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    version: z.literal(1),
  })
  .strict();

export const runLedgerSchema = z
  .object({
    candidates: z.array(
      z
        .object({
          audit: z
            .object({
              checks: jsonObjectSchema,
              isPassed: z.boolean(),
              profile: qaProfileSchema,
            })
            .strict()
            .optional(),
          cacheKey: z.string(),
          candidateId: z.string(),
          contentHash: z.string(),
          file: z.string(),
          jobId: z.string(),
          kind: z.enum(["audio", "image"]),
          qa: qaProfileSchema.optional(),
          requestId: z.string().optional(),
          sizeBytes: z.number().int().nonnegative(),
          status: z.literal("completed"),
          variantId: z.string(),
        })
        .strict(),
    ),
    completedAt: z.string().optional(),
    createdAt: z.string(),
    failures: z.array(
      z
        .object({
          candidateId: z.string(),
          errorCode: z.string(),
          status: z.literal("failed"),
        })
        .strict(),
    ),
    manifestHash: z.string(),
    planHash: z.string(),
    status: z.enum(["completed", "failed", "running"]),
    version: z.literal(1),
  })
  .strict();
