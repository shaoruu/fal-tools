import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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

function findAssetUrl(
  value: JsonValue,
  kind?: "audio" | "image",
): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = findAssetUrl(entry, kind);
      if (url !== undefined) {
        return url;
      }
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    const preferred = kind === undefined ? undefined : value[kind];
    if (preferred !== undefined) {
      const preferredUrl = findAssetUrl(preferred, kind);
      if (preferredUrl !== undefined) {
        return preferredUrl;
      }
    }
    const directUrl = value.url;
    if (typeof directUrl === "string" && /^https:\/\//i.test(directUrl)) {
      return directUrl;
    }
    for (const entry of Object.values(value)) {
      const url = findAssetUrl(entry, kind);
      if (url !== undefined) {
        return url;
      }
    }
  }
  return undefined;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const first = octets[0] ?? 0;
    const second = octets[1] ?? 0;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }
  const normalized = address.toLocaleLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

async function assertSafeDownloadUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:") {
    throw new Error("fal asset URL must use HTTPS");
  }
  const hostname = url.hostname.toLocaleLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("fal asset URL cannot target a local host");
  }
  const addresses =
    isIP(hostname) === 0
      ? await lookup(hostname, { all: true, verbatim: true })
      : [{ address: hostname }];
  if (
    addresses.length === 0 ||
    addresses.some((entry) => isPrivateAddress(entry.address))
  ) {
    throw new Error("fal asset URL resolved to a private network");
  }
}

function assertMediaFormat(
  bytes: Uint8Array,
  mediaType: string | undefined,
  kind: "audio" | "image",
  format: string,
): void {
  if (
    mediaType !== undefined &&
    mediaType !== "application/octet-stream" &&
    !mediaType.startsWith(`${kind}/`)
  ) {
    throw new Error("fal asset media type does not match the planned kind");
  }
  const signature = Buffer.from(bytes.subarray(0, 12));
  const isExpected =
    (format === "png" &&
      signature
        .subarray(0, 8)
        .equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    (format === "jpeg" && signature[0] === 0xff && signature[1] === 0xd8) ||
    (format === "webp" &&
      signature.toString("ascii", 0, 4) === "RIFF" &&
      signature.toString("ascii", 8, 12) === "WEBP") ||
    (format === "wav" &&
      signature.toString("ascii", 0, 4) === "RIFF" &&
      signature.toString("ascii", 8, 12) === "WAVE") ||
    (format === "flac" && signature.toString("ascii", 0, 4) === "fLaC") ||
    (format === "mp3" &&
      (signature.toString("ascii", 0, 3) === "ID3" ||
        (signature[0] === 0xff && ((signature[1] ?? 0) & 0xe0) === 0xe0))) ||
    !["flac", "jpeg", "mp3", "png", "wav", "webp"].includes(format);
  if (!isExpected) {
    throw new Error("fal asset bytes do not match the planned format");
  }
}

async function downloadAsset(
  url: string,
  fetcher: typeof fetch,
  kind: "audio" | "image",
  format: string,
): Promise<{ bytes: Uint8Array; mediaType?: string }> {
  let currentUrl = new URL(url);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    await assertSafeDownloadUrl(currentUrl);
    response = await fetcher(currentUrl, {
      headers: { accept: "audio/*, image/*, application/octet-stream" },
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      break;
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (location === null || redirect === 5) {
      throw new Error("fal asset download exceeded safe redirects");
    }
    currentUrl = new URL(location, currentUrl);
    response = undefined;
  }
  if (response === undefined) {
    throw new Error("fal asset download did not produce a response");
  }
  if (!response.ok) {
    throw new Error(`fal asset download failed with status ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 512 * 1024 * 1024) {
    throw new Error("fal asset exceeds the 512 MiB download limit");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    size += result.value.length;
    if (size > 512 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("fal asset exceeds the 512 MiB download limit");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const mediaType = response.headers.get("content-type")?.split(";")[0];
  assertMediaFormat(bytes, mediaType, kind, format);
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
      retry: { maxRetries: 0 },
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
    const assetUrl = findAssetUrl(data, request.kind);
    if (assetUrl === undefined) {
      throw new Error(
        "fal response did not contain a supported HTTPS asset URL",
      );
    }
    return {
      ...(await downloadAsset(
        assetUrl,
        this.#fetcher,
        request.kind,
        request.outputFormat,
      )),
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
