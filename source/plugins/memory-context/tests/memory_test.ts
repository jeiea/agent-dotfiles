import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { fromFileUrl } from "jsr:@std/path@^1/from-file-url";
import { run as runMemory } from "../scripts/memory.ts";

const launcherPath = fromFileUrl(
  new URL("../bin/agent-memory", import.meta.url),
);

Deno.test("session memory is injected once and compact opens a new epoch", async () => {
  await using fixture = await setupIntegration();
  await fixture.addMemory(
    { id: "repository-policy", triggers: ["session"] },
    "Prefer source files.",
  );

  const startup = await fixture.hook({
    hook_event_name: "SessionStart",
    session_id: "session-1",
    source: "startup",
    cwd: fixture.repo,
  });
  assertStringIncludes(startup.context, "Prefer source files.");
  assertEquals(
    (await fixture.hook({
      hook_event_name: "SessionStart",
      session_id: "session-1",
      source: "resume",
      cwd: fixture.repo,
    })).context,
    "",
  );

  const compact = await fixture.hook({
    hook_event_name: "SessionStart",
    session_id: "session-1",
    source: "compact",
    cwd: fixture.repo,
  });
  assertStringIncludes(compact.context, "Prefer source files.");
});

Deno.test("executable launcher adapts official SessionStart stdin to additionalContext stdout", async () => {
  const hooks = JSON.parse(
    await Deno.readTextFile(new URL("../hooks/hooks.json", import.meta.url)),
  );
  assertStringIncludes(
    hooks.hooks.SessionStart[0].hooks[0].command,
    "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}",
  );
  for (const client of ["claude", "codex"] as const) {
    await using fixture = await setupIntegration({ client });
    await fixture.addMemory(
      { id: `${client}-launcher-smoke`, triggers: ["session"] },
      `${client} launcher assembled context.`,
    );
    const response = await invokeLauncher({
      cwd: fixture.repo,
      env: fixture.env,
      input: {
        hook_event_name: "SessionStart",
        session_id: `${client}-launcher-smoke-session`,
        source: "startup",
        cwd: fixture.repo,
      },
    });
    assertEquals(response.hookSpecificOutput.hookEventName, "SessionStart");
    assertStringIncludes(
      response.hookSpecificOutput.additionalContext,
      `${client} launcher assembled context.`,
    );
  }
});

Deno.test("successful read and write inject path memories on their first matching trigger", async () => {
  await using fixture = await setupIntegration();
  await fixture.addMemory({
    id: "read-policy",
    paths: ["src/**/*.ts"],
    triggers: ["read"],
  }, "Read policy");
  await fixture.addMemory({
    id: "write-policy",
    paths: ["src/**/*.ts"],
    triggers: ["write"],
  }, "Write policy");
  await fixture.addMemory({
    id: "first-match",
    paths: ["src/**/*.ts"],
    triggers: ["read", "write"],
  }, "First matching trigger only");

  const read = await fixture.hook({
    hook_event_name: "PostToolUse",
    session_id: "session-2",
    cwd: fixture.repo,
    tool_name: "Read",
    tool_input: { file_path: `${fixture.repo}/src/app/main.ts` },
    tool_response: { content: "export {};" },
  });
  assertStringIncludes(read.context, "Read policy");
  assertStringIncludes(read.context, "First matching trigger only");
  assertEquals(
    (await fixture.hook({
      hook_event_name: "PostToolUse",
      session_id: "session-2",
      cwd: fixture.repo,
      tool_name: "Read",
      tool_input: { file_path: `${fixture.repo}/src/app/main.ts` },
      tool_response: { content: "export {};" },
    })).context,
    "",
  );

  const write = await fixture.hook({
    hook_event_name: "PostToolUse",
    session_id: "session-2",
    cwd: fixture.repo,
    tool_name: "apply_patch",
    tool_input: {
      command:
        "*** Begin Patch\n*** Update File: src/app/main.ts\n@@\n-old\n+new\n*** End Patch",
    },
    tool_response: { exit_code: 0, output: "Done!" },
  });
  assertStringIncludes(write.context, "Write policy");
  assert(
    !write.context.includes("First matching trigger only"),
    "a read claim must prevent a repeated write injection in the same epoch",
  );
});

Deno.test("a failed Codex tool does not claim memory and the retry can inject it", async () => {
  await using fixture = await setupIntegration({ client: "codex" });
  await fixture.addMemory({
    id: "shell-read",
    paths: ["src/config.ts"],
    triggers: ["read"],
  }, "Configuration constraint");
  const input = {
    hook_event_name: "PostToolUse",
    session_id: "session-3",
    cwd: fixture.repo,
    tool_name: "Bash",
    tool_input: { command: "cat src/config.ts" },
  };

  assertEquals(
    (await fixture.hook({
      ...input,
      tool_response: { exit_code: 1, output: "No such file" },
    })).context,
    "",
  );
  assertStringIncludes(
    (await fixture.hook({
      ...input,
      tool_response: { exit_code: 0, output: "export {};" },
    })).context,
    "Configuration constraint",
  );
});

Deno.test("parallel hook processes claim the same memory exactly once", async () => {
  await using fixture = await setupIntegration();
  await fixture.addMemory(
    { id: "parallel", triggers: ["session"] },
    "Only once",
  );
  const input = {
    hook_event_name: "SessionStart",
    session_id: "session-parallel",
    source: "resume",
    cwd: fixture.repo,
  };

  const results = await Promise.all(
    Array.from({ length: 12 }, () => fixture.hook(input)),
  );
  assertEquals(
    results.filter((result) => result.context.includes("Only once")).length,
    1,
  );
});

Deno.test("priority and budget deterministically select fitting memories", async () => {
  await using fixture = await setupIntegration({ budget: "650" });
  await fixture.addMemory(
    { id: "low", priority: 1, triggers: ["session"] },
    "L".repeat(220),
  );
  await fixture.addMemory(
    { id: "high", priority: 100, triggers: ["session"] },
    "H".repeat(220),
  );

  const output = await fixture.hook({
    hook_event_name: "SessionStart",
    session_id: "session-budget",
    source: "startup",
    cwd: fixture.repo,
  });
  assertStringIncludes(output.context, "H".repeat(100));
  assert(
    !output.context.includes("L".repeat(100)),
    "lower-priority memory exceeded the budget",
  );
  assert(output.raw.length <= 850, "hook adapter output must remain bounded");
});

Deno.test("put, get, list, and reindex use the visible Markdown source immediately", async () => {
  await using fixture = await setupIntegration();
  const put = await fixture.run([
    "put",
    "new-memory",
    "--trigger",
    "session",
    "--path",
    "src/**",
  ], "Remember this immediately.");
  assertEquals(put.code, 0);
  assertEquals(
    (await fixture.run(
      ["put", "../escape", "--trigger", "session"],
      "unsafe",
    )).code,
    1,
  );
  const get = await fixture.run(["get", "new-memory"]);
  assertStringIncludes(get.stdout, "Remember this immediately.");
  const list = await fixture.run(["list"]);
  assertStringIncludes(list.stdout, '"id": "new-memory"');

  const manifestPath =
    `${fixture.amsd}/github.com-example-memory-repo/_agent-memory.json`;
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      scope: { repositories: ["origin:github.com/example/memory-repo"] },
      memories: [],
    }),
  );
  assertEquals((await fixture.run(["reindex"])).code, 0);
  assertStringIncludes(await Deno.readTextFile(manifestPath), '"new-memory"');
});

Deno.test("malformed, traversal, and escaping symlink entries fail open", async () => {
  await using fixture = await setupIntegration();
  const scope = `${fixture.amsd}/unsafe`;
  await Deno.mkdir(scope);
  const outside = `${fixture.root}/outside.md`;
  await Deno.writeTextFile(outside, "Do not inject");
  await Deno.symlink(outside, `${scope}/escape.md`);
  await Deno.writeTextFile(
    `${scope}/_agent-memory.json`,
    JSON.stringify({
      version: 1,
      scope: { repositories: ["origin:github.com/example/memory-repo"] },
      memories: [
        { id: "traversal", file: "../outside.md", triggers: ["session"] },
        { id: "symlink", file: "escape.md", triggers: ["session"] },
        { id: "malformed", file: 42, triggers: ["session"] },
      ],
    }),
  );

  const result = await fixture.hook({
    hook_event_name: "SessionStart",
    session_id: "session-unsafe",
    source: "startup",
    cwd: fixture.repo,
  });
  assertEquals(result.code, 0);
  assertEquals(result.context, "");
});

Deno.test("repository scope excludes a different origin and includes another clone", async () => {
  await using fixture = await setupIntegration();
  await fixture.addMemory(
    { id: "shared-clone", triggers: ["session"] },
    "Shared by origin",
  );
  const other = `${fixture.root}/other`;
  const clone = `${fixture.root}/clone`;
  await Deno.mkdir(other);
  await Deno.mkdir(clone);
  await git(other, "init");
  await git(
    other,
    "remote",
    "add",
    "origin",
    "git@github.com:example/unrelated.git",
  );
  await git(clone, "init");
  await git(
    clone,
    "remote",
    "add",
    "origin",
    "https://github.com/example/memory-repo.git",
  );

  assertEquals(
    (await fixture.hook({
      hook_event_name: "SessionStart",
      session_id: "unrelated",
      source: "startup",
      cwd: other,
    })).context,
    "",
  );
  assertStringIncludes(
    (await fixture.hook({
      hook_event_name: "SessionStart",
      session_id: "clone",
      source: "startup",
      cwd: clone,
    })).context,
    "Shared by origin",
  );
});

Deno.test("worktrees without an origin share the git-common-dir scope", async () => {
  await using fixture = await setupIntegration();
  await git(fixture.repo, "config", "user.email", "memory@example.test");
  await git(fixture.repo, "config", "user.name", "Memory Test");
  await git(fixture.repo, "add", ".");
  await git(fixture.repo, "commit", "-m", "fixture");
  await git(fixture.repo, "remote", "remove", "origin");
  const worktree = `${fixture.root}/worktree`;
  await git(
    fixture.repo,
    "worktree",
    "add",
    "-b",
    "memory-worktree",
    worktree,
  );
  assertEquals(
    (await fixture.run(
      ["put", "worktree-memory", "--trigger", "session"],
      "Shared across worktrees.",
    )).code,
    0,
  );

  assertStringIncludes(
    (await fixture.hook({
      hook_event_name: "SessionStart",
      session_id: "worktree-session",
      source: "startup",
      cwd: worktree,
    })).context,
    "Shared across worktrees.",
  );
});

Deno.test("global memories match every repository after repository-specific memories", async () => {
  await using fixture = await setupIntegration();
  await fixture.addMemory(
    { id: "repository-memory", triggers: ["session"] },
    "Repository specific",
  );
  const global = `${fixture.amsd}/global`;
  await Deno.mkdir(global);
  await Deno.writeTextFile(
    `${global}/global-memory.md`,
    markdown(
      { id: "global-memory", priority: 100, triggers: ["session"] },
      "Available everywhere",
    ),
  );
  await Deno.writeTextFile(
    `${global}/_agent-memory.json`,
    JSON.stringify({
      version: 1,
      scope: { repositories: ["*"] },
      memories: [{
        id: "global-memory",
        file: "global-memory.md",
        priority: 100,
        triggers: ["session"],
      }],
    }),
  );

  const output = await fixture.hook({
    hook_event_name: "SessionStart",
    session_id: "global-session",
    source: "startup",
    cwd: fixture.repo,
  });
  assertStringIncludes(output.context, "Available everywhere");
  assert(
    output.context.indexOf("Repository specific") <
      output.context.indexOf("Available everywhere"),
    "repository-specific memories must precede global memories",
  );

  assertEquals(
    (await fixture.run(
      ["put", "new-repository-memory", "--trigger", "session"],
      "Do not write this to global.",
    )).code,
    0,
  );
  assert(
    !(await Deno.readTextFile(`${global}/_agent-memory.json`)).includes(
      "new-repository-memory",
    ),
    "put must never select the global scope",
  );
});

Deno.test("concurrent puts preserve every manifest entry", async () => {
  await using fixture = await setupIntegration();
  const ids = Array.from({ length: 16 }, (_, index) => `concurrent-${index}`);
  const results = await Promise.all(
    ids.map((id) =>
      fixture.run(["put", id, "--trigger", "session"], `Body for ${id}`)
    ),
  );
  assert(
    results.every((result) => result.code === 0),
    `all puts must succeed: ${JSON.stringify(results)}`,
  );
  const list = await fixture.run(["list"]);
  for (const id of ids) assertStringIncludes(list.stdout, `"id": "${id}"`);
});

Deno.test("Claude and Codex receive the common official additionalContext adapter", async () => {
  for (const client of ["claude", "codex"] as const) {
    await using fixture = await setupIntegration({ client });
    await fixture.addMemory(
      { id: `${client}-adapter`, triggers: ["session"] },
      `${client} context`,
    );
    const result = await fixture.hook({
      hook_event_name: "SessionStart",
      session_id: `${client}-adapter-session`,
      source: "startup",
      cwd: fixture.repo,
    });
    const output = JSON.parse(result.raw);
    assertEquals(output.hookSpecificOutput.hookEventName, "SessionStart");
    assertStringIncludes(
      output.hookSpecificOutput.additionalContext,
      `${client} context`,
    );
  }
});

interface MemoryMetadata {
  id: string;
  paths?: string[];
  priority?: number;
  triggers: Array<"session" | "read" | "write">;
}

interface FixtureOptions {
  budget?: string;
  client?: "claude" | "codex";
}

interface HookResult {
  code: number;
  context: string;
  raw: string;
}

interface HookAdapterOutput {
  hookSpecificOutput: {
    additionalContext: string;
    hookEventName: string;
  };
}

interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

async function setupIntegration(options: FixtureOptions = {}) {
  const root = await Deno.makeTempDir({ prefix: "agent-memory-test-" });
  const repo = `${root}/repo`;
  const amsd = `${root}/memory`;
  const state = `${root}/state`;
  await Deno.mkdir(`${repo}/src/app`, { recursive: true });
  await Deno.mkdir(amsd);
  await git(repo, "init");
  await git(
    repo,
    "remote",
    "add",
    "origin",
    "git@github.com:example/memory-repo.git",
  );
  await Deno.writeTextFile(`${repo}/src/app/main.ts`, "export {};\n");
  await Deno.writeTextFile(`${repo}/src/config.ts`, "export {};\n");

  const env: Record<string, string> = {
    AGENT_MEMORY_SHARED_DIR: amsd,
    AGENT_MEMORY_STATE_DIR: state,
    AGENT_MEMORY_OUTPUT_BUDGET: options.budget ?? "6000",
  };
  if (options.client === "codex") env.PLUGIN_ROOT = `${root}/codex-plugin`;
  else if (options.client === "claude") {
    env.CLAUDE_PLUGIN_ROOT = `${root}/claude-plugin`;
  }

  return {
    root,
    repo,
    amsd,
    env,
    async addMemory(metadata: MemoryMetadata, body: string) {
      const scope = `${amsd}/github.com-example-memory-repo`;
      await Deno.mkdir(scope, { recursive: true });
      const file = `${metadata.id}.md`;
      await Deno.writeTextFile(`${scope}/${file}`, markdown(metadata, body));
      const manifestPath = `${scope}/_agent-memory.json`;
      let manifest: Record<string, unknown> = {
        version: 1,
        scope: { repositories: ["origin:github.com/example/memory-repo"] },
        memories: [],
      };
      try {
        manifest = JSON.parse(await Deno.readTextFile(manifestPath));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      const memories = manifest.memories as unknown[];
      memories.push({ ...metadata, file });
      await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
    },
    async hook(input: Record<string, unknown>): Promise<HookResult> {
      const result = await runScript(
        ["hook"],
        JSON.stringify(input),
        env,
        repo,
      );
      let context = "";
      if (result.stdout.trim()) {
        const parsed = JSON.parse(result.stdout);
        context = parsed.hookSpecificOutput?.additionalContext ?? "";
      }
      return { code: result.code, context, raw: result.stdout };
    },
    run(args: string[], stdin = "") {
      return runScript(args, stdin, env, repo);
    },
    async [Symbol.asyncDispose]() {
      await Deno.remove(root, { recursive: true });
    },
  };
}

function markdown(metadata: MemoryMetadata, body: string): string {
  return `---\n${JSON.stringify(metadata, null, 2)}\n---\n\n${body}\n`;
}

async function runScript(
  args: string[],
  stdin: string,
  env: Record<string, string>,
  cwd: string,
): Promise<CommandResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runMemory(args, {
    cwd,
    env,
    stdin,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

async function invokeLauncher(options: {
  cwd: string;
  env: Record<string, string>;
  input: Record<string, unknown>;
}): Promise<HookAdapterOutput> {
  const command = new Deno.Command(launcherPath, {
    args: ["hook"],
    clearEnv: true,
    cwd: options.cwd,
    env: { PATH: Deno.env.get("PATH") ?? "", ...options.env },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(options.input)));
  await writer.close();
  const output = await child.output();
  assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const output = await new Deno.Command("git", { args, cwd }).output();
  assertEquals(output.code, 0);
}
