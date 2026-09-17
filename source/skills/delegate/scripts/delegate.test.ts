import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import { runDelegate } from "./delegate.ts";
import { exitCode } from "./document.ts";
import { fakeExec, type FakeResponse } from "./fakes.ts";
import {
  captureBaseline,
  findNativeSession,
  identifyPromptSession,
  renderConversation,
} from "./native_session.ts";
import { denoExec } from "./process.ts";

const codexId = "019efcf8-381f-74a2-a141-f105f1e00e81";
const claudeId = "c627ecae-f35d-40b1-b5fb-b2b109a52e89";
const cwd = "/workspace";
const prefix = "delegate 스킬 등 다른 에이전트 재위임 금지.\n\n";

async function tempDir() {
  const path = await Deno.makeTempDir({ prefix: "delegate-test-" });
  return {
    path,
    async [Symbol.asyncDispose]() {
      await Deno.remove(path, { recursive: true });
    },
  };
}

function setup(
  root: string,
  prompt: string,
  responses: readonly FakeResponse[] = [],
  options: {
    env?: Record<string, string>;
    signal?: AbortSignal;
    now?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const fake = fakeExec(responses);
  return {
    fake,
    deps: {
      exec: fake.exec,
      env: {
        HOME: root,
        CODEX_HOME: join(root, "codex"),
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        HERDR_SOCKET_PATH: join(root, "herdr.sock"),
        ...options.env,
      },
      stdin: {
        isTerminal: () => false,
        text: () => Promise.resolve(prompt),
      },
      cwd,
      signal: options.signal ?? new AbortController().signal,
      now: options.now,
      sleep: options.sleep,
    },
  };
}

function codexPath(root: string, id = codexId) {
  return join(
    root,
    "codex",
    "sessions",
    "2026",
    "09",
    "16",
    `rollout-anon-${id}.jsonl`,
  );
}

function claudePath(root: string, id = claudeId) {
  return join(root, "claude", "projects", "-workspace", `${id}.jsonl`);
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function codexMeta(id = codexId, sessionCwd = cwd) {
  return { type: "session_meta", payload: { id, cwd: sessionCwd } };
}

function codexTurn(
  id: string,
  prompt: string,
  result?: string,
  end: "complete" | "aborted" | "open" = result == null ? "open" : "complete",
) {
  return [
    { type: "event_msg", payload: { type: "task_started", turn_id: id } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "bootstrap은 무시" }],
      },
    },
    { type: "turn_context", payload: { turn_id: id, cwd } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    },
    ...(result == null ? [] : [{
      type: "response_item",
      payload: { type: "function_call", name: "tool", arguments: "secret" },
    }, {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: result }],
      },
    }]),
    ...(end === "complete"
      ? [{
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: id,
        },
      }]
      : end === "aborted"
      ? [{
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: id },
      }]
      : []),
  ];
}

function writeJsonl(path: string, records: readonly unknown[], partial = "") {
  Deno.mkdirSync(join(path, ".."), { recursive: true });
  Deno.writeTextFileSync(path, records.map(line).join("") + partial);
}

function appendJsonl(path: string, records: readonly unknown[]) {
  Deno.writeTextFileSync(path, records.map(line).join(""), { append: true });
}

function claudeOpen(prompt: string, id = claudeId, sessionCwd = cwd) {
  return [{
    type: "user",
    sessionId: id,
    cwd: sessionCwd,
    uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    origin: { kind: "human" },
    promptSource: "typed",
    userType: "external",
    isSidechain: false,
    message: { role: "user", content: prompt },
  }];
}

function herdr(
  result: unknown,
  extra: Partial<FakeResponse> = {},
): FakeResponse {
  return { cmd: "herdr", stdout: JSON.stringify({ result }), ...extra };
}

function herdrFailure(message: string): FakeResponse {
  return {
    cmd: "herdr",
    code: 1,
    stderr: JSON.stringify({ error: { code: "herdr_failed", message } }),
  };
}

function newTabAllocation(): FakeResponse[] {
  return [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
  ];
}

function splitPaneAllocation(): FakeResponse[] {
  return [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({
      panes: [{
        pane_id: "pane-anchor",
        tab_id: "tab-delegate",
        agent: "busy",
        agent_status: "working",
      }],
    }),
    herdr({ pane: { pane_id: "pane-delegate" } }),
  ];
}

function completedUntilPostProcessing(
  path: string,
  prompt: string,
): FakeResponse[] {
  return [
    ...newTabAllocation(),
    herdr({}),
    herdr({}, {
      onStart: () =>
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("turn", prompt, "완료"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
  ];
}

function successfulCleanup(): FakeResponse[] {
  return [
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: liveAgent("done", 2).name,
        agent_status: "done",
      }],
    }),
    herdr({}),
    herdr({}),
  ];
}

function liveAgent(status: string, sequence: number) {
  return {
    name: `dlg-${codexId.replaceAll("-", "").slice(0, 28)}`,
    agent_kind: "codex",
    cwd,
    agent_status: status,
    state_change_seq: sequence,
    agent_session: { value: codexId },
    workspace_id: "ws-1",
    tab_id: "tab-delegate",
    pane_id: "pane-delegate",
  };
}

function claudeLive(status: string, sequence: number) {
  return {
    name: `dlg-${claudeId.replaceAll("-", "").slice(0, 28)}`,
    agent: "claude",
    cwd,
    agent_status: status,
    state_change_seq: sequence,
    agent_session: { value: claudeId },
    workspace_id: "ws-1",
    tab_id: "tab-delegate",
    pane_id: "pane-delegate",
  };
}

function completedHerdrResponses(
  path: string,
  prompt: string,
  options: {
    onAgentStart?: () => void | Promise<void>;
    onCleanupStart?: () => void | Promise<void>;
  } = {},
): FakeResponse[] {
  return [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "tab-current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({}, { onStart: options.onAgentStart }),
    herdr({}, {
      onStart: () =>
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("turn", prompt, "완료"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }, {
      onStart: options.onCleanupStart,
    }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: liveAgent("done", 2).name,
        agent_status: "done",
      }],
    }),
    herdr({}),
    herdr({}),
  ];
}

Deno.test("두 위임을 동시에 요청해도 각자 작업을 마치고 결과를 받는다", async () => {
  await using firstDir = await tempDir();
  await using secondDir = await tempDir();
  const socketPath = join(firstDir.path, "shared-herdr.sock");
  const firstPrompt = `${prefix}첫 작업`;
  const secondPrompt = `${prefix}둘째 작업`;
  const firstStart = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondWaiting = Promise.withResolvers<void>();

  const first = setup(
    firstDir.path,
    "첫 작업",
    completedHerdrResponses(codexPath(firstDir.path), firstPrompt, {
      onAgentStart: async () => {
        firstStart.resolve();
        await releaseFirst.promise;
      },
    }),
    { env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath } },
  );
  const second = setup(
    secondDir.path,
    "둘째 작업",
    completedHerdrResponses(codexPath(secondDir.path), secondPrompt),
    {
      env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
      sleep: async () => {
        secondWaiting.resolve();
        await releaseFirst.promise;
      },
    },
  );

  const firstResult = runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], first.deps);
  await firstStart.promise;
  const secondResult = runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], second.deps);
  await secondWaiting.promise;

  const secondCallsBeforeRelease = second.fake.calls.length;
  releaseFirst.resolve();
  const results = await Promise.all([firstResult, secondResult]);
  assertEquals(secondCallsBeforeRelease, 0);
  assertEquals(results.map((result) => result.code), [0, 0]);
  assertEquals(
    results.every((result) => result.stdout.includes("\n\n완료\n")),
    true,
  );
});

Deno.test("같은 중단 세션을 동시에 재개하면 먼저 시작한 요청만 진행한다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  writeJsonl(path, [codexMeta(), ...codexTurn("old", "이전", "완료")]);
  const firstStart = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondWaiting = Promise.withResolvers<void>();
  const secondChecked = Promise.withResolvers<void>();
  const socketPath = join(dir.path, "shared-herdr.sock");
  const first = setup(dir.path, "첫 재개", [
    herdr({ agents: [] }),
    herdr({ agents: [] }),
    herdr({ pane: { workspace_id: "ws-1", tab_id: "tab-current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({}, {
      onStart: async () => {
        firstStart.resolve();
        await releaseFirst.promise;
      },
    }),
    herdr({}, {
      onStart: () =>
        appendJsonl(
          path,
          codexTurn("resumed", `${prefix}첫 재개`, "첫 결과"),
        ),
    }),
    herdr({ agent: liveAgent("done", 2) }, {
      onStart: () => secondChecked.promise,
    }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: liveAgent("done", 2).name,
        agent_status: "done",
      }],
    }),
    herdr({}),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
  });
  const second = setup(dir.path, "둘째 재개", [
    herdr({ agents: [] }),
    herdr({ agents: [liveAgent("working", 1)] }, {
      onStart: () => secondChecked.resolve(),
    }),
  ], {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
    sleep: async () => {
      secondWaiting.resolve();
      await releaseFirst.promise;
    },
  });

  const firstResult = runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
  ], first.deps);
  await firstStart.promise;
  const secondResult = runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
  ], second.deps);
  await secondWaiting.promise;
  releaseFirst.resolve();

  const [firstOutput, secondOutput] = await Promise.all([
    firstResult,
    secondResult,
  ]);
  assertEquals(firstOutput.code, 0);
  assertStringIncludes(firstOutput.stdout, "\n\n첫 결과\n");
  assertEquals(secondOutput.code, 5);
  assertStringIncludes(secondOutput.stdout, "code: live_session_ambiguous");
  assertStringIncludes(
    secondOutput.stdout,
    "session이 다른 호출에서 재개되었습니다",
  );
  assertEquals(
    second.fake.calls.some((call) => call.args[1] === "start"),
    false,
  );
});

Deno.test("먼저 끝난 위임을 정리하는 동안 새 위임을 요청해도 둘 다 완료한다", async () => {
  await using firstDir = await tempDir();
  await using secondDir = await tempDir();
  const socketPath = join(firstDir.path, "shared-herdr.sock");
  const cleanupStarted = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const secondWaiting = Promise.withResolvers<void>();

  const first = setup(
    firstDir.path,
    "첫 작업",
    completedHerdrResponses(
      codexPath(firstDir.path),
      `${prefix}첫 작업`,
      {
        onCleanupStart: async () => {
          cleanupStarted.resolve();
          await releaseCleanup.promise;
        },
      },
    ),
    { env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath } },
  );
  const second = setup(
    secondDir.path,
    "둘째 작업",
    completedHerdrResponses(codexPath(secondDir.path), `${prefix}둘째 작업`),
    {
      env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
      sleep: async () => {
        secondWaiting.resolve();
        await releaseCleanup.promise;
      },
    },
  );

  const firstResult = runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], first.deps);
  await cleanupStarted.promise;
  const secondResult = runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], second.deps);
  await secondWaiting.promise;

  const secondCallsBeforeRelease = second.fake.calls.length;
  releaseCleanup.resolve();
  const results = await Promise.all([firstResult, secondResult]);
  assertEquals(secondCallsBeforeRelease, 0);
  assertEquals(results.map((result) => result.code), [0, 0]);
});

Deno.test("사용자가 진행 중 작업의 상태 확인·wait·logs·close를 이어가면 같은 native session의 대화와 정리 결과를 받는다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  const firstPrompt = `${prefix}첫 요청`;
  writeJsonl(path, [codexMeta(), ...codexTurn("turn-1", firstPrompt)]);
  let now = 0;
  const responses: FakeResponse[] = [
    herdr({ agents: [liveAgent("working", 1)] }),
    herdr({ agents: [liveAgent("working", 3)] }),
    herdr({ agent: liveAgent("done", 3) }, {
      onStart: () =>
        appendJsonl(path, [
          ...codexTurn(
            "turn-1-tail",
            "취소한 중간 요청",
            "ignored",
            "aborted",
          ),
          ...codexTurn(
            "turn-2",
            `${prefix}수동 후속 요청`,
            "최신 완료 결과",
          ),
        ]),
    }),
    herdr({ agent: liveAgent("done", 3) }),
    herdr({}),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller-1" }] }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: liveAgent("done", 3).name,
        agent_status: "done",
      }],
    }),
    herdr({}),
    herdr({}),
    herdr({ agents: [] }),
  ];
  const start = setup(dir.path, "", responses, {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });

  const status = await runDelegate(["status", codexId], start.deps);
  assertEquals(status.code, 0);
  assertEquals(
    status.stdout,
    `---\nsession_id: ${codexId}\nagent: codex\nactivity: working\n---\n`,
  );

  const waited = await runDelegate([
    "wait",
    codexId,
    "--caller-id",
    "caller-1",
    "--name",
    "검토",
  ], start.deps);
  assertEquals(waited.code, 0);
  assertStringIncludes(waited.stdout, "activity: quiescent");
  assertStringIncludes(
    waited.stdout,
    "intervening_prompts:\n  - 취소한 중간 요청\n  - 수동 후속 요청",
  );
  assertStringIncludes(waited.stdout, "\n\n최신 완료 결과\n");
  assertEquals(
    start.fake.calls.some((call) =>
      call.args.includes("/rename caller-1 검토")
    ),
    true,
  );
  assertEquals(
    start.fake.calls.some((call) =>
      call.args.join(" ") === "pane close pane-delegate"
    ),
    true,
  );

  const logs = await runDelegate(
    ["logs", codexId, "--lines", "20"],
    start.deps,
  );
  assertEquals(logs.code, 0);
  assertStringIncludes(logs.stdout, "수동 후속 요청");
  assertStringIncludes(logs.stdout, "최신 완료 결과");
  assertEquals(logs.stdout.includes("secret"), false);

  const closed = await runDelegate([
    "close",
    codexId,
    "--caller-id",
    "caller-1",
  ], start.deps);
  assertEquals(closed.code, 0);
  assertStringIncludes(closed.stdout, "activity: not_live");
});

Deno.test("prompt 파일의 BOM과 마지막 개행 하나를 제거한 전송 문자열로 Herdr gate를 완료한다", async () => {
  await using dir = await tempDir();
  const promptPath = join(dir.path, "prompt.md");
  const nativePath = codexPath(dir.path);
  const filePrompt = "첫 문단입니다.\n\n둘째 문단입니다.\n";
  const sentPrompt = `${prefix}첫 문단입니다.\n\n둘째 문단입니다.`;
  Deno.writeTextFileSync(promptPath, `\uFEFF${filePrompt}`);
  let now = 0;
  const test = setup(dir.path, "stdin은 사용하지 않습니다", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "tab-current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller-file" }] }),
    herdr({}),
    herdr({}, {
      onStart: () =>
        writeJsonl(nativePath, [
          codexMeta(),
          ...codexTurn("file", sentPrompt, "완료"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller-file" }] }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: liveAgent("done", 2).name,
        agent_status: "done",
      }],
    }),
    herdr({}),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });

  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller-file",
    "--prompt-file",
    promptPath,
    "--timeout",
    "1s",
  ], test.deps);

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, `session_id: ${codexId}`);
  assertEquals(result.stdout.includes("intervening_prompts:"), false);
  assertStringIncludes(result.stdout, "\n\n완료\n");
  assertEquals(
    test.fake.calls.find((call) => call.args[1] === "prompt")?.args[3],
    sentPrompt,
  );
});

Deno.test("사용자가 직접 prompt를 완료하면 native 파일 flush 없이 결과를 받고 재개는 native cwd와 같은 ID를 지킨다", async () => {
  await using dir = await tempDir();
  const normal = setup(dir.path, "작업", [{
    cmd: "codex",
    stdout: `{"type":"thread.started","thread_id":"${codexId}"}\n` +
      '{"type":"item.completed","item":{"type":"agent_message","text":"# 완료\\n\\n본문"}}\n',
  }]);
  const completed = await runDelegate([
    "prompt",
    "--transport",
    "direct",
    "--agent",
    "codex",
  ], normal.deps);
  assertEquals(completed.code, 0);
  assertEquals(
    completed.stdout,
    `---\nsession_id: ${codexId}\nagent: codex\nactivity: quiescent\n---\n\n# 완료\n\n본문\n`,
  );
  assertEquals(completed.stdout.includes("run_id:"), false);
  assertEquals(normal.fake.calls[0]?.env.HERDR_ENV, undefined);

  const sessionCwd = join(dir.path, "session-workspace");
  Deno.mkdirSync(sessionCwd);
  writeJsonl(codexPath(dir.path), [
    codexMeta(codexId, sessionCwd),
    ...codexTurn("turn-a", "old", "old"),
  ]);
  const changedId = "11111111-2222-3333-4444-555555555555";
  const changed = setup(dir.path, "후속", [{
    cmd: "codex",
    stdout: `{"type":"thread.started","thread_id":"${changedId}"}\n` +
      '{"type":"item.completed","item":{"type":"agent_message","text":"잘못된 재개"}}\n',
  }]);
  const rejected = await runDelegate([
    "prompt",
    codexId,
    "--transport",
    "direct",
  ], changed.deps);
  assertEquals(rejected.code, 5);
  assertStringIncludes(rejected.stdout, "code: session_id_changed");
  assertStringIncludes(rejected.stdout, codexId);
  assertStringIncludes(rejected.stdout, changedId);
  assertEquals(changed.fake.calls[0]?.cwd, sessionCwd);

  const claudeCwd = join(dir.path, "claude-session-workspace");
  Deno.mkdirSync(claudeCwd);
  writeJsonl(claudePath(dir.path), claudeOpen("old", claudeId, claudeCwd));
  const claude = setup(dir.path, "클로드 후속", [{
    cmd: "claude",
    stdout: line({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: claudeId,
      result: "클로드 재개",
    }),
  }]);
  const resumed = await runDelegate([
    "prompt",
    claudeId,
    "--transport",
    "direct",
  ], claude.deps);
  assertEquals(resumed.code, 0);
  assertStringIncludes(resumed.stdout, "\n\n클로드 재개\n");
  assertEquals(claude.fake.calls[0]?.cwd, claudeCwd);
});

Deno.test("사용자가 종료된 Herdr session을 확인 후 write로 재개하면 같은 파일에 append하고 비종결 상태를 쉬어 재대기한 뒤 결정적 이름으로 정리한다", async () => {
  await using dir = await tempDir();
  const sessionCwd = join(dir.path, "stopped-session-workspace");
  Deno.mkdirSync(sessionCwd);
  const path = codexPath(dir.path);
  writeJsonl(path, [
    codexMeta(codexId, sessionCwd),
    ...codexTurn("old", "이전 요청", "이전 결과"),
  ]);
  const deterministic = `dlg-${codexId.replaceAll("-", "").slice(0, 28)}`;
  let now = 0;
  const sleeps: number[] = [];
  const test = setup(dir.path, "수정 요청", [
    herdr({ agents: [] }),
    herdr({ agents: [] }),
    herdr({ agents: [] }),
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({}),
    herdr({}, {
      onStart: () =>
        appendJsonl(
          path,
          codexTurn("resumed", `${prefix}수정 요청`, "재개 결과"),
        ),
    }),
    herdr({ agent_status: "working", state_change_seq: 2 }),
    herdr({ agent: { agent_status: "done", state_change_seq: 3 } }),
    herdr({ agent_status: "done", state_change_seq: 3 }),
    herdr({}),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: deterministic,
        agent_status: "done",
      }],
    }),
    herdr({}),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  const denied = await runDelegate([
    "prompt",
    codexId,
    "--permission",
    "write",
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(denied.code, 4);
  assertStringIncludes(denied.stdout, "code: permission_escalation");

  const resumed = await runDelegate([
    "prompt",
    codexId,
    "--permission",
    "write",
    "--confirm-escalation",
    "--caller-id",
    "caller",
    "--name",
    "재개 작업",
    "--timeout",
    "2s",
  ], test.deps);
  assertEquals(resumed.code, 0);
  assertStringIncludes(resumed.stdout, "\n\n재개 결과\n");
  assertEquals(sleeps, [50, 500, 500]);
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "wait").length,
    2,
  );
  const start = test.fake.calls.find((call) => call.args[1] === "start");
  assertEquals(start?.cwd, sessionCwd);
  assertEquals(start?.args[2], deterministic);
  assertEquals(start?.args.includes(codexId), true);
  assertEquals(start?.args.includes("--approve-for-me"), true);
  assertEquals(
    test.fake.calls.some((call) =>
      call.args.includes("/rename caller 재개 작업")
    ),
    true,
  );
  assertStringIncludes(Deno.readTextFileSync(path), "재개 결과");

  const changedId = "11111111-2222-3333-4444-555555555555";
  const changedPath = codexPath(dir.path, changedId);
  let changedNow = 0;
  const changed = setup(dir.path, "다른 ID로 바뀌면 안 됩니다", [
    herdr({ agents: [] }),
    herdr({ agents: [] }),
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({}),
    herdr({}, {
      onStart: () =>
        writeJsonl(changedPath, [
          codexMeta(changedId, sessionCwd),
          ...codexTurn(
            "changed",
            `${prefix}다른 ID로 바뀌면 안 됩니다`,
          ),
        ]),
    }),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => changedNow,
    sleep: (ms) => {
      changedNow += ms;
      return Promise.resolve();
    },
  });
  const rejected = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
    "--timeout",
    "1s",
  ], changed.deps);
  assertEquals(rejected.code, 5);
  assertStringIncludes(rejected.stdout, "code: session_id_changed");
  assertStringIncludes(rejected.stdout, codexId);
  assertStringIncludes(rejected.stdout, changedId);
});

Deno.test("새 작업의 관리 pane 셸이 늦게 준비되어도 다시 시작해 결과와 회복 기록을 반환한다", async () => {
  for (
    const allocationKind of ["root", "split"] as const
  ) {
    await using dir = await tempDir();
    const path = codexPath(dir.path);
    const shellError =
      `agent target pane pane-delegate is not an available shell`;
    const sleeps: number[] = [];
    let now = 0;
    const allocation = allocationKind === "root"
      ? [
        herdr({ tabs: [] }),
        herdr({
          tab: { tab_id: "tab-delegate" },
          root_pane: { pane_id: "pane-delegate" },
        }),
        herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
      ]
      : [
        herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
        herdr({
          panes: [{
            pane_id: "pane-anchor",
            tab_id: "tab-delegate",
            agent: "busy",
            agent_status: "working",
          }],
        }),
        herdr({ pane: { pane_id: "pane-delegate" } }),
      ];
    const afterPrompt = [
      herdr({ agent: liveAgent("done", 2) }),
      herdr({ agent: liveAgent("done", 2) }),
      herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
      herdr({
        panes: [{
          pane_id: "pane-delegate",
          tab_id: "tab-delegate",
          agent: liveAgent("done", 2).name,
          agent_status: "done",
        }],
      }),
      herdr({}),
      herdr({}),
    ];
    const test = setup(dir.path, "작업", [
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      ...allocation,
      herdrFailure(shellError),
      herdr({}),
      herdr({}, {
        onStart: () =>
          writeJsonl(path, [
            codexMeta(),
            ...codexTurn("retry", `${prefix}작업`, "회복 결과"),
          ]),
      }),
      herdr({}),
      ...afterPrompt,
    ], {
      env: { HERDR_ENV: "1" },
      now: () => now,
      sleep: (ms) => {
        now += ms;
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);

    assertEquals(result.code, 0, allocationKind);
    assertStringIncludes(
      result.stdout,
      `retry:\n  reason:\n    code: herdr_failed\n    message: ${shellError}\n  result: success`,
    );
    assertStringIncludes(result.stdout, "회복 결과");
    const starts = test.fake.calls.filter((call) => call.args[1] === "start");
    assertEquals(starts.length, 2);
    assertEquals(starts[0]?.args, starts[1]?.args);
    assertEquals(sleeps[0], 100);
    assertEquals(
      test.fake.calls.findIndex((call) => call.args[1] === "prompt") >
        test.fake.calls.findLastIndex((call) => call.args[1] === "start"),
      true,
    );
  }
});

Deno.test("중단된 작업의 관리 pane 셸이 늦게 준비되어도 다시 시작해 재개 결과와 회복 기록을 반환한다", async () => {
  for (const retrySucceeds of [true, false]) {
    await using dir = await tempDir();
    const path = codexPath(dir.path);
    writeJsonl(path, [codexMeta(), ...codexTurn("old", "이전", "완료")]);
    const shellError =
      `agent target pane pane-delegate is not an available shell`;
    const responses: FakeResponse[] = [
      herdr({ agents: [] }),
      herdr({ agents: [] }),
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      herdr({ tabs: [] }),
      herdr({
        tab: { tab_id: "tab-delegate" },
        root_pane: { pane_id: "pane-delegate" },
      }),
      herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
      herdrFailure(shellError),
      retrySucceeds ? herdr({}) : herdrFailure("retry refused"),
    ];
    if (retrySucceeds) {
      responses.push(
        herdr({}, {
          onStart: () =>
            appendJsonl(
              path,
              codexTurn("resumed", `${prefix}수정`, "재개 결과"),
            ),
        }),
        herdr({ agent_status: "done", state_change_seq: 2 }),
        herdr({ agent: { agent_status: "done", state_change_seq: 2 } }),
        herdr({ agent_status: "done", state_change_seq: 2 }),
        herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
        herdr({
          panes: [{
            pane_id: "pane-delegate",
            tab_id: "tab-delegate",
            agent: liveAgent("done", 2).name,
            agent_status: "done",
          }],
        }),
        herdr({}),
        herdr({}),
      );
    }
    const test = setup(dir.path, "수정", responses, {
      env: { HERDR_ENV: "1" },
      now: () => 0,
      sleep: () => Promise.resolve(),
    });

    const result = await runDelegate([
      "prompt",
      codexId,
      "--caller-id",
      "caller",
    ], test.deps);

    assertStringIncludes(result.stdout, `session_id: ${codexId}`);
    assertStringIncludes(result.stdout, `message: ${shellError}`);
    assertStringIncludes(
      result.stdout,
      `result: ${retrySucceeds ? "success" : "failed"}`,
    );
    if (retrySucceeds) {
      assertEquals(result.code, 0);
      assertStringIncludes(result.stdout, "재개 결과");
    } else {
      assertEquals(result.code, 5);
      assertStringIncludes(result.stdout, "message: retry refused");
    }
    const start = test.fake.calls.filter((call) => call.args[1] === "start");
    assertEquals(start.length, 2);
    assertEquals(start[0]?.args[2], liveAgent("done", 2).name);
  }
});

Deno.test("기존 관리 pane이나 다른 이유로 시작이 거부되면 곧바로 원인을 반환한다", async () => {
  for (
    const scenario of [
      {
        existing: true,
        message: "agent target pane pane-delegate is not an available shell",
      },
      { existing: false, message: "agent start refused" },
    ]
  ) {
    await using dir = await tempDir();
    const allocation = scenario.existing
      ? [
        herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
        herdr({
          panes: [{
            pane_id: "pane-delegate",
            tab_id: "tab-delegate",
            agent: null,
          }],
        }),
      ]
      : [
        herdr({ tabs: [] }),
        herdr({
          tab: { tab_id: "tab-delegate" },
          root_pane: { pane_id: "pane-delegate" },
        }),
        herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
      ];
    let sleeps = 0;
    const test = setup(dir.path, "작업", [
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      ...allocation,
      herdrFailure(scenario.message),
    ], {
      env: { HERDR_ENV: "1" },
      sleep: () => {
        sleeps++;
        return Promise.resolve();
      },
    });

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);

    assertEquals(result.code, 5);
    assertStringIncludes(result.stdout, `message: ${scenario.message}`);
    assertEquals(result.stdout.includes("retry:"), false);
    assertEquals(sleeps, 0);
    assertEquals(
      test.fake.calls.filter((call) => call.args[1] === "start").length,
      1,
    );
  }
});

Deno.test("관리 pane 셸을 다시 시작하지 못하면 마지막 상태와 실패 기록을 반환한다", async () => {
  for (
    const scenario of [
      { name: "같은 오류", second: "shell", cancel: "none" },
      { name: "다른 오류", second: "other", cancel: "none" },
      { name: "대기 중 취소", second: "none", cancel: "sleep" },
      { name: "두 번째 시작 중 취소", second: "cancel", cancel: "start" },
    ] as const
  ) {
    await using dir = await tempDir();
    const controller = new AbortController();
    const shellError =
      `agent target pane pane-delegate is not an available shell`;
    const responses: FakeResponse[] = [
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      herdr({ tabs: [] }),
      herdr({
        tab: { tab_id: "tab-delegate" },
        root_pane: { pane_id: "pane-delegate" },
      }),
      herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
      herdrFailure(shellError),
    ];
    if (scenario.second === "shell") responses.push(herdrFailure(shellError));
    if (scenario.second === "other") {
      responses.push(herdrFailure("retry refused"));
    }
    if (scenario.second === "cancel") {
      responses.push({
        cmd: "herdr",
        waitForAbort: true,
        onStart: () => controller.abort(),
      });
    }
    let sleeps = 0;
    const test = setup(dir.path, "작업", responses, {
      env: { HERDR_ENV: "1" },
      signal: controller.signal,
      sleep: () => {
        sleeps++;
        if (scenario.cancel === "sleep") {
          controller.abort();
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        }
        return Promise.resolve();
      },
    });

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);

    assertEquals(
      result.code,
      scenario.cancel === "none" ? 5 : 130,
      scenario.name,
    );
    assertStringIncludes(result.stdout, "result: failed");
    assertStringIncludes(result.stdout, `message: ${shellError}`);
    if (scenario.second === "other") {
      assertStringIncludes(result.stdout, "message: retry refused");
    }
    if (scenario.cancel !== "none") {
      assertStringIncludes(result.stdout, "code: cancelled");
    }
    assertEquals(sleeps, 1);
    assertEquals(
      test.fake.calls.filter((call) => call.args[1] === "start").length,
      scenario.cancel === "sleep" ? 1 : 2,
    );
  }
});

Deno.test("관리 pane 시작이 회복된 뒤 후속 단계가 실패해도 회복 기록을 반환한다", async () => {
  for (
    const failure of ["prompt", "session", "wait", "blocked", "raw"] as const
  ) {
    await using dir = await tempDir();
    const path = codexPath(dir.path);
    const shellError =
      `agent target pane pane-delegate is not an available shell`;
    let sleepCalls = 0;
    const afterRetry: FakeResponse[] = failure === "prompt"
      ? [herdrFailure("prompt refused")]
      : failure === "session"
      ? [
        herdr({
          agent: {
            agent_session: {
              value: "11111111-2222-3333-4444-555555555555",
            },
            cwd: "/different-workspace",
          },
        }, {
          onStart: () =>
            writeJsonl(
              codexPath(
                dir.path,
                "11111111-2222-3333-4444-555555555555",
              ),
              [
                codexMeta(
                  "11111111-2222-3333-4444-555555555555",
                  "/different-workspace",
                ),
                ...codexTurn("retry", `${prefix}작업`),
              ],
            ),
        }),
      ]
      : [
        herdr({}, {
          onStart: () => {
            if (failure !== "raw") {
              writeJsonl(path, [
                codexMeta(),
                ...codexTurn("retry", `${prefix}작업`),
              ]);
            }
          },
        }),
        ...(failure === "wait"
          ? [herdr({}), herdrFailure("wait refused")]
          : failure === "blocked"
          ? [herdr({}), herdr({ agent: liveAgent("blocked", 2) })]
          : failure === "raw"
          ? []
          : []),
      ];
    const test = setup(dir.path, "작업", [
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      herdr({ tabs: [] }),
      herdr({
        tab: { tab_id: "tab-delegate" },
        root_pane: { pane_id: "pane-delegate" },
      }),
      herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
      herdrFailure(shellError),
      herdr({}),
      ...afterRetry,
    ], {
      env: { HERDR_ENV: "1" },
      now: () => 0,
      sleep: (_ms) => {
        sleepCalls++;
        if (failure === "raw" && sleepCalls === 2) {
          throw new Error("session lookup exploded");
        }
        return Promise.resolve();
      },
    });

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "1m",
    ], test.deps);

    assertEquals(result.code === 0, false, failure);
    assertStringIncludes(result.stdout, "result: success");
    assertStringIncludes(result.stdout, `message: ${shellError}`);
    if (failure === "blocked") {
      assertStringIncludes(result.stdout, "code: agent_blocked");
      assertStringIncludes(result.stdout, "activity: blocked");
    }
    if (failure === "raw" || failure === "session") {
      assertStringIncludes(
        result.stdout,
        `code: ${
          failure === "raw" ? "agent_failed" : "invalid_native_session"
        }`,
      );
    }
    if (failure === "raw") {
      assertEquals(
        test.fake.calls.filter((call) =>
          call.args[0] === "agent" && call.args[1] === "prompt"
        ).length,
        1,
      );
    }
  }
});

Deno.test("Herdr gate와 정숙 판정은 deadline을 공유하고 중단 시 확인된 session ID를 보존한다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  writeJsonl(path, [codexMeta(), ...codexTurn("old", "이전", "완료")]);
  let now = 0;
  let delayedPromptWritten = false;
  const sleeps: number[] = [];
  const timed = setup(dir.path, "늦은 prompt", [
    herdr({ agents: [] }),
    herdr({ agents: [] }),
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({}),
    herdr({}),
    herdr({ agent_status: "done", state_change_seq: 2 }),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      sleeps.push(ms);
      if (!delayedPromptWritten) {
        appendJsonl(
          path,
          codexTurn("late", `${prefix}늦은 prompt`, "늦은 결과"),
        );
        delayedPromptWritten = true;
      }
      return Promise.resolve();
    },
  });
  const timeout = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
    "--timeout",
    "600ms",
  ], timed.deps);
  assertEquals(timeout.code, 6);
  assertStringIncludes(timeout.stdout, "code: timeout");
  assertStringIncludes(timeout.stdout, `session_id: ${codexId}`);
  assertEquals(now, 600);
  assertEquals(sleeps, [250, 350]);

  const controller = new AbortController();
  const cancelled = setup(dir.path, "", [
    herdr({ agents: [liveAgent("working", 3)] }),
    {
      cmd: "herdr",
      waitForAbort: true,
      onStart: () => controller.abort(),
    },
  ], {
    env: { HERDR_ENV: "1" },
    signal: controller.signal,
  });
  const interrupted = await runDelegate(["wait", codexId], cancelled.deps);
  assertEquals(interrupted.code, 130);
  assertStringIncludes(interrupted.stdout, "code: cancelled");
  assertStringIncludes(interrupted.stdout, `session_id: ${codexId}`);

  const newController = new AbortController();
  const createdId = "55555555-6666-7777-8888-999999999999";
  const createdPath = codexPath(dir.path, createdId);
  const created = setup(dir.path, "신규 중단", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-new" },
      root_pane: { pane_id: "pane-new" },
    }),
    herdr({ tabs: [{ tab_id: "tab-new", label: "caller-new" }] }),
    herdr({}),
    herdr({}, {
      onStart: () =>
        writeJsonl(
          createdPath,
          [
            codexMeta(createdId),
            ...codexTurn("new", `${prefix}신규 중단`),
          ],
        ),
    }),
    herdr({}),
    {
      cmd: "herdr",
      waitForAbort: true,
      onStart: () => newController.abort(),
    },
  ], {
    env: { HERDR_ENV: "1" },
    signal: newController.signal,
  });
  const createdInterrupted = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller-new",
  ], created.deps);
  assertEquals(createdInterrupted.code, 130);
  assertStringIncludes(createdInterrupted.stdout, "code: cancelled");
  assertStringIncludes(createdInterrupted.stdout, `session_id: ${createdId}`);
});

Deno.test("짧은 Herdr prompt 제한 시간은 진행 중인 agent start와 최초 prompt를 중단하고 timeout을 반환한다", async () => {
  for (const stage of ["start", "prompt"] as const) {
    await using dir = await tempDir();
    const controller = new AbortController();
    const responses: FakeResponse[] = [
      ...newTabAllocation(),
      ...(stage === "prompt" ? [herdr({})] : []),
      { cmd: "herdr", waitForAbort: true },
    ];
    const test = setup(dir.path, "작업", responses, {
      env: { HERDR_ENV: "1" },
      signal: controller.signal,
    });
    const safety = setTimeout(() => controller.abort(), 150);

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "20ms",
    ], test.deps);
    clearTimeout(safety);

    assertEquals(result.code, 6, stage);
    assertStringIncludes(result.stdout, "code: timeout", stage);
    const start = test.fake.calls.find((call) => call.args[1] === "start");
    const timeout = Number(start?.args[start.args.indexOf("--timeout") + 1]);
    assertEquals(
      Number.isInteger(timeout) && timeout > 0 && timeout <= 20,
      true,
    );
    assertEquals(
      test.fake.calls.length,
      stage === "start" ? newTabAllocation().length + 1 : 6,
      stage,
    );
  }

  for (
    const scenario of [{ elapsed: 0, expected: 30_000 }, {
      elapsed: 40_000,
      expected: 20_000,
    }]
  ) {
    await using dir = await tempDir();
    let now = 0;
    const allocation = newTabAllocation();
    allocation.at(-1)!.onStart = () => {
      now = scenario.elapsed;
    };
    const test = setup(dir.path, "작업", [
      ...allocation,
      herdrFailure("start refused"),
      herdr({}),
      herdr({ panes: [] }),
      herdr({}),
    ], {
      env: { HERDR_ENV: "1" },
      now: () => now,
    });

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "1m",
    ], test.deps);

    assertEquals(result.code, 5);
    const start = test.fake.calls.find((call) => call.args[1] === "start");
    assertEquals(
      start?.args[start.args.indexOf("--timeout") + 1],
      String(scenario.expected),
    );
  }
});

Deno.test("호출자 중단과 제한 시간이 함께 성립해도 cancelled와 확인된 session ID를 보존한다", async () => {
  for (const simultaneous of [false, true]) {
    await using dir = await tempDir();
    const path = codexPath(dir.path);
    const controller = new AbortController();
    const blocking: FakeResponse = simultaneous
      ? {
        cmd: "herdr",
        waitForAbort: true,
        onStart: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          controller.abort();
        },
      }
      : { cmd: "herdr", waitForAbort: true };
    const test = setup(dir.path, "작업", [
      ...newTabAllocation(),
      herdr({}),
      herdr({}, {
        onStart: () =>
          writeJsonl(path, [
            codexMeta(),
            ...codexTurn("turn", `${prefix}작업`),
          ]),
      }),
      blocking,
    ], {
      env: { HERDR_ENV: "1" },
      signal: controller.signal,
    });
    const safety = simultaneous
      ? undefined
      : setTimeout(() => controller.abort(), 150);

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "20ms",
    ], test.deps);
    if (safety != null) clearTimeout(safety);

    assertEquals(result.code, simultaneous ? 130 : 6);
    assertStringIncludes(
      result.stdout,
      `code: ${simultaneous ? "cancelled" : "timeout"}`,
    );
    assertStringIncludes(result.stdout, `session_id: ${codexId}`);
    assertEquals(test.fake.calls.length, 7);
  }
});

Deno.test("rename 또는 성공 후 자동 정리 중 중단되면 성공이나 warning이 아닌 중단 오류를 반환한다", async () => {
  for (
    const scenario of [
      { stage: "rename-command", interruption: "cancelled" },
      { stage: "rename-pause", interruption: "timeout" },
      { stage: "cleanup-lock", interruption: "timeout" },
      { stage: "cleanup-query", interruption: "timeout" },
      { stage: "cleanup-close", interruption: "cancelled" },
    ] as const
  ) {
    await using dir = await tempDir();
    const path = codexPath(dir.path);
    const controller = new AbortController();
    const responses = completedUntilPostProcessing(path, `${prefix}작업`);
    let cleanupLock: Deno.FsFile | undefined;
    let cleanupLockAcquired = false;
    if (scenario.stage === "cleanup-lock") {
      responses.at(-1)!.onStart = async () => {
        cleanupLock = await Deno.open(
          `${join(dir.path, "herdr.sock")}.delegate-pane.lock`,
          { create: true, read: true, write: true },
        );
        await cleanupLock.lock(true);
        cleanupLockAcquired = true;
      };
    }
    if (scenario.stage.startsWith("rename")) {
      responses.push(
        scenario.stage === "rename-command"
          ? {
            cmd: "herdr",
            waitForAbort: true,
            onStart: () => controller.abort(),
          }
          : herdr({}),
        ...successfulCleanup(),
      );
    } else if (scenario.stage !== "cleanup-lock") {
      responses.push(
        ...(scenario.stage === "cleanup-query"
          ? [{ cmd: "herdr", waitForAbort: true } satisfies FakeResponse]
          : [
            herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
            herdr({
              panes: [{
                pane_id: "pane-delegate",
                tab_id: "tab-delegate",
                agent: liveAgent("done", 2).name,
                agent_status: "done",
              }],
            }),
            {
              cmd: "herdr",
              waitForAbort: true,
              onStart: () => controller.abort(),
            },
          ]),
      );
    }
    let sleepCalls = 0;
    const test = setup(dir.path, "작업", responses, {
      env: {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: join(dir.path, "herdr.sock"),
      },
      signal: controller.signal,
      sleep: (_ms, signal) => {
        sleepCalls++;
        if (scenario.stage !== "rename-pause" || sleepCalls === 1) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      },
    });
    const safety = ["cleanup-lock", "cleanup-query"].includes(scenario.stage)
      ? setTimeout(() => controller.abort(), 150)
      : undefined;

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      ...(scenario.stage.startsWith("rename") ? ["--name", "표시"] : []),
      "--timeout",
      "20ms",
    ], test.deps);
    if (safety != null) clearTimeout(safety);
    if (cleanupLock != null) {
      await cleanupLock.unlock();
      cleanupLock.close();
    }

    assertEquals(
      result.code,
      scenario.interruption === "cancelled" ? 130 : 6,
      scenario.stage,
    );
    assertStringIncludes(result.stdout, `code: ${scenario.interruption}`);
    assertStringIncludes(result.stdout, `session_id: ${codexId}`);
    assertEquals(result.stdout.includes("warnings:"), false, scenario.stage);
    assertEquals(
      scenario.stage.startsWith("rename")
        ? test.fake.calls.some((call) =>
          call.args.some((arg) => arg.startsWith("/rename "))
        )
        : scenario.stage === "cleanup-lock"
        ? cleanupLockAcquired
        : scenario.stage === "cleanup-query"
        ? test.fake.calls.filter((call) =>
          call.args.join(" ") === "tab list --workspace ws-1"
        ).length === 3
        : test.fake.calls.some((call) =>
          call.args.join(" ") === "pane close pane-delegate"
        ),
      true,
      scenario.stage,
    );
    assertEquals(
      test.fake.calls.length,
      {
        "rename-command": 10,
        "rename-pause": 10,
        "cleanup-lock": 9,
        "cleanup-query": 10,
        "cleanup-close": 12,
      }[scenario.stage],
      scenario.stage,
    );
  }
});

Deno.test("agent start 또는 최초 prompt가 실패하면 이번 호출이 만든 pane과 탭만 정리하고 원래 오류를 반환한다", async () => {
  for (const allocation of ["tab", "pane"] as const) {
    for (const stage of ["start", "prompt"] as const) {
      await using dir = await tempDir();
      const shellError =
        "agent target pane pane-delegate is not an available shell";
      const original = stage === "start" ? "retry refused" : "prompt refused";
      const responses: FakeResponse[] = [
        ...(allocation === "tab" ? newTabAllocation() : splitPaneAllocation()),
        ...(stage === "start"
          ? [herdrFailure(shellError), herdrFailure(original)]
          : [herdr({}), herdrFailure(original)]),
        herdr({}),
        ...(allocation === "tab" ? [herdr({ panes: [] }), herdr({})] : []),
      ];
      const test = setup(dir.path, "작업", responses, {
        env: { HERDR_ENV: "1" },
        now: () => 0,
        sleep: () => Promise.resolve(),
      });

      const result = await runDelegate([
        "prompt",
        "--agent",
        "codex",
        "--caller-id",
        "caller",
      ], test.deps);

      assertEquals(result.code, 5, `${allocation}-${stage}`);
      assertStringIncludes(result.stdout, `message: ${original}`);
      if (stage === "start") {
        assertStringIncludes(result.stdout, "result: failed");
        assertStringIncludes(result.stdout, `message: ${shellError}`);
      }
      assertEquals(
        test.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
          call.args
        ),
        allocation === "tab"
          ? [["pane", "close", "pane-delegate"], [
            "tab",
            "close",
            "tab-delegate",
          ]]
          : [["pane", "close", "pane-delegate"]],
        `${allocation}-${stage}`,
      );
      if (allocation === "tab") {
        assertEquals(
          test.fake.calls.slice(-3).map((call) => call.args),
          [["pane", "close", "pane-delegate"], [
            "pane",
            "list",
            "--workspace",
            "ws-1",
          ], ["tab", "close", "tab-delegate"]],
          stage,
        );
      }
    }
  }
});

Deno.test("실패 복구 정리가 실패하거나 기존 pane을 재사용해도 원래 오류를 보존하고 소유하지 않은 자원은 닫지 않는다", async () => {
  for (const cleanupFailure of ["ordinary", "cancelled", "timeout"] as const) {
    await using dir = await tempDir();
    const controller = new AbortController();
    const cleanupResponse: FakeResponse = cleanupFailure === "ordinary"
      ? herdrFailure("close refused")
      : {
        cmd: "herdr",
        waitForAbort: true,
        ...(cleanupFailure === "cancelled"
          ? { onStart: () => controller.abort() }
          : {}),
      };
    const test = setup(dir.path, "작업", [
      ...newTabAllocation(),
      herdr({}),
      herdrFailure("prompt refused"),
      cleanupResponse,
      ...(cleanupFailure === "ordinary"
        ? [herdr({ panes: [] }), herdr({})]
        : []),
    ], {
      env: { HERDR_ENV: "1" },
      signal: controller.signal,
    });
    const safety = cleanupFailure === "timeout"
      ? setTimeout(() => controller.abort(), 150)
      : undefined;

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      "--timeout",
      "20ms",
    ], test.deps);
    if (safety != null) clearTimeout(safety);

    assertEquals(result.code, 5, cleanupFailure);
    assertStringIncludes(result.stdout, "message: prompt refused");
    assertEquals(
      test.fake.calls.slice(6).map((call) => call.args),
      cleanupFailure === "ordinary"
        ? [["pane", "close", "pane-delegate"], [
          "pane",
          "list",
          "--workspace",
          "ws-1",
        ], ["tab", "close", "tab-delegate"]]
        : [["pane", "close", "pane-delegate"]],
      cleanupFailure,
    );
  }

  await using sharedDir = await tempDir();
  const shared = setup(sharedDir.path, "작업", [
    ...newTabAllocation(),
    herdr({}),
    herdrFailure("prompt refused"),
    herdr({}),
    herdr({
      panes: [{
        pane_id: "pane-other",
        tab_id: "tab-delegate",
        agent: "other-agent",
        agent_status: "working",
      }],
    }),
  ], { env: { HERDR_ENV: "1" } });
  const sharedResult = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], shared.deps);
  assertEquals(sharedResult.code, 5);
  assertStringIncludes(sharedResult.stdout, "message: prompt refused");
  assertEquals(
    shared.fake.calls.slice(6).map((call) => call.args),
    [["pane", "close", "pane-delegate"], [
      "pane",
      "list",
      "--workspace",
      "ws-1",
    ]],
  );

  await using dir = await tempDir();
  const reused = setup(dir.path, "작업", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: null,
      }],
    }),
    herdrFailure("start refused"),
  ], { env: { HERDR_ENV: "1" } });
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], reused.deps);
  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "message: start refused");
  assertEquals(
    reused.fake.calls.some((call) => call.args[1] === "close"),
    false,
  );
});

Deno.test("Claude Herdr 시작은 caller 표시 이름을 적용하고 live 이름 변경과 wait 이름 변경을 거부한다", async () => {
  await using dir = await tempDir();
  const path = claudePath(dir.path);
  const test = setup(dir.path, "화면 작업", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller-claude" }] }),
    herdr({}),
    herdr({}, {
      onStart: () =>
        writeJsonl(path, [
          ...claudeOpen(`${prefix}화면 작업`),
          {
            type: "assistant",
            sessionId: claudeId,
            cwd,
            requestId: "req-final",
            isSidechain: false,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "완료" }],
            },
          },
          {
            type: "system",
            subtype: "turn_duration",
            sessionId: claudeId,
            cwd,
            timestamp: "2026-09-16T00:00:01Z",
          },
        ]),
    }),
    herdr({}),
    herdr({ agent: claudeLive("done", 2) }),
    herdr({ agent: claudeLive("done", 2) }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller-claude" }] }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: claudeLive("done", 2).name,
        agent_status: "done",
      }],
    }),
    herdr({}),
    herdr({}),
  ], { env: { HERDR_ENV: "1" } });

  const started = await runDelegate([
    "prompt",
    "--agent",
    "claude",
    "--caller-id",
    "caller-claude",
    "--name",
    "화면",
  ], test.deps);
  assertEquals(started.code, 0);
  assertStringIncludes(started.stdout, "\n\n완료\n");
  const start = test.fake.calls.find((call) => call.args[1] === "start");
  assertEquals(start?.args.includes("--name=caller-claude 화면"), true);

  const conflictSetup = setup(dir.path, "후속", [
    herdr({ agents: [claudeLive("idle", 3)] }),
  ], { env: { HERDR_ENV: "1" } });
  const conflict = await runDelegate([
    "prompt",
    claudeId,
    "--caller-id",
    "caller-claude",
    "--name",
    "새 이름",
  ], conflictSetup.deps);
  assertEquals(conflict.code, 2);
  assertStringIncludes(conflict.stdout, "code: live_option_conflict");

  const waitName = await runDelegate([
    "wait",
    claudeId,
    "--name",
    "새 이름",
  ], conflictSetup.deps);
  assertEquals(waitName.code, 2);
  assertStringIncludes(waitName.stdout, "code: usage");
  assertEquals(conflictSetup.fake.calls.length, 1);
});

Deno.test("직접 실행의 spawn 실패·timeout·사용자 중단은 공개 오류와 확인된 session ID를 보존한다", async () => {
  await using dir = await tempDir();
  const failed = setup(dir.path, "작업", [{
    cmd: "codex",
    onStart: () => {
      throw new Deno.errors.NotFound("missing");
    },
  }]);
  const spawn = await runDelegate([
    "prompt",
    "--transport",
    "direct",
    "--agent",
    "codex",
  ], failed.deps);
  assertEquals(spawn.code, 5);
  assertStringIncludes(spawn.stdout, "code: agent_failed");

  const timeout = setup(dir.path, "작업", [{
    cmd: "codex",
    waitForAbort: true,
    stdout: `{"type":"thread.started","thread_id":"${codexId}"}\n`,
  }]);
  const timedOut = await runDelegate([
    "prompt",
    "--transport",
    "direct",
    "--agent",
    "codex",
    "--timeout",
    "1ms",
  ], timeout.deps);
  assertEquals(timedOut.code, 6);
  assertStringIncludes(timedOut.stdout, "code: timeout");
  assertStringIncludes(timedOut.stdout, codexId);

  const controller = new AbortController();
  const cancelled = setup(dir.path, "작업", [{
    cmd: "codex",
    waitForAbort: true,
    stdout: `{"type":"thread.started","thread_id":"${codexId}"}\n`,
    onStart: () => controller.abort(),
  }], { signal: controller.signal });
  const interrupted = await runDelegate([
    "prompt",
    "--transport",
    "direct",
    "--agent",
    "codex",
  ], cancelled.deps);
  assertEquals(interrupted.code, 130);
  assertStringIncludes(interrupted.stdout, "code: cancelled");
  assertStringIncludes(interrupted.stdout, codexId);
});

Deno.test("Windows에서 HOME과 사용자 프로필이 달라도 사용자는 기본 프로필의 native session 상태를 확인한다", async () => {
  await using dir = await tempDir();
  const home = join(dir.path, "home");
  const profile = join(dir.path, "profile");
  const path = join(
    profile,
    ".codex",
    "sessions",
    "2026",
    "09",
    "16",
    `rollout-anon-${codexId}.jsonl`,
  );
  writeJsonl(path, [
    codexMeta(),
    ...codexTurn("turn-1", "사람 요청", "최종 답변"),
  ]);
  const base = setup(dir.path, "");
  const env: Record<string, string> = {
    ...base.deps.env,
    OS: "Windows_NT",
    HOME: home,
    USERPROFILE: profile,
  };
  delete env.CODEX_HOME;

  const result = await runDelegate(["status", codexId], {
    ...base.deps,
    env,
  });

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, `session_id: ${codexId}`);
  assertStringIncludes(result.stdout, "agent: codex");
});

Deno.test("코덱스 native fixture는 완료 대화와 부분 record를 보존한다", async () => {
  await using dir = await tempDir();
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("turn-1", "사람 요청", "최종 답변"),
    ...codexTurn("turn-2", "취소 요청", undefined, "aborted"),
  ], '{"type":"response_item"');
  const snapshot = await findNativeSession(
    codexId,
    setup(dir.path, "", [], {
      env: {
        OS: "Windows_NT",
        USERPROFILE: join(dir.path, "other-profile"),
      },
    }).deps.env,
  );
  assertEquals(snapshot.cursor.partial, true);
  assertStringIncludes(renderConversation(snapshot), "사람 요청");
  assertStringIncludes(renderConversation(snapshot), "최종 답변");
  assertEquals(
    renderConversation(snapshot).includes("bootstrap은 무시"),
    false,
  );
  assertEquals(renderConversation(snapshot).includes("secret"), false);
});

Deno.test("클로드 native fixture는 사람 prompt와 마지막 도구 없는 assistant group만 완료 대화로 렌더한다", async () => {
  await using dir = await tempDir();
  writeJsonl(claudePath(dir.path), [{
    type: "user",
    sessionId: claudeId,
    cwd,
    uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    origin: { kind: "human" },
    promptSource: "typed",
    userType: "external",
    isSidechain: false,
    message: { role: "user", content: `${prefix}클로드 요청` },
  }, {
    type: "assistant",
    sessionId: claudeId,
    cwd,
    requestId: "req-tool",
    isSidechain: false,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "중간 설명" }, {
        type: "tool_use",
        id: "tool-1",
      }],
    },
  }, {
    type: "user",
    sessionId: claudeId,
    cwd,
    uuid: "tool-result",
    toolUseResult: { value: "secret" },
    message: {
      role: "user",
      content: [{ type: "tool_result", content: "secret" }],
    },
  }, {
    type: "assistant",
    sessionId: claudeId,
    cwd,
    requestId: "req-final",
    isSidechain: false,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "최종 답변" }],
    },
  }, {
    type: "system",
    subtype: "turn_duration",
    sessionId: claudeId,
    cwd,
    timestamp: "2026-09-16T00:00:01Z",
  }]);
  const snapshot = await findNativeSession(
    claudeId,
    setup(dir.path, "").deps.env,
  );
  assertEquals(snapshot.agent, "claude");
  const rendered = renderConversation(snapshot);
  assertStringIncludes(rendered, "클로드 요청");
  assertStringIncludes(rendered, "최종 답변");
  assertEquals(rendered.includes("중간 설명"), false);
  assertEquals(rendered.includes("secret"), false);
});

Deno.test("native 탐색은 잘못된 ID·중간 JSONL 손상·root 밖 symlink·복수 후보를 fail closed한다", async () => {
  await using dir = await tempDir();
  const env = setup(dir.path, "").deps.env;
  const invalid = await runDelegate(
    ["status", "not-a-session"],
    setup(dir.path, "").deps,
  );
  assertEquals(invalid.code, 2);
  assertStringIncludes(invalid.stdout, "code: invalid_session_id");

  writeJsonl(codexPath(dir.path), [codexMeta()]);
  Deno.writeTextFileSync(codexPath(dir.path), "not-json\n", { append: true });
  const corrupt = await runDelegate(
    ["status", codexId],
    setup(dir.path, "").deps,
  );
  assertEquals(corrupt.code, 5);
  assertStringIncludes(corrupt.stdout, "code: invalid_native_session");

  Deno.removeSync(join(dir.path, "codex"), { recursive: true });
  const outside = join(dir.path, "outside.jsonl");
  writeJsonl(outside, [codexMeta()]);
  const linked = codexPath(dir.path);
  Deno.mkdirSync(join(linked, ".."), { recursive: true });
  Deno.symlinkSync(outside, linked);
  const unsafe = await runDelegate(
    ["status", codexId],
    setup(dir.path, "").deps,
  );
  assertEquals(unsafe.code, 5);
  assertStringIncludes(unsafe.stdout, "code: unsafe_native_path");

  Deno.removeSync(join(dir.path, "codex"), { recursive: true });
  writeJsonl(codexPath(dir.path), [codexMeta()]);
  writeJsonl(
    join(
      dir.path,
      "codex",
      "sessions",
      "other",
      `rollout-other-${codexId}.jsonl`,
    ),
    [codexMeta()],
  );
  const ambiguous = await runDelegate(
    ["status", codexId],
    setup(dir.path, "").deps,
  );
  assertEquals(ambiguous.code, 5);
  assertStringIncludes(ambiguous.stdout, "code: session_ambiguous");
  assertEquals(env.CODEX_HOME, join(dir.path, "codex"));
});

Deno.test("blocked 후보는 정숙 시간을 기다리지 않고 agent_blocked로 끝난다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  const sent = `${prefix}승인 필요`;
  let sleeps = 0;
  const test = setup(dir.path, "승인 필요", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({}),
    herdr({}, {
      onStart: () => writeJsonl(path, [codexMeta(), ...codexTurn("t", sent)]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("blocked", 2) }),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => 0,
    sleep: () => {
      sleeps++;
      return Promise.resolve();
    },
  });
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 4);
  assertStringIncludes(result.stdout, "code: agent_blocked");
  assertStringIncludes(result.stdout, "activity: blocked");
  assertEquals(sleeps, 0);
});

Deno.test("이름이 바뀐 탭이나 blocker가 남은 탭은 주 결과를 성공으로 유지하고 어떤 pane도 자동 정리하지 않는다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  const sent = `${prefix}작업`;
  let now = 0;
  const test = setup(dir.path, "작업", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({}),
    herdr({}, {
      onStart: () =>
        writeJsonl(path, [codexMeta(), ...codexTurn("t", sent, "완료")]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "renamed-by-user" }] }),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "\n\n완료\n");
  assertStringIncludes(result.stdout, "code: unmanaged_tab");
  assertEquals(test.fake.calls.some((call) => call.args[1] === "close"), false);
});

Deno.test("작업 중 사람이 프롬프트를 추가하면 접두사 없는 중간 프롬프트와 최신 결과를 반환한다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  const sent = `${prefix}첫 요청`;
  let now = 0;
  let sleeps = 0;
  const test = setup(dir.path, "첫 요청", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({}),
    herdr({}, {
      onStart: () =>
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("turn-1", sent, "첫 결과"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 1) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: liveAgent("done", 2).name,
        agent_status: "done",
      }],
    }),
    herdr({}),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      sleeps++;
      if (sleeps === 1) {
        appendJsonl(
          path,
          codexTurn("turn-2", `${prefix}수동 요청`, "최신 결과"),
        );
      }
      return Promise.resolve();
    },
  });
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 0);
  assertStringIncludes(
    result.stdout,
    "intervening_prompts:\n  - 수동 요청",
  );
  assertEquals(result.stdout.includes(prefix), false);
  assertStringIncludes(result.stdout, "\n\n최신 결과\n");
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "wait").length,
    2,
  );
  assertEquals(sleeps, 2);
});

Deno.test("같은 cwd에서 동시에 생긴 native session은 전체 prompt exact match로만 식별한다", async () => {
  await using dir = await tempDir();
  const env = setup(dir.path, "").deps.env;
  const baseline = await captureBaseline(env, "codex");
  const invalidId = "22222222-3333-4444-5555-666666666666";
  const invalidPath = codexPath(dir.path, invalidId);
  Deno.mkdirSync(join(invalidPath, ".."), { recursive: true });
  Deno.writeTextFileSync(invalidPath, "not-json\n");
  const invalidSchemaId = "33333333-4444-5555-6666-777777777777";
  writeJsonl(codexPath(dir.path, invalidSchemaId), [{
    type: "session_meta",
    payload: { id: invalidSchemaId },
  }]);
  const unsafeId = "44444444-5555-6666-7777-888888888888";
  const outside = join(dir.path, "outside-candidate.jsonl");
  writeJsonl(outside, [codexMeta(unsafeId)]);
  Deno.symlinkSync(outside, codexPath(dir.path, unsafeId));
  const otherId = "11111111-2222-3333-4444-555555555555";
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("one", `${prefix}첫 병렬 요청`),
  ]);
  writeJsonl(codexPath(dir.path, otherId), [
    codexMeta(otherId),
    ...codexTurn("two", `${prefix}둘째 병렬 요청`),
  ]);
  const selected = await identifyPromptSession(
    env,
    "codex",
    baseline,
    `${prefix}둘째 병렬 요청`,
  );
  assertEquals(selected?.sessionId, otherId);

  const thirdId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  writeJsonl(codexPath(dir.path, thirdId), [
    codexMeta(thirdId),
    ...codexTurn("three", `${prefix}같은 요청`),
  ]);
  const fourthId = "99999999-8888-7777-6666-555555555555";
  writeJsonl(codexPath(dir.path, fourthId), [
    codexMeta(fourthId),
    ...codexTurn("four", `${prefix}같은 요청`),
  ]);
  try {
    await identifyPromptSession(env, "codex", baseline, `${prefix}같은 요청`);
    throw new Error("모호한 session을 선택했습니다");
  } catch (error) {
    assertStringIncludes(String(error), "후보가 복수");
  }
});

Deno.test("Herdr live 조회가 모호하면 두 번째 native writer를 시작하거나 prompt하지 않는다", async () => {
  await using dir = await tempDir();
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("old", "old", "done"),
  ]);
  const first = liveAgent("working", 1);
  const second = {
    ...liveAgent("idle", 2),
    name: "duplicate",
    pane_id: "pane-2",
  };
  const test = setup(dir.path, "후속", [herdr({ agents: [first, second] })], {
    env: { HERDR_ENV: "1" },
  });
  const result = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "code: live_session_ambiguous");
  assertEquals(test.fake.calls.length, 1);
  assertEquals(test.fake.calls[0]?.args, ["agent", "list"]);
});

Deno.test("명시적 close는 target만 취소·정리하고 남은 active pane을 구조화된 blocker로 반환한다", async () => {
  await using dir = await tempDir();
  writeJsonl(codexPath(dir.path), [codexMeta(), ...codexTurn("old", "old")]);
  const test = setup(dir.path, "", [
    herdr({ agents: [liveAgent("working", 1)] }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({}),
    herdr({ agent: liveAgent("idle", 2) }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: liveAgent("idle", 2).name,
        agent_status: "idle",
      }, {
        pane_id: "pane-other",
        tab_id: "tab-delegate",
        agent: "other-agent",
        agent_status: "working",
      }, {
        pane_id: "pane-terminal",
        tab_id: "tab-delegate",
        agent: null,
      }],
    }),
    herdr({}),
  ], { env: { HERDR_ENV: "1" } });
  const result = await runDelegate([
    "close",
    codexId,
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 4);
  assertStringIncludes(result.stdout, "code: tab_close_blocked");
  assertStringIncludes(result.stdout, "pane_id: pane-other");
  assertStringIncludes(result.stdout, "pane_id: pane-terminal");
  assertEquals(
    test.fake.calls.some((call) =>
      call.args.join(" ") === "pane close pane-delegate"
    ),
    true,
  );
  assertEquals(
    test.fake.calls.some((call) =>
      call.args.join(" ") === "pane close pane-other"
    ),
    false,
  );
});

Deno.test("다른 작업의 정리가 끝나지 않으면 닫기 요청은 60초 뒤 제한 시간 초과를 알린다", async () => {
  await using dir = await tempDir();
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("old", "old", "done"),
  ]);
  const socketPath = join(dir.path, "herdr.sock");
  const lock = await Deno.open(`${socketPath}.delegate-pane.lock`, {
    create: true,
    read: true,
    write: true,
  });
  await lock.lock(true);
  let now = 0;
  const test = setup(dir.path, "", [
    herdr({ agents: [liveAgent("done", 1)] }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
  ], {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });

  try {
    const result = await runDelegate([
      "close",
      codexId,
      "--caller-id",
      "caller",
    ], test.deps);
    assertEquals(result.code, 6);
    assertStringIncludes(result.stdout, "code: timeout");
    assertEquals(now, 60_000);
  } finally {
    await lock.unlock();
    lock.close();
  }
});

Deno.test("자동 cleanup은 다른 active pane을 모두 보고하고 target pane도 건드리지 않은 채 주 결과를 유지한다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  let now = 0;
  const test = setup(dir.path, "작업", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({}),
    herdr({}, {
      onStart: () =>
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("t", `${prefix}작업`, "완료"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: liveAgent("done", 2).name,
        agent_status: "done",
      }, {
        pane_id: "pane-working",
        tab_id: "tab-delegate",
        agent: "other",
        agent_status: "working",
      }, {
        pane_id: "pane-unknown",
        tab_id: "tab-delegate",
        agent: null,
      }],
    }),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "\n\n완료\n");
  assertStringIncludes(result.stdout, "code: tab_close_blocked");
  assertStringIncludes(result.stdout, "pane_id: pane-working");
  assertStringIncludes(result.stdout, "pane_id: pane-unknown");
  assertEquals(test.fake.calls.some((call) => call.args[1] === "close"), false);
});

Deno.test("완료된 작업의 마지막 관리 pane을 닫으며 탭이 함께 사라져도 정리 경고 없이 결과를 반환한다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  let now = 0;
  const test = setup(dir.path, "작업", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({}),
    herdr({}, {
      onStart: () =>
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("t", `${prefix}작업`, "완료"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({
      panes: [{
        pane_id: "pane-delegate",
        tab_id: "tab-delegate",
        agent: liveAgent("done", 2).name,
        agent_status: "done",
      }],
    }),
    herdr({}),
    herdr({}, {
      code: 1,
      stderr: JSON.stringify({
        error: {
          code: "herdr_failed",
          message: "tab tab-delegate not found",
        },
      }),
    }),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "\n\n완료\n");
  assertEquals(result.stdout.includes("warnings:"), false);
  assertEquals(
    test.fake.calls.slice(-2).map((call) => call.args),
    [["pane", "close", "pane-delegate"], ["tab", "close", "tab-delegate"]],
  );
});

Deno.test("완료된 작업의 자동 정리가 실패하면 cleanup_failed 경고와 원인을 남긴다", async () => {
  const scenarios = [{
    name: "pane close 실패",
    closeResponses: [
      herdr({}, {
        code: 1,
        stderr: JSON.stringify({
          error: { code: "herdr_failed", message: "pane close refused" },
        }),
      }),
    ],
    cause: "pane close refused",
    closeCalls: [["pane", "close", "pane-delegate"]],
  }, {
    name: "tab close 다른 실패",
    closeResponses: [
      herdr({}),
      herdr({}, {
        code: 1,
        stderr: JSON.stringify({
          error: {
            code: "herdr_failed",
            message: "tab tab-delegate has active panes",
          },
        }),
      }),
    ],
    cause: "tab tab-delegate has active panes",
    closeCalls: [
      ["pane", "close", "pane-delegate"],
      ["tab", "close", "tab-delegate"],
    ],
  }];

  for (const scenario of scenarios) {
    await using dir = await tempDir();
    const path = codexPath(dir.path);
    let now = 0;
    const test = setup(dir.path, "작업", [
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      herdr({ tabs: [] }),
      herdr({
        tab: { tab_id: "tab-delegate" },
        root_pane: { pane_id: "pane-delegate" },
      }),
      herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
      herdr({}),
      herdr({}, {
        onStart: () =>
          writeJsonl(path, [
            codexMeta(),
            ...codexTurn("t", `${prefix}작업`, "완료"),
          ]),
      }),
      herdr({}),
      herdr({ agent: liveAgent("done", 2) }),
      herdr({ agent: liveAgent("done", 2) }),
      herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
      herdr({
        panes: [{
          pane_id: "pane-delegate",
          tab_id: "tab-delegate",
          agent: liveAgent("done", 2).name,
          agent_status: "done",
        }],
      }),
      ...scenario.closeResponses,
    ], {
      env: { HERDR_ENV: "1" },
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);
    assertEquals(result.code, 0, scenario.name);
    assertStringIncludes(result.stdout, "\n\n완료\n", scenario.name);
    assertStringIncludes(result.stdout, "code: cleanup_failed", scenario.name);
    assertStringIncludes(result.stdout, scenario.cause, scenario.name);
    assertEquals(
      test.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
        call.args
      ),
      scenario.closeCalls,
      scenario.name,
    );
  }
});

Deno.test("live session의 시작 옵션은 writer를 건드리기 전에 충돌로 거부하고 stopped write는 확인을 요구한다", async () => {
  await using dir = await tempDir();
  writeJsonl(codexPath(dir.path), [codexMeta(), ...codexTurn("old", "old")]);
  const live = setup(dir.path, "후속", [
    herdr({ agents: [liveAgent("idle", 1)] }),
  ], {
    env: { HERDR_ENV: "1" },
  });
  const conflict = await runDelegate([
    "prompt",
    codexId,
    "--effort",
    "medium",
    "--caller-id",
    "caller",
  ], live.deps);
  assertEquals(conflict.code, 2);
  assertStringIncludes(conflict.stdout, "code: live_option_conflict");
  assertEquals(live.fake.calls.length, 1);

  const stopped = setup(dir.path, "후속", [herdr({ agents: [] })], {
    env: { HERDR_ENV: "1" },
  });
  const escalation = await runDelegate([
    "prompt",
    codexId,
    "--permission",
    "write",
    "--caller-id",
    "caller",
  ], stopped.deps);
  assertEquals(escalation.code, 4);
  assertStringIncludes(escalation.stdout, "code: permission_escalation");
  assertEquals(stopped.fake.calls.length, 1);
});

Deno.test("직접 실행 자식 환경에서는 모든 HERDR 변수를 제거한다", async () => {
  await using dir = await tempDir();
  const test = setup(dir.path, "작업", [{
    cmd: "codex",
    stdout: `{"type":"thread.started","thread_id":"${codexId}"}\n` +
      '{"type":"item.completed","item":{"type":"agent_message","text":"완료"}}\n',
  }], {
    env: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "private-workspace",
      KEEP_ME: "yes",
    },
  });
  const result = await runDelegate([
    "prompt",
    "--transport",
    "direct",
    "--agent",
    "codex",
  ], test.deps);
  assertEquals(result.code, 0);
  assertEquals(test.fake.calls[0]?.env.KEEP_ME, "yes");
  assertEquals(
    Object.keys(test.fake.calls[0]?.env ?? {}).some((key) =>
      key.startsWith("HERDR_")
    ),
    false,
  );
});

Deno.test("삭제된 명령과 옵션·위치 prompt·확인 없는 write 재개는 실행 전에 거부된다", async () => {
  await using dir = await tempDir();
  const base = setup(dir.path, "작업");
  for (
    const args of [
      ["run"],
      ["resume", codexId],
      ["prompt", "위치 본문", "추가 본문"],
      ["prompt", "--keep"],
    ]
  ) {
    const result = await runDelegate(args, base.deps);
    assertEquals(result.code, 2);
    assertStringIncludes(result.stdout, "code: usage");
  }
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("t", "old", "done"),
  ]);
  const escalation = await runDelegate([
    "prompt",
    codexId,
    "--transport",
    "direct",
    "--permission",
    "write",
  ], base.deps);
  assertEquals(escalation.code, 4);
  assertStringIncludes(escalation.stdout, "code: permission_escalation");
  assertEquals(base.fake.calls, []);
});

Deno.test("Herdr 연결 위치가 없거나 상대 경로이면 위임을 시작하지 않는다", async () => {
  await using dir = await tempDir();
  for (const socketPath of ["", "relative/herdr.sock"]) {
    const test = setup(dir.path, "작업", [], {
      env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
    });
    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);
    assertEquals(result.code, 3);
    assertStringIncludes(result.stdout, "code: transport_unavailable");
    assertEquals(test.fake.calls, []);
  }
});

Deno.test("공개 오류는 명세의 종료 코드로만 매핑된다", () => {
  const cases = {
    usage: 2,
    invalid_session_id: 2,
    live_option_conflict: 2,
    permission_escalation: 4,
    transport_unavailable: 3,
    caller_session_unavailable: 3,
    session_not_found: 3,
    session_ambiguous: 5,
    live_session_ambiguous: 5,
    session_id_unavailable: 5,
    session_id_changed: 5,
    unsafe_native_path: 5,
    invalid_native_session: 5,
    agent_failed: 5,
    herdr_failed: 5,
    agent_blocked: 4,
    unmanaged_tab: 4,
    tab_close_blocked: 4,
    cleanup_failed: 5,
    timeout: 6,
    cancelled: 130,
  } as const;
  for (const [code, expected] of Object.entries(cases)) {
    assertEquals(exitCode(code as keyof typeof cases), expected);
  }
});

Deno.test("자식이 stdin을 읽기 전에 종료돼도 stdout과 종료 상태를 회수한다", async () => {
  const result = await denoExec("git", ["--version"], {
    cwd: Deno.cwd(),
    env: { PATH: Deno.env.get("PATH") ?? "" },
    stdin: "x".repeat(1_000_000),
  });
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "git version");
});
