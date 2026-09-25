import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import { runDelegate } from "./delegate.ts";
import { exitCode } from "./document.ts";
import { fakeExec, type FakeResponse } from "./fakes.ts";
import { findNativeSession, renderConversation } from "./native_session.ts";
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
  userMessages: {
    before?: string[];
    after?: string[];
    metadataPrompt?: boolean;
  } = {},
) {
  const userMessage = (text: string, metadata = false) => ({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      ...(metadata
        ? {
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["user.text"],
          },
        }
        : {}),
    },
  });
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
    ...(userMessages.before ?? []).map((text) => userMessage(text)),
    userMessage(prompt, userMessages.metadataPrompt),
    ...(userMessages.after ?? []).map((text) => userMessage(text)),
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
  return herdrError("herdr_failed", message);
}

function herdrError(code: string, message: string): FakeResponse {
  return {
    cmd: "herdr",
    code: 1,
    stderr: JSON.stringify({ error: { code, message } }),
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
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent: currentAgent("working", 1) }, {
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
  return [herdr({})];
}

function liveAgent(
  status: string,
  sequence: number,
  id = codexId,
  sessionCwd = cwd,
) {
  return {
    name: `dlg-${id.replaceAll("-", "").slice(0, 28)}`,
    agent_kind: "codex",
    cwd: sessionCwd,
    agent_status: status,
    state_change_seq: sequence,
    agent_session: { kind: "id", value: id },
    workspace_id: "ws-1",
    tab_id: "tab-delegate",
    pane_id: "pane-delegate",
  };
}

function currentAgent(
  status: string,
  sequence: number,
  id = codexId,
  sessionCwd = cwd,
) {
  return {
    agent_kind: "codex",
    cwd: sessionCwd,
    agent_status: status,
    state_change_seq: sequence,
    agent_session: { kind: "id", value: id },
  };
}

function unidentifiedAgent(status: string, sequence: number) {
  return {
    agent_kind: "codex",
    cwd,
    agent_status: status,
    state_change_seq: sequence,
  };
}

function claudeLive(status: string, sequence: number, id = claudeId) {
  return {
    name: `dlg-${id.replaceAll("-", "").slice(0, 28)}`,
    agent: "claude",
    cwd,
    agent_status: status,
    state_change_seq: sequence,
    agent_session: { kind: "id", value: id },
    workspace_id: "ws-1",
    tab_id: "tab-delegate",
    pane_id: "pane-delegate",
  };
}

function currentClaude(status: string, sequence: number) {
  return {
    agent: "claude",
    cwd,
    agent_status: status,
    state_change_seq: sequence,
    agent_session: { kind: "id", value: claudeId },
  };
}

function unidentifiedClaude(status: string, sequence: number) {
  return {
    agent: "claude",
    cwd,
    agent_status: status,
    state_change_seq: sequence,
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
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: options.onAgentStart,
    }),
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: () =>
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("turn", prompt, "완료"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({}, { onStart: options.onCleanupStart }),
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
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: async () => {
        firstStart.resolve();
        await releaseFirst.promise;
      },
    }),
    herdr({ agent: currentAgent("working", 1) }, {
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
  let followUpWritten = false;
  const responses: FakeResponse[] = [
    herdr({ agents: [liveAgent("working", 1)] }),
    herdr({ agents: [liveAgent("working", 1)] }),
    herdr({ agent: currentAgent("working", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({}),
    herdr({ agents: [liveAgent("done", 2)] }),
    herdr({ agent: liveAgent("done", 3) }, {
      onStart: () => {
        const replacement = `${path}.replacement`;
        writeJsonl(replacement, [
          codexMeta(),
          ...codexTurn(
            "turn-2",
            `${prefix}수동 후속 요청`,
            "최신 완료 결과",
          ),
        ]);
        Deno.renameSync(replacement, path);
      },
    }),
    herdr({
      agent: {
        ...liveAgent("done", 3),
        workspace_id: "ws-2",
        tab_id: "tab-moved",
        pane_id: "pane-moved",
      },
    }),
    herdr({}),
    herdr({}),
    herdr({ agents: [] }),
  ];
  const start = setup(dir.path, "후속 요청", responses, {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      if (!followUpWritten && now > 5_000) {
        appendJsonl(path, [
          {
            type: "event_msg",
            payload: { type: "turn_aborted", turn_id: "turn-1" },
          },
          ...codexTurn(
            "turn-follow-up",
            `${prefix}후속 요청`,
            "후속 결과",
          ),
        ]);
        followUpWritten = true;
      }
      return Promise.resolve();
    },
  });

  const status = await runDelegate(["status", codexId], start.deps);
  assertEquals(status.code, 0);
  assertEquals(
    status.stdout,
    `---\nsession_id: ${codexId}\nagent: codex\nactivity: working\n---\n`,
  );

  const prompted = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller-1",
  ], start.deps);
  assertEquals(prompted.code, 0);
  assertStringIncludes(prompted.stdout, "후속 결과");
  assertEquals(prompted.stdout.includes("intervening_prompts:"), false);
  assertEquals(now > 5_000, true);
  const followUp = start.fake.calls.find((call) =>
    call.args[1] === "prompt" && call.args[3] === `${prefix}후속 요청`
  );
  assertEquals(followUp?.args.includes("--wait"), false);

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
    "intervening_prompts:\n  - 수동 후속 요청",
  );
  assertStringIncludes(waited.stdout, "\n\n최신 완료 결과\n");
  assertEquals(
    start.fake.calls.some((call) =>
      call.args.includes("/rename caller-1 검토")
    ),
    true,
  );
  assertEquals(
    start.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
      call.args
    ),
    [
      ["pane", "close", "pane-delegate"],
      ["pane", "close", "pane-moved"],
    ],
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
  ], start.deps);
  assertEquals(closed.code, 3);
  assertStringIncludes(closed.stdout, "code: transport_unavailable");

  await using deadlineDir = await tempDir();
  const deadlinePath = codexPath(deadlineDir.path);
  writeJsonl(deadlinePath, [
    codexMeta(),
    ...codexTurn("deadline-old", "기존 요청"),
  ]);
  let deadlineNow = 0;
  const deadline = setup(deadlineDir.path, "나타나지 않는 후속 요청", [
    herdr({ agents: [liveAgent("unknown", 1)] }),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => deadlineNow,
    sleep: (ms) => {
      deadlineNow += ms;
      return Promise.resolve();
    },
  });
  const expired = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller-1",
    "--timeout",
    "1s",
  ], deadline.deps);
  assertEquals(expired.code, 6);
  assertStringIncludes(expired.stdout, "code: timeout");
  assertStringIncludes(expired.stdout, `session_id: ${codexId}`);
  assertEquals(deadlineNow, 1_000);
});

Deno.test("prompt 파일을 정규화하고 명시한 effort로 Herdr 작업을 완료한다", async () => {
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
    herdr({ agent: unidentifiedAgent("working", 1) }),
    herdr({ agent: unidentifiedAgent("working", 1) }, {
      onStart: () =>
        writeJsonl(nativePath, [
          codexMeta(),
          ...codexTurn(
            "file",
            "다른 문자열이어도 공식 ID를 따릅니다",
            "완료",
            "complete",
            {
              before: ["AGENTS 지침"],
              after: ["스킬 지침"],
              metadataPrompt: true,
            },
          ),
        ]),
    }),
    herdr({ agent: currentAgent("working", 1) }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
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
    "--effort",
    "high",
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
  const prompt = test.fake.calls.find((call) => call.args[1] === "prompt");
  assertEquals(prompt?.args.includes("--wait"), true);
  assertEquals(prompt?.args.includes("--until"), true);
  assertEquals(prompt?.args.includes("working"), true);
  assertEquals(prompt?.args.includes("blocked"), true);
  assertEquals(prompt?.args.includes("--timeout"), true);
  assertEquals(
    test.fake.calls.some((call) => call.args[1] === "get"),
    true,
  );
  const start = test.fake.calls.find((call) => call.args[1] === "start");
  assertEquals(start?.args.includes("-c"), true);
  assertEquals(start?.args.includes("model_reasoning_effort=high"), true);

  const logs = await runDelegate(["logs", codexId], test.deps);
  assertEquals(logs.code, 0);
  assertStringIncludes(logs.stdout, "다른 문자열이어도 공식 ID를 따릅니다");
  assertEquals(logs.stdout.includes("AGENTS 지침"), false);
  assertEquals(logs.stdout.includes("스킬 지침"), false);
});

Deno.test("사용자가 native 기본 옵션으로 직접 prompt를 완료하고 재개하면 결과와 같은 session을 보존한다", async () => {
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
  assertEquals(normal.fake.calls[0]?.args.includes("--approve-for-me"), true);
  assertEquals(
    normal.fake.calls[0]?.args.some((arg) =>
      arg.startsWith("model_reasoning_effort=")
    ),
    false,
  );

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
  assertEquals(
    claude.fake.calls[0]?.args.includes("--permission-mode=auto"),
    true,
  );
  assertEquals(
    claude.fake.calls[0]?.args.some((arg) => arg.startsWith("--effort=")),
    false,
  );
});

Deno.test("사용자가 종료된 Herdr session을 보고 ID 없이 확인 후 write로 재개하고 탭 정돈으로 pane이 옮겨져도 같은 파일에 append하고 비종결 상태를 쉬어 재대기한 뒤 결정적 이름으로 정리한다", async () => {
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
    herdr({ agents: [] }, {
      onStart: () =>
        appendJsonl(
          path,
          codexTurn("pre-submit", "전송 직전 외부 요청", "외부 결과"),
        ),
    }),
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ agent: unidentifiedAgent("working", 1) }),
    herdr({ agent: unidentifiedAgent("working", 1) }, {
      onStart: () =>
        appendJsonl(
          path,
          codexTurn("resumed", `${prefix}수정 요청`, "재개 결과"),
        ),
    }),
    herdr({ agent: unidentifiedAgent("working", 1) }),
    herdrError(
      "agent_not_running",
      "agent is no longer running in the target pane",
    ),
    herdr({
      agents: [liveAgent("working", 2, codexId, sessionCwd)],
    }),
    herdr({ agent_status: "working", state_change_seq: 2 }),
    herdr({ agent: { agent_status: "done", state_change_seq: 3 } }),
    herdr({ agent_status: "done", state_change_seq: 3 }),
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

  const resumed = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
    "--name",
    "재개 작업",
    "--timeout",
    "2s",
  ], test.deps);
  assertEquals(resumed.code, 0);
  assertStringIncludes(resumed.stdout, "\n\n재개 결과\n");
  assertEquals(resumed.stdout.includes("intervening_prompts:"), false);
  assertEquals(sleeps, [50, 500, 500]);
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "wait").length,
    3,
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
    herdr({}),
    herdr({
      agent: currentAgent("working", 1, changedId, sessionCwd),
    }, {
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

  const replacementId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const replacementPath = codexPath(dir.path, replacementId);
  writeJsonl(replacementPath, [
    codexMeta(replacementId),
    ...codexTurn("before-replace", "교체 전 요청", "교체 전 결과"),
  ]);
  let replacementNow = 0;
  const replacement = setup(dir.path, "교체 후 요청", [
    herdr({ agents: [] }),
    herdr({ agents: [] }),
    ...newTabAllocation(),
    herdr({ agent: currentAgent("working", 1, replacementId) }),
    herdr({ agent: currentAgent("working", 1, replacementId) }, {
      onStart: () =>
        appendJsonl(
          replacementPath,
          codexTurn("after-replace", `${prefix}교체 후 요청`),
        ),
    }),
    herdr({ agent: liveAgent("done", 2, replacementId) }, {
      onStart: () => {
        Deno.renameSync(replacementPath, `${replacementPath}.old`);
        writeJsonl(replacementPath, [
          codexMeta(replacementId),
          ...codexTurn(
            "after-replace",
            `${prefix}교체 후 요청`,
            "교체 후 결과",
          ),
        ]);
      },
    }),
    herdr({ agent: liveAgent("done", 2, replacementId) }),
    ...successfulCleanup(),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => replacementNow,
    sleep: (ms) => {
      replacementNow += ms;
      return Promise.resolve();
    },
  });
  const replaced = await runDelegate([
    "prompt",
    replacementId,
    "--caller-id",
    "caller",
  ], replacement.deps);
  assertEquals(replaced.code, 0);
  assertStringIncludes(replaced.stdout, "교체 후 결과");
  assertEquals(replaced.stdout.includes("intervening_prompts:"), false);
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
      herdr({}),
    ];
    const test = setup(dir.path, "작업", [
      herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
      ...allocation,
      herdrFailure(shellError),
      herdr({ agent: currentAgent("working", 1) }),
      herdr({ agent: currentAgent("working", 1) }, {
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
      herdrFailure(shellError),
      retrySucceeds
        ? herdr({ agent: currentAgent("working", 1) })
        : herdrFailure("retry refused"),
    ];
    if (retrySucceeds) {
      responses.push(
        herdr({ agent: currentAgent("working", 1) }, {
          onStart: () =>
            appendJsonl(
              path,
              codexTurn("resumed", `${prefix}수정`, "재개 결과"),
            ),
        }),
        herdr({ agent_status: "done", state_change_seq: 2 }),
        herdr({ agent: { agent_status: "done", state_change_seq: 2 } }),
        herdr({ agent_status: "done", state_change_seq: 2 }),
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

Deno.test("시작 중 준비되지 않은 agent는 prompt를 제출하거나 pane을 닫지 않고 대응 위치를 반환한다", async () => {
  for (const resume of [false, true]) {
    await using dir = await tempDir();
    if (resume) {
      writeJsonl(codexPath(dir.path), [
        codexMeta(),
        ...codexTurn("old", "이전", "완료"),
      ]);
    }
    const reason = "interactive startup screen requires input";
    const test = setup(dir.path, "작업", [
      ...(resume ? [herdr({ agents: [] }), herdr({ agents: [] })] : []),
      ...newTabAllocation(),
      herdrError("agent_not_ready", reason),
      herdr({
        agent: {
          pane_id: "pane-delegate",
          agent_kind: "codex",
          cwd,
          agent_status: "blocked",
        },
      }),
      { cmd: "herdr", stdout: "Trust this folder?\n``` suspicious\n" },
    ], { env: { HERDR_ENV: "1" } });

    const result = await runDelegate([
      "prompt",
      ...(resume ? [codexId] : []),
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);
    const start = test.fake.calls.find((call) => call.args[1] === "start");
    const agentName = start?.args[2];

    assertEquals(result.code, 4, String(resume));
    assertStringIncludes(result.stdout, "code: agent_blocked");
    assertStringIncludes(result.stdout, reason);
    assertStringIncludes(result.stdout, "prompt를 제출하지 않았습니다");
    assertStringIncludes(result.stdout, "pane_id: pane-delegate");
    assertEquals(result.stdout.includes("blockers:"), false);
    assertStringIncludes(result.stdout, "Trust this folder?\n``` suspicious\n");
    assertStringIncludes(result.stdout, "````text\nTrust this folder?");
    assertEquals(result.stdout.endsWith("````\n"), true);
    assertEquals(result.stdout.includes(`agent_name: ${agentName}`), false);
    assertEquals(
      result.stdout.includes(`session_id: ${codexId}`),
      resume,
      String(resume),
    );
    assertEquals(
      test.fake.calls.some((call) => call.args[1] === "prompt"),
      false,
    );
    assertEquals(
      test.fake.calls.some((call) =>
        call.args[1] === "close" &&
        (call.args[0] === "pane" || call.args[0] === "tab")
      ),
      false,
    );
  }
});

Deno.test("클로드 시작 신뢰 화면과 기록 없는 후속 조회는 연결된 pane의 현재 화면을 반환한다", async () => {
  await using dir = await tempDir();
  const started = setup(dir.path, "작업", [
    ...newTabAllocation(),
    herdrError("agent_not_ready", "Trust required"),
    herdr({
      agent: {
        pane_id: "pane-delegate",
        agent_kind: "claude",
        cwd,
        agent_status: "blocked",
      },
    }),
    { cmd: "herdr", stdout: "Trust this folder?\n" },
  ], { env: { HERDR_ENV: "1" } });
  const first = await runDelegate([
    "prompt",
    "--agent",
    "claude",
    "--caller-id",
    "caller",
  ], started.deps);
  const start = started.fake.calls.find((call) => call.args[1] === "start")!;
  const id = start.args.find((arg) => arg.startsWith("--session-id="))!.slice(
    13,
  );
  assertEquals(start.args[2], `dlg-${id.replaceAll("-", "").slice(0, 28)}`);
  assertStringIncludes(first.stdout, `session_id: ${id}`);
  assertStringIncludes(first.stdout, "pane_id: pane-delegate");
  assertStringIncludes(first.stdout, "Trust this folder?");

  for (
    const command of ["status", "wait", "logs", "close", "prompt"] as const
  ) {
    for (const status of ["blocked", "idle"] as const) {
      const live = { ...claudeLive(status, 1, id), name: start.args[2] };
      const test = setup(dir.path, "다음 작업", [
        herdr({ agents: [live] }),
        herdr({ agent: live }),
        { cmd: "herdr", stdout: `Current screen: ${status}\n` },
      ], { env: { HERDR_ENV: "1" } });
      const args = command === "prompt"
        ? ["prompt", id, "--transport", "herdr"]
        : [command, id];
      const result = await runDelegate(args, test.deps);
      assertEquals(
        result.code,
        status === "blocked" ? 4 : 5,
        `${command}/${status}`,
      );
      assertStringIncludes(
        result.stdout,
        `code: ${
          status === "blocked" ? "agent_blocked" : "invalid_native_session"
        }`,
      );
      assertStringIncludes(result.stdout, "pane_id: pane-delegate");
      assertStringIncludes(result.stdout, `Current screen: ${status}`);
      assertEquals(result.stdout.includes("blockers:"), false);
      assertEquals(
        test.fake.calls.some((call) =>
          ["prompt", "close"].includes(call.args[1] ?? "")
        ),
        false,
      );
    }
  }
});

Deno.test("시작 차단 때 agent 조회가 실패하거나 위치를 누락해도 pane 연결을 확인하면 화면을 반환한다", async () => {
  for (const agentGet of ["failed", "missing-pane"] as const) {
    await using dir = await tempDir();
    const paneResponse = herdr({ pane: {} });
    const test = setup(dir.path, "작업", [
      ...newTabAllocation(),
      herdrError("agent_not_ready", "Trust required"),
      agentGet === "failed" ? herdrFailure("agent get unavailable") : herdr({
        agent: { agent_kind: "codex", cwd, agent_status: "blocked" },
      }),
      paneResponse,
      { cmd: "herdr", stdout: "Trust this folder?\n" },
    ], { env: { HERDR_ENV: "1" } });
    paneResponse.onStart = () => {
      const name = test.fake.calls.find((call) => call.args[1] === "start")
        ?.args[2];
      paneResponse.stdout = JSON.stringify({
        result: {
          pane: {
            pane_id: "pane-delegate",
            agent_name: name,
          },
        },
      });
    };
    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
    ], test.deps);
    assertEquals(result.code, 4);
    assertStringIncludes(result.stdout, "pane_id: pane-delegate");
    assertStringIncludes(result.stdout, "Trust this folder?");
    assertEquals(
      test.fake.calls.some((call) =>
        call.args[0] === "pane" && call.args[1] === "get"
      ),
      true,
    );
  }

  await using dir = await tempDir();
  const unverified = setup(dir.path, "작업", [
    ...newTabAllocation(),
    herdrError("agent_not_ready", "Trust required"),
    herdr({ agent: { agent_kind: "codex", cwd, agent_status: "blocked" } }),
    herdr({
      pane: { pane_id: "pane-delegate", agent_name: "unrelated-agent" },
    }),
  ], { env: { HERDR_ENV: "1" } });
  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], unverified.deps);
  assertEquals(result.code, 4);
  assertEquals(result.stdout.includes("pane_id:"), false);
  assertEquals(
    unverified.fake.calls.some((call) => call.args[1] === "read"),
    false,
  );
});

Deno.test("차단 화면 진단 명령이 멈춰도 원래 오류와 확인된 pane을 기한 안에 반환한다", async () => {
  for (const stalled of ["agent get", "pane get", "pane read"] as const) {
    await using dir = await tempDir();
    const controller = new AbortController();
    let callerAborted = false;
    const watchdog = setTimeout(() => {
      callerAborted = true;
      controller.abort();
    }, 2_500);
    const responses: FakeResponse[] = [
      ...newTabAllocation(),
      herdrError("agent_not_ready", "Trust required"),
      stalled === "agent get"
        ? { cmd: "herdr", waitForAbort: true }
        : stalled === "pane get"
        ? herdrFailure("agent get unavailable")
        : herdr({
          agent: { pane_id: "pane-delegate", agent_kind: "codex", cwd },
        }),
      ...(stalled === "pane get" ? [{ cmd: "herdr", waitForAbort: true }] : []),
      ...(stalled === "pane read"
        ? [{ cmd: "herdr", waitForAbort: true }]
        : []),
    ];
    try {
      const test = setup(dir.path, "작업", responses, {
        env: { HERDR_ENV: "1" },
        signal: controller.signal,
      });
      const result = await runDelegate([
        "prompt",
        "--agent",
        "codex",
        "--caller-id",
        "caller",
        "--timeout",
        "500ms",
      ], test.deps);
      assertEquals(callerAborted, false, stalled);
      assertEquals(result.code, 4, stalled);
      assertStringIncludes(result.stdout, "Trust required");
      assertEquals(
        result.stdout.includes("pane_id: pane-delegate"),
        stalled === "pane read",
        stalled,
      );
      assertEquals(
        test.fake.calls.some((call) => call.args[1] === "close"),
        false,
      );
    } finally {
      clearTimeout(watchdog);
    }
  }

  await using dir = await tempDir();
  const controller = new AbortController();
  let callerAborted = false;
  const watchdog = setTimeout(() => {
    callerAborted = true;
    controller.abort();
  }, 2_500);
  try {
    const test = setup(dir.path, "", [{ cmd: "herdr", waitForAbort: true }], {
      env: { HERDR_ENV: "1" },
      signal: controller.signal,
    });
    const result = await runDelegate(["status", claudeId], test.deps);
    assertEquals(callerAborted, false);
    assertStringIncludes(result.stdout, "code: session_not_found");
  } finally {
    clearTimeout(watchdog);
  }
});

Deno.test("기록 없는 직접 실행과 연결되지 않은 허더 pane은 화면을 노출하지 않는다", async () => {
  await using dir = await tempDir();
  const direct = setup(dir.path, "작업", [], { env: { HERDR_ENV: "1" } });
  const directResult = await runDelegate([
    "prompt",
    claudeId,
    "--transport",
    "direct",
  ], direct.deps);
  assertStringIncludes(directResult.stdout, "code: session_not_found");
  assertEquals(direct.fake.calls.length, 0);
  for (
    const live of [
      {
        ...claudeLive("blocked", 1),
        name: `dlg-${claudeId.replaceAll("-", "").slice(0, 27)}x`,
      },
      { ...claudeLive("blocked", 1), cwd: "/other-workspace" },
    ]
  ) {
    const test = setup(dir.path, "", [herdr({ agents: [live] })], {
      env: { HERDR_ENV: "1" },
    });
    const result = await runDelegate(["status", claudeId], test.deps);
    assertStringIncludes(result.stdout, "code: session_not_found");
    assertEquals(result.stdout.includes("pane_id:"), false);
  }
  const mismatched = setup(dir.path, "", [
    herdr({ agents: [claudeLive("blocked", 1)] }),
    herdr({
      agent: {
        ...claudeLive("blocked", 1),
        name: "unrelated-agent",
        pane_id: "another-pane",
      },
    }),
  ], { env: { HERDR_ENV: "1" } });
  const mismatch = await runDelegate(["status", claudeId], mismatched.deps);
  assertStringIncludes(mismatch.stdout, "code: session_not_found");
  assertEquals(
    mismatched.fake.calls.some((call) => call.args[1] === "read"),
    false,
  );

  const missingButWrong = setup(dir.path, "", [
    herdr({ agents: [claudeLive("blocked", 1)] }),
    herdr({
      agent: {
        name: "unrelated-agent",
        agent_kind: "claude",
        cwd,
        agent_status: "blocked",
      },
    }),
  ], { env: { HERDR_ENV: "1" } });
  const wrong = await runDelegate(["status", claudeId], missingButWrong.deps);
  assertStringIncludes(wrong.stdout, "code: session_not_found");
  assertEquals(
    missingButWrong.fake.calls.some((call) =>
      call.args[0] === "pane" && ["get", "read"].includes(call.args[1] ?? "")
    ),
    false,
  );

  const unreadable = setup(dir.path, "", [
    herdr({ agents: [claudeLive("blocked", 1)] }),
    herdr({ agent: claudeLive("blocked", 1) }),
    herdrError("pane_failed", "read refused"),
  ], { env: { HERDR_ENV: "1" } });
  const unread = await runDelegate(["status", claudeId], unreadable.deps);
  assertStringIncludes(unread.stdout, "code: agent_blocked");
  assertStringIncludes(unread.stdout, "pane_id: pane-delegate");
  assertEquals(unread.stdout.includes("read refused"), false);
});

Deno.test("응답 대기 중 차단되면 연결된 pane 화면을 반환하고 요청을 다시 보내지 않는다", async () => {
  await using dir = await tempDir();
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("open", "승인 필요"),
  ]);
  const test = setup(dir.path, "", [
    herdr({ agents: [liveAgent("working", 1)] }),
    herdr({ agent: liveAgent("blocked", 2) }),
    herdr({ agents: [liveAgent("blocked", 2)] }),
    herdr({ agent: { ...liveAgent("blocked", 2), pane_id: "pane-moved" } }),
    { cmd: "herdr", stdout: "Wait for approval\n" },
  ], { env: { HERDR_ENV: "1" } });
  const result = await runDelegate(["wait", codexId], test.deps);
  assertEquals(result.code, 4);
  assertStringIncludes(result.stdout, "pane_id: pane-moved");
  assertEquals(
    test.fake.calls.some((call) =>
      call.args.join(" ") === "pane read pane-moved --source visible"
    ),
    true,
  );
  assertStringIncludes(result.stdout, "Wait for approval");
  assertEquals(
    test.fake.calls.some((call) =>
      ["prompt", "close"].includes(call.args[1] ?? "")
    ),
    false,
  );
});

Deno.test("기존 세션의 요청 제출 중 차단되면 같은 pane의 화면을 반환한다", async () => {
  await using dir = await tempDir();
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("old", "이전", "완료"),
  ]);
  const test = setup(dir.path, "새 요청", [
    herdr({ agents: [liveAgent("idle", 1)] }),
    herdrError("agent_blocked", "Approval needed"),
    herdr({ agent: liveAgent("blocked", 2) }),
    { cmd: "herdr", stdout: "Confirm action\n" },
  ], { env: { HERDR_ENV: "1" } });
  const result = await runDelegate(
    ["prompt", codexId, "--caller-id", "caller"],
    test.deps,
  );
  assertEquals(result.code, 4);
  assertStringIncludes(result.stdout, "pane_id: pane-delegate");
  assertStringIncludes(result.stdout, "Confirm action");
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "prompt").length,
    1,
  );
});

Deno.test("클로드 요청 뒤 차단되고 기록이 아직 없어도 pane 화면과 차단 상태를 반환한다", async () => {
  await using dir = await tempDir();
  let now = 0;
  const identity = herdr({ agent: {} });
  const diagnostic = herdr({ agent: {} });
  const test = setup(dir.path, "작업", [
    ...newTabAllocation(),
    herdr({ agent: unidentifiedClaude("working", 1) }),
    herdr({ agent: unidentifiedClaude("blocked", 2) }),
    identity,
    diagnostic,
    { cmd: "herdr", stdout: "Workspace trust required\n" },
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: () => {
      now += 5_000;
      return Promise.resolve();
    },
  });
  for (const response of [identity, diagnostic]) {
    response.onStart = () => {
      const name = test.fake.calls.find((call) => call.args[1] === "start")
        ?.args[2];
      response.stdout = JSON.stringify({
        result: {
          agent: {
            ...unidentifiedClaude("blocked", 2),
            name,
            pane_id: "pane-delegate",
          },
        },
      });
    };
  }
  const result = await runDelegate([
    "prompt",
    "--agent",
    "claude",
    "--caller-id",
    "caller",
  ], test.deps);
  assertEquals(result.code, 4);
  assertStringIncludes(result.stdout, "code: agent_blocked");
  assertStringIncludes(result.stdout, "pane_id: pane-delegate");
  assertStringIncludes(result.stdout, "Workspace trust required");
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "prompt").length,
    1,
  );
  assertEquals(test.fake.calls.some((call) => call.args[1] === "close"), false);
});

Deno.test("관리 pane 셸을 다시 시작하지 못하면 마지막 상태와 실패 기록을 반환한다", async () => {
  for (
    const scenario of [
      { name: "같은 오류", second: "shell", cancel: "none" },
      { name: "다른 오류", second: "other", cancel: "none" },
      { name: "준비 차단", second: "blocked", cancel: "none" },
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
      herdrFailure(shellError),
    ];
    if (scenario.second === "shell") responses.push(herdrFailure(shellError));
    if (scenario.second === "other") {
      responses.push(herdrFailure("retry refused"));
    }
    if (scenario.second === "blocked") {
      responses.push(
        herdrError("agent_not_ready", "interactive startup screen"),
        herdr({
          agent: {
            pane_id: "pane-delegate",
            agent_kind: "codex",
            cwd,
            agent_status: "blocked",
          },
        }),
        { cmd: "herdr", stdout: "Trust this folder?\n" },
      );
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
      scenario.second === "blocked" ? 4 : scenario.cancel === "none" ? 5 : 130,
      scenario.name,
    );
    assertStringIncludes(result.stdout, "result: failed");
    assertStringIncludes(result.stdout, `message: ${shellError}`);
    if (scenario.second === "other") {
      assertStringIncludes(result.stdout, "message: retry refused");
    }
    if (scenario.second === "blocked") {
      assertStringIncludes(result.stdout, "code: agent_blocked");
      assertStringIncludes(result.stdout, "prompt를 제출하지 않았습니다");
      assertStringIncludes(result.stdout, "pane_id: pane-delegate");
      assertStringIncludes(result.stdout, "Trust this folder?");
      assertEquals(result.stdout.includes("blockers:"), false);
      assertEquals(
        test.fake.calls.some((call) => call.args[1] === "prompt"),
        false,
      );
      assertEquals(
        test.fake.calls.some((call) => call.args[1] === "close"),
        false,
      );
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
    const failure of [
      "prompt",
      "session",
      "id-unavailable",
      "native-missing",
      "invalid-kind",
      "invalid-id",
      "wait",
      "blocked",
      "raw",
    ] as const
  ) {
    await using dir = await tempDir();
    const path = codexPath(dir.path);
    const shellError =
      `agent target pane pane-delegate is not an available shell`;
    let sleepCalls = 0;
    let now = 0;
    let identityPolling = false;
    const afterRetry: FakeResponse[] = failure === "prompt"
      ? [herdrFailure("prompt refused")]
      : failure === "session"
      ? [
        herdr({
          agent: {
            agent_session: {
              kind: "id",
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
      : failure === "id-unavailable"
      ? [
        herdr({ agent: unidentifiedAgent("working", 1) }, {
          onStart: () => {
            identityPolling = true;
          },
        }),
        herdr({ agent: unidentifiedAgent("working", 1) }),
        herdr({}),
        herdr({ panes: [] }),
        herdr({}),
      ]
      : failure === "native-missing"
      ? [
        herdr({ agent: currentAgent("working", 1) }, {
          onStart: () => {
            identityPolling = true;
          },
        }),
        herdr({
          agent: { ...currentAgent("working", 1), pane_id: "pane-delegate" },
        }),
        { cmd: "herdr", stdout: "Still starting\n" },
      ]
      : failure === "invalid-kind" || failure === "invalid-id"
      ? [
        herdr({
          agent: {
            ...unidentifiedAgent("working", 1),
            agent_session: failure === "invalid-kind"
              ? { kind: "path", value: codexId }
              : { kind: "id", value: "not-a-session-id" },
          },
        }),
        herdr({}),
        herdr({ panes: [] }),
        herdr({}),
      ]
      : [
        herdr({ agent: currentAgent("working", 1) }, {
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
          ? [
            herdr({}),
            herdrFailure("wait refused"),
            herdrFailure("list refused"),
          ]
          : failure === "blocked"
          ? [
            herdr({}),
            herdr({ agent: liveAgent("blocked", 2) }),
            herdr({
              agent: {
                ...currentAgent("blocked", 2),
                pane_id: "pane-delegate",
              },
            }),
            { cmd: "herdr", stdout: "Approval needed\n" },
          ]
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
      herdrFailure(shellError),
      herdr({
        agent: failure === "id-unavailable"
          ? unidentifiedAgent("working", 1)
          : currentAgent("working", 1),
      }),
      ...afterRetry,
    ], {
      env: { HERDR_ENV: "1" },
      now: () => now,
      sleep: (_ms) => {
        sleepCalls++;
        if (failure === "raw" && sleepCalls === 2) {
          throw new Error("session lookup exploded");
        }
        if (identityPolling) now += 5_000;
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
      assertStringIncludes(result.stdout, "pane_id: pane-delegate");
      assertStringIncludes(result.stdout, "Approval needed");
    }
    if (failure === "raw" || failure === "session") {
      assertStringIncludes(
        result.stdout,
        `code: ${
          failure === "raw" ? "agent_failed" : "invalid_native_session"
        }`,
      );
    }
    if (failure === "wait") {
      assertStringIncludes(result.stdout, "code: herdr_failed");
      assertStringIncludes(result.stdout, "message: wait refused");
    }
    if (failure === "raw") {
      assertEquals(
        test.fake.calls.filter((call) =>
          call.args[0] === "agent" && call.args[1] === "prompt"
        ).length,
        1,
      );
    }
    if (failure === "id-unavailable") {
      assertStringIncludes(result.stdout, "code: session_id_unavailable");
      assertEquals(now, 5_000);
    }
    if (failure === "native-missing") {
      assertStringIncludes(result.stdout, "code: invalid_native_session");
      assertStringIncludes(result.stdout, `session_id: ${codexId}`);
      assertStringIncludes(result.stdout, "pane_id: pane-delegate");
      assertStringIncludes(result.stdout, "Still starting");
    }
    if (failure === "invalid-kind" || failure === "invalid-id") {
      assertStringIncludes(result.stdout, "code: invalid_native_session");
    }
    if (
      [
        "id-unavailable",
        "invalid-kind",
        "invalid-id",
      ].includes(failure)
    ) {
      assertEquals(
        test.fake.calls.some((call) =>
          call.args.join(" ") === "pane close pane-delegate"
        ),
        true,
      );
    }
    if (failure === "native-missing") {
      assertEquals(
        test.fake.calls.some((call) => call.args[1] === "close"),
        false,
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
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent_status: "done", state_change_seq: 2 }),
    herdr({ agent_status: "done", state_change_seq: 2 }),
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
  assertEquals(sleeps, [500, 100]);

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
    herdr({ agent: currentAgent("working", 1, createdId) }),
    herdr({ agent: currentAgent("working", 1, createdId) }, {
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

Deno.test("짧은 Herdr prompt 제한 시간은 agent start 실패를 정리하고 전달 불확실한 최초 prompt pane은 보존한다", async () => {
  for (const stage of ["start", "prompt"] as const) {
    await using dir = await tempDir();
    const controller = new AbortController();
    const responses: FakeResponse[] = [
      ...newTabAllocation(),
      ...(stage === "prompt" ? [herdr({})] : []),
      { cmd: "herdr", waitForAbort: true },
      herdr({}),
      herdr({ panes: [] }),
      herdr({}),
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
    const gated = test.fake.calls.find((call) => call.args[1] === stage);
    const timeout = Number(gated?.args[gated.args.indexOf("--timeout") + 1]);
    assertEquals(
      Number.isInteger(timeout) && timeout > 0 && timeout <= 20,
      true,
    );
    assertEquals(
      test.fake.calls.some((call) =>
        call.args.join(" ") === "pane close pane-delegate"
      ),
      stage === "start",
      stage,
    );
  }

  await using cancelledDir = await tempDir();
  const cancelledController = new AbortController();
  const cancelled = setup(cancelledDir.path, "작업", [
    ...newTabAllocation(),
    herdr({ agent: unidentifiedAgent("working", 1) }),
    {
      cmd: "herdr",
      waitForAbort: true,
      onStart: () => cancelledController.abort(),
    },
    herdr({}),
    herdr({ panes: [] }),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    signal: cancelledController.signal,
  });
  const cancelledResult = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], cancelled.deps);
  assertEquals(cancelledResult.code, 130);
  assertStringIncludes(cancelledResult.stdout, "code: cancelled");
  assertEquals(
    cancelled.fake.calls.some((call) =>
      call.args.join(" ") === "pane close pane-delegate"
    ),
    true,
  );

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

  await using gateDir = await tempDir();
  const gatePath = codexPath(gateDir.path);
  const lockPath = join(gateDir.path, "herdr.sock.delegate-pane.lock");
  let gateNow = 0;
  let lockReleasedBeforeIdentityLookup = false;
  const gate = setup(gateDir.path, "게이트 뒤 작업", [
    ...newTabAllocation(),
    herdr({ agent: unidentifiedAgent("unknown", 1) }),
    {
      cmd: "herdr",
      code: 1,
      stderr: JSON.stringify({
        error: { code: "timeout", message: "activity gate stalled" },
      }),
      onStart: () =>
        writeJsonl(gatePath, [
          codexMeta(),
          ...codexTurn(
            "gate-timeout",
            `${prefix}게이트 뒤 작업`,
            "게이트 뒤 완료",
          ),
        ]),
    },
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: async () => {
        const lock = await Deno.open(lockPath, {
          create: true,
          read: true,
          write: true,
        });
        lockReleasedBeforeIdentityLookup = await lock.tryLock(true);
        if (lockReleasedBeforeIdentityLookup) await lock.unlock();
        lock.close();
      },
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    ...successfulCleanup(),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => gateNow,
    sleep: (ms) => {
      gateNow += ms;
      return Promise.resolve();
    },
  });
  const gated = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
    "--timeout",
    "1m",
  ], gate.deps);
  assertEquals(gated.code, 0);
  assertStringIncludes(gated.stdout, "게이트 뒤 완료");
  assertEquals(lockReleasedBeforeIdentityLookup, true);
  const gatePrompt = gate.fake.calls.find((call) => call.args[1] === "prompt");
  assertEquals(
    gatePrompt?.args[gatePrompt.args.indexOf("--timeout") + 1],
    "30000",
  );

  await using unidentifiedDir = await tempDir();
  let unidentifiedNow = 0;
  const unidentified = setup(unidentifiedDir.path, "식별되지 않는 작업", [
    ...newTabAllocation(),
    herdr({ agent: unidentifiedAgent("unknown", 1) }),
    {
      cmd: "herdr",
      code: 1,
      stderr: JSON.stringify({
        error: { code: "timeout", message: "activity gate stalled" },
      }),
    },
    herdr({ agent: unidentifiedAgent("unknown", 1) }),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => unidentifiedNow,
    sleep: () => {
      unidentifiedNow += 5_000;
      return Promise.resolve();
    },
  });
  const unidentifiedResult = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
    "--timeout",
    "1m",
  ], unidentified.deps);
  assertEquals(unidentifiedResult.code, 5);
  assertStringIncludes(
    unidentifiedResult.stdout,
    "code: session_id_unavailable",
  );
  assertEquals(unidentifiedNow, 5_000);
  assertEquals(
    unidentified.fake.calls.some((call) =>
      ["pane", "tab"].includes(call.args[0] ?? "") &&
      call.args[1] === "close"
    ),
    false,
  );
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
      herdr({ agent: currentAgent("working", 1) }),
      herdr({ agent: currentAgent("working", 1) }, {
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
    assertEquals(test.fake.calls.length, 6);
  }
});

Deno.test("rename 또는 성공 후 자동 정리 중 중단되면 성공이나 warning이 아닌 중단 오류를 반환한다", async () => {
  for (
    const scenario of [
      { stage: "rename-command", interruption: "cancelled" },
      { stage: "rename-pause", interruption: "timeout" },
      { stage: "cleanup-close", interruption: "cancelled" },
    ] as const
  ) {
    await using dir = await tempDir();
    const path = codexPath(dir.path);
    const controller = new AbortController();
    const responses = completedUntilPostProcessing(path, `${prefix}작업`);
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
    } else {
      responses.push({
        cmd: "herdr",
        waitForAbort: true,
        onStart: () => controller.abort(),
      });
    }
    let sleepCalls = 0;
    const logicalNow = 0;
    const test = setup(dir.path, "작업", responses, {
      env: {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: join(dir.path, "herdr.sock"),
      },
      signal: controller.signal,
      now: () => logicalNow,
      sleep: (_ms, signal) => {
        sleepCalls++;
        const shouldBlock = scenario.stage === "rename-pause" && sleepCalls > 1;
        if (!shouldBlock) {
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

    const result = await runDelegate([
      "prompt",
      "--agent",
      "codex",
      "--caller-id",
      "caller",
      ...(scenario.stage.startsWith("rename") ? ["--name", "표시"] : []),
      "--timeout",
      scenario.stage === "rename-pause" || scenario.stage === "cleanup-close"
        ? "100ms"
        : "20ms",
    ], test.deps);

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
        : test.fake.calls.some((call) =>
          call.args.join(" ") === "pane close pane-delegate"
        ),
      true,
      scenario.stage,
    );
    assertEquals(
      test.fake.calls.length,
      {
        "rename-command": 9,
        "rename-pause": 9,
        "cleanup-close": 9,
      }[scenario.stage],
      scenario.stage,
    );
  }
});

Deno.test("agent start 또는 최초 prompt가 실패하면 이번 호출이 만든 pane만 정리하고 원래 오류를 반환한다", async () => {
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
        [["pane", "close", "pane-delegate"]],
        `${allocation}-${stage}`,
      );
    }
  }
});

Deno.test("agent start 외 Herdr 명령의 준비 실패는 일반 Herdr 오류로 반환한다", async () => {
  await using dir = await tempDir();
  const reason = "pane lookup agent not ready";
  const test = setup(dir.path, "작업", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdrError("agent_not_ready", reason),
  ], { env: { HERDR_ENV: "1" } });

  const result = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--caller-id",
    "caller",
  ], test.deps);

  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "code: herdr_failed");
  assertStringIncludes(result.stdout, reason);
  assertEquals(
    test.fake.calls.some((call) =>
      call.args[0] === "agent" && call.args[1] === "start"
    ),
    false,
  );
});

Deno.test("실패 복구 정리가 실패하거나 기존 pane을 재사용해도 원래 오류를 보존하고 소유하지 않은 자원은 닫지 않는다", async () => {
  for (
    const cleanupFailure of [
      "ordinary",
      "missing",
      "cancelled",
      "timeout",
    ] as const
  ) {
    await using dir = await tempDir();
    const controller = new AbortController();
    const cleanupResponse: FakeResponse = cleanupFailure === "ordinary"
      ? herdrFailure("close refused")
      : cleanupFailure === "missing"
      ? herdrError("pane_not_found", "pane pane-delegate not found")
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
      test.fake.calls.slice(5).map((call) => call.args),
      [["pane", "close", "pane-delegate"]],
      cleanupFailure,
    );
  }

  await using sharedDir = await tempDir();
  const shared = setup(sharedDir.path, "작업", [
    ...newTabAllocation(),
    herdr({}),
    herdrFailure("prompt refused"),
    herdr({}),
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
    shared.fake.calls.slice(5).map((call) => call.args),
    [["pane", "close", "pane-delegate"]],
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

Deno.test("Claude Herdr 시작은 지정 ID로 보고 부재를 보완하고 불일치를 거부하며 표시 이름과 effort를 적용한다", async () => {
  await using dir = await tempDir();
  const test = setup(dir.path, "화면 작업", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ agent: unidentifiedClaude("working", 1) }),
    herdr({ agent: unidentifiedClaude("working", 1) }, {
      onStart: () => {
        const start = test.fake.calls.find((call) => call.args[1] === "start");
        const assignedId = start?.args.find((arg) =>
          arg.startsWith("--session-id=")
        )?.slice("--session-id=".length);
        if (assignedId == null) {
          throw new Error("Claude start에 --session-id가 없습니다");
        }
        writeJsonl(claudePath(dir.path, assignedId), [
          ...claudeOpen(`${prefix}화면 작업`, assignedId),
          {
            type: "assistant",
            sessionId: assignedId,
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
            sessionId: assignedId,
            cwd,
            timestamp: "2026-09-16T00:00:01Z",
          },
        ]);
      },
    }),
    herdr({ agent: unidentifiedClaude("working", 1) }),
    herdr({}),
    herdr({ agent: unidentifiedClaude("done", 2) }),
    herdr({ agent: unidentifiedClaude("done", 2) }),
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
    "--effort",
    "high",
  ], test.deps);
  assertEquals(started.code, 0);
  assertStringIncludes(started.stdout, "\n\n완료\n");
  const start = test.fake.calls.find((call) => call.args[1] === "start");
  assertEquals(start?.args.includes("--name=caller-claude 화면"), true);
  assertEquals(start?.args.includes("--effort=high"), true);
  const assignedId = start?.args.find((arg) => arg.startsWith("--session-id="))
    ?.slice("--session-id=".length);
  assertEquals(assignedId == null, false);
  assertStringIncludes(started.stdout, `session_id: ${assignedId}`);

  const conflictSetup = setup(dir.path, "후속", [
    herdr({ agents: [claudeLive("idle", 3, assignedId!)] }),
  ], { env: { HERDR_ENV: "1" } });
  const conflict = await runDelegate([
    "prompt",
    assignedId!,
    "--caller-id",
    "caller-claude",
    "--name",
    "새 이름",
  ], conflictSetup.deps);
  assertEquals(conflict.code, 2);
  assertStringIncludes(conflict.stdout, "code: live_option_conflict");

  const waitName = await runDelegate([
    "wait",
    assignedId!,
    "--name",
    "새 이름",
  ], conflictSetup.deps);
  assertEquals(waitName.code, 2);
  assertStringIncludes(waitName.stdout, "code: usage");
  assertEquals(conflictSetup.fake.calls.length, 1);

  await using mismatchDir = await tempDir();
  let mismatchNow = 0;
  const mismatch = setup(mismatchDir.path, "불일치", [
    ...newTabAllocation(),
    herdr({ agent: currentClaude("working", 1) }),
    herdr({}),
    herdr({ panes: [] }),
    herdr({}),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => mismatchNow,
    sleep: (ms) => {
      mismatchNow += ms;
      return Promise.resolve();
    },
  });
  const mismatched = await runDelegate([
    "prompt",
    "--agent",
    "claude",
    "--caller-id",
    "caller",
  ], mismatch.deps);
  assertEquals(mismatched.code, 5);
  assertStringIncludes(mismatched.stdout, "code: session_id_changed");
  const mismatchedStart = mismatch.fake.calls.find((call) =>
    call.args[1] === "start"
  );
  const mismatchedAssignedId = mismatchedStart?.args.find((arg) =>
    arg.startsWith("--session-id=")
  )?.slice("--session-id=".length);
  assertEquals(mismatchedAssignedId == null, false);
  assertStringIncludes(mismatched.stdout, mismatchedAssignedId!);
  assertStringIncludes(mismatched.stdout, claudeId);
  assertEquals(
    mismatch.fake.calls.some((call) => call.args[1] === "prompt"),
    false,
  );
  assertEquals(
    mismatch.fake.calls.some((call) =>
      call.args.join(" ") === "pane close pane-delegate"
    ),
    true,
  );
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

Deno.test("사용자 응답을 기다리는 작업은 즉시 차단을 알리고 응답 뒤에는 호출자 ID 없이 대기·정리를 마친다", async () => {
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
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent: currentAgent("blocked", 2) }, {
      onStart: () => writeJsonl(path, [codexMeta(), ...codexTurn("t", sent)]),
    }),
    herdr({
      agent: { ...currentAgent("blocked", 2), pane_id: "pane-delegate" },
    }),
    { cmd: "herdr", stdout: "Approve action?\n" },
    herdr({ agents: [liveAgent("done", 3)] }),
    herdr({ agent: liveAgent("done", 3) }),
    herdr({ agent: liveAgent("done", 3) }),
    ...successfulCleanup(),
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
  assertStringIncludes(result.stdout, `session_id: ${codexId}`);
  assertStringIncludes(result.stdout, "pane_id: pane-delegate");
  assertStringIncludes(result.stdout, "Approve action?");
  assertEquals(sleeps, 0);
  assertEquals(
    test.fake.calls.some((call) => call.args[1] === "close"),
    false,
  );

  appendJsonl(path, [{
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "응답 후 완료" }],
    },
  }, {
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "t" },
  }]);
  const waitStart = test.fake.calls.length;
  const waited = await runDelegate(["wait", codexId], test.deps);
  assertEquals(waited.code, 0);
  assertStringIncludes(waited.stdout, "intervening_prompts:\n  - 승인 필요");
  assertStringIncludes(waited.stdout, "응답 후 완료");
  assertEquals(
    test.fake.calls.slice(waitStart).map((call) => call.args.slice(0, 2)),
    [["agent", "list"], ["agent", "wait"], ["agent", "get"], ["pane", "close"]],
  );
  assertEquals(test.fake.calls.at(-1)?.args, [
    "pane",
    "close",
    "pane-delegate",
  ]);
  assertEquals(waited.stdout.includes("warnings:"), false);
});

Deno.test("유저가 pane을 다른 탭으로 옮겨도 턴 종료 시 그 pane을 닫는다", async () => {
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
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: () =>
        writeJsonl(path, [codexMeta(), ...codexTurn("t", sent, "완료")]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({
      agent: {
        ...liveAgent("done", 2),
        workspace_id: "ws-2",
        tab_id: "tab-moved",
        pane_id: "pane-moved",
      },
    }),
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
    "caller",
  ], test.deps);
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "\n\n완료\n");
  assertEquals(result.stdout.includes("warnings:"), false);
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
      call.args
    ),
    [["pane", "close", "pane-moved"]],
  );
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
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent: currentAgent("working", 1) }, {
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

Deno.test("명시적 close는 실행 중인 세션을 취소한 뒤 다른 pane을 건드리지 않고 해당 pane만 닫는다", async () => {
  await using dir = await tempDir();
  writeJsonl(codexPath(dir.path), [codexMeta(), ...codexTurn("old", "old")]);
  const live = liveAgent("working", 1);
  const test = setup(dir.path, "", [
    herdr({ agents: [live] }),
    herdr({}),
    herdr({
      agent: {
        ...liveAgent("idle", 2),
        workspace_id: "ws-2",
        tab_id: "tab-moved",
        pane_id: "pane-moved",
      },
    }),
    herdr({}),
  ], { env: { HERDR_ENV: "1" } });

  const result = await runDelegate(["close", codexId], test.deps);

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "activity: not_live");
  assertEquals(test.fake.calls.map((call) => call.args), [
    ["agent", "list"],
    ["agent", "send-keys", live.name, "ctrl+c"],
    ["agent", "get", live.name],
    ["pane", "close", "pane-moved"],
  ]);
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
  ], {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });

  try {
    const result = await runDelegate(["close", codexId], test.deps);
    assertEquals(result.code, 6);
    assertStringIncludes(result.stdout, "code: timeout");
    assertEquals(now, 60_000);
  } finally {
    await lock.unlock();
    lock.close();
  }
});

Deno.test("같은 관리 탭에서 다른 작업이 실행 중이어도 완료된 작업의 pane만 닫는다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  let now = 0;
  const test = setup(dir.path, "작업", [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "current" } }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller" }] }),
    herdr({
      panes: [{
        pane_id: "pane-working",
        tab_id: "tab-delegate",
        agent: "other",
        agent_status: "working",
      }, {
        pane_id: "pane-unknown",
        tab_id: "tab-delegate",
        agent: "unknown-agent",
        agent_status: "unknown",
      }],
    }),
    herdr({ pane: { pane_id: "pane-delegate" } }),
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: () =>
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("t", `${prefix}작업`, "완료"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
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
    "caller",
  ], test.deps);
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "\n\n완료\n");
  assertEquals(result.stdout.includes("warnings:"), false);
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
      call.args
    ),
    [["pane", "close", "pane-delegate"]],
  );
});

Deno.test("완료된 작업의 마지막 관리 pane만 닫고 결과를 반환한다", async () => {
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
    herdr({ agent: currentAgent("working", 1) }),
    herdr({ agent: currentAgent("working", 1) }, {
      onStart: () =>
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("t", `${prefix}작업`, "완료"),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
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
    "caller",
  ], test.deps);
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "\n\n완료\n");
  assertEquals(result.stdout.includes("warnings:"), false);
  assertEquals(
    test.fake.calls.filter((call) => call.args[1] === "close").map((call) =>
      call.args
    ),
    [["pane", "close", "pane-delegate"]],
  );
});

Deno.test("패널 부재 메시지가 정확히 일치할 때만 세션을 한 번 재조회하고 두 번째 닫기 실패를 알린다", async (t) => {
  for (const command of ["prompt", "wait", "close"] as const) {
    for (
      const scenario of [
        "gone",
        "moved",
        "refused",
        "different-message",
        "retry-missing",
        "retry-refused",
        "list-failed",
        "identity-changed",
        "cancelled",
        "timeout",
      ] as const
    ) {
      await t.step(`${command}: ${scenario}`, async () => {
        await using dir = await tempDir();
        const path = codexPath(dir.path);
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("t", `${prefix}작업`, "완료"),
        ]);
        let now = 0;
        const controller = new AbortController();
        const moved = {
          ...liveAgent("done", 2),
          name: "user-renamed-agent",
          workspace_id: "ws-2",
          tab_id: "tab-moved",
          pane_id: "pane-moved",
        };
        const firstMessage = scenario === "refused"
          ? "pane close refused"
          : scenario === "different-message"
          ? "pane pane-delegate not found elsewhere"
          : "pane pane-delegate not found";
        const retry = ["moved", "retry-missing", "retry-refused"].includes(
          scenario,
        );
        const requery = !["refused", "different-message"].includes(scenario);
        const failure = scenario === "retry-missing"
          ? "pane pane-moved not found"
          : scenario === "retry-refused"
          ? "retry close refused"
          : scenario === "list-failed"
          ? "list refused"
          : firstMessage;
        const responses = [
          ...(command === "prompt"
            ? completedUntilPostProcessing(path, `${prefix}작업`)
            : command === "wait"
            ? [
              herdr({ agents: [liveAgent("done", 2)] }),
              herdr({ agent: liveAgent("done", 2) }),
              herdr({ agent: liveAgent("done", 2) }),
            ]
            : [herdr({ agents: [liveAgent("done", 2)] })]),
          herdrError(
            scenario === "refused" ? "herdr_failed" : "pane_not_found",
            firstMessage,
          ),
          ...(requery
            ? [
              scenario === "list-failed" ? herdrFailure(failure) : herdr({
                agents: scenario === "gone" ? [] : [{
                  ...moved,
                  ...(scenario === "identity-changed"
                    ? {
                      name: liveAgent("done", 2).name,
                      agent_session: { kind: "id", value: claudeId },
                    }
                    : {}),
                }],
              }, {
                onStart: () => {
                  if (scenario === "cancelled") controller.abort();
                  if (scenario === "timeout") now += 60_000;
                },
              }),
            ]
            : []),
          ...(retry
            ? [
              scenario === "moved" ? herdr({}) : herdrError(
                scenario === "retry-missing"
                  ? "pane_not_found"
                  : "herdr_failed",
                failure,
              ),
            ]
            : []),
        ];
        const test = setup(dir.path, "작업", responses, {
          env: { HERDR_ENV: "1", CODEX_THREAD_ID: "caller" },
          signal: controller.signal,
          now: () => now,
          sleep: (ms) => {
            now += ms;
            return Promise.resolve();
          },
        });
        const result = await runDelegate(
          command === "prompt"
            ? [
              "prompt",
              "--agent",
              "codex",
              "--caller-id",
              "caller",
              "--timeout",
              "60s",
            ]
            : command === "wait"
            ? ["wait", codexId, "--timeout", "60s"]
            : ["close", codexId],
          test.deps,
        );
        const success = scenario === "gone" || scenario === "moved";
        assertEquals(
          result.code,
          scenario === "cancelled"
            ? 130
            : scenario === "timeout"
            ? 6
            : command === "close" && !success
            ? 5
            : 0,
        );
        if (success) {
          assertStringIncludes(
            result.stdout,
            `activity: ${command === "close" ? "not_live" : "quiescent"}`,
          );
          assertEquals(result.stdout.includes("warnings:"), false);
        } else if (scenario === "cancelled" || scenario === "timeout") {
          assertStringIncludes(result.stdout, `code: ${scenario}`);
        } else if (scenario === "identity-changed") {
          assertStringIncludes(
            result.stdout,
            `code: ${
              command === "close" ? "session_id_changed" : "cleanup_failed"
            }`,
          );
        } else {
          assertStringIncludes(
            result.stdout,
            `code: ${
              command === "close" && scenario === "list-failed"
                ? "live_session_ambiguous"
                : "cleanup_failed"
            }`,
          );
          assertStringIncludes(result.stdout, failure);
        }
        if (
          command !== "close" && !["cancelled", "timeout"].includes(scenario)
        ) {
          assertStringIncludes(result.stdout, "\n\n완료\n");
        }
        const firstClose = test.fake.calls.findIndex((call) =>
          call.args[0] === "pane" && call.args[1] === "close"
        );
        assertEquals(
          test.fake.calls.slice(firstClose).map((call) => call.args),
          [
            ["pane", "close", "pane-delegate"],
            ...(requery ? [["agent", "list"]] : []),
            ...(retry ? [["pane", "close", "pane-moved"]] : []),
          ],
        );
      });
    }
  }
});

Deno.test("live session의 시작 옵션은 writer를 건드리기 전에 충돌로 거부한다", async () => {
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

  let now = 0;
  const idle = setup(dir.path, "후속", [
    herdr({ agents: [liveAgent("idle", 1)] }),
    herdr({ agent: currentAgent("working", 2) }, {
      onStart: () =>
        appendJsonl(codexPath(dir.path), [{
          type: "event_msg",
          payload: { type: "turn_aborted", turn_id: "old" },
        }, ...codexTurn("next", `${prefix}후속`, "후속 완료")]),
    }),
    herdr({ agent: liveAgent("done", 2) }),
    herdr({ agent: liveAgent("done", 2) }),
    ...successfulCleanup(),
  ], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });
  const resumed = await runDelegate([
    "prompt",
    codexId,
    "--caller-id",
    "caller",
    "--timeout",
    "1s",
  ], idle.deps);
  assertEquals(resumed.code, 0);
  assertStringIncludes(resumed.stdout, "후속 완료");
  const idlePrompt = idle.fake.calls.find((call) => call.args[1] === "prompt");
  assertEquals(idlePrompt?.args.includes("--wait"), true);
  assertEquals(idlePrompt?.args.includes("working"), true);
  assertEquals(idlePrompt?.args.includes("blocked"), true);
  const timeoutIndex = idlePrompt?.args.indexOf("--timeout") ?? -1;
  assertEquals(
    timeoutIndex >= 0 && Number(idlePrompt?.args[timeoutIndex + 1]) <= 1_000,
    true,
  );
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

Deno.test("시작 차단 도움말은 pane 화면과 사전 발급 UUID의 기록 부재를 안내한다", async () => {
  await using dir = await tempDir();
  const result = await runDelegate(
    ["prompt", "--help"],
    setup(dir.path, "").deps,
  );

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "error.pane.pane_id");
  assertStringIncludes(
    result.stdout,
    "native 기록 파일은 아직 없을 수 있음",
  );
  assertStringIncludes(
    result.stdout,
    "차단 해소 뒤에도 native 기록 파일이 없을 수 있으므로",
  );
  assertEquals(
    result.stdout.includes("native session UUID가 있으면 wait"),
    false,
  );
});

Deno.test("삭제된 명령과 옵션·위치 prompt는 실행 전에 거부된다", async () => {
  await using dir = await tempDir();
  const base = setup(dir.path, "작업");
  for (
    const args of [
      ["run"],
      ["resume", codexId],
      ["prompt", "위치 본문", "추가 본문"],
      ["prompt", "--keep"],
      ["prompt", "--confirm-escalation"],
      ["close", codexId, "--caller-id", "caller"],
    ]
  ) {
    const result = await runDelegate(args, base.deps);
    assertEquals(result.code, 2);
    assertStringIncludes(result.stdout, "code: usage");
  }
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
    cleanup_failed: 5,
    timeout: 6,
    cancelled: 130,
  } as const;
  for (const [code, expected] of Object.entries(cases)) {
    assertEquals(exitCode(code as keyof typeof cases), expected);
  }
});

Deno.test("자식이 stdin을 읽기 전에 종료돼도 stdout과 종료 상태를 회수한다", async () => {
  const chunks: string[] = [];
  const result = await denoExec("git", ["--version"], {
    cwd: Deno.cwd(),
    env: { PATH: Deno.env.get("PATH") ?? "" },
    stdin: "x".repeat(1_000_000),
    onStdout: (chunk) => {
      chunks.push(chunk);
    },
  });
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "git version");
  assertEquals(chunks.join(""), result.stdout);
});

Deno.test("직접 요청은 종료 전에 공개 활동을 전달하고 민감한 내용과 최종 응답을 진행 출력에 섞지 않는다", async () => {
  await using dir = await tempDir();
  for (const agent of ["codex", "claude"] as const) {
    const progress: string[] = [];
    const events = agent === "codex"
      ? [
        { type: "thread.started", thread_id: codexId },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: { type: "reasoning", text: "private-reasoning" },
        },
        {
          type: "item.started",
          item: { type: "command_execution", command: "secret-argument" },
        },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            aggregated_output: "secret-output",
          },
        },
        {
          type: "item.completed",
          item: { type: "agent_message", text: "최종 답변" },
        },
        { type: "turn.completed" },
      ]
      : [
        { type: "system", subtype: "init", session_id: claudeId },
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "private-reasoning" },
              {
                type: "tool_use",
                id: "call",
                name: "Read",
                input: "secret-argument",
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "call",
              content: "secret-output",
            }],
          },
        },
        {
          type: "result",
          session_id: claudeId,
          subtype: "success",
          is_error: false,
          result: "최종 답변",
        },
      ];
    const output = events.map(line).join("");
    const test = setup(dir.path, "작업", [{
      cmd: agent,
      stdoutChunks: [output.slice(0, 17), output.slice(17)],
      afterOutput: () => {
        assertStringIncludes(
          progress.join(""),
          agent === "codex" ? codexId : claudeId,
        );
        assertStringIncludes(progress.join(""), "direct");
        assertStringIncludes(progress.join(""), "tool_started");
        assertStringIncludes(progress.join(""), "tool_completed");
      },
    }]);
    const result = await runDelegate(["prompt", "--agent", agent], {
      ...test.deps,
      ...{
        progress: (text: string) => {
          progress.push(text);
        },
      },
    });
    assertEquals(result.code, 0);
    assertEquals(
      result.stdout,
      `---\nsession_id: ${
        agent === "codex" ? codexId : claudeId
      }\nagent: ${agent}\nactivity: quiescent\n---\n\n최종 답변\n`,
    );
    for (
      const secret of [
        "private-reasoning",
        "secret-argument",
        "secret-output",
        "최종 답변",
      ]
    ) {
      assertEquals(progress.join("").includes(secret), false);
    }
  }
});

Deno.test("직접 세션의 상태와 로그는 생존을 추측하지 않고 최신 미완료 요청과 공개 활동을 표시한다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  writeJsonl(path, [
    codexMeta(),
    ...codexTurn("old", "이전 요청", "이전 답변"),
    ...codexTurn("new", "새 요청"),
    {
      type: "response_item",
      timestamp: "2026-09-22T01:02:03Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: "secret-argument",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-09-22T01:02:04Z",
      payload: { type: "reasoning", summary: "private-reasoning" },
    },
  ], '{"type":"event_msg"');
  for (const herdrEnv of [false, true]) {
    const test = setup(dir.path, "", herdrEnv ? [herdr({ agents: [] })] : [], {
      env: herdrEnv ? { HERDR_ENV: "1" } : {},
    });
    const status = await runDelegate(["status", codexId], test.deps);
    assertStringIncludes(status.stdout, "activity: unknown");
    assertStringIncludes(status.stdout, "request_state: incomplete");
    assertStringIncludes(status.stdout, "2026-09-22T01:02:04Z");
    const logs = await runDelegate(["logs", codexId], test.deps);
    assertStringIncludes(logs.stdout, "tool_started");
    assertStringIncludes(logs.stdout, "exec_command");
    assertStringIncludes(logs.stdout, "partial_record: true");
    assertStringIncludes(logs.stdout, "이전 답변");
    assertStringIncludes(logs.stdout, "새 요청");
    assertEquals(logs.stdout.includes("secret-argument"), false);
    assertEquals(logs.stdout.includes("private-reasoning"), false);
  }
});

Deno.test("직접 대기는 이전 답변을 반환하지 않고 부분 기록이 완성된 최신 요청 결과를 기다린다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  writeJsonl(path, [
    codexMeta(),
    ...codexTurn("old", "이전 요청", "이전 답변"),
    ...codexTurn("new", "새 요청").slice(0, 2),
  ], '{"type":"turn_context"');
  let sleeps = 0;
  let now = 0;
  const test = setup(dir.path, "", [], {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      sleeps++;
      if (sleeps === 2) {
        writeJsonl(path, [
          codexMeta(),
          ...codexTurn("old", "이전 요청", "이전 답변"),
          ...codexTurn("new", "새 요청", "새 답변"),
        ]);
      }
      return Promise.resolve();
    },
  });
  const result = await runDelegate(
    ["wait", codexId, "--timeout", "2s"],
    test.deps,
  );
  assertEquals(result.code, 0);
  assertEquals(sleeps, 2);
  assertStringIncludes(result.stdout, "새 답변");
  assertEquals(result.stdout.includes("이전 답변"), false);
  assertEquals(result.stdout.includes("intervening_prompts"), false);
  assertStringIncludes(result.stdout, "activity: unknown");
});

Deno.test("대기 중 같은 기록 파일을 잘랐다가 더 길게 다시 써도 교체 요청의 결과를 반환하지 않는다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  writeJsonl(path, [codexMeta(), ...codexTurn("target", "원래 요청")]);
  const before = Deno.statSync(path);
  let now = 0;
  const test = setup(dir.path, "", [], {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      Deno.truncateSync(path, 0);
      appendJsonl(path, [
        codexMeta(),
        ...codexTurn("target", "교체 요청", "반환하면 안 되는 교체 결과"),
      ]);
      const after = Deno.statSync(path);
      assertEquals(after.ino, before.ino);
      assertEquals(after.size > before.size, true);
      return Promise.resolve();
    },
  });
  const result = await runDelegate(
    ["wait", codexId, "--timeout", "1s"],
    test.deps,
  );
  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "code: invalid_native_session");
  assertEquals(result.stdout.includes("반환하면 안 되는 교체 결과"), false);
});

Deno.test("클로드 대기의 이름 지정은 Herdr와 직접 실행 모두 사용법 오류로 거부한다", async () => {
  await using dir = await tempDir();
  writeJsonl(claudePath(dir.path), [
    ...claudeOpen("요청"),
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "답변" }] },
    },
    { type: "system", subtype: "turn_duration" },
  ]);
  for (const herdrEnv of [true, false]) {
    const test = setup(dir.path, "", [], {
      env: herdrEnv ? { HERDR_ENV: "1" } : {},
    });
    const result = await runDelegate(
      ["wait", claudeId, "--name", "검토"],
      test.deps,
    );
    assertEquals(result.code, 2, herdrEnv ? "Herdr" : "직접 실행");
    assertStringIncludes(result.stdout, "code: usage");
    assertStringIncludes(
      result.stdout,
      "Claude wait에는 --name을 사용할 수 없습니다",
    );
    assertEquals(test.fake.calls, []);
  }
});

Deno.test("직접 대기는 중단 기록과 호출자 취소를 구별하고 종료 근거 없는 기록은 시간 제한까지 기다린다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  for (
    const scenario of [
      "aborted",
      "cancelled",
      "silent",
      "partial",
      "partial_after_abort",
    ] as const
  ) {
    writeJsonl(
      path,
      [
        codexMeta(),
        ...codexTurn(
          "new",
          "새 요청",
          undefined,
          scenario === "aborted" || scenario === "partial_after_abort"
            ? "aborted"
            : "open",
        ),
      ],
      scenario === "partial" || scenario === "partial_after_abort"
        ? '{"type":"event_msg","payload":{"type":"task_complete"'
        : "",
    );
    let now = 0;
    const controller = new AbortController();
    const test = setup(dir.path, "", [], {
      signal: controller.signal,
      now: () => now,
      sleep: (ms) => {
        now += ms;
        if (scenario === "cancelled") {
          controller.abort();
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        }
        return Promise.resolve();
      },
    });
    const result = await runDelegate(
      ["wait", codexId, "--timeout", "1s"],
      test.deps,
    );
    assertEquals(
      result.code,
      scenario === "aborted" || scenario === "cancelled" ? 130 : 6,
      scenario,
    );
    assertStringIncludes(result.stdout, codexId);
    if (scenario === "silent" || scenario === "partial") {
      assertEquals(
        now,
        1_000,
      );
    }
  }
});

Deno.test("직접 실행을 제어할 수 없는 닫기 요청은 지원 범위를 알리는 오류를 반환한다", async () => {
  await using dir = await tempDir();
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("new", "새 요청"),
  ]);
  for (const herdrEnv of [false, true]) {
    const test = setup(dir.path, "", herdrEnv ? [herdr({ agents: [] })] : [], {
      env: herdrEnv ? { HERDR_ENV: "1" } : {},
    });
    const result = await runDelegate(["close", codexId], test.deps);
    assertEquals(result.code, 3);
    assertStringIncludes(result.stdout, "code: transport_unavailable");
    assertStringIncludes(result.stdout, "Herdr");
  }
});

Deno.test("창 없는 클로드 세션도 새 요청 뒤 추가 요청까지 마친 결과와 공개 도구 활동을 회수한다", async () => {
  await using dir = await tempDir();
  const path = claudePath(dir.path);
  const completed = [
    ...claudeOpen("이전 요청"),
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "이전 답변" }] },
    },
    { type: "system", subtype: "turn_duration" },
  ];
  writeJsonl(path, completed, '{"type":"user"');
  let now = 0;
  const test = setup(dir.path, "", [herdr({ agents: [] })], {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      writeJsonl(path, [
        ...completed,
        ...claudeOpen("새 요청"),
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "새 답변" }] },
        },
        { type: "system", subtype: "turn_duration" },
        ...claudeOpen("추가 요청"),
        {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "call",
              name: "Read",
              input: "secret-argument",
            }],
          },
        },
        {
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "call",
              content: "secret-output",
            }],
          },
        },
      ]);
      if (now >= 500) {
        appendJsonl(path, [
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "추가 답변" }] },
          },
          { type: "system", subtype: "turn_duration" },
        ]);
      }
      return Promise.resolve();
    },
  });
  const result = await runDelegate(
    ["wait", claudeId, "--timeout", "2s"],
    test.deps,
  );
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "추가 답변");
  assertStringIncludes(result.stdout, "intervening_prompts:\n  - 추가 요청");
  assertEquals(result.stdout.includes("이전 답변"), false);
  assertEquals(now, 500);
  writeJsonl(path, [
    ...claudeOpen("도구 실행"),
    {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "call",
          name: "Read",
          input: "secret-argument",
        }],
      },
    },
    {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "call",
          content: "secret-output",
        }],
      },
    },
  ]);
  const logs = await runDelegate(["logs", claudeId], test.deps);
  assertStringIncludes(logs.stdout, "tool_completed");
  assertStringIncludes(logs.stdout, "Read");
  assertEquals(logs.stdout.includes("secret-"), false);
});

Deno.test("직접 요청의 비정상 종료와 불완전 출력도 먼저 관찰한 세션과 실패 상태를 보존한다", async () => {
  await using dir = await tempDir();
  for (const agent of ["codex", "claude"] as const) {
    const id = agent === "codex" ? codexId : claudeId;
    const event = agent === "codex"
      ? { type: "thread.started", thread_id: id }
      : { type: "system", subtype: "init", session_id: id };
    const progress: string[] = [];
    const test = setup(dir.path, "작업", [{
      cmd: agent,
      code: 1,
      stdoutChunks: [line(event), '{"type":'],
    }]);
    const result = await runDelegate(["prompt", "--agent", agent], {
      ...test.deps,
      progress: (text) => {
        progress.push(text);
      },
    });
    assertEquals(result.code, 5);
    assertStringIncludes(result.stdout, id);
    assertStringIncludes(result.stdout, "code: agent_failed");
    assertEquals(progress.length, 1);
  }
});
