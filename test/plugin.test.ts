import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PLUGIN_JSON_PATH = join(ROOT, "plugin/.claude-plugin/plugin.json");
const SKILLS_DIR = join(ROOT, "plugin/skills");

describe("Claude plugin scaffold", () => {
  it('declares the "lens" plugin name', async () => {
    const raw = await readFile(PLUGIN_JSON_PATH, "utf-8");
    const manifest = JSON.parse(raw) as { name: string };
    expect(manifest.name).toBe("lens");
  });

  it("ships YAML frontmatter with a description for every skill", async () => {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    const skillDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillDirs.length).toBeGreaterThan(0);

    for (const skillDir of skillDirs) {
      const skillPath = join(SKILLS_DIR, skillDir, "SKILL.md");
      const raw = await readFile(skillPath, "utf-8");
      expect(raw.startsWith("---\n")).toBe(true);
      expect(raw).toContain("description:");
    }
  });
});
