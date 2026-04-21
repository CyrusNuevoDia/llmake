import { describe, expect, it } from "bun:test";
import { parse } from "yaml";
import { validateConfig } from "../src/config";

describe("validateConfig", () => {
  it("accepts lens definitions without pullSources", () => {
    const config = validateConfig(
      parse(`
intent: Minimal app
runner: claude --print {prompt}
lenses:
  - name: api
    path: .lenses/api.md
    description: API docs
`)
    );

    expect(config.lenses).toHaveLength(1);
    expect(config.lenses[0]?.pullSources).toBeUndefined();
  });
});
