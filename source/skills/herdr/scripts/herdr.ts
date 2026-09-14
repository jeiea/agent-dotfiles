import type { Exec, ExecResult } from "./process.ts";
import {
  listRuns,
  runExitCode,
  type RunRecord,
  writeLogs,
  writeRun,
} from "./runs.ts";
import type { NativeInvocation } from "./select.ts";

type HerdrDeps = {
  exec: Exec;
  env: Record<string, string>;
  stateDir: string;
  signal: AbortSignal;
  now(): Date;
};

type HerdrOptions = {
  callerId?: string;
  detach: boolean;
};

type DelegateResult = { record: RunRecord; code: number };

type AgentInfo = {
  agent_status?: string;
  agent_session?: { value?: string };
};

type PaneInfo = {
  workspace_id?: string;
  tab_id?: string;
  pane_id?: string;
  agent?: string | null;
  agent_status?: string;
  agent_session?: { value?: string };
};

type TabInfo = { tab_id: string; label?: string; agent_status?: string };

type HerdrResult = {
  pane?: PaneInfo;
  panes?: PaneInfo[];
  tab?: { tab_id: string };
  tabs?: TabInfo[];
  root_pane?: { pane_id: string };
  agent?: AgentInfo;
  agent_status?: string;
  status?: string;
};

class HerdrCommandError extends Error {
  constructor(readonly commandCode: string, message: string) {
    super(message);
  }
}

async function execute(
  record: RunRecord,
  deps: HerdrDeps,
  args: string[],
  signal?: AbortSignal,
): Promise<ExecResult> {
  return await deps.exec(deps.env.HERDR_BIN_PATH ?? "herdr", args, {
    cwd: record.cwd,
    env: deps.env,
    signal,
  });
}

function parseError(stderr: string): { code: string; message: string } {
  try {
    const parsed = JSON.parse(stderr) as {
      error?: { code?: string; message?: string };
    };
    return {
      code: parsed.error?.code ?? "herdr_failed",
      message: parsed.error?.message ?? (stderr.trim() || "Herdr 명령 실패"),
    };
  } catch {
    return {
      code: "herdr_failed",
      message: stderr.trim() || "Herdr 명령 실패",
    };
  }
}

async function json(
  record: RunRecord,
  deps: HerdrDeps,
  args: string[],
  signal?: AbortSignal,
): Promise<HerdrResult> {
  const output = await execute(record, deps, args, signal);
  if (output.code !== 0) {
    const error = parseError(output.stderr);
    throw new HerdrCommandError(error.code, error.message);
  }
  try {
    return (JSON.parse(output.stdout) as { result?: HerdrResult }).result ?? {};
  } catch {
    throw new HerdrCommandError(
      "invalid_response",
      "Herdr JSON 응답 파싱 실패",
    );
  }
}

function statusOf(result: HerdrResult): string {
  return result.agent?.agent_status ?? result.agent_status ?? result.status ??
    "unknown";
}

async function readAgent(record: RunRecord, deps: HerdrDeps): Promise<string> {
  const name = record.herdr?.agentName;
  if (name == null) return "";
  const recent = await execute(record, deps, [
    "agent",
    "read",
    name,
    "--source",
    "recent-unwrapped",
    "--lines",
    "200",
  ]);
  if (recent.code === 0) return recent.stdout;
  return (await execute(record, deps, [
    "agent",
    "read",
    name,
    "--source",
    "visible",
    "--lines",
    "200",
  ])).stdout;
}

async function updateSession(
  record: RunRecord,
  deps: HerdrDeps,
): Promise<void> {
  const name = record.herdr?.agentName;
  if (name == null) return;
  const result = await json(record, deps, ["agent", "get", name]);
  record.nativeSessionId = result.agent?.agent_session?.value;
}

async function completeAgent(
  record: RunRecord,
  deps: HerdrDeps,
  sessionId?: string,
): Promise<void> {
  const output = await readAgent(record, deps);
  await writeLogs(deps.stateDir, record.runId, output, "");
  if (sessionId == null) await updateSession(record, deps);
  else record.nativeSessionId = sessionId;
  record.status = "done";
  record.finishedAt = deps.now().toISOString();
  delete record.error;
  await writeRun(deps.stateDir, record);
}

async function maybeCloseTab(
  record: RunRecord,
  deps: HerdrDeps,
  keep: boolean,
  ignoredPaneId?: string,
): Promise<boolean> {
  if (keep || record.herdr == null) return false;
  const { tabId, workspaceId } = record.herdr;
  const records = await listRuns(deps.stateDir);
  const ownsTab = records.some((candidate) =>
    candidate.herdr?.tabId === tabId && candidate.herdr.createdTab
  );
  const hasActiveRecord = records.some((candidate) =>
    candidate.runId !== record.runId && candidate.herdr?.tabId === tabId &&
    ["working", "blocked", "timed_out"].includes(candidate.status)
  );
  if (!ownsTab || hasActiveRecord) return false;
  const result = await json(record, deps, [
    "pane",
    "list",
    "--workspace",
    workspaceId,
  ]);
  const hasActivePane = (result.panes ?? []).some((pane) =>
    pane.tab_id === tabId && pane.pane_id !== ignoredPaneId &&
    ["working", "blocked"].includes(pane.agent_status ?? "")
  );
  if (hasActivePane) return false;
  await json(record, deps, ["tab", "close", tabId]);
  return true;
}

async function settleHerdrError(
  record: RunRecord,
  deps: HerdrDeps,
  error: unknown,
  override: { commandCode?: string; exitCode?: number } = {},
): Promise<DelegateResult> {
  if (deps.signal.aborted) {
    record.status = "working";
    delete record.error;
    delete record.finishedAt;
    await writeRun(deps.stateDir, record);
    return { record, code: 130 };
  }
  const commandCode = override.commandCode ??
    (error instanceof HerdrCommandError ? error.commandCode : "herdr_failed");
  record.status = ["agent_blocked", "ambiguous_delegate_tab"].includes(
      commandCode,
    )
    ? "blocked"
    : ["agent_prompt_stalled", "timeout"].includes(commandCode)
    ? "timed_out"
    : "failed";
  record.error = {
    code: record.status === "timed_out" ? "timeout" : commandCode,
    message: error instanceof Error ? error.message : String(error),
  };
  if (record.status === "failed") {
    record.finishedAt = deps.now().toISOString();
  } else {
    delete record.finishedAt;
  }
  await writeRun(deps.stateDir, record);
  return { record, code: override.exitCode ?? runExitCode(record.status) };
}

async function cleanupCompletedRun(
  record: RunRecord,
  deps: HerdrDeps,
): Promise<void> {
  try {
    await maybeCloseTab(record, deps, record.keep ?? false);
  } catch (error) {
    record.error = {
      code: "tab_close_failed",
      message: error instanceof Error ? error.message : String(error),
    };
    await writeRun(deps.stateDir, record);
  }
}

async function allocatePane(
  record: RunRecord,
  deps: HerdrDeps,
  workspaceId: string,
  currentTabId: string,
  callerId: string,
): Promise<{ tabId: string; paneId: string; createdTab: boolean }> {
  const listed = await json(record, deps, [
    "tab",
    "list",
    "--workspace",
    workspaceId,
  ]);
  const candidates = (listed.tabs ?? []).filter((tab) =>
    tab.label === callerId && tab.tab_id !== currentTabId
  );
  if (candidates.length > 1) {
    throw new HerdrCommandError(
      "ambiguous_delegate_tab",
      `위임 탭 후보 복수: ${candidates.map((tab) => tab.tab_id).join(", ")}`,
    );
  }
  if (candidates.length === 0) {
    const created = await json(record, deps, [
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      record.cwd,
      "--label",
      callerId,
      "--no-focus",
    ]);
    if (created.tab == null || created.root_pane == null) {
      throw new HerdrCommandError(
        "invalid_response",
        "Herdr 탭 생성 응답 누락",
      );
    }
    return {
      tabId: created.tab.tab_id,
      paneId: created.root_pane.pane_id,
      createdTab: true,
    };
  }

  const tabId = candidates[0]?.tab_id;
  if (tabId == null) {
    throw new HerdrCommandError("invalid_response", "탭 ID 누락");
  }
  const listedPanes = await json(record, deps, [
    "pane",
    "list",
    "--workspace",
    workspaceId,
  ]);
  const panes = (listedPanes.panes ?? []).filter((pane) =>
    pane.tab_id === tabId
  );
  const available = panes.find((pane) => pane.agent == null);
  if (available?.pane_id != null) {
    return { tabId, paneId: available.pane_id, createdTab: false };
  }
  const lastPaneId = panes.at(-1)?.pane_id;
  if (lastPaneId == null) throw new Error(`위임 탭에 pane 없음: ${tabId}`);
  const split = await json(record, deps, [
    "pane",
    "split",
    "--pane",
    lastPaneId,
    "--direction",
    "right",
    "--cwd",
    record.cwd,
    "--no-focus",
  ]);
  if (split.pane?.pane_id == null) {
    throw new HerdrCommandError(
      "invalid_response",
      "Herdr pane 분할 응답 누락",
    );
  }
  return { tabId, paneId: split.pane.pane_id, createdTab: false };
}

async function promptAndCollect(
  record: RunRecord,
  invocation: NativeInvocation,
  deps: HerdrDeps,
  options: HerdrOptions,
): Promise<DelegateResult> {
  const agentName = record.herdr?.agentName;
  if (agentName == null) {
    return settleHerdrError(
      record,
      deps,
      new HerdrCommandError("invalid_response", "Herdr agent 이름 누락"),
    );
  }
  record.status = "working";
  delete record.error;
  delete record.finishedAt;
  await writeRun(deps.stateDir, record);
  try {
    const prompted = await json(record, deps, [
      "agent",
      "prompt",
      agentName,
      invocation.prompt,
      "--wait",
      ...(options.detach ? ["--until", "working"] : []),
      "--timeout",
      String(options.detach ? 5_000 : record.timeoutMs),
    ], deps.signal);
    const status = statusOf(prompted);
    if (options.detach && status === "working") return { record, code: 0 };
    if (status === "blocked") {
      return settleHerdrError(
        record,
        deps,
        new HerdrCommandError("agent_blocked", "에이전트 응답 필요"),
      );
    }
    if (status !== "done" && status !== "idle") {
      throw new HerdrCommandError(
        "agent_unknown",
        `알 수 없는 상태: ${status}`,
      );
    }
    await completeAgent(record, deps);
    await cleanupCompletedRun(record, deps);
    return { record, code: 0 };
  } catch (error) {
    return settleHerdrError(record, deps, error);
  }
}

export async function startHerdr(
  record: RunRecord,
  invocation: NativeInvocation,
  deps: HerdrDeps,
  options: HerdrOptions,
): Promise<DelegateResult> {
  let current: HerdrResult;
  try {
    current = await json(record, deps, ["pane", "current", "--current"]);
  } catch (error) {
    return settleHerdrError(record, deps, error, {
      commandCode: "transport_unavailable",
      exitCode: 3,
    });
  }

  try {
    const workspaceId = current.pane?.workspace_id;
    const currentTabId = current.pane?.tab_id;
    const callerId = options.callerId ?? current.pane?.agent_session?.value;
    if (workspaceId == null || currentTabId == null) {
      throw new HerdrCommandError(
        "invalid_response",
        "현재 Herdr pane 정보 누락",
      );
    }
    if (callerId == null || callerId === "") {
      throw new HerdrCommandError(
        "invalid_response",
        "Herdr 전송에는 --caller-id가 필요합니다",
      );
    }
    const allocated = await allocatePane(
      record,
      deps,
      workspaceId,
      currentTabId,
      callerId,
    );
    const agentName = `dlg-${record.runId.slice(-8).toLowerCase()}`;
    record.callerId = callerId;
    record.herdr = { workspaceId, agentName, ...allocated };
    await writeRun(deps.stateDir, record);
    await json(record, deps, [
      "agent",
      "start",
      agentName,
      "--kind",
      record.agent,
      "--pane",
      allocated.paneId,
      "--timeout",
      "30000",
      "--",
      ...invocation.herdrArgs,
    ]);
    return promptAndCollect(record, invocation, deps, options);
  } catch (error) {
    return settleHerdrError(record, deps, error);
  }
}

export async function resumeHerdr(
  record: RunRecord,
  parent: RunRecord,
  invocation: NativeInvocation,
  deps: HerdrDeps,
  options: HerdrOptions,
): Promise<DelegateResult> {
  if (parent.herdr == null) {
    return startHerdr(record, invocation, deps, options);
  }
  record.herdr = { ...parent.herdr, createdTab: false };
  try {
    await json(parent, deps, ["agent", "get", parent.herdr.agentName]);
  } catch (error) {
    if (
      error instanceof HerdrCommandError &&
      error.commandCode === "agent_not_found"
    ) {
      if (parent.nativeSessionId == null) {
        return settleHerdrError(
          record,
          deps,
          new HerdrCommandError(
            "session_unavailable",
            `재개할 세션 ID 없음: ${parent.runId}`,
          ),
          { exitCode: 2 },
        );
      }
      return startHerdr(record, invocation, deps, options);
    }
    return settleHerdrError(record, deps, error);
  }
  return promptAndCollect(record, invocation, deps, options);
}

export async function refreshHerdr(
  record: RunRecord,
  deps: HerdrDeps,
): Promise<DelegateResult> {
  if (
    record.herdr == null ||
    !["working", "timed_out", "blocked"].includes(record.status)
  ) return { record, code: runExitCode(record.status) };
  try {
    const result = await json(record, deps, [
      "agent",
      "get",
      record.herdr.agentName,
    ]);
    const status = statusOf(result);
    if (status === "done" || status === "idle") {
      await completeAgent(record, deps, result.agent?.agent_session?.value);
      return { record, code: 0 };
    }
    if (status === "working" || status === "blocked") {
      record.status = status;
      if (status === "blocked") {
        record.error = { code: "agent_blocked", message: "에이전트 응답 필요" };
      } else {
        delete record.error;
      }
    } else {
      record.error = {
        code: "agent_unknown",
        message: `알 수 없는 상태: ${status}`,
      };
      delete record.finishedAt;
      await writeRun(deps.stateDir, record);
      return { record, code: 5 };
    }
    await writeRun(deps.stateDir, record);
    return { record, code: runExitCode(record.status) };
  } catch (error) {
    const lost = error instanceof HerdrCommandError &&
      error.commandCode === "agent_not_found";
    if (lost) {
      return settleHerdrError(record, deps, error, {
        commandCode: "agent_lost",
      });
    }
    record.error = {
      code: error instanceof HerdrCommandError
        ? error.commandCode
        : "herdr_failed",
      message: error instanceof Error ? error.message : String(error),
    };
    delete record.finishedAt;
    await writeRun(deps.stateDir, record);
    return { record, code: 5 };
  }
}

export async function waitHerdr(
  record: RunRecord,
  deps: HerdrDeps,
  timeoutMs: number,
): Promise<DelegateResult> {
  const refreshed = await refreshHerdr(record, deps);
  if (refreshed.code !== 0) return refreshed;
  if (record.status !== "working") {
    if (record.status === "done") await cleanupCompletedRun(record, deps);
    return { record, code: runExitCode(record.status) };
  }
  try {
    const result = await json(record, deps, [
      "agent",
      "wait",
      record.herdr?.agentName ?? "",
      "--timeout",
      String(timeoutMs),
    ], deps.signal);
    const status = statusOf(result);
    if (status === "done" || status === "idle") {
      await completeAgent(record, deps, result.agent?.agent_session?.value);
      await cleanupCompletedRun(record, deps);
      return { record, code: 0 };
    }
    record.status = status === "blocked" ? "blocked" : "working";
    if (record.status === "blocked") {
      record.error = { code: "agent_blocked", message: "에이전트 응답 필요" };
    } else {
      delete record.error;
    }
    await writeRun(deps.stateDir, record);
    return { record, code: status === "blocked" ? 4 : 0 };
  } catch (error) {
    return settleHerdrError(record, deps, error);
  }
}

export async function closeHerdr(
  record: RunRecord,
  deps: HerdrDeps,
): Promise<DelegateResult> {
  const wasWorking = record.status === "working";
  await refreshHerdr(record, deps);
  try {
    const closed = await maybeCloseTab(
      record,
      deps,
      false,
      record.herdr?.paneId,
    );
    if (!closed && record.herdr != null) {
      throw new HerdrCommandError(
        "tab_close_failed",
        "다른 활성 실행 또는 pane 때문에 Herdr 탭을 닫지 못했습니다",
      );
    }
  } catch (error) {
    record.error = {
      code: "tab_close_failed",
      message: error instanceof Error ? error.message : String(error),
    };
    await writeRun(deps.stateDir, record);
    return { record, code: 5 };
  }
  if (wasWorking && record.status === "working") {
    record.status = "cancelled";
    record.error = { code: "cancelled", message: "Herdr 탭 닫힘" };
    record.finishedAt = deps.now().toISOString();
    await writeRun(deps.stateDir, record);
  }
  return { record, code: 0 };
}
