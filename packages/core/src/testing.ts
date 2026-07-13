import { z } from "zod";

import {
  ProviderFailure,
  type GenerationProvider,
  type GenerationRequest,
  type GenerationResult,
  type ModelCapability,
  type PriceQuote,
} from "./index.js";

export interface FakeProviderOptions {
  readonly failuresBeforeSuccess?: number;
  readonly kind?: "audio" | "image";
  readonly name?: string;
  readonly pricing?: PriceQuote;
  readonly result?: GenerationResult;
}

export class FakeProvider implements GenerationProvider {
  readonly calls: GenerationRequest[] = [];
  readonly name: string;
  readonly #capability: ModelCapability;
  readonly #failuresBeforeSuccess: number;
  readonly #result: GenerationResult;

  constructor(options: FakeProviderOptions = {}) {
    this.name = options.name ?? "fake";
    this.#failuresBeforeSuccess = options.failuresBeforeSuccess ?? 0;
    this.#result = options.result ?? {
      bytes: new TextEncoder().encode("synthetic fixture"),
      mediaType: "application/octet-stream",
    };
    this.#capability = {
      kind: options.kind ?? "image",
      inputSchema: z.record(z.string(), z.json()),
      ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    };
  }

  getModel(model: string): ModelCapability | undefined {
    return model === "fixture/model" ? this.#capability : undefined;
  }

  generate(request: GenerationRequest): Promise<GenerationResult> {
    this.calls.push(request);
    if (this.calls.length <= this.#failuresBeforeSuccess) {
      throw new ProviderFailure({
        code: "fixture_transient",
        isTransient: true,
        message: "synthetic transient failure",
      });
    }
    return Promise.resolve(this.#result);
  }
}
