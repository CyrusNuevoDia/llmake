import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config";
import { Exit, type ExitCode } from "../exit";
import { getHead, isGitRepo, updateRef } from "../git";
import { computeMerkleRoot, hashFile } from "../hash";
import { writeLock } from "../lock";
import type { FileSnapshot } from "../prompts";
import { assemblePrompt, GENERATE_PROMPT } from "../prompts";
import { executeRunner } from "../runner";
import {
  INTENT_PLACEHOLDER,
  loadTemplate,
  substituteIntent,
} from "../templates";

export interface InitArgs {
  description?: string;
  template: string;
  force: boolean;
  dryRun: boolean;
  configPath?: string;
}

const DEFAULT_CONFIG_REL = ".lenses/config.yaml";
const LOCK_REL = ".lens/lock.json";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function promptForIntent(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "lens init: no description provided and stdin is not a TTY — pass a description as a positional argument"
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question("Describe your system: ")).trim();
  } finally {
    rl.close();
  }
}

async function ensureLensFiles(
  configDir: string,
  lensPaths: string[]
): Promise<void> {
  for (const lensPath of lensPaths) {
    const full = resolve(configDir, "..", lensPath);
    await mkdir(dirname(full), { recursive: true });
    if (!(await fileExists(full))) {
      await writeFile(full, "");
    }
  }
}

async function snapshotLensFiles(
  configDir: string,
  lensPaths: string[]
): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = [];
  for (const lensPath of lensPaths) {
    const full = resolve(configDir, "..", lensPath);
    let content = "";
    try {
      content = await readFile(full, "utf-8");
    } catch {
      // treat missing file as empty
    }
    snapshots.push({ path: lensPath, content });
  }
  return snapshots;
}

/**
 * Warn (non-fatal) if the generate runner exited 0 but didn't modify any
 * lens file — a common symptom of Claude entering plan mode instead of
 * applying edits. We don't fail because a user's custom runner may have
 * legitimate no-op behavior.
 */
async function warnIfRunnerNoOp(
  configDir: string,
  lenses: { path: string }[],
  preSnapshots: FileSnapshot[]
): Promise<void> {
  const postSnapshots = await snapshotLensFiles(
    configDir,
    lenses.map((l) => l.path)
  );
  const preByPath = new Map(preSnapshots.map((s) => [s.path, s.content]));
  const anyLensChanged = postSnapshots.some(
    (s) => s.content !== preByPath.get(s.path)
  );
  if (!anyLensChanged) {
    console.warn(
      "lens: warning — runner exited 0 but no lens files were modified. If using Claude, add `--permission-mode acceptEdits` so it doesn't enter plan mode."
    );
  }
}

/**
 * `lens init` — scaffold a new Lens setup, run the generate prompt to
 * populate lens files from the intent + template, write the lockfile, and
 * advance `refs/lens/synced` if the working tree is in a git repo.
 */
export async function runInit(args: InitArgs): Promise<ExitCode> {
  const cwd = process.cwd();
  const configPath = args.configPath
    ? resolve(args.configPath)
    : resolve(cwd, DEFAULT_CONFIG_REL);
  const configDir = dirname(configPath);

  if ((await fileExists(configPath)) && !args.force) {
    console.error(
      `lens: ${configPath} already exists (use --force to overwrite)`
    );
    return Exit.FAIL;
  }

  const intent =
    args.description && args.description.trim().length > 0
      ? args.description.trim()
      : await promptForIntent();

  if (!intent) {
    console.error("lens: description must not be empty");
    return Exit.FAIL;
  }

  const { raw } = await loadTemplate(args.template);
  if (!raw.includes(INTENT_PLACEHOLDER)) {
    console.error(
      `lens: template "${args.template}" is missing the ${INTENT_PLACEHOLDER} marker`
    );
    return Exit.FAIL;
  }
  const finalYaml = substituteIntent(raw, intent);

  if (args.dryRun) {
    console.log(finalYaml);
    return Exit.SUCCESS;
  }

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, finalYaml);

  // Re-read the config we just wrote so Zod validates the substituted form.
  const config = await loadConfig(configPath);

  await ensureLensFiles(
    configDir,
    config.lenses.map((l) => l.path)
  );

  if (config.lenses.length === 0) {
    console.log(
      "lens: initialized blank config (no lenses yet — use `lens add`)"
    );
  } else {
    const snapshots = await snapshotLensFiles(
      configDir,
      config.lenses.map((l) => l.path)
    );
    const prompt = assemblePrompt(GENERATE_PROMPT, {
      intent: config.intent,
      lenses: config.lenses,
      changed_files: config.lenses.map((l) => l.path),
      changed_files_content: snapshots,
    });
    console.log(
      `lens: running generate prompt via runner (${config.lenses.length} lenses)`
    );
    const result = await executeRunner(config.runner, prompt);
    if (result.exitCode !== 0) {
      console.error(`lens: generate runner failed (exit ${result.exitCode})`);
      return Exit.FAIL;
    }

    await warnIfRunnerNoOp(configDir, config.lenses, snapshots);
  }

  const populated = await snapshotLensFiles(
    configDir,
    config.lenses.map((l) => l.path)
  );
  const fileHashes: Record<string, string> = {};
  for (const snap of populated) {
    const full = resolve(configDir, "..", snap.path);
    fileHashes[snap.path] = await hashFile(full);
  }
  const merkleRoot = computeMerkleRoot(fileHashes);
  const lockPath = resolve(configDir, "..", LOCK_REL);
  await writeLock(lockPath, {
    version: 1,
    tasks: {
      generate: {
        last_run: new Date().toISOString(),
        sources_hash: merkleRoot,
        files: fileHashes,
      },
    },
  });

  if (await isGitRepo(cwd)) {
    const head = await getHead(cwd);
    if (head) {
      try {
        await updateRef("refs/lens/synced", head, cwd);
      } catch {
        // Preserve init's existing best-effort ref advancement behavior.
      }
    }
  }

  console.log(
    `lens: initialized ${configPath.replace(`${cwd}/`, "")} (${config.lenses.length} lenses). Review .lenses/, commit, then edit any lens to start iterating.`
  );
  return Exit.SUCCESS;
}
