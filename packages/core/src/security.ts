import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import type { JsonObject, JsonValue } from "./types.js";

const secretKeyPattern =
  /(?:^|_)(?:api_?key|authorization|cookie|credential|password|private_?key|secret|token)(?:$|_)/i;
const credentialValuePattern =
  /(?:bearer\s+[a-z0-9._~-]{12,}|fal[_-][a-z0-9_-]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;
const signedUrlPattern =
  /[?&](?:x-amz-(?:credential|signature)|signature|sig|token|expires)=/i;

export function assertSafeRelativePath(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("~/") ||
    /^file:/i.test(value)
  ) {
    throw new Error(`${label} must be a non-empty relative path`);
  }

  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) {
    throw new Error(`${label} must not escape its base directory`);
  }
}

export function assertSafeData(value: JsonValue, label = "input"): void {
  if (typeof value === "string") {
    if (credentialValuePattern.test(value) || signedUrlPattern.test(value)) {
      throw new Error(`${label} contains credential-like data`);
    }
    if (
      path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value) ||
      value.startsWith("\\\\") ||
      value.startsWith("~/") ||
      /^file:/i.test(value)
    ) {
      throw new Error(`${label} contains an absolute local path`);
    }
    return;
  }

  if (Array.isArray(value)) {
    const entries = value as readonly JsonValue[];
    entries.forEach((entry, index) => {
      assertSafeData(entry, `${label}[${index}]`);
    });
    return;
  }

  if (value !== null && typeof value === "object") {
    const record: JsonObject = value;
    for (const [key, entry] of Object.entries(record)) {
      if (secretKeyPattern.test(key) || key.toLowerCase() === "prompt") {
        throw new Error(`${label}.${key} is not allowed`);
      }
      assertSafeData(entry, `${label}.${key}`);
    }
  }
}

export function assertSafePrompt(value: string): void {
  if (credentialValuePattern.test(value) || signedUrlPattern.test(value)) {
    throw new Error("prompt contains credential-like data");
  }
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries = value as readonly JsonValue[];
    return `[${entries.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  const record: JsonObject = value;
  return `{${Object.entries(record)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export async function resolveContainedFile(
  baseDirectory: string,
  relativePath: string,
): Promise<string> {
  assertSafeRelativePath(relativePath, "file");
  const base = await realpath(baseDirectory);
  const target = await realpath(path.resolve(base, relativePath));
  const relative = path.relative(base, target);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("file must resolve beneath the manifest directory");
  }
  return target;
}

export function redactMessage(value: string): string {
  let redacted = value;
  for (const environmentValue of Object.values(process.env)) {
    if (environmentValue !== undefined && environmentValue.length >= 8) {
      redacted = redacted.replaceAll(environmentValue, "[REDACTED_ENV]");
    }
  }
  return redacted
    .replace(credentialValuePattern, "[REDACTED]")
    .replaceAll(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]")
    .replace(
      /(?:^|\s)(?:\/(?:Users|home|workspace|tmp)\/[^\s:]+|[A-Z]:\\[^\s:]+)/i,
      " [REDACTED_PATH]",
    )
    .slice(0, 240);
}
