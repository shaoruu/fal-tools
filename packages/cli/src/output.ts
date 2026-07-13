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

const failureRules: {
  code: string;
  exitCode: number;
  hint: string;
  pattern: RegExp;
}[] = [
  {
    code: "PRICING_REQUIRED",
    exitCode: 3,
    hint: "Add sourced pricing or explicitly allow unpriced calls in the private manifest.",
    pattern: /pricing is UNKNOWN|unpriced/i,
  },
  {
    code: "BUDGET_EXCEEDED",
    exitCode: 3,
    hint: "Raise the explicit hard ceiling or reduce the planned call graph.",
    pattern: /max-calls|max-cost|hard budget|budget exhausted|exceed.*budget/i,
  },
  {
    code: "RUN_LOCKED",
    exitCode: 7,
    hint: "Wait for the active process to finish before resuming this run directory.",
    pattern: /locked by another process/i,
  },
  {
    code: "RESUME_MISMATCH",
    exitCode: 7,
    hint: "Resume only with the original manifest and run directory.",
    pattern: /resume|stored plan|immutable plan/i,
  },
  {
    code: "CAPABILITY_INVALID",
    exitCode: 2,
    hint: "Inspect `fal-tools models <manifest> --json` and correct the provider/model/format.",
    pattern: /capabilit|model .*does not support|provider .*not configured/i,
  },
  {
    code: "INPUT_REJECTED",
    exitCode: 2,
    hint: "Use relative contained paths and remove secret-like or private content.",
    pattern:
      /absolute|machine path|parent|path escapes|secret|symlink|prompt file/i,
  },
  {
    code: "PLAN_COLLISION",
    exitCode: 2,
    hint: "Give every candidate and normalized output a distinct ID and stem.",
    pattern: /collision|duplicate variant/i,
  },
  {
    code: "QA_REQUIRED",
    exitCode: 5,
    hint: "Run audit, inspect objective checks, and select only passing candidates.",
    pattern: /passed QA|QA|audited/i,
  },
  {
    code: "EXPORT_REJECTED",
    exitCode: 6,
    hint: "Check selected IDs, destination aliases, QA status, and destination contents.",
    pattern: /selection|export|destination|selected candidate/i,
  },
  {
    code: "RUN_FAILED",
    exitCode: 4,
    hint: "Inspect run.json failure codes, then resume with the same manifest and budgets.",
    pattern: /failed candidates|provider|generation|cache integrity/i,
  },
];

export function detectOutputMode(argumentsList: string[]): OutputMode {
  if (argumentsList.includes("--jsonl")) {
    return "jsonl";
  }
  if (argumentsList.includes("--json")) {
    return "json";
  }
  return "human";
}

export function classifyFailure(error: Error): Failure {
  if (error instanceof CommanderError) {
    return {
      code: "CLI_USAGE",
      exitCode: 2,
      hint: "Run `fal-tools --help` or `fal-tools <command> --help`.",
      message: redactText(error.message.replace(/^error:\s*/i, "")),
    };
  }
  if (error.name === "ZodError" || error.name.includes("YAML")) {
    return {
      code: "MANIFEST_INVALID",
      exitCode: 2,
      hint: "Validate the strict v1 manifest fields and retry `fal-tools plan`.",
      message: "Manifest or profile validation failed.",
    };
  }
  const message = redactText(error.message);
  const rule = failureRules.find((entry) => entry.pattern.test(message));
  if (rule !== undefined) {
    return {
      code: rule.code,
      exitCode: rule.exitCode,
      hint: rule.hint,
      message,
    };
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
  process.stderr.write(
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
