import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const isStaged = process.argv.includes("--staged");
const command = isStaged
  ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
  : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
const files = execFileSync("git", command, { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const forbiddenPathPattern =
  /(^|\/)(?:cache|candidates|generated|outputs|private-manifests|raw|workdir)(\/|$)|\.private\.(?:json|ya?ml)$/i;
const absoluteMachinePathPattern =
  /(?:\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\)/;
const secretPatterns = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:fal[_-]?key|api[_-]?key|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk|pk)_[A-Za-z0-9_-]{16,}\b/,
  /https?:\/\/\S+[?&](?:signature|token|x-amz-credential|x-amz-signature)=/i,
];
const scanExclusions = new Set([
  "pnpm-lock.yaml",
  "scripts/security-checks.mjs",
]);
const productTerms = readFileSync(
  "security/forbidden-product-names.txt",
  "utf8",
)
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));
const violations = [];

for (const file of files) {
  if (forbiddenPathPattern.test(file) || /^\.env(?!\.example$)/.test(file)) {
    violations.push(`${file}: forbidden private or generated path`);
    continue;
  }
  const bytes = readFileSync(file);
  if (bytes.length > 100 * 1024) {
    violations.push(`${file}: exceeds the 100 KiB repository file limit`);
  }
  if (bytes.includes(0)) {
    violations.push(`${file}: binary files are not repository content`);
    continue;
  }
  if (scanExclusions.has(file)) {
    continue;
  }
  const text = bytes.toString("utf8");
  if (absoluteMachinePathPattern.test(text)) {
    violations.push(`${file}: contains an absolute local machine path`);
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) {
      violations.push(`${file}: contains secret-like content`);
      break;
    }
  }
  for (const term of productTerms) {
    if (text.toLocaleLowerCase().includes(term.toLocaleLowerCase())) {
      violations.push(`${file}: contains a forbidden product name`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Security content checks passed for ${files.length} files.\n`,
  );
}
