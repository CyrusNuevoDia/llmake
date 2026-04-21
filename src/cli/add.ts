import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isMap, isSeq, parseDocument, Scalar } from "yaml";
import { discoverConfig, loadConfig } from "../config";
import { Exit, type ExitCode } from "../exit";
import { getHead, isGitRepo, isWorkingTreeClean, updateRef } from "../git";
import { computeMerkleRoot, hashFile } from "../hash";
import { readLock, writeLock } from "../lock";
import { assemblePrompt, type FileSnapshot, GENERATE_PROMPT } from "../prompts";
import { executeRunner } from "../runner";
import type { LensDef, TaskLockEntry } from "../types";

export interface AddArgs {
  name?: string;
  description?: string;
  path?: string;
  configPath?: string;
  dryRun: boolean;
}

const DEFAULT_LENS_DIR = ".lenses";
const DIRTY_TREE_GUIDANCE =
  "lens: add complete. Commit changes and run 'lens mark synced' to advance ref.";
const LOCK_REL = ".lens/lock.json";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
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

function resolveRepoRoot(configPath: string): string {
  return resolve(dirname(configPath), "..");
}

function resolveLensFile(repoRoot: string, lensPath: string): string {
  return resolve(repoRoot, lensPath);
}

function normalizeDescriptionForYaml(description: string): string {
  if (description.includes("\n") && !description.endsWith("\n")) {
    return `${description}\n`;
  }
  return description;
}

function appendLensToYaml(rawText: string, lens: LensDef): string {
  const doc = parseDocument(rawText);
  if (doc.errors.length > 0) {
    throw doc.errors[0];
  }

  const lenses = doc.get("lenses", true);
  if (!isSeq(lenses)) {
    throw new Error('lens: config error in "lenses": expected sequence');
  }
  if (lenses.items.length === 0) {
    lenses.flow = false;
  }

  const lensNode = doc.createNode(
    {
      name: lens.name,
      path: lens.path,
      description: normalizeDescriptionForYaml(lens.description),
    },
    { flow: false }
  );

  if (isMap(lensNode)) {
    lensNode.flow = false;
    const description = lensNode.get("description", true);
    if (description instanceof Scalar && lens.description.includes("\n")) {
      description.type = Scalar.BLOCK_LITERAL;
    }
  }

  lenses.add(lensNode);
  return doc.toString();
}

async function ensureNewLensFile(
  fullPath: string,
  displayPath: string
): Promise<void> {
  await mkdir(dirname(fullPath), { recursive: true });

  if (await fileExists(fullPath)) {
    const content = await readFileOrEmpty(fullPath);
    if (content.length > 0) {
      console.log(`lens: add — ${displayPath} already has content; keeping it`);
    }
    return;
  }

  await writeFile(fullPath, "");
}

async function snapshotLensFiles(
  repoRoot: string,
  lenses: LensDef[]
): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = [];

  for (const lens of lenses) {
    snapshots.push({
      path: lens.path,
      content: await readFileOrEmpty(resolveLensFile(repoRoot, lens.path)),
    });
  }

  return snapshots;
}

async function hashLensFiles(
  repoRoot: string,
  lenses: LensDef[]
): Promise<Record<string, string>> {
  const fileHashes: Record<string, string> = {};

  for (const lens of lenses) {
    fileHashes[lens.path] = await hashFile(
      resolveLensFile(repoRoot, lens.path)
    );
  }

  return fileHashes;
}

export async function runAdd(args: AddArgs): Promise<ExitCode> {
  const cwd = process.cwd();
  const configPath = args.configPath
    ? resolve(args.configPath)
    : await discoverConfig();

  if (!configPath) {
    console.error("lens: no config file found (run 'lens init' first)");
    return Exit.CONFIG;
  }

  const name = args.name?.trim();
  if (!name) {
    console.error("lens add: <name> is required");
    return Exit.FAIL;
  }

  const config = await loadConfig(configPath);
  if (config.lenses.some((lens) => lens.name === name)) {
    console.error(`lens '${name}' already exists`);
    return Exit.FAIL;
  }

  if (args.description === undefined || args.description.trim().length === 0) {
    console.error("lens add: --description is required");
    return Exit.FAIL;
  }

  const lensPath = args.path ?? `${DEFAULT_LENS_DIR}/${name}.md`;
  const newLens: LensDef = {
    name,
    path: lensPath,
    description: args.description,
  };
  const rawText = await readFile(configPath, "utf-8");
  const updatedYaml = appendLensToYaml(rawText, newLens);

  if (args.dryRun) {
    console.log(updatedYaml);
    return Exit.SUCCESS;
  }

  const repoRoot = resolveRepoRoot(configPath);
  await ensureNewLensFile(resolveLensFile(repoRoot, lensPath), lensPath);
  await writeFile(configPath, updatedYaml);

  const updatedConfig = await loadConfig(configPath);
  const prompt = assemblePrompt(GENERATE_PROMPT, {
    intent: updatedConfig.intent,
    lenses: updatedConfig.lenses,
    changed_files: updatedConfig.lenses.map((lens) => lens.path),
    changed_files_content: await snapshotLensFiles(
      repoRoot,
      updatedConfig.lenses
    ),
  });

  console.log(
    `lens: running generate prompt via runner (${updatedConfig.lenses.length} lenses)`
  );
  const result = await executeRunner(updatedConfig.runner, prompt);
  if (result.exitCode !== 0) {
    console.error(`lens: generate runner failed (exit ${result.exitCode})`);
    return Exit.FAIL;
  }

  const fileHashes = await hashLensFiles(repoRoot, updatedConfig.lenses);
  const merkleRoot = computeMerkleRoot(fileHashes);
  const lockPath = resolve(repoRoot, LOCK_REL);
  const lock = await readLock(lockPath);
  lock.version = 1;
  lock.tasks.generate = makeLockEntry(fileHashes, merkleRoot);
  await writeLock(lockPath, lock);

  if (await isGitRepo(cwd)) {
    if (await isWorkingTreeClean(cwd)) {
      const head = await getHead(cwd);
      if (head) {
        try {
          await updateRef("refs/lens/synced", head, cwd);
        } catch {
          // Best-effort ref advancement only.
        }
      }
    } else {
      console.log(DIRTY_TREE_GUIDANCE);
    }
  }

  console.log(`lens: added lens '${name}' (${lensPath}). Review and commit.`);
  return Exit.SUCCESS;
}
