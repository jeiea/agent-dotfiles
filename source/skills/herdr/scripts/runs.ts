import { join } from "jsr:@std/path@^1";
import type { Agent, Permission, Transport } from "./select.ts";

export type RunStatus =
  | "planned"
  | "starting"
  | "working"
  | "done"
  | "blocked"
  | "timed_out"
  | "failed"
  | "cancelled";

export type RunRecord = {
  runId: string;
  parentRunId?: string;
  agent: Agent;
  transport: Transport;
  permission: Permission;
  cwd: string;
  callerId?: string;
  name?: string;
  keep?: boolean;
  reason: string[];
  nativeSessionId?: string;
  herdr?: {
    workspaceId: string;
    tabId: string;
    paneId: string;
    agentName: string;
    createdTab: boolean;
  };
  status: RunStatus;
  error?: { code: string; message: string };
  timeoutMs: number;
  prompt: { bytes: number; sha256: string };
  startedAt: string;
  finishedAt?: string;
};

export function runExitCode(status: RunStatus): number {
  if (status === "blocked") return 4;
  if (status === "failed") return 5;
  if (status === "timed_out") return 6;
  if (status === "cancelled") return 130;
  return 0;
}

const runIdPattern =
  /^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertRunId(runId: string): void {
  if (!runIdPattern.test(runId)) throw new Error(`잘못된 run ID: ${runId}`);
}

export async function readRun(
  stateDir: string,
  runId: string,
): Promise<RunRecord> {
  assertRunId(runId);
  try {
    return JSON.parse(
      await Deno.readTextFile(join(stateDir, "runs", `${runId}.json`)),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`실행 기록 없음: ${runId}`);
    }
    throw error;
  }
}

export async function writeRun(
  stateDir: string,
  record: RunRecord,
): Promise<void> {
  const dir = join(stateDir, "runs");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, `${record.runId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

export async function writeLogs(
  stateDir: string,
  runId: string,
  stdout: string,
  stderr: string,
): Promise<void> {
  await Deno.mkdir(join(stateDir, "runs"), { recursive: true });
  await Promise.all([
    Deno.writeTextFile(logPath(stateDir, runId, "stdout"), stdout),
    Deno.writeTextFile(logPath(stateDir, runId, "stderr"), stderr),
  ]);
}

export async function readLog(
  stateDir: string,
  runId: string,
  stream: "stdout" | "stderr",
): Promise<string> {
  try {
    return await Deno.readTextFile(logPath(stateDir, runId, stream));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "";
    throw error;
  }
}

export async function listRuns(stateDir: string): Promise<RunRecord[]> {
  const dir = join(stateDir, "runs");
  try {
    const records: RunRecord[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      records.push(JSON.parse(await Deno.readTextFile(join(dir, entry.name))));
    }
    return records;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

function logPath(
  stateDir: string,
  runId: string,
  stream: "stdout" | "stderr",
): string {
  assertRunId(runId);
  return join(stateDir, "runs", `${runId}.${stream}.log`);
}
