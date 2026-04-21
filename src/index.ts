#!/usr/bin/env node

import { parseArgs } from "node:util";
import { runAdd } from "./cli/add";
import { runApply } from "./cli/apply";
import { runDiff } from "./cli/diff";
import { runInit } from "./cli/init";
import { runMark } from "./cli/mark";
import { runPull } from "./cli/pull";
import { runStatus } from "./cli/status";
import { runSync } from "./cli/sync";
import { runValidate } from "./cli/validate";
import { Exit, type ExitCode } from "./exit";

const VERSION = "0.1.0";

const HELP = `lens ${VERSION}

Usage:
  lens init [description] [--template <name>]
  lens status
  lens sync [--force] [--dry-run]
  lens pull [--force] [--dry-run]
  lens add <name> --description <text> [--path <p>] [--dry-run]
  lens apply [--dry-run]
  lens diff
  lens validate
  lens mark <synced|applied>
  lens --help
  lens --version

Global flags:
  --config <path>    Use a specific config file (default: lens.yml)
  --force            Overwrite existing config (init only)
  --dry-run          Print what would happen without executing
  -t, --template <name>  Template for init (default: webapp)
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
  description?: string;
  path?: string;
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
      template: { type: "string", short: "t" },
      description: { type: "string" },
      path: { type: "string", short: "p" },
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
    description: values.description,
    path: values.path,
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

  if (args.verb === "pull") {
    return runPull({
      force: args.force,
      dryRun: args.dryRun,
      configPath: args.configPath,
    });
  }

  if (args.verb === "add") {
    return runAdd({
      name: args.positionals[0],
      description: args.description,
      path: args.path,
      configPath: args.configPath,
      dryRun: args.dryRun,
    });
  }

  if (args.verb === "apply") {
    return runApply({ dryRun: args.dryRun, configPath: args.configPath });
  }

  if (args.verb === "diff") {
    return runDiff({ configPath: args.configPath });
  }

  if (args.verb === "validate") {
    return runValidate({ configPath: args.configPath });
  }

  if (args.verb === "status") {
    return runStatus({ configPath: args.configPath });
  }

  if (args.verb === "mark") {
    return runMark({ which: args.positionals[0] });
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
