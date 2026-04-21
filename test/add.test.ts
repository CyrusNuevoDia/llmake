import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashFile } from "../src/hash";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-add-"));
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8"));
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

async function initBlankProject(dir: string): Promise<void> {
  const result = await runLens(["init", "--template", "blank", "my system"], {
    cwd: dir,
  });

  if (result.exitCode !== 0) {
    throw new Error(`lens init failed: ${result.stderr || result.stdout}`);
  }
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

async function makeEmptyFileRunner(dir: string): Promise<string> {
  const scriptPath = join(dir, "mock-runner.sh");
  await writeRunnerScript(
    scriptPath,
    `for f in .lenses/*.md docs/*.md; do
  [ -e "$f" ] || continue
  [ -s "$f" ] || printf 'generated\\n' > "$f"
done`
  );
  return scriptPath;
}

describe("lens add", () => {
  it("returns Exit.CONFIG when no config file is found", async () => {
    const { exitCode, stdout, stderr } = await runLens([
      "add",
      "schema",
      "--description",
      "schema lens",
    ]);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("no config file found");
  });

  it("fails when the lens name is missing", async () => {
    await initBlankProject(tempDir);

    const { exitCode, stdout, stderr } = await runLens([
      "add",
      "--description",
      "schema lens",
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("lens add: <name> is required");
  });

  it("fails when the description flag is missing", async () => {
    await initBlankProject(tempDir);

    const { exitCode, stdout, stderr } = await runLens(["add", "schema"]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("--description is required");
  });

  it("rejects duplicate lens names", async () => {
    await initWebappProject(tempDir);

    const { exitCode, stderr } = await runLens([
      "add",
      "schema",
      "--description",
      "duplicate schema lens",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists");
  });

  it("appends the lens, runs generate, and refreshes the generate lock entry", async () => {
    await initBlankProject(tempDir);
    const runner = await makeEmptyFileRunner(tempDir);

    const { exitCode } = await runLens(
      ["add", "wireframes", "--description", "low-fi sketches"],
      {
        cwd: tempDir,
        env: { LENS_RUNNER_OVERRIDE: `${runner} {prompt}` },
      }
    );

    expect(exitCode).toBe(0);

    const configYaml = await readFile(
      join(tempDir, ".lenses/config.yaml"),
      "utf-8"
    );
    expect(configYaml).toContain("name: wireframes");
    expect(configYaml).toContain("low-fi sketches");

    const lensPath = join(tempDir, ".lenses/wireframes.md");
    expect(await fileExists(lensPath)).toBe(true);
    expect(await readFile(lensPath, "utf-8")).toBe("generated\n");

    const lock = await readJson(join(tempDir, ".lens/lock.json"));
    const generateEntry = (lock.tasks as Record<string, unknown>).generate as
      | Record<string, unknown>
      | undefined;
    const generateFiles =
      generateEntry && "files" in generateEntry
        ? (generateEntry.files as Record<string, string>)
        : {};

    expect(generateEntry).toBeDefined();
    expect(generateFiles[".lenses/wireframes.md"]).toBe(
      await hashFile(lensPath)
    );
  });

  it("prints the updated YAML and makes no disk changes on --dry-run", async () => {
    await initBlankProject(tempDir);
    const configPath = join(tempDir, ".lenses/config.yaml");
    const before = await readFile(configPath, "utf-8");

    const { exitCode, stdout } = await runLens([
      "add",
      "preview",
      "--description",
      "preview lens",
      "--dry-run",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("name: preview");
    expect(stdout).toContain("preview lens");
    expect(await readFile(configPath, "utf-8")).toBe(before);
    expect(await fileExists(join(tempDir, ".lenses/preview.md"))).toBe(false);
  });

  it("supports a custom --path", async () => {
    await initBlankProject(tempDir);
    const runner = await makeEmptyFileRunner(tempDir);

    const { exitCode } = await runLens(
      ["add", "special", "--description", "x", "--path", "docs/special.md"],
      {
        cwd: tempDir,
        env: { LENS_RUNNER_OVERRIDE: `${runner} {prompt}` },
      }
    );

    expect(exitCode).toBe(0);
    expect(await fileExists(join(tempDir, "docs/special.md"))).toBe(true);

    const configYaml = await readFile(
      join(tempDir, ".lenses/config.yaml"),
      "utf-8"
    );
    expect(configYaml).toContain("path: docs/special.md");
  });

  it("preserves an existing file with content", async () => {
    await initBlankProject(tempDir);
    const runner = await makeEmptyFileRunner(tempDir);
    const lensPath = join(tempDir, ".lenses/foo.md");
    await writeFile(lensPath, "seeded content\n");

    const { exitCode, stdout } = await runLens(
      ["add", "foo", "--description", "existing file lens"],
      {
        cwd: tempDir,
        env: { LENS_RUNNER_OVERRIDE: `${runner} {prompt}` },
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("already has content; keeping it");
    expect(await readFile(lensPath, "utf-8")).toBe("seeded content\n");
  });
});
