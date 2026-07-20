import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { htmlToMarkdown } from "./htmlToMarkdown.ts";

Deno.test("htmlToMarkdown removes non-content head script and style text", () => {
  const markdown = htmlToMarkdown(`<!doctype html>
<html>
  <head>
    <title>AI Workflow Guide</title>
    <script>
      (function(){
        var theme = localStorage.getItem('theme');
        document.documentElement.setAttribute('data-theme', theme);
      })();
    </script>
    <style>
      body { background: #eee; }
    </style>
    <noscript>Please enable JavaScript.</noscript>
  </head>
  <body>
    <h1>AI Workflow 구축 가이드</h1>
    <p>문서화하는 방법을 안내합니다.</p>
  </body>
</html>`);

  assertStringIncludes(markdown, "# AI Workflow 구축 가이드");
  assertStringIncludes(markdown, "문서화하는 방법을 안내합니다.");
  assertEquals(markdown.includes("AI Workflow Guide"), false);
  assertEquals(markdown.includes("localStorage"), false);
  assertEquals(markdown.includes("documentElement"), false);
  assertEquals(markdown.includes("background: #eee"), false);
  assertEquals(markdown.includes("Please enable JavaScript"), false);
});
