import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-pull-"));
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

async function seedPullSourcesRepo(dir: string): Promise<string> {
  gitInit(dir);
  await initWebappProject(dir);
  await mkdir(join(dir, "src/routes"), { recursive: true });
  await mkdir(join(dir, "src/components"), { recursive: true });
  await writeFile(
    join(dir, "src/routes/todos.ts"),
    "export const listTodos = () => ['a'];\n"
  );
  await writeFile(
    join(dir, "src/components/App.tsx"),
    "export function App() { return null; }\n"
  );
  await writeFile(join(dir, ".lenses/api.md"), "pulled\n");
  await writeFile(join(dir, ".lenses/wireframes.md"), "pulled\n");

  const pullScript = join(dir, "pull-runner.sh");
  await writeRunnerScript(
    pullScript,
    `printf 'pulled\n' > ".lenses/api.md"
printf 'pulled\n' > ".lenses/wireframes.md"`
  );

  expectGitOk(["add", "-A"], dir);
  expectGitOk(["commit", "-q", "-m", "scaffold"], dir);
  return pullScript;
}

async function writeNoPullSourcesProject(dir: string): Promise<void> {
  await mkdir(join(dir, ".lenses"), { recursive: true });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, ".lenses/config.yaml"),
    `intent: test
runner: echo {prompt}
lenses:
  - name: schema
    path: .lenses/schema.md
    description: Schema lens
`
  );
  await writeFile(join(dir, ".lenses/schema.md"), "schema\n");
  await writeFile(join(dir, "src/index.ts"), "export const value = 1;\n");
}

describe("lens pull", () => {
  it("returns Exit.CONFIG when no config file is found", async () => {
    const { exitCode, stdout, stderr } = await runLens(["pull"]);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("no config file found");
  });

  it("fails with guidance when no pullSources are configured outside a git repo", async () => {
    await writeNoPullSourcesProject(tempDir);

    const { exitCode, stdout, stderr } = await runLens(["pull"]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      "lens: pull — no code sources (define pullSources in .lenses/config.yaml lenses)"
    );
  });

  it("runs with pullSources globs, writes the pull lock entry, and advances refs/lens/applied on a clean tree", async () => {
    const pullScript = await seedPullSourcesRepo(tempDir);
    const head = expectGitOk(["rev-parse", "HEAD"], tempDir).trim();

    const { exitCode, stdout, stderr } = await runLens(["pull"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${pullScript} {prompt}` },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("running prompt via runner");
    expect(stdout).toContain("runner completed");

    const lock = await readJson(join(tempDir, ".lens/lock.json"));
    const pullEntry = (lock.tasks as Record<string, unknown>).pull as
      | Record<string, unknown>
      | undefined;
    const pullFiles =
      pullEntry && "files" in pullEntry
        ? (pullEntry.files as Record<string, string>)
        : {};

    expect(pullEntry).toBeDefined();
    expect(Object.keys(pullFiles)).toEqual([
      "src/components/App.tsx",
      "src/routes/todos.ts",
    ]);

    const appliedRef = expectGitOk(
      ["rev-parse", "refs/lens/applied"],
      tempDir
    ).trim();
    expect(appliedRef).toBe(head);
  });

  it("falls back to git-tracked files when pullSources are absent in a git repo", async () => {
    gitInit(tempDir);
    await writeNoPullSourcesProject(tempDir);

    const pullScript = join(tempDir, "fallback-runner.sh");
    await writeRunnerScript(
      pullScript,
      `printf 'pulled\n' > ".lenses/schema.md"`
    );

    expectGitOk(["add", "-A"], tempDir);
    expectGitOk(["commit", "-q", "-m", "scaffold"], tempDir);

    const { exitCode, stdout, stderr } = await runLens(["pull"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${pullScript} {prompt}` },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("running prompt via runner");

    const lock = await readJson(join(tempDir, ".lens/lock.json"));
    const pullEntry = (lock.tasks as Record<string, unknown>).pull as
      | Record<string, unknown>
      | undefined;
    const files =
      pullEntry && "files" in pullEntry
        ? Object.keys(pullEntry.files as Record<string, string>)
        : [];

    expect(pullEntry).toBeDefined();
    expect(files).toContain("src/index.ts");
    expect(files).not.toContain(".lenses/config.yaml");
    expect(files).not.toContain(".lenses/schema.md");
  });

  it("does not re-invoke the runner when nothing changed since the last pull", async () => {
    const firstPullScript = await seedPullSourcesRepo(tempDir);

    const first = await runLens(["pull"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${firstPullScript} {prompt}` },
    });
    expect(first.exitCode).toBe(0);

    const markerPath = join(tempDir, "runner-called.txt");
    const secondPullScript = join(tempDir, "second-pull-runner.sh");
    await writeRunnerScript(
      secondPullScript,
      `printf 'called\n' > "${markerPath}"`
    );

    const second = await runLens(["pull"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${secondPullScript} {prompt}` },
    });

    expect(second.exitCode).toBe(0);
    expect(second.stderr).toBe("");
    expect(second.stdout).toContain("nothing to pull");
    expect(await fileExists(markerPath)).toBe(false);
  });

  it("prints the assembled prompt on --dry-run without writing a pull lock entry or advancing refs", async () => {
    const pullScript = await seedPullSourcesRepo(tempDir);

    const { exitCode, stdout, stderr } = await runLens(["pull", "--dry-run"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${pullScript} {prompt}` },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      "You are updating lens files to reflect the current state of the codebase."
    );
    expect(stdout).toContain("CHANGED CODE FILE CONTENT:");
    expect(stdout).toContain("src/routes/todos.ts");
    expect(stdout).toContain("src/components/App.tsx");

    const lock = await readJson(join(tempDir, ".lens/lock.json"));
    expect((lock.tasks as Record<string, unknown>).pull).toBeUndefined();
    expect(
      runGit(["rev-parse", "--verify", "refs/lens/applied"], tempDir).status
    ).not.toBe(0);
  });

  it("leaves refs/lens/applied unchanged when unrelated untracked files keep the tree dirty", async () => {
    const pullScript = await seedPullSourcesRepo(tempDir);
    await writeFile(join(tempDir, "notes.txt"), "untracked\n");

    const { exitCode, stdout, stderr } = await runLens(["pull"], {
      cwd: tempDir,
      env: { LENS_RUNNER_OVERRIDE: `${pullScript} {prompt}` },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      "Commit changes and run 'lens mark-applied' to advance ref."
    );
    expect(
      runGit(["rev-parse", "--verify", "refs/lens/applied"], tempDir).status
    ).not.toBe(0);
  });
});
