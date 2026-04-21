import { dirname, resolve } from "node:path";
import { discoverConfig, loadConfig } from "../config";
import { Exit, type ExitCode } from "../exit";
import { getHead, isGitRepo, readRef, updateRef } from "../git";
import { computeMerkleRoot } from "../hash";
import { readLock, writeLock } from "../lock";
import type { LensConfig, LensLock, TaskLockEntry } from "../types";
import { hashRelativeFiles, resolvePullSources } from "./pull";

export type MarkWhich = "synced" | "applied";

export interface MarkArgs {
  which?: string;
  cwd?: string;
}

const LOCK_REL = ".lens/lock.json";

function parseWhich(raw: string | undefined): MarkWhich | null {
  if (raw === "synced" || raw === "applied") {
    return raw;
  }
  return null;
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

async function loadConfigIfPresent(
  cwd: string
): Promise<{ configPath: string; config: LensConfig } | null> {
  const configPath = await discoverConfig(cwd);
  if (!configPath) {
    return null;
  }
  try {
    const config = await loadConfig(configPath);
    return { configPath, config };
  } catch {
    return null;
  }
}

async function buildMarkLockEntry(
  which: MarkWhich,
  config: LensConfig,
  repoRoot: string
): Promise<TaskLockEntry | null> {
  if (which === "synced") {
    const hashes = await hashRelativeFiles(
      repoRoot,
      config.lenses.map((lens) => lens.path)
    );
    return makeLockEntry(hashes, computeMerkleRoot(hashes));
  }

  const sources = await resolvePullSources(config, repoRoot);
  if (sources === null) {
    return null;
  }
  const hashes = await hashRelativeFiles(repoRoot, sources);
  return makeLockEntry(hashes, computeMerkleRoot(hashes));
}

function withUpdatedTask(
  lock: LensLock,
  which: MarkWhich,
  entry: TaskLockEntry
): LensLock {
  const taskKey = which === "synced" ? "sync" : "pull";
  return {
    ...lock,
    tasks: { ...lock.tasks, [taskKey]: entry },
  };
}

async function refreshLockfileEntry(
  which: MarkWhich,
  cwd: string
): Promise<boolean> {
  const loaded = await loadConfigIfPresent(cwd);
  if (!loaded) {
    return false;
  }
  const repoRoot = resolve(dirname(loaded.configPath), "..");
  const entry = await buildMarkLockEntry(which, loaded.config, repoRoot);
  if (!entry) {
    return false;
  }
  const lockPath = resolve(repoRoot, LOCK_REL);
  const lock = await readLock(lockPath);
  await writeLock(lockPath, withUpdatedTask(lock, which, entry));
  return true;
}

export async function runMark(args: MarkArgs): Promise<ExitCode> {
  const which = parseWhich(args.which);
  if (!which) {
    console.error("lens: mark — usage: lens mark <synced|applied>");
    return Exit.FAIL;
  }

  const cwd = args.cwd ?? process.cwd();
  const ref = `refs/lens/${which}`;

  if (!(await isGitRepo(cwd))) {
    console.error(`lens: mark ${which} requires a git repository`);
    return Exit.GIT;
  }

  const head = await getHead(cwd);
  if (head === null) {
    console.error(`lens: mark ${which} could not resolve HEAD`);
    return Exit.GIT;
  }

  const refreshed = await refreshLockfileEntry(which, cwd);
  const current = await readRef(ref, cwd);
  const refAlreadyAtHead = current === head;

  if (refAlreadyAtHead && !refreshed) {
    console.error(`lens: ${ref} already at HEAD`);
    return Exit.FAIL;
  }

  if (!refAlreadyAtHead) {
    await updateRef(ref, head, cwd);
    console.log(`lens: advanced ${ref} to ${head.slice(0, 7)}`);
  }

  if (refreshed) {
    const taskKey = which === "synced" ? "sync" : "pull";
    console.log(`lens: refreshed lock.tasks.${taskKey} from current state`);
  }

  return Exit.SUCCESS;
}
