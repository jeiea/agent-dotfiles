import { isAbsolute } from "jsr:@std/path@^1";
import type {
  Blocker,
  DelegateDocument,
  PublicActivity,
  RetryRecord,
} from "./document.ts";
import {
  copyDelegateError,
  DelegateError,
  normalizeError,
} from "./document.ts";
import {
  captureBaseline,
  cursorEquals,
  findNativeSession,
  identifyPromptSession,
  latestHumanOffset,
  refreshNativeSession,
  resultAfter,
  type SharedSession,
} from "./native_session.ts";
import type { Exec, ExecResult } from "./process.ts";
import type { Agent, NativeInvocation } from "./select.ts";

export type HerdrDeps = {
  exec: Exec;
  env: Record<string, string>;
  signal: AbortSignal;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

export type HerdrPrompt = {
  invocation: NativeInvocation;
  cwd: string;
  snapshot?: SharedSession;
  callerId?: string;
  name?: string;
  timeoutMs: number;
  startOptionsSpecified: boolean;
  writeResume: boolean;
  confirmEscalation: boolean;
};

type HerdrResult = Record<string, unknown>;

type LiveAgent = {
  name: string;
  kind?: Agent;
  cwd?: string;
  status: string;
  sequence?: string;
  sessionId?: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
};

type ManagedPane = LiveAgent & {
  workspaceId: string;
  tabId: string;
  paneId: string;
  callerId: string;
};

type CleanupWarning = NonNullable<DelegateDocument["warnings"]>[number];

const paneLockWaitMs = 60_000;

export async function promptHerdr(
  request: HerdrPrompt,
  deps: HerdrDeps,
): Promise<DelegateDocument> {
  const deadline = deps.now() + request.timeoutMs;
  const expected = request.snapshot;
  let retry: RetryRecord | undefined;
  let live = expected == null ? undefined : await findLiveAgent(expected, deps);
  if (
    live != null && expected != null &&
    hasLiveOptionConflict(request, expected.agent)
  ) {
    throw new DelegateError(
      "live_option_conflict",
      "live session에는 시작 전용 옵션을 적용할 수 없습니다",
    );
  }
  if (
    live == null && expected != null && request.writeResume &&
    !request.confirmEscalation
  ) {
    throw new DelegateError(
      "permission_escalation",
      "stopped session의 write 재개에는 --confirm-escalation이 필요합니다",
    );
  }
  const callerId = await withSessionError(
    resolveCallerId(
      request.callerId,
      deps,
      expected?.cwd ?? request.cwd,
      live == null,
    ),
    expected?.sessionId,
  );
  try {
    let baseline: Awaited<ReturnType<typeof captureBaseline>>;
    if (live == null) {
      if (callerId == null) {
        throw new DelegateError(
          "caller_session_unavailable",
          "Herdr 신규 session의 caller ID를 확인할 수 없습니다",
        );
      }
      const started = await withPaneLock(
        { deadline, deps, sessionId: expected?.sessionId },
        async () => {
          const concurrent = expected == null
            ? undefined
            : await findLiveAgent(expected, deps);
          if (concurrent != null) {
            throw new DelegateError(
              "live_session_ambiguous",
              "session이 다른 호출에서 재개되었습니다",
              undefined,
              expected?.sessionId,
            );
          }
          const agentStart = await withSessionError(
            startAgent(request, callerId, deps),
            expected?.sessionId,
          );
          try {
            const submitted = await submitPrompt(
              request,
              agentStart.live,
              deps,
            );
            return { ...submitted, retry: agentStart.retry };
          } catch (error) {
            throw copyDelegateError(normalizeError(error), {
              retry: agentStart.retry,
            });
          }
        },
      );
      live = started.live;
      baseline = started.baseline;
      retry = started.retry;
    } else {
      const submitted = await submitPrompt(request, live, deps);
      live = submitted.live;
      baseline = submitted.baseline;
    }
    const snapshot = await waitForPrompt(
      request,
      baseline,
      live,
      deadline,
      deps,
    );
    const deterministic = deterministicName(snapshot.sessionId);
    if (live.name !== deterministic) {
      try {
        await withSessionError(
          json(snapshot.cwd, deps, [
            "agent",
            "rename",
            live.name,
            deterministic,
          ]),
          snapshot.sessionId,
        );
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "cancelled" || normalized.code === "timeout") {
          throw normalized;
        }
        throw new DelegateError(
          "live_session_ambiguous",
          normalized.message,
          undefined,
          normalized.sessionId,
          normalized.retry,
        );
      }
      live.name = deterministic;
    }
    live.sessionId = snapshot.sessionId;
    live.kind = snapshot.agent;
    live.cwd = snapshot.cwd;

    const offset = baseline.get(snapshot.path)?.byteLength ?? 0;
    const settled = await waitForQuiescence(snapshot, live, deadline, deps);
    if (settled.snapshot.agent === "codex" && request.name != null) {
      await renameCodex(
        live,
        callerId,
        request.name,
        settled.snapshot.cwd,
        deps,
      );
    }
    const warnings = await cleanupAutomatically(
      live,
      callerId,
      settled.snapshot.cwd,
      deadline,
      deps,
    );
    return document(
      settled.snapshot,
      "quiescent",
      resultAfter(settled.snapshot, offset),
      warnings,
      retry,
    );
  } catch (error) {
    const normalized = normalizeError(error);
    throw copyDelegateError(normalized, {
      sessionId: normalized.sessionId ?? expected?.sessionId,
      retry: normalized.retry ?? retry,
    });
  }
}

export async function statusHerdr(
  snapshot: SharedSession,
  deps: HerdrDeps,
): Promise<DelegateDocument> {
  const live = await findLiveAgent(snapshot, deps);
  return document(
    snapshot,
    live == null ? "not_live" : activityOf(live.status),
  );
}

export async function waitHerdr(
  snapshot: SharedSession,
  options: {
    timeoutMs: number;
    callerId?: string;
    name?: string;
  },
  deps: HerdrDeps,
): Promise<DelegateDocument> {
  if (snapshot.agent === "claude" && options.name != null) {
    throw new DelegateError(
      "usage",
      "Claude wait에는 --name을 사용할 수 없습니다",
    );
  }
  const live = await findLiveAgent(snapshot, deps);
  if (live == null) return document(snapshot, "not_live");
  const deadline = deps.now() + options.timeoutMs;
  const offset = latestHumanOffset(snapshot);
  const settled = await waitForQuiescence(snapshot, live, deadline, deps);
  const callerId = await withSessionError(
    resolveCallerId(options.callerId, deps, snapshot.cwd),
    snapshot.sessionId,
  );
  if (snapshot.agent === "codex" && options.name != null) {
    await renameCodex(live, callerId, options.name, snapshot.cwd, deps);
  }
  const warnings = await cleanupAutomatically(
    live,
    callerId,
    settled.snapshot.cwd,
    deadline,
    deps,
  );
  return document(
    settled.snapshot,
    "quiescent",
    resultAfter(settled.snapshot, offset),
    warnings,
  );
}

export async function closeHerdr(
  snapshot: SharedSession,
  callerId: string | undefined,
  deps: HerdrDeps,
): Promise<DelegateDocument> {
  const live = await findLiveAgent(snapshot, deps);
  if (
    live == null || live.tabId == null || live.paneId == null ||
    live.workspaceId == null
  ) {
    return document(snapshot, "not_live");
  }
  const owner = await withSessionError(
    resolveCallerId(callerId, deps, snapshot.cwd),
    snapshot.sessionId,
  );
  const label = await tabLabel(live, snapshot.cwd, deps);
  if (owner == null || label !== owner) {
    throw new DelegateError(
      "unmanaged_tab",
      "탭 이름이 현재 caller ID와 다릅니다. 이름을 복구한 뒤 다시 close하세요",
    );
  }
  if (["working", "blocked", "unknown"].includes(live.status)) {
    await json(snapshot.cwd, deps, [
      "agent",
      "send-keys",
      live.name,
      "ctrl+c",
    ]);
    try {
      await getAgent(live, snapshot.cwd, deps);
    } catch {
      // 취소 직후 agent가 사라지는 것은 정상적인 정리 경로다.
    }
  }
  const { workspaceId, tabId, paneId } = live;
  await withPaneLock(
    {
      deadline: deps.now() + paneLockWaitMs,
      deps,
      sessionId: snapshot.sessionId,
    },
    async () => {
      const panes = await listPanes(workspaceId, snapshot.cwd, deps);
      const blockers = blockersInTab(panes, tabId, paneId);
      await closePane(paneId, snapshot.cwd, deps);
      if (blockers.length > 0) {
        throw new DelegateError(
          "tab_close_blocked",
          "다른 active pane이 남아 탭을 닫지 않았습니다",
          blockers,
        );
      }
      await closeTab(tabId, snapshot.cwd, deps);
    },
  );
  return document(snapshot, "not_live");
}

async function submitPrompt(
  request: HerdrPrompt,
  live: LiveAgent,
  deps: HerdrDeps,
): Promise<{
  baseline: Awaited<ReturnType<typeof captureBaseline>>;
  live: LiveAgent;
}> {
  const baseline = await captureBaseline(deps.env, request.invocation.agent);
  const prompted = await withSessionError(
    json(live.cwd ?? request.snapshot?.cwd ?? request.cwd, deps, [
      "agent",
      "prompt",
      live.name,
      request.invocation.prompt,
    ]),
    request.snapshot?.sessionId,
  );
  const promptedAgent = objectValue(prompted.agent);
  return {
    baseline,
    live: Object.keys(promptedAgent).length === 0
      ? live
      : { ...live, ...liveFrom(promptedAgent, live.name) },
  };
}

async function withPaneLock<T>(
  options: {
    deadline: number;
    deps: HerdrDeps;
    sessionId?: string;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const { deadline, deps, sessionId } = options;
  const socketPath = deps.env.HERDR_SOCKET_PATH;
  if (socketPath == null || socketPath === "" || !isAbsolute(socketPath)) {
    throw new DelegateError(
      "transport_unavailable",
      "Herdr의 절대 socket 경로를 확인할 수 없습니다",
      undefined,
      sessionId,
    );
  }
  let file: Deno.FsFile;
  try {
    file = await Deno.open(`${socketPath}.delegate-pane.lock`, {
      create: true,
      read: true,
      write: true,
    });
  } catch (error) {
    throw new DelegateError(
      "herdr_failed",
      error instanceof Error ? error.message : String(error),
      undefined,
      sessionId,
    );
  }
  try {
    while (!await file.tryLock(true)) {
      ensureTime(deadline, deps, sessionId);
      await pause(Math.min(50, remaining(deadline, deps)), deps, sessionId);
    }
    try {
      return await operation();
    } finally {
      try {
        await file.unlock();
      } catch {
        // close도 잠금을 해제하므로 주 작업 결과를 unlock 진단으로 덮지 않는다.
      }
    }
  } finally {
    file.close();
  }
}

async function startAgent(
  request: HerdrPrompt,
  callerId: string,
  deps: HerdrDeps,
): Promise<{ live: ManagedPane; retry?: RetryRecord }> {
  const cwd = request.snapshot?.cwd ?? request.cwd;
  const { created, ...pane } = await allocatePane(
    cwd,
    callerId,
    request.snapshot?.sessionId,
    deps,
  );
  const name = request.snapshot == null
    ? `dlg-tmp-${crypto.randomUUID().slice(0, 8)}`
    : deterministicName(request.snapshot.sessionId);
  const herdrArgs = request.invocation.agent === "claude"
    ? [
      ...request.invocation.herdrArgs.filter((arg) =>
        !arg.startsWith("--name=")
      ),
      `--name=${
        [callerId, request.name].filter((part) => part != null && part !== "")
          .join(" ")
      }`,
    ]
    : request.invocation.herdrArgs;
  const startArgs = [
    "agent",
    "start",
    name,
    "--kind",
    request.invocation.agent,
    "--pane",
    pane.paneId,
    "--timeout",
    "30000",
    "--",
    ...herdrArgs,
  ];
  let retry: RetryRecord | undefined;
  try {
    await json(cwd, deps, startArgs);
  } catch (error) {
    const normalized = normalizeError(error);
    if (
      !created || normalized.code !== "herdr_failed" ||
      normalized.message !==
        `agent target pane ${pane.paneId} is not an available shell`
    ) throw normalized;
    const reason = {
      code: "herdr_failed" as const,
      message: normalized.message,
    };
    try {
      await pause(100, deps, request.snapshot?.sessionId);
      await json(cwd, deps, startArgs);
      retry = { reason, result: "success" };
    } catch (retryError) {
      throw copyDelegateError(normalizeError(retryError), {
        retry: { reason, result: "failed" },
      });
    }
  }
  return {
    live: {
      ...pane,
      name,
      kind: request.invocation.agent,
      cwd,
      status: "unknown",
      sessionId: request.snapshot?.sessionId,
    },
    retry,
  };
}

async function waitForPrompt(
  request: HerdrPrompt,
  baseline: Awaited<ReturnType<typeof captureBaseline>>,
  live: LiveAgent,
  deadline: number,
  deps: HerdrDeps,
): Promise<SharedSession> {
  let confirmedSessionId = request.snapshot?.sessionId;
  while (true) {
    if (confirmedSessionId == null && live.sessionId != null) {
      try {
        const reported = await findNativeSession(live.sessionId, deps.env);
        if (
          reported.agent !== request.invocation.agent ||
          reported.cwd !== (request.snapshot?.cwd ?? request.cwd)
        ) {
          throw new DelegateError(
            "invalid_native_session",
            "Herdr session 정보와 native session metadata가 다릅니다",
          );
        }
        confirmedSessionId = reported.sessionId;
      } catch (error) {
        if (
          !(error instanceof DelegateError &&
            error.code === "session_not_found")
        ) {
          throw error;
        }
      }
    }
    ensureTime(deadline, deps, confirmedSessionId);
    const snapshot = await identifyPromptSession(
      deps.env,
      request.invocation.agent,
      baseline,
      request.invocation.prompt,
      request.snapshot?.sessionId,
      live.sessionId,
    );
    if (snapshot != null) return snapshot;
    await pause(
      Math.min(250, remaining(deadline, deps)),
      deps,
      confirmedSessionId,
    );
  }
}

async function waitForQuiescence(
  initial: SharedSession,
  live: LiveAgent,
  deadline: number,
  deps: HerdrDeps,
): Promise<{ snapshot: SharedSession; live: LiveAgent }> {
  let snapshot = initial;
  while (true) {
    ensureTime(deadline, deps, snapshot.sessionId);
    const waited = await withSessionError(
      json(snapshot.cwd, deps, [
        "agent",
        "wait",
        live.name,
        "--until",
        "idle",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        String(Math.max(1, Math.floor(remaining(deadline, deps)))),
      ], deps.signal),
      snapshot.sessionId,
    );
    const candidate = agentFromResult(waited, live.name);
    if (candidate.status === "blocked") {
      throw new DelegateError(
        "agent_blocked",
        "에이전트가 사용자 입력을 기다립니다",
        undefined,
        snapshot.sessionId,
      );
    }
    if (!["idle", "done"].includes(candidate.status)) {
      await pause(
        Math.min(50, remaining(deadline, deps)),
        deps,
        snapshot.sessionId,
      );
      continue;
    }
    snapshot = await refreshNativeSession(snapshot);
    const sequence = requireSequence(candidate);
    const cursor = snapshot.cursor;
    await pause(
      Math.min(500, remaining(deadline, deps)),
      deps,
      snapshot.sessionId,
    );
    ensureTime(deadline, deps, snapshot.sessionId);
    const checked = await withSessionError(
      getAgent(live, snapshot.cwd, deps),
      snapshot.sessionId,
    );
    if (checked.status === "blocked") {
      throw new DelegateError(
        "agent_blocked",
        "에이전트가 사용자 입력을 기다립니다",
        undefined,
        snapshot.sessionId,
      );
    }
    const refreshed = await refreshNativeSession(snapshot);
    if (
      ["idle", "done"].includes(checked.status) &&
      requireSequence(checked) === sequence &&
      cursorEquals(cursor, refreshed.cursor) && !refreshed.cursor.partial
    ) return { snapshot: refreshed, live: checked };
    snapshot = refreshed;
  }
}

async function findLiveAgent(
  snapshot: SharedSession,
  deps: HerdrDeps,
): Promise<LiveAgent | undefined> {
  let result: HerdrResult;
  try {
    result = await json(snapshot.cwd, deps, ["agent", "list"]);
  } catch (error) {
    if (
      error instanceof DelegateError &&
      (error.code === "cancelled" || error.code === "timeout")
    ) {
      throw new DelegateError(
        error.code,
        error.message,
        error.blockers,
        snapshot.sessionId,
      );
    }
    throw new DelegateError(
      "live_session_ambiguous",
      error instanceof Error ? error.message : String(error),
    );
  }
  const agents = arrayObjects(result.agents);
  const bySession = agents.filter((agent) =>
    sessionOf(agent)?.toLowerCase() === snapshot.sessionId.toLowerCase()
  );
  const deterministic = deterministicName(snapshot.sessionId);
  const byName = agents.filter((agent) => nameOf(agent) === deterministic);
  const candidates = uniqueObjects([...bySession, ...byName]);
  if (candidates.length === 0) return undefined;
  if (candidates.length !== 1) {
    throw new DelegateError(
      "live_session_ambiguous",
      `live agent 후보 복수: ${snapshot.sessionId}`,
    );
  }
  const live = liveFrom(candidates[0]!);
  if (
    live.sessionId != null &&
    live.sessionId.toLowerCase() !== snapshot.sessionId.toLowerCase()
  ) {
    throw new DelegateError(
      "live_session_ambiguous",
      "live agent session ID 불일치",
    );
  }
  if (live.kind != null && live.kind !== snapshot.agent) {
    throw new DelegateError("live_session_ambiguous", "live agent 종류 불일치");
  }
  if (live.cwd != null && live.cwd !== snapshot.cwd) {
    throw new DelegateError("live_session_ambiguous", "live agent cwd 불일치");
  }
  return live;
}

async function getAgent(
  live: LiveAgent,
  cwd: string,
  deps: HerdrDeps,
): Promise<LiveAgent> {
  const result = await json(cwd, deps, ["agent", "get", live.name]);
  return { ...live, ...agentFromResult(result, live.name) };
}

function agentFromResult(result: HerdrResult, fallbackName: string): LiveAgent {
  const nested = objectValue(result.agent);
  return liveFrom(
    Object.keys(nested).length === 0 ? result : nested,
    fallbackName,
  );
}

async function allocatePane(
  cwd: string,
  callerId: string,
  sessionId: string | undefined,
  deps: HerdrDeps,
): Promise<
  Pick<ManagedPane, "workspaceId" | "tabId" | "paneId" | "callerId"> & {
    created: boolean;
  }
> {
  let currentResult: HerdrResult;
  try {
    currentResult = await json(cwd, deps, ["pane", "current", "--current"]);
  } catch (error) {
    if (error instanceof DelegateError && error.code === "herdr_failed") {
      throw new DelegateError("transport_unavailable", error.message);
    }
    throw error;
  }
  const current = objectValue(currentResult.pane);
  const workspaceId = stringValue(current.workspace_id);
  const currentTabId = stringValue(current.tab_id);
  if (workspaceId == null || currentTabId == null) {
    throw new DelegateError("herdr_failed", "현재 Herdr pane 정보가 없습니다");
  }
  const tabs = await listTabs(workspaceId, cwd, deps);
  let candidates = tabs.filter((tab) =>
    tab.label === callerId && tab.tabId !== currentTabId
  );
  if (candidates.length > 1 && sessionId != null) {
    const panes = await listPanes(workspaceId, cwd, deps);
    const target = deterministicName(sessionId);
    const tabIds = new Set(
      panes.filter((pane) => pane.agentName === target).map((pane) =>
        pane.tabId
      ),
    );
    candidates = candidates.filter((tab) => tabIds.has(tab.tabId));
  }
  if (candidates.length > 1) {
    throw new DelegateError(
      "live_session_ambiguous",
      "관리 탭 후보가 복수입니다",
    );
  }
  if (candidates.length === 0) {
    const created = await json(cwd, deps, [
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      cwd,
      "--label",
      callerId,
      "--no-focus",
    ]);
    const tabId = stringValue(objectValue(created.tab).tab_id);
    const paneId = stringValue(objectValue(created.root_pane).pane_id);
    if (tabId == null || paneId == null) {
      throw new DelegateError(
        "herdr_failed",
        "Herdr 탭 생성 응답이 불완전합니다",
      );
    }
    const verified = (await listTabs(workspaceId, cwd, deps)).filter((tab) =>
      tab.label === callerId && tab.tabId === tabId
    );
    if (verified.length !== 1) {
      throw new DelegateError(
        "live_session_ambiguous",
        "생성한 관리 탭 소유권을 확인하지 못했습니다",
      );
    }
    return { workspaceId, tabId, paneId, callerId, created: true };
  }
  const tabId = candidates[0]!.tabId;
  const panes = (await listPanes(workspaceId, cwd, deps)).filter((pane) =>
    pane.tabId === tabId
  );
  const available = panes.find((pane) => pane.agentName == null);
  if (available != null) {
    return {
      workspaceId,
      tabId,
      paneId: available.paneId,
      callerId,
      created: false,
    };
  }
  const anchor = panes.at(-1)?.paneId;
  if (anchor == null) {
    throw new DelegateError("herdr_failed", "관리 탭에 pane이 없습니다");
  }
  const split = await json(cwd, deps, [
    "pane",
    "split",
    "--pane",
    anchor,
    "--direction",
    "right",
    "--cwd",
    cwd,
    "--no-focus",
  ]);
  const paneId = stringValue(objectValue(split.pane).pane_id);
  if (paneId == null) {
    throw new DelegateError("herdr_failed", "pane 분할 응답이 불완전합니다");
  }
  return { workspaceId, tabId, paneId, callerId, created: true };
}

async function cleanupAutomatically(
  live: LiveAgent,
  callerId: string | undefined,
  cwd: string,
  deadline: number,
  deps: HerdrDeps,
): Promise<CleanupWarning[] | undefined> {
  if (live.workspaceId == null || live.tabId == null || live.paneId == null) {
    return [{
      code: "cleanup_failed",
      message: "live pane 위치를 확인하지 못했습니다",
    }];
  }
  const { workspaceId, tabId, paneId } = live;
  try {
    return await withPaneLock(
      { deadline, deps, sessionId: live.sessionId },
      async () => {
        const label = await tabLabel(live, cwd, deps);
        if (callerId == null || label !== callerId) {
          return [{
            code: "unmanaged_tab",
            message: "탭 이름이 caller ID와 달라 자동 정리하지 않았습니다",
          }];
        }
        const panes = await listPanes(workspaceId, cwd, deps);
        const blockers = blockersInTab(panes, tabId, paneId);
        if (blockers.length > 0) {
          return [{
            code: "tab_close_blocked",
            message: "다른 active pane이 있어 자동 정리하지 않았습니다",
            blockers,
          }];
        }
        await closePane(paneId, cwd, deps);
        if (panes.filter((pane) => pane.tabId === tabId).length === 1) {
          try {
            await closeTab(tabId, cwd, deps);
          } catch (error) {
            if (
              !(error instanceof DelegateError &&
                error.code === "cleanup_failed" &&
                error.message === `tab ${tabId} not found`)
            ) throw error;
          }
        }
        return undefined;
      },
    );
  } catch (error) {
    return [{
      code: "cleanup_failed",
      message: error instanceof Error ? error.message : String(error),
    }];
  }
}

async function renameCodex(
  live: LiveAgent,
  callerId: string | undefined,
  name: string,
  cwd: string,
  deps: HerdrDeps,
): Promise<void> {
  const title = [callerId, name].filter((part) => part != null && part !== "")
    .join(" ");
  if (title === "") return;
  try {
    await json(cwd, deps, ["agent", "prompt", live.name, `/rename ${title}`]);
    await deps.sleep(500, deps.signal);
  } catch {
    // Codex local command는 best effort이며 공개 warning을 만들지 않는다.
  }
}

async function resolveCallerId(
  explicit: string | undefined,
  deps: HerdrDeps,
  cwd: string,
  strict = false,
): Promise<string | undefined> {
  if (explicit != null && explicit !== "") return explicit;
  if (deps.env.CODEX_THREAD_ID != null && deps.env.CODEX_THREAD_ID !== "") {
    return deps.env.CODEX_THREAD_ID;
  }
  try {
    const pane = objectValue(
      (await json(cwd, deps, ["pane", "current", "--current"])).pane,
    );
    return stringValue(objectValue(pane.agent_session).value);
  } catch (error) {
    if (
      error instanceof DelegateError &&
      (error.code === "cancelled" || error.code === "timeout")
    ) throw error;
    if (strict) {
      throw new DelegateError(
        "transport_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    return undefined;
  }
}

async function tabLabel(
  live: LiveAgent,
  cwd: string,
  deps: HerdrDeps,
): Promise<string | undefined> {
  if (live.workspaceId == null || live.tabId == null) return undefined;
  return (await listTabs(live.workspaceId, cwd, deps)).find((tab) =>
    tab.tabId === live.tabId
  )?.label;
}

async function listTabs(workspaceId: string, cwd: string, deps: HerdrDeps) {
  return arrayObjects(
    (await json(cwd, deps, [
      "tab",
      "list",
      "--workspace",
      workspaceId,
    ])).tabs,
  ).flatMap((tab) => {
    const tabId = stringValue(tab.tab_id);
    return tabId == null ? [] : [{ tabId, label: stringValue(tab.label) }];
  });
}

async function listPanes(workspaceId: string, cwd: string, deps: HerdrDeps) {
  return arrayObjects(
    (await json(cwd, deps, [
      "pane",
      "list",
      "--workspace",
      workspaceId,
    ])).panes,
  ).flatMap((pane) => {
    const paneId = stringValue(pane.pane_id);
    const tabId = stringValue(pane.tab_id);
    if (paneId == null || tabId == null) return [];
    return [{
      paneId,
      tabId,
      agentName: stringValue(pane.agent) ?? stringValue(pane.agent_name) ??
        null,
      status: stringValue(pane.agent_status) ?? "unknown",
    }];
  });
}

function blockersInTab(
  panes: Awaited<ReturnType<typeof listPanes>>,
  tabId: string,
  targetPaneId: string,
): Blocker[] {
  return panes.filter((pane) =>
    pane.tabId === tabId && pane.paneId !== targetPaneId &&
    (pane.agentName == null ||
      ["working", "blocked", "unknown"].includes(pane.status))
  ).map((pane) => ({
    pane_id: pane.paneId,
    agent_name: pane.agentName,
    status: ["working", "blocked"].includes(pane.status)
      ? pane.status as "working" | "blocked"
      : "unknown",
  }));
}

async function closePane(paneId: string, cwd: string, deps: HerdrDeps) {
  try {
    await json(cwd, deps, ["pane", "close", paneId]);
  } catch (error) {
    throw new DelegateError(
      "cleanup_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function closeTab(tabId: string, cwd: string, deps: HerdrDeps) {
  try {
    await json(cwd, deps, ["tab", "close", tabId]);
  } catch (error) {
    throw new DelegateError(
      "cleanup_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function json(
  cwd: string,
  deps: HerdrDeps,
  args: string[],
  signal = deps.signal,
): Promise<HerdrResult> {
  let output: ExecResult;
  try {
    output = await deps.exec(deps.env.HERDR_BIN_PATH ?? "herdr", args, {
      cwd,
      env: deps.env,
      signal,
    });
  } catch (error) {
    if (deps.signal.aborted) throw cancelled();
    throw new DelegateError(
      "herdr_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (deps.signal.aborted) throw cancelled();
  if (output.code !== 0) {
    const parsed = parseCommandError(output.stderr);
    if (parsed.code === "timeout") {
      throw new DelegateError("timeout", parsed.message);
    }
    if (parsed.code === "agent_blocked") {
      throw new DelegateError("agent_blocked", parsed.message);
    }
    throw new DelegateError("herdr_failed", parsed.message);
  }
  try {
    return objectValue(
      (JSON.parse(output.stdout) as Record<string, unknown>).result,
    );
  } catch {
    throw new DelegateError(
      "herdr_failed",
      "Herdr JSON 응답을 해석할 수 없습니다",
    );
  }
}

function parseCommandError(stderr: string): { code: string; message: string } {
  try {
    const error = objectValue(objectValue(JSON.parse(stderr)).error);
    return {
      code: stringValue(error.code) ?? "herdr_failed",
      message: stringValue(error.message) ?? "Herdr 명령 실패",
    };
  } catch {
    return {
      code: "herdr_failed",
      message: stderr.trim() || "Herdr 명령 실패",
    };
  }
}

function document(
  snapshot: SharedSession,
  activity: PublicActivity,
  result?: string,
  warnings?: CleanupWarning[],
  retry?: RetryRecord,
): DelegateDocument {
  return {
    session_id: snapshot.sessionId,
    agent: snapshot.agent,
    activity,
    completed_turns: snapshot.completedTurns,
    ...(result == null ? {} : { result }),
    ...(warnings == null || warnings.length === 0 ? {} : { warnings }),
    ...(retry == null ? {} : { retry }),
  };
}

function liveFrom(
  value: Record<string, unknown>,
  fallbackName = "",
): LiveAgent {
  const pane = objectValue(value.pane);
  const session = objectValue(value.agent_session);
  const kind = stringValue(value.agent_kind) ?? stringValue(value.kind) ??
    stringValue(value.agent);
  return {
    name: nameOf(value) ?? fallbackName,
    ...(kind === "codex" || kind === "claude" ? { kind } : {}),
    cwd: stringValue(value.cwd),
    status: stringValue(value.agent_status) ?? stringValue(value.status) ??
      "unknown",
    sequence: value.state_change_seq == null
      ? undefined
      : String(value.state_change_seq),
    sessionId: stringValue(session.value),
    workspaceId: stringValue(value.workspace_id) ??
      stringValue(pane.workspace_id),
    tabId: stringValue(value.tab_id) ?? stringValue(pane.tab_id),
    paneId: stringValue(value.pane_id) ?? stringValue(pane.pane_id),
  };
}

function nameOf(value: Record<string, unknown>): string | undefined {
  return stringValue(value.name) ?? stringValue(value.agent_name) ??
    stringValue(value.pane_id);
}

function sessionOf(value: Record<string, unknown>): string | undefined {
  return stringValue(objectValue(value.agent_session).value);
}

function deterministicName(sessionId: string): string {
  return `dlg-${sessionId.replaceAll("-", "").slice(0, 28).toLowerCase()}`;
}

function hasLiveOptionConflict(request: HerdrPrompt, agent: Agent): boolean {
  return request.startOptionsSpecified ||
    (agent === "claude" && request.name != null);
}

function activityOf(status: string): PublicActivity {
  if (status === "working") return "working";
  if (status === "blocked") return "blocked";
  if (status === "idle" || status === "done") return "quiescent";
  return "unknown";
}

function requireSequence(live: LiveAgent): string {
  if (live.sequence == null) {
    throw new DelegateError(
      "herdr_failed",
      "Herdr state_change_seq가 없습니다",
    );
  }
  return live.sequence;
}

function ensureTime(
  deadline: number,
  deps: HerdrDeps,
  sessionId?: string,
): void {
  if (deps.signal.aborted) throw cancelled(sessionId);
  if (remaining(deadline, deps) <= 0) {
    throw new DelegateError(
      "timeout",
      "실행 제한 시간 초과",
      undefined,
      sessionId,
    );
  }
}

function remaining(deadline: number, deps: HerdrDeps): number {
  return deadline - deps.now();
}

async function pause(
  milliseconds: number,
  deps: HerdrDeps,
  sessionId?: string,
): Promise<void> {
  try {
    await deps.sleep(milliseconds, deps.signal);
  } catch (error) {
    if (deps.signal.aborted) throw cancelled(sessionId);
    throw error;
  }
}

async function withSessionError<T>(
  operation: Promise<T>,
  sessionId?: string,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    const normalized = normalizeError(error);
    throw copyDelegateError(normalized, {
      sessionId: normalized.sessionId ?? sessionId,
    });
  }
}

function cancelled(sessionId?: string): DelegateError {
  return new DelegateError(
    "cancelled",
    sessionId == null ? "호출자 중단" : `호출자 중단; session_id=${sessionId}`,
    undefined,
    sessionId,
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function arrayObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function uniqueObjects(values: Record<string, unknown>[]) {
  return [...new Set(values)];
}
