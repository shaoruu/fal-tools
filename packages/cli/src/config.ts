import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  createPipeline,
  type JsonObject,
  type Pipeline,
} from "@fal-tools/core";
import { audioInspector, audioProcessor } from "@fal-tools/audio";
import { imageInspector, imageProcessor } from "@fal-tools/image";
import {
  createFalProvider,
  type FalModelDefinition,
} from "@fal-tools/provider-fal";
import { parseDocument } from "yaml";
import { z } from "zod";

const modelSchema = z.strictObject({
  kind: z.enum(["image", "audio"]),
  artifactPath: z.array(z.string().min(1).max(100)).min(1).max(20),
  allowedInputKeys: z
    .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/))
    .max(100)
    .default([]),
  pricing: z
    .strictObject({
      perCallUsd: z.number().min(0),
      source: z.string().min(1).max(500),
      timestamp: z.iso.datetime(),
    })
    .optional(),
});

const configSchema = z.strictObject({
  version: z.literal(1),
  providers: z.strictObject({
    fal: z.strictObject({
      models: z.record(z.string().min(1).max(200), modelSchema),
    }),
  }),
});

export async function createCliPipeline(
  manifestPath: string,
): Promise<Pipeline> {
  const configPath = path.join(
    path.dirname(path.resolve(manifestPath)),
    "fal-tools.config.yaml",
  );
  const source = await readFile(configPath, "utf8").catch(() => {
    throw new Error(
      `missing provider configuration: ${path.basename(configPath)}`,
    );
  });
  if (Buffer.byteLength(source) > 1024 * 1024) {
    throw new Error("provider configuration exceeds the 1 MiB limit");
  }
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((entry) => entry.message).join("; "));
  }
  const config = configSchema.parse(document.toJS({ maxAliasCount: 0 }));
  const models: Record<string, FalModelDefinition> = {};
  for (const [model, definition] of Object.entries(
    config.providers.fal.models,
  )) {
    const shape = Object.fromEntries(
      definition.allowedInputKeys.map((key) => [key, z.json().optional()]),
    );
    models[model] = {
      kind: definition.kind,
      artifactPath: definition.artifactPath,
      inputSchema: z.strictObject(shape) as z.ZodType<JsonObject>,
      ...(definition.pricing === undefined
        ? {}
        : {
            pricing: {
              currency: "USD",
              perCallMicros: Math.ceil(
                definition.pricing.perCallUsd * 1_000_000,
              ),
              source: definition.pricing.source,
              timestamp: definition.pricing.timestamp,
            },
          }),
    };
  }

  return createPipeline({
    providers: {
      fal: createFalProvider({ models }),
    },
    processors: {
      audio: audioProcessor,
      image: imageProcessor,
    },
    inspectors: {
      audio: audioInspector,
      image: imageInspector,
    },
  });
}

export function createAuditPipeline(): Pipeline {
  return createPipeline({
    providers: {},
    inspectors: {
      audio: audioInspector,
      image: imageInspector,
    },
  });
}
