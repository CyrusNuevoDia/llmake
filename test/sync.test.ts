import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-sync-"));
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

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8"));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
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

describe("lens sync", () => {
  it("returns Exit.CONFIG when no config file is found", async () => {
    const { exitCode, stderr } = await runLens(["sync"]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("no config file found");
  });

  it("fails when a configured lens file is missing", async () => {
    await mkdir(join(tempDir, ".lenses"), { recursive: true });
    await writeFile(
      join(tempDir, ".lenses/config.yaml"),
      `intent: test
runner: echo {prompt}
lenses:
  - name: schema
    path: .lenses/schema.md
    description: Schema lens
`
    );

    const { exitCode, stderr } = await runLens(["sync"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing lens file");
    expect(stderr).toContain(".lenses/schema.md");
  });

  it("reports nothing to sync immediately after init", async () => {
    await initWebappProject(tempDir);

    const { exitCode, stdout, stderr } = await runLens(["sync"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("nothing to sync");
  });

  it("runs sync successfully, writes the sync lock entry, and leaves refs alone on a dirty tree", async () => {
    gitInit(tempDir);
    await initWebappProject(tempDir);
    expectGitOk(["add", "-A"], tempDir);
    expectGitOk(["commit", "-q", "-m", "scaffold"], tempDir);
    const beforeRef = expectGitOk(
      ["rev-parse", "refs/lens/synced"],
      tempDir
    ).trim();

    await writeFile(join(tempDir, ".lenses/api.md"), "# api\nextra content\n");

    const syncScript = join(tempDir, "sync-runner.sh");
    await writeRunnerScript(
      syncScript,
      `for name in schema api roles jobs flows wireframes; do
  echo "synced" >> ".lenses/$name.md"
done`
    );

    const { exitCode, stdout, stderr } = await runLens(["sync"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${syncScript} {prompt}` },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("running prompt via runner");
    expect(stdout).toContain("runner completed");
    expect(stdout).toContain("Commit changes and run 'lens mark synced'");

    const lock = await readJson(join(tempDir, ".lens/lock.json"));
    const syncEntry = (lock.tasks as Record<string, unknown>).sync as
      | Record<string, unknown>
      | undefined;
    expect(syncEntry).toBeDefined();
    expect(
      Object.keys((syncEntry?.files as Record<string, string>) ?? {}).length
    ).toBe(6);

    const afterRef = expectGitOk(
      ["rev-parse", "refs/lens/synced"],
      tempDir
    ).trim();
    expect(afterRef).toBe(beforeRef);
  });

  it("does not advance refs/lens/synced when unrelated untracked files keep the tree dirty", async () => {
    gitInit(tempDir);
    await initWebappProject(tempDir);
    expectGitOk(["add", "-A"], tempDir);
    expectGitOk(["commit", "-q", "-m", "scaffold"], tempDir);
    const beforeRef = expectGitOk(
      ["rev-parse", "refs/lens/synced"],
      tempDir
    ).trim();

    await writeFile(join(tempDir, "notes.txt"), "untracked\n");
    await writeFile(join(tempDir, ".lenses/schema.md"), "# schema\nchanged\n");

    const syncScript = join(tempDir, "sync-runner.sh");
    await writeRunnerScript(
      syncScript,
      `for name in schema api roles jobs flows wireframes; do
  echo "synced" >> ".lenses/$name.md"
done`
    );

    const { exitCode, stdout } = await runLens(["sync"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${syncScript} {prompt}` },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commit changes and run 'lens mark synced'");
    const afterRef = expectGitOk(
      ["rev-parse", "refs/lens/synced"],
      tempDir
    ).trim();
    expect(afterRef).toBe(beforeRef);
  });

  it("prints the assembled prompt on --dry-run without invoking the runner or writing a sync lock entry", async () => {
    await initWebappProject(tempDir);
    await writeFile(join(tempDir, ".lenses/api.md"), "# api\nchanged\n");

    const markerPath = join(tempDir, "runner-called.txt");
    const syncScript = join(tempDir, "dry-run-runner.sh");
    await writeRunnerScript(syncScript, `echo "called" > "${markerPath}"`);

    const { exitCode, stdout, stderr } = await runLens(["sync", "--dry-run"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${syncScript} {prompt}` },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      "You are maintaining consistency across a set of lens files."
    );
    expect(await fileExists(markerPath)).toBe(false);

    const lock = await readJson(join(tempDir, ".lens/lock.json"));
    expect((lock.tasks as Record<string, unknown>).sync).toBeUndefined();
  });

  it("invokes the runner on --force even when nothing changed", async () => {
    gitInit(tempDir);
    await initWebappProject(tempDir);
    expectGitOk(["add", "-A"], tempDir);
    expectGitOk(["commit", "-q", "-m", "scaffold"], tempDir);

    const scriptPath = join(tempDir, "force-runner.sh");
    const markerPath = join(tempDir, "runner-called.txt");
    await writeRunnerScript(scriptPath, `echo "called" > "${markerPath}"`);

    const { exitCode, stdout, stderr } = await runLens(["sync", "--force"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${scriptPath} {prompt}` },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("running prompt via runner");
    expect(await fileExists(markerPath)).toBe(true);
  });

  it("advances refs/lens/synced after a clean no-op sync run", async () => {
    gitInit(tempDir);
    await initWebappProject(tempDir);
    expectGitOk(["add", "-A"], tempDir);
    expectGitOk(["commit", "-q", "-m", "scaffold"], tempDir);
    const initialRef = expectGitOk(
      ["rev-parse", "refs/lens/synced"],
      tempDir
    ).trim();

    const scriptPath = join(tempDir, "noop-runner.sh");
    await writeRunnerScript(scriptPath, ":");
    await writeFile(
      join(tempDir, ".lenses/api.md"),
      "# api\ncommitted change\n"
    );
    expectGitOk(["add", ".lenses/api.md", "noop-runner.sh"], tempDir);
    expectGitOk(["commit", "-q", "-m", "lens edit"], tempDir);
    const headBeforeSync = expectGitOk(["rev-parse", "HEAD"], tempDir).trim();

    const { exitCode, stderr } = await runLens(["sync"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${scriptPath} {prompt}` },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(initialRef).not.toBe(headBeforeSync);
    const updatedRef = expectGitOk(
      ["rev-parse", "refs/lens/synced"],
      tempDir
    ).trim();
    expect(updatedRef).toBe(headBeforeSync);
  });
});
