import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import stripJsonComments from "strip-json-comments";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { LensConfig } from "./types";

export const CONFIG_FILES = [
  "lens.yml",
  "lens.yaml",
  "lens.jsonc",
  "lens.json",
] as const;

export const CONFIG_FILENAMES: ReadonlySet<string> = new Set(CONFIG_FILES);

const LensSettingsSchema = z
  .object({
    autoApprove: z.boolean().optional(),
  })
  .passthrough();

const LensDefSchema = z
  .object({
    name: z.string().min(1, "lens name must not be empty"),
    path: z.string().min(1, "lens path must not be empty"),
    description: z.string().min(1, "lens description must not be empty"),
    pullSources: z.array(z.string().min(1)).optional(),
    affects: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

const LensConfigSchema = z
  .object({
    intent: z.string().min(1, "intent must not be empty"),
    runner: z
      .string()
      .min(1, "runner must not be empty")
      .refine(
        (s) => s.includes("{prompt}"),
        "runner must contain {prompt} placeholder"
      ),
    settings: LensSettingsSchema.optional(),
    lenses: z.array(LensDefSchema),
  })
  .passthrough();

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk the filesystem looking for a Lens config file.
 * Discovery order: `lens.yml` → `lens.yaml` → `lens.jsonc` → `lens.json`.
 * Returns absolute path or null if none found.
 */
export async function discoverConfig(cwd?: string): Promise<string | null> {
  const dir = cwd ?? process.cwd();

  for (const filename of CONFIG_FILES) {
    const filepath = resolve(dir, filename);
    if (await fileExists(filepath)) {
      return filepath;
    }
  }

  return null;
}

/**
 * Load and parse a config file. Supports .yaml, .jsonc, .json extensions.
 */
export async function loadConfig(path: string): Promise<LensConfig> {
  const ext = path.split(".").pop()?.toLowerCase();
  const text = await readFile(path, "utf-8");

  if (ext === "yaml" || ext === "yml") {
    return validateConfig(parseYaml(text));
  }

  if (ext === "jsonc") {
    return validateConfig(JSON.parse(stripJsonComments(text)));
  }

  if (ext === "json") {
    return validateConfig(JSON.parse(text));
  }

  throw new Error(`lens: unsupported config format: ${ext}`);
}

/**
 * Validate an arbitrary value against the Lens config schema.
 */
export function validateConfig(raw: unknown): LensConfig {
  const result = LensConfigSchema.safeParse(raw);

  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? ` in "${issue.path.join(".")}"` : "";
    throw new Error(`lens: config error${path}: ${issue.message}`);
  }

  return result.data;
}
