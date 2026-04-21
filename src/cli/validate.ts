import { access } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { discoverConfig, loadConfig } from "../config";
import { Exit, type ExitCode } from "../exit";
import { resolveFiles } from "../hash";
import type { LensConfig } from "../types";

export interface ValidateArgs {
  configPath?: string;
}

interface CheckResult {
  symbol: "✓" | "⚠" | "✗";
  title: string;
  details: string[];
}

const NO_CONFIG_MESSAGE = "lens: no config file found (.lenses/config.yaml)";

function formatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("lens: ") ? message : `lens: ${message}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getWorkspaceRoot(configPath: string): string {
  return resolve(dirname(configPath), "..");
}

function displayPath(path: string): string {
  const relPath = relative(process.cwd(), path);
  return relPath === "" ? "." : relPath;
}

function findDuplicates(values: string[]): string[] {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function formatCheck(result: CheckResult): string {
  return [`${result.symbol} ${result.title}`, ...result.details].join("\n");
}

async function collectPullSourceWarnings(
  config: LensConfig,
  workspaceRoot: string
): Promise<string[]> {
  const warnings: string[] = [];
  const originalCwd = process.cwd();
  process.chdir(workspaceRoot);

  try {
    for (const lens of config.lenses) {
      if (!Array.isArray(lens.pullSources)) {
        continue;
      }

      const matches = await resolveFiles(lens.pullSources);
      if (matches.length === 0) {
        warnings.push(
          `  ${lens.name} (${lens.path}): no matches for ${lens.pullSources.join(", ")}; remove pullSources or adjust the globs.`
        );
      }
    }
  } finally {
    process.chdir(originalCwd);
  }

  return warnings;
}

export async function runValidate(args: ValidateArgs): Promise<ExitCode> {
  const configPath = args.configPath
    ? resolve(args.configPath)
    : await discoverConfig();

  if (!configPath) {
    console.error(NO_CONFIG_MESSAGE);
    return Exit.CONFIG;
  }

  let config: LensConfig;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    console.error(formatErrorMessage(error));
    return Exit.CONFIG;
  }

  const workspaceRoot = getWorkspaceRoot(configPath);
  const results: CheckResult[] = [
    {
      symbol: "✓",
      title: "config loads + parses",
      details: [`  Loaded ${displayPath(configPath)}.`],
    },
    {
      symbol: config.runner.includes("{prompt}") ? "✓" : "✗",
      title: "runner contains {prompt}",
      details: config.runner.includes("{prompt}")
        ? ["  runner includes the required {prompt} placeholder."]
        : ["  runner is missing the required {prompt} placeholder."],
    },
  ];

  const missingLensPaths: string[] = [];
  for (const lens of config.lenses) {
    if (!(await fileExists(resolve(workspaceRoot, lens.path)))) {
      missingLensPaths.push(lens.path);
    }
  }

  results.push(
    missingLensPaths.length === 0
      ? {
          symbol: "✓",
          title: "lens files exist on disk",
          details: [`  Checked ${config.lenses.length} lens paths.`],
        }
      : {
          symbol: "✗",
          title: "lens files exist on disk",
          details: [
            "  Missing lens files:",
            ...missingLensPaths.map((path) => `  - ${path}`),
          ],
        }
  );

  const duplicateNames = findDuplicates(config.lenses.map((lens) => lens.name));
  results.push(
    duplicateNames.length === 0
      ? {
          symbol: "✓",
          title: "lens names are unique",
          details: [`  Checked ${config.lenses.length} lens names.`],
        }
      : {
          symbol: "✗",
          title: "lens names are unique",
          details: [`  Duplicate lens names: ${duplicateNames.join(", ")}`],
        }
  );

  const duplicatePaths = findDuplicates(config.lenses.map((lens) => lens.path));
  results.push(
    duplicatePaths.length === 0
      ? {
          symbol: "✓",
          title: "lens paths are unique",
          details: [`  Checked ${config.lenses.length} lens paths.`],
        }
      : {
          symbol: "✗",
          title: "lens paths are unique",
          details: [`  Duplicate lens paths: ${duplicatePaths.join(", ")}`],
        }
  );

  const pullSourceWarnings = await collectPullSourceWarnings(
    config,
    workspaceRoot
  );
  results.push(
    pullSourceWarnings.length === 0
      ? {
          symbol: "✓",
          title: "pullSources globs resolve to files",
          details: ["  No pullSources warnings detected."],
        }
      : {
          symbol: "⚠",
          title: "pullSources globs resolve to files",
          details: pullSourceWarnings,
        }
  );

  const passedCount = results.filter((result) => result.symbol === "✓").length;
  const warningCount = results.filter((result) => result.symbol === "⚠").length;
  const errorCount = results.filter((result) => result.symbol === "✗").length;

  console.log(
    `${results.map(formatCheck).join("\n\n")}\n\nvalidate: ${passedCount} checks passed, ${warningCount} warnings, ${errorCount} errors`
  );

  return errorCount > 0 ? Exit.FAIL : Exit.SUCCESS;
}
