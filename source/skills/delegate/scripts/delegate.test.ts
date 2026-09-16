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
          completed_at: "2026-09-16T00:00:00Z",
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

Deno.test("사용자가 새 작업을 detach하고 상태 확인·wait·logs·close를 이어가면 같은 native session의 대화와 정리 결과를 받는다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  const longPrompt = Array.from(
    { length: 64 },
    (_, index) =>
      `${index + 1}번째 줄: 내부 공백  과 CRLF를 그대로 보존합니다.`,
  ).join("\r\n");
  const submittedPrompt = `\uFEFF${longPrompt}\r\n`;
  const firstPrompt = `${prefix}${longPrompt}`;
  let now = 0;
  const responses: FakeResponse[] = [
    herdr({ pane: { workspace_id: "ws-1", tab_id: "tab-current" } }),
    herdr({ tabs: [] }),
    herdr({
      tab: { tab_id: "tab-delegate" },
      root_pane: { pane_id: "pane-delegate" },
    }),
    herdr({ tabs: [{ tab_id: "tab-delegate", label: "caller-1" }] }),
    herdr({}),
    herdr({}, {
      onStart: () =>
        writeJsonl(path, [codexMeta(), ...codexTurn("turn-1", firstPrompt)]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("working", 1) }),
    herdr({ agents: [liveAgent("working", 1)] }),
    herdr({ agents: [liveAgent("working", 3)] }),
    herdr({ agent: liveAgent("done", 3) }),
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
  const start = setup(dir.path, submittedPrompt, responses, {
    env: { HERDR_ENV: "1" },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });

  const detached = await runDelegate([
    "prompt",
    "--agent",
    "codex",
    "--detach",
    "--caller-id",
    "caller-1",
    "--timeout",
    "1s",
  ], start.deps);
  assertEquals(detached.code, 0);
  assertStringIncludes(detached.stdout, `session_id: ${codexId}`);
  assertStringIncludes(detached.stdout, "activity: working");
  assertEquals(
    start.fake.calls.find((call) => call.args[1] === "prompt")?.args[3],
    firstPrompt,
  );

  const status = await runDelegate(["status", codexId], start.deps);
  assertEquals(status.code, 0);
  assertStringIncludes(status.stdout, "activity: working");

  appendJsonl(path, [
    ...codexTurn("turn-1-tail", "ignored", "ignored", "aborted"),
    ...codexTurn("turn-2", `${prefix}수동 후속 요청`, "최신 완료 결과"),
  ]);
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
  assertStringIncludes(waited.stdout, "result: 최신 완료 결과");
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
          ...codexTurn("file", sentPrompt),
        ]),
    }),
    herdr({}),
    herdr({ agent: liveAgent("working", 1) }),
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
    "--detach",
    "--timeout",
    "1s",
  ], test.deps);

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, `session_id: ${codexId}`);
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
      '{"type":"item.completed","item":{"type":"agent_message","text":"완료"}}\n',
  }]);
  const completed = await runDelegate([
    "prompt",
    "--transport",
    "direct",
    "--agent",
    "codex",
  ], normal.deps);
  assertEquals(completed.code, 0);
  assertStringIncludes(completed.stdout, "activity: quiescent");
  assertStringIncludes(completed.stdout, "result: 완료");
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
  assertStringIncludes(resumed.stdout, "result: 클로드 재개");
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
  assertStringIncludes(resumed.stdout, "result: 재개 결과");
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

Deno.test("Herdr gate와 정숙 판정은 deadline을 공유하고 중단 시 확인된 session ID를 보존한다", async () => {
  await using dir = await tempDir();
  const path = codexPath(dir.path);
  writeJsonl(path, [codexMeta(), ...codexTurn("old", "이전", "완료")]);
  let now = 0;
  let delayedPromptWritten = false;
  const sleeps: number[] = [];
  const timed = setup(dir.path, "늦은 prompt", [
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
    "--detach",
  ], created.deps);
  assertEquals(createdInterrupted.code, 130);
  assertStringIncludes(createdInterrupted.stdout, "code: cancelled");
  assertStringIncludes(createdInterrupted.stdout, `session_id: ${createdId}`);
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
      onStart: () => writeJsonl(path, claudeOpen(`${prefix}화면 작업`)),
    }),
    herdr({}),
    herdr({ agent: claudeLive("working", 1) }),
    herdr({ agents: [claudeLive("working", 1)] }),
  ], { env: { HERDR_ENV: "1" } });

  const started = await runDelegate([
    "prompt",
    "--agent",
    "claude",
    "--caller-id",
    "caller-claude",
    "--name",
    "화면",
    "--detach",
  ], test.deps);
  assertEquals(started.code, 0);
  const start = test.fake.calls.find((call) => call.args[1] === "start");
  assertEquals(start?.args.includes("--name=caller-claude 화면"), true);

  const conflict = await runDelegate([
    "prompt",
    claudeId,
    "--caller-id",
    "caller-claude",
    "--name",
    "새 이름",
  ], test.deps);
  assertEquals(conflict.code, 2);
  assertStringIncludes(conflict.stdout, "code: live_option_conflict");

  const waitName = await runDelegate([
    "wait",
    claudeId,
    "--name",
    "새 이름",
  ], test.deps);
  assertEquals(waitName.code, 2);
  assertStringIncludes(waitName.stdout, "code: usage");
  assertEquals(test.fake.calls.length, 9);
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

Deno.test("코덱스 native fixture는 bootstrap·도구·중단 turn을 제외하고 완료 대화와 부분 record 상태를 보존한다", async () => {
  await using dir = await tempDir();
  writeJsonl(codexPath(dir.path), [
    codexMeta(),
    ...codexTurn("turn-1", "사람 요청", "최종 답변"),
    ...codexTurn("turn-2", "취소 요청", undefined, "aborted"),
  ], '{"type":"response_item"');
  const snapshot = await findNativeSession(
    codexId,
    setup(dir.path, "").deps.env,
  );
  assertEquals(snapshot.cursor.partial, true);
  assertEquals(snapshot.completedTurns, [{
    turn_id: "turn-1",
    completed_at: "2026-09-16T00:00:00Z",
  }]);
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
  assertEquals(
    snapshot.completedTurns[0]?.turn_id,
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
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
  assertStringIncludes(result.stdout, "result: 완료");
  assertStringIncludes(result.stdout, "code: unmanaged_tab");
  assertEquals(test.fake.calls.some((call) => call.args[1] === "close"), false);
});

Deno.test("정숙 구간 중 sequence와 native cursor가 바뀌면 500ms 판정을 재무장하고 최신 완료 결과를 반환한다", async () => {
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
  assertStringIncludes(result.stdout, "result: 최신 결과");
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
  assertStringIncludes(result.stdout, "result: 완료");
  assertStringIncludes(result.stdout, "code: tab_close_blocked");
  assertStringIncludes(result.stdout, "pane_id: pane-working");
  assertStringIncludes(result.stdout, "pane_id: pane-unknown");
  assertEquals(test.fake.calls.some((call) => call.args[1] === "close"), false);
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

Deno.test("삭제된 명령과 옵션·위치 prompt·direct detach·확인 없는 write 재개는 실행 전에 거부된다", async () => {
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
  const detach = await runDelegate([
    "prompt",
    "--transport",
    "direct",
    "--detach",
  ], base.deps);
  assertEquals(detach.code, 2);
  assertStringIncludes(detach.stdout, "code: detach_requires_herdr");

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

Deno.test("공개 오류는 명세의 종료 코드로만 매핑된다", () => {
  const cases = {
    usage: 2,
    invalid_session_id: 2,
    live_option_conflict: 2,
    detach_requires_herdr: 2,
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
