import { spawn } from "node:child_process";
import { Shescape } from "shescape";

/**
 * Env var that, when set, overrides the config's `runner` template for this
 * invocation. Used by tests and for ops/debugging — lets you swap models or
 * mock the LLM without editing `.lenses/config.yaml`. Must still contain the
 * `{prompt}` placeholder.
 */
export const RUNNER_OVERRIDE_ENV = "LENS_RUNNER_OVERRIDE";

export interface ExecuteRunnerOptions {
  capture?: boolean;
}

/**
 * Execute a runner template as a login shell command.
 * Uses -l -i flags to ensure user's PATH is loaded from .zshrc/.bashrc.
 *
 * Honors `$LENS_RUNNER_OVERRIDE` when set (must contain `{prompt}`).
 */
export function executeRunner(
  runnerTemplate: string,
  prompt: string,
  options: ExecuteRunnerOptions = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const override = process.env[RUNNER_OVERRIDE_ENV];
  const usingOverride = Boolean(override?.includes("{prompt}"));
  const effective = usingOverride ? (override as string) : runnerTemplate;
  const capture = options.capture === true;

  // When using the override, run under a non-login `/bin/bash` — overrides
  // are for tests/ops and should not depend on the user's interactive shell
  // startup (zshrc/bashrc) succeeding. Normal runs go through the user's
  // login shell so `$PATH` picks up tools like `claude`.
  const shell = usingOverride ? "/bin/bash" : process.env.SHELL || "/bin/sh";
  const shellArgs = usingOverride ? ["-c"] : ["-l", "-i", "-c"];
  const shescape = new Shescape({ shell });
  const quoted = shescape.quote(prompt);
  const command = effective.replace("{prompt}", quoted);

  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const proc = spawn(shell, [...shellArgs, command], {
      cwd: process.cwd(),
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: {
        ...process.env,
        FORCE_COLOR: "1",
      },
    });

    if (capture) {
      proc.stdout?.on("data", (chunk: Buffer | string) => {
        const output = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutChunks.push(output);
        process.stdout.write(output);
      });

      proc.stderr?.on("data", (chunk: Buffer | string) => {
        const output = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrChunks.push(output);
        process.stderr.write(output);
      });
    }

    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: capture ? Buffer.concat(stdoutChunks).toString("utf-8") : "",
        stderr: capture ? Buffer.concat(stderrChunks).toString("utf-8") : "",
      });
    });
  });
}
