import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "./config";
import { EMBEDDED_TEMPLATES } from "./embedded-templates";
import type { LensConfig } from "./types";

/**
 * Read a template either from disk (when the source tree or installed
 * package's `templates/` directory is reachable) or from the embedded map
 * (bun-compiled standalone binary, where nothing sits next to the binary).
 */
async function readTemplateRaw(name: string): Promise<string> {
  const path = templatePath(name);
  try {
    return await readFile(path, "utf-8");
  } catch {
    const embedded = EMBEDDED_TEMPLATES[name];
    if (embedded !== undefined) {
      return embedded;
    }
    throw new Error(
      `lens: template "${name}" not found at ${path} and no embedded fallback. Known templates ship under <pkg>/templates/*.yaml.`
    );
  }
}

/**
 * Marker in shipped template YAMLs that is replaced with the user's actual
 * `intent` string at `lens init` time. See SPEC §9 and notes N1/N6.
 */
export const INTENT_PLACEHOLDER = "__LENS_INTENT_PLACEHOLDER__";

/**
 * Resolve the absolute path to a shipped template YAML.
 * Uses `import.meta.url` so it works both from source (`src/` → `../templates`)
 * and from the bundled `dist/lens.js` (which also sits one directory below the
 * published `templates/`).
 */
function templatePath(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "templates", `${name}.yaml`);
}

/**
 * Read a shipped template and parse/validate it. The returned config still
 * carries the intent placeholder — callers substitute the user's description
 * before writing `lens.yml`.
 */
export async function loadTemplate(name: string): Promise<{
  raw: string;
  config: LensConfig;
}> {
  const raw = await readTemplateRaw(name);
  const { parse } = await import("yaml");
  const parsed = parse(raw);
  const config = validateConfig(parsed);
  return { raw, config };
}

/**
 * Replace the intent placeholder in raw template YAML text with the user's
 * description. We operate on the raw string so the template's comments and
 * block structure survive — a parse/stringify round-trip would lose them.
 *
 * The user's intent is re-emitted as a YAML block scalar (`|`) so newlines
 * are preserved without risk of re-quoting issues.
 */
export function substituteIntent(raw: string, intent: string): string {
  const lines = intent.split("\n");
  const blockScalar = `|\n${lines.map((l) => `  ${l}`).join("\n")}`;
  // Replace the entire `intent:` line that carries the placeholder.
  const placeholderLinePattern = new RegExp(
    `^([ \\t]*)intent:.*${INTENT_PLACEHOLDER}.*$`,
    "m"
  );
  return raw.replace(placeholderLinePattern, (_, indent: string) => {
    return `${indent}intent: ${blockScalar}`;
  });
}
