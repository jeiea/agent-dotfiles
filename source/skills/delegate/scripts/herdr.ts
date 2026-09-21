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
  cursorEquals,
  findNativeSession,
  latestHumanBoundary,
  type NativeCursor,
  outcomeAfter,
  type PromptOutcome,
  refreshNativeSession,
  sessionIdPattern,
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

type PromptExecutionDeps = HerdrDeps & {
  callerSignal: AbortSignal;
  timeoutSignal: AbortSignal;
  executionSignal: AbortSignal;
};

export type HerdrPrompt = {
  invocation: NativeInvocation;
  cwd: string;
  snapshot?: SharedSession;
  callerId?: string;
  name?: string;
  timeoutMs: number;
  startOptionsSpecified: boolean;
};

type HerdrResult = Record<string, unknown>;

type LiveAgent = {
  name: string;
  kind?: Agent;
  cwd?: string;
  status: string;
  sequence?: string;
  sessionKind?: string;
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

type PaneOwnership =
  | { kind: "none" }
  | { kind: "pane"; paneId: string }
  | { kind: "tab"; workspaceId: string; paneId: string; tabId: string };

type CleanupWarning = NonNullable<DelegateDocument["warnings"]>[number];

class RetainPaneError extends DelegateError {}
class LiveAgentListError extends DelegateError {}

const paneLockWaitMs = 60_000;
const activityGateMs = 30_000;
const identityPollMs = 5_000;
const recoveryMs = 500;

export async function promptHerdr(
  request: HerdrPrompt,
  deps: HerdrDeps,
): Promise<DelegateDocument> {
  const executionDeps = promptExecutionDeps(deps, request.timeoutMs);
  const deadline = executionDeps.now() + request.timeoutMs;
  const expected = request.snapshot;
  const expectedSessionId = expected?.sessionId;
  const assignedSessionId = expected == null &&
      request.invocation.agent === "claude"
    ? crypto.randomUUID()
    : undefined;
  const knownSessionId = expectedSessionId ?? assignedSessionId;
  let confirmedSessionId = knownSessionId;
  let retry: RetryRecord | undefined;
  let live = expected == null
    ? undefined
    : await findLiveAgent(expected, executionDeps);
  if (
    live != null && expected != null &&
    hasLiveOptionConflict(request, expected.agent)
  ) {
    throw new DelegateError(
      "live_option_conflict",
      "live session에는 시작 전용 옵션을 적용할 수 없습니다",
    );
  }
  const callerId = await withSessionError(
    resolveCallerId(
      request.callerId,
      executionDeps,
      expected?.cwd ?? request.cwd,
      live == null,
    ),
    expected?.sessionId,
  );
  try {
    let snapshot: SharedSession;
    let boundaryCursor: NativeCursor | undefined;
    if (live == null) {
      if (callerId == null) {
        throw new DelegateError(
          "caller_session_unavailable",
          "Herdr 신규 session의 caller ID를 확인할 수 없습니다",
        );
      }
      const started = await withPaneLock(
        { deadline, deps: executionDeps, sessionId: knownSessionId },
        async () => {
          const concurrent = expected == null
            ? undefined
            : await findLiveAgent(expected, executionDeps);
          if (concurrent != null) {
            throw new DelegateError(
              "live_session_ambiguous",
              "session이 다른 호출에서 재개되었습니다",
              undefined,
              expected?.sessionId,
            );
          }
          let ownership: PaneOwnership = { kind: "none" };
          let ownedCwd = expected?.cwd ?? request.cwd;
          let startRetry: RetryRecord | undefined;
          try {
            const agentStart = await withSessionError(
              startAgent(
                request,
                callerId,
                assignedSessionId,
                deadline,
                executionDeps,
                (allocated, cwd) => {
                  ownership = allocated;
                  ownedCwd = cwd;
                },
              ),
              knownSessionId,
            );
            startRetry = agentStart.retry;
            const submitted = await submitPromptOnly(
              request,
              agentStart.live,
              "started",
              knownSessionId,
              deadline,
              executionDeps,
            );
            return {
              ...submitted,
              ownership,
              ownedCwd,
              retry: agentStart.retry,
            };
          } catch (error) {
            const retainPane = error instanceof RetainPaneError;
            const preserved = copyDelegateError(normalizeError(error), {
              retry: startRetry,
            });
            if (!retainPane && preserved.code !== "agent_blocked") {
              await recoverOwnedPane(ownership, ownedCwd, deps).catch(() => {});
            }
            throw preserved;
          }
        },
      );
      let submitted: Awaited<ReturnType<typeof identifySubmittedPrompt>>;
      try {
        submitted = await identifySubmittedPrompt(
          request,
          started,
          knownSessionId,
          deadline,
          executionDeps,
        );
      } catch (error) {
        const retainPane = error instanceof RetainPaneError ||
          started.deliveryUncertain;
        const preserved = copyDelegateError(normalizeError(error), {
          retry: started.retry,
        });
        if (!retainPane && preserved.code !== "agent_blocked") {
          await recoverOwnedPane(
            started.ownership,
            started.ownedCwd,
            deps,
          ).catch(() => {});
        }
        throw preserved;
      }
      live = submitted.live;
      snapshot = submitted.snapshot;
      boundaryCursor = submitted.boundaryCursor;
      retry = started.retry;
    } else {
      const submitted = await submitAndIdentify(
        request,
        live,
        "existing",
        knownSessionId,
        deadline,
        executionDeps,
      );
      live = submitted.live;
      snapshot = submitted.snapshot;
      boundaryCursor = submitted.boundaryCursor;
    }
    confirmedSessionId = snapshot.sessionId;
    const deterministic = deterministicName(snapshot.sessionId);
    if (live.name !== deterministic) {
      try {
        await withSessionError(
          json(snapshot.cwd, executionDeps, [
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

    const settled = await waitForQuiescence(
      snapshot,
      live,
      deadline,
      executionDeps,
    );
    const offset = boundaryCursor != null &&
        boundaryCursor.path === settled.snapshot.cursor.path &&
        boundaryCursor.identity === settled.snapshot.cursor.identity
      ? boundaryCursor.byteLength
      : 0;
    if (settled.snapshot.agent === "codex" && request.name != null) {
      await renameCodex(
        live,
        callerId,
        request.name,
        settled.snapshot.cwd,
        executionDeps,
      );
    }
    const warnings = await cleanupAutomatically(
      live,
      callerId,
      settled.snapshot.cwd,
      deadline,
      executionDeps,
    );
    return document(
      settled.snapshot,
      "quiescent",
      {
        outcome: outcomeAfter(settled.snapshot, {
          offset,
          excludeInitialTurn: true,
        }),
        warnings,
        retry,
      },
    );
  } catch (error) {
    const normalized = normalizeError(error);
    throw copyDelegateError(normalized, {
      sessionId: normalized.sessionId ?? confirmedSessionId,
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
  const boundaryCursor = snapshot.cursor;
  const boundary = latestHumanBoundary(snapshot);
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
    {
      outcome: outcomeAfter(settled.snapshot, {
        ...boundary,
        offset: boundaryCursor.path === settled.snapshot.cursor.path &&
            boundaryCursor.identity === settled.snapshot.cursor.identity
          ? boundary.offset
          : 0,
      }),
      warnings,
    },
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
      await getAgent(live, snapshot.cwd, deps, snapshot.sessionId);
    } catch (error) {
      if (
        error instanceof DelegateError &&
        ["session_id_changed", "invalid_native_session"].includes(error.code)
      ) throw error;
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
  origin: "started" | "existing",
  deadline: number,
  deps: HerdrDeps,
): Promise<{ live: LiveAgent; deliveryUncertain: boolean }> {
  ensureTime(deadline, deps, request.snapshot?.sessionId);
  if (origin === "existing" && live.status === "blocked") {
    throw new DelegateError(
      "agent_blocked",
      "에이전트가 사용자 입력을 기다립니다",
      undefined,
      live.sessionId ?? request.snapshot?.sessionId,
    );
  }
  const activityGate = origin === "started" ||
    ["idle", "done"].includes(live.status);
  let prompted: HerdrResult;
  try {
    prompted = await withSessionError(
      json(live.cwd ?? request.snapshot?.cwd ?? request.cwd, deps, [
        "agent",
        "prompt",
        live.name,
        request.invocation.prompt,
        ...(activityGate
          ? [
            "--wait",
            "--until",
            "working",
            "--until",
            "blocked",
            "--timeout",
            String(
              Math.max(
                1,
                Math.floor(
                  Math.min(activityGateMs, remaining(deadline, deps)),
                ),
              ),
            ),
          ]
          : []),
      ]),
      request.snapshot?.sessionId,
    );
  } catch (error) {
    const normalized = normalizeError(error);
    if (origin === "started" && normalized.code === "timeout") {
      return { live, deliveryUncertain: true };
    }
    if (normalized.code !== "agent_blocked") throw normalized;
    return {
      live: { ...live, status: "blocked" },
      deliveryUncertain: false,
    };
  }
  const promptedAgent = objectValue(prompted.agent);
  const result = Object.keys(promptedAgent).length === 0
    ? live
    : mergeReportedLive(live, liveFrom(promptedAgent, live.name));
  return { live: result, deliveryUncertain: false };
}

type SubmittedPrompt = {
  live: LiveAgent;
  boundaryCursor?: NativeCursor;
  awaitNewTurn: boolean;
  deliveryUncertain: boolean;
};

async function submitPromptOnly(
  request: HerdrPrompt,
  live: LiveAgent,
  origin: "started" | "existing",
  knownSessionId: string | undefined,
  deadline: number,
  deps: HerdrDeps,
): Promise<SubmittedPrompt> {
  readReportedSessionId(live, knownSessionId);
  const before = request.snapshot == null
    ? undefined
    : (await refreshNativeSession(request.snapshot)).cursor;
  const statusBeforePrompt = live.status;
  const prompted = await submitPrompt(request, live, origin, deadline, deps);
  return {
    live: prompted.live,
    boundaryCursor: before,
    awaitNewTurn: origin === "existing" &&
      ["working", "unknown"].includes(statusBeforePrompt),
    deliveryUncertain: prompted.deliveryUncertain,
  };
}

async function identifySubmittedPrompt(
  request: HerdrPrompt,
  submitted: SubmittedPrompt,
  knownSessionId: string | undefined,
  deadline: number,
  deps: HerdrDeps,
): Promise<{
  live: LiveAgent;
  snapshot: SharedSession;
  boundaryCursor?: NativeCursor;
}> {
  const prompted = submitted.live;
  let identified: SharedSession;
  try {
    identified = await waitForNativeSession(
      request,
      prompted,
      knownSessionId,
      deadline,
      deps,
    );
  } catch (error) {
    const normalized = normalizeError(error);
    if (prompted.status === "blocked") {
      throw new RetainPaneError(
        normalized.code,
        normalized.message,
        normalized.blockers,
        normalized.sessionId,
        normalized.retry,
      );
    }
    throw normalized;
  }
  if (prompted.status === "blocked") {
    throw new DelegateError(
      "agent_blocked",
      "에이전트가 사용자 입력을 기다립니다",
      undefined,
      identified.sessionId,
    );
  }
  if (submitted.awaitNewTurn) {
    identified = await waitForNewTurn(
      identified,
      submitted.boundaryCursor,
      deadline,
      deps,
    );
  }
  return {
    live: prompted,
    snapshot: identified,
    boundaryCursor: submitted.boundaryCursor,
  };
}

async function submitAndIdentify(
  request: HerdrPrompt,
  live: LiveAgent,
  origin: "started" | "existing",
  knownSessionId: string | undefined,
  deadline: number,
  deps: HerdrDeps,
): Promise<{
  live: LiveAgent;
  snapshot: SharedSession;
  boundaryCursor?: NativeCursor;
}> {
  const submitted = await submitPromptOnly(
    request,
    live,
    origin,
    knownSessionId,
    deadline,
    deps,
  );
  return await identifySubmittedPrompt(
    request,
    submitted,
    knownSessionId,
    deadline,
    deps,
  );
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
  ensureTime(deadline, deps, sessionId);
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
    ensureTime(deadline, deps, sessionId);
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
  assignedSessionId: string | undefined,
  deadline: number,
  deps: HerdrDeps,
  allocated: (ownership: PaneOwnership, cwd: string) => void,
): Promise<{
  live: ManagedPane;
  retry?: RetryRecord;
}> {
  const cwd = request.snapshot?.cwd ?? request.cwd;
  const { ownership, ...pane } = await allocatePane(
    cwd,
    callerId,
    request.snapshot?.sessionId,
    deps,
    (ownership) => allocated(ownership, cwd),
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
      ...(assignedSessionId == null
        ? []
        : [`--session-id=${assignedSessionId}`]),
    ]
    : request.invocation.herdrArgs;
  const start = async () => {
    ensureTime(deadline, deps, request.snapshot?.sessionId);
    const result = await json(cwd, deps, [
      "agent",
      "start",
      name,
      "--kind",
      request.invocation.agent,
      "--pane",
      pane.paneId,
      "--timeout",
      String(
        Math.max(
          1,
          Math.floor(Math.min(activityGateMs, remaining(deadline, deps))),
        ),
      ),
      "--",
      ...herdrArgs,
    ]);
    return agentFromResult(result, name);
  };
  let retry: RetryRecord | undefined;
  let started: LiveAgent;
  try {
    try {
      started = await start();
    } catch (error) {
      const normalized = normalizeError(error);
      if (
        ownership.kind === "none" || normalized.code !== "herdr_failed" ||
        normalized.message !==
          `agent target pane ${pane.paneId} is not an available shell`
      ) throw normalized;
      const reason = {
        code: "herdr_failed" as const,
        message: normalized.message,
      };
      try {
        await pause(100, deps, request.snapshot?.sessionId);
        started = await start();
        retry = { reason, result: "success" };
      } catch (retryError) {
        throw copyDelegateError(normalizeError(retryError), {
          retry: { reason, result: "failed" },
        });
      }
    }
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.code === "agent_blocked") {
      throw new DelegateError(
        "agent_blocked",
        `${normalized.message}; agent start가 완료되지 않아 prompt를 제출하지 않았습니다`,
        [{
          pane_id: pane.paneId,
          agent_name: name,
          status: "blocked",
        }],
        normalized.sessionId,
        normalized.retry,
      );
    }
    throw normalized;
  }
  return {
    live: mergeReportedLive({
      ...pane,
      name,
      kind: request.invocation.agent,
      cwd,
      status: "unknown",
    }, started) as ManagedPane,
    retry,
  };
}

async function waitForNativeSession(
  request: HerdrPrompt,
  initialLive: LiveAgent,
  knownSessionId: string | undefined,
  deadline: number,
  deps: HerdrDeps,
): Promise<SharedSession> {
  ensureTime(deadline, deps, knownSessionId);
  const pollDeadline = Math.min(deadline, deps.now() + identityPollMs);
  let live = initialLive;
  let reportedSessionId: string | undefined;
  while (remaining(pollDeadline, deps) > 0) {
    ensureTime(deadline, deps, reportedSessionId ?? knownSessionId);
    if (live.sessionId == null) {
      live = await withSessionError(
        getAgent(
          live,
          request.snapshot?.cwd ?? request.cwd,
          deps,
          knownSessionId,
        ),
        knownSessionId,
      );
    }
    reportedSessionId = readReportedSessionId(live, knownSessionId);
    const candidateSessionId = reportedSessionId ?? knownSessionId;
    if (candidateSessionId != null) {
      try {
        const snapshot = await findNativeSession(candidateSessionId, deps.env);
        if (
          snapshot.agent !== request.invocation.agent ||
          snapshot.cwd !== (request.snapshot?.cwd ?? request.cwd)
        ) {
          throw new DelegateError(
            "invalid_native_session",
            "Herdr session 정보와 native session metadata가 다릅니다",
            undefined,
            candidateSessionId,
          );
        }
        return snapshot;
      } catch (error) {
        if (
          !(error instanceof DelegateError &&
            error.code === "session_not_found")
        ) throw error;
      }
    }
    await pause(
      Math.min(250, remaining(pollDeadline, deps)),
      deps,
      reportedSessionId ?? knownSessionId,
    );
  }
  ensureTime(deadline, deps, reportedSessionId ?? knownSessionId);
  const candidateSessionId = reportedSessionId ?? knownSessionId;
  if (candidateSessionId == null) {
    throw new DelegateError(
      "session_id_unavailable",
      "Herdr가 native session ID를 보고하지 않았습니다",
    );
  }
  throw new DelegateError(
    "invalid_native_session",
    `native session을 찾을 수 없습니다: ${candidateSessionId}`,
    undefined,
    candidateSessionId,
  );
}

function readReportedSessionId(
  live: LiveAgent,
  knownSessionId: string | undefined,
): string | undefined {
  if (live.sessionId == null) return undefined;
  if (live.sessionKind !== "id" || !sessionIdPattern.test(live.sessionId)) {
    throw new DelegateError(
      "invalid_native_session",
      "Herdr가 올바른 native session ID를 보고하지 않았습니다",
      undefined,
      knownSessionId,
    );
  }
  if (
    knownSessionId != null &&
    live.sessionId.toLowerCase() !== knownSessionId.toLowerCase()
  ) {
    throw new DelegateError(
      "session_id_changed",
      `session ID 변경: ${knownSessionId} -> ${live.sessionId}`,
      undefined,
      knownSessionId,
    );
  }
  return live.sessionId;
}

async function waitForNewTurn(
  initial: SharedSession,
  before: NativeCursor | undefined,
  deadline: number,
  deps: HerdrDeps,
): Promise<SharedSession> {
  if (before == null) return initial;
  let snapshot = initial;
  while (true) {
    ensureTime(deadline, deps, snapshot.sessionId);
    const offset = before.path === snapshot.cursor.path &&
        before.identity === snapshot.cursor.identity
      ? before.byteLength
      : 0;
    if (snapshot.turns.some((turn) => turn.start >= offset)) return snapshot;
    await pause(
      Math.min(250, remaining(deadline, deps)),
      deps,
      snapshot.sessionId,
    );
    snapshot = await refreshNativeSession(snapshot);
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
    let waited: HerdrResult;
    try {
      waited = await withSessionError(
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
        ]),
        snapshot.sessionId,
      );
    } catch (error) {
      if (
        error instanceof DelegateError &&
        (error.code === "cancelled" || error.code === "timeout")
      ) throw error;
      let recovered: LiveAgent | undefined;
      try {
        recovered = await findLiveAgent(snapshot, deps);
      } catch (recoveryError) {
        if (recoveryError instanceof LiveAgentListError) throw error;
        throw recoveryError;
      }
      if (recovered == null) throw error;
      live = recovered;
      continue;
    }
    const candidate = agentFromResult(waited, live.name);
    readReportedSessionId(candidate, snapshot.sessionId);
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
    ensureTime(deadline, deps, snapshot.sessionId);
    const sequence = requireSequence(candidate);
    const cursor = snapshot.cursor;
    await pause(
      Math.min(500, remaining(deadline, deps)),
      deps,
      snapshot.sessionId,
    );
    ensureTime(deadline, deps, snapshot.sessionId);
    const checked = await withSessionError(
      getAgent(live, snapshot.cwd, deps, snapshot.sessionId),
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
    ensureTime(deadline, deps, refreshed.sessionId);
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
    throw new LiveAgentListError(
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
  readReportedSessionId(live, snapshot.sessionId);
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
  knownSessionId: string | undefined,
): Promise<LiveAgent> {
  const result = await json(cwd, deps, ["agent", "get", live.name]);
  const reported = agentFromResult(result, live.name);
  readReportedSessionId(reported, knownSessionId);
  return mergeReportedLive(live, reported);
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
  allocated: (ownership: PaneOwnership) => void,
): Promise<
  Pick<ManagedPane, "workspaceId" | "tabId" | "paneId" | "callerId"> & {
    ownership: PaneOwnership;
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
    const ownership: PaneOwnership = {
      kind: "tab",
      workspaceId,
      paneId,
      tabId,
    };
    allocated(ownership);
    const verified = (await listTabs(workspaceId, cwd, deps)).filter((tab) =>
      tab.label === callerId && tab.tabId === tabId
    );
    if (verified.length !== 1) {
      throw new DelegateError(
        "live_session_ambiguous",
        "생성한 관리 탭 소유권을 확인하지 못했습니다",
      );
    }
    return {
      workspaceId,
      tabId,
      paneId,
      callerId,
      ownership,
    };
  }
  const tabId = candidates[0]!.tabId;
  const panes = (await listPanes(workspaceId, cwd, deps)).filter((pane) =>
    pane.tabId === tabId
  );
  const available = panes.find((pane) => pane.agentName == null);
  if (available != null) {
    const ownership: PaneOwnership = { kind: "none" };
    allocated(ownership);
    return {
      workspaceId,
      tabId,
      paneId: available.paneId,
      callerId,
      ownership,
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
  const ownership: PaneOwnership = { kind: "pane", paneId };
  allocated(ownership);
  return {
    workspaceId,
    tabId,
    paneId,
    callerId,
    ownership,
  };
}

async function cleanupOwnedPane(
  ownership: PaneOwnership,
  cwd: string,
  deadline: number,
  deps: HerdrDeps,
): Promise<void> {
  if (ownership.kind === "none") return;
  ensureTime(deadline, deps);
  let paneCloseError: DelegateError | undefined;
  try {
    await closePane(ownership.paneId, cwd, deps);
  } catch (error) {
    const normalized = normalizeError(error);
    if (isLifecycleError(normalized)) throw normalized;
    paneCloseError = normalized;
  }
  if (ownership.kind === "pane") {
    if (paneCloseError != null) throw paneCloseError;
    return;
  }

  ensureTime(deadline, deps);
  let panes: Awaited<ReturnType<typeof listPanes>>;
  try {
    panes = await listPanes(ownership.workspaceId, cwd, deps);
  } catch (error) {
    const normalized = normalizeError(error);
    if (isLifecycleError(normalized)) throw normalized;
    throw paneCloseError ?? normalized;
  }
  if (panes.some((pane) => pane.tabId === ownership.tabId)) {
    if (paneCloseError != null) throw paneCloseError;
    return;
  }

  ensureTime(deadline, deps);
  try {
    await closeTab(ownership.tabId, cwd, deps);
  } catch (error) {
    const normalized = normalizeError(error);
    if (isLifecycleError(normalized)) throw normalized;
    if (normalized.message !== `tab ${ownership.tabId} not found`) {
      throw paneCloseError ?? normalized;
    }
  }
  if (paneCloseError != null) throw paneCloseError;
}

async function recoverOwnedPane(
  ownership: PaneOwnership,
  cwd: string,
  deps: HerdrDeps,
): Promise<void> {
  if (ownership.kind === "none") return;
  const recoveryDeps: HerdrDeps = {
    exec: deps.exec,
    env: deps.env,
    signal: AbortSignal.timeout(recoveryMs),
    now: deps.now,
    sleep: deps.sleep,
  };
  await cleanupOwnedPane(
    ownership,
    cwd,
    recoveryDeps.now() + recoveryMs,
    recoveryDeps,
  );
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
  const { paneId } = live;
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
        await closePane(paneId, cwd, deps);
        return undefined;
      },
    );
  } catch (error) {
    const normalized = normalizeError(error);
    if (isLifecycleError(normalized)) throw normalized;
    return [{
      code: "cleanup_failed",
      message: normalized.message,
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
    await pause(500, deps, live.sessionId);
  } catch (error) {
    const normalized = normalizeError(error);
    if (isLifecycleError(normalized)) throw normalized;
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
    const normalized = normalizeError(error);
    if (isLifecycleError(normalized)) throw normalized;
    throw new DelegateError(
      "cleanup_failed",
      normalized.message,
    );
  }
}

async function closeTab(tabId: string, cwd: string, deps: HerdrDeps) {
  try {
    await json(cwd, deps, ["tab", "close", tabId]);
  } catch (error) {
    const normalized = normalizeError(error);
    if (isLifecycleError(normalized)) throw normalized;
    throw new DelegateError(
      "cleanup_failed",
      normalized.message,
    );
  }
}

async function json(
  cwd: string,
  deps: HerdrDeps,
  args: string[],
  signal = executionSignal(deps),
): Promise<HerdrResult> {
  const before = interruptionError(deps);
  if (before != null) throw before;
  let output: ExecResult;
  try {
    output = await deps.exec(deps.env.HERDR_BIN_PATH ?? "herdr", args, {
      cwd,
      env: deps.env,
      signal,
    });
  } catch (error) {
    const interruption = interruptionError(deps);
    if (interruption != null) throw interruption;
    throw new DelegateError(
      "herdr_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  const interruption = interruptionError(deps);
  if (interruption != null) throw interruption;
  if (output.code !== 0) {
    const parsed = parseCommandError(output.stderr);
    if (parsed.code === "timeout") {
      throw new DelegateError("timeout", parsed.message);
    }
    if (
      parsed.code === "agent_blocked" ||
      (parsed.code === "agent_not_ready" && args[0] === "agent" &&
        args[1] === "start")
    ) {
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
  options: {
    outcome?: PromptOutcome;
    warnings?: CleanupWarning[];
    retry?: RetryRecord;
  } = {},
): DelegateDocument {
  return {
    session_id: snapshot.sessionId,
    agent: snapshot.agent,
    activity,
    ...options.outcome,
    ...(options.warnings == null || options.warnings.length === 0
      ? {}
      : { warnings: options.warnings }),
    ...(options.retry == null ? {} : { retry: options.retry }),
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
    sessionKind: stringValue(session.kind),
    sessionId: stringValue(session.value),
    workspaceId: stringValue(value.workspace_id) ??
      stringValue(pane.workspace_id),
    tabId: stringValue(value.tab_id) ?? stringValue(pane.tab_id),
    paneId: stringValue(value.pane_id) ?? stringValue(pane.pane_id),
  };
}

function mergeLive(base: LiveAgent, update: LiveAgent): LiveAgent {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(update).filter(([, value]) => value !== undefined),
    ),
  };
}

function mergeReportedLive(base: LiveAgent, update: LiveAgent): LiveAgent {
  if (
    update.name !== base.name ||
    (base.paneId != null && update.paneId != null &&
      update.paneId !== base.paneId)
  ) {
    throw new DelegateError(
      "live_session_ambiguous",
      "Herdr 응답의 agent 또는 pane이 전송 대상과 다릅니다",
      undefined,
      base.sessionId,
    );
  }
  return mergeLive(base, update);
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
  const interruption = interruptionError(deps, sessionId);
  if (interruption != null) throw interruption;
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
  const before = interruptionError(deps, sessionId);
  if (before != null) throw before;
  try {
    await deps.sleep(milliseconds, executionSignal(deps));
  } catch (error) {
    const interruption = interruptionError(deps, sessionId);
    if (interruption != null) throw interruption;
    throw error;
  }
  const interruption = interruptionError(deps, sessionId);
  if (interruption != null) throw interruption;
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

function promptExecutionDeps(
  deps: HerdrDeps,
  timeoutMs: number,
): PromptExecutionDeps {
  const callerSignal = deps.signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    ...deps,
    callerSignal,
    timeoutSignal,
    executionSignal: AbortSignal.any([callerSignal, timeoutSignal]),
  };
}

function executionSignal(deps: HerdrDeps): AbortSignal {
  return isPromptExecutionDeps(deps) ? deps.executionSignal : deps.signal;
}

function interruptionError(
  deps: HerdrDeps,
  sessionId?: string,
): DelegateError | undefined {
  if (isPromptExecutionDeps(deps)) {
    if (deps.callerSignal.aborted) return cancelled(sessionId);
    if (deps.timeoutSignal.aborted) {
      return new DelegateError(
        "timeout",
        "실행 제한 시간 초과",
        undefined,
        sessionId,
      );
    }
  } else if (deps.signal.aborted) {
    return cancelled(sessionId);
  }
}

function isPromptExecutionDeps(
  deps: HerdrDeps,
): deps is PromptExecutionDeps {
  return "executionSignal" in deps;
}

function isLifecycleError(error: DelegateError): boolean {
  return error.code === "cancelled" || error.code === "timeout";
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
