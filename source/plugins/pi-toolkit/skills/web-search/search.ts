#!/usr/bin/env deno

import { Readability } from "npm:@mozilla/readability@^0.6.0";
// @ts-types="npm:@types/jsdom@^27.0.0"
import { JSDOM } from "npm:jsdom@^28.0.0";
import { htmlToMarkdown } from "../web-fetch/htmlToMarkdown.ts";
import { parseArgs } from "jsr:@std/cli@^1/parse-args";

if (import.meta.main) {
  main();
}

async function main() {
  const {
    content: isContentRequested,
    country,
    freshness,
    numResults,
    _: positionals,
  } = parseArgs(Deno.args, {
    string: ["numResults", "country", "freshness"],
    boolean: ["content"],
  });

  const query = positionals.join(" ");
  if (!query) {
    printHelp();
    Deno.exit(1);
  }

  const apiKey = Deno.env.get("BRAVE_API_KEY");
  if (!apiKey) {
    console.error("Error: BRAVE_API_KEY environment variable is required.");
    console.error(
      "Get your API key at: https://api-dashboard.search.brave.com/app/keys",
    );
    Deno.exit(1);
  }

  try {
    const results = await fetchBraveResults(query, {
      numResults: Number(numResults ?? 5),
      country: country ?? "US",
      freshness: freshness ?? null,
      apiKey,
    });

    if (results.length === 0) {
      console.error("No results found.");
      Deno.exit(0);
    }

    if (isContentRequested) {
      for (const result of results) {
        result.content = await fetchPageContent(result.link);
      }
    }

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;

      console.log(`--- Result ${i + 1} ---`);
      console.log(`Title: ${r.title}`);
      console.log(`Link: ${r.link}`);
      if (r.age) {
        console.log(`Age: ${r.age}`);
      }
      console.log(`Snippet: ${r.snippet}`);
      if (r.content) {
        console.log(`Content:\n${r.content}`);
      }
      console.log("");
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : `${e}`}`);
    Deno.exit(1);
  }
}

function printHelp() {
  console.info(
    `Usage: deno search.ts <query> [-n <num>] [--content] [--country <code>] [--freshness <period>]

Options:
  -n <num>              Number of results (default: 5, max: 20)
  --content             Fetch readable content as markdown
  --country <code>      Country code for results (default: US)
  --freshness <period>  Filter by time: pd (day), pw (week), pm (month), py (year)

	Environment:
  BRAVE_API_KEY         Required. Your Brave Search API key.

Examples:"
  search.js "javascript async await"
  search.js "rust programming" -n 10
  search.js "climate change" --content
  search.js "news today" --freshness pd`,
  );
}

type BraveSearchOptions = {
  numResults: number;
  country: string;
  freshness: string | null;
  apiKey: string;
};

async function fetchBraveResults(
  query: string,
  { numResults, country, freshness, apiKey }: BraveSearchOptions,
): Promise<
  {
    title: string;
    link: string;
    snippet: string;
    age: string;
    content?: string;
  }[]
> {
  const params = new URLSearchParams({
    q: query,
    count: Math.min(numResults, 20).toString(),
    country: country,
  });

  if (freshness) {
    params.append("freshness", freshness);
  }

  const url =
    `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      ...(apiKey ? { "X-Subscription-Token": apiKey } : {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HTTP ${response.status}: ${response.statusText}\n${errorText}`,
    );
  }

  const data = await response.json();

  const results = [];

  // Extract web results
  if (data.web && data.web.results) {
    for (const result of data.web.results) {
      if (results.length >= numResults) break;

      results.push({
        title: result.title || "",
        link: result.url || "",
        snippet: result.description || "",
        age: result.age || result.page_age || "",
      });
    }
  }

  return results;
}

async function fetchPageContent(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return `(HTTP ${response.status})`;
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (article && article.content) {
      return htmlToMarkdown(article.content).substring(0, 5000);
    }

    // Fallback: try to get main content
    const fallbackDoc = new JSDOM(html, { url });
    const body = fallbackDoc.window.document;
    body
      .querySelectorAll("script, style, noscript, nav, header, footer, aside")
      .forEach((el) => el.remove());
    const main =
      body.querySelector("main, article, [role='main'], .content, #content") ||
      body.body;
    const text = main?.textContent || "";

    if (text.trim().length > 100) {
      return text.trim().substring(0, 5000);
    }

    return "(Could not extract content)";
  } catch (e) {
    return `(Error: ${e instanceof Error ? e.message : `${e}`})`;
  }
}
