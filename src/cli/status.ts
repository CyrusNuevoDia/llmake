import { access } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { CONFIG_FILENAMES, discoverConfig, loadConfig } from "../config";
import { Exit, type ExitCode } from "../exit";
import {
  changedSince,
  commitRelativeTime,
  isGitRepo,
  readRef,
  repoRoot,
} from "../git";
import { hashFile } from "../hash";
import { readLock } from "../lock";
import type { LensConfig, LensLock, TaskLockEntry } from "../types";

export interface StatusArgs {
  configPath?: string;
}

interface LensStatusRow {
  name: string;
  path: string;
  symbol: string;
  note: string;
  changed: boolean;
}

interface RepositoryInfo {
  inGitRepo: boolean;
  repositoryPath: string;
}

interface GitStatusSummary {
  syncedSha: string | null;
  appliedSha: string | null;
  syncedTime: string | null;
  appliedTime: string | null;
  codeLine: string;
  codeDriftCount: number;
}

const LOCK_REL = ".lenses/lock.json";
const SYNCED_REF = "refs/lens/synced";
const APPLIED_REF = "refs/lens/applied";
const NOT_GIT_REFS_NOTE = "(not a git repo — ref tracking disabled)";
const NOT_GIT_CODE_NOTE = "(not a git repo — code drift tracking disabled)";
const NO_APPLY_BASELINE_NOTE =
  "(no lens/applied ref yet — run lens apply to set a baseline)";

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
  return dirname(configPath);
}

function getSyncBaselineEntry(lock: LensLock): TaskLockEntry | undefined {
  if (lock.tasks.sync) {
    return lock.tasks.sync;
  }
  return lock.tasks.generate;
}

function formatRefValue(sha: string | null, relTime: string | null): string {
  if (!sha) {
    return "<not set>";
  }
  if (!relTime) {
    return sha.slice(0, 7);
  }
  return `${sha.slice(0, 7)} (${relTime})`;
}

function formatLensRow(
  row: LensStatusRow,
  nameWidth: number,
  pathWidth: number
): string {
  return `  ${row.symbol} ${row.name.padEnd(nameWidth)}  ${row.path.padEnd(pathWidth)}  ${row.note}`;
}

function filterCodePaths(paths: string[]): string[] {
  return paths.filter(
    (path) => !(path.startsWith(".lenses/") || CONFIG_FILENAMES.has(path))
  );
}

function formatCodeSummary(codeDriftCount: number): string {
  if (codeDriftCount === 0) {
    return "✓ code matches last apply";
  }
  const noun = codeDriftCount === 1 ? "file" : "files";
  return `⚠ ${codeDriftCount} code ${noun} changed since last apply`;
}

async function collectLensRows(
  config: LensConfig,
  workspaceRoot: string,
  baseline: TaskLockEntry | undefined
): Promise<LensStatusRow[]> {
  const rows: LensStatusRow[] = [];

  for (const lens of config.lenses) {
    const fullPath = resolve(workspaceRoot, lens.path);
    if (!(await fileExists(fullPath))) {
      rows.push({
        name: lens.name,
        path: lens.path,
        symbol: "⚠",
        note: "missing on disk",
        changed: true,
      });
      continue;
    }

    const currentHash = await hashFile(fullPath);
    const previousHash = baseline ? baseline.files[lens.path] : undefined;
    if (!previousHash || previousHash !== currentHash) {
      rows.push({
        name: lens.name,
        path: lens.path,
        symbol: "⚠",
        note: "edited since last sync",
        changed: true,
      });
      continue;
    }

    rows.push({
      name: lens.name,
      path: lens.path,
      symbol: "✓",
      note: "up to date",
      changed: false,
    });
  }

  return rows;
}

async function resolveRepositoryInfo(cwd: string): Promise<RepositoryInfo> {
  const inGitRepo = await isGitRepo(cwd);
  if (!inGitRepo) {
    return {
      inGitRepo: false,
      repositoryPath: cwd,
    };
  }

  const detectedRepoRoot = await repoRoot(cwd);
  return {
    inGitRepo: true,
    repositoryPath: detectedRepoRoot || cwd,
  };
}

async function collectGitStatus(
  repositoryPath: string
): Promise<GitStatusSummary> {
  const syncedSha = await readRef(SYNCED_REF, repositoryPath);
  const appliedSha = await readRef(APPLIED_REF, repositoryPath);

  let syncedTime: string | null = null;
  let appliedTime: string | null = null;
  if (syncedSha) {
    syncedTime = await commitRelativeTime(syncedSha, repositoryPath);
  }

  if (!appliedSha) {
    return {
      syncedSha,
      appliedSha,
      syncedTime,
      appliedTime,
      codeLine: NO_APPLY_BASELINE_NOTE,
      codeDriftCount: 0,
    };
  }

  appliedTime = await commitRelativeTime(appliedSha, repositoryPath);
  const changedPaths = await changedSince(APPLIED_REF, ["."], repositoryPath);
  const codeDriftCount = filterCodePaths(changedPaths).length;

  return {
    syncedSha,
    appliedSha,
    syncedTime,
    appliedTime,
    codeLine: formatCodeSummary(codeDriftCount),
    codeDriftCount,
  };
}

function buildSuggestions(
  lensRows: LensStatusRow[],
  inGitRepo: boolean,
  codeDriftCount: number
): string[] {
  const suggestions: string[] = [];
  const firstChangedLens = lensRows.find((row) => row.changed);
  if (firstChangedLens) {
    suggestions.push(
      `Run \`lens sync\` to propagate ${firstChangedLens.name}.md edits to other lenses`
    );
  }
  if (inGitRepo && codeDriftCount > 0) {
    suggestions.push(
      "Run `lens pull` to reflect code changes in lenses, OR run `lens apply` to propagate lens changes into code"
    );
  }
  if (suggestions.length === 0) {
    suggestions.push("Everything is up to date.");
  }
  return suggestions;
}

export async function runStatus(args: StatusArgs): Promise<ExitCode> {
  const cwd = process.cwd();
  const configPath = args.configPath
    ? resolve(args.configPath)
    : await discoverConfig();

  if (!configPath) {
    console.error("lens: no config file found (lens.yml)");
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
  const lockPath = resolve(workspaceRoot, LOCK_REL);
  const lock = await readLock(lockPath);
  const baseline = getSyncBaselineEntry(lock);
  const lensRows = await collectLensRows(config, workspaceRoot, baseline);

  const repositoryInfo = await resolveRepositoryInfo(cwd);
  const repositoryPath = repositoryInfo.repositoryPath;
  const relConfigPath = relative(repositoryPath, configPath) || configPath;

  let gitStatus: GitStatusSummary = {
    syncedSha: null,
    appliedSha: null,
    syncedTime: null,
    appliedTime: null,
    codeLine: NOT_GIT_CODE_NOTE,
    codeDriftCount: 0,
  };
  if (repositoryInfo.inGitRepo) {
    gitStatus = await collectGitStatus(repositoryPath);
  }

  const suggestions = buildSuggestions(
    lensRows,
    repositoryInfo.inGitRepo,
    gitStatus.codeDriftCount
  );

  const lensNameWidth =
    config.lenses.length > 0
      ? Math.max(...config.lenses.map((lens) => lens.name.length))
      : 0;
  const lensPathWidth =
    config.lenses.length > 0
      ? Math.max(...config.lenses.map((lens) => lens.path.length))
      : 0;
  const refNameWidth = "lens/applied".length;

  const lines = [
    "Lens status",
    "───────────",
    "",
    `Repository: ${repositoryPath}`,
    `Config:     ${relConfigPath} (${config.lenses.length} lenses)`,
    "",
    "Refs:",
  ];

  if (repositoryInfo.inGitRepo) {
    lines.push(
      `  ${"lens/synced".padEnd(refNameWidth)}  ${formatRefValue(gitStatus.syncedSha, gitStatus.syncedTime)}`
    );
    lines.push(
      `  ${"lens/applied".padEnd(refNameWidth)}  ${formatRefValue(gitStatus.appliedSha, gitStatus.appliedTime)}`
    );
  } else {
    lines.push(`  ${NOT_GIT_REFS_NOTE}`);
  }

  lines.push("");
  lines.push("Lens set:");

  if (lensRows.length === 0) {
    lines.push("  (no lenses configured)");
  } else {
    for (const row of lensRows) {
      lines.push(formatLensRow(row, lensNameWidth, lensPathWidth));
    }
  }

  lines.push("");
  lines.push("Code:");
  lines.push(`  ${gitStatus.codeLine}`);
  lines.push("");
  lines.push("Suggestions:");

  for (const suggestion of suggestions) {
    lines.push(`  • ${suggestion}`);
  }

  console.log(lines.join("\n"));
  return Exit.SUCCESS;
}
