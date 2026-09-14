import type { NativeInvocation, PlanRequest } from "./select.ts";
import type { ParsedAgentOutput } from "./codex.ts";

const promptPrefix = "claude와 codex 재호출 금지.\n\n";

export function planClaude(request: PlanRequest): NativeInvocation {
  const name = [request.callerId, request.name].filter((part) => part != null)
    .join(" ");
  const permission = request.permission === "read-only"
    ? [
      "--restricted",
      "--permission-mode=dontAsk",
      "--permission-prompts=none",
      "--tools=Read,Glob,Grep,WebSearch,WebFetch",
      "--allowedTools=WebSearch,WebFetch(domain:*)",
      "--strict-mcp-config",
    ]
    : [
      "--permission-mode=auto",
      "--allowedTools=WebSearch,WebFetch(domain:*)",
      "--disallowedTools=Skill(codex-tools:codex),Skill(claude-tools:claude)",
    ];
  const shared = [
    ...(request.model == null ? [] : [`--model=${request.model}`]),
    `--effort=${request.effort}`,
    ...permission,
    ...request.addDirs.map((dir) => `--add-dir=${dir}`),
    ...(name === "" ? [] : [`--name=${name}`]),
    ...(request.resumeSessionId == null
      ? []
      : [`--resume=${request.resumeSessionId}`]),
  ];

  return {
    agent: "claude",
    directArgs: [
      "-p",
      "--verbose",
      "--output-format=stream-json",
      ...shared,
      "-",
    ],
    herdrArgs: shared,
    prompt: promptPrefix + request.prompt,
  };
}

export function parseClaudeEvents(text: string): ParsedAgentOutput {
  let sessionId: string | undefined;
  let result: string | undefined;
  let error: string | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "result") continue;
      sessionId = event.session_id;
      if (event.subtype === "success" && event.is_error === false) {
        result = event.result;
      } else {
        error = event.result ?? event.subtype ?? "claude_error";
      }
    } catch {
      error = "invalid_jsonl";
    }
  }
  return { sessionId, result, error };
}
