export async function runJjCommand(args: string[], cwd: string) {
  const command = new Deno.Command("jj", {
    args: ["--no-pager", "--color", "never", "--quiet", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: { LC_ALL: "C" },
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout).trimEnd();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trimEnd();
    throw new Error(`jj ${args.join(" ")} failed\n${stderr}`);
  }
  return stdout;
}

export async function isJjRepo(cwd: string) {
  try {
    await runJjCommand(["root"], cwd);
    return true;
  } catch {
    return false;
  }
}
