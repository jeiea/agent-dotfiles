#!/usr/bin/env -S deno run -A

import { resolve, toFileUrl } from "jsr:@std/path@^1";

interface LspMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class LspClient {
  private process: Deno.ChildProcess;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private notifications: LspMessage[] = [];
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private buffer = new Uint8Array(0);
  private initialized = false;
  private readingStarted = false;
  private debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
    const command = new Deno.Command("deno", {
      args: ["lsp"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    this.process = command.spawn();
    this.writer = this.process.stdin.getWriter();
    this.reader = this.process.stdout.getReader();
  }

  private ensureReading() {
    if (this.readingStarted) return;
    this.readingStarted = true;
    this.startReading();
  }

  private async startReading() {
    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;
        const newBuffer = new Uint8Array(this.buffer.length + value.length);
        newBuffer.set(this.buffer);
        newBuffer.set(value, this.buffer.length);
        this.buffer = newBuffer;
        this.processBuffer();
      }
    } catch {
      // Process closed
    }
  }

  private findHeaderEnd(): number {
    const separator = this.encoder.encode("\r\n\r\n");
    for (let i = 0; i <= this.buffer.length - 4; i++) {
      if (
        this.buffer[i] === separator[0] &&
        this.buffer[i + 1] === separator[1] &&
        this.buffer[i + 2] === separator[2] &&
        this.buffer[i + 3] === separator[3]
      ) {
        return i;
      }
    }
    return -1;
  }

  private processBuffer() {
    while (true) {
      const headerEnd = this.findHeaderEnd();
      if (headerEnd === -1) break;

      const headerBytes = this.buffer.slice(0, headerEnd);
      const header = this.decoder.decode(headerBytes);
      const match = header.match(/Content-Length:\s*(\d+)/i)?.[1];
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match, 10);
      const contentStart = headerEnd + 4;
      const contentEnd = contentStart + contentLength;

      if (this.buffer.length < contentEnd) break;

      const contentBytes = this.buffer.slice(contentStart, contentEnd);
      const content = this.decoder.decode(contentBytes);
      this.buffer = this.buffer.slice(contentEnd);

      try {
        const message: LspMessage = JSON.parse(content);
        this.handleMessage(message);
      } catch {
        // Invalid JSON
      }
    }
  }

  private handleMessage(message: LspMessage) {
    if (this.debug) {
      console.error("[LSP]", JSON.stringify(message).slice(0, 200));
    }
    if (message.id !== undefined && !message.method) {
      // Response to our request
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.id !== undefined && message.method) {
      // Request from server - respond (fire and forget)
      this.handleServerRequest(message).catch(() => {});
    } else if (message.method) {
      // Notification from server
      this.notifications.push(message);
    }
  }

  private async handleServerRequest(message: LspMessage) {
    if (message.method === "workspace/configuration") {
      // Respond with deno configuration
      const params = message.params as { items: Array<{ section?: string }> };
      const result = params.items.map((item) => {
        if (item.section === "deno") {
          return { enable: true, lint: true, unstable: true };
        }
        return {};
      });
      await this.send({ jsonrpc: "2.0", id: message.id, result });
    } else if (message.method === "client/registerCapability") {
      await this.send({ jsonrpc: "2.0", id: message.id, result: null });
    } else {
      // Unknown request - respond with null
      await this.send({ jsonrpc: "2.0", id: message.id, result: null });
    }
  }

  private async send(message: LspMessage) {
    const json = JSON.stringify(message);
    const bytes = this.encoder.encode(json);
    const header = `Content-Length: ${bytes.length}\r\n\r\n`;
    if (this.debug) console.error("[SEND]", json.slice(0, 200));
    await this.writer.write(this.encoder.encode(header + json));
  }

  async request(
    method: string,
    params?: unknown,
    timeout = 10000,
  ): Promise<unknown> {
    await this.ensureReading();
    const id = ++this.requestId;
    const message: LspMessage = { jsonrpc: "2.0", id, method, params };

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, timeout);
    });

    await this.send(message);
    return promise;
  }

  async notify(method: string, params?: unknown) {
    await this.send({ jsonrpc: "2.0", method, params });
  }

  getNotifications(method?: string): LspMessage[] {
    if (method) {
      return this.notifications.filter((n) => n.method === method);
    }
    return this.notifications;
  }

  async initialize(rootUri: string) {
    if (this.initialized) return;

    await this.request("initialize", {
      processId: Deno.pid,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
          configuration: true,
          workspaceFolders: true,
        },
      },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      initializationOptions: {
        enable: true,
        lint: true,
        unstable: true,
      },
    });

    await this.notify("initialized", {});
    this.initialized = true;
  }

  async openDocument(uri: string, text: string) {
    await this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: uri.endsWith(".ts") || uri.endsWith(".tsx")
          ? "typescript"
          : uri.endsWith(".js") || uri.endsWith(".jsx")
          ? "javascript"
          : "plaintext",
        version: 1,
        text,
      },
    });
  }

  async hover(uri: string, line: number, character: number): Promise<unknown> {
    return await this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async definition(
    uri: string,
    line: number,
    character: number,
  ): Promise<unknown> {
    return await this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async close() {
    try {
      await this.request("shutdown", undefined, 3000);
      await this.notify("exit");
    } catch {
      // Ignore errors during shutdown
    }
    try {
      await this.writer.close();
    } catch {
      // Already closed
    }
    try {
      this.process.kill();
    } catch {
      // Already dead
    }
  }
}

main();

async function main() {
  const debug = Deno.env.get("DEBUG") === "1";
  const [command, filePath, lineStr, colStr] = Deno.args;

  if (!command || !filePath) {
    printUsageAndExit();
  }

  const absolutePath = resolve(filePath);
  const fileUri = toFileUrl(absolutePath).href;
  const projectRoot = await findProjectRoot(absolutePath);
  const rootUri = toFileUrl(projectRoot).href;

  const client = new LspClient(debug);

  try {
    await client.initialize(rootUri);

    const text = await Deno.readTextFile(absolutePath);
    await client.openDocument(fileUri, text);

    // diagnostics 수신 대기
    await new Promise((r) => setTimeout(r, 1500));

    switch (command) {
      case "hover": {
        if (!lineStr || !colStr) {
          printUsageAndExit();
        }

        const line = parseInt(lineStr, 10) - 1;
        const col = parseInt(colStr, 10) - 1;
        if (isNaN(line) || isNaN(col)) {
          console.error("Invalid line or column");
          Deno.exit(1);
        }
        const result = await client.hover(fileUri, line, col);
        console.log(formatHover(result));
        break;
      }

      case "diagnostics": {
        console.log(formatDiagnostics(client.getNotifications()));
        break;
      }

      case "definition": {
        if (!lineStr || !colStr) {
          printUsageAndExit();
        }

        const line = parseInt(lineStr, 10) - 1;
        const col = parseInt(colStr, 10) - 1;
        if (isNaN(line) || isNaN(col)) {
          console.error("Invalid line or column");
          Deno.exit(1);
        }
        const result = await client.definition(fileUri, line, col);
        console.log(formatDefinition(result));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        Deno.exit(1);
    }
  } finally {
    await client.close();
  }
}

function printUsageAndExit(): never {
  console.error(`Usage:
  deno run -A lsp-client.ts hover <file> <line> <column>
  deno run -A lsp-client.ts diagnostics <file>
  deno run -A lsp-client.ts definition <file> <line> <column>

Line and column are 1-based.`);
  Deno.exit(1);
}

async function findProjectRoot(filePath: string): Promise<string> {
  let dir = resolve(filePath, "..");
  while (dir !== resolve(dir, "..")) {
    for (const name of ["deno.json", "deno.jsonc"]) {
      try {
        await Deno.stat(resolve(dir, name));
        return dir;
      } catch {
        // Not found
      }
    }
    dir = resolve(dir, "..");
  }
  return resolve(filePath, "..");
}

function formatHover(result: unknown): string {
  if (!result) return "No hover information";
  const hover = result as { contents?: unknown };
  if (!hover.contents) return "No hover information";

  if (typeof hover.contents === "string") return hover.contents;
  if (Array.isArray(hover.contents)) {
    return hover.contents.map((
      c,
    ) => (typeof c === "string" ? c : c.value || "")).join("\n");
  }
  const contents = hover.contents as { value?: string; kind?: string };
  return contents.value || JSON.stringify(hover.contents);
}

function formatDefinition(result: unknown): string {
  if (!result) return "No definition found";

  const locations = Array.isArray(result) ? result : [result];
  return locations
    .map((loc) => {
      const uri = loc.targetUri || loc.uri;
      const range = loc.targetRange || loc.range;
      if (!uri || !range) return JSON.stringify(loc);

      const path = decodeURIComponent(uri.replace(/^file:\/\/\//, ""));
      const line = range.start.line + 1;
      const col = range.start.character + 1;
      return `${path}:${line}:${col}`;
    })
    .join("\n");
}

function formatDiagnostics(notifications: LspMessage[]): string {
  const diagnosticNotifs = notifications.filter(
    (n) => n.method === "textDocument/publishDiagnostics",
  );

  if (diagnosticNotifs.length === 0) return "No diagnostics";

  const lines: string[] = [];
  for (const notif of diagnosticNotifs) {
    const params = notif.params as {
      uri: string;
      diagnostics: Array<{
        range: { start: { line: number; character: number } };
        severity?: number;
        message: string;
        source?: string;
      }>;
    };

    const path = decodeURIComponent(params.uri.replace(/^file:\/\/\//, ""));
    for (const diag of params.diagnostics) {
      const severity =
        ["", "Error", "Warning", "Info", "Hint"][diag.severity || 1];
      const line = diag.range.start.line + 1;
      const col = diag.range.start.character + 1;
      lines.push(`${path}:${line}:${col} [${severity}] ${diag.message}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "No issues found";
}
