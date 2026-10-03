import { runInForeignRepository } from "jsr:@jeiea/snippets@^0.2.0";

export async function runJjCommand(args: string[], cwd: string) {
  const result = await runInForeignRepository("jj", {
    args: ["--no-pager", "--color", "never", "--quiet", ...args],
    cwd,
    env: { LC_ALL: "C" },
  });
  if (!result.ok) {
    throw new Error(`jj ${args.join(" ")} failed\n${result.stderr.trimEnd()}`);
  }
  return result.stdout.trimEnd();
}

export async function isJjRepo(cwd: string) {
  try {
    await runJjCommand(["root"], cwd);
    return true;
  } catch {
    return false;
  }
}
