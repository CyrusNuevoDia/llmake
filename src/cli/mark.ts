import { Exit, type ExitCode } from "../exit";
import { getHead, isGitRepo, readRef, updateRef } from "../git";

export type MarkWhich = "synced" | "applied";

export interface MarkArgs {
  which?: string;
  cwd?: string;
}

function parseWhich(raw: string | undefined): MarkWhich | null {
  if (raw === "synced" || raw === "applied") {
    return raw;
  }
  return null;
}

export async function runMark(args: MarkArgs): Promise<ExitCode> {
  const which = parseWhich(args.which);
  if (!which) {
    console.error("lens: mark — usage: lens mark <synced|applied>");
    return Exit.FAIL;
  }

  const cwd = args.cwd ?? process.cwd();
  const ref = `refs/lens/${which}`;

  if (!(await isGitRepo(cwd))) {
    console.error(`lens: mark ${which} requires a git repository`);
    return Exit.GIT;
  }

  const head = await getHead(cwd);
  if (head === null) {
    console.error(`lens: mark ${which} could not resolve HEAD`);
    return Exit.GIT;
  }

  const current = await readRef(ref, cwd);
  if (current === head) {
    console.error(`lens: ${ref} already at HEAD`);
    return Exit.FAIL;
  }

  await updateRef(ref, head, cwd);
  console.log(`lens: advanced ${ref} to ${head.slice(0, 7)}`);
  return Exit.SUCCESS;
}
