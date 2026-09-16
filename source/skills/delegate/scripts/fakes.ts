import type { Exec, ExecResult } from "./process.ts";

export type FakeCall = {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
};

export type FakeResponse = Partial<ExecResult> & {
  cmd: string;
  waitForAbort?: boolean;
  onStart?: () => void;
};

export function fakeExec(responses: readonly FakeResponse[]): {
  exec: Exec;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let index = 0;
  const exec: Exec = async (cmd, args, options) => {
    calls.push({
      cmd,
      args: [...args],
      cwd: options.cwd,
      env: { ...options.env },
      stdin: options.stdin,
    });
    const response = responses[index++];
    if (response == null) throw new Error(`예상하지 않은 실행: ${cmd}`);
    if (response.cmd !== cmd) {
      throw new Error(`예상한 실행 ${response.cmd}, 실제 ${cmd}`);
    }
    response.onStart?.();
    if (response.waitForAbort) {
      if (!options.signal?.aborted) {
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          })
        );
      }
      return {
        code: null,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      };
    }
    return {
      code: response.code ?? 0,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
    };
  };
  return { exec, calls };
}
