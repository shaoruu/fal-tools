import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const packages = ["core", "provider-fal", "image", "audio", "cli"];
const artifacts = path.join(root, "artifacts", "packs");
mkdirSync(artifacts, { recursive: true });

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

for (const packageName of packages) {
  const packageDirectory = path.join(root, "packages", packageName);
  copyFileSync(
    path.join(root, "LICENSE"),
    path.join(packageDirectory, "LICENSE"),
  );
  copyFileSync(
    path.join(root, "NOTICE"),
    path.join(packageDirectory, "NOTICE"),
  );
  const output = execFileSync(
    "pnpm",
    ["--dir", packageDirectory, "pack", "--pack-destination", artifacts],
    { encoding: "utf8" },
  ).trim();
  const tarball = path.isAbsolute(output)
    ? output
    : path.join(packageDirectory, output);
  const unpacked = mkdtempSync(path.join(tmpdir(), "fal-tools-pack-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
    const files = walk(unpacked);
    for (const file of files) {
      const relative = path.relative(unpacked, file).replaceAll(path.sep, "/");
      if (
        /(?:^|\/)(?:src|test|tests|examples|node_modules)(?:\/|$)/.test(
          relative,
        ) ||
        /(?:\.env|\.tsbuildinfo|\.pem|\.key|\.private\.|pnpm-lock)/i.test(
          relative,
        ) ||
        /\.(?:avif|flac|gif|jpe?g|m4a|mov|mp3|mp4|ogg|png|wav|webm|webp)$/i.test(
          relative,
        )
      ) {
        throw new Error(`${packageName}: forbidden packed path ${relative}`);
      }
      if (statSync(file).size > 1024 * 1024) {
        throw new Error(
          `${packageName}: packed file exceeds 1 MiB: ${relative}`,
        );
      }
      const source = readFileSync(file, "utf8");
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
        throw new Error(
          `${packageName}: sensitive packed content in ${relative}`,
        );
      }
    }
    process.stdout.write(
      `${packageName}: inspected ${files.length} packed files\n`,
    );
  } finally {
    rmSync(unpacked, { force: true, recursive: true });
  }
}
