import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

const forbiddenDirectories =
  /(?:^|\/)(?:\.fal-tools|cache|candidates|generated|outputs?|raw|workdirs?)(?:\/|$)/i;
const forbiddenExtensions =
  /\.(?:avif|flac|gif|jpe?g|m4a|mov|mp3|mp4|ogg|opus|png|wav|webm|webp)$/i;
const secretPattern =
  /(?:fal[_-][a-z0-9_-]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:api_?key|password|secret|token)\s*[:=]\s*["'][^"']{8,})/i;
const signedUrlPattern =
  /https?:\/\/[^\s]+[?&](?:x-amz-signature|signature|sig|token)=/i;
const machinePathPattern =
  /(?:\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Z]:\\Users\\[A-Za-z0-9._-]+)/;
const configuredTerms = (process.env.REPOSITORY_FORBIDDEN_TERMS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const failures = [];

for (const file of files) {
  if (forbiddenDirectories.test(file) || forbiddenExtensions.test(file)) {
    failures.push(`${file}: generated or binary media path is forbidden`);
    continue;
  }
  if (statSync(file).size > 1024 * 1024 && file !== "pnpm-lock.yaml") {
    failures.push(`${file}: file exceeds 1 MiB`);
    continue;
  }
  const bytes = readFileSync(file);
  if (bytes.includes(0)) {
    failures.push(`${file}: binary content is forbidden`);
    continue;
  }
  const source = bytes.toString("utf8");
  if (
    secretPattern.test(source) ||
    signedUrlPattern.test(source) ||
    machinePathPattern.test(source)
  ) {
    failures.push(`${file}: possible secret, signed URL, or machine path`);
  }
  for (const term of configuredTerms) {
    if (
      source
        .toLocaleLowerCase("en-US")
        .includes(term.toLocaleLowerCase("en-US"))
    ) {
      failures.push(`${file}: configured forbidden term found`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`repository guard checked ${files.length} files\n`);
}
