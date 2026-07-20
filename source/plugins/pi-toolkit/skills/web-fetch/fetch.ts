import { Readability } from "npm:@mozilla/readability@^0.6.0";
import { JSDOM } from "npm:jsdom@^28.0.0";
import { htmlToMarkdown } from "./htmlToMarkdown.ts";

if (import.meta.main) {
  main();
}

async function main() {
  const url = Deno.args[0];
  if (!url) {
    printHelp();
    Deno.exit(1);
  }

  try {
    await fetchMarkdown(url);
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : `${e}`}`);
    Deno.exit(1);
  }
}

async function fetchMarkdown(url: string) {
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
    console.error(`HTTP ${response.status}: ${response.statusText}`);
    Deno.exit(1);
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (article && article.content) {
    if (article.title) {
      console.info(`# ${article.title}\n`);
    }
    console.info(htmlToMarkdown(article.content));
    Deno.exit(0);
  }

  // Fallback: try to extract main content
  const fallbackDoc = new JSDOM(html, { url });
  const body = fallbackDoc.window.document;
  body
    .querySelectorAll("script, style, noscript, nav, header, footer, aside")
    .forEach((el) => el.remove());

  const title = body.querySelector("title")?.textContent?.trim();
  const main =
    body.querySelector("main, article, [role='main'], .content, #content") ||
    body.body;

  if (title) {
    console.info(`# ${title}\n`);
  }

  const text = main?.innerHTML || "";
  if (text.trim().length > 100) {
    console.info(htmlToMarkdown(text));
  } else {
    console.error("Could not extract readable content from this page.");
    Deno.exit(1);
  }
}

function printHelp() {
  console.info(`Usage: deno -A content.ts <url>
Fetch and extract content from a URL.

Examples:
  deno -A ./fetch.ts https://example.com/article
  deno -A ./fetch.ts https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html`);
}
