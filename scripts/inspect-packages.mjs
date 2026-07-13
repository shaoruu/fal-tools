import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

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
const archives = [];

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
  const packageManifest = JSON.parse(
    await readFile(
      path.join(repositoryRoot, packageDirectory, "package.json"),
      "utf8",
    ),
  );
  archives.push({ archivePath, name: packageManifest.name });
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
  const requiredEntries = [
    "package/package.json",
    "package/LICENSE",
    "package/NOTICE",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ];
  if (packageDirectory === "packages/cli") {
    requiredEntries.push("package/dist/cli.js", "package/dist/cli.d.ts");
  }
  for (const required of requiredEntries) {
    if (!entries.includes(required)) {
      throw new Error(`${archive} is missing ${required}`);
    }
  }
}

const consumerDirectory = await mkdtemp(
  path.join(os.tmpdir(), "fal-tools-pack-consumer-"),
);
try {
  await writeFile(
    path.join(consumerDirectory, "package.json"),
    JSON.stringify({
      dependencies: Object.fromEntries(
        archives.map(({ archivePath, name }) => [name, `file:${archivePath}`]),
      ),
      private: true,
      type: "module",
    }),
    { mode: 0o600 },
  );
  execFileSync("pnpm", ["install"], {
    cwd: consumerDirectory,
    stdio: "pipe",
  });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'await Promise.all(["@fal-tools/core","@fal-tools/provider-fal","@fal-tools/image","@fal-tools/audio","fal-tools"].map((name) => import(name)));',
    ],
    { cwd: consumerDirectory, stdio: "pipe" },
  );
  execFileSync(
    path.join(consumerDirectory, "node_modules", ".bin", "fal-tools"),
    ["--help"],
    { cwd: consumerDirectory, stdio: "pipe" },
  );
} finally {
  await rm(consumerDirectory, { force: true, recursive: true });
}

process.stdout.write(
  `Inspected and consumed ${packageDirectories.length} packed packages.\n`,
);
