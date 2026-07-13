import { fal } from "@fal-ai/client";
import {
  ProviderFailure,
  type AssetKind,
  type GenerationProvider,
  type GenerationRequest,
  type GenerationResult,
  type JsonObject,
  type JsonValue,
  type ModelCapability,
  type PriceQuote,
} from "@fal-tools/core";
import { z } from "zod";

const defaultMaxDownloadBytes = 100 * 1024 * 1024;

export interface FalModelDefinition {
  readonly artifactPath: readonly string[];
  readonly inputSchema: z.ZodType<JsonObject>;
  readonly kind: AssetKind;
  readonly pricing?: PriceQuote;
}

export interface FalProviderOptions {
  readonly maxDownloadBytes?: number;
  readonly models: Readonly<Record<string, FalModelDefinition>>;
}

function readPath(value: JsonValue, segments: readonly string[]): JsonValue {
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        current[index] === undefined
      ) {
        throw new ProviderFailure({
          code: "invalid_provider_result",
          isTransient: false,
          message: "provider result did not contain the configured artifact",
        });
      }
      current = current[index] as JsonValue;
      continue;
    }
    if (current === null || typeof current !== "object") {
      throw new ProviderFailure({
        code: "invalid_provider_result",
        isTransient: false,
        message: "provider result did not contain the configured artifact",
      });
    }
    const record = current as Readonly<Record<string, JsonValue>>;
    if (!(segment in record)) {
      throw new ProviderFailure({
        code: "invalid_provider_result",
        isTransient: false,
        message: "provider result did not contain the configured artifact",
      });
    }
    current = record[segment] as JsonValue;
  }
  return current;
}

function isTransientFalError(error: Error): boolean {
  return (
    /(?:\b429\b|\b5\d\d\b|ECONNRESET|ETIMEDOUT|fetch failed|network)/i.test(
      error.message,
    ) || error.name === "AbortError"
  );
}

async function downloadArtifact(
  rawUrl: string,
  maxBytes: number,
): Promise<GenerationResult> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new ProviderFailure({
      code: "invalid_artifact_url",
      isTransient: false,
      message: "provider artifact URL must use HTTPS",
    });
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new ProviderFailure({
      code: "artifact_download_failed",
      isTransient: response.status === 429 || response.status >= 500,
      message: "provider artifact download failed",
    });
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) {
    throw new ProviderFailure({
      code: "artifact_too_large",
      isTransient: false,
      message: "provider artifact exceeds the configured limit",
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new ProviderFailure({
      code: "artifact_too_large",
      isTransient: false,
      message: "provider artifact exceeds the configured limit",
    });
  }
  return {
    bytes,
    mediaType:
      response.headers.get("content-type")?.split(";")[0] ??
      "application/octet-stream",
  };
}

export function createFalProvider(
  options: FalProviderOptions,
): GenerationProvider {
  const maxDownloadBytes = options.maxDownloadBytes ?? defaultMaxDownloadBytes;
  if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes < 1) {
    throw new Error("maxDownloadBytes must be a positive integer");
  }

  return Object.freeze({
    name: "fal",
    getModel(model: string): ModelCapability | undefined {
      const definition = options.models[model];
      if (definition === undefined) {
        return undefined;
      }
      return {
        kind: definition.kind,
        inputSchema: definition.inputSchema,
        ...(definition.pricing === undefined
          ? {}
          : { pricing: definition.pricing }),
      };
    },
    async generate(request: GenerationRequest): Promise<GenerationResult> {
      const definition = options.models[request.model];
      if (definition?.kind !== request.kind) {
        throw new ProviderFailure({
          code: "unsupported_model",
          isTransient: false,
          message: "model is not configured",
        });
      }
      if (!process.env.FAL_KEY) {
        throw new ProviderFailure({
          code: "missing_credentials",
          isTransient: false,
          message: "FAL_KEY is required at runtime",
        });
      }
      const validatedInput = definition.inputSchema.parse(request.input);
      const input: JsonObject = {
        ...validatedInput,
        prompt: request.prompt,
      };
      try {
        const result = await fal.subscribe(request.model, {
          input,
          logs: false,
        });
        const data = z.json().parse(result.data) as JsonValue;
        const artifactUrl = readPath(data, definition.artifactPath);
        if (typeof artifactUrl !== "string") {
          throw new ProviderFailure({
            code: "invalid_provider_result",
            isTransient: false,
            message: "configured provider artifact is not a URL",
          });
        }
        return await downloadArtifact(artifactUrl, maxDownloadBytes);
      } catch (error) {
        if (error instanceof ProviderFailure) {
          throw error;
        }
        const normalized =
          error instanceof Error ? error : new Error("provider call failed");
        throw new ProviderFailure({
          code: "fal_request_failed",
          isTransient: isTransientFalError(normalized),
          message: "fal request failed",
        });
      }
    },
  });
}
