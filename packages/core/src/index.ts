import { auditRun, type AuditOptions } from "./audit.js";
import { exportSelection, type ExportResult } from "./export.js";
import { preparePlan, type PlanOptions } from "./plan.js";
import { runPipeline, type RunOptions } from "./run.js";
import type {
  AssetInspector,
  AssetProcessor,
  Clock,
  GenerationProvider,
  Logger,
  PipelinePlan,
  RunLedger,
} from "./types.js";

const defaultLogger: Logger = {
  error(event, fields) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", event, ...fields })}\n`,
    );
  },
  info(event, fields) {
    process.stderr.write(
      `${JSON.stringify({ level: "info", event, ...fields })}\n`,
    );
  },
  warn(event, fields) {
    process.stderr.write(
      `${JSON.stringify({ level: "warn", event, ...fields })}\n`,
    );
  },
};

const defaultClock: Clock = {
  now: () => new Date(),
  sleep: async (milliseconds) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};

export interface PipelineConfiguration {
  readonly clock?: Clock;
  readonly inspectors?: Partial<Record<"audio" | "image", AssetInspector>>;
  readonly logger?: Logger;
  readonly processors?: Partial<Record<"audio" | "image", AssetProcessor>>;
  readonly providers: Readonly<Record<string, GenerationProvider>>;
}

export interface Pipeline {
  audit(
    runPath: string,
    options?: Pick<AuditOptions, "profilePath">,
  ): Promise<RunLedger>;
  export(
    selectionPath: string,
    runDirectory: string,
    destination: string,
  ): Promise<ExportResult>;
  plan(manifestPath: string, options?: PlanOptions): Promise<PipelinePlan>;
  run(manifestPath: string, options: RunOptions): Promise<RunLedger>;
}

export function createPipeline(configuration: PipelineConfiguration): Pipeline {
  const logger = configuration.logger ?? defaultLogger;
  const clock = configuration.clock ?? defaultClock;
  const processors = configuration.processors ?? {};
  const inspectors = configuration.inspectors ?? {};

  return Object.freeze({
    async plan(manifestPath: string, options: PlanOptions = {}) {
      return (
        await preparePlan(
          manifestPath,
          configuration.providers,
          options,
          clock.now().toISOString(),
        )
      ).plan;
    },
    async run(manifestPath: string, options: RunOptions) {
      return runPipeline(manifestPath, options, {
        providers: configuration.providers,
        processors,
        logger,
        clock,
      });
    },
    async audit(
      runPath: string,
      options: Pick<AuditOptions, "profilePath"> = {},
    ) {
      return auditRun(runPath, {
        inspectors,
        ...(options.profilePath === undefined
          ? {}
          : { profilePath: options.profilePath }),
      });
    },
    async export(
      selectionPath: string,
      runDirectory: string,
      destination: string,
    ) {
      return exportSelection(selectionPath, runDirectory, destination);
    },
  });
}

export { auditRun } from "./audit.js";
export { exportSelection } from "./export.js";
export { loadManifest, loadQaProfile } from "./manifest.js";
export { preparePlan } from "./plan.js";
export { redactMessage, sha256 } from "./security.js";
export { runPipeline } from "./run.js";
export {
  ProviderFailure,
  type AssetInspector,
  type AssetKind,
  type AssetProcessor,
  type AuditRecord,
  type CandidateRecord,
  type Clock,
  type GenerationProvider,
  type GenerationRequest,
  type GenerationResult,
  type InspectionResult,
  type JsonObject,
  type JsonValue,
  type Logger,
  type Manifest,
  type ModelCapability,
  type PipelinePlan,
  type PlanCall,
  type PostStep,
  type PriceQuote,
  type ProcessRequest,
  type QaCheck,
  type QaProfile,
  type RunLedger,
  type Selection,
} from "./types.js";
export type { AuditOptions } from "./audit.js";
export type { ExportResult } from "./export.js";
export type { PlanOptions } from "./plan.js";
export type { RunOptions } from "./run.js";
