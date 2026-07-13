import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const store = path.join("node_modules", ".pnpm");
const dependencies = new Map();

function packageDirectories(nodeModulesDirectory) {
  if (!existsSync(nodeModulesDirectory)) {
    return [];
  }
  return readdirSync(nodeModulesDirectory, { withFileTypes: true }).flatMap(
    (entry) => {
      if (!entry.isDirectory()) {
        return [];
      }
      const target = path.join(nodeModulesDirectory, entry.name);
      if (!entry.name.startsWith("@")) {
        return [target];
      }
      return readdirSync(target, { withFileTypes: true })
        .filter((child) => child.isDirectory())
        .map((child) => path.join(target, child.name));
    },
  );
}

for (const entry of readdirSync(store, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const nodeModulesDirectory = path.join(store, entry.name, "node_modules");
  for (const packageDirectory of packageDirectories(nodeModulesDirectory)) {
    const manifestPath = path.join(packageDirectory, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string"
    ) {
      continue;
    }
    const license =
      typeof manifest.license === "string" ? manifest.license : "NOASSERTION";
    dependencies.set(`${manifest.name}@${manifest.version}`, license);
  }
}

const lines = [
  "fal-tools third-party dependency report",
  `Generated: ${new Date().toISOString()}`,
  "",
];

for (const [dependency, license] of [...dependencies.entries()].sort(
  ([left], [right]) => left.localeCompare(right),
)) {
  lines.push(`${dependency} — ${license}`);
}

mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/THIRD_PARTY_NOTICES.txt",
  `${lines.join("\n")}\n`,
  "utf8",
);
