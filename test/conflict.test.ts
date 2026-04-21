import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-conflict-"));
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

async function writeConflictProject(dir: string): Promise<void> {
  await mkdir(join(dir, ".lenses"), { recursive: true });
  await writeFile(
    join(dir, ".lenses/config.yaml"),
    `intent: conflict test
runner: echo {prompt}
lenses:
  - name: schema
    path: .lenses/schema.md
    description: Schema lens
  - name: api
    path: .lenses/api.md
    description: API lens
  - name: roles
    path: .lenses/roles.md
    description: Roles lens
`
  );
  await writeFile(join(dir, ".lenses/schema.md"), "# schema\n");
  await writeFile(join(dir, ".lenses/api.md"), "# api\n");
  await writeFile(join(dir, ".lenses/roles.md"), "# roles\n");
}

describe("lens sync conflict surfacing", () => {
  it("surfaces .lens/conflicts.md when the runner writes one", async () => {
    await writeConflictProject(tempDir);
    await mkdir(join(tempDir, ".lens"), { recursive: true });

    const runnerPath = join(tempDir, "conflict-runner.sh");
    await writeRunnerScript(
      runnerPath,
      `mkdir -p .lens
cat > .lens/conflicts.md <<'EOF'
# Sync conflicts

## schema
schema cannot satisfy both incoming edits

Changes:
- api now expects normalized relational tables
- roles now assumes embedded document payloads
EOF`
    );

    const { exitCode, stdout, stderr } = await runLens(["sync"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${runnerPath} {prompt}` },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("lens: sync — runner completed");
    expect(stdout).toContain(
      "lens: sync recorded unresolved conflicts in .lens/conflicts.md:"
    );
    expect(stdout).toContain("# Sync conflicts");
    expect(stdout).toContain("## schema");
    expect(stdout).toContain("schema cannot satisfy both incoming edits");
    expect(stdout).toContain("- api now expects normalized relational tables");
    expect(stdout).toContain("Resolve them manually and re-run `lens sync`");
  });

  it("does not mention conflicts when the runner writes no file", async () => {
    await writeConflictProject(tempDir);

    const runnerPath = join(tempDir, "clean-runner.sh");
    await writeRunnerScript(runnerPath, "true");

    const { exitCode, stdout } = await runLens(["sync"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${runnerPath} {prompt}` },
    });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("unresolved conflicts");
  });

  it("clears a stale .lens/conflicts.md when the current run has none", async () => {
    await writeConflictProject(tempDir);
    await mkdir(join(tempDir, ".lens"), { recursive: true });
    await writeFile(join(tempDir, ".lens/conflicts.md"), "# Stale\n");

    const runnerPath = join(tempDir, "clean-runner.sh");
    await writeRunnerScript(runnerPath, "true");

    const { exitCode } = await runLens(["sync"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${runnerPath} {prompt}` },
    });

    expect(exitCode).toBe(0);
    const leftover = Bun.file(join(tempDir, ".lens/conflicts.md"));
    expect(await leftover.exists()).toBe(false);
  });
});
