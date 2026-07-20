import { getCurrentBranch, runGitCommand } from "./git_commands.ts";
import { runJjCommand } from "./jj_commands.ts";

/** baseBranch 기준 현재 브랜치 커밋과 변경 파일 텍스트 반환 */
export async function getBranchChangesText(
  path: string,
  baseBranch: string,
  options: { vcs?: "git" | "jj" } = {},
): Promise<string> {
  if (options.vcs === "jj") {
    return await getJjBranchChangesText(path, baseBranch);
  }

  const currentBranch = await getCurrentBranch(path);

  const messages = await runGitCommand([
    "log",
    "--oneline",
    `${baseBranch}..${currentBranch}`,
  ], path);
  const mergeBase = await runGitCommand([
    "merge-base",
    baseBranch,
    currentBranch,
  ], path);
  const changes = await runGitCommand([
    "diff",
    "--stat",
    `${mergeBase}...${currentBranch}`,
  ], path);

  const isEmpty = messages.trim() === "" && changes.trim() === "";
  if (isEmpty) {
    return "No changes found";
  }
  return `# ${baseBranch}..${currentBranch}

# Commits:
${messages}

# Changes:
${changes}`;
}

async function getJjBranchChangesText(
  path: string,
  baseBranch: string,
): Promise<string> {
  const baseRevset = toJjBaseRevset(baseBranch);
  const exactBaseRevset = `exactly(${baseRevset}, 1)`;
  await validateJjBaseRevset(path, baseBranch, exactBaseRevset);
  const forkPointRevset = `fork_point(${exactBaseRevset} | @)`;
  const messages = await runJjCommand([
    "log",
    "--no-graph",
    "-r",
    `${exactBaseRevset}..@ & ~empty()`,
    "-T",
    'commit_id.short() ++ " " ++ description.first_line() ++ "\n"',
  ], path);
  const changes = await runJjCommand([
    "diff",
    "--from",
    forkPointRevset,
    "--to",
    "@",
    "--stat",
  ], path);

  const isEmpty = messages.trim() === "" && changes.trim() === "";
  if (isEmpty) {
    return "No changes found";
  }
  return `# ${baseBranch}..@

# Commits:
${messages}

# Changes:
${changes}`;
}

function toJjBaseRevset(baseBranch: string) {
  const normalizedRemoteRef = normalizeGitRemoteRef(baseBranch);
  if (normalizedRemoteRef) {
    return quoteJjSymbol(normalizedRemoteRef);
  }

  const trimmed = baseBranch.trim();
  if (isJjRevsetExpression(trimmed)) {
    return trimmed;
  }

  const remoteSlash = trimmed.match(/^(origin|upstream)\/(.+)$/);
  if (remoteSlash?.[1] && remoteSlash[2]) {
    return quoteJjSymbol(`${remoteSlash[2]}@${remoteSlash[1]}`);
  }

  if (trimmed.includes("@")) {
    return quoteJjSymbol(trimmed);
  }

  return `coalesce(${presentJjSymbol(trimmed)}, ${
    presentJjSymbol(`${trimmed}@origin`)
  }, ${presentJjSymbol(`${trimmed}@upstream`)})`;
}

async function validateJjBaseRevset(
  path: string,
  baseBranch: string,
  exactBaseRevset: string,
) {
  try {
    await runJjCommand([
      "log",
      "--no-graph",
      "-r",
      exactBaseRevset,
      "-T",
      'commit_id.short() ++ "\n"',
    ], path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `jj base revision not found or ambiguous: ${baseBranch}\n${detail}`,
    );
  }
}

function normalizeGitRemoteRef(ref: string) {
  const match = ref.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
  return match?.[1] && match[2] ? `${match[2]}@${match[1]}` : null;
}

function isJjRevsetExpression(value: string) {
  return value.startsWith("(") || value.startsWith('"') ||
    value.startsWith("'") ||
    /^[A-Za-z_][A-Za-z0-9_-]*\(.*\)$/.test(value) ||
    /[|&~]/.test(value) ||
    value.includes("..");
}

function quoteJjSymbol(symbol: string) {
  return JSON.stringify(symbol);
}

function presentJjSymbol(symbol: string) {
  return `present(${quoteJjSymbol(symbol)})`;
}
