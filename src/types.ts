/**
 * The resolved, validated Lens configuration shape.
 */
export interface LensConfig {
  /** Seed description of the system. Passed into every generation prompt. */
  intent: string;
  /** Runner command template. Must contain `{prompt}` placeholder. */
  runner: string;
  /** Optional global settings. */
  settings?: LensSettings;
  /** The lens set. Order is not significant. */
  lenses: LensDef[];
}

/**
 * Optional settings block on `LensConfig`.
 */
export interface LensSettings {
  /** If true, sync/pull skip user review. Default false. */
  autoApprove?: boolean;
}

/**
 * A single lens definition.
 */
export interface LensDef {
  /** Unique identifier. Used in CLI args. */
  name: string;
  /** File path. Can be anywhere in repo, not just `.lenses/`. */
  path: string;
  /** What the lens should contain. Used as generation guidance. */
  description: string;
}

/**
 * Internal task kinds that Lens runs.
 * Derived from the lens set, not user-declared.
 */
export type TaskKind = "generate" | "sync" | "pull";

/**
 * The `.lens/lock.json` file shape.
 * Tracks the state of each task's last run for incremental change detection.
 */
export interface LensLock {
  /** Lock file format version for future compatibility. */
  version: 1;
  /** Map of task kinds to their lock entries. */
  tasks: Partial<Record<TaskKind, TaskLockEntry>>;
}

/**
 * Lock entry for a single task run.
 */
export interface TaskLockEntry {
  /** ISO 8601 timestamp of when the task was last executed. */
  last_run: string;
  /** Merkle root over all sources at last run, format "sha256:<hex>". */
  sources_hash: string;
  /** Map of file paths to their content hashes, format "sha256:<hex>". */
  files: Record<string, string>;
}

/**
 * Result of diffing current state against lockfile.
 */
export interface TaskDiff {
  /** The task kind being diffed. */
  task: TaskKind;
  /** Whether any source files have changed since the last run. */
  changed: boolean;
  /** Paths to files that are new or have been modified. */
  changed_files: string[];
  /** Paths to files that were in the lock but no longer match. */
  removed_files: string[];
  /** All files currently matched by the task's source set. */
  all_files: string[];
}
