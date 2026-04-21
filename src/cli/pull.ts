import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { discoverConfig, loadConfig } from "../config";
import { Exit, type ExitCode } from "../exit";
import {
  diffSince,
  getHead,
  isGitRepo,
  isWorkingTreeClean,
  updateRef,
} from "../git";
import { computeMerkleRoot, hashFile, resolveFiles } from "../hash";
import { diffTask, readLock, writeLock } from "../lock";
import {
  assemblePrompt,
  type FileSnapshot,
  type PromptVars,
  PULL_PROMPT,
} from "../prompts";
import { executeRunner } from "../runner";
import type { LensConfig, TaskLockEntry } from "../types";

export interface PullArgs {
  force: boolean;
  dryRun: boolean;
  configPath?: string;
}

const LOCK_REL = ".lenses/lock.json";
const PULL_REF = "refs/lens/applied";
const PROMPT_SNAPSHOT_LIMIT = 50;
const FALLBACK_SOURCE_GUIDANCE =
  "lens: pull — no code sources (define pullSources in lens.yml lenses)";
const DIRTY_TREE_GUIDANCE =
  "lens: pull complete. Commit changes and run 'lens mark applied' to advance ref.";
const LOCKFILE_PATHSPEC = ":(exclude).lenses/lock.json";
const GIT_CODE_EXCLUDES = [
  ":(exclude).lenses",
  ":(exclude)lens.yml",
  ":(exclude)lens.yaml",
  ":(exclude)lens.jsonc",
  ":(exclude)lens.json",
  ":(exclude)node_modules",
  ":(exclude).git",
];
const FALLBACK_EXCLUDED_PATHS: ReadonlySet<string> = new Set([
  "lens.yml",
  "lens.yaml",
  "lens.jsonc",
  "lens.json",
]);
const FALLBACK_EXCLUDED_PREFIXES = [".lenses/", "node_modules/", ".git/"];

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

function makeLockEntry(
  fileHashes: Record<string, string>,
  merkleRoot: string
): TaskLockEntry {
  return {
    last_run: new Date().toISOString(),
    sources_hash: merkleRoot,
    files: fileHashes,
  };
}

function dedupeAndSort(paths: string[]): string[] {
  return Array.from(new Set(paths)).sort();
}

function isExcludedFallbackPath(path: string): boolean {
  if (FALLBACK_EXCLUDED_PATHS.has(path)) {
    return true;
  }
  for (const prefix of FALLBACK_EXCLUDED_PREFIXES) {
    if (path.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function runGitStdout(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolveStdout, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
    }

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        resolveStdout(null);
        return;
      }
      resolveStdout(Buffer.concat(chunks).toString("utf-8"));
    });
  });
}

function isCleanIgnoringLockfile(cwd: string): Promise<boolean> {
  return new Promise((resolveStatus) => {
    const stdoutChunks: Buffer[] = [];
    const proc = spawn(
      "git",
      ["status", "--porcelain", "--", ".", LOCKFILE_PATHSPEC],
      {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );

    if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
    }

    proc.on("error", () => {
      resolveStatus(false);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        resolveStatus(false);
        return;
      }
      resolveStatus(
        Buffer.concat(stdoutChunks).toString("utf-8").trim() === ""
      );
    });
  });
}

export async function resolvePullSources(
  config: LensConfig,
  repoRoot: string
): Promise<string[] | null> {
  const globs: string[] = [];

  for (const lens of config.lenses) {
    if (!Array.isArray(lens.pullSources)) {
      continue;
    }
    for (const source of lens.pullSources) {
      globs.push(source);
    }
  }

  if (globs.length > 0) {
    const originalCwd = process.cwd();
    process.chdir(repoRoot);
    try {
      return dedupeAndSort(await resolveFiles(globs));
    } finally {
      process.chdir(originalCwd);
    }
  }

  if (!(await isGitRepo(repoRoot))) {
    return null;
  }

  const tracked = await runGitStdout(["ls-files"], repoRoot);
  if (tracked === null) {
    return null;
  }

  return dedupeAndSort(
    tracked
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !isExcludedFallbackPath(line))
  );
}

export async function hashRelativeFiles(
  repoRoot: string,
  relPaths: string[]
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};

  for (const relPath of relPaths) {
    hashes[relPath] = await hashFile(resolve(repoRoot, relPath));
  }

  return hashes;
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function readLensSnapshots(
  config: LensConfig,
  repoRoot: string
): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = [];

  for (const lens of config.lenses) {
    snapshots.push({
      path: lens.path,
      content: await readFileOrEmpty(resolve(repoRoot, lens.path)),
    });
  }

  return snapshots;
}

function formatChangedCodeContentNotice(total: number): string {
  return `(content omitted: ${total} changed files exceeds prompt cap of ${PROMPT_SNAPSHOT_LIMIT})`;
}

async function buildChangedCodeSnapshots(
  repoRoot: string,
  changedFiles: string[]
): Promise<FileSnapshot[]> {
  if (changedFiles.length === 0) {
    return [];
  }

  if (changedFiles.length > PROMPT_SNAPSHOT_LIMIT) {
    const notice = formatChangedCodeContentNotice(changedFiles.length);
    return changedFiles.map((path) => ({
      path,
      content: notice,
    }));
  }

  const snapshots: FileSnapshot[] = [];
  for (const relPath of changedFiles) {
    snapshots.push({
      path: relPath,
      content: await readFileOrEmpty(resolve(repoRoot, relPath)),
    });
  }

  return snapshots;
}

function formatLensesBlock(
  lenses: LensConfig["lenses"],
  snapshots: FileSnapshot[]
): string {
  const snapshotByPath = new Map<string, string>();

  for (const snapshot of snapshots) {
    snapshotByPath.set(snapshot.path, snapshot.content);
  }

  const chunks: string[] = [];
  for (const lens of lenses) {
    const content = snapshotByPath.has(lens.path)
      ? snapshotByPath.get(lens.path) || ""
      : "(not loaded)";
    chunks.push(
      [
        `### ${lens.name}`,
        `Path: ${lens.path}`,
        `Description: ${lens.description}`,
        "Current content:",
        "```",
        content,
        "```",
      ].join("\n")
    );
  }

  return chunks.join("\n\n");
}

function buildPullPrompt(input: {
  config: LensConfig;
  lensSnapshots: FileSnapshot[];
  changedFiles: string[];
  changedCodeSnapshots: FileSnapshot[];
  gitDiffSince?: PromptVars["git_diff_since"];
}): string {
  const placeholderLensBlock = formatLensesBlock(input.config.lenses, []);
  const actualLensBlock = formatLensesBlock(
    input.config.lenses,
    input.lensSnapshots
  );

  const assembled = assemblePrompt(PULL_PROMPT, {
    intent: input.config.intent,
    lenses: input.config.lenses,
    changed_files: input.changedFiles,
    changed_files_content: input.changedCodeSnapshots,
    git_diff_since: input.gitDiffSince,
  });

  return assembled
    .replace(placeholderLensBlock, actualLensBlock)
    .replace("CURRENT LENS CONTENT:", "CHANGED CODE FILE CONTENT:");
}

function listPromptChangedFiles(diff: ReturnType<typeof diffTask>): string[] {
  return dedupeAndSort([...diff.changed_files, ...diff.removed_files]);
}

async function ensureLensFilesExist(
  config: LensConfig,
  repoRoot: string
): Promise<boolean> {
  for (const lens of config.lenses) {
    if (!(await fileExists(resolve(repoRoot, lens.path)))) {
      console.error(
        `lens: pull — missing lens file: ${lens.path}. Run 'lens add' or create it manually.`
      );
      return false;
    }
  }

  return true;
}

/**
 * `lens pull` — reflect code changes back into the configured lens files,
 * run the configured runner with the pull prompt, and record the code hash
 * baseline used for incremental detection on the next run.
 */
export async function runPull(args: PullArgs): Promise<ExitCode> {
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

  const repoRoot = dirname(configPath);

  if (!(await ensureLensFilesExist(config, repoRoot))) {
    return Exit.FAIL;
  }

  const relSources = await resolvePullSources(config, repoRoot);
  if (relSources === null) {
    console.error(FALLBACK_SOURCE_GUIDANCE);
    return Exit.FAIL;
  }

  const fileHashes = await hashRelativeFiles(repoRoot, relSources);
  const merkleRoot = computeMerkleRoot(fileHashes);
  const lockPath = resolve(repoRoot, LOCK_REL);
  const lock = await readLock(lockPath);
  const diff = diffTask("pull", fileHashes, merkleRoot, lock.tasks.pull);

  if (!(diff.changed || args.force)) {
    console.log("lens: pull — nothing to pull");
    return Exit.SUCCESS;
  }

  const changedFiles = listPromptChangedFiles(diff);
  const changedCodeSnapshots = await buildChangedCodeSnapshots(
    repoRoot,
    changedFiles
  );
  const lensSnapshots = await readLensSnapshots(config, repoRoot);

  let gitDiffSinceApplied: PromptVars["git_diff_since"];
  if (await isGitRepo(repoRoot)) {
    const gitDiff = await diffSince(
      PULL_REF,
      [".", ...GIT_CODE_EXCLUDES],
      repoRoot
    );
    if (gitDiff !== null) {
      gitDiffSinceApplied = { "lens/applied": gitDiff };
    }
  }

  const prompt = buildPullPrompt({
    config,
    lensSnapshots,
    changedFiles,
    changedCodeSnapshots,
    gitDiffSince: gitDiffSinceApplied,
  });

  if (args.dryRun) {
    console.log(prompt);
    return Exit.SUCCESS;
  }

  const startedAt = Date.now();
  console.log(
    `lens: pull — running prompt via runner (${changedFiles.length} changed files)`
  );
  const result = await executeRunner(config.runner, prompt);
  const elapsedMs = Date.now() - startedAt;

  if (result.exitCode !== 0) {
    console.error(
      `lens: pull — runner failed (exit ${result.exitCode}) after ${elapsedMs}ms`
    );
    return Exit.FAIL;
  }

  console.log(`lens: pull — runner completed in ${elapsedMs}ms`);

  // Pull wrote lens files from the runner's single prompt, so the result is
  // by construction an internally-consistent baseline. Refresh both tasks:
  // `pull` tracks code hashes (drift detection), `sync` tracks lens hashes
  // (so a subsequent `lens sync` doesn't see false drift).
  const postLensHashes = await hashRelativeFiles(
    repoRoot,
    config.lenses.map((lens) => lens.path)
  );
  const postLensMerkle = computeMerkleRoot(postLensHashes);

  await writeLock(lockPath, {
    ...lock,
    tasks: {
      ...lock.tasks,
      pull: makeLockEntry(fileHashes, merkleRoot),
      sync: makeLockEntry(postLensHashes, postLensMerkle),
    },
  });

  if (!(await isGitRepo(repoRoot))) {
    return Exit.SUCCESS;
  }

  if (
    (await isWorkingTreeClean(repoRoot)) ||
    (await isCleanIgnoringLockfile(repoRoot))
  ) {
    const head = await getHead(repoRoot);
    if (head) {
      try {
        await updateRef(PULL_REF, head, repoRoot);
      } catch {
        // Ref advancement is best-effort after a successful pull.
      }
    }
    return Exit.SUCCESS;
  }

  console.log(DIRTY_TREE_GUIDANCE);
  return Exit.SUCCESS;
}
