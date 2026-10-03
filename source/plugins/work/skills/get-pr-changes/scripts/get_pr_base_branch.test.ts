import { assertEquals } from "jsr:@std/assert@^1";
import { _internals } from "./get_pr_base_branch.ts";

const { parsePrBaseBranch } = _internals;

Deno.test("parsePrBaseBranch - valid JSON with baseRefName", () => {
  assertEquals(parsePrBaseBranch('{"baseRefName":"main"}'), "main");
});

Deno.test("parsePrBaseBranch - develop branch", () => {
  assertEquals(parsePrBaseBranch('{"baseRefName":"develop"}'), "develop");
});

Deno.test("parsePrBaseBranch - empty baseRefName", () => {
  assertEquals(parsePrBaseBranch('{"baseRefName":""}'), null);
});

Deno.test("parsePrBaseBranch - missing baseRefName", () => {
  assertEquals(parsePrBaseBranch('{"other":"value"}'), null);
});

Deno.test("parsePrBaseBranch - invalid JSON", () => {
  assertEquals(parsePrBaseBranch("not json"), null);
});

Deno.test("parsePrBaseBranch - null baseRefName", () => {
  assertEquals(parsePrBaseBranch('{"baseRefName":null}'), null);
});

Deno.test("parsePrBaseBranch - numeric baseRefName", () => {
  assertEquals(parsePrBaseBranch('{"baseRefName":123}'), null);
});
