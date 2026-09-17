import {
  delegatePromptPrefix,
  type NativeInvocation,
  type PlanRequest,
} from "./select.ts";

export type NativeRecord = {
  value: unknown;
  start: number;
  end: number;
};

export type ParsedTurn = {
  prompt: string;
  assistant?: string;
  completed: boolean;
  start: number;
  end: number;
};

export type ParsedSession = {
  sessionId?: string;
  cwd?: string;
  turns: ParsedTurn[];
};

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
    ...(request.effort == null
      ? []
      : ["-c", `model_reasoning_effort=${request.effort}`]),
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
    prompt: delegatePromptPrefix + request.prompt,
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

export function parseCodexSession(
  records: readonly NativeRecord[],
): ParsedSession {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let active: {
    id: string;
    context: boolean;
    prompt: string;
    assistant: string[];
    start: number;
  } | undefined;
  const turns: ParsedTurn[] = [];

  for (const record of records) {
    const event = asObject(record.value);
    const payload = asObject(event.payload);
    if (event.type === "session_meta") {
      sessionId = stringValue(payload.id);
      cwd = stringValue(payload.cwd);
      if (sessionId == null || cwd == null) {
        throw new Error("invalid codex session_meta");
      }
      continue;
    }
    if (event.type === "event_msg" && payload.type === "task_started") {
      const id = stringValue(payload.turn_id);
      if (id == null) throw new Error("invalid codex task_started");
      active = {
        id,
        context: false,
        prompt: "",
        assistant: [],
        start: record.start,
      };
      continue;
    }
    if (event.type === "turn_context") {
      if (stringValue(payload.turn_id) == null) {
        throw new Error("invalid codex turn_context");
      }
      if (active != null && payload.turn_id === active.id) {
        active.context = true;
      }
      continue;
    }
    if (
      event.type === "response_item" && active?.context === true &&
      payload.type === "message"
    ) {
      const text = messageText(payload.content);
      if (payload.role === "user") active.prompt = text;
      if (payload.role === "assistant" && text !== "") {
        active.assistant.push(text);
      }
      continue;
    }
    if (
      event.type === "event_msg" && active != null &&
      (payload.type === "task_complete" || payload.type === "turn_aborted") &&
      payload.turn_id === active.id
    ) {
      const completed = payload.type === "task_complete";
      turns.push({
        prompt: active.prompt,
        ...(completed && active.assistant.length > 0
          ? { assistant: active.assistant.at(-1) }
          : {}),
        completed,
        start: active.start,
        end: record.end,
      });
      active = undefined;
    }
  }
  if (active?.context === true) {
    turns.push({
      prompt: active.prompt,
      completed: false,
      start: active.start,
      end: records.at(-1)?.end ?? active.start,
    });
  }
  return { sessionId, cwd, turns };
}

function asObject(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => {
    const block = asObject(item);
    return ["input_text", "output_text", "text"].includes(String(block.type)) &&
        typeof block.text === "string"
      ? [block.text]
      : [];
  }).join("\n");
}
