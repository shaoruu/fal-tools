import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const artifactDirectory = path.join(repositoryRoot, "artifacts", "packs");
const packageDirectories = [
  "packages/core",
  "packages/provider-fal",
  "packages/image",
  "packages/audio",
  "packages/cli",
];
const allowedRoots = new Set([
  "dist",
  "LICENSE",
  "NOTICE",
  "package.json",
  "README.md",
]);

await rm(artifactDirectory, { force: true, recursive: true });
await mkdir(artifactDirectory, { recursive: true });

for (const packageDirectory of packageDirectories) {
  const before = new Set(await readdir(artifactDirectory));
  execFileSync("pnpm", ["pack", "--pack-destination", artifactDirectory], {
    cwd: path.join(repositoryRoot, packageDirectory),
    stdio: "pipe",
  });
  const archive = (await readdir(artifactDirectory)).find(
    (entry) => !before.has(entry) && entry.endsWith(".tgz"),
  );
  if (archive === undefined) {
    throw new Error(`pack did not create an archive for ${packageDirectory}`);
  }
  const archivePath = path.join(artifactDirectory, archive);
  const entries = execFileSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  for (const entry of entries) {
    const relative = entry.replace(/^package\//, "");
    const root = relative.split("/")[0] ?? "";
    if (!allowedRoots.has(root)) {
      throw new Error(`${archive} contains forbidden entry ${entry}`);
    }
    if (
      /(?:\.env|candidate|generated|output|private|raw|response|signed)/i.test(
        relative,
      )
    ) {
      throw new Error(`${archive} contains sensitive-looking entry ${entry}`);
    }
  }
  for (const required of [
    "package/package.json",
    "package/LICENSE",
    "package/NOTICE",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`${archive} is missing ${required}`);
    }
  }
}

process.stdout.write(
  `Inspected ${packageDirectories.length} packed package allowlists.\n`,
);
