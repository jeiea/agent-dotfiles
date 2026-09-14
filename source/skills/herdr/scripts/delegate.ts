import {
  argument,
  choice,
  command,
  integer,
  lineBreak,
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
import { join, resolve } from "jsr:@std/path@^1";
import { parseClaudeEvents, planClaude } from "./claude.ts";
import { parseCodexEvents, planCodex } from "./codex.ts";
import { directAbortStatus, startDirect } from "./direct.ts";
import { type DocumentFront, renderDocument } from "./document.ts";
import {
  closeHerdr,
  refreshHerdr,
  resumeHerdr,
  startHerdr,
  waitHerdr,
} from "./herdr.ts";
import { denoExec, type Exec } from "./process.ts";
import {
  readLog,
  readRun,
  runExitCode,
  type RunRecord,
  writeLogs,
  writeRun,
} from "./runs.ts";
import {
  type Agent,
  type Effort,
  parseDuration,
  type Permission,
  selectAgent,
  selectTransport,
  type Transport,
} from "./select.ts";

export type Deps = {
  exec: Exec;
  env: Record<string, string>;
  stdin: { isTerminal(): boolean; text(): Promise<string> };
  stateDir: string;
  cwd: string;
  signal: AbortSignal;
  now(): Date;
};

type CommonOptions = {
  promptFile?: string;
  agent: "auto" | Agent;
  transport: "auto" | "herdr" | "direct";
  permission?: "read-only" | "write";
  cwd?: string;
  addDirs: readonly string[];
  callerId?: string;
  name?: string;
  model?: string;
  effort: Effort;
  timeoutMs: number;
  detach: boolean;
  keep: boolean;
  dryRun: boolean;
};

type ParsedCommand =
  | ({ kind: "run" } & CommonOptions & { permission: "read-only" | "write" })
  | (
    & { kind: "resume"; target: string; confirmEscalation: boolean }
    & CommonOptions
  )
  | { kind: "status"; target: string }
  | { kind: "close"; target: string }
  | { kind: "wait"; target: string; timeoutMs: number }
  | { kind: "logs"; target: string; lines: number };

type RequestFront = Omit<DocumentFront, "status" | "error">;

function requestResult(
  front: RequestFront,
  status: "planned" | "blocked" | "failed",
  code: number,
  error?: NonNullable<DocumentFront["error"]>,
) {
  const { run_id, ...details } = front;
  return {
    stdout: renderDocument({ run_id, status, ...details, error }),
    stderr: "",
    code,
  };
}

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

const br = lineBreak();
const helpFooter =
  message`권장:${br}delegate run --permission read-only <<'PROMPT'${br}첫 번째 줄입니다.${br}${br}두 번째 문단입니다.${br}코드의 \\n은 그대로 유지됩니다.${br}PROMPT${br}${br}오용(위치 인자와 리터럴 \\n 변환 미지원):${br}delegate run --permission read-only '첫 번째 줄\\n두 번째 줄'${br}${br}파일 입력:${br}delegate run --permission write --prompt-file scratch/task.md${br}${br}read-only는 파일·외부 상태 변경 금지, write는 워크스페이스 변경·테스트 허용. 웹 검색·가져오기는 항상 허용.`;

function commonOptions(permissionDefault: boolean) {
  return {
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
    permission: permissionDefault
      ? withDefault(
        option("--permission", choice(["read-only", "write"] as const)),
        "read-only" as const,
      )
      : optional(option(
        "--permission",
        choice(["read-only", "write"] as const),
      )),
    cwd: optional(option(
      "-C",
      "--cwd",
      path({ type: "directory", mustExist: true }),
    )),
    addDirs: multiple(
      option("--add-dir", path({ type: "directory", mustExist: true })),
    ),
    callerId: optional(option("--caller-id", string({ metavar: "ID" }))),
    name: optional(option("--name", string({ metavar: "NAME" }))),
    model: optional(option("--model", string({ metavar: "MODEL" }))),
    effort: withDefault(
      option(
        "--effort",
        choice(["low", "medium", "high", "xhigh", "max"] as const),
      ),
      "medium" as const,
    ),
    timeoutMs: withDefault(option("--timeout", duration), 1_200_000),
    detach: option("--detach"),
    keep: option("--keep"),
    dryRun: option("--dry-run"),
  };
}

function parser() {
  const runCommand = map(
    command("run", object(commonOptions(true)), {
      brief: message`새 위임 시작`,
      footer: helpFooter,
    }),
    (value) => ({ kind: "run" as const, ...value }),
  );
  const resumeCommand = map(
    command(
      "resume",
      object({
        target: argument(string({ metavar: "RUN_ID|SESSION_ID" }), {}),
        ...commonOptions(false),
        confirmEscalation: option("--confirm-escalation"),
      }),
      { brief: message`기존 위임 재개` },
    ),
    (value) => ({ kind: "resume" as const, ...value }),
  );
  const targetCommand = (kind: "status" | "close") =>
    map(
      command(
        kind,
        object({
          target: argument(string({ metavar: "RUN_ID" }), {}),
        }),
        { brief: message`실행 상태 처리` },
      ),
      (value) => ({ kind, ...value }),
    );
  const waitCommand = map(
    command(
      "wait",
      object({
        target: argument(string({ metavar: "RUN_ID" }), {}),
        timeoutMs: withDefault(option("--timeout", duration), 1_200_000),
      }),
      { brief: message`실행 완료 대기` },
    ),
    (value) => ({ kind: "wait" as const, ...value }),
  );
  const logsCommand = map(
    command(
      "logs",
      object({
        target: argument(string({ metavar: "RUN_ID" }), {}),
        lines: withDefault(option("--lines", integer({ min: 1 })), 200),
      }),
      { brief: message`실행 로그 조회` },
    ),
    (value) => ({ kind: "logs" as const, ...value }),
  );
  return or(
    runCommand,
    resumeCommand,
    targetCommand("status"),
    waitCommand,
    logsCommand,
    targetCommand("close"),
  );
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function readPrompt(
  promptFile: string | undefined,
  deps: Deps,
): Promise<{ text: string; source: "stdin" | "file"; path?: string }> {
  if (promptFile != null) {
    const absolutePath = resolve(deps.cwd, promptFile);
    return {
      text: (await Deno.readTextFile(absolutePath)).replace(/^\uFEFF/, ""),
      source: "file",
      path: absolutePath,
    };
  }
  if (deps.stdin.isTerminal()) throw new Error("stdin 프롬프트가 필요합니다");
  return {
    text: (await deps.stdin.text()).replace(/^\uFEFF/, ""),
    source: "stdin",
  };
}

function frontFromRecord(record: RunRecord): DocumentFront {
  return {
    run_id: record.runId,
    status: record.status,
    agent: record.agent,
    transport: record.transport,
    permission: record.permission,
    session_id: record.nativeSessionId,
    cwd: record.cwd,
    reason: record.reason,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    herdr: record.herdr == null ? undefined : {
      workspace_id: record.herdr.workspaceId,
      tab_id: record.herdr.tabId,
      pane_id: record.herdr.paneId,
      agent_name: record.herdr.agentName,
    },
    error: record.error,
  };
}

function parsedOutput(record: RunRecord, stdout: string) {
  return record.agent === "codex"
    ? parseCodexEvents(stdout)
    : parseClaudeEvents(stdout);
}

async function renderRecord(
  record: RunRecord,
  deps: Deps,
): Promise<string> {
  const raw = await readLog(deps.stateDir, record.runId, "stdout");
  const result = record.transport === "direct"
    ? parsedOutput(record, raw).result ?? ""
    : raw;
  const continuation = record.transport === "herdr" &&
      ["working", "blocked", "timed_out"].includes(record.status)
    ? `\n\n상태 확인: delegate status ${record.runId}` +
      (record.status === "blocked"
        ? `\n재개: delegate resume ${record.runId}`
        : `\n계속 대기: delegate wait ${record.runId}`)
    : (record.status === "timed_out" || record.status === "cancelled") &&
        record.nativeSessionId != null
    ? `\n\n재개: delegate resume ${record.runId}`
    : "";
  return renderDocument(frontFromRecord(record), result + continuation);
}

async function executeDirect(
  record: RunRecord,
  invocation: ReturnType<typeof planCodex> | ReturnType<typeof planClaude>,
  deps: Deps,
): Promise<{ stdout: string; stderr: string; code: number }> {
  record.status = "working";
  await writeRun(deps.stateDir, record);
  let output;
  let handle;
  try {
    handle = startDirect(
      invocation,
      { ...deps, cwd: record.cwd },
      record.timeoutMs,
    );
    output = await handle.output;
  } catch (error) {
    record.status = "failed";
    record.finishedAt = deps.now().toISOString();
    record.error = error instanceof Deno.errors.NotFound
      ? {
        code: "native_unavailable",
        message: `${record.agent} 실행 파일 없음`,
      }
      : {
        code: "native_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    await writeRun(deps.stateDir, record);
    await writeLogs(deps.stateDir, record.runId, "", record.error.message);
    return {
      stdout: await renderRecord(record, deps),
      stderr: "[delegate] starting\n[delegate] failed\n",
      code: record.error.code === "native_unavailable" ? 3 : 5,
    };
  }

  await writeLogs(
    deps.stateDir,
    record.runId,
    output.stdout,
    output.stderr,
  );
  const parsed = parsedOutput(record, output.stdout);
  record.nativeSessionId = parsed.sessionId;
  record.finishedAt = deps.now().toISOString();
  const abortStatus = directAbortStatus(handle);
  if (abortStatus === "cancelled") {
    record.status = "cancelled";
    record.error = { code: "cancelled", message: "사용자 중단" };
  } else if (abortStatus === "timed_out") {
    record.status = "timed_out";
    record.error = { code: "timeout", message: "실행 제한 시간 초과" };
  } else if (
    output.code !== 0 || parsed.result == null || parsed.sessionId == null
  ) {
    record.status = "failed";
    record.error = {
      code: "agent_failed",
      message: parsed.error ??
        (output.stderr.trim() || "에이전트 결과 파싱 실패"),
    };
  } else {
    record.status = "done";
    delete record.error;
  }
  await writeRun(deps.stateDir, record);
  return {
    stdout: await renderRecord(record, deps),
    stderr: `[delegate] starting\n[delegate] ${record.status}\n`,
    code: runExitCode(record.status),
  };
}

function tail(text: string, lines: number): string {
  return text.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
}

function fenced(text: string): string {
  const longest = Math.max(
    2,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function usageFailure(error: unknown, stderr = "") {
  const message = error instanceof Error ? error.message : String(error);
  return {
    stdout: renderDocument({
      status: "failed",
      error: { code: "usage", message },
    }),
    stderr,
    code: 2,
  };
}

export function resolveStateDir(env: Record<string, string>): string {
  if (env.DELEGATE_STATE_DIR != null) return resolve(env.DELEGATE_STATE_DIR);
  if (env.XDG_STATE_HOME != null) return join(env.XDG_STATE_HOME, "delegate");
  if (env.HOME != null) return join(env.HOME, ".local", "state", "delegate");
  throw new Error("DELEGATE_STATE_DIR, XDG_STATE_HOME 또는 HOME이 필요합니다");
}

export async function runDelegate(
  args: string[],
  deps: Deps,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const parserStdout: string[] = [];
  const parserStderr: string[] = [];
  let parsed: ParsedCommand;
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
    const parserMessage = parserStderr.join("").trim();
    return usageFailure(
      parserMessage || (error instanceof Error ? error.message : String(error)),
      parserStderr.join(""),
    );
  }

  if (
    parsed.kind === "status" || parsed.kind === "wait" ||
    parsed.kind === "logs" || parsed.kind === "close"
  ) {
    try {
      let record = await readRun(deps.stateDir, parsed.target);
      let actionCode: number | undefined;
      if (record.transport === "herdr" && parsed.kind === "wait") {
        const result = await waitHerdr(record, deps, parsed.timeoutMs);
        record = result.record;
        actionCode = result.code;
      } else if (record.transport === "herdr" && parsed.kind === "close") {
        const result = await closeHerdr(record, deps);
        record = result.record;
        actionCode = result.code;
      } else if (record.transport === "herdr" && parsed.kind === "status") {
        const result = await refreshHerdr(record, deps);
        record = result.record;
        actionCode = result.code;
      }
      if (parsed.kind === "logs") {
        const [stdout, stderr] = await Promise.all([
          readLog(deps.stateDir, record.runId, "stdout"),
          readLog(deps.stateDir, record.runId, "stderr"),
        ]);
        const body = `## stdout\n\n${fenced(tail(stdout, parsed.lines))}\n\n` +
          `## stderr\n\n${fenced(tail(stderr, parsed.lines))}`;
        return {
          stdout: renderDocument(frontFromRecord(record), body),
          stderr: "",
          code: runExitCode(record.status),
        };
      }
      return {
        stdout: await renderRecord(record, deps),
        stderr: "",
        code: parsed.kind === "close" && record.transport === "direct"
          ? 0
          : actionCode ?? runExitCode(record.status),
      };
    } catch (error) {
      return usageFailure(error);
    }
  }

  try {
    const prompt = await readPrompt(parsed.promptFile, deps);
    if (prompt.text.trim() === "") throw new Error("빈 프롬프트입니다");
    let parent: RunRecord | undefined;
    let resumeSessionId: string | undefined;
    let agentDecision: { agent: Agent; reason: string };
    let transportDecision: { transport: Transport; reason: string };

    if (parsed.kind === "resume" && parsed.target.startsWith("run_")) {
      parent = await readRun(deps.stateDir, parsed.target);
      if (parsed.agent !== "auto" && parsed.agent !== parent.agent) {
        throw new Error(
          `부모 실행의 agent=${parent.agent}와 --agent=${parsed.agent}가 다릅니다`,
        );
      }
      if (
        parsed.transport !== "auto" && parsed.transport !== parent.transport
      ) {
        throw new Error(
          `부모 실행의 transport=${parent.transport}와 --transport=${parsed.transport}가 다릅니다`,
        );
      }
      if (
        parent.nativeSessionId == null &&
        (parent.transport !== "herdr" || parent.herdr == null)
      ) {
        throw new Error(`재개할 세션 ID 없음: ${parsed.target}`);
      }
      resumeSessionId = parent.nativeSessionId;
      agentDecision = {
        agent: parent.agent,
        reason: `resume-run=${parent.runId}`,
      };
      transportDecision = {
        transport: parent.transport,
        reason: `resume-transport=${parent.transport}`,
      };
    } else if (parsed.kind === "resume") {
      if (parsed.agent === "auto") {
        throw new Error("세션 ID resume에는 --agent가 필요합니다");
      }
      resumeSessionId = parsed.target;
      agentDecision = {
        agent: parsed.agent,
        reason: `agent-explicit=${parsed.agent}`,
      };
      transportDecision = selectTransport(parsed.transport, deps.env);
    } else {
      agentDecision = parsed.agent === "auto"
        ? selectAgent(prompt.text)
        : { agent: parsed.agent, reason: `agent-explicit=${parsed.agent}` };
      transportDecision = selectTransport(parsed.transport, deps.env);
    }

    if (parsed.detach && transportDecision.transport === "direct") {
      throw new Error("--detach는 Herdr 전송에서만 사용할 수 있습니다");
    }
    const permission: Permission = parsed.permission ?? parent?.permission ??
      "read-only";
    const cwd = resolve(deps.cwd, parsed.cwd ?? parent?.cwd ?? deps.cwd);
    const request = {
      permission,
      cwd,
      addDirs: parsed.addDirs.map((dir) => resolve(deps.cwd, dir)),
      effort: parsed.effort,
      prompt: prompt.text,
      model: parsed.model,
      callerId: parsed.callerId ?? parent?.callerId,
      name: parsed.name ?? parent?.name,
      resumeSessionId,
    };
    const invocation = agentDecision.agent === "codex"
      ? planCodex(request)
      : planClaude(request);
    const bytes = new TextEncoder().encode(prompt.text).length;
    const promptDigest = await sha256(prompt.text);
    const runId = `run_${crypto.randomUUID()}`;
    const reason = [agentDecision.reason, transportDecision.reason];
    const requestFront: RequestFront = {
      run_id: runId,
      agent: agentDecision.agent,
      transport: transportDecision.transport,
      permission,
      session_id: resumeSessionId,
      cwd,
      reason,
      started_at: deps.now().toISOString(),
      command: [
        agentDecision.agent,
        ...(transportDecision.transport === "direct"
          ? invocation.directArgs
          : invocation.herdrArgs),
      ],
      prompt: {
        source: prompt.source,
        ...(prompt.path == null ? {} : { path: prompt.path }),
        bytes,
        sha256: promptDigest,
      },
    };

    if (
      parsed.kind === "resume" && parent?.permission === "read-only" &&
      permission === "write" && !parsed.confirmEscalation
    ) {
      return requestResult(requestFront, "blocked", 4, {
        code: "permission_escalation",
        message: "write 재개에는 --confirm-escalation이 필요합니다",
      });
    }

    if (
      transportDecision.transport === "herdr" && deps.env.HERDR_ENV !== "1"
    ) {
      return requestResult(requestFront, "failed", 3, {
        code: "transport_unavailable",
        message: "Herdr 환경 밖에서는 Herdr 전송을 사용할 수 없습니다",
      });
    }

    if (parsed.dryRun) {
      return requestResult(requestFront, "planned", 0);
    }

    const record: RunRecord = {
      runId,
      ...(parent == null ? {} : { parentRunId: parent.runId }),
      agent: agentDecision.agent,
      transport: transportDecision.transport,
      permission,
      cwd,
      callerId: request.callerId,
      name: request.name,
      keep: parsed.keep || parent?.keep,
      reason,
      status: "starting",
      timeoutMs: parsed.timeoutMs,
      prompt: { bytes, sha256: promptDigest },
      startedAt: deps.now().toISOString(),
    };
    await writeRun(deps.stateDir, record);
    if (record.transport === "direct") {
      return executeDirect(record, invocation, deps);
    }
    const herdrOptions = {
      callerId: request.callerId,
      detach: parsed.detach,
    };
    const herdrResult = parsed.kind === "resume" && parent != null
      ? await resumeHerdr(record, parent, invocation, deps, herdrOptions)
      : await startHerdr(record, invocation, deps, herdrOptions);
    return {
      stdout: await renderRecord(herdrResult.record, deps),
      stderr: `[delegate] starting\n[delegate] ${herdrResult.record.status}\n`,
      code: herdrResult.code,
    };
  } catch (error) {
    return usageFailure(error);
  }
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
  const env = Deno.env.toObject();
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  Deno.addSignalListener("SIGINT", interrupt);
  try {
    const result = await runDelegate(Deno.args, {
      exec: denoExec,
      env,
      stdin: {
        isTerminal: () => Deno.stdin.isTerminal(),
        text: () => new Response(Deno.stdin.readable).text(),
      },
      stateDir: resolveStateDir(env),
      cwd: Deno.cwd(),
      signal: controller.signal,
      now: () => new Date(),
    });
    await writeText(Deno.stdout, result.stdout);
    await writeText(Deno.stderr, result.stderr);
    Deno.exit(result.code);
  } finally {
    Deno.removeSignalListener("SIGINT", interrupt);
  }
}

if (import.meta.main) await main();
