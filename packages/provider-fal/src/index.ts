import {
  ApiError,
  createFalClient,
  isRetryableError,
  type FalClient,
} from "@fal-ai/client";

import type {
  GenerationProvider,
  JsonValue,
  ModelCapability,
  ProviderRequest,
  ProviderResult,
} from "@fal-tools/core";

export type FalProviderOptions = {
  capabilities: Record<string, ModelCapability>;
  credentials?: string | (() => string | undefined);
  fetcher?: typeof fetch;
};

function findAssetUrl(value: JsonValue): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = findAssetUrl(entry);
      if (url !== undefined) {
        return url;
      }
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    const directUrl = value.url;
    if (typeof directUrl === "string" && /^https:\/\//i.test(directUrl)) {
      return directUrl;
    }
    for (const entry of Object.values(value)) {
      const url = findAssetUrl(entry);
      if (url !== undefined) {
        return url;
      }
    }
  }
  return undefined;
}

async function downloadAsset(
  url: string,
  fetcher: typeof fetch,
): Promise<{ bytes: Uint8Array; mediaType?: string }> {
  const response = await fetcher(url, {
    headers: { accept: "audio/*, image/*, application/octet-stream" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`fal asset download failed with status ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 512 * 1024 * 1024) {
    throw new Error("fal asset exceeds the 512 MiB download limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 512 * 1024 * 1024) {
    throw new Error("fal asset exceeds the 512 MiB download limit");
  }
  const mediaType = response.headers.get("content-type")?.split(";")[0];
  return {
    bytes,
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}

class FalGenerationProvider implements GenerationProvider {
  readonly #capabilities: Record<string, ModelCapability>;
  readonly #client: FalClient;
  readonly #fetcher: typeof fetch;

  constructor(options: FalProviderOptions) {
    this.#capabilities = structuredClone(options.capabilities);
    this.#client = createFalClient({
      ...(options.credentials === undefined
        ? {}
        : { credentials: options.credentials }),
    });
    this.#fetcher = options.fetcher ?? fetch;
  }

  getCapability(model: string): ModelCapability | undefined {
    return this.#capabilities[model];
  }

  isTransientError(error: Error): boolean {
    if (isRetryableError(error, [408, 429, 500, 502, 503, 504])) {
      return true;
    }
    return (
      error instanceof ApiError &&
      !error.isUserTimeout &&
      (error.status === 408 ||
        error.status === 429 ||
        error.status === 500 ||
        error.status === 502 ||
        error.status === 503 ||
        error.status === 504)
    );
  }

  async generate(request: ProviderRequest): Promise<ProviderResult> {
    const submitted = await this.#client.queue.submit(request.model, {
      input: { ...request.input, prompt: request.prompt },
    });
    await this.#client.queue.subscribeToStatus(request.model, {
      logs: false,
      mode: "polling",
      requestId: submitted.request_id,
    });
    const result = await this.#client.queue.result(request.model, {
      requestId: submitted.request_id,
    });
    const data = JSON.parse(JSON.stringify(result.data)) as JsonValue;
    const assetUrl = findAssetUrl(data);
    if (assetUrl === undefined) {
      throw new Error(
        "fal response did not contain a supported HTTPS asset URL",
      );
    }
    return {
      ...(await downloadAsset(assetUrl, this.#fetcher)),
      requestId: result.requestId,
    };
  }
}

export function createFalProvider(
  options: FalProviderOptions,
): GenerationProvider {
  return new FalGenerationProvider(options);
}

export { findAssetUrl };
