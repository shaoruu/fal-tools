export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AssetKind = "audio" | "image";

export type Price = {
  amountUsd: number;
  retrievedAt: string;
  source: string;
  unit: "call";
};

export type ModelCapability = {
  kinds: AssetKind[];
  outputFormats: string[];
  price?: Price;
};

export type ProviderRequest = {
  input: JsonObject;
  kind: AssetKind;
  model: string;
  outputFormat: string;
  prompt: string;
};

export type ProviderResult = {
  bytes: Uint8Array;
  mediaType?: string;
  requestId?: string;
};

export type GenerationProvider = {
  generate(request: ProviderRequest): Promise<ProviderResult>;
  getCapability(model: string): ModelCapability | undefined;
  isTransientError(error: Error): boolean;
};

export type Providers = Record<string, GenerationProvider>;

export type Logger = {
  debug(message: string, fields?: JsonObject): void;
  error(message: string, fields?: JsonObject): void;
  info(message: string, fields?: JsonObject): void;
  warn(message: string, fields?: JsonObject): void;
};

export type Clock = {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
};

export type OutputSpec = {
  format: string;
  stem: string;
};

export type ImageQaProfile = {
  isAlphaRequired?: boolean;
  isDuplicateAllowed?: boolean;
  minHeight?: number;
  minWidth?: number;
};

export type AudioQaProfile = {
  maxClippedSampleRatio?: number;
  maxPeakDbfs?: number;
  maxSeamDelta?: number;
  maxTailEnergyRatio?: number;
  minDurationSeconds?: number;
};

export type QaProfile = {
  audio?: AudioQaProfile;
  image?: ImageQaProfile;
};

export type Variant = {
  id: string;
  input?: JsonObject;
};

export type ImagePostStep = {
  background?: string;
  format?: "avif" | "jpeg" | "png" | "webp";
  quality?: number;
  type: "image-convert";
};

export type AudioPostStep = {
  channels?: number;
  format?: "flac" | "mp3" | "wav";
  sampleRate?: number;
  type: "audio-convert";
};

export type PostStep = AudioPostStep | ImagePostStep;

export type ManifestJob = {
  id: string;
  input: JsonObject;
  kind: AssetKind;
  model: string;
  output: OutputSpec;
  post?: PostStep[];
  prompt?: string;
  promptFile?: string;
  provider: string;
  qa?: QaProfile;
  variants?: number | Variant[];
};

export type ManifestBudget = {
  isUnpricedCallsAllowed?: boolean;
  maxCalls?: number;
  maxCostUsd?: number;
};

export type Manifest = {
  budget?: ManifestBudget;
  capabilities?: Record<string, Record<string, ModelCapability>>;
  concurrency?: number;
  jobs: ManifestJob[];
  version: 1;
};

export type PlannedCall = {
  cacheKey: string;
  candidateId: string;
  costUsd: number | null;
  input: JsonObject;
  jobId: string;
  kind: AssetKind;
  model: string;
  output: OutputSpec;
  post: PostStep[];
  price: Price | null;
  providerFormat: string;
  promptFile?: string;
  promptHash: string;
  provider: string;
  qa?: QaProfile;
  variantId: string;
};

export type PipelinePlan = {
  callCount: number;
  calls: PlannedCall[];
  createdAt: string;
  estimatedCostUsd: number;
  isPricingUnknown: boolean;
  manifestHash: string;
  planHash: string;
  version: 1;
};

export type CandidateAudit = {
  checks: JsonObject;
  isPassed: boolean;
  profile: QaProfile;
};

export type CandidateRecord = {
  audit?: CandidateAudit;
  cacheKey: string;
  candidateId: string;
  contentHash: string;
  file: string;
  jobId: string;
  kind: AssetKind;
  qa?: QaProfile;
  requestId?: string;
  sizeBytes: number;
  status: "completed";
  variantId: string;
};

export type FailedCallRecord = {
  candidateId: string;
  errorCode: string;
  status: "failed";
};

export type RunLedger = {
  candidates: CandidateRecord[];
  completedAt?: string;
  createdAt: string;
  failures: FailedCallRecord[];
  manifestHash: string;
  planHash: string;
  status: "completed" | "failed" | "running";
  version: 1;
};

export type RunOptions = {
  isResume?: boolean;
  isUnpricedCallsAllowed?: boolean;
  maxCalls: number;
  maxCostUsd?: number;
  outDir: string;
};

export type AuditContext = {
  candidate: CandidateRecord;
  duplicateCandidateIds: string[];
  filePath: string;
  profile: QaProfile;
};

export type AssetAuditor = {
  audit(context: AuditContext): Promise<CandidateAudit>;
};

export type AssetAuditors = Partial<Record<AssetKind, AssetAuditor>>;

export type ProcessContext = {
  bytes: Uint8Array;
  format: string;
  steps: PostStep[];
};

export type AssetProcessor = {
  process(context: ProcessContext): Promise<Uint8Array>;
};

export type AssetProcessors = Partial<Record<AssetKind, AssetProcessor>>;

export type PipelineDependencies = {
  auditors?: AssetAuditors;
  clock?: Clock;
  logger?: Logger;
  processors?: AssetProcessors;
  providers: Providers;
};

export type PlanOptions = {
  manifestPath: string;
};

export type AuditOptions = {
  profilePath?: string;
  runPath: string;
};

export type ExportOptions = {
  destinationDir: string;
  runDir: string;
  selectionPath: string;
};
