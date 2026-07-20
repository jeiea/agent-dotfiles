import { runGitOrThrow } from "jsr:@jeiea/snippets@^0.1.1";

export async function runGitCommand(args: string[], cwd: string) {
  const { stdout } = await runGitOrThrow(["-C", cwd, ...args], { env: { LC_ALL: "C" } });
  return stdout.trimEnd();
}

export async function getCurrentBranch(cwd: string) {
  return await runGitCommand(["rev-parse", "--abbrev-ref=strict", "HEAD"], cwd);
}
