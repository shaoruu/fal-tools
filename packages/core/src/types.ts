import type { z } from "zod";

export type AssetKind = "audio" | "image";
export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface PriceQuote {
  readonly currency: "USD";
  readonly perCallMicros: number;
  readonly source: string;
  readonly timestamp: string;
}

export interface ModelCapability {
  readonly inputSchema: z.ZodType<JsonObject>;
  readonly kind: AssetKind;
  readonly pricing?: PriceQuote;
}

export interface GenerationRequest {
  readonly callId: string;
  readonly input: JsonObject;
  readonly kind: AssetKind;
  readonly model: string;
  readonly prompt: string;
}

export interface GenerationResult {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface ProviderFailureOptions {
  readonly code: string;
  readonly isTransient: boolean;
  readonly message: string;
}

export class ProviderFailure extends Error {
  readonly code: string;
  readonly isTransient: boolean;

  constructor(options: ProviderFailureOptions) {
    super(options.message);
    this.name = "ProviderFailure";
    this.code = options.code;
    this.isTransient = options.isTransient;
  }
}

export interface GenerationProvider {
  readonly name: string;
  generate(request: GenerationRequest): Promise<GenerationResult>;
  getModel(model: string): ModelCapability | undefined;
}

export interface Logger {
  error(event: string, fields?: Readonly<Record<string, JsonPrimitive>>): void;
  info(event: string, fields?: Readonly<Record<string, JsonPrimitive>>): void;
  warn(event: string, fields?: Readonly<Record<string, JsonPrimitive>>): void;
}

export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface PostStep {
  readonly [key: string]: JsonValue;
  readonly type: string;
}

export interface QaProfile {
  readonly checks: Readonly<Record<string, boolean | number>>;
  readonly kind: AssetKind;
  readonly version: 1;
}

export interface ManifestJob {
  readonly id: string;
  readonly input: JsonObject;
  readonly kind: AssetKind;
  readonly model: string;
  readonly output: {
    readonly format: string;
    readonly stem: string;
  };
  readonly post: readonly PostStep[];
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly provider: string;
  readonly qa: string;
  readonly variants: number;
}

export interface Manifest {
  readonly budget?: {
    readonly maxCostUsd: number;
  };
  readonly concurrency: number;
  readonly jobs: readonly ManifestJob[];
  readonly version: 1;
}

export interface PlanCall {
  readonly cacheKey: string;
  readonly estimatedCostMicros?: number;
  readonly id: string;
  readonly input: JsonObject;
  readonly jobId: string;
  readonly kind: AssetKind;
  readonly model: string;
  readonly output: string;
  readonly post: readonly PostStep[];
  readonly promptHash: string;
  readonly provider: string;
  readonly qaProfile: QaProfile;
  readonly variant: number;
}

export interface PipelinePlan {
  readonly calls: readonly PlanCall[];
  readonly concurrency: number;
  readonly createdAt: string;
  readonly estimatedCostMicros?: number;
  readonly id: string;
  readonly manifestHash: string;
  readonly pricing: readonly {
    readonly model: string;
    readonly provider: string;
    readonly quote?: PriceQuote;
  }[];
  readonly version: 1;
}

export interface ProcessRequest {
  readonly format: string;
  readonly input: Uint8Array;
  readonly post: readonly PostStep[];
}

export interface AssetProcessor {
  process(request: ProcessRequest): Promise<Uint8Array>;
}

export interface QaCheck {
  readonly id: string;
  readonly measured?: boolean | number | string;
  readonly passed: boolean;
}

export interface InspectionResult {
  readonly checks: readonly QaCheck[];
  readonly measurements: Readonly<Record<string, boolean | number | string>>;
}

export interface AssetInspector {
  inspect(path: string, profile: QaProfile): Promise<InspectionResult>;
}

export interface CandidateRecord {
  readonly byteLength: number;
  readonly cacheKey: string;
  readonly contentHash: string;
  readonly id: string;
  readonly jobId: string;
  readonly kind: AssetKind;
  readonly mediaType: string;
  readonly output: string;
  readonly path: string;
  readonly qaProfile: QaProfile;
  readonly status: "complete";
  readonly variant: number;
}

export interface FailedCallRecord {
  readonly code: string;
  readonly id: string;
  readonly message: string;
  readonly status: "failed";
}

export interface AuditRecord {
  readonly candidateId: string;
  readonly checks: readonly QaCheck[];
  readonly measurements: Readonly<Record<string, boolean | number | string>>;
  readonly passed: boolean;
}

export interface RunLedger {
  readonly audits: readonly AuditRecord[];
  readonly callAttempts: number;
  readonly candidates: readonly CandidateRecord[];
  readonly completedAt: string;
  readonly costMicros: number;
  readonly failures: readonly FailedCallRecord[];
  readonly planId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly version: 1;
}

export interface Selection {
  readonly candidates: readonly {
    readonly id: string;
    readonly to: string;
  }[];
  readonly version: 1;
}
