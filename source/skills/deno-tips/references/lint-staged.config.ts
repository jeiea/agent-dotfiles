import type { Configuration } from "lint-staged";

const formattableExtensions = new Set([
  "js",
  "jsx",
  "json",
  "jsonc",
  "md",
  "ts",
  "tsx",
]);
const lintableExtensions = new Set(["js", "jsx", "ts", "tsx"]);

const config: Configuration = (files) => {
  const formattableFiles = files.filter((file) =>
    hasExtension(file, formattableExtensions)
  );
  const lintableFiles = files.filter((file) =>
    hasExtension(file, lintableExtensions)
  );
  const commands: string[] = [];

  if (formattableFiles.length > 0) {
    commands.push(`deno fmt ${joinFiles(formattableFiles)}`);
  }

  if (lintableFiles.length > 0) {
    commands.push(`deno lint ${joinFiles(lintableFiles)}`);
  }

  commands.push("deno task check:lint-staged");

  return commands;
};

export default config;

function hasExtension(file: string, extensions: ReadonlySet<string>): boolean {
  const extension = file.split(".").at(-1)?.toLowerCase();
  return extension === undefined ? false : extensions.has(extension);
}

function joinFiles(files: readonly string[]): string {
  return files.map(quote).join(" ");
}

function quote(path: string): string {
  return `"${path.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
}
