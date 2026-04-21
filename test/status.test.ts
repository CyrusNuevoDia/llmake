import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-status-"));
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

async function writeRunnerScript(path: string): Promise<void> {
  await Bun.write(
    path,
    `#!/bin/bash
for name in schema api roles jobs flows wireframes; do
  echo "# $name" > ".lenses/$name.md"
done
`
  );
  spawnSync("chmod", ["+x", path]);
}

async function initWebappProject(dir: string): Promise<void> {
  const scriptPath = join(dir, "mock-runner.sh");
  await writeRunnerScript(scriptPath);

  const result = await runLens(["init", "a task tracker"], {
    cwd: dir,
    env: { LENS_RUNNER_OVERRIDE: `${scriptPath} {prompt}` },
  });

  if (result.exitCode !== 0) {
    throw new Error(`lens init failed: ${result.stderr || result.stdout}`);
  }
}

describe("lens status", () => {
  it("returns Exit.CONFIG when no config file is found", async () => {
    const { exitCode, stdout, stderr } = await runLens(["status"]);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("no config file found");
  });

  it("shows a clean lens set immediately after init", async () => {
    gitInit(tempDir);
    await initWebappProject(tempDir);

    const { exitCode, stdout, stderr } = await runLens(["status"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Lens status");
    expect(stdout).toContain("Repository: ");
    expect(stdout).toContain(basename(tempDir));
    expect(stdout).toContain("Config:     lens.yml (6 lenses)");
    expect(stdout).toContain("✓ schema");
    expect(stdout).toContain("✓ api");
    expect(stdout).toContain("✓ roles");
    expect(stdout).toContain("✓ jobs");
    expect(stdout).toContain("✓ flows");
    expect(stdout).toContain("✓ wireframes");
    expect(stdout).toContain("Everything is up to date.");
    expect(stdout).toContain("no lens/applied ref yet");
    expect(stdout.includes("⚠")).toBe(false);
  });

  it("flags a modified lens and suggests lens sync", async () => {
    gitInit(tempDir);
    await initWebappProject(tempDir);
    await writeFile(join(tempDir, ".lenses/api.md"), "# api\nmodified\n");

    const { exitCode, stdout, stderr } = await runLens(["status"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("⚠ api");
    expect(stdout).toContain("edited since last sync");
    expect(stdout).toContain(
      "Run `lens sync` to propagate api.md edits to other lenses"
    );
  });

  it("reports disabled git tracking outside a git repo", async () => {
    await initWebappProject(tempDir);

    const { exitCode, stdout, stderr } = await runLens(["status"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("(not a git repo — ref tracking disabled)");
    expect(stdout).toContain("(not a git repo — code drift tracking disabled)");
  });

  it("flags missing lens files on disk", async () => {
    gitInit(tempDir);
    await initWebappProject(tempDir);
    await unlink(join(tempDir, ".lenses/api.md"));

    const { exitCode, stdout, stderr } = await runLens(["status"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("⚠ api");
    expect(stdout).toContain("missing on disk");
  });
});
