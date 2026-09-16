import {
  argument,
  choice,
  command,
  integer,
  map,
  message,
  multiple,
  object,
  option,
  optional,
  or,
  string,
  type ValueParser,
  withDefault,
} from "jsr:@optique/core@^1.2";
import { path, run } from "jsr:@optique/run@^1.2";
import { resolve } from "jsr:@std/path@^1";
import { parseClaudeEvents, planClaude } from "./claude.ts";
import { parseCodexEvents, planCodex } from "./codex.ts";
import { directAbortStatus, startDirect } from "./direct.ts";
import {
  type DelegateDocument,
  DelegateError,
  exitCode,
  type NativeSessionId,
  normalizeError,
  renderDocument,
} from "./document.ts";
import {
  closeHerdr,
  type HerdrDeps,
  promptHerdr,
  statusHerdr,
  waitHerdr,
} from "./herdr.ts";
import {
  assertSessionId,
  findNativeSession,
  renderConversation,
  sessionIdPattern,
} from "./native_session.ts";
import { denoExec, type Exec } from "./process.ts";
import {
  type Agent,
  type Effort,
  type NativeInvocation,
  parseDuration,
  type Permission,
  selectAgent,
  selectTransport,
} from "./select.ts";

export type Deps = {
  exec: Exec;
  env: Record<string, string>;
  stdin: { isTerminal(): boolean; text(): Promise<string> };
  cwd: string;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

type PromptOptions = {
  kind: "prompt";
  target?: string;
  promptFile?: string;
  agent: "auto" | Agent;
  transport: "auto" | "herdr" | "direct";
  permission?: Permission;
  model?: string;
  effort?: Effort;
  addDirs: readonly string[];
  callerId?: string;
  name?: string;
  timeoutMs: number;
  confirmEscalation: boolean;
};

type ParsedCommand = PromptOptions | {
  kind: "status";
  target: string;
} | {
  kind: "wait";
  target: string;
  timeoutMs: number;
  callerId?: string;
  name?: string;
} | {
  kind: "logs";
  target: string;
  lines: number;
} | {
  kind: "close";
  target: string;
  callerId?: string;
};

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exit ${code}`);
  }
}

const duration: ValueParser<"sync", number> = {
  mode: "sync",
  metavar: "DURATION",
  placeholder: 1_200_000,
  parse(input) {
    try {
      return { success: true, value: parseDuration(input) };
    } catch {
      return { success: false, error: message`잘못된 duration: ${input}` };
    }
  },
  format: (value) => `${value}ms`,
};

function parser() {
  const prompt = map(
    command(
      "prompt",
      object({
        target: optional(argument(string({ metavar: "SESSION_ID" }), {})),
        promptFile: optional(option(
          "-f",
          "--prompt-file",
          path({ type: "file", mustExist: true }),
        )),
        agent: withDefault(
          option("--agent", choice(["auto", "codex", "claude"] as const)),
          "auto" as const,
        ),
        transport: withDefault(
          option("--transport", choice(["auto", "herdr", "direct"] as const)),
          "auto" as const,
        ),
        permission: optional(option(
          "--permission",
          choice(["read-only", "write"] as const),
        )),
        model: optional(option("--model", string({ metavar: "MODEL" }))),
        effort: optional(option(
          "--effort",
          choice(["low", "medium", "high", "xhigh", "max"] as const),
        )),
        addDirs: multiple(option(
          "--add-dir",
          path({ type: "directory", mustExist: true }),
        )),
        callerId: optional(option("--caller-id", string({ metavar: "ID" }))),
        name: optional(option("--name", string({ metavar: "NAME" }))),
        timeoutMs: withDefault(option("--timeout", duration), 1_200_000),
        confirmEscalation: option("--confirm-escalation"),
      }),
      { brief: message`새 native session 시작 또는 기존 session prompt` },
    ),
    (value) => ({
      kind: "prompt" as const,
      ...value,
    }),
  );
  const status = map(
    command(
      "status",
      object({
        target: argument(string({ metavar: "SESSION_ID" }), {}),
      }),
    ),
    (value) => ({ kind: "status" as const, ...value }),
  );
  const wait = map(
    command(
      "wait",
      object({
        target: argument(string({ metavar: "SESSION_ID" }), {}),
        timeoutMs: withDefault(option("--timeout", duration), 1_200_000),
        callerId: optional(option("--caller-id", string({ metavar: "ID" }))),
        name: optional(option("--name", string({ metavar: "NAME" }))),
      }),
    ),
    (value) => ({ kind: "wait" as const, ...value }),
  );
  const logs = map(
    command(
      "logs",
      object({
        target: argument(string({ metavar: "SESSION_ID" }), {}),
        lines: withDefault(option("--lines", integer({ min: 1 })), 200),
      }),
    ),
    (value) => ({ kind: "logs" as const, ...value }),
  );
  const close = map(
    command(
      "close",
      object({
        target: argument(string({ metavar: "SESSION_ID" }), {}),
        callerId: optional(option("--caller-id", string({ metavar: "ID" }))),
      }),
    ),
    (value) => ({ kind: "close" as const, ...value }),
  );
  return or(prompt, status, wait, logs, close);
}

export async function runDelegate(
  args: string[],
  deps: Deps,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let parsed: ParsedCommand;
  const parserStdout: string[] = [];
  const parserStderr: string[] = [];
  try {
    parsed = run(parser(), {
      programName: "delegate",
      args,
      stdout: (text) => parserStdout.push(text),
      stderr: (text) => parserStderr.push(text),
      onExit: (code) => {
        throw new CliExit(code);
      },
      errorExitCode: 2,
      help: "option",
      colors: false,
      showChoices: true,
      showDefault: true,
    }) as ParsedCommand;
  } catch (error) {
    if (error instanceof CliExit && error.code === 0) {
      return { stdout: parserStdout.join(""), stderr: "", code: 0 };
    }
    return failure(
      new DelegateError(
        "usage",
        parserStderr.join("").trim() ||
          (error instanceof Error ? error.message : String(error)),
      ),
      undefined,
      undefined,
      parserStderr.join(""),
    );
  }

  const herdrDeps = runtimeDeps(deps);
  try {
    if (parsed.kind !== "prompt") {
      const snapshot = await findNativeSession(parsed.target, deps.env);
      if (parsed.kind === "logs") {
        return success({
          session_id: snapshot.sessionId,
          agent: snapshot.agent,
          completed_turns: snapshot.completedTurns,
          result: tail(renderConversation(snapshot), parsed.lines),
        });
      }
      if (deps.env.HERDR_ENV !== "1") {
        return success({
          session_id: snapshot.sessionId,
          agent: snapshot.agent,
          activity: "not_live",
          completed_turns: snapshot.completedTurns,
        });
      }
      if (parsed.kind === "status") {
        return success(await statusHerdr(snapshot, herdrDeps));
      }
      if (parsed.kind === "wait") {
        return success(await waitHerdr(snapshot, parsed, herdrDeps));
      }
      return success(await closeHerdr(snapshot, parsed.callerId, herdrDeps));
    }

    const prompt = await readPrompt(parsed.promptFile, deps);
    if (prompt.trim() === "") {
      throw new DelegateError("usage", "빈 프롬프트입니다");
    }
    const snapshot = parsed.target == null
      ? undefined
      : await findNativeSession(parsed.target, deps.env);
    const agent = selectPromptAgent(parsed.agent, prompt, snapshot?.agent);
    const transport = selectTransport(parsed.transport, deps.env).transport;
    if (transport === "herdr" && deps.env.HERDR_ENV !== "1") {
      throw new DelegateError(
        "transport_unavailable",
        "Herdr 전송을 사용할 수 없습니다",
      );
    }
    const permission = parsed.permission ?? "read-only";
    if (
      transport === "direct" && snapshot != null && permission === "write" &&
      !parsed.confirmEscalation
    ) {
      throw new DelegateError(
        "permission_escalation",
        "stopped session의 write 재개에는 --confirm-escalation이 필요합니다",
      );
    }
    const request = {
      permission,
      cwd: snapshot?.cwd ?? deps.cwd,
      addDirs: parsed.addDirs.map((dir) => resolve(deps.cwd, dir)),
      effort: parsed.effort ?? "medium",
      prompt,
      model: parsed.model,
      callerId: parsed.callerId ?? deps.env.CODEX_THREAD_ID,
      name: parsed.name,
      resumeSessionId: snapshot?.sessionId,
    };
    const invocation = agent === "codex"
      ? planCodex(request)
      : planClaude(request);
    const startOptionsSpecified = snapshot != null && (
      parsed.permission != null || parsed.model != null ||
      parsed.effort != null || parsed.addDirs.length > 0
    );
    if (transport === "direct") {
      return await executeDirect(
        invocation,
        snapshot?.sessionId,
        request.cwd,
        deps,
        parsed.timeoutMs,
      );
    }
    return success(
      await promptHerdr({
        invocation,
        cwd: request.cwd,
        snapshot,
        callerId: request.callerId,
        name: parsed.name,
        timeoutMs: parsed.timeoutMs,
        startOptionsSpecified,
        writeResume: snapshot != null && permission === "write",
        confirmEscalation: parsed.confirmEscalation,
      }, herdrDeps),
    );
  } catch (error) {
    const sessionId = parsed.target;
    const normalized = normalizeError(error);
    const knownSessionId = normalized.sessionId ?? sessionId;
    if (
      normalized.code === "agent_blocked" && knownSessionId != null &&
      sessionIdPattern.test(knownSessionId)
    ) {
      try {
        const snapshot = await findNativeSession(knownSessionId, deps.env);
        return failure(normalized, knownSessionId, snapshot.agent, "", {
          activity: "blocked",
          completed_turns: snapshot.completedTurns,
        });
      } catch {
        // 원래 blocked 진단을 native 재조회 실패로 덮지 않는다.
      }
    }
    return failure(normalized, knownSessionId);
  }
}

async function executeDirect(
  invocation: NativeInvocation,
  expectedSessionId: string | undefined,
  cwd: string,
  deps: Deps,
  timeoutMs: number,
) {
  let handle;
  let output;
  try {
    handle = startDirect(invocation, { ...deps, cwd }, timeoutMs);
    output = await handle.output;
  } catch (error) {
    return failure(
      new DelegateError(
        "agent_failed",
        error instanceof Error ? error.message : String(error),
      ),
      expectedSessionId,
      invocation.agent,
    );
  }
  const parsed = invocation.agent === "codex"
    ? parseCodexEvents(output.stdout)
    : parseClaudeEvents(output.stdout);
  const aborted = directAbortStatus(handle);
  if (aborted != null) {
    return failure(
      new DelegateError(
        aborted === "cancelled" ? "cancelled" : "timeout",
        aborted === "cancelled" ? "호출자 중단" : "실행 제한 시간 초과",
        undefined,
        parsed.sessionId ?? expectedSessionId,
      ),
      parsed.sessionId ?? expectedSessionId,
      invocation.agent,
    );
  }
  if (
    expectedSessionId != null && parsed.sessionId != null &&
    parsed.sessionId.toLowerCase() !== expectedSessionId.toLowerCase()
  ) {
    return failure(
      new DelegateError(
        "session_id_changed",
        `resume session ID 변경: ${expectedSessionId} -> ${parsed.sessionId}`,
      ),
      expectedSessionId,
      invocation.agent,
    );
  }
  if (output.code !== 0 || parsed.sessionId == null || parsed.result == null) {
    return failure(
      new DelegateError(
        "agent_failed",
        parsed.error ??
          (output.stderr.trim() || "에이전트 결과를 해석할 수 없습니다"),
      ),
      parsed.sessionId ?? expectedSessionId,
      invocation.agent,
    );
  }
  try {
    assertSessionId(parsed.sessionId);
  } catch {
    return failure(
      new DelegateError(
        "session_id_unavailable",
        "native agent가 유효한 session ID를 보고하지 않았습니다",
      ),
      expectedSessionId,
      invocation.agent,
    );
  }
  return success({
    session_id: parsed.sessionId,
    agent: invocation.agent,
    activity: "quiescent",
    result: parsed.result,
  });
}

async function readPrompt(promptFile: string | undefined, deps: Deps) {
  let prompt: string;
  if (promptFile != null) {
    prompt = await Deno.readTextFile(resolve(deps.cwd, promptFile));
  } else {
    if (deps.stdin.isTerminal()) {
      throw new DelegateError("usage", "stdin 프롬프트가 필요합니다");
    }
    prompt = await deps.stdin.text();
  }
  return prompt.replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
}

function selectPromptAgent(
  requested: "auto" | Agent,
  prompt: string,
  detected?: Agent,
): Agent {
  if (detected != null) {
    if (requested !== "auto" && requested !== detected) {
      throw new DelegateError(
        "usage",
        `감지된 agent=${detected}와 --agent=${requested}가 다릅니다`,
      );
    }
    return detected;
  }
  return requested === "auto" ? selectAgent(prompt).agent : requested;
}

function runtimeDeps(deps: Deps): HerdrDeps {
  return {
    exec: deps.exec,
    env: deps.env,
    signal: deps.signal,
    now: deps.now ?? (() => performance.now()),
    sleep: deps.sleep ?? abortableSleep,
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolveSleep, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function success(document: DelegateDocument) {
  return { stdout: renderDocument(document), stderr: "", code: 0 };
}

function failure(
  error: DelegateError,
  sessionId?: string,
  agent?: Agent,
  stderr = "",
  context: Pick<DelegateDocument, "activity" | "completed_turns"> = {},
) {
  const publicSessionId = sessionId != null && sessionIdPattern.test(sessionId)
    ? sessionId as NativeSessionId
    : undefined;
  return {
    stdout: renderDocument({
      ...(publicSessionId == null ? {} : { session_id: publicSessionId }),
      ...(agent == null ? {} : { agent }),
      ...context,
      error: {
        code: error.code,
        message: error.message,
        ...(error.blockers == null ? {} : { blockers: error.blockers }),
      },
      ...(error.retry == null ? {} : { retry: error.retry }),
    }),
    stderr,
    code: exitCode(error.code),
  };
}

function tail(text: string, lines: number): string {
  return text.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
}

async function writeText(
  stream: { write(data: Uint8Array): Promise<number> },
  text: string,
): Promise<void> {
  const data = new TextEncoder().encode(text);
  let offset = 0;
  while (offset < data.length) {
    offset += await stream.write(data.subarray(offset));
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  Deno.addSignalListener("SIGINT", interrupt);
  try {
    const result = await runDelegate(Deno.args, {
      exec: denoExec,
      env: Deno.env.toObject(),
      stdin: {
        isTerminal: () => Deno.stdin.isTerminal(),
        text: () => new Response(Deno.stdin.readable).text(),
      },
      cwd: Deno.cwd(),
      signal: controller.signal,
    });
    await writeText(Deno.stdout, result.stdout);
    await writeText(Deno.stderr, result.stderr);
    Deno.exit(result.code);
  } finally {
    Deno.removeSignalListener("SIGINT", interrupt);
  }
}

if (import.meta.main) await main();
