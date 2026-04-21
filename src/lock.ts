import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LensLock, TaskDiff, TaskKind, TaskLockEntry } from "./types";

/**
 * Read the lockfile from disk.
 * Returns an empty lock structure if the file doesn't exist.
 */
export async function readLock(lockPath: string): Promise<LensLock> {
  try {
    const text = await readFile(lockPath, "utf-8");
    return JSON.parse(text);
  } catch {
    return { version: 1, tasks: {} };
  }
}

/**
 * Write the lockfile to disk as formatted JSON with a trailing newline.
 * Creates the containing directory if needed (e.g., `.lenses/`).
 */
export async function writeLock(
  lockPath: string,
  lock: LensLock
): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * Diff current task state against the lockfile entry.
 * Uses Merkle root for fast-path comparison, falls back to per-file diff.
 */
export function diffTask(
  taskKind: TaskKind,
  currentFiles: Record<string, string>,
  currentRoot: string,
  lockEntry: TaskLockEntry | undefined
): TaskDiff {
  const allFiles = Object.keys(currentFiles);

  if (!lockEntry) {
    return {
      task: taskKind,
      changed: true,
      changed_files: allFiles,
      removed_files: [],
      all_files: allFiles,
    };
  }

  if (lockEntry.sources_hash === currentRoot) {
    return {
      task: taskKind,
      changed: false,
      changed_files: [],
      removed_files: [],
      all_files: allFiles,
    };
  }

  const changed: string[] = [];
  const removed: string[] = [];

  for (const [path, hash] of Object.entries(currentFiles)) {
    if (lockEntry.files[path] !== hash) {
      changed.push(path);
    }
  }

  for (const path of Object.keys(lockEntry.files)) {
    if (!(path in currentFiles)) {
      removed.push(path);
    }
  }

  return {
    task: taskKind,
    changed: changed.length > 0 || removed.length > 0,
    changed_files: changed,
    removed_files: removed,
    all_files: allFiles,
  };
}
