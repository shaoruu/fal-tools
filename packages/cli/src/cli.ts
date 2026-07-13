import process from "node:process";

import { Command, InvalidArgumentError, Option } from "commander";

import { audioAuditor, audioProcessor } from "@fal-tools/audio";
import {
  createPipeline,
  loadManifest,
  redactText,
  type JsonObject,
  type Logger,
  type Pipeline,
} from "@fal-tools/core";
import { imageAuditor, imageProcessor } from "@fal-tools/image";
import { createFalProvider } from "@fal-tools/provider-fal";

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

function nonnegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError("must be a nonnegative number");
  }
  return parsed;
}

class NamedOption extends Option {
  readonly #attribute: string;

  constructor(flags: string, description: string, attribute: string) {
    super(flags, description);
    this.#attribute = attribute;
  }

  override attributeName(): string {
    return this.#attribute;
  }
}

const logger: Logger = {
  debug: (message, fields) => writeLog("debug", message, fields),
  error: (message, fields) => writeLog("error", message, fields),
  info: (message, fields) => writeLog("info", message, fields),
  warn: (message, fields) => writeLog("warn", message, fields),
};

function writeLog(level: string, message: string, fields?: JsonObject): void {
  const suffix = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
  process.stderr.write(`[${level}] ${message}${suffix}\n`);
}

async function pipelineForManifest(manifestPath: string): Promise<Pipeline> {
  const manifest = await loadManifest(manifestPath);
  const capabilities = manifest.capabilities?.fal ?? {};
  return createPipeline({
    auditors: {
      audio: audioAuditor,
      image: imageAuditor,
    },
    logger,
    processors: {
      audio: audioProcessor,
      image: imageProcessor,
    },
    providers: {
      fal: createFalProvider({ capabilities }),
    },
  });
}

const program = new Command()
  .name("fal-tools")
  .description(
    "Private-first manifest planning, generation, objective QA, and export",
  )
  .version("0.1.0");

program
  .command("plan")
  .argument("<manifest>")
  .addOption(
    new NamedOption("--json", "emit the immutable plan as JSON", "isJson"),
  )
  .action(
    async (
      manifestPath: string,
      options: { isJson?: boolean },
    ): Promise<void> => {
      const pipeline = await pipelineForManifest(manifestPath);
      const plan = await pipeline.plan({ manifestPath });
      if (options.isJson === true) {
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        [
          `Plan ${plan.planHash}`,
          `Calls: ${plan.callCount}`,
          `Known cost: $${plan.estimatedCostUsd.toFixed(4)}`,
          `Pricing: ${plan.isPricingUnknown ? "UNKNOWN" : "KNOWN"}`,
        ].join("\n") + "\n",
      );
    },
  );

program
  .command("run")
  .argument("<manifest>")
  .requiredOption("--out <dir>", "candidate work directory")
  .requiredOption(
    "--max-calls <count>",
    "hard generation-call ceiling",
    positiveInteger,
  )
  .option("--max-cost <usd>", "hard known-cost ceiling", nonnegativeNumber)
  .addOption(
    new NamedOption("--resume", "resume the exact matching plan", "isResume"),
  )
  .action(
    async (
      manifestPath: string,
      options: {
        maxCalls: number;
        maxCost?: number;
        out: string;
        isResume?: boolean;
      },
    ): Promise<void> => {
      const pipeline = await pipelineForManifest(manifestPath);
      const ledger = await pipeline.run({
        manifestPath,
        maxCalls: options.maxCalls,
        ...(options.maxCost === undefined
          ? {}
          : { maxCostUsd: options.maxCost }),
        outDir: options.out,
        ...(options.isResume === undefined
          ? {}
          : { isResume: options.isResume }),
      });
      process.stdout.write(
        `Run ${ledger.status}: ${ledger.candidates.length} candidates\n`,
      );
    },
  );

program
  .command("audit")
  .argument("<run.json>")
  .option("--profile <qa.yaml>", "override the recorded objective QA profile")
  .action(
    async (runPath: string, options: { profile?: string }): Promise<void> => {
      const pipeline = createPipeline({
        auditors: {
          audio: audioAuditor,
          image: imageAuditor,
        },
        providers: {},
      });
      const ledger = await pipeline.audit({
        ...(options.profile === undefined
          ? {}
          : { profilePath: options.profile }),
        runPath,
      });
      const passed = ledger.candidates.filter(
        (candidate) => candidate.audit?.isPassed === true,
      ).length;
      process.stdout.write(
        `Audit: ${passed}/${ledger.candidates.length} candidates passed objective checks\n`,
      );
    },
  );

program
  .command("export")
  .argument("<selection.yaml>")
  .requiredOption("--from <run-dir>", "audited run directory")
  .requiredOption("--to <dest>", "export destination")
  .action(
    async (
      selectionPath: string,
      options: { from: string; to: string },
    ): Promise<void> => {
      const pipeline = createPipeline({ providers: {} });
      const exported = await pipeline.export({
        destinationDir: options.to,
        runDir: options.from,
        selectionPath,
      });
      process.stdout.write(`Exported ${exported.length} selected candidates\n`);
    },
  );

try {
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : "command failed";
  process.stderr.write(`fal-tools: ${redactText(message)}\n`);
  process.exitCode = 1;
}
