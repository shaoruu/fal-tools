import { execFileSync } from "node:child_process";
import { extname } from "node:path";

const files = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const binaryExtensions = new Set([
  ".avif",
  ".flac",
  ".gif",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".opus",
  ".png",
  ".wav",
  ".webm",
  ".webp",
]);
const failures = [];

for (const file of files) {
  const bytes = execFileSync("git", ["show", `:${file}`], {
    encoding: "buffer",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (binaryExtensions.has(extname(file).toLowerCase()) || bytes.includes(0)) {
    failures.push(`${file}: binary content is forbidden`);
    continue;
  }
  if (bytes.byteLength > 1024 * 1024 && file !== "pnpm-lock.yaml") {
    failures.push(`${file}: file exceeds 1 MiB`);
    continue;
  }
  const source = bytes.toString("utf8");
  if (
    /(?:fal[_-][a-z0-9_-]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i.test(
      source,
    ) ||
    /https?:\/\/[^\s]+[?&](?:x-amz-signature|signature|sig|token)=/i.test(
      source,
    ) ||
    /(?:\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Z]:\\Users\\[A-Za-z0-9._-]+)/.test(
      source,
    )
  ) {
    failures.push(`${file}: possible secret, signed URL, or machine path`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`staged guard checked ${files.length} files\n`);
}
