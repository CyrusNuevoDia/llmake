import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-validate-"));
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

async function writeProjectConfig(dir: string, body: string): Promise<void> {
  await mkdir(join(dir, ".lenses"), { recursive: true });
  await writeFile(join(dir, "lens.yml"), body);
}

async function writeLensFile(
  dir: string,
  relPath: string,
  body = "# lens\n"
): Promise<void> {
  await mkdir(dirname(join(dir, relPath)), { recursive: true });
  await writeFile(join(dir, relPath), body);
}

describe("lens validate", () => {
  it("returns Exit.CONFIG when no config file is found", async () => {
    const { exitCode, stdout, stderr } = await runLens(["validate"]);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("no config file found");
  });

  it("passes on a valid freshly initialized config", async () => {
    const init = await runLens(["init", "--template", "blank", "my system"]);
    expect(init.exitCode).toBe(0);

    const { exitCode, stdout, stderr } = await runLens(["validate"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("checks passed");
  });

  it("fails when a lens file is missing", async () => {
    await writeProjectConfig(
      tempDir,
      `intent: missing lens
runner: echo {prompt}
lenses:
  - name: api
    path: .lenses/api.md
    description: API lens
`
    );

    const { exitCode, stdout, stderr } = await runLens(["validate"]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(stdout.toLowerCase()).toContain("missing");
  });

  it("fails when duplicate lens names are declared", async () => {
    await writeProjectConfig(
      tempDir,
      `intent: duplicate names
runner: echo {prompt}
lenses:
  - name: api
    path: .lenses/api.md
    description: First
  - name: api
    path: .lenses/roles.md
    description: Second
`
    );
    await writeLensFile(tempDir, ".lenses/api.md");
    await writeLensFile(tempDir, ".lenses/roles.md");

    const { exitCode, stdout, stderr } = await runLens(["validate"]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(stdout.toLowerCase()).toContain("duplicate");
  });

  it("fails when duplicate lens paths are declared", async () => {
    await writeProjectConfig(
      tempDir,
      `intent: duplicate paths
runner: echo {prompt}
lenses:
  - name: api
    path: .lenses/shared.md
    description: First
  - name: roles
    path: .lenses/shared.md
    description: Second
`
    );
    await writeLensFile(tempDir, ".lenses/shared.md");

    const { exitCode, stdout, stderr } = await runLens(["validate"]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(stdout.toLowerCase()).toContain("duplicate");
  });

  it("warns when pullSources globs match zero files", async () => {
    await writeProjectConfig(
      tempDir,
      `intent: pull sources warning
runner: echo {prompt}
lenses:
  - name: api
    path: .lenses/api.md
    description: API lens
    pullSources:
      - src/**/*.ts
`
    );
    await writeLensFile(tempDir, ".lenses/api.md");

    const { exitCode, stdout, stderr } = await runLens(["validate"]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("⚠");
    expect(stdout).toContain("no matches");
  });
});
