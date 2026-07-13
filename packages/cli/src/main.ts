#!/usr/bin/env node

import { redactMessage } from "@fal-tools/core";

import { createAuditPipeline, createCliPipeline } from "./config.js";

const help = `fal-tools 0.1.0

Usage:
  fal-tools plan <manifest> [--json] [--allow-unpriced]
  fal-tools run <manifest> --out <dir> --max-calls <N> [--max-cost <USD>] [--resume] [--allow-unpriced]
  fal-tools audit <run.json> [--profile <qa.yaml>]
  fal-tools export <selection.yaml> --from <run-dir> --to <dest>
`;

interface ParsedArguments {
  readonly flags: ReadonlyMap<string, string | true>;
  readonly positional: readonly string[];
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    if (equals > 2) {
      flags.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const key = argument.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { flags, positional };
}

function assertFlags(
  flags: ReadonlyMap<string, string | true>,
  allowed: readonly string[],
): void {
  for (const key of flags.keys()) {
    if (!allowed.includes(key)) {
      throw new Error(`unsupported option: --${key}`);
    }
  }
}

function stringFlag(
  flags: ReadonlyMap<string, string | true>,
  key: string,
  isRequired = false,
): string | undefined {
  const value = flags.get(key);
  if (value === true || (value === undefined && isRequired)) {
    throw new Error(`--${key} requires a value`);
  }
  return value;
}

function numericFlag(
  flags: ReadonlyMap<string, string | true>,
  key: string,
  isRequired = false,
): number | undefined {
  const value = stringFlag(flags, key, isRequired);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${key} requires a positive number`);
  }
  return parsed;
}

async function planCommand(arguments_: ParsedArguments): Promise<void> {
  assertFlags(arguments_.flags, ["json", "allow-unpriced"]);
  const manifest = arguments_.positional[0];
  if (manifest === undefined || arguments_.positional.length !== 1) {
    throw new Error("plan requires exactly one manifest");
  }
  const pipeline = await createCliPipeline(manifest);
  const plan = await pipeline.plan(manifest, {
    isAllowUnpriced: arguments_.flags.has("allow-unpriced"),
  });
  if (arguments_.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Plan ${plan.id}\n`);
  process.stdout.write(`Calls: ${plan.calls.length}\n`);
  process.stdout.write(
    `Estimated cost: ${
      plan.estimatedCostMicros === undefined
        ? "UNKNOWN"
        : `$${(plan.estimatedCostMicros / 1_000_000).toFixed(6)} USD`
    }\n`,
  );
  for (const call of plan.calls) {
    process.stdout.write(`- ${call.id} -> ${call.output}\n`);
  }
}

async function runCommand(arguments_: ParsedArguments): Promise<void> {
  assertFlags(arguments_.flags, [
    "out",
    "max-calls",
    "max-cost",
    "resume",
    "allow-unpriced",
  ]);
  const manifest = arguments_.positional[0];
  if (manifest === undefined || arguments_.positional.length !== 1) {
    throw new Error("run requires exactly one manifest");
  }
  const outDirectory = stringFlag(arguments_.flags, "out", true);
  const maxCalls = numericFlag(arguments_.flags, "max-calls", true);
  const maxCostUsd = numericFlag(arguments_.flags, "max-cost");
  if (outDirectory === undefined || maxCalls === undefined) {
    throw new Error("run requires --out and --max-calls");
  }
  if (!Number.isSafeInteger(maxCalls)) {
    throw new Error("--max-calls requires an integer");
  }
  const pipeline = await createCliPipeline(manifest);
  const ledger = await pipeline.run(manifest, {
    outDirectory,
    maxCalls,
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    isResume: arguments_.flags.has("resume"),
    isAllowUnpriced: arguments_.flags.has("allow-unpriced"),
  });
  process.stdout.write(
    `${JSON.stringify({
      runId: ledger.runId,
      candidates: ledger.candidates.length,
      failures: ledger.failures.length,
      callAttempts: ledger.callAttempts,
      costMicros: ledger.costMicros,
    })}\n`,
  );
  if (ledger.failures.length > 0) {
    process.exitCode = 1;
  }
}

async function auditCommand(arguments_: ParsedArguments): Promise<void> {
  assertFlags(arguments_.flags, ["profile"]);
  const runPath = arguments_.positional[0];
  if (runPath === undefined || arguments_.positional.length !== 1) {
    throw new Error("audit requires exactly one run.json");
  }
  const profilePath = stringFlag(arguments_.flags, "profile");
  const pipeline = createAuditPipeline();
  const ledger = await pipeline.audit(runPath, {
    ...(profilePath === undefined ? {} : { profilePath }),
  });
  const failed = ledger.audits.filter((audit) => !audit.passed).length;
  process.stdout.write(
    `${JSON.stringify({ audited: ledger.audits.length, failed })}\n`,
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function exportCommand(arguments_: ParsedArguments): Promise<void> {
  assertFlags(arguments_.flags, ["from", "to"]);
  const selection = arguments_.positional[0];
  if (selection === undefined || arguments_.positional.length !== 1) {
    throw new Error("export requires exactly one selection");
  }
  const from = stringFlag(arguments_.flags, "from", true);
  const to = stringFlag(arguments_.flags, "to", true);
  if (from === undefined || to === undefined) {
    throw new Error("export requires --from and --to");
  }
  const result = await createAuditPipeline().export(selection, from, to);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    process.stdout.write(help);
    return;
  }
  const arguments_ = parseArguments(rest);
  if (command === "plan") {
    await planCommand(arguments_);
  } else if (command === "run") {
    await runCommand(arguments_);
  } else if (command === "audit") {
    await auditCommand(arguments_);
  } else if (command === "export") {
    await exportCommand(arguments_);
  } else {
    throw new Error(`unsupported command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `fal-tools: ${redactMessage(
      error instanceof Error ? error.message : "command failed",
    )}\n`,
  );
  process.exitCode = 1;
});
