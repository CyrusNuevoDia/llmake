import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
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
import { readLock, writeLock } from "../lock";
import { assemblePrompt, type FileSnapshot, SYNC_PROMPT } from "../prompts";
import { executeRunner } from "../runner";
import { assembleSyncContext } from "../tasks";
import type { LensConfig, LensDef, LensLock, TaskLockEntry } from "../types";

export interface SyncArgs {
  force: boolean;
  dryRun: boolean;
  configPath?: string;
}

const LOCK_REL = ".lens/lock.json";
const CONFLICTS_REL = ".lens/conflicts.md";

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

function isCleanIgnoringLockfile(cwd: string): Promise<boolean> {
  return new Promise((resolveStatus) => {
    const stdoutChunks: Buffer[] = [];
    const proc = spawn(
      "git",
      ["status", "--porcelain", "--", ".", ":(exclude).lens/lock.json"],
      {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

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

function syncBaselineLock(lock: LensLock): LensLock {
  const syncEntry = lock.tasks.sync ?? lock.tasks.generate;
  if (!syncEntry) {
    return lock;
  }

  return {
    ...lock,
    tasks: {
      ...lock.tasks,
      sync: syncEntry,
    },
  };
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

function filterSnapshotsForLenses(
  snapshots: FileSnapshot[],
  lenses: LensDef[]
): FileSnapshot[] {
  const lensPaths = new Set(lenses.map((lens) => lens.path));
  return snapshots.filter((snapshot) => lensPaths.has(snapshot.path));
}

/**
 * `lens sync` — reconcile lens files with each other, invoke the configured
 * runner with the sync prompt, and record the resulting file hashes.
 *
 * Unresolved conflicts travel as a side-channel file: the sync prompt
 * instructs the runner to write `.lens/conflicts.md` when it can't
 * resolve contradictory edits. After the runner exits, `lens sync`
 * surfaces that file if present — no stdout parsing required, so the
 * mechanism is runner-agnostic.
 */
export async function runSync(args: SyncArgs): Promise<ExitCode> {
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

  const configDir = dirname(configPath);
  const repoRoot = resolve(configDir, "..");

  for (const lens of config.lenses) {
    const lensPath = resolve(repoRoot, lens.path);
    if (!(await fileExists(lensPath))) {
      console.error(
        `lens: sync — missing lens file: ${lens.path}. Run 'lens add' or create it manually.`
      );
      return Exit.FAIL;
    }
  }

  const lockPath = resolve(repoRoot, LOCK_REL);
  const lock = await readLock(lockPath);
  const ctx = await assembleSyncContext(
    config,
    configDir,
    syncBaselineLock(lock)
  );

  if (!(ctx.diff.changed || args.force)) {
    console.log("lens: sync — nothing to sync");
    return Exit.SUCCESS;
  }

  const gitDiff = await diffSince("refs/lens/synced", ctx.relSources, repoRoot);
  const promptSnapshots = filterSnapshotsForLenses(
    ctx.snapshots,
    ctx.lensesForPrompt
  );
  const promptLensPaths = new Set(ctx.lensesForPrompt.map((lens) => lens.path));
  const prompt = assemblePrompt(SYNC_PROMPT, {
    intent: config.intent,
    lenses: ctx.lensesForPrompt,
    changed_files: ctx.diff.changed_files.filter((path) =>
      promptLensPaths.has(path)
    ),
    changed_files_content: promptSnapshots,
    git_diff_since: gitDiff == null ? undefined : { "lens/synced": gitDiff },
  });

  if (args.dryRun) {
    console.log(prompt);
    return Exit.SUCCESS;
  }

  // Clear any stale conflicts file from a prior sync so absence after this
  // run is a clean "no conflicts" signal.
  const conflictsPath = resolve(repoRoot, CONFLICTS_REL);
  await rm(conflictsPath, { force: true });

  const startedAt = Date.now();
  console.log(
    `lens: sync — running prompt via runner (${ctx.diff.changed_files.length} changed files)`
  );
  const result = await executeRunner(config.runner, prompt);
  const elapsedMs = Date.now() - startedAt;

  if (result.exitCode !== 0) {
    console.error(
      `lens: sync — runner failed (exit ${result.exitCode}) after ${elapsedMs}ms`
    );
    return Exit.FAIL;
  }

  console.log(`lens: sync — runner completed in ${elapsedMs}ms`);

  if (await fileExists(conflictsPath)) {
    const body = await readFile(conflictsPath, "utf-8");
    console.log(
      `\nlens: sync recorded unresolved conflicts in ${CONFLICTS_REL}:\n`
    );
    console.log(body.trim());
    console.log(
      `\nResolve them manually and re-run \`lens sync\`. (Remove ${CONFLICTS_REL} when done.)`
    );
  }

  const updatedCtx = await assembleSyncContext(config, configDir, lock);
  await writeLock(lockPath, {
    ...lock,
    tasks: {
      ...lock.tasks,
      sync: makeLockEntry(updatedCtx.fileHashes, updatedCtx.merkleRoot),
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
        await updateRef("refs/lens/synced", head, repoRoot);
      } catch {
        // Ref advancement is best-effort after a successful sync.
      }
    }
    return Exit.SUCCESS;
  }

  console.log(
    "lens: sync complete. Commit changes and run 'lens mark synced' to advance ref."
  );
  return Exit.SUCCESS;
}
