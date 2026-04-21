import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computeMerkleRoot, hashFile } from "./hash";
import { diffTask } from "./lock";
import type { FileSnapshot } from "./prompts";
import type { LensConfig, LensDef, LensLock, TaskDiff } from "./types";

export interface SyncTaskContext {
  lockTaskName: "sync";
  sources: string[];
  relSources: string[];
  fileHashes: Record<string, string>;
  merkleRoot: string;
  diff: TaskDiff;
  snapshots: FileSnapshot[];
  lensesForPrompt: LensDef[];
}

async function readLensFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

function hasAffectsGraph(lenses: LensDef[]): boolean {
  return lenses.some(
    (lens) => Array.isArray(lens.affects) && lens.affects.length > 0
  );
}

export function pruneLensesForSync(
  lenses: LensDef[],
  changedPaths: string[]
): LensDef[] {
  if (!hasAffectsGraph(lenses)) {
    return lenses;
  }

  const lensByName = new Map<string, LensDef>();
  const nameByPath = new Map<string, string>();

  for (const lens of lenses) {
    lensByName.set(lens.name, lens);
    nameByPath.set(lens.path, lens.name);
  }

  const reachable = new Set<string>();
  const pending = changedPaths
    .map((path) => nameByPath.get(path))
    .filter((name): name is string => name !== undefined);

  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || reachable.has(name)) {
      continue;
    }

    reachable.add(name);

    const lens = lensByName.get(name);
    if (!lens) {
      continue;
    }

    for (const affectedName of lens.affects ?? []) {
      if (!reachable.has(affectedName) && lensByName.has(affectedName)) {
        pending.push(affectedName);
      }
    }
  }

  return lenses.filter((lens) => reachable.has(lens.name));
}

export async function assembleSyncContext(
  config: LensConfig,
  repoRoot: string,
  lock: LensLock
): Promise<SyncTaskContext> {
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
  const lensesForPrompt = pruneLensesForSync(config.lenses, diff.changed_files);

  return {
    lockTaskName: "sync",
    sources,
    relSources,
    fileHashes,
    merkleRoot,
    diff,
    snapshots,
    lensesForPrompt,
  };
}
