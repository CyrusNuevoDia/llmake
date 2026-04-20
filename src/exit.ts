/**
 * Shared exit codes across every `lens` verb.
 * Keep these in sync with SPEC.md §11.5.
 */
export const Exit = {
  SUCCESS: 0,
  FAIL: 1,
  CONFIG: 2,
  GIT: 3,
} as const;

export type ExitCode = (typeof Exit)[keyof typeof Exit];
