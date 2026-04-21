#!/usr/bin/env node

import { parseArgs } from "node:util";
import { runApply } from "./cli/apply";
import { runInit } from "./cli/init";
import { runMark } from "./cli/mark";
import { runStatus } from "./cli/status";
import { runSync } from "./cli/sync";
import { Exit, type ExitCode } from "./exit";

const VERSION = "0.0.1";

const HELP = `lens ${VERSION}

Usage:
  lens init [description] [--template <name>]
  lens status
  lens sync [--force] [--dry-run]
  lens apply [--dry-run]
  lens mark-synced
  lens mark-applied
  lens --help
  lens --version

Global flags:
  --config <path>    Use a specific config file (default: .lenses/config.yaml)
  --force            Overwrite existing config (init only)
  --dry-run          Print what would happen without executing
  --template <name>  Template for init (default: webapp)
  --help, -h         Print this help
  --version, -v      Print version
`;

interface ParsedArgs {
  verb?: string;
  positionals: string[];
  help: boolean;
  version: boolean;
  force: boolean;
  dryRun: boolean;
  template?: string;
  configPath?: string;
}

function parseCliArgs(): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      force: { type: "boolean", short: "f", default: false },
      "dry-run": { type: "boolean", short: "n", default: false },
      template: { type: "string" },
      config: { type: "string", short: "c" },
    },
    allowPositionals: true,
    strict: true,
  });

  const [verb, ...rest] = positionals;
  return {
    verb,
    positionals: rest,
    help: values.help ?? false,
    version: values.version ?? false,
    force: values.force ?? false,
    dryRun: values["dry-run"] ?? false,
    template: values.template,
    configPath: values.config,
  };
}

function dispatch(args: ParsedArgs): Promise<ExitCode> {
  if (args.help || args.verb === "help") {
    console.log(HELP);
    return Promise.resolve(Exit.SUCCESS);
  }
  if (args.version || args.verb === "version") {
    console.log(VERSION);
    return Promise.resolve(Exit.SUCCESS);
  }
  if (!args.verb) {
    console.log(HELP);
    return Promise.resolve(Exit.SUCCESS);
  }

  if (args.verb === "init") {
    return runInit({
      description: args.positionals[0],
      template: args.template ?? "webapp",
      force: args.force,
      dryRun: args.dryRun,
      configPath: args.configPath,
    });
  }

  if (args.verb === "sync") {
    return runSync({
      force: args.force,
      dryRun: args.dryRun,
      configPath: args.configPath,
    });
  }

  if (args.verb === "apply") {
    return runApply({ dryRun: args.dryRun, configPath: args.configPath });
  }

  if (args.verb === "status") {
    return runStatus({ configPath: args.configPath });
  }

  if (args.verb === "mark-synced") {
    return runMark({ which: "synced" });
  }
  if (args.verb === "mark-applied") {
    return runMark({ which: "applied" });
  }

  console.error(`lens: unknown verb: ${args.verb}`);
  console.error(HELP);
  return Promise.resolve(Exit.FAIL);
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseCliArgs();
  } catch (error) {
    console.error(
      `lens: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(Exit.FAIL);
  }

  const code = await dispatch(args);
  process.exit(code);
}

main().catch((error) => {
  console.error(
    `lens: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(Exit.FAIL);
});
