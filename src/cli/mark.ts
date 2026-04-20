import { Exit, type ExitCode } from "../exit";
import { getHead, isGitRepo, readRef, updateRef } from "../git";

export type MarkWhich = "synced" | "applied";

export interface MarkArgs {
  which: MarkWhich;
  cwd?: string;
}

export async function runMark(args: MarkArgs): Promise<ExitCode> {
  const cwd = args.cwd ?? process.cwd();
  const ref = `refs/lens/${args.which}`;

  if (!(await isGitRepo(cwd))) {
    console.error(`lens: mark-${args.which} requires a git repository`);
    return Exit.GIT;
  }

  const head = await getHead(cwd);
  if (head === null) {
    console.error(`lens: mark-${args.which} could not resolve HEAD`);
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
