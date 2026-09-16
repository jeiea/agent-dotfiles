import { runInForeignRepository } from "jsr:@jeiea/snippets@^0.2.0";

export const _internals = { parsePrBaseBranch, runGhCommand };

/** 현재 브랜치에 열린 PR이 있으면 base branch 이름 반환, 없으면 null. */
export async function getPrBaseBranch(cwd: string): Promise<string | null> {
  try {
    const json = await runGhCommand(
      ["pr", "view", "--json", "baseRefName"],
      cwd,
    );
    return parsePrBaseBranch(json);
  } catch {
    return null;
  }
}

function parsePrBaseBranch(json: string): string | null {
  try {
    const parsed = JSON.parse(json);
    const name = parsed?.baseRefName;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

async function runGhCommand(args: string[], cwd: string): Promise<string> {
  const result = await runInForeignRepository("gh", { args, cwd });
  if (!result.ok) {
    throw new Error(`gh ${args.join(" ")} failed`);
  }
  return result.stdout;
}
