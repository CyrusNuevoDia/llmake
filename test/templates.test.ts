import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/index.ts");

const expectedLenses = {
  webapp: ["api", "flows", "jobs", "roles", "schema", "wireframes"],
  cli: ["commands", "exit-codes", "flags", "manpage", "scenarios"],
  library: ["errors", "examples", "public-api", "types"],
  pipeline: ["failure-modes", "inputs", "observability", "outputs", "stages"],
  protocol: ["conformance", "messages", "state-machine", "wire-format"],
  blank: [],
} satisfies Record<string, string[]>;

let tempDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lens-templates-"));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

async function runLens(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd: tempDir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: process.env as Record<string, string>,
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe("shipped templates", () => {
  it("declare the expected lens sets", async () => {
    const { loadTemplate } = await import("../src/templates");

    for (const [name, expected] of Object.entries(expectedLenses)) {
      const { config, raw } = await loadTemplate(name);
      expect(raw).toContain("__LENS_INTENT_PLACEHOLDER__");
      const actual = config.lenses.map((lens) => lens.name).sort();
      expect(actual).toEqual([...expected].sort());
    }
  });

  it("initializes successfully with the blank template", async () => {
    const { exitCode, stderr } = await runLens([
      "init",
      "--template",
      "blank",
      "template smoke test",
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const yaml = await readFile(join(tempDir, ".lenses/config.yaml"), "utf-8");
    expect(yaml).toContain("template smoke test");
    expect(yaml).not.toContain("__LENS_INTENT_PLACEHOLDER__");
  });
});
