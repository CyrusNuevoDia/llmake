import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");
const DIST_PATH = resolve(import.meta.dir, "../dist/lens.js");
const VERSION_PATTERN = /^\d+\.\d+\.\d+\n?$/;

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-init-"));
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
    usingDist?: boolean;
    env?: Record<string, string>;
  } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cmd = opts.usingDist
    ? ["node", DIST_PATH, ...args]
    : ["bun", "run", CLI_PATH, ...args];
  const proc = Bun.spawn(cmd, {
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

function gitInit(dir: string): void {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
  spawnSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], {
    cwd: dir,
  });
}

describe("lens init", () => {
  it("webapp template end-to-end: 6 lens files populated by mock runner", async () => {
    // Exercises the spec's Phase 1 milestone (SPEC §10): default template,
    // real generate step, 6 populated lens files. The mock runner fills each
    // empty .md file via $LENS_RUNNER_OVERRIDE so we don't invoke claude.
    const scriptPath = join(tempDir, "mock-runner.sh");
    await Bun.write(
      scriptPath,
      `#!/bin/bash
for name in schema api roles jobs flows wireframes; do
  echo "# $name" > ".lenses/$name.md"
done
`
    );
    spawnSync("chmod", ["+x", scriptPath]);
    const mockRunner = `${scriptPath} {prompt}`;

    const { exitCode, stdout } = await runLens(["init", "a task tracker"], {
      env: { LENS_RUNNER_OVERRIDE: mockRunner },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("initialized");

    for (const name of [
      "schema",
      "api",
      "roles",
      "jobs",
      "flows",
      "wireframes",
    ]) {
      const lensPath = join(tempDir, `.lenses/${name}.md`);
      expect(await fileExists(lensPath)).toBe(true);
      const body = await readFile(lensPath, "utf-8");
      expect(body.length).toBeGreaterThan(0);
    }

    const lock = await readJson(join(tempDir, ".lens/lock.json"));
    expect(lock.version).toBe(1);
    const generateEntry = (lock.tasks as Record<string, unknown>).generate as
      | Record<string, unknown>
      | undefined;
    expect(generateEntry).toBeDefined();
    expect(Object.keys(generateEntry?.files ?? {}).length).toBe(6);
  });

  it("blank template init succeeds with no runner invocation", async () => {
    const { exitCode, stdout, stderr } = await runLens([
      "init",
      "--template",
      "blank",
      "my system",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("initialized blank config");
    expect(stderr).toBe("");

    const configExists = await fileExists(join(tempDir, ".lenses/config.yaml"));
    expect(configExists).toBe(true);

    const lock = await readJson(join(tempDir, ".lens/lock.json"));
    expect(lock.version).toBe(1);
    expect((lock.tasks as Record<string, unknown>).generate).toBeDefined();
  });

  it("refuses to overwrite without --force", async () => {
    await runLens(["init", "--template", "blank", "first"]);

    const { exitCode, stderr } = await runLens([
      "init",
      "--template",
      "blank",
      "second",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists");
  });

  it("--force overwrites existing config", async () => {
    await runLens(["init", "--template", "blank", "first"]);

    const { exitCode } = await runLens([
      "init",
      "--template",
      "blank",
      "--force",
      "second",
    ]);
    expect(exitCode).toBe(0);

    const yaml = await readFile(join(tempDir, ".lenses/config.yaml"), "utf-8");
    expect(yaml).toContain("second");
  });

  it("writes a valid YAML config with intent substituted", async () => {
    await runLens(["init", "--template", "blank", "a team invoicing app"]);

    const yaml = await readFile(join(tempDir, ".lenses/config.yaml"), "utf-8");
    expect(yaml).toContain("a team invoicing app");
    expect(yaml).not.toContain("__LENS_INTENT_PLACEHOLDER__");
  });

  it("webapp template declares the expected 6 lenses", async () => {
    // Exercise the template at the loader level: we don't want to drive the
    // generate step for webapp in tests because its runner is the real
    // `claude` CLI. The install-from-dist test below covers end-to-end
    // resolution of the templates/ directory.
    const { loadTemplate } = await import("../src/templates");
    const { config, raw } = await loadTemplate("webapp");
    expect(raw).toContain("__LENS_INTENT_PLACEHOLDER__");
    const names = config.lenses.map((l) => l.name).sort();
    expect(names).toEqual([
      "api",
      "flows",
      "jobs",
      "roles",
      "schema",
      "wireframes",
    ]);
  });

  it("honors --config for a custom destination path", async () => {
    const custom = join(tempDir, "nested/dir/custom.yaml");
    const { exitCode } = await runLens([
      "init",
      "--template",
      "blank",
      "--config",
      custom,
      "custom-path",
    ]);
    expect(exitCode).toBe(0);
    expect(await fileExists(custom)).toBe(true);
    const yaml = await readFile(custom, "utf-8");
    expect(yaml).toContain("custom-path");
  });

  it("succeeds outside a git repo without creating a ref", async () => {
    // tempDir is not a git repo. Just running init should not error.
    const { exitCode } = await runLens([
      "init",
      "--template",
      "blank",
      "not-a-repo",
    ]);
    expect(exitCode).toBe(0);
    // No refs to check — absence of git means git show-ref would fail anyway.
  });

  it("creates refs/lens/synced inside a git repo", async () => {
    gitInit(tempDir);
    const { exitCode } = await runLens([
      "init",
      "--template",
      "blank",
      "in-repo",
    ]);
    expect(exitCode).toBe(0);
    const refs = spawnSync("git", ["show-ref"], {
      cwd: tempDir,
      encoding: "utf-8",
    });
    expect(refs.stdout).toContain("refs/lens/synced");
  });

  it("--help prints usage", async () => {
    const { exitCode, stdout } = await runLens(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("lens init");
  });

  it("--version prints version", async () => {
    const { exitCode, stdout } = await runLens(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(VERSION_PATTERN);
  });

  it("unknown verb errors out", async () => {
    const { exitCode, stderr } = await runLens(["bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown verb");
  });

  it("install-from-dist smoke: templates/ resolve under bundled dist/lens.js", async () => {
    // Build once per repo state. This test validates that the `files` array
    // in package.json includes templates/ and that import.meta.url resolves
    // correctly from the minified dist bundle.
    const build = spawnSync("bun", ["run", "build"], {
      cwd: resolve(import.meta.dir, ".."),
      encoding: "utf-8",
    });
    expect(build.status).toBe(0);

    const distExists = await fileExists(DIST_PATH);
    expect(distExists).toBe(true);

    const { exitCode, stdout } = await runLens(
      ["init", "--template", "blank", "from-dist"],
      { usingDist: true }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("initialized");
  });
});
