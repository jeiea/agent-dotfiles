// @ts-types="npm:@types/turndown@^5.0.6"
import TurndownService from "npm:turndown@^7.2.2";
import { gfm } from "npm:turndown-plugin-gfm@^1.0.2";

const NON_CONTENT_NODE_NAMES = new Set([
  "HEAD",
  "TITLE",
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
]);

if (import.meta.main) {
  await main();
}

export function htmlToMarkdown(html: string) {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  turndown.use(gfm);
  turndown.addRule("removeNonContentElements", {
    filter: (node) => NON_CONTENT_NODE_NAMES.has(node.nodeName),
    replacement: () => "",
  });
  turndown.addRule("removeEmptyLinks", {
    filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => "",
  });
  return turndown
    .turndown(html)
    .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
    .replace(/ +/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function main() {
  const input = Deno.args[0];
  if (!input) {
    printHelp();
    Deno.exit(1);
  }

  try {
    const html = input === "-" ? await readStdin() : await fetchHtml(input);
    console.info(htmlToMarkdown(html));
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : `${e}`}`);
    Deno.exit(1);
  }
}

async function readStdin() {
  return await new Response(Deno.stdin.readable).text();
}

async function fetchHtml(input: string) {
  const url = new URL(input);
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.text();
}

function printHelp() {
  console.info(`Usage: deno -A htmlToMarkdown.ts <url|->
Convert HTML from stdin or a URL to Markdown.

Examples:
  deno -A ./htmlToMarkdown.ts - < page.html
  deno -A ./htmlToMarkdown.ts https://example.com`);
}
