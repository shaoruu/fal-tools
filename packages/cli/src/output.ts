import process from "node:process";

import { CommanderError } from "commander";

import { redactText, type JsonObject, type Logger } from "@fal-tools/core";

export type CommandName =
  "audit" | "cli" | "export" | "models" | "plan" | "run";

export type OutputMode = "human" | "json" | "jsonl";

export type Failure = {
  code: string;
  exitCode: number;
  hint: string;
  message: string;
};

type MachineEnvelope = {
  command: CommandName;
  error?: Omit<Failure, "exitCode">;
  isSuccess: boolean;
  result?: object;
  schemaVersion: 1;
  type?: "result";
};

export function detectOutputMode(argumentsList: string[]): OutputMode {
  if (argumentsList.includes("--jsonl")) {
    return "jsonl";
  }
  if (argumentsList.includes("--json")) {
    return "json";
  }
  return "human";
}

function validationFailure(command: CommandName): Failure {
  if (command === "export") {
    return {
      code: "SELECTION_INVALID",
      exitCode: 6,
      hint: "Validate the strict v1 selection and retry export.",
      message: "Selection validation failed.",
    };
  }
  if (command === "audit") {
    return {
      code: "QA_PROFILE_INVALID",
      exitCode: 5,
      hint: "Validate the objective QA profile and retry audit.",
      message: "QA profile validation failed.",
    };
  }
  return {
    code: "MANIFEST_INVALID",
    exitCode: 2,
    hint: "Validate the strict v1 manifest fields and retry `fal-tools plan`.",
    message: "Manifest validation failed.",
  };
}

function runFailure(message: string): Failure {
  if (/pricing is UNKNOWN|unpriced/i.test(message)) {
    return {
      code: "PRICING_REQUIRED",
      exitCode: 3,
      hint: "Add sourced pricing or explicitly allow unpriced calls in the private manifest.",
      message,
    };
  }
  if (
    /max-calls|max-cost|hard budget|budget exhausted|exceed.*budget/i.test(
      message,
    )
  ) {
    return {
      code: "BUDGET_EXCEEDED",
      exitCode: 3,
      hint: "Raise the explicit hard ceiling or reduce the planned call graph.",
      message,
    };
  }
  if (/locked by another process/i.test(message)) {
    return {
      code: "RUN_LOCKED",
      exitCode: 7,
      hint: "Wait for the active process to finish before resuming this run directory.",
      message,
    };
  }
  if (/resume|stored plan|immutable plan/i.test(message)) {
    return {
      code: "RESUME_MISMATCH",
      exitCode: 7,
      hint: "Resume only with the original manifest and run directory.",
      message,
    };
  }
  if (
    /capabilit|model .*does not support|provider .*not configured|absolute|machine path|secret|symlink|collision/i.test(
      message,
    )
  ) {
    return {
      code: "RUN_INPUT_REJECTED",
      exitCode: 2,
      hint: "Dry-run with `fal-tools plan <manifest> --json` and fix the reported input.",
      message,
    };
  }
  return {
    code: "RUN_FAILED",
    exitCode: 4,
    hint: "Inspect run.json failure codes, then resume with the same manifest and budgets.",
    message,
  };
}

export function classifyFailure(error: Error, command: CommandName): Failure {
  if (error instanceof CommanderError) {
    return {
      code: "CLI_USAGE",
      exitCode: 2,
      hint: "Run `fal-tools --help` or `fal-tools <command> --help`.",
      message: redactText(error.message.replace(/^error:\s*/i, "")),
    };
  }
  if (
    error.name === "ZodError" ||
    error.name.includes("YAML") ||
    error instanceof SyntaxError
  ) {
    return validationFailure(command);
  }
  const message = redactText(error.message);
  if (command === "export") {
    return {
      code: "EXPORT_REJECTED",
      exitCode: 6,
      hint: "Check selected IDs, destination aliases, QA status, and destination contents.",
      message,
    };
  }
  if (command === "audit") {
    return {
      code: "AUDIT_FAILED",
      exitCode: 5,
      hint: "Check the completed run ledger, candidate integrity, and objective QA profile.",
      message,
    };
  }
  if (command === "plan" || command === "models") {
    return {
      code: /capabilit|model .*does not support|provider .*not configured/i.test(
        message,
      )
        ? "CAPABILITY_INVALID"
        : /collision|duplicate variant/i.test(message)
          ? "PLAN_COLLISION"
          : "INPUT_REJECTED",
      exitCode: 2,
      hint: "Check the private manifest, contained paths, capability registry, and output names.",
      message,
    };
  }
  if (command === "run") {
    return runFailure(message);
  }
  return {
    code: "COMMAND_FAILED",
    exitCode: 1,
    hint: "Inspect sanitized diagnostics and retry the same non-interactive command.",
    message: message === "" ? "Command failed." : message,
  };
}

export function writeOutcome(
  command: CommandName,
  mode: OutputMode,
  result: object,
  humanSummary: string,
  failure?: Failure,
): void {
  const envelope: MachineEnvelope = {
    command,
    ...(failure === undefined
      ? {}
      : {
          error: {
            code: failure.code,
            hint: failure.hint,
            message: failure.message,
          },
        }),
    isSuccess: failure === undefined,
    result,
    schemaVersion: 1,
    ...(mode === "jsonl" ? { type: "result" as const } : {}),
  };
  if (mode === "human") {
    process.stdout.write(`${humanSummary}\n`);
    if (failure !== undefined) {
      process.stderr.write(
        `fal-tools: ${failure.code}: ${failure.message}\nHint: ${failure.hint}\n`,
      );
    }
    return;
  }
  process.stdout.write(
    `${JSON.stringify(envelope, null, mode === "json" ? 2 : undefined)}\n`,
  );
}

export function writeFailure(
  command: CommandName,
  mode: OutputMode,
  failure: Failure,
): void {
  const envelope: MachineEnvelope = {
    command,
    error: {
      code: failure.code,
      hint: failure.hint,
      message: failure.message,
    },
    isSuccess: false,
    schemaVersion: 1,
    ...(mode === "jsonl" ? { type: "result" as const } : {}),
  };
  if (mode === "human") {
    process.stderr.write(
      `fal-tools: ${failure.code}: ${failure.message}\nHint: ${failure.hint}\n`,
    );
    return;
  }
  const stream = mode === "jsonl" ? process.stdout : process.stderr;
  stream.write(
    `${JSON.stringify(envelope, null, mode === "json" ? 2 : undefined)}\n`,
  );
}

export function createCliLogger(mode: OutputMode): Logger {
  const write =
    (level: "debug" | "error" | "info" | "warn") =>
    (message: string, fields: JsonObject = {}): void => {
      if (mode === "json") {
        return;
      }
      if (mode === "jsonl") {
        process.stdout.write(
          `${JSON.stringify({
            fields,
            level,
            message,
            schemaVersion: 1,
            type: "log",
          })}\n`,
        );
        return;
      }
      const suffix =
        Object.keys(fields).length === 0 ? "" : ` ${JSON.stringify(fields)}`;
      process.stderr.write(`[${level}] ${message}${suffix}\n`);
    };

  return {
    debug: write("debug"),
    error: write("error"),
    info: write("info"),
    warn: write("warn"),
  };
}
