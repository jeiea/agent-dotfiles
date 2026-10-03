#!/usr/bin/env -S deno run --allow-all
import {
  getDefaultBranch,
  getGitRepoDefaultBranch,
  getRemoteForBranch,
} from "./get_default_branch.ts";
import { getPrBaseBranch } from "./get_pr_base_branch.ts";
import { getBranchChangesText } from "./get_branch_changes.ts";
import { getCurrentBranch } from "./git_commands.ts";
import { isJjRepo } from "./jj_commands.ts";
import { parseArgs } from "jsr:@std/cli@^1";

if (import.meta.main) {
  await main();
}

async function main() {
  const {
    _: [command],
    base,
  } = parseArgs(Deno.args, { string: ["base"] });

  const cwd = Deno.cwd();

  switch (command) {
    case "get-default-branch": {
      console.info(await getGitRepoDefaultBranch(cwd));
      return;
    }
    case "get-pr-changes": {
      const vcs = await isJjRepo(cwd) ? "jj" : "git";
      const baseBranch = base ?? await resolveBaseBranch(cwd, vcs);
      console.info(await getBranchChangesText(cwd, baseBranch, { vcs }));
      return;
    }
    default:
      printHelp();
      Deno.exit(1);
  }
}

/** PR이 열려있으면 PR base branch, 없으면 remote default branch */
async function resolveBaseBranch(
  path: string,
  vcs: "git" | "jj",
): Promise<string> {
  if (vcs === "jj") {
    return await resolveJjBaseBranch(path);
  }

  const currentBranch = await getCurrentBranch(path);

  const prBase = await getPrBaseBranch(path);
  if (prBase) {
    const remote = await getRemoteForBranch(path, currentBranch);
    return `refs/remotes/${remote}/${prBase}`;
  }
  return await getDefaultBranch(path, currentBranch);
}

/** jj: Git branch 대신 bookmark/revset 기준 비교 */
async function resolveJjBaseBranch(path: string): Promise<string> {
  const prBase = await getPrBaseBranch(path);
  return prBase ?? "trunk()";
}

function printHelp() {
  console.info(`Usage:
  deno -A scripts/cli.ts get-default-branch
  deno -A scripts/cli.ts get-pr-changes [--base <branch>]`);
}
