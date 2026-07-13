#!/usr/bin/env node

import process from "node:process";

import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";

import { audioAuditor, audioProcessor } from "@fal-tools/audio";
import {
  createPipeline,
  loadManifest,
  type Manifest,
  type Pipeline,
} from "@fal-tools/core";
import { imageAuditor, imageProcessor } from "@fal-tools/image";
import { createFalProvider } from "@fal-tools/provider-fal";

import {
  classifyFailure,
  createCliLogger,
  detectOutputMode,
  type CommandName,
  type Failure,
  type OutputMode,
  writeFailure,
  writeOutcome,
} from "./output.js";
import packageMetadata from "../package.json" with { type: "json" };

type MachineOptions = {
  isJson?: boolean;
  isJsonl?: boolean;
};

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

function addMachineOptions(command: Command, isJsonlEnabled = false): Command {
  command.addOption(
    new NamedOption("--json", "emit one stable JSON result envelope", "isJson"),
  );
  if (isJsonlEnabled) {
    command.addOption(
      new NamedOption(
        "--jsonl",
        "emit JSONL log events followed by one result event",
        "isJsonl",
      ),
    );
  }
  return command;
}

function modeFor(options: MachineOptions): OutputMode {
  if (options.isJson === true && options.isJsonl === true) {
    throw new InvalidArgumentError("--json and --jsonl cannot be combined");
  }
  if (options.isJsonl === true) {
    return "jsonl";
  }
  if (options.isJson === true) {
    return "json";
  }
  return "human";
}

async function pipelineForManifest(
  manifestPath: string,
  mode: OutputMode,
): Promise<Pipeline> {
  const manifest = await loadManifest(manifestPath);
  const capabilities = manifest.capabilities?.fal ?? {};
  return createPipeline({
    auditors: {
      audio: audioAuditor,
      image: imageAuditor,
    },
    logger: createCliLogger(mode),
    processors: {
      audio: audioProcessor,
      image: imageProcessor,
    },
    providers: {
      fal: createFalProvider({ capabilities }),
    },
  });
}

function modelResult(manifest: Manifest): {
  models: {
    kinds: string[];
    model: string;
    outputFormats: string[];
    pricing:
      | { status: "unpriced" }
      | {
          amountUsd: number;
          retrievedAt: string;
          source: string;
          status: "known";
          unit: "call";
        };
    provider: string;
  }[];
} {
  const models = Object.entries(manifest.capabilities?.fal ?? {}).map(
    ([model, capability]) => ({
      kinds: [...capability.kinds].sort(),
      model,
      outputFormats: [...capability.outputFormats].sort(),
      pricing:
        capability.price === undefined
          ? ({ status: "unpriced" } as const)
          : {
              amountUsd: capability.price.amountUsd,
              retrievedAt: capability.price.retrievedAt,
              source: capability.price.source,
              status: "known" as const,
              unit: capability.price.unit,
            },
      provider: "fal",
    }),
  );
  models.sort((left, right) =>
    `${left.provider}/${left.model}`.localeCompare(
      `${right.provider}/${right.model}`,
    ),
  );
  return { models };
}

const initialMode = detectOutputMode(process.argv.slice(2));
const commandArgument = process.argv[2];
const commandNames: CommandName[] = [
  "audit",
  "export",
  "models",
  "plan",
  "run",
];
let activeCommand: CommandName =
  commandArgument !== undefined &&
  commandNames.includes(commandArgument as CommandName)
    ? (commandArgument as CommandName)
    : "cli";

const program = new Command()
  .name("fal-tools")
  .description(
    "Non-interactive, private-first fal.ai planning, generation, objective QA, and export",
  )
  .version(packageMetadata.version)
  .helpOption("-h, --help", "show command help")
  .showSuggestionAfterError(true)
  .exitOverride()
  .configureOutput({
    writeErr: () => undefined,
  })
  .addHelpText(
    "after",
    `
Agent workflow:
  fal-tools models private-manifest.yaml --json
  fal-tools plan private-manifest.yaml --json
  fal-tools run private-manifest.yaml --out .fal-tools/run-001 --max-calls 4 --max-cost 1 --jsonl
  fal-tools audit .fal-tools/run-001/run.json --json
  fal-tools export selection.yaml --from .fal-tools/run-001 --to export-dir --json

Machine exit codes:
  0 success, 1 command failure, 2 usage/input/capability, 3 budget/pricing,
  4 run failure, 5 QA gate, 6 export gate, 7 resume/lock

Commands never prompt, start a daemon, or write generated assets outside the
explicit run/export directories.`,
  );

const modelsCommand = addMachineOptions(
  program
    .command("models")
    .description(
      "list the manifest capability registry without contacting fal.ai",
    )
    .argument("<manifest>", "private YAML/JSON manifest"),
);
modelsCommand.action(
  async (manifestPath: string, options: MachineOptions): Promise<void> => {
    activeCommand = "models";
    const mode = modeFor(options);
    const result = modelResult(await loadManifest(manifestPath));
    const summary =
      result.models.length === 0
        ? "Models: none configured"
        : result.models
            .map(
              (entry) =>
                `${entry.provider}/${entry.model} [${entry.kinds.join(",")}] ${entry.outputFormats.join(",")} ${entry.pricing.status === "known" ? "priced" : "unpriced"}`,
            )
            .join("\n");
    writeOutcome("models", mode, result, summary);
  },
);

const planCommand = addMachineOptions(
  program
    .command("plan")
    .description(
      "validate and emit the immutable call graph; makes zero generation calls",
    )
    .argument("<manifest>", "private YAML/JSON manifest"),
);
planCommand.action(
  async (manifestPath: string, options: MachineOptions): Promise<void> => {
    activeCommand = "plan";
    const mode = modeFor(options);
    const pipeline = await pipelineForManifest(manifestPath, mode);
    const plan = await pipeline.plan({ manifestPath });
    writeOutcome(
      "plan",
      mode,
      plan,
      [
        `Plan ${plan.planHash}`,
        `Calls: ${plan.callCount}`,
        `Known cost: $${plan.estimatedCostUsd.toFixed(4)}`,
        `Pricing: ${plan.isPricingUnknown ? "UNKNOWN" : "KNOWN"}`,
      ].join("\n"),
    );
  },
);

const runCommand = addMachineOptions(
  program
    .command("run")
    .description("execute the immutable plan under lifetime call/cost ceilings")
    .argument("<manifest>", "private YAML/JSON manifest")
    .requiredOption(
      "--out <dir>",
      "candidate run directory; never a product tree",
    )
    .requiredOption(
      "--max-calls <count>",
      "hard lifetime provider-submission ceiling",
      positiveInteger,
    )
    .option(
      "--max-cost <usd>",
      "hard lifetime known-cost ceiling",
      nonnegativeNumber,
    )
    .addOption(
      new NamedOption(
        "--resume",
        "resume the exact matching plan and persisted budget",
        "isResume",
      ),
    ),
  true,
);
runCommand.action(
  async (
    manifestPath: string,
    options: MachineOptions & {
      isResume?: boolean;
      maxCalls: number;
      maxCost?: number;
      out: string;
    },
  ): Promise<void> => {
    activeCommand = "run";
    const mode = modeFor(options);
    const pipeline = await pipelineForManifest(manifestPath, mode);
    const ledger = await pipeline.run({
      manifestPath,
      maxCalls: options.maxCalls,
      ...(options.maxCost === undefined ? {} : { maxCostUsd: options.maxCost }),
      outDir: options.out,
      ...(options.isResume === undefined ? {} : { isResume: options.isResume }),
    });
    writeOutcome(
      "run",
      mode,
      ledger,
      `Run ${ledger.status}: ${ledger.candidates.length} candidates; ${ledger.usage.calls} calls reserved`,
    );
  },
);

const auditCommand = addMachineOptions(
  program
    .command("audit")
    .description(
      "run objective technical checks and persist candidate QA results",
    )
    .argument("<run.json>", "run ledger")
    .option(
      "--profile <qa.yaml>",
      "supplement recorded QA without weakening manifest gates",
    ),
);
auditCommand.action(
  async (
    runPath: string,
    options: MachineOptions & { profile?: string },
  ): Promise<void> => {
    activeCommand = "audit";
    const mode = modeFor(options);
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
    const isPassed = passed === ledger.candidates.length;
    const result = {
      candidates: ledger.candidates.map((candidate) => ({
        audit: candidate.audit,
        candidateId: candidate.candidateId,
      })),
      isPassed,
      passed,
      total: ledger.candidates.length,
    };
    const failure: Failure | undefined = isPassed
      ? undefined
      : {
          code: "QA_FAILED",
          exitCode: 5,
          hint: "Inspect objective checks, adjust generation inputs, and resume a new candidate run.",
          message: `${ledger.candidates.length - passed} candidates failed objective QA gates.`,
        };
    writeOutcome(
      "audit",
      mode,
      result,
      `Audit: ${passed}/${ledger.candidates.length} candidates passed objective checks`,
      failure,
    );
    if (failure !== undefined) {
      process.exitCode = failure.exitCode;
    }
  },
);

const exportCommand = addMachineOptions(
  program
    .command("export")
    .description("export only explicit candidate IDs with passing QA")
    .argument("<selection.yaml>", "explicit candidate selection")
    .requiredOption("--from <run-dir>", "audited run directory")
    .requiredOption("--to <dest>", "export destination"),
);
exportCommand.action(
  async (
    selectionPath: string,
    options: MachineOptions & { from: string; to: string },
  ): Promise<void> => {
    activeCommand = "export";
    const mode = modeFor(options);
    const pipeline = createPipeline({ providers: {} });
    const exported = await pipeline.export({
      destinationDir: options.to,
      runDir: options.from,
      selectionPath,
    });
    writeOutcome(
      "export",
      mode,
      { exportedCount: exported.length },
      `Exported ${exported.length} selected candidates`,
    );
  },
);

async function main(): Promise<void> {
  if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    return;
  }
  try {
    await program.parseAsync();
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      process.exitCode = 0;
    } else {
      const normalizedError =
        error instanceof Error ? error : new Error("command failed");
      const failure = classifyFailure(normalizedError, activeCommand);
      writeFailure(activeCommand, initialMode, failure);
      process.exitCode = failure.exitCode;
    }
  }
}

await main();
