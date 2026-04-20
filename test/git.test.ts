import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedSince,
  diffSince,
  getHead,
  isGitRepo,
  isWorkingTreeClean,
  readRef,
  refExists,
  updateRef,
} from "../src/git";

const SHA_PATTERN = /^[0-9a-f]{40}$/;

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-git-"));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

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

describe("git helpers", () => {
  it("detects whether the current directory is a git repo", async () => {
    expect(await isGitRepo(tempDir)).toBe(false);
    gitInit(tempDir);
    expect(await isGitRepo(tempDir)).toBe(true);
  });

  it("tracks whether the working tree is clean", async () => {
    gitInit(tempDir);
    expect(await isWorkingTreeClean(tempDir)).toBe(true);

    await writeFile(join(tempDir, "draft.txt"), "hello\n");
    expect(await isWorkingTreeClean(tempDir)).toBe(false);

    expectGitOk(["add", "draft.txt"], tempDir);
    expectGitOk(["commit", "-q", "-m", "add draft"], tempDir);
    expect(await isWorkingTreeClean(tempDir)).toBe(true);
  });

  it("reads HEAD as a full commit sha", async () => {
    gitInit(tempDir);
    const head = await getHead(tempDir);
    expect(head).toMatch(SHA_PATTERN);
  });

  it("checks whether a ref exists", async () => {
    gitInit(tempDir);
    const head = expectGitOk(["rev-parse", "HEAD"], tempDir).trim();

    expect(await refExists("refs/lens/fake", tempDir)).toBe(false);
    expectGitOk(["update-ref", "refs/lens/fake", head], tempDir);
    expect(await refExists("refs/lens/fake", tempDir)).toBe(true);
  });

  it("round-trips refs through updateRef and readRef", async () => {
    gitInit(tempDir);
    const head = expectGitOk(["rev-parse", "HEAD"], tempDir).trim();

    await updateRef("refs/lens/synced", head, tempDir);

    expect(await readRef("refs/lens/synced", tempDir)).toBe(head);
  });

  it("shows diffs and changed paths since a ref", async () => {
    gitInit(tempDir);
    const base = expectGitOk(["rev-parse", "HEAD"], tempDir).trim();

    await writeFile(join(tempDir, "lens.md"), "first\n");
    expectGitOk(["add", "lens.md"], tempDir);
    expectGitOk(["commit", "-q", "-m", "add lens file"], tempDir);

    const diff = await diffSince(base, ["lens.md"], tempDir);
    const changed = await changedSince(base, ["lens.md"], tempDir);

    expect(diff).not.toBeNull();
    expect(diff).toContain("first");
    expect(changed).toEqual(["lens.md"]);
  });
});
