import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@^1";
import { planClaude } from "./claude.ts";
import { planCodex } from "./codex.ts";
import { resolveStateDir, runDelegate } from "./delegate.ts";
import { renderDocument } from "./document.ts";
import { fakeExec } from "./fakes.ts";
import { denoExec } from "./process.ts";
import { readRun, writeRun } from "./runs.ts";
import { parseDuration, selectAgent } from "./select.ts";

function testDeps(
  stateDir: string,
  prompt: string,
  options: { env?: Record<string, string>; terminal?: boolean } = {},
) {
  const calls: unknown[] = [];
  return {
    calls,
    deps: {
      exec: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      env: options.env ?? {},
      stdin: {
        isTerminal: () => options.terminal ?? false,
        text: () => Promise.resolve(prompt),
      },
      stateDir,
      cwd: "/workspace",
      signal: new AbortController().signal,
      now: () => new Date("2026-09-14T00:00:00.000Z"),
    },
  };
}

async function tempDir() {
  const path = await Deno.makeTempDir({ prefix: "delegate-test-" });
  return {
    path,
    async [Symbol.asyncDispose]() {
      await Deno.remove(path, { recursive: true });
    },
  };
}

function runIdFrom(document: string): string {
  const match = /^run_id: (run_[0-9a-f-]+)$/m.exec(document);
  if (match?.[1] == null) throw new Error("run_id 없음");
  return match[1];
}

Deno.test("상태 디렉터리는 명시값, XDG, 홈 디렉터리 순서로 선택한다", () => {
  assertEquals(
    resolveStateDir({
      DELEGATE_STATE_DIR: "/explicit",
      XDG_STATE_HOME: "/xdg",
      HOME: "/home/test",
    }),
    "/explicit",
  );
  assertEquals(
    resolveStateDir({ XDG_STATE_HOME: "/xdg", HOME: "/home/test" }),
    "/xdg/delegate",
  );
  assertEquals(
    resolveStateDir({ HOME: "/home/test" }),
    "/home/test/.local/state/delegate",
  );
});

Deno.test(
  "Herdr 밖에서 stdin으로 조사 요청을 넘겨 dry-run하면 코덱스 읽기 전용 명령이 담긴 planned 문서를 받고 아무 프로세스도 실행되지 않는다",
  async () => {
    await using dir = await tempDir();
    const prompt = "원인을 조사하고 계획만 제시하세요.";
    const { calls, deps } = testDeps(dir.path, prompt);

    const result = await runDelegate(["run", "--dry-run"], deps);

    assertEquals(result.code, 0);
    assertEquals(calls, []);
    assertStringIncludes(result.stdout, "status: planned");
    assertStringIncludes(result.stdout, "agent: codex");
    assertStringIncludes(result.stdout, "transport: direct");
    assertStringIncludes(result.stdout, "permission: read-only");
    assertStringIncludes(result.stdout, "command:");
    assertStringIncludes(result.stdout, "  - codex");
    assertStringIncludes(result.stdout, "source: stdin");
    assertStringIncludes(
      result.stdout,
      `bytes: ${new TextEncoder().encode(prompt).length}`,
    );
    assertEquals(result.stdout.includes(prompt), false);
  },
);

Deno.test(
  "프롬프트 파일로 dry-run하면 절대 경로와 내용 식별 정보만 문서에 남는다",
  async () => {
    await using dir = await tempDir();
    const promptPath = `${dir.path}/prompt.md`;
    await Deno.writeTextFile(promptPath, "프론트엔드 화면을 구현하세요.\n");
    const { calls, deps } = testDeps(dir.path, "읽으면 안 됨");

    const result = await runDelegate([
      "run",
      "--dry-run",
      "--prompt-file",
      promptPath,
    ], deps);

    assertEquals(result.code, 0);
    assertEquals(calls, []);
    assertStringIncludes(result.stdout, "agent: claude");
    assertStringIncludes(result.stdout, "source: file");
    assertStringIncludes(result.stdout, promptPath);
    assertStringIncludes(result.stdout, "sha256:");
    assertEquals(result.stdout.includes("프론트엔드 화면"), false);
  },
);

Deno.test("작업 성격 네 가지를 결정적 규칙으로 에이전트에 배정한다", () => {
  const cases = [
    ["변경 원인을 디버깅하고 검토하세요", "codex", "task-kind=analysis"],
    ["프론트엔드 화면을 구현하세요", "claude", "task-kind=frontend"],
    [
      "여러 작업을 조율하고 넓은 맥락을 조사하세요",
      "claude",
      "task-kind=coordination",
    ],
    ["일반 기능을 구현하세요", "codex", "task-kind=default"],
  ] as const;

  for (const [prompt, agent, reason] of cases) {
    assertEquals(selectAgent(prompt), { agent, reason });
  }
});

Deno.test("코덱스 읽기 전용은 쓰기 승인을 켜지 않고 write와 resume은 정해진 인자를 사용한다", () => {
  const common = {
    cwd: "/workspace",
    addDirs: ["/reference"],
    effort: "high",
    model: "gpt-test",
    prompt: "작업",
  } as const;

  assertEquals(planCodex({ ...common, permission: "read-only" }).directArgs, [
    "--search",
    "-s",
    "read-only",
    "-a",
    "never",
    "-C",
    "/workspace",
    "--add-dir",
    "/reference",
    "-m",
    "gpt-test",
    "-c",
    "model_reasoning_effort=high",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-",
  ]);
  assertEquals(planCodex({ ...common, permission: "write" }).directArgs, [
    "--search",
    "--approve-for-me",
    "-C",
    "/workspace",
    "--add-dir",
    "/reference",
    "-m",
    "gpt-test",
    "-c",
    "model_reasoning_effort=high",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-",
  ]);
  assertEquals(
    planCodex({
      ...common,
      permission: "read-only",
      resumeSessionId: "thread-1",
    }).directArgs,
    [
      "--search",
      "-s",
      "read-only",
      "-a",
      "never",
      "-C",
      "/workspace",
      "--add-dir",
      "/reference",
      "-m",
      "gpt-test",
      "-c",
      "model_reasoning_effort=high",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "resume",
      "thread-1",
      "-",
    ],
  );
});

Deno.test("클로드 읽기 전용은 도구를 제한하고 write와 resume도 마지막 stdin 인자를 보존한다", () => {
  const common = {
    cwd: "/workspace",
    addDirs: ["/reference"],
    callerId: "caller",
    name: "frontend",
    effort: "high",
    model: "best",
    prompt: "작업",
  } as const;

  assertEquals(planClaude({ ...common, permission: "read-only" }).directArgs, [
    "-p",
    "--verbose",
    "--output-format=stream-json",
    "--model=best",
    "--effort=high",
    "--restricted",
    "--permission-mode=dontAsk",
    "--permission-prompts=none",
    "--tools=Read,Glob,Grep,WebSearch,WebFetch",
    "--allowedTools=WebSearch,WebFetch(domain:*)",
    "--strict-mcp-config",
    "--add-dir=/reference",
    "--name=caller frontend",
    "-",
  ]);
  assertEquals(planClaude({ ...common, permission: "write" }).directArgs, [
    "-p",
    "--verbose",
    "--output-format=stream-json",
    "--model=best",
    "--effort=high",
    "--permission-mode=auto",
    "--allowedTools=WebSearch,WebFetch(domain:*)",
    "--disallowedTools=Skill(codex-tools:codex),Skill(claude-tools:claude)",
    "--add-dir=/reference",
    "--name=caller frontend",
    "-",
  ]);
  assertEquals(
    planClaude({
      ...common,
      permission: "read-only",
      resumeSessionId: "session-1",
    }).directArgs,
    [
      "-p",
      "--verbose",
      "--output-format=stream-json",
      "--model=best",
      "--effort=high",
      "--restricted",
      "--permission-mode=dontAsk",
      "--permission-prompts=none",
      "--tools=Read,Glob,Grep,WebSearch,WebFetch",
      "--allowedTools=WebSearch,WebFetch(domain:*)",
      "--strict-mcp-config",
      "--add-dir=/reference",
      "--name=caller frontend",
      "--resume=session-1",
      "-",
    ],
  );
});

Deno.test("시간 단위는 밀리초로 바꾸고 잘못된 값은 거부한다", () => {
  assertEquals(parseDuration("20m"), 1_200_000);
  assertEquals(parseDuration("1500ms"), 1_500);
  assertThrows(() => parseDuration("later"), RangeError, "잘못된 duration");
});

Deno.test("터미널에서 프롬프트 없이 실행하면 기다리지 않고 사용법 오류로 끝난다", async () => {
  await using dir = await tempDir();
  const { calls, deps } = testDeps(dir.path, "", { terminal: true });
  const result = await runDelegate(["run"], deps);
  assertEquals(result.code, 2);
  assertEquals(calls, []);
  assertStringIncludes(result.stdout, "status: failed");
  assertStringIncludes(result.stdout, "code: usage");
  assertStringIncludes(result.stdout, "stdin 프롬프트가 필요합니다");
});

Deno.test("Herdr 밖에서 detach를 요청하면 dry-run이어도 실행 전에 사용법 오류로 끝난다", async () => {
  await using dir = await tempDir();
  const { calls, deps } = testDeps(dir.path, "작업을 수행하세요.");
  const result = await runDelegate([
    "run",
    "--transport",
    "direct",
    "--detach",
    "--dry-run",
  ], deps);
  assertEquals(result.code, 2);
  assertEquals(calls, []);
  assertStringIncludes(result.stdout, "--detach는 Herdr 전송에서만");
});

Deno.test("위치 인자 프롬프트를 넘기면 stdin을 읽지 않고 사용법 오류로 끝난다", async () => {
  await using dir = await tempDir();
  const { calls, deps } = testDeps(dir.path, "읽으면 안 됨");
  const result = await runDelegate(["run", "위치 인자"], deps);
  assertEquals(result.code, 2);
  assertEquals(calls, []);
  assertStringIncludes(result.stdout, "code: usage");
  assertStringIncludes(result.stdout, "Unexpected option or subcommand");
  assertStringIncludes(result.stderr, "Unexpected option or subcommand");
});

Deno.test("잘못됐거나 존재하지 않는 run ID를 조회하면 사용법 오류로 끝난다", async () => {
  await using dir = await tempDir();
  const { deps } = testDeps(dir.path, "");
  const malformed = await runDelegate(["status", "session-1"], deps);
  const missing = await runDelegate([
    "status",
    "run_00000000-0000-4000-8000-000000000000",
  ], deps);
  assertEquals(malformed.code, 2);
  assertStringIncludes(malformed.stdout, "잘못된 run ID");
  assertEquals(missing.code, 2);
  assertStringIncludes(missing.stdout, "실행 기록 없음");
});

Deno.test(
  "Herdr 밖에서 write 권한으로 프론트엔드 작업을 위임하면 클로드가 직접 실행되어 done 문서에 세션 ID와 응답이 담기고, 그 run ID로 재개하면 같은 권한으로 같은 세션에 후속 지시가 전달되며 status와 logs로 두 실행을 조회할 수 있다",
  async () => {
    await using dir = await tempDir();
    const fake = fakeExec([
      {
        cmd: "claude",
        stdout:
          '{"type":"system","subtype":"init","session_id":"session-1"}\n' +
          '{"type":"result","subtype":"success","is_error":false,"session_id":"session-1","result":"첫 응답"}\n',
        stderr: "first diagnostic\n```embedded\n",
      },
      {
        cmd: "claude",
        stdout:
          '{"type":"result","subtype":"success","is_error":false,"session_id":"session-1","result":"후속 응답"}\n',
        stderr: "second diagnostic\n",
      },
    ]);
    const firstSetup = testDeps(dir.path, "프론트엔드 화면을 구현하세요.");
    const first = await runDelegate(
      ["run", "--permission", "write", "--name", "화면"],
      { ...firstSetup.deps, exec: fake.exec },
    );
    const firstId = runIdFrom(first.stdout);

    assertEquals(first.code, 0);
    assertStringIncludes(first.stdout, "status: done");
    assertStringIncludes(first.stdout, "session_id: session-1");
    assertStringIncludes(first.stdout, "첫 응답");
    assertEquals(fake.calls[0]?.cmd, "claude");
    assertEquals(fake.calls[0]?.args.includes("--permission-mode=auto"), true);
    assertStringIncludes(
      fake.calls[0]?.stdin ?? "",
      "claude와 codex 재호출 금지.",
    );

    const resumedSetup = testDeps(dir.path, "후속 지시입니다.");
    const resumed = await runDelegate(["resume", firstId], {
      ...resumedSetup.deps,
      exec: fake.exec,
    });
    const resumedId = runIdFrom(resumed.stdout);

    assertEquals(resumed.code, 0);
    assertStringIncludes(resumed.stdout, "permission: write");
    assertStringIncludes(resumed.stdout, "후속 응답");
    assertEquals(fake.calls[1]?.args.includes("--resume=session-1"), true);
    assertEquals(fake.calls[1]?.args.includes("--permission-mode=auto"), true);

    const status = await runDelegate(["status", resumedId], resumedSetup.deps);
    const logs = await runDelegate(
      ["logs", firstId, "--lines", "2"],
      resumedSetup.deps,
    );
    assertEquals(status.code, 0);
    assertStringIncludes(status.stdout, "status: done");
    assertStringIncludes(status.stdout, "후속 응답");
    assertEquals(logs.code, 0);
    assertStringIncludes(logs.stdout, "````text");
    assertStringIncludes(logs.stdout, "first diagnostic");
    assertStringIncludes(logs.stdout, "```embedded");
    const closed = await runDelegate(["close", firstId], resumedSetup.deps);
    assertEquals(closed.code, 0);
    assertStringIncludes(closed.stdout, "status: done");
  },
);

Deno.test("네이티브 세션 ID와 에이전트를 지정하면 dry-run과 실제 직접 실행 모두 같은 세션을 재개한다", async () => {
  await using dir = await tempDir();
  const setup = testDeps(dir.path, "후속 작업을 수행하세요.");
  const dryRun = await runDelegate([
    "resume",
    "thread-native",
    "--agent",
    "codex",
    "--transport",
    "direct",
    "--dry-run",
  ], setup.deps);

  assertEquals(dryRun.code, 0);
  assertStringIncludes(dryRun.stdout, "session_id: thread-native");
  assertStringIncludes(dryRun.stdout, "  - resume");
  assertStringIncludes(dryRun.stdout, "  - thread-native");

  const fake = fakeExec([{
    cmd: "codex",
    stdout: '{"type":"thread.started","thread_id":"thread-native"}\n' +
      '{"type":"item.completed","item":{"type":"agent_message","text":"재개 완료"}}\n',
  }]);
  const executed = await runDelegate([
    "resume",
    "thread-native",
    "--agent",
    "codex",
    "--transport",
    "direct",
  ], { ...setup.deps, exec: fake.exec });

  assertEquals(executed.code, 0);
  assertStringIncludes(executed.stdout, "status: done");
  assertStringIncludes(executed.stdout, "재개 완료");
  assertEquals(fake.calls[0]?.args.includes("thread-native"), true);
});

Deno.test("run ID 재개에서 부모와 다른 에이전트나 전송 방식을 지정하면 실행 전에 거부한다", async () => {
  await using dir = await tempDir();
  const runId = "run_00000000-0000-4000-8000-000000000010";
  await writeRun(dir.path, {
    runId,
    agent: "codex",
    transport: "direct",
    permission: "read-only",
    cwd: "/workspace",
    reason: ["parent"],
    nativeSessionId: "thread-parent",
    status: "done",
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
  });
  const setup = testDeps(dir.path, "후속 작업입니다.");

  const agentConflict = await runDelegate([
    "resume",
    runId,
    "--agent",
    "claude",
    "--dry-run",
  ], setup.deps);
  const transportConflict = await runDelegate([
    "resume",
    runId,
    "--transport",
    "herdr",
    "--dry-run",
  ], setup.deps);

  assertEquals(agentConflict.code, 2);
  assertStringIncludes(agentConflict.stdout, "부모 실행의 agent=codex");
  assertEquals(transportConflict.code, 2);
  assertStringIncludes(
    transportConflict.stdout,
    "부모 실행의 transport=direct",
  );
  assertEquals(setup.calls, []);
});

Deno.test("에이전트 응답이 frontmatter 구분자로 시작해도 문서 본문에 그대로 남는다", async () => {
  await using dir = await tempDir();
  const fake = fakeExec([{
    cmd: "codex",
    stdout: '{"type":"thread.started","thread_id":"thread-1"}\n' +
      '{"type":"item.completed","item":{"type":"agent_message","text":"---\\n응답"}}\n' +
      '{"type":"turn.completed"}\n',
  }]);
  const setup = testDeps(dir.path, "일반 기능을 구현하세요.");

  const result = await runDelegate(["run"], {
    ...setup.deps,
    exec: fake.exec,
  });

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "---\n\n---\n응답");
});

Deno.test("긴 frontmatter 값은 접힌 YAML 블록으로 바꾸지 않는다", () => {
  const cwd = `/${"long-segment/".repeat(20)}workspace`;
  const document = renderDocument({ status: "planned", cwd });

  assertStringIncludes(document, `cwd: ${cwd}\n`);
  assertEquals(document.includes("cwd: >-"), false);
});

Deno.test("자식 프로세스가 stdin을 읽기 전에 끝나도 stdout과 종료 상태를 회수한다", async () => {
  const result = await denoExec("git", ["--version"], {
    cwd: Deno.cwd(),
    env: { PATH: Deno.env.get("PATH") ?? "" },
    stdin: "x".repeat(1_000_000),
  });

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "git version");
});

Deno.test("직접 실행에서는 자식이 Herdr 환경 변수를 물려받지 않는다", async () => {
  await using dir = await tempDir();
  const fake = fakeExec([{
    cmd: "codex",
    stdout: '{"type":"thread.started","thread_id":"thread-1"}\n' +
      '{"type":"item.completed","item":{"type":"agent_message","text":"완료"}}\n',
  }]);
  const setup = testDeps(dir.path, "일반 기능을 구현하세요.", {
    env: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "workspace-secret",
      PATH: "/bin",
      KEEP_ME: "yes",
    },
  });

  const result = await runDelegate([
    "run",
    "--transport",
    "direct",
  ], { ...setup.deps, exec: fake.exec });

  assertEquals(result.code, 0);
  assertEquals(fake.calls[0]?.env, { PATH: "/bin", KEEP_ME: "yes" });
});

Deno.test(
  "Herdr 작업 완료 뒤 탭 정리가 실패해도 done 결과를 유지하고 정리 오류를 진단한다",
  async () => {
    await using dir = await tempDir();
    const fake = fakeExec([
      {
        cmd: "herdr",
        stdout: JSON.stringify({
          result: {
            pane: {
              workspace_id: "ws-1",
              tab_id: "tab-current",
              pane_id: "pane-current",
              agent_session: { value: "caller-1" },
            },
          },
        }),
      },
      { cmd: "herdr", stdout: '{"result":{"tabs":[]}}' },
      {
        cmd: "herdr",
        stdout:
          '{"result":{"tab":{"tab_id":"tab-delegate"},"root_pane":{"pane_id":"pane-delegate"}}}',
      },
      { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"idle"}}}' },
      { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"done"}}}' },
      { cmd: "herdr", stdout: "검토 결과" },
      {
        cmd: "herdr",
        stdout:
          '{"result":{"agent":{"agent_status":"done","agent_session":{"value":"thread-herdr"}}}}',
      },
      {
        cmd: "herdr",
        stdout:
          '{"result":{"panes":[{"pane_id":"pane-delegate","tab_id":"tab-delegate","agent":"dlg","agent_status":"done"}]}}',
      },
      {
        cmd: "herdr",
        code: 1,
        stderr: '{"error":{"code":"close_failed","message":"tab stayed open"}}',
      },
    ]);
    const setup = testDeps(dir.path, "현재 변경을 검토하세요.", {
      env: { HERDR_ENV: "1", PATH: "/bin" },
    });

    const result = await runDelegate(["run"], {
      ...setup.deps,
      exec: fake.exec,
    });

    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, "status: done");
    assertStringIncludes(result.stdout, "transport: herdr");
    assertStringIncludes(result.stdout, "session_id: thread-herdr");
    assertStringIncludes(result.stdout, "tab_id: tab-delegate");
    assertStringIncludes(result.stdout, "pane_id: pane-delegate");
    assertStringIncludes(result.stdout, "검토 결과");
    assertStringIncludes(result.stdout, "code: tab_close_failed");
    assertStringIncludes(result.stdout, "tab stayed open");
    assertEquals(fake.calls.map((call) => call.args.slice(0, 2)), [
      ["pane", "current"],
      ["tab", "list"],
      ["tab", "create"],
      ["agent", "start"],
      ["agent", "prompt"],
      ["agent", "read"],
      ["agent", "get"],
      ["pane", "list"],
      ["tab", "close"],
    ]);
    assertEquals(fake.calls[2]?.args.includes("caller-1"), true);
    assertEquals(fake.calls[3]?.args.includes("--kind"), true);
    assertEquals(fake.calls[3]?.args.includes("codex"), true);
  },
);

Deno.test("HERDR_ENV=1이면 지정된 호환 CLI로 현재 pane을 조회하고 실패를 직접 실행으로 대체하지 않는다", async () => {
  await using dir = await tempDir();
  const fake = fakeExec([{
    cmd: "/matching/herdr",
    code: 1,
    stderr:
      '{"error":{"code":"connection_failed","message":"Herdr unavailable"}}',
  }]);
  const setup = testDeps(dir.path, "현재 변경을 검토하세요.", {
    env: { HERDR_BIN_PATH: "/matching/herdr", HERDR_ENV: "1" },
  });

  const result = await runDelegate(["run"], {
    ...setup.deps,
    exec: fake.exec,
  });

  assertEquals(result.code, 3);
  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0]?.cmd, "/matching/herdr");
  assertStringIncludes(result.stdout, "code: transport_unavailable");
  assertEquals(result.stdout.includes("transport: direct"), false);

  const outside = fakeExec([]);
  const outsideSetup = testDeps(dir.path, "검토하세요.");
  const explicit = await runDelegate(["run", "--transport", "herdr"], {
    ...outsideSetup.deps,
    exec: outside.exec,
  });
  assertEquals(explicit.code, 3);
  assertEquals(outside.calls, []);
  assertStringIncludes(explicit.stdout, "code: transport_unavailable");

  const explicitDryRun = await runDelegate([
    "run",
    "--transport",
    "herdr",
    "--dry-run",
  ], {
    ...outsideSetup.deps,
    exec: outside.exec,
  });
  assertEquals(explicitDryRun.code, 3);
  assertEquals(outside.calls, []);
  assertStringIncludes(explicitDryRun.stdout, "code: transport_unavailable");
});

Deno.test("Herdr 현재 pane 응답이 불완전하면 starting 기록을 남기지 않고 실패로 정착한다", async () => {
  await using dir = await tempDir();
  const fake = fakeExec([{
    cmd: "herdr",
    stdout: '{"result":{"pane":{"workspace_id":"ws-1"}}}',
  }]);
  const setup = testDeps(dir.path, "검토하세요.", {
    env: { HERDR_ENV: "1" },
  });

  const result = await runDelegate(["run"], {
    ...setup.deps,
    exec: fake.exec,
  });

  const runId = runIdFrom(result.stdout);
  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "status: failed");
  assertStringIncludes(result.stdout, "finished_at:");
  assertEquals(result.stdout.includes("code: usage"), false);
  assertEquals((await readRun(dir.path, runId)).status, "failed");
});

Deno.test("위임 탭에 아직 일하는 다른 실행이 있으면 탭을 닫지 않는다", async () => {
  await using dir = await tempDir();
  await writeRun(dir.path, {
    runId: "run_00000000-0000-4000-8000-000000000001",
    agent: "codex",
    transport: "herdr",
    permission: "read-only",
    cwd: "/workspace",
    callerId: "caller-1",
    reason: ["existing"],
    herdr: {
      workspaceId: "ws-1",
      tabId: "tab-delegate",
      paneId: "pane-other",
      agentName: "dlg-other",
      createdTab: true,
    },
    status: "working",
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
  });
  const fake = fakeExec([
    {
      cmd: "herdr",
      stdout:
        '{"result":{"pane":{"workspace_id":"ws-1","tab_id":"tab-current","agent_session":{"value":"caller-1"}}}}',
    },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"tabs":[{"tab_id":"tab-delegate","label":"caller-1"}]}}',
    },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"panes":[{"pane_id":"pane-other","tab_id":"tab-delegate","agent":"dlg-other","agent_status":"working"}]}}',
    },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"pane":{"pane_id":"pane-new","tab_id":"tab-delegate"}}}',
    },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"idle"}}}' },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"done"}}}' },
    { cmd: "herdr", stdout: "완료" },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"agent":{"agent_status":"done","agent_session":{"value":"thread-2"}}}}',
    },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"panes":[{"pane_id":"pane-free","tab_id":"tab-delegate","agent_status":"done"}]}}',
    },
    { cmd: "herdr", stdout: '{"result":{}}' },
  ]);
  const setup = testDeps(dir.path, "검토하세요.", { env: { HERDR_ENV: "1" } });

  const result = await runDelegate(["run"], { ...setup.deps, exec: fake.exec });

  assertEquals(result.code, 0);
  assertEquals(
    fake.calls.some((call) =>
      call.args[0] === "tab" && call.args[1] === "close"
    ),
    false,
  );
  assertEquals(
    fake.calls.find((call) => call.args[1] === "split")?.args,
    [
      "pane",
      "split",
      "--pane",
      "pane-other",
      "--direction",
      "right",
      "--cwd",
      "/workspace",
      "--no-focus",
    ],
  );
});

Deno.test(
  "Herdr 안에서 detach로 위임하면 에이전트가 일하기 시작한 뒤 working 문서를 받고, wait는 아직 일하는 중이면 끝날 때까지 기다렸다가 done 문서를 준다",
  async () => {
    await using dir = await tempDir();
    const fake = fakeExec([
      {
        cmd: "herdr",
        stdout:
          '{"result":{"pane":{"workspace_id":"ws-1","tab_id":"tab-current","agent_session":{"value":"caller-1"}}}}',
      },
      { cmd: "herdr", stdout: '{"result":{"tabs":[]}}' },
      {
        cmd: "herdr",
        stdout:
          '{"result":{"tab":{"tab_id":"tab-delegate"},"root_pane":{"pane_id":"pane-delegate"}}}',
      },
      { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"idle"}}}' },
      {
        cmd: "herdr",
        stdout: '{"result":{"agent":{"agent_status":"working"}}}',
      },
      {
        cmd: "herdr",
        stdout: '{"result":{"agent":{"agent_status":"working"}}}',
      },
      { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"done"}}}' },
      { cmd: "herdr", stdout: "비동기 결과" },
      {
        cmd: "herdr",
        stdout:
          '{"result":{"agent":{"agent_status":"done","agent_session":{"value":"thread-detached"}}}}',
      },
    ]);
    const startSetup = testDeps(dir.path, "오래 걸리는 검토를 수행하세요.", {
      env: { HERDR_ENV: "1" },
    });

    const started = await runDelegate(["run", "--detach", "--keep"], {
      ...startSetup.deps,
      exec: fake.exec,
    });
    const runId = runIdFrom(started.stdout);

    assertEquals(started.code, 0);
    assertStringIncludes(started.stdout, "status: working");
    const promptCall = fake.calls.find((call) => call.args[1] === "prompt");
    assertEquals(promptCall?.args.includes("--until"), true);
    assertEquals(promptCall?.args.includes("working"), true);
    assertEquals(promptCall?.args.includes("5000"), true);

    const waited = await runDelegate(["wait", runId], {
      ...testDeps(dir.path, "").deps,
      env: { HERDR_ENV: "1" },
      exec: fake.exec,
    });

    assertEquals(waited.code, 0);
    assertStringIncludes(waited.stdout, "status: done");
    assertStringIncludes(waited.stdout, "session_id: thread-detached");
    assertStringIncludes(waited.stdout, "비동기 결과");
    assertEquals(
      fake.calls.some((call) =>
        call.args[0] === "agent" && call.args[1] === "wait"
      ),
      true,
    );
    assertEquals(
      fake.calls.some((call) =>
        call.args[0] === "tab" && call.args[1] === "close"
      ),
      false,
    );
  },
);

Deno.test("직접 실행이 제한 시간을 넘기면 에이전트를 멈추고 timed_out 문서와 종료 코드 6을 받으며 세션 ID가 있으면 재개 안내가 담긴다", async () => {
  await using dir = await tempDir();
  const fake = fakeExec([{
    cmd: "codex",
    waitForAbort: true,
    stdout: '{"type":"thread.started","thread_id":"thread-timeout"}\n',
  }]);
  const setup = testDeps(dir.path, "오래 걸리는 작업을 수행하세요.");

  const result = await runDelegate(["run", "--timeout", "1ms"], {
    ...setup.deps,
    exec: fake.exec,
  });

  const runId = runIdFrom(result.stdout);
  assertEquals(result.code, 6);
  assertStringIncludes(result.stdout, "status: timed_out");
  assertStringIncludes(result.stdout, "session_id: thread-timeout");
  assertStringIncludes(result.stdout, `delegate resume ${runId}`);

  const closed = await runDelegate(["close", runId], {
    ...setup.deps,
    exec: fake.exec,
  });
  assertEquals(closed.code, 0);
  assertStringIncludes(closed.stdout, "status: timed_out");
});

Deno.test("Herdr 위임이 제한 시간을 넘기면 pane을 유지한 채 timed_out으로 끝나고 status는 에이전트의 현재 상태를 다시 조회한다", async () => {
  await using dir = await tempDir();
  const fake = fakeExec([
    {
      cmd: "herdr",
      stdout:
        '{"result":{"pane":{"workspace_id":"ws-1","tab_id":"tab-current","agent_session":{"value":"caller-1"}}}}',
    },
    { cmd: "herdr", stdout: '{"result":{"tabs":[]}}' },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"tab":{"tab_id":"tab-delegate"},"root_pane":{"pane_id":"pane-delegate"}}}',
    },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"idle"}}}' },
    {
      cmd: "herdr",
      code: 1,
      stderr:
        '{"error":{"code":"agent_prompt_stalled","message":"prompt stalled"}}',
    },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"agent":{"agent_status":"done","agent_session":{"value":"thread-late"}}}}',
    },
    { cmd: "herdr", stdout: "늦게 완료된 결과" },
  ]);
  const setup = testDeps(dir.path, "오래 걸리는 검토를 수행하세요.", {
    env: { HERDR_ENV: "1" },
  });

  const timedOut = await runDelegate(["run", "--timeout", "1ms"], {
    ...setup.deps,
    exec: fake.exec,
  });
  const runId = runIdFrom(timedOut.stdout);
  assertEquals(timedOut.code, 6);
  assertStringIncludes(timedOut.stdout, "status: timed_out");
  assertStringIncludes(timedOut.stdout, `delegate status ${runId}`);
  assertStringIncludes(timedOut.stdout, `delegate wait ${runId}`);
  assertEquals(
    fake.calls.some((call) =>
      call.args[0] === "tab" && call.args[1] === "close"
    ),
    false,
  );

  const status = await runDelegate(["status", runId], {
    ...testDeps(dir.path, "").deps,
    env: { HERDR_ENV: "1" },
    exec: fake.exec,
  });
  assertEquals(status.code, 0);
  assertStringIncludes(status.stdout, "status: done");
  assertStringIncludes(status.stdout, "session_id: thread-late");
  assertStringIncludes(status.stdout, "늦게 완료된 결과");
});

Deno.test("위임한 에이전트가 사라졌으면 status가 실패로 갱신된다", async () => {
  await using dir = await tempDir();
  const runId = "run_00000000-0000-4000-8000-000000000002";
  await writeRun(dir.path, {
    runId,
    agent: "codex",
    transport: "herdr",
    permission: "read-only",
    cwd: "/workspace",
    reason: ["detached"],
    herdr: {
      workspaceId: "ws-1",
      tabId: "tab-delegate",
      paneId: "pane-lost",
      agentName: "dlg-lost",
      createdTab: true,
    },
    status: "working",
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
  });
  const fake = fakeExec([{
    cmd: "herdr",
    code: 1,
    stderr: '{"error":{"code":"agent_not_found","message":"missing"}}',
  }]);

  const result = await runDelegate(["status", runId], {
    ...testDeps(dir.path, "").deps,
    env: { HERDR_ENV: "1" },
    exec: fake.exec,
  });

  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "status: failed");
  assertStringIncludes(result.stdout, "code: agent_lost");
});

Deno.test("Herdr 상태 조회가 일시적으로 실패해도 기존 timed_out 상태를 유지하고 다음 wait에서 완료를 회수한다", async () => {
  await using dir = await tempDir();
  const runId = "run_00000000-0000-4000-8000-000000000016";
  await writeRun(dir.path, {
    runId,
    agent: "codex",
    transport: "herdr",
    permission: "read-only",
    cwd: "/workspace",
    keep: true,
    reason: ["timed-out"],
    herdr: {
      workspaceId: "ws-1",
      tabId: "tab-retry",
      paneId: "pane-retry",
      agentName: "dlg-retry",
      createdTab: true,
    },
    status: "timed_out",
    error: { code: "timeout", message: "이전 제한 시간 초과" },
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
  });
  const fake = fakeExec([
    {
      cmd: "herdr",
      code: 1,
      stderr:
        '{"error":{"code":"connection_failed","message":"temporary disconnect"}}',
    },
    { cmd: "herdr", code: 1, stderr: "temporary Herdr failure" },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"working"}}}' },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"agent":{"agent_status":"done","agent_session":{"value":"thread-recovered"}}}}',
    },
    { cmd: "herdr", stdout: "복구된 결과" },
  ]);
  const deps = {
    ...testDeps(dir.path, "").deps,
    env: { HERDR_ENV: "1" },
    exec: fake.exec,
  };

  const disconnected = await runDelegate(["status", runId], deps);
  assertEquals(disconnected.code, 5);
  assertStringIncludes(disconnected.stdout, "status: timed_out");
  assertStringIncludes(disconnected.stdout, "code: connection_failed");

  const unavailable = await runDelegate(["status", runId], deps);
  assertEquals(unavailable.code, 5);
  assertStringIncludes(unavailable.stdout, "status: timed_out");
  assertStringIncludes(unavailable.stdout, "code: herdr_failed");

  const recovered = await runDelegate(["wait", runId], deps);
  assertEquals(recovered.code, 0);
  assertStringIncludes(recovered.stdout, "status: done");
  assertStringIncludes(recovered.stdout, "복구된 결과");
  assertEquals(fake.calls.length, 5);
});

Deno.test("Herdr가 unknown 상태를 반환해도 기존 working 상태를 유지하고 다음 close에서 다시 조회한다", async () => {
  await using dir = await tempDir();
  const runId = "run_00000000-0000-4000-8000-000000000017";
  await writeRun(dir.path, {
    runId,
    agent: "codex",
    transport: "herdr",
    permission: "read-only",
    cwd: "/workspace",
    reason: ["working"],
    herdr: {
      workspaceId: "ws-1",
      tabId: "tab-unknown",
      paneId: "pane-unknown",
      agentName: "dlg-unknown",
      createdTab: true,
    },
    status: "working",
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
  });
  const fake = fakeExec([
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"unknown"}}}' },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"working"}}}' },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"panes":[{"pane_id":"pane-unknown","tab_id":"tab-unknown","agent_status":"working"}]}}',
    },
    { cmd: "herdr", stdout: '{"result":{}}' },
  ]);
  const deps = {
    ...testDeps(dir.path, "").deps,
    env: { HERDR_ENV: "1" },
    exec: fake.exec,
  };

  const unknown = await runDelegate(["status", runId], deps);
  assertEquals(unknown.code, 5);
  assertStringIncludes(unknown.stdout, "status: working");
  assertStringIncludes(unknown.stdout, "code: agent_unknown");

  const closed = await runDelegate(["close", runId], deps);
  assertEquals(closed.code, 0);
  assertStringIncludes(closed.stdout, "status: cancelled");
  assertEquals(fake.calls.at(-1)?.args, ["tab", "close", "tab-unknown"]);
});

Deno.test("직접 실행 중 Ctrl-C를 누르면 에이전트를 멈추고 cancelled 문서로 끝난다", async () => {
  await using dir = await tempDir();
  const controller = new AbortController();
  const fake = fakeExec([{
    cmd: "codex",
    waitForAbort: true,
    stdout: '{"type":"thread.started","thread_id":"thread-cancelled"}\n',
    onStart: () => controller.abort(),
  }]);
  const setup = testDeps(dir.path, "작업을 수행하세요.");

  const result = await runDelegate(["run"], {
    ...setup.deps,
    signal: controller.signal,
    exec: fake.exec,
  });

  assertEquals(result.code, 130);
  assertStringIncludes(result.stdout, "status: cancelled");
  assertStringIncludes(result.stdout, "session_id: thread-cancelled");
  assertStringIncludes(result.stdout, "delegate resume");
});

Deno.test("Herdr 위임 중 Ctrl-C를 누르면 에이전트는 계속 일하고 working 문서와 wait 안내를 받는다", async () => {
  await using dir = await tempDir();
  const controller = new AbortController();
  const fake = fakeExec([
    {
      cmd: "herdr",
      stdout:
        '{"result":{"pane":{"workspace_id":"ws-1","tab_id":"tab-current","agent_session":{"value":"caller-1"}}}}',
    },
    { cmd: "herdr", stdout: '{"result":{"tabs":[]}}' },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"tab":{"tab_id":"tab-delegate"},"root_pane":{"pane_id":"pane-delegate"}}}',
    },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"idle"}}}' },
    { cmd: "herdr", waitForAbort: true, onStart: () => controller.abort() },
  ]);
  const setup = testDeps(dir.path, "계속 수행할 검토입니다.", {
    env: { HERDR_ENV: "1" },
  });

  const result = await runDelegate(["run"], {
    ...setup.deps,
    signal: controller.signal,
    exec: fake.exec,
  });

  assertEquals(result.code, 130);
  assertStringIncludes(result.stdout, "status: working");
  assertStringIncludes(result.stdout, "delegate wait");
  assertEquals(
    fake.calls.some((call) =>
      call.args[0] === "tab" && call.args[1] === "close"
    ),
    false,
  );
});

Deno.test("read-only로 시작한 세션을 write로 재개하면 확인 플래그 없이는 실행하지 않는다", async () => {
  await using dir = await tempDir();
  const fake = fakeExec([
    {
      cmd: "codex",
      stdout: '{"type":"thread.started","thread_id":"thread-read"}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"읽기 완료"}}\n',
    },
    {
      cmd: "codex",
      stdout: '{"type":"thread.started","thread_id":"thread-read"}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"쓰기 완료"}}\n',
    },
  ]);
  const firstSetup = testDeps(dir.path, "원인을 조사하세요.");
  const first = await runDelegate(["run"], {
    ...firstSetup.deps,
    exec: fake.exec,
  });
  const runId = runIdFrom(first.stdout);

  const blockedSetup = testDeps(dir.path, "수정하세요.");
  const blocked = await runDelegate([
    "resume",
    runId,
    "--permission",
    "write",
  ], { ...blockedSetup.deps, exec: fake.exec });

  assertEquals(blocked.code, 4);
  assertEquals(fake.calls.length, 1);
  assertStringIncludes(blocked.stdout, "status: blocked");
  assertStringIncludes(blocked.stdout, "--confirm-escalation");

  const confirmed = await runDelegate([
    "resume",
    runId,
    "--permission",
    "write",
    "--confirm-escalation",
  ], { ...blockedSetup.deps, exec: fake.exec });
  assertEquals(confirmed.code, 0);
  assertStringIncludes(confirmed.stdout, "permission: write");
  assertEquals(fake.calls[1]?.args.includes("--approve-for-me"), true);
});

Deno.test("살아 있는 Herdr 실행을 재개하면 새 에이전트 없이 같은 이름에 후속 지시를 보낸다", async () => {
  await using dir = await tempDir();
  const fake = fakeExec([
    {
      cmd: "herdr",
      stdout:
        '{"result":{"pane":{"workspace_id":"ws-1","tab_id":"tab-current","agent_session":{"value":"caller-1"}}}}',
    },
    { cmd: "herdr", stdout: '{"result":{"tabs":[]}}' },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"tab":{"tab_id":"tab-delegate"},"root_pane":{"pane_id":"pane-live"}}}',
    },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"idle"}}}' },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"working"}}}' },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"idle"}}}' },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"done"}}}' },
    { cmd: "herdr", stdout: "재개 결과" },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"agent":{"agent_status":"done","agent_session":{"value":"thread-live"}}}}',
    },
  ]);
  const startSetup = testDeps(dir.path, "오래 걸리는 검토를 수행하세요.", {
    env: { HERDR_ENV: "1" },
  });
  const started = await runDelegate(["run", "--detach"], {
    ...startSetup.deps,
    exec: fake.exec,
  });
  const parentId = runIdFrom(started.stdout);
  const parent = await readRun(dir.path, parentId);

  assertEquals(started.code, 0);
  assertEquals(parent.nativeSessionId, undefined);

  const setup = testDeps(dir.path, "후속 검토를 수행하세요.", {
    env: { HERDR_ENV: "1" },
  });

  const result = await runDelegate(["resume", parentId], {
    ...setup.deps,
    exec: fake.exec,
  });

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "재개 결과");
  assertEquals(
    fake.calls.filter((call) =>
      call.args[0] === "agent" && call.args[1] === "start"
    ).length,
    1,
  );
  assertEquals(fake.calls[6]?.args.slice(0, 3), [
    "agent",
    "prompt",
    fake.calls[3]?.args[2],
  ]);
});

Deno.test("Herdr가 새 위임과 살아 있는 재개를 agent_blocked로 거부하면 pane을 유지한 blocked 문서를 준다", async () => {
  await using dir = await tempDir();
  const blockedError = {
    cmd: "herdr",
    code: 1,
    stderr: '{"error":{"code":"agent_blocked","message":"approval required"}}',
  } as const;
  const fake = fakeExec([
    {
      cmd: "herdr",
      stdout:
        '{"result":{"pane":{"workspace_id":"ws-1","tab_id":"tab-current","agent_session":{"value":"caller-1"}}}}',
    },
    { cmd: "herdr", stdout: '{"result":{"tabs":[]}}' },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"tab":{"tab_id":"tab-blocked"},"root_pane":{"pane_id":"pane-blocked"}}}',
    },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"idle"}}}' },
    blockedError,
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"blocked"}}}' },
    blockedError,
  ]);
  const startSetup = testDeps(dir.path, "승인이 필요한 검토입니다.", {
    env: { HERDR_ENV: "1" },
  });

  const started = await runDelegate(["run"], {
    ...startSetup.deps,
    exec: fake.exec,
  });
  const runId = runIdFrom(started.stdout);

  assertEquals(started.code, 4);
  assertStringIncludes(started.stdout, "status: blocked");
  assertStringIncludes(started.stdout, "code: agent_blocked");
  assertStringIncludes(started.stdout, "pane_id: pane-blocked");
  assertStringIncludes(started.stdout, `delegate status ${runId}`);
  assertStringIncludes(started.stdout, `delegate resume ${runId}`);

  const resumeSetup = testDeps(dir.path, "승인 뒤 계속하세요.", {
    env: { HERDR_ENV: "1" },
  });
  const resumed = await runDelegate(["resume", runId], {
    ...resumeSetup.deps,
    exec: fake.exec,
  });

  assertEquals(resumed.code, 4);
  assertStringIncludes(resumed.stdout, "status: blocked");
  assertStringIncludes(resumed.stdout, "code: agent_blocked");
  assertEquals(
    fake.calls.some((call) =>
      call.args[0] === "tab" && call.args[1] === "close"
    ),
    false,
  );
});

Deno.test("세션 ID 없는 Herdr 실행의 에이전트가 사라졌으면 대체 시작 전에 재개 불가를 알린다", async () => {
  await using dir = await tempDir();
  const runId = "run_00000000-0000-4000-8000-000000000011";
  await writeRun(dir.path, {
    runId,
    agent: "codex",
    transport: "herdr",
    permission: "read-only",
    cwd: "/workspace",
    reason: ["detached"],
    herdr: {
      workspaceId: "ws-1",
      tabId: "tab-missing",
      paneId: "pane-missing",
      agentName: "dlg-missing",
      createdTab: true,
    },
    status: "working",
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
  });
  const fake = fakeExec([{
    cmd: "herdr",
    code: 1,
    stderr: '{"error":{"code":"agent_not_found","message":"missing"}}',
  }]);
  const setup = testDeps(dir.path, "후속 작업입니다.", {
    env: { HERDR_ENV: "1" },
  });

  const result = await runDelegate(["resume", runId], {
    ...setup.deps,
    exec: fake.exec,
  });

  assertEquals(result.code, 2);
  assertStringIncludes(result.stdout, "재개할 세션 ID 없음");
  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0]?.args.slice(0, 2), ["agent", "get"]);
});

Deno.test("세션 ID가 있는 Herdr 실행의 에이전트가 사라졌으면 새 pane에서 네이티브 세션을 재개한다", async () => {
  await using dir = await tempDir();
  const runId = "run_00000000-0000-4000-8000-000000000015";
  await writeRun(dir.path, {
    runId,
    agent: "codex",
    transport: "herdr",
    permission: "read-only",
    cwd: "/workspace",
    callerId: "caller-1",
    reason: ["detached"],
    nativeSessionId: "thread-restart",
    herdr: {
      workspaceId: "ws-old",
      tabId: "tab-old",
      paneId: "pane-old",
      agentName: "dlg-old",
      createdTab: true,
    },
    status: "working",
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
  });
  const fake = fakeExec([
    {
      cmd: "herdr",
      code: 1,
      stderr: '{"error":{"code":"agent_not_found","message":"missing"}}',
    },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"pane":{"workspace_id":"ws-new","tab_id":"tab-current","agent_session":{"value":"caller-1"}}}}',
    },
    { cmd: "herdr", stdout: '{"result":{"tabs":[]}}' },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"tab":{"tab_id":"tab-new"},"root_pane":{"pane_id":"pane-new"}}}',
    },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"idle"}}}' },
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"done"}}}' },
    { cmd: "herdr", stdout: "다시 시작한 결과" },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"agent":{"agent_status":"done","agent_session":{"value":"thread-restart"}}}}',
    },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"panes":[{"pane_id":"pane-new","tab_id":"tab-new","agent_status":"done"}]}}',
    },
    { cmd: "herdr", stdout: '{"result":{}}' },
  ]);
  const setup = testDeps(dir.path, "이어서 수행하세요.", {
    env: { HERDR_ENV: "1" },
  });

  const result = await runDelegate(["resume", runId], {
    ...setup.deps,
    exec: fake.exec,
  });

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "다시 시작한 결과");
  const start = fake.calls.find((call) => call.args[1] === "start");
  assertEquals(start?.args.includes("resume"), true);
  assertEquals(start?.args.includes("thread-restart"), true);
});

Deno.test("working Herdr 실행을 close하면 해당 탭을 닫고 cancelled 기록을 남긴다", async () => {
  await using dir = await tempDir();
  const runId = "run_00000000-0000-4000-8000-000000000004";
  await writeRun(dir.path, {
    runId,
    agent: "codex",
    transport: "herdr",
    permission: "read-only",
    cwd: "/workspace",
    reason: ["detached"],
    herdr: {
      workspaceId: "ws-1",
      tabId: "tab-close",
      paneId: "pane-close",
      agentName: "dlg-close",
      createdTab: true,
    },
    status: "working",
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
  });
  const fake = fakeExec([
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"working"}}}' },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"panes":[{"pane_id":"pane-close","tab_id":"tab-close","agent_status":"working"}]}}',
    },
    { cmd: "herdr", stdout: '{"result":{}}' },
  ]);

  const result = await runDelegate(["close", runId], {
    ...testDeps(dir.path, "").deps,
    env: { HERDR_ENV: "1" },
    exec: fake.exec,
  });

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "status: cancelled");
  assertEquals(fake.calls.at(-1)?.args, ["tab", "close", "tab-close"]);
});

Deno.test("working Herdr 실행의 탭을 닫지 못하면 작업 중 상태와 재시도 가능한 정리 오류를 유지한다", async () => {
  await using dir = await tempDir();
  const runId = "run_00000000-0000-4000-8000-000000000012";
  await writeRun(dir.path, {
    runId,
    agent: "codex",
    transport: "herdr",
    permission: "read-only",
    cwd: "/workspace",
    reason: ["detached"],
    herdr: {
      workspaceId: "ws-1",
      tabId: "tab-close-failed",
      paneId: "pane-close-failed",
      agentName: "dlg-close-failed",
      createdTab: true,
    },
    status: "working",
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
  });
  const fake = fakeExec([
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"working"}}}' },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"panes":[{"pane_id":"pane-close-failed","tab_id":"tab-close-failed","agent_status":"working"}]}}',
    },
    {
      cmd: "herdr",
      code: 1,
      stderr: '{"error":{"code":"close_failed","message":"tab stayed open"}}',
    },
  ]);

  const result = await runDelegate(["close", runId], {
    ...testDeps(dir.path, "").deps,
    env: { HERDR_ENV: "1" },
    exec: fake.exec,
  });

  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "status: working");
  assertStringIncludes(result.stdout, "code: tab_close_failed");
  assertStringIncludes(result.stdout, `delegate wait ${runId}`);
});

Deno.test("Herdr wait가 완료된 뒤 탭 정리에 실패해도 done 결과와 종료 코드 0을 유지한다", async () => {
  await using dir = await tempDir();
  const runId = "run_00000000-0000-4000-8000-000000000013";
  await writeRun(dir.path, {
    runId,
    agent: "codex",
    transport: "herdr",
    permission: "read-only",
    cwd: "/workspace",
    reason: ["detached"],
    herdr: {
      workspaceId: "ws-1",
      tabId: "tab-wait-cleanup",
      paneId: "pane-wait-cleanup",
      agentName: "dlg-wait-cleanup",
      createdTab: true,
    },
    status: "working",
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
  });
  const fake = fakeExec([
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"working"}}}' },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"agent":{"agent_status":"done","agent_session":{"value":"thread-wait-cleanup"}}}}',
    },
    { cmd: "herdr", stdout: "완료 결과" },
    {
      cmd: "herdr",
      stdout:
        '{"result":{"panes":[{"pane_id":"pane-wait-cleanup","tab_id":"tab-wait-cleanup","agent_status":"done"}]}}',
    },
    {
      cmd: "herdr",
      code: 1,
      stderr: '{"error":{"code":"close_failed","message":"tab stayed open"}}',
    },
  ]);

  const result = await runDelegate(["wait", runId], {
    ...testDeps(dir.path, "").deps,
    env: { HERDR_ENV: "1" },
    exec: fake.exec,
  });

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "status: done");
  assertStringIncludes(result.stdout, "code: tab_close_failed");
  assertStringIncludes(result.stdout, "완료 결과");
});

Deno.test("이미 정착된 Herdr 상태 조회는 기록 상태와 같은 종료 코드를 반환한다", async () => {
  await using dir = await tempDir();
  const runId = "run_00000000-0000-4000-8000-000000000014";
  await writeRun(dir.path, {
    runId,
    agent: "codex",
    transport: "herdr",
    permission: "read-only",
    cwd: "/workspace",
    reason: ["failed"],
    status: "failed",
    error: { code: "agent_failed", message: "failed earlier" },
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
    finishedAt: "2026-09-14T00:01:00.000Z",
  });
  const setup = testDeps(dir.path, "");

  const result = await runDelegate(["status", runId], setup.deps);

  assertEquals(result.code, 5);
  assertStringIncludes(result.stdout, "status: failed");
  assertEquals(setup.calls, []);
});

Deno.test("Herdr wait가 제한 시간을 넘기면 timed_out 문서와 종료 코드 6을 준다", async () => {
  await using dir = await tempDir();
  const runId = "run_00000000-0000-4000-8000-000000000005";
  await writeRun(dir.path, {
    runId,
    agent: "codex",
    transport: "herdr",
    permission: "read-only",
    cwd: "/workspace",
    reason: ["detached"],
    herdr: {
      workspaceId: "ws-1",
      tabId: "tab-wait",
      paneId: "pane-wait",
      agentName: "dlg-wait",
      createdTab: true,
    },
    status: "working",
    timeoutMs: 1_200_000,
    prompt: { bytes: 1, sha256: "hash" },
    startedAt: "2026-09-14T00:00:00.000Z",
  });
  const fake = fakeExec([
    { cmd: "herdr", stdout: '{"result":{"agent":{"agent_status":"working"}}}' },
    {
      cmd: "herdr",
      code: 1,
      stderr: '{"error":{"code":"timeout","message":"still working"}}',
    },
  ]);

  const result = await runDelegate(["wait", runId, "--timeout", "1ms"], {
    ...testDeps(dir.path, "").deps,
    env: { HERDR_ENV: "1" },
    exec: fake.exec,
  });

  assertEquals(result.code, 6);
  assertStringIncludes(result.stdout, "status: timed_out");
});
