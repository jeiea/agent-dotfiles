import { assert } from "jsr:@std/assert@^1";
import { getCurrentBranch } from "./git_commands.ts";

Deno.test("getCurrentBranch", async () => {
  const branch = await getCurrentBranch(import.meta.dirname!);
  assert(!!branch);
});
