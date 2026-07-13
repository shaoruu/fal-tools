import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(packageDirectory, "..");
const target =
  process.argv[2] === undefined
    ? process.cwd()
    : path.resolve(repositoryRoot, process.argv[2]);

await mkdir(target, { recursive: true });
await Promise.all(
  ["LICENSE", "NOTICE"].map((file) =>
    copyFile(path.join(repositoryRoot, file), path.join(target, file)),
  ),
);
