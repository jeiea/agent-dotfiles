import { basename, join, relative, SEPARATOR } from "jsr:@std/path@^1";
import { parseClaudeSession } from "./claude.ts";
import {
  type NativeRecord,
  parseCodexSession,
  type ParsedSession,
  type ParsedTurn,
} from "./codex.ts";
import { DelegateError, type NativeSessionId } from "./document.ts";
import { type Agent, stripDelegatePromptPrefix } from "./select.ts";

export const sessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NativeCursor = {
  path: string;
  identity: string;
  byteLength: number;
  lastRecord: string | null;
  partial: boolean;
};

export type SharedSession = {
  sessionId: NativeSessionId;
  agent: Agent;
  cwd: string;
  path: string;
  cursor: NativeCursor;
  turns: ParsedTurn[];
};

export type PromptOutcome = {
  result?: string;
  intervening_prompts?: string[];
};

export type PromptBoundary = {
  offset: number;
  prompt?: string;
};

export type NativeBaseline = Map<
  string,
  Pick<NativeCursor, "identity" | "byteLength">
>;

type Candidate = { agent: Agent; path: string; root: string };

export function assertSessionId(
  value: string,
): asserts value is NativeSessionId {
  if (!sessionIdPattern.test(value)) {
    throw new DelegateError(
      "invalid_session_id",
      `잘못된 native session ID: ${value}`,
    );
  }
}

export async function findNativeSession(
  sessionId: string,
  env: Record<string, string>,
): Promise<SharedSession> {
  assertSessionId(sessionId);
  const candidates = (await listCandidates(env)).filter((candidate) =>
    candidateId(candidate) === sessionId.toLowerCase()
  );
  if (candidates.length === 0) {
    throw new DelegateError(
      "session_not_found",
      `native session 없음: ${sessionId}`,
    );
  }
  if (candidates.length > 1) {
    throw new DelegateError(
      "session_ambiguous",
      `native session 후보 복수: ${sessionId}`,
    );
  }
  return await readSnapshot(candidates[0]!);
}

export async function captureBaseline(
  env: Record<string, string>,
  agent: Agent,
): Promise<NativeBaseline> {
  const baseline: NativeBaseline = new Map();
  for (const candidate of await listCandidates(env, agent)) {
    try {
      const cursor = await readCursor(candidate);
      baseline.set(cursor.path, {
        identity: cursor.identity,
        byteLength: cursor.byteLength,
      });
    } catch {
      // 신규 session baseline에서 무관한 손상 후보는 식별 대상이 아니다.
    }
  }
  return baseline;
}

export async function identifyPromptSession(
  env: Record<string, string>,
  agent: Agent,
  baseline: NativeBaseline,
  prompt: string,
  expectedSessionId?: string,
  reportedSessionId?: string,
): Promise<SharedSession | undefined> {
  const matches: SharedSession[] = [];
  for (const candidate of await listCandidates(env, agent)) {
    let cursor: NativeCursor;
    try {
      cursor = await readCursor(candidate);
    } catch (error) {
      if (isExpectedCandidate(candidate, expectedSessionId)) throw error;
      continue;
    }
    const before = baseline.get(cursor.path);
    const sameFile = before?.identity === cursor.identity;
    const offset = sameFile ? before?.byteLength ?? 0 : 0;
    if (sameFile && cursor.byteLength <= offset) continue;
    let snapshot: SharedSession;
    try {
      snapshot = await readSnapshot(candidate);
    } catch (error) {
      if (isExpectedCandidate(candidate, expectedSessionId)) throw error;
      continue;
    }
    if (
      snapshot.cursor.byteLength > offset &&
      snapshot.turns.some((turn) =>
        turn.start >= offset && turn.prompt === prompt
      )
    ) matches.push(snapshot);
  }
  if (expectedSessionId != null) {
    const changed = matches.find((match) =>
      match.sessionId.toLowerCase() !== expectedSessionId.toLowerCase()
    );
    if (changed != null) {
      throw new DelegateError(
        "session_id_changed",
        `resume session ID 변경: ${expectedSessionId} -> ${changed.sessionId}`,
      );
    }
  }
  if (reportedSessionId != null) {
    assertSessionId(reportedSessionId);
    if (
      expectedSessionId != null &&
      reportedSessionId.toLowerCase() !== expectedSessionId.toLowerCase()
    ) {
      throw new DelegateError(
        "session_id_changed",
        `resume session ID 변경: ${expectedSessionId} -> ${reportedSessionId}`,
      );
    }
    return matches.find((match) =>
      match.sessionId.toLowerCase() === reportedSessionId.toLowerCase()
    );
  }
  if (expectedSessionId != null) {
    return matches.find((match) =>
      match.sessionId.toLowerCase() === expectedSessionId.toLowerCase()
    );
  }
  if (matches.length > 1) {
    throw new DelegateError(
      "session_id_unavailable",
      "prompt와 일치하는 native session 후보가 복수입니다",
    );
  }
  return matches[0];
}

async function readCursor(candidate: Candidate): Promise<NativeCursor> {
  const root = await realPathOrSelf(candidate.root);
  const path = await realPathOrSelf(candidate.path);
  if (!inside(root, path)) {
    throw new DelegateError(
      "unsafe_native_path",
      `native session 경로가 신뢰 root 밖입니다: ${basename(candidate.path)}`,
    );
  }
  const info = await Deno.stat(path);
  let partial = false;
  if (info.size > 0) {
    using file = await Deno.open(path, { read: true });
    await file.seek(-1, Deno.SeekMode.End);
    const lastByte = new Uint8Array(1);
    await file.read(lastByte);
    partial = lastByte[0] !== 10;
  }
  return {
    path,
    identity: `${String(info.dev ?? "")}:${String(info.ino ?? path)}`,
    byteLength: info.size,
    lastRecord: null,
    partial,
  };
}

function isExpectedCandidate(
  candidate: Candidate,
  expectedSessionId: string | undefined,
): boolean {
  return expectedSessionId != null &&
    candidateId(candidate) === expectedSessionId.toLowerCase();
}

export async function refreshNativeSession(
  snapshot: SharedSession,
): Promise<SharedSession> {
  return await readSnapshot({
    agent: snapshot.agent,
    path: snapshot.path,
    root: rootForPath(snapshot.path, snapshot.agent),
  });
}

export function cursorEquals(
  left: NativeCursor,
  right: NativeCursor,
): boolean {
  return left.identity === right.identity &&
    left.byteLength === right.byteLength &&
    left.lastRecord === right.lastRecord && left.partial === right.partial;
}

export function outcomeAfter(
  snapshot: SharedSession,
  boundary: PromptBoundary,
): PromptOutcome {
  const turns = snapshot.turns.filter((turn) => turn.start >= boundary.offset);
  const resultIndex = turns.findLastIndex((turn) =>
    turn.completed && turn.assistant != null
  );
  if (resultIndex < 0) return {};
  const concluded = turns.slice(0, resultIndex + 1);
  const initialIndex = boundary.prompt == null
    ? -1
    : concluded.findIndex((turn) => turn.prompt === boundary.prompt);
  const interveningPrompts = concluded.slice(initialIndex + 1).map((turn) =>
    stripDelegatePromptPrefix(turn.prompt)
  );
  return {
    ...(interveningPrompts.length === 0
      ? {}
      : { intervening_prompts: interveningPrompts }),
    result: turns[resultIndex]!.assistant,
  };
}

export function latestHumanBoundary(snapshot: SharedSession): PromptBoundary {
  const turn = snapshot.turns.at(-1);
  return turn == null
    ? { offset: snapshot.cursor.byteLength }
    : { offset: turn.start, prompt: turn.prompt };
}

export function renderConversation(snapshot: SharedSession): string {
  return snapshot.turns.flatMap((turn) => [
    `## User\n\n${turn.prompt}`,
    ...(turn.completed && turn.assistant != null
      ? [`## Assistant\n\n${turn.assistant}`]
      : []),
  ]).join("\n\n");
}

async function readSnapshot(candidate: Candidate): Promise<SharedSession> {
  const root = await realPathOrSelf(candidate.root);
  const path = await realPathOrSelf(candidate.path);
  if (!inside(root, path)) {
    throw new DelegateError(
      "unsafe_native_path",
      `native session 경로가 신뢰 root 밖입니다: ${basename(candidate.path)}`,
    );
  }
  const data = await Deno.readFile(path);
  const { records, partial } = decodeRecords(data);
  let parsed: ParsedSession;
  try {
    parsed = candidate.agent === "codex"
      ? parseCodexSession(records)
      : parseClaudeSession(records);
  } catch {
    throw new DelegateError(
      "invalid_native_session",
      `지원하지 않는 native session schema: ${basename(candidate.path)}`,
    );
  }
  const fileId = candidateId(candidate);
  if (
    parsed.sessionId == null || parsed.cwd == null ||
    parsed.sessionId.toLowerCase() !== fileId
  ) {
    throw new DelegateError(
      "invalid_native_session",
      `native session metadata 불일치: ${basename(candidate.path)}`,
    );
  }
  assertSessionId(parsed.sessionId);
  const info = await Deno.stat(path);
  const identity = `${String(info.dev ?? "")}:${String(info.ino ?? path)}`;
  return {
    sessionId: parsed.sessionId,
    agent: candidate.agent,
    cwd: parsed.cwd,
    path,
    cursor: {
      path,
      identity,
      byteLength: data.byteLength,
      lastRecord: recordIdentity(records.at(-1)),
      partial,
    },
    turns: parsed.turns,
  };
}

function decodeRecords(data: Uint8Array): {
  records: NativeRecord[];
  partial: boolean;
} {
  const records: NativeRecord[] = [];
  let start = 0;
  for (let index = 0; index < data.length; index++) {
    if (data[index] !== 10) continue;
    const bytes = data.subarray(start, index);
    if (bytes.length > 0) {
      try {
        records.push({
          value: JSON.parse(new TextDecoder().decode(bytes)),
          start,
          end: index + 1,
        });
      } catch {
        throw new DelegateError(
          "invalid_native_session",
          "native session 중간 JSONL record가 잘못되었습니다",
        );
      }
    }
    start = index + 1;
  }
  return { records, partial: start < data.length };
}

function recordIdentity(record: NativeRecord | undefined): string | null {
  if (record == null) return null;
  const value = record.value as Record<string, unknown>;
  const payload = value.payload as Record<string, unknown> | undefined;
  return [
    value.type,
    value.uuid,
    value.timestamp,
    payload?.type,
    payload?.turn_id,
    record.end,
  ].filter((part) => part != null).join(":");
}

async function listCandidates(
  env: Record<string, string>,
  onlyAgent?: Agent,
): Promise<Candidate[]> {
  const home = env.HOME;
  const roots: Array<{ agent: Agent; root: string; search: string }> = [];
  if (onlyAgent == null || onlyAgent === "codex") {
    const defaultHome = env.OS === "Windows_NT"
      ? env.USERPROFILE ?? home
      : home;
    const root = env.CODEX_HOME ??
      (defaultHome == null ? undefined : join(defaultHome, ".codex"));
    if (root != null) {
      roots.push({ agent: "codex", root, search: join(root, "sessions") });
    }
  }
  if (onlyAgent == null || onlyAgent === "claude") {
    const root = env.CLAUDE_CONFIG_DIR ??
      (home == null ? undefined : join(home, ".claude"));
    if (root != null) {
      roots.push({ agent: "claude", root, search: join(root, "projects") });
    }
  }
  const candidates: Candidate[] = [];
  for (const spec of roots) {
    for (const path of await walkJsonl(spec.search)) {
      const rel = relative(spec.search, path);
      if (spec.agent === "codex") {
        if (/^rollout-.*-[0-9a-f-]{36}\.jsonl$/i.test(basename(path))) {
          candidates.push({ agent: spec.agent, path, root: spec.root });
        }
      } else if (
        !rel.split(SEPARATOR).includes("subagents") &&
        sessionIdPattern.test(basename(path, ".jsonl"))
      ) {
        candidates.push({ agent: spec.agent, path, root: spec.root });
      }
    }
  }
  return candidates;
}

async function walkJsonl(root: string): Promise<string[]> {
  const paths: string[] = [];
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let real: string;
    try {
      real = await Deno.realPath(directory);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    for await (const entry of Deno.readDir(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory) pending.push(path);
      else if (entry.isSymlink) {
        const info = await Deno.stat(path);
        if (info.isDirectory) pending.push(path);
        else if (info.isFile && entry.name.endsWith(".jsonl")) paths.push(path);
      } else if (entry.isFile && entry.name.endsWith(".jsonl")) {
        paths.push(path);
      }
    }
  }
  return paths;
}

function candidateId(candidate: Candidate): string {
  const name = basename(candidate.path, ".jsonl").toLowerCase();
  return candidate.agent === "claude" ? name : name.slice(-36);
}

function inside(root: string, path: string): boolean {
  return path === root ||
    path.startsWith(root.endsWith(SEPARATOR) ? root : root + SEPARATOR);
}

async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return path;
    throw error;
  }
}

function rootForPath(path: string, agent: Agent): string {
  const marker = agent === "codex"
    ? `${SEPARATOR}sessions${SEPARATOR}`
    : `${SEPARATOR}projects${SEPARATOR}`;
  const index = path.indexOf(marker);
  return index < 0 ? path : path.slice(0, index);
}
