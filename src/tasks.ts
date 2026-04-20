import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computeMerkleRoot, hashFile } from "./hash";
import { diffTask } from "./lock";
import type { FileSnapshot } from "./prompts";
import type { LensConfig, LensLock, TaskDiff } from "./types";

export interface SyncTaskContext {
  lockTaskName: "sync";
  sources: string[];
  relSources: string[];
  fileHashes: Record<string, string>;
  merkleRoot: string;
  diff: TaskDiff;
  snapshots: FileSnapshot[];
}

async function readLensFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

export async function assembleSyncContext(
  config: LensConfig,
  configDir: string,
  lock: LensLock
): Promise<SyncTaskContext> {
  const repoRoot = resolve(configDir, "..");
  const relSources = config.lenses.map((lens) => lens.path);
  const sources = relSources.map((lensPath) => resolve(repoRoot, lensPath));

  const snapshots: FileSnapshot[] = [];
  const fileHashes: Record<string, string> = {};

  for (const [index, source] of sources.entries()) {
    const relPath = relSources[index];
    snapshots.push({
      path: relPath,
      content: await readLensFile(source),
    });
    fileHashes[relPath] = await hashFile(source);
  }

  const merkleRoot = computeMerkleRoot(fileHashes);
  const diff = diffTask("sync", fileHashes, merkleRoot, lock.tasks.sync);

  return {
    lockTaskName: "sync",
    sources,
    relSources,
    fileHashes,
    merkleRoot,
    diff,
    snapshots,
  };
}
