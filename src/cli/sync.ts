import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
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

interface LensConflict {
  lens: string;
  what: string;
  changes: string[];
}

function filterSnapshotsForLenses(
  snapshots: FileSnapshot[],
  lenses: LensDef[]
): FileSnapshot[] {
  const lensPaths = new Set(lenses.map((lens) => lens.path));
  return snapshots.filter((snapshot) => lensPaths.has(snapshot.path));
}

function extractLensConflictField(block: string, field: string): string | null {
  const openTag = `<${field}>`;
  const start = block.indexOf(openTag);
  if (start === -1) {
    return null;
  }

  const contentStart = start + openTag.length;
  const end = block.indexOf(`</${field}>`, contentStart);
  if (end === -1) {
    return null;
  }

  return block.slice(contentStart, end).trim();
}

function extractLensConflictName(block: string): string | null {
  const startTagEnd = block.indexOf(">");
  if (startTagEnd === -1) {
    return null;
  }

  const startTag = block.slice(0, startTagEnd);
  const attr = 'lens="';
  const attrStart = startTag.indexOf(attr);
  if (attrStart === -1) {
    return null;
  }

  const valueStart = attrStart + attr.length;
  const valueEnd = startTag.indexOf('"', valueStart);
  if (valueEnd === -1) {
    return null;
  }

  return startTag.slice(valueStart, valueEnd).trim();
}

function parseLensConflictChanges(changesBlock: string): string[] {
  return changesBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      if (line.startsWith("- ")) {
        return line.slice(2).trim();
      }
      return line;
    });
}

function parseLensConflicts(output: string): LensConflict[] {
  const conflicts: LensConflict[] = [];
  const openTag = "<lens-conflict ";
  const closeTag = "</lens-conflict>";
  let searchIndex = 0;

  while (searchIndex < output.length) {
    const blockStart = output.indexOf(openTag, searchIndex);
    if (blockStart === -1) {
      break;
    }

    const blockEnd = output.indexOf(closeTag, blockStart);
    if (blockEnd === -1) {
      break;
    }

    const block = output.slice(blockStart, blockEnd + closeTag.length);
    const lens = extractLensConflictName(block);
    const what = extractLensConflictField(block, "what");
    const changesBlock = extractLensConflictField(block, "changes");

    if (lens && what && changesBlock) {
      conflicts.push({
        lens,
        what,
        changes: parseLensConflictChanges(changesBlock),
      });
    }

    searchIndex = blockEnd + closeTag.length;
  }

  return conflicts;
}

function formatLensConflictReport(conflicts: LensConflict[]): string {
  const sections = conflicts.map((conflict) =>
    [
      `  ⚠ ${conflict.lens}`,
      `    ${conflict.what}`,
      "    changes:",
      ...conflict.changes.map((change) => `      • ${change}`),
    ].join("\n")
  );

  return [
    `lens: sync detected ${conflicts.length} conflict(s):`,
    "",
    sections.join("\n\n"),
    "",
    "Resolve them manually and re-run `lens sync`.",
  ].join("\n");
}

/**
 * `lens sync` — reconcile lens files with each other, invoke the configured
 * runner with the sync prompt, and record the resulting file hashes.
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

  const startedAt = Date.now();
  console.log(
    `lens: sync — running prompt via runner (${ctx.diff.changed_files.length} changed files)`
  );
  const result = await executeRunner(config.runner, prompt, {
    capture: true,
  });
  const elapsedMs = Date.now() - startedAt;

  if (result.exitCode !== 0) {
    console.error(
      `lens: sync — runner failed (exit ${result.exitCode}) after ${elapsedMs}ms`
    );
    return Exit.FAIL;
  }

  console.log(`lens: sync — runner completed in ${elapsedMs}ms`);
  const conflicts = parseLensConflicts(result.stdout);
  if (conflicts.length > 0) {
    console.log(formatLensConflictReport(conflicts));
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
    "lens: sync complete. Commit changes and run 'lens mark-synced' to advance ref."
  );
  return Exit.SUCCESS;
}
