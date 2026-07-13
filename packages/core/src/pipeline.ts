import { auditRun } from "./audit.js";
import { exportSelection } from "./export.js";
import { createPlan } from "./plan.js";
import { runPlan } from "./run.js";
import { createRedactingLogger } from "./security.js";
import type {
  AuditOptions,
  Clock,
  ExportOptions,
  Logger,
  PipelineDependencies,
  PipelinePlan,
  PlanOptions,
  RunLedger,
  RunOptions,
} from "./types.js";

const defaultClock: Clock = {
  now: () => new Date(),
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

const silentLogger: Logger = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

export type Pipeline = {
  audit(options: AuditOptions): Promise<RunLedger>;
  export(options: ExportOptions): Promise<string[]>;
  plan(options: PlanOptions): Promise<PipelinePlan>;
  run(options: PlanOptions & RunOptions): Promise<RunLedger>;
};

export function createPipeline(dependencies: PipelineDependencies): Pipeline {
  const clock = dependencies.clock ?? defaultClock;
  const logger = createRedactingLogger(dependencies.logger ?? silentLogger);
  const auditors = dependencies.auditors ?? {};
  const processors = dependencies.processors ?? {};

  return {
    audit: (options) => auditRun(options, auditors),
    export: (options) => exportSelection(options),
    plan: async ({ manifestPath }) =>
      (await createPlan(manifestPath, dependencies.providers, clock)).plan,
    run: ({ manifestPath, ...options }) =>
      runPlan(
        manifestPath,
        options,
        dependencies.providers,
        processors,
        clock,
        logger,
      ),
  };
}
