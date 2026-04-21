import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-apply-"));
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

describe("lens apply", () => {
  it("returns Exit.CONFIG when no config file is found", async () => {
    const { exitCode, stdout, stderr } = await runLens(["apply"]);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("no config file found");
  });

  it("prints a context bundle for a freshly initialized project", async () => {
    gitInit(tempDir);
    await initWebappProject(tempDir);
    expectGitOk(["add", "-A"], tempDir);
    expectGitOk(["commit", "-q", "-m", "scaffold"], tempDir);

    const { exitCode, stdout, stderr } = await runLens(["apply"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("# Lens apply — context bundle");
    expect(stdout).toContain("## Intent");
    expect(stdout).toContain("a task tracker");
    expect(stdout).toContain("## Lenses");
    expect(stdout).toContain("### schema — .lenses/schema.md");
    expect(stdout).toContain("Normalized relational schema as markdown.");
    expect(stdout).toContain("```");
    expect(stdout).toContain("# schema");
    expect(
      stdout.includes(
        "(no refs/lens/applied yet — treat current state as baseline)"
      ) || stdout.includes("(no code drift since refs/lens/applied)")
    ).toBe(true);
    expect(stdout).toContain(
      "Pipe this to your coding agent, or run `/lens:apply` in Claude Code for integrated plan-mode handoff."
    );
  });

  it("omits the instructions footer on --dry-run", async () => {
    gitInit(tempDir);
    await initWebappProject(tempDir);

    const { exitCode, stdout, stderr } = await runLens(["apply", "--dry-run"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("# Lens apply — context bundle");
    expect(stdout).not.toContain("Pipe this to your coding agent");
  });

  it("still prints a bundle outside a git repo", async () => {
    await initWebappProject(tempDir);

    const { exitCode, stdout, stderr } = await runLens(["apply"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("# Lens apply — context bundle");
    expect(stdout).toContain("(not a git repo — drift tracking disabled)");
    expect(stdout).toContain("(not a git repo — file tree unavailable)");
  });
});
