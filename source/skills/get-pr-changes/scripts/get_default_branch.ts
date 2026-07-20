import { getCurrentBranch, runGitCommand } from "./git_commands.ts";

export const _internals = {
  extractRemotesFromConfig,
  getBranchUpstream,
  extractDefaultBranch,
};

export async function getGitRepoDefaultBranch(path: string) {
  const currentBranch = await getCurrentBranch(path);
  return await getDefaultBranch(path, currentBranch);
}

export async function getRemoteForBranch(path: string, sourceBranch: string): Promise<string> {
  const config = await runGitCommand(["config", "--list"], path);
  const remotes = extractRemotesFromConfig(config);
  const firstRemote = remotes[0];
  if (!firstRemote) {
    throw new Error("no remote found");
  }
  return getBranchUpstream(config, sourceBranch) ?? firstRemote;
}

export async function getDefaultBranch(path: string, sourceBranch: string) {
  const remote = await getRemoteForBranch(path, sourceBranch);

  const stdout = await runGitCommand(["remote", "show", remote], path);
  const defaultBranch = extractDefaultBranch(stdout);
  if (!defaultBranch) {
    throw new Error(`default branch not found\ncwd: ${path}\ngit remote show ${remote}: ${stdout}`);
  }

  return `refs/remotes/${remote}/${defaultBranch}`;
}

function extractRemotesFromConfig(config: string) {
  return [...config.matchAll(/^remote\.(.*)\.url=/gm).map((match) => match[1])];
}

function getBranchUpstream(config: string, currentBranch: string) {
  return config.match(new RegExp(`branch\.${RegExp.escape(currentBranch)}\.remote=(.*)`))?.[1];
}

function extractDefaultBranch(stdout: string) {
  return stdout.match(/HEAD branch: (.*)/)?.[1];
}
