import { spawn } from "node:child_process";

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runGit(
  args: string[],
  options: {
    cwd?: string;
    captureStdout?: boolean;
  } = {}
): Promise<GitResult> {
  const cwd = options.cwd ?? process.cwd();
  const captureStdout = options.captureStdout ?? false;

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const proc = spawn("git", args, {
      cwd,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    proc.on("error", (error) => {
      reject(error);
    });
    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

export async function isGitRepo(cwd = process.cwd()): Promise<boolean> {
  const result = await runGit(["rev-parse", "--git-dir"], { cwd });
  return result.exitCode === 0;
}

export async function isWorkingTreeClean(
  cwd = process.cwd()
): Promise<boolean> {
  const result = await runGit(["status", "--porcelain"], {
    cwd,
    captureStdout: true,
  });
  if (result.exitCode !== 0) {
    return false;
  }
  return result.stdout.trim().length === 0;
}

export async function getHead(cwd = process.cwd()): Promise<string | null> {
  const result = await runGit(["rev-parse", "HEAD"], {
    cwd,
    captureStdout: true,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

export async function repoRoot(cwd = process.cwd()): Promise<string | null> {
  const result = await runGit(["rev-parse", "--show-toplevel"], {
    cwd,
    captureStdout: true,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

export async function refExists(
  ref: string,
  cwd = process.cwd()
): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", ref], { cwd });
  return result.exitCode === 0;
}

export async function readRef(
  ref: string,
  cwd = process.cwd()
): Promise<string | null> {
  const result = await runGit(["rev-parse", ref], {
    cwd,
    captureStdout: true,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

export async function commitRelativeTime(
  rev: string,
  cwd = process.cwd()
): Promise<string | null> {
  const result = await runGit(["log", "-1", "--format=%cr", rev], {
    cwd,
    captureStdout: true,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

export async function updateRef(
  ref: string,
  sha: string,
  cwd = process.cwd()
): Promise<void> {
  const result = await runGit(["update-ref", ref, sha], { cwd });
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || `git update-ref failed for ${ref}`;
    throw new Error(message);
  }
}

export async function diffSince(
  ref: string,
  paths: string[],
  cwd = process.cwd()
): Promise<string | null> {
  const result = await runGit(["diff", ref, "--", ...paths], {
    cwd,
    captureStdout: true,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout;
}

export async function changedSince(
  ref: string,
  paths: string[],
  cwd = process.cwd()
): Promise<string[]> {
  const result = await runGit(["diff", "--name-only", ref, "--", ...paths], {
    cwd,
    captureStdout: true,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
