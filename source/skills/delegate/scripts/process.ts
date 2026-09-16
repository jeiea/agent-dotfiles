export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type Exec = (
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdin?: string;
    signal?: AbortSignal;
  },
) => Promise<ExecResult>;

export const denoExec: Exec = async (cmd, args, options) => {
  const child = new Deno.Command(cmd, {
    args,
    cwd: options.cwd,
    env: options.env,
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    signal: options.signal,
  }).spawn();
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const writer = child.stdin.getWriter();
  let stdinError: unknown;
  try {
    await writer.write(new TextEncoder().encode(options.stdin ?? ""));
    await writer.close();
  } catch (error) {
    stdinError = error;
  }

  let code: number | null = null;
  try {
    code = (await child.status).code;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      throw error;
    }
  }
  const result = { code, stdout: await stdout, stderr: await stderr };
  if (stdinError != null && !(stdinError instanceof Deno.errors.BrokenPipe)) {
    throw stdinError;
  }
  return result;
};
