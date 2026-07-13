import path from "node:path";

import type { JsonObject, JsonValue, Logger } from "./types.js";

const sensitiveKeyPattern =
  /(?:authorization|cookie|credential|env|header|key|password|prompt|response|secret|token)/i;
const secretValuePatterns = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:fal[_-]?key|api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:sk|pk)_[A-Za-z0-9_-]{16,}\b/,
  /https?:\/\/\S+[?&](?:signature|token|x-amz-credential|x-amz-signature)=/i,
];
const absolutePathPatterns = [
  /^\/(?:Users|home|private|tmp|var)\//,
  /^[A-Za-z]:[\\/]/,
  /^file:\/\//i,
];

export function assertSafeRelativePath(value: string, label: string): void {
  if (
    path.isAbsolute(value) ||
    value.split(/[\\/]/).includes("..") ||
    absolutePathPatterns.some((pattern) => pattern.test(value))
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
}

export function assertPublicSafe(value: JsonValue, label = "value"): void {
  if (typeof value === "string") {
    if (secretValuePatterns.some((pattern) => pattern.test(value))) {
      throw new Error(`${label} contains secret-like content`);
    }
    if (absolutePathPatterns.some((pattern) => pattern.test(value))) {
      throw new Error(`${label} contains an absolute machine path`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertPublicSafe(entry, `${label}[${index}]`);
    });
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (sensitiveKeyPattern.test(key)) {
        throw new Error(
          `${label}.${key} uses a forbidden sensitive field name`,
        );
      }
      assertPublicSafe(entry, `${label}.${key}`);
    }
  }
}

export function redactJson(value: JsonValue, key = ""): JsonValue {
  if (sensitiveKeyPattern.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJson(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        redactJson(entry, entryKey),
      ]),
    );
  }
  return value;
}

export function redactText(value: string): string {
  let redacted = value;
  for (const pattern of secretValuePatterns) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  redacted = redacted.replace(/https?:\/\/\S+\?\S+/gi, "[REDACTED_URL]");
  for (const envValue of Object.values(process.env)) {
    if (envValue !== undefined && envValue.length >= 8) {
      redacted = redacted.replaceAll(envValue, "[REDACTED]");
    }
  }
  return redacted;
}

export function createRedactingLogger(logger: Logger): Logger {
  const write =
    (level: keyof Logger) =>
    (message: string, fields: JsonObject = {}): void => {
      logger[level](redactText(message), redactJson(fields) as JsonObject);
    };

  return {
    debug: write("debug"),
    error: write("error"),
    info: write("info"),
    warn: write("warn"),
  };
}
