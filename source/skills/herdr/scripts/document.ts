import { stringify } from "jsr:@std/yaml@^1";

export type DocumentFront = {
  run_id?: string;
  status: string;
  agent?: string;
  transport?: string;
  permission?: string;
  session_id?: string;
  cwd?: string;
  reason?: readonly string[];
  started_at?: string;
  finished_at?: string;
  command?: readonly string[];
  prompt?: {
    source: "stdin" | "file";
    path?: string;
    bytes: number;
    sha256: string;
  };
  herdr?: Record<string, unknown>;
  error?: { code: string; message: string };
};

export function renderDocument(front: DocumentFront, body = ""): string {
  const yaml = stringify(
    Object.fromEntries(
      Object.entries(front).filter(([, value]) => value !== undefined),
    ),
    { lineWidth: -1 },
  );
  return `---\n${yaml}---\n\n${body}`;
}
