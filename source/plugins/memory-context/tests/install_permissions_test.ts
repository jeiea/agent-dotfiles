import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "jsr:@std/assert@^1";

Deno.test("install task grants SOA only the native plugin client executables", async () => {
  const config = await readDenoConfig();
  const install = config.tasks?.install;
  assert(typeof install === "string", "deno.json install task is missing");
  assertStringIncludes(
    install,
    "--allow-run=claude,codex",
    "install task must let SOA reconcile native plugins through the Claude and Codex CLIs",
  );
  assertFalse(
    /--allow-run(?:\s|$)/.test(install),
    "install task must not grant unrestricted process execution",
  );
});

Deno.test("test task validates the repository permcheck source", async () => {
  const config = await readDenoConfig();
  assertEquals(
    config.tasks?.["test:permcheck"],
    "permcheck validate source/rules.toml",
    "test:permcheck must validate source/rules.toml instead of the installed default config",
  );
});

Deno.test("test task grants process access only to existing test tools and the launcher", async () => {
  const config = await readDenoConfig();
  const test = config.tasks?.["test:deno"];
  assert(typeof test === "string", "test:deno task is missing");
  const permission = test.match(/--allow-run=([^ ]+)/)?.[1];
  assertEquals(
    permission,
    "git,jj,source/plugins/memory-context/bin/agent-memory",
    "test:deno must grant process access only to git, jj, and the memory launcher",
  );
});

Deno.test("check and formatter include plugin TypeScript", async () => {
  const config = await readDenoConfig();
  const check = config.tasks?.check;
  assert(typeof check === "string", "check task is missing");
  assertStringIncludes(
    check,
    "source/plugins/**/*.ts",
    "check task must include plugin TypeScript",
  );
  assert(
    config.fmt?.include?.includes("source/plugins/**/*.ts"),
    "formatter config must include plugin TypeScript",
  );
});

interface DenoConfig {
  fmt?: { include?: string[] };
  tasks?: Record<string, unknown>;
}

async function readDenoConfig(): Promise<DenoConfig> {
  return JSON.parse(
    await Deno.readTextFile(
      new URL("../../../../deno.json", import.meta.url),
    ),
  );
}
