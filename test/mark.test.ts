import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-mark-"));
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

function currentHead(dir: string): string {
  return expectGitOk(["rev-parse", "HEAD"], dir).trim();
}

function readRef(ref: string, dir: string): string {
  return expectGitOk(["rev-parse", ref], dir).trim();
}

describe("lens mark (usage errors)", () => {
  it("fails with a usage message when no subcommand is given", async () => {
    const { exitCode, stderr } = await runLens(["mark"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage: lens mark <synced|applied>");
  });

  it("fails with a usage message for an unknown subcommand", async () => {
    const { exitCode, stderr } = await runLens(["mark", "bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage: lens mark <synced|applied>");
  });
});

for (const which of ["synced", "applied"] as const) {
  describe(`lens mark ${which}`, () => {
    const ref = `refs/lens/${which}`;

    it("fails outside a git repo", async () => {
      const { exitCode, stderr } = await runLens(["mark", which]);

      expect(exitCode).toBe(3);
      expect(stderr).toContain("requires a git repository");
    });

    it("creates the ref at HEAD when it does not exist yet", async () => {
      gitInit(tempDir);

      const { exitCode, stdout, stderr } = await runLens(["mark", which]);
      const head = currentHead(tempDir);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`advanced ${ref} to ${head.slice(0, 7)}`);
      expect(readRef(ref, tempDir)).toBe(head);
    });

    it("fails when the ref is already at HEAD", async () => {
      gitInit(tempDir);
      const head = currentHead(tempDir);
      expectGitOk(["update-ref", ref, head], tempDir);

      const { exitCode, stderr, stdout } = await runLens(["mark", which]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(`${ref} already at HEAD`);
    });

    it("advances the ref after HEAD moves forward", async () => {
      gitInit(tempDir);
      const firstHead = currentHead(tempDir);
      expectGitOk(["update-ref", ref, firstHead], tempDir);
      expectGitOk(["commit", "--allow-empty", "-q", "-m", "next"], tempDir);

      const { exitCode, stdout, stderr } = await runLens(["mark", which]);
      const nextHead = currentHead(tempDir);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`advanced ${ref} to ${nextHead.slice(0, 7)}`);
      expect(readRef(ref, tempDir)).toBe(nextHead);
    });
  });
}
