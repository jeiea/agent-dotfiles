import type { Configuration } from "npm:lint-staged@17.0.5";

const quote = (path: string) =>
  `"${path.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
const joinFiles = (files: readonly string[]) => files.map(quote).join(" ");
const formattableExtensions = new Set([
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".ts",
  ".tsx",
]);

const config: Configuration = {
  "*": (files) => {
    const formattableFiles = files.filter((file) =>
      formattableExtensions.has(getExtension(file))
    );
    return [
      ...(formattableFiles.length > 0
        ? [`deno fmt --permit-no-files ${joinFiles(formattableFiles)}`]
        : []),
      "deno task verify",
    ];
  },
};

export default config;

function getExtension(path: string): string {
  const filename = path.split(/[\\/]/).at(-1) ?? path;
  const extensionIndex = filename.lastIndexOf(".");
  return extensionIndex > 0 ? filename.slice(extensionIndex) : "";
}
