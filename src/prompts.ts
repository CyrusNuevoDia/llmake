import type { LensDef } from "./types";

/**
 * Prompt used by `lens init` and `lens add` to populate empty lens files
 * from the intent + other lenses' current state.
 * Verbatim from SPEC.md §5.1.
 */
export const GENERATE_PROMPT = `You are initializing a set of lens files that describe a software system.

INTENT (what the user wants to build):
{intent}

LENS DEFINITIONS (what each lens should contain):
{lenses}

CURRENT STATE OF LENS FILES (some may be empty):
{changed_files_content}

Populate any lens files that are currently empty or missing. For each lens,
use its description as guidance for format and content. Maintain internal
consistency: if the schema lens defines a User table, the roles lens should
reference it, etc.

Do nothing to lens files that already have content. Making no changes to
non-empty files is correct.

Use Write or Edit tools to update the files at the paths listed in the
lens definitions.
`;

/**
 * Prompt used by `lens sync` to propagate edits across the lens set.
 * Verbatim from SPEC.md §5.2.
 */
export const SYNC_PROMPT = `You are maintaining consistency across a set of lens files.

INTENT:
{intent}

LENS DEFINITIONS:
{lenses}

CHANGES SINCE LAST SYNC:
{git_diff_since:lens/synced}

CURRENT FULL CONTENT OF ALL LENSES:
{changed_files_content}

The user has edited one or more lens files. Read the diff above to see what
changed. Update any other lens files that need to change to restore
consistency.

Rules:
- Preserve human-authored prose where possible. Prefer targeted edits over
  full rewrites.
- Making no changes to a lens that is already consistent is correct and
  expected. Do not rewrite files that don't need updates.
- If two changes imply contradictory updates to a third lens, do not guess.
  Instead, leave the third lens unchanged and record the conflict in
  \`.lenses/conflicts.md\` (see below).
- Use Edit (preferred) or Write tools to update files.

Conflict reporting:
If you detect any conflict you cannot resolve, write a markdown file at
\`.lenses/conflicts.md\` using the Write tool. Use this structure:

\`\`\`markdown
# Sync conflicts

## <lens-name>
<one-line description of the contradiction>

Changes:
- first change pulling the lens in direction A
- second change pulling it in direction B

## <next-lens-name>
...
\`\`\`

Emit one \`##\` section per conflicted lens. Do NOT create the file if there
are no conflicts. Lens will surface this file to the user after you exit.
`;

/**
 * Prompt used by `lens pull` to reflect code changes back into lenses.
 * Verbatim from SPEC.md §5.3.
 */
export const PULL_PROMPT = `You are updating lens files to reflect the current state of the codebase.

INTENT:
{intent}

LENS DEFINITIONS:
{lenses}

CURRENT LENS CONTENT:
{changed_files_content}

CODE CHANGES SINCE LAST PULL:
{git_diff_since:lens/applied}

For each lens, determine whether the code state implies changes to that
lens. If yes, update the lens file. If no, leave it alone.

Focus on intent-level changes. Do not pollute lenses with implementation
details — only surface what belongs at the lens's level of abstraction.

Use Edit or Write tools to update files.
`;

/**
 * Placeholder substituted for `{git_diff_since:<ref>}` when the ref doesn't
 * exist (e.g., first sync in a new repo).
 */
export const MISSING_REF_PLACEHOLDER =
  "(no previous sync — treat current state as baseline)";

/**
 * A file that has been touched, surfaced in `{changed_files}` and
 * `{changed_files_content}` substitutions.
 */
export interface FileSnapshot {
  path: string;
  content: string;
}

/**
 * Git diff entry for a given ref → actual diff text (or null if ref missing).
 * Keyed by ref name (e.g., "lens/synced").
 */
export type GitDiffMap = Record<string, string | null>;

/**
 * All inputs to the prompt-assembly step.
 */
export interface PromptVars {
  intent: string;
  lenses: LensDef[];
  changed_files: string[];
  changed_files_content: FileSnapshot[];
  /** Optional per-ref diff lookup. Missing entries use the placeholder. */
  git_diff_since?: GitDiffMap;
}

/**
 * Format the `{lenses}` block: structured dump per lens with current content.
 */
function formatLensesBlock(
  lenses: LensDef[],
  snapshots: FileSnapshot[]
): string {
  const byPath = new Map(snapshots.map((s) => [s.path, s.content]));
  const chunks: string[] = [];

  for (const lens of lenses) {
    const content = byPath.get(lens.path) ?? "(not loaded)";
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

/**
 * Format the `{changed_files_content}` block: structured per-file snapshot.
 */
function formatChangedFilesContent(snapshots: FileSnapshot[]): string {
  if (snapshots.length === 0) {
    return "(no files)";
  }
  return snapshots
    .map((s) => [`<file path="${s.path}">`, s.content, "</file>"].join("\n"))
    .join("\n\n");
}

const GIT_DIFF_PATTERN = /\{git_diff_since:([^}]+)\}/g;

/**
 * Substitute prompt-template variables. Unused variables are left intact.
 * Supports `{intent}`, `{lenses}`, `{changed_files}`, `{changed_files_content}`,
 * and `{git_diff_since:<ref>}` (looked up in `vars.git_diff_since`; missing
 * refs substitute `MISSING_REF_PLACEHOLDER`).
 */
export function assemblePrompt(template: string, vars: PromptVars): string {
  const lensesBlock = formatLensesBlock(
    vars.lenses,
    vars.changed_files_content
  );
  const changedContent = formatChangedFilesContent(vars.changed_files_content);
  const changedList =
    vars.changed_files.length > 0 ? vars.changed_files.join("\n") : "(none)";

  let result = template
    .replaceAll("{intent}", vars.intent)
    .replaceAll("{lenses}", lensesBlock)
    .replaceAll("{changed_files_content}", changedContent)
    .replaceAll("{changed_files}", changedList);

  result = result.replace(GIT_DIFF_PATTERN, (_, ref: string) => {
    const diffs = vars.git_diff_since ?? {};
    const diff = diffs[ref];
    if (diff === undefined || diff === null) {
      return MISSING_REF_PLACEHOLDER;
    }
    return diff;
  });

  return result;
}
