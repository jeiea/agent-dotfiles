import type { NativeInvocation } from "./select.ts";
import type { Exec, ExecResult } from "./process.ts";

export type DirectDeps = {
  exec: Exec;
  env: Record<string, string>;
  cwd: string;
  signal: AbortSignal;
};

export type DirectHandle = {
  output: Promise<ExecResult>;
  interrupted: AbortSignal;
  timedOut: AbortSignal;
};

function directEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("HERDR_")),
  );
}

export function startDirect(
  invocation: NativeInvocation,
  deps: DirectDeps,
  timeoutMs: number,
): DirectHandle {
  const timedOut = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([deps.signal, timedOut]);
  return {
    output: deps.exec(invocation.agent, invocation.directArgs, {
      cwd: deps.cwd,
      env: directEnv(deps.env),
      stdin: invocation.prompt,
      signal,
    }),
    interrupted: deps.signal,
    timedOut,
  };
}

export function directAbortStatus(
  handle: DirectHandle,
): "cancelled" | "timed_out" | undefined {
  if (handle.interrupted.aborted) return "cancelled";
  if (handle.timedOut.aborted) return "timed_out";
}
