import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const report = execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});
const licenses = JSON.parse(report);
const lines = [
  "fal-tools third-party production dependency report",
  `Generated: ${new Date().toISOString()}`,
  "",
];

for (const license of Object.keys(licenses).sort()) {
  lines.push(`${license}:`);
  for (const dependency of licenses[license]) {
    lines.push(`  ${dependency.name}@${dependency.versions.join(", ")}`);
  }
  lines.push("");
}

mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/THIRD_PARTY_NOTICES.txt",
  `${lines.join("\n")}\n`,
  "utf8",
);
