import {
  assert,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { getBranchChangesText } from "./get_branch_changes.ts";
import { runGitCommand } from "./git_commands.ts";
import { runJjCommand } from "./jj_commands.ts";

async function createTempRepo(prefix: string) {
  const path = await Deno.makeTempDir({ prefix });
  return {
    path,
    async [Symbol.asyncDispose]() {
      await Deno.remove(path, { recursive: true });
    },
  };
}

Deno.test("getBranchChangesText - diff --stat shows changed files", async () => {
  await using repo = await createTempRepo("get-pr-changes-test-");
  await using origin = await createTempRepo("get-pr-changes-origin-");

  const git = (cwd: string, ...args: string[]) => runGitCommand(args, cwd);

  await git(origin.path, "init", "--bare", "-b", "main");

  await git(repo.path, "init", "-b", "main");
  await git(repo.path, "config", "user.email", "t@t.com");
  await git(repo.path, "config", "user.name", "T");
  await git(repo.path, "remote", "add", "origin", origin.path);

  await Deno.writeTextFile(`${repo.path}/README.md`, "hello\n");
  await git(repo.path, "add", "README.md");
  await git(repo.path, "commit", "-m", "init");
  await git(repo.path, "push", "-u", "origin", "main");

  // main~1..main에 해당하는 변경: feature가 main에서 분기 후 foo.ts 추가
  await git(repo.path, "checkout", "-b", "feature");
  await Deno.writeTextFile(`${repo.path}/foo.ts`, "export const x = 1;\n");
  await git(repo.path, "add", "foo.ts");
  await git(repo.path, "commit", "-m", "add foo");

  const result = await getBranchChangesText(
    repo.path,
    "refs/remotes/origin/main",
  );

  assertStringIncludes(result, "foo.ts");
  assertStringIncludes(result, "insertion");
});

Deno.test("getBranchChangesText - jj repo shows changed files", async () => {
  await using repo = await createTempRepo("get-pr-changes-jj-test-");

  const jj = (...args: string[]) => runJjCommand(args, repo.path);

  await jj("git", "init");
  await jj("bookmark", "create", "main", "-r", "@");
  await Deno.writeTextFile(`${repo.path}/README.md`, "hello\n");
  await jj("commit", "-m", "init");
  await jj("new", "main", "-m", "feature");
  await Deno.writeTextFile(`${repo.path}/foo.ts`, "export const x = 1;\n");

  const result = await getBranchChangesText(repo.path, "main", { vcs: "jj" });

  assertStringIncludes(result, "feature");
  assertStringIncludes(result, "foo.ts");
  assertStringIncludes(result, "insertion");
});

Deno.test("getBranchChangesText - jj diff uses fork point when base advanced", async () => {
  await using repo = await createTempRepo("get-pr-changes-jj-advanced-base-");

  const git = (...args: string[]) => runGitCommand(args, repo.path);
  const jj = (...args: string[]) => runJjCommand(args, repo.path);

  await git("init", "-b", "main");
  await git("config", "user.email", "t@t.com");
  await git("config", "user.name", "T");
  await Deno.writeTextFile(`${repo.path}/README.md`, "hello\n");
  await git("add", "README.md");
  await git("commit", "-m", "init");

  await git("checkout", "-b", "feature");
  await Deno.writeTextFile(`${repo.path}/foo.ts`, "export const x = 1;\n");
  await git("add", "foo.ts");
  await git("commit", "-m", "add foo");

  await git("checkout", "main");
  await Deno.writeTextFile(`${repo.path}/main.ts`, "export const main = 1;\n");
  await git("add", "main.ts");
  await git("commit", "-m", "advance main");

  await jj("git", "init", "--git-repo", `${repo.path}/.git`);
  await jj("new", "feature");

  const result = await getBranchChangesText(repo.path, "main", { vcs: "jj" });

  assertStringIncludes(result, "foo.ts");
  assert(!result.includes("main.ts"));
});

Deno.test("getBranchChangesText - jj fails clearly when base is missing", async () => {
  await using repo = await createTempRepo("get-pr-changes-jj-missing-base-");

  const jj = (...args: string[]) => runJjCommand(args, repo.path);

  await jj("git", "init");

  await assertRejects(
    () => getBranchChangesText(repo.path, "missing", { vcs: "jj" }),
    Error,
    "jj base revision not found or ambiguous: missing",
  );
});
