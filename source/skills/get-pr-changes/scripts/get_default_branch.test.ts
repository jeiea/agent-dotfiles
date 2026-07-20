import { assertEquals } from "jsr:@std/assert@^1";
import { _internals, getGitRepoDefaultBranch } from "./get_default_branch.ts";

const { extractRemotesFromConfig, getBranchUpstream, extractDefaultBranch } = _internals;

Deno.test("extractRemotesFromConfig extracts single remote", () => {
  const config = `user.name=John Doe
remote.origin.url=https://github.com/example/repo.git
remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*`;

  const remotes = extractRemotesFromConfig(config);
  assertEquals(remotes, ["origin"]);
});

Deno.test("extractRemotesFromConfig extracts multiple remotes", () => {
  const config = `user.name=John Doe
remote.origin.url=https://github.com/example/repo.git
remote.upstream.url=https://github.com/upstream/repo.git
remote.fork.url=https://github.com/fork/repo.git`;

  const remotes = extractRemotesFromConfig(config);
  assertEquals(remotes, ["origin", "upstream", "fork"]);
});

Deno.test("extractRemotesFromConfig returns empty array when no remotes", () => {
  const config = `user.name=John Doe
user.email=john@example.com`;

  const remotes = extractRemotesFromConfig(config);
  assertEquals(remotes, []);
});

Deno.test("getBranchUpstream returns correct remote for branch", () => {
  const config = `branch.main.remote=origin
branch.main.merge=refs/heads/main
branch.develop.remote=upstream`;

  const remote = getBranchUpstream(config, "main");
  assertEquals(remote, "origin");
});

Deno.test("getBranchUpstream returns correct remote for another branch", () => {
  const config = `branch.main.remote=origin
branch.develop.remote=upstream
branch.feature.remote=fork`;

  const remote = getBranchUpstream(config, "develop");
  assertEquals(remote, "upstream");
});

Deno.test("getBranchUpstream returns undefined when branch has no remote", () => {
  const config = `branch.main.remote=origin
branch.main.merge=refs/heads/main`;

  const remote = getBranchUpstream(config, "feature");
  assertEquals(remote, undefined);
});

Deno.test("getBranchUpstream handles branch names with special characters", () => {
  const config = `branch.feature/test-123.remote=origin
branch.feature/test-123.merge=refs/heads/feature/test-123`;

  const remote = getBranchUpstream(config, "feature/test-123");
  assertEquals(remote, "origin");
});

Deno.test("extractDefaultBranch extracts main as default branch", () => {
  const stdout = `* remote origin
  Fetch URL: https://github.com/example/repo.git
  Push  URL: https://github.com/example/repo.git
  HEAD branch: main
  Remote branches:
    develop tracked
    main    tracked`;

  const branch = extractDefaultBranch(stdout);
  assertEquals(branch, "main");
});

Deno.test("extractDefaultBranch extracts master as default branch", () => {
  const stdout = `* remote origin
  Fetch URL: https://github.com/example/repo.git
  Push  URL: https://github.com/example/repo.git
  HEAD branch: master
  Remote branches:
    develop tracked
    master  tracked`;

  const branch = extractDefaultBranch(stdout);
  assertEquals(branch, "master");
});

Deno.test("extractDefaultBranch extracts custom branch name", () => {
  const stdout = `* remote origin
  Fetch URL: https://github.com/example/repo.git
  Push  URL: https://github.com/example/repo.git
  HEAD branch: production
  Remote branches:
    develop tracked
    production tracked`;

  const branch = extractDefaultBranch(stdout);
  assertEquals(branch, "production");
});

Deno.test("extractDefaultBranch returns undefined when no HEAD branch", () => {
  const stdout = `* remote origin
  Fetch URL: https://github.com/example/repo.git
  Push  URL: https://github.com/example/repo.git
  Remote branches:
    develop tracked
    main    tracked`;

  const branch = extractDefaultBranch(stdout);
  assertEquals(branch, undefined);
});

Deno.test("getGitRepoDefaultBranch returns result in real world", async () => {
  const result = await getGitRepoDefaultBranch(import.meta.dirname!);
  assertEquals(result, "refs/remotes/origin/main");
});
