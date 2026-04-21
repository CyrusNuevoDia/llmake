import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-diff-"));
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

function runGit(
  args: string[],
  cwd: string
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function expectGitOk(args: string[], cwd: string): string {
  const result = runGit(args, cwd);
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`
    );
  }
  return result.stdout;
}

function gitInit(dir: string): void {
  expectGitOk(["init", "-q"], dir);
  expectGitOk(["config", "user.email", "t@t"], dir);
  expectGitOk(["config", "user.name", "test"], dir);
  expectGitOk(["commit", "--allow-empty", "-q", "-m", "init"], dir);
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

async function initWebappProject(dir: string): Promise<void> {
  const scriptPath = join(dir, "init-runner.sh");
  await writeRunnerScript(
    scriptPath,
    `for name in schema api roles jobs flows wireframes; do
  echo "# $name" > ".lenses/$name.md"
done`
  );

  const result = await runLens(["init", "a task tracker"], {
    cwd: dir,
    env: { LENS_RUNNER_OVERRIDE: `${scriptPath} {prompt}` },
  });

  if (result.exitCode !== 0) {
    throw new Error(`lens init failed: ${result.stderr || result.stdout}`);
  }
}

describe("lens diff", () => {
  it("returns Exit.CONFIG when no config file is found", async () => {
    const { exitCode, stdout, stderr } = await runLens(["diff"]);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("no config file found");
  });

  it("prints a preview header and the apply bundle markers", async () => {
    gitInit(tempDir);
    await initWebappProject(tempDir);

    const { exitCode, stdout, stderr } = await runLens(["diff"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Lens diff");
    expect(stdout).toContain("Drift summary");
    expect(stdout).toContain("## Intent");
    expect(stdout).toContain("## Lenses");
  });

  it("summarizes lens drift against refs/lens/applied", async () => {
    gitInit(tempDir);
    await initWebappProject(tempDir);
    expectGitOk(["add", "-A"], tempDir);
    expectGitOk(["commit", "-q", "-m", "scaffold"], tempDir);
    const head = expectGitOk(["rev-parse", "HEAD"], tempDir).trim();
    expectGitOk(["update-ref", "refs/lens/applied", head], tempDir);

    const clean = await runLens(["diff"]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stderr).toBe("");
    expect(clean.stdout).toContain("  Lenses:   0 files");

    await writeFile(join(tempDir, ".lenses/api.md"), "# api\nmodified\n");

    const dirty = await runLens(["diff"]);
    expect(dirty.exitCode).toBe(0);
    expect(dirty.stderr).toBe("");
    expect(dirty.stdout).toContain("  Lenses:   1 files");
  });

  it("reports disabled code drift tracking outside a git repo", async () => {
    await initWebappProject(tempDir);

    const { exitCode, stdout, stderr } = await runLens(["diff"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("(not a git repo — code drift tracking disabled)");
  });
});
