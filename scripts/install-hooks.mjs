import { execFileSync } from "node:child_process";

function gitConfig(...argumentsList) {
  return execFileSync("git", ["config", ...argumentsList], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

try {
  const existing = gitConfig("--get", "core.hooksPath");
  if (existing === "" || existing === ".githooks") {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
      stdio: "ignore",
    });
  } else {
    process.stdout.write(
      `Preserving existing Git hooks path. Run .githooks/pre-commit from the existing pre-commit hook.\n`,
    );
  }
} catch {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
      stdio: "ignore",
    });
  } catch {
    process.stdout.write(
      "Git hooks were not configured in this environment.\n",
    );
  }
}
