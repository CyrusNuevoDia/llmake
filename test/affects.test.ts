import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-affects-"));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

async function runLens(
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
  } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd: opts.cwd ?? tempDir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

async function writeRunnerScript(path: string, body: string): Promise<void> {
  await Bun.write(
    path,
    `#!/bin/bash
${body}
`
  );
  spawnSync("chmod", ["+x", path]);
}

async function writeAffectsProject(
  dir: string,
  includeAffects: boolean
): Promise<void> {
  await mkdir(join(dir, ".lenses"), { recursive: true });

  const affectsBlock = includeAffects
    ? `    affects:
      - bravo
`
    : "";

  await writeFile(
    join(dir, ".lenses/config.yaml"),
    `intent: affects test
runner: echo {prompt}
lenses:
  - name: alpha
    path: .lenses/alpha.md
    description: Alpha lens
${affectsBlock}  - name: bravo
    path: .lenses/bravo.md
    description: Bravo lens
  - name: charlie
    path: .lenses/charlie.md
    description: Charlie lens
`
  );
  await writeFile(join(dir, ".lenses/alpha.md"), "# alpha\n");
  await writeFile(join(dir, ".lenses/bravo.md"), "# bravo\n");
  await writeFile(join(dir, ".lenses/charlie.md"), "# charlie\n");
}

async function writeInitialSyncLock(dir: string): Promise<void> {
  const runnerPath = join(dir, "noop-runner.sh");
  await writeRunnerScript(runnerPath, ":");

  const result = await runLens(["sync"], {
    cwd: dir,
    env: { LENS_RUNNER_OVERRIDE: `${runnerPath} {prompt}` },
  });

  if (result.exitCode !== 0) {
    throw new Error(`initial sync failed: ${result.stderr || result.stdout}`);
  }
}

describe("lens sync affects graph", () => {
  it("limits the dry-run prompt to changed lenses plus their affects closure", async () => {
    await writeAffectsProject(tempDir, true);
    await writeInitialSyncLock(tempDir);
    await writeFile(join(tempDir, ".lenses/alpha.md"), "# alpha\nchanged\n");

    const { exitCode, stdout, stderr } = await runLens(["sync", "--dry-run"], {
      cwd: tempDir,
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("### alpha");
    expect(stdout).toContain("### bravo");
    expect(stdout).not.toContain("### charlie");
    expect(stdout).toContain('<file path=".lenses/alpha.md">');
    expect(stdout).toContain('<file path=".lenses/bravo.md">');
    expect(stdout).not.toContain('<file path=".lenses/charlie.md">');
  });

  it("keeps the full lens set in the prompt when no affects graph is declared", async () => {
    await writeAffectsProject(tempDir, false);
    await writeInitialSyncLock(tempDir);
    await writeFile(join(tempDir, ".lenses/alpha.md"), "# alpha\nchanged\n");

    const { exitCode, stdout, stderr } = await runLens(["sync", "--dry-run"], {
      cwd: tempDir,
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("### alpha");
    expect(stdout).toContain("### bravo");
    expect(stdout).toContain("### charlie");
  });
});
