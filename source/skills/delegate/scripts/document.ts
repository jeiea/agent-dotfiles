import { stringify } from "jsr:@std/yaml@^1";

export type PublicActivity =
  | "working"
  | "blocked"
  | "quiescent"
  | "not_live"
  | "unknown";

export type NativeSessionId = string & {
  readonly __brand: "NativeSessionId";
};

export type PublicErrorCode =
  | "usage"
  | "invalid_session_id"
  | "live_option_conflict"
  | "permission_escalation"
  | "transport_unavailable"
  | "caller_session_unavailable"
  | "session_not_found"
  | "session_ambiguous"
  | "live_session_ambiguous"
  | "session_id_unavailable"
  | "session_id_changed"
  | "unsafe_native_path"
  | "invalid_native_session"
  | "agent_failed"
  | "herdr_failed"
  | "agent_blocked"
  | "unmanaged_tab"
  | "tab_close_blocked"
  | "cleanup_failed"
  | "timeout"
  | "cancelled";

export type CompletedTurn = {
  turn_id: string;
  completed_at?: string;
};

export type Blocker = {
  pane_id: string;
  agent_name: string | null;
  status: "working" | "blocked" | "unknown";
};

export type RetryRecord = {
  reason: {
    code: "herdr_failed";
    message: string;
  };
  result: "success" | "failed";
};

export type DelegateDocument = {
  session_id?: NativeSessionId;
  agent?: "codex" | "claude";
  activity?: PublicActivity;
  completed_turns?: CompletedTurn[];
  result?: string;
  error?: {
    code: PublicErrorCode;
    message: string;
    blockers?: Blocker[];
  };
  warnings?: Array<{
    code: "unmanaged_tab" | "tab_close_blocked" | "cleanup_failed";
    message: string;
    blockers?: Blocker[];
  }>;
  retry?: RetryRecord;
};

export class DelegateError extends Error {
  constructor(
    readonly code: PublicErrorCode,
    message: string,
    readonly blockers?: Blocker[],
    readonly sessionId?: string,
    readonly retry?: RetryRecord,
  ) {
    super(message);
  }
}

export function normalizeError(error: unknown): DelegateError {
  if (error instanceof DelegateError) return error;
  return new DelegateError(
    "agent_failed",
    error instanceof Error ? error.message : String(error),
  );
}

export function copyDelegateError(
  error: DelegateError,
  overrides: { sessionId?: string; retry?: RetryRecord },
): DelegateError {
  return new DelegateError(
    error.code,
    error.message,
    error.blockers,
    overrides.sessionId ?? error.sessionId,
    overrides.retry ?? error.retry,
  );
}

export function exitCode(code: PublicErrorCode): number {
  if (
    code === "usage" || code === "invalid_session_id" ||
    code === "live_option_conflict"
  ) return 2;
  if (
    code === "transport_unavailable" ||
    code === "caller_session_unavailable" || code === "session_not_found"
  ) return 3;
  if (
    code === "permission_escalation" || code === "agent_blocked" ||
    code === "unmanaged_tab" || code === "tab_close_blocked"
  ) return 4;
  if (code === "timeout") return 6;
  if (code === "cancelled") return 130;
  return 5;
}

export function renderDocument(document: DelegateDocument): string {
  return `---\n${stringify(document, { lineWidth: -1 })}---\n`;
}
