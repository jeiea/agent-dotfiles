import type { NativeInvocation, PlanRequest } from "./select.ts";

const promptPrefix = "claude와 codex 재호출 금지.\n\n";

export function planCodex(request: PlanRequest): NativeInvocation {
  const permission = request.permission === "read-only"
    ? ["-s", "read-only", "-a", "never"]
    : ["--approve-for-me"];
  const globals = [
    "--search",
    ...permission,
    "-C",
    request.cwd,
    ...request.addDirs.flatMap((dir) => ["--add-dir", dir]),
    ...(request.model == null ? [] : ["-m", request.model]),
    "-c",
    `model_reasoning_effort=${request.effort}`,
  ];
  const resume = request.resumeSessionId == null
    ? []
    : ["resume", request.resumeSessionId];

  return {
    agent: "codex",
    directArgs: [
      ...globals,
      "exec",
      "--json",
      "--skip-git-repo-check",
      ...resume,
      "-",
    ],
    herdrArgs: [...globals, ...resume],
    prompt: promptPrefix + request.prompt,
  };
}

export type ParsedAgentOutput = {
  sessionId?: string;
  result?: string;
  error?: string;
};

export function parseCodexEvents(text: string): ParsedAgentOutput {
  let sessionId: string | undefined;
  let result: string | undefined;
  let error: string | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started") sessionId = event.thread_id;
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message"
      ) result = event.item.text;
      if (event.type === "error") error = event.message ?? event.error?.message;
    } catch {
      error = "invalid_jsonl";
    }
  }
  return { sessionId, result, error };
}
