import { dirname, resolve } from "node:path";
import { discoverConfig, loadConfig } from "../config";
import { Exit, type ExitCode } from "../exit";
import { changedSince, refExists } from "../git";
import { assembleApplyBundle } from "./apply";

export interface DiffArgs {
  configPath?: string;
}

const APPLIED_REF = "refs/lens/applied";
const NO_CONFIG_MESSAGE = "lens: no config file found (.lenses/config.yaml)";
const NO_BASELINE_NOTE = "(no baseline yet — treat current as baseline)";
const NOT_GIT_CODE_NOTE = "(not a git repo — code drift tracking disabled)";

function formatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("lens: ") ? message : `lens: ${message}`;
}

function getWorkspaceRoot(configPath: string): string {
  return resolve(dirname(configPath), "..");
}

function formatSummary(input: {
  lensDriftCount: number;
  codeDriftCount: number;
  inGitRepo: boolean;
  hasBaseline: boolean;
}): string {
  let codeLine = NOT_GIT_CODE_NOTE;
  if (input.inGitRepo) {
    codeLine = input.hasBaseline
      ? `${input.codeDriftCount} files changed since ${APPLIED_REF}`
      : NO_BASELINE_NOTE;
  }

  return [
    "Lens diff (preview of what `lens apply` would hand off to plan mode)",
    "",
    "Drift summary:",
    `  Lenses:   ${input.lensDriftCount} files`,
    `  Code:     ${codeLine}`,
  ].join("\n");
}

export async function runDiff(args: DiffArgs): Promise<ExitCode> {
  const configPath = args.configPath
    ? resolve(args.configPath)
    : await discoverConfig();

  if (!configPath) {
    console.error(NO_CONFIG_MESSAGE);
    return Exit.CONFIG;
  }

  try {
    await loadConfig(configPath);
  } catch (error) {
    console.error(formatErrorMessage(error));
    return Exit.CONFIG;
  }

  try {
    const bundle = await assembleApplyBundle(configPath);
    const workspaceRoot = getWorkspaceRoot(configPath);
    let lensDriftCount = 0;
    let hasBaseline = false;

    if (bundle.inGitRepo) {
      hasBaseline = await refExists(APPLIED_REF, workspaceRoot);
      if (hasBaseline) {
        lensDriftCount = (
          await changedSince(APPLIED_REF, [".lenses/"], workspaceRoot)
        ).length;
      }
    }

    console.log(
      `${formatSummary({
        lensDriftCount,
        codeDriftCount: bundle.codeDriftCount,
        inGitRepo: bundle.inGitRepo,
        hasBaseline,
      })}\n\n${bundle.text}`
    );
    return Exit.SUCCESS;
  } catch (error) {
    console.error(formatErrorMessage(error));
    return Exit.FAIL;
  }
}
