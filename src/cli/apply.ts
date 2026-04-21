import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { discoverConfig, loadConfig } from "../config";
import { Exit, type ExitCode } from "../exit";
import { changedSince, diffSince, isGitRepo } from "../git";
import type { LensConfig } from "../types";

export interface ApplyArgs {
  dryRun: boolean;
  configPath?: string;
}

interface LensRecord {
  name: string;
  path: string;
  description: string;
  content: string;
}

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const APPLIED_REF = "refs/lens/applied";
const NO_BASELINE_NOTE =
  "(no refs/lens/applied yet — treat current state as baseline)";
const NO_LENS_CHANGES_NOTE = "(no lens changes since refs/lens/applied)";
const NO_CODE_DRIFT_NOTE = "(no code drift since refs/lens/applied)";
const NOT_GIT_DRIFT_NOTE = "(not a git repo — drift tracking disabled)";
const NOT_GIT_TREE_NOTE = "(not a git repo — file tree unavailable)";
const NO_TRACKED_CODE_FILES_NOTE = "(no tracked code files)";
const APPLY_FOOTER =
  "---\nPipe this to your coding agent, or run `/lens:apply` in Claude Code for integrated plan-mode handoff.";
const FILE_TREE_LIMIT = 200;

function formatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("lens: ") ? message : `lens: ${message}`;
}

function filterCodePaths(paths: string[]): string[] {
  return paths.filter((path) => {
    return !(path.startsWith(".lenses/") || path.startsWith(".lens/"));
  });
}

function runGit(
  args: string[],
  cwd: string,
  captureStdout = false
): Promise<GitCommandResult> {
  return new Promise((resolveResult, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const proc = spawn("git", args, {
      cwd,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    });

    if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
    }
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
    }

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      resolveResult({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

function readLensRecords(
  config: LensConfig,
  workspaceRoot: string
): Promise<LensRecord[]> {
  return Promise.all(
    config.lenses.map(async (lens) => {
      const fullPath = resolve(workspaceRoot, lens.path);
      let content: string;

      try {
        content = await readFile(fullPath, "utf-8");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          throw new Error(`missing lens file: ${lens.path}`);
        }
        throw error;
      }

      return {
        name: lens.name,
        path: lens.path,
        description: lens.description,
        content,
      };
    })
  );
}

function formatLensSections(lenses: LensRecord[]): string[] {
  const lines = ["## Lenses"];

  for (const lens of lenses) {
    lines.push(`### ${lens.name} — ${lens.path}`);
    lines.push(lens.description);
    lines.push("");
    lines.push("```");
    if (lens.content.length > 0) {
      lines.push(lens.content);
    }
    lines.push("```");
    lines.push("");
  }

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function formatDiffSection(diff: string | null): string {
  if (diff === null) {
    return NO_BASELINE_NOTE;
  }
  if (diff.trim().length === 0) {
    return NO_LENS_CHANGES_NOTE;
  }
  return diff.trimEnd();
}

function formatCodeFilesSection(
  codeFiles: string[],
  inGitRepo: boolean
): string {
  if (!inGitRepo) {
    return NOT_GIT_DRIFT_NOTE;
  }
  if (codeFiles.length === 0) {
    return NO_CODE_DRIFT_NOTE;
  }
  return codeFiles.map((path) => `- ${path}`).join("\n");
}

async function buildFileTreeSummary(workspaceRoot: string): Promise<string> {
  const result = await runGit(["ls-files"], workspaceRoot, true);
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || "git ls-files failed";
    throw new Error(message);
  }

  const paths = filterCodePaths(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );

  if (paths.length === 0) {
    return NO_TRACKED_CODE_FILES_NOTE;
  }

  if (paths.length <= FILE_TREE_LIMIT) {
    return paths.join("\n");
  }

  const remaining = paths.length - FILE_TREE_LIMIT;
  return `${paths.slice(0, FILE_TREE_LIMIT).join("\n")}\n… and ${remaining} more`;
}

function buildBundle(input: {
  intent: string;
  lenses: LensRecord[];
  diff: string | null;
  codeFiles: string[];
  inGitRepo: boolean;
  fileTree: string;
}): string {
  return [
    "# Lens apply — context bundle",
    "",
    "## Intent",
    input.intent,
    "",
    ...formatLensSections(input.lenses),
    "",
    "## Changes since last apply (`refs/lens/applied`)",
    formatDiffSection(input.diff),
    "",
    "## Code files changed since last apply",
    formatCodeFilesSection(input.codeFiles, input.inGitRepo),
    "",
    "## Repo file tree",
    input.fileTree,
  ].join("\n");
}

/**
 * `lens apply` — assemble a context bundle for an external coding agent.
 * This is intentionally read-only: no runner execution, lockfile writes,
 * or ref updates happen here.
 */
export async function runApply(args: ApplyArgs): Promise<ExitCode> {
  const configPath = args.configPath
    ? resolve(args.configPath)
    : await discoverConfig();

  if (!configPath) {
    console.error("lens: no config file found (.lenses/config.yaml)");
    return Exit.CONFIG;
  }

  let config: LensConfig;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    console.error(formatErrorMessage(error));
    return Exit.CONFIG;
  }

  try {
    const workspaceRoot = resolve(dirname(configPath), "..");
    const lenses = await readLensRecords(config, workspaceRoot);
    const inGitRepo = await isGitRepo(workspaceRoot);

    let diff: string | null = null;
    let codeFiles: string[] = [];
    let fileTree = NOT_GIT_TREE_NOTE;

    if (inGitRepo) {
      diff = await diffSince(APPLIED_REF, [".lenses/"], workspaceRoot);
      codeFiles = filterCodePaths(
        await changedSince(APPLIED_REF, ["."], workspaceRoot)
      );
      fileTree = await buildFileTreeSummary(workspaceRoot);
    }

    const bundle = buildBundle({
      intent: config.intent,
      lenses,
      diff,
      codeFiles,
      inGitRepo,
      fileTree,
    });

    if (args.dryRun) {
      console.log(bundle);
      return Exit.SUCCESS;
    }

    console.log(`${bundle}\n\n${APPLY_FOOTER}`);
    return Exit.SUCCESS;
  } catch (error) {
    console.error(formatErrorMessage(error));
    return Exit.FAIL;
  }
}
