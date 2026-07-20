#!/usr/bin/env -S deno run --allow-run=fig --allow-write
import { parseArgs } from "jsr:@std/cli@^1";

const PRACTICAL_UNBOUNDED_DEPTH = 99;
const MAX_TEXT_LENGTH = 120;
const ICON_ASSET_MAX_SIZE = 64;

export interface TreeNode {
  id: string;
  name: string;
  type: string;
  children?: TreeNode[];
}

export interface FigTreeResult {
  rootNodeId?: string;
  rootNodeName?: string;
  rootNodeType?: string;
  page?: string;
  ancestors?: Array<{ id: string; name: string; type: string }>;
  tree: TreeNode;
}

export interface FigStyleNode {
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
  absoluteBoundingBox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  css?: Record<string, string>;
  layout?: Record<string, unknown>;
  style?: Record<string, unknown>;
}

export interface FigStylesResult {
  count?: number;
  nodes?: FigStyleNode[];
}

export interface FigColorNode {
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
  depth?: number;
  fills?: string[];
  strokes?: string[];
}

export interface FigColorsResult {
  fileKey?: string;
  nodeId?: string;
  depth?: number;
  count?: number;
  nodes?: FigColorNode[];
}

export interface FigTextNode {
  id: string;
  name?: string;
  page?: string;
  text: string;
}

export interface FigTextResult {
  fileKey?: string;
  nodeId?: string;
  count?: number;
  nodes?: FigTextNode[];
}

export interface AnnotatedTreeInput {
  source?: string;
  tree: FigTreeResult;
  styles?: FigStylesResult | FigStyleNode;
  colors?: FigColorsResult;
  text?: FigTextResult;
}

interface RenderOptions {
  maxTextLength?: number;
}

interface NodeAnnotations {
  size?: string;
  layout?: string;
  space?: string;
  paint?: string;
}

interface LookupTables {
  styles: Map<string, FigStyleNode>;
  colors: Map<string, FigColorNode>;
  texts: Map<string, FigTextNode>;
  textStyles: TextStyleRegistry;
  visitedTextIds: Set<string>;
}

interface TextStyleRegistry {
  idsByNode: Map<string, string>;
  stylesById: Map<string, string>;
}

if (import.meta.main) {
  await main();
}

export function renderAnnotatedTree(
  input: AnnotatedTreeInput,
  options: RenderOptions = {},
): string {
  const root = input.tree.tree;
  const lookups = buildLookupTables(input);
  const lines: string[] = [];

  lines.push("# Figma Annotated Tree");
  lines.push("");
  if (input.source) {
    lines.push(`source: ${input.source}`);
  }
  lines.push(`root: \`${root.id}\` ${root.name} \`${root.type}\``);
  if (input.tree.page) {
    lines.push(`page: ${input.tree.page.replaceAll("\b", "")}`);
  }
  const path = formatPath(input.tree.ancestors, root);
  if (path) {
    lines.push(`path: ${path}`);
  }
  lines.push("");
  lines.push("```txt");
  renderNode(root, lookups, lines, {
    depth: 0,
    parent: {},
    maxTextLength: options.maxTextLength ?? MAX_TEXT_LENGTH,
  });
  lines.push("```");

  if (lookups.textStyles.stylesById.size > 0) {
    lines.push("");
    lines.push("## Text Styles");
    lines.push("");
    for (const [id, style] of lookups.textStyles.stylesById) {
      lines.push(`- [${id}] ${style}`);
    }
  }

  const unplacedTexts = findUnplacedTexts(lookups);
  if (unplacedTexts.length > 0) {
    lines.push("");
    lines.push("## Unplaced Text");
    lines.push("");
    lines.push(
      "Tree depth or instance expansion did not expose these text leaves.",
    );
    for (const text of unplacedTexts.slice(0, 20)) {
      lines.push(
        `- ${text.id}: "${
          truncateOneLine(text.text, options.maxTextLength ?? MAX_TEXT_LENGTH)
        }"`,
      );
    }
    if (unplacedTexts.length > 20) {
      lines.push(`- ... ${unplacedTexts.length - 20} more`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function collectStyleTargetIds(root: TreeNode): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  visitTree(root, (node) => {
    if (!isStyleTargetType(node.type) || seen.has(node.id)) {
      return;
    }
    seen.add(node.id);
    ids.push(node.id);
  });

  return ids;
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["node-id", "output", "text-length"],
    boolean: ["help"],
    alias: { n: "node-id", o: "output", h: "help" },
  });

  if (args.help) {
    printHelp();
    return;
  }

  const file = String(args._[0] ?? "");
  const nodeId = args["node-id"];
  if (!file || !nodeId) {
    printHelp();
    Deno.exit(1);
  }

  const textLength = parseTextLength(args["text-length"]);
  const tree = await runFigJson<FigTreeResult>([
    "tree",
    file,
    "--node-id",
    nodeId,
    "--depth",
    String(PRACTICAL_UNBOUNDED_DEPTH),
    "--format",
    "json",
  ]);
  const styleIds = collectStyleTargetIds(tree.tree);
  const styles = await readStyles(file, styleIds);
  const [colors, text] = await Promise.all([
    runFigJson<FigColorsResult>([
      "colors",
      file,
      "--node-id",
      nodeId,
      "--depth",
      String(PRACTICAL_UNBOUNDED_DEPTH),
      "--format",
      "json",
    ]),
    runFigJson<FigTextResult>([
      "text",
      file,
      "--node-id",
      nodeId,
      "--format",
      "json",
    ]),
  ]);

  const report = renderAnnotatedTree({
    source: file,
    tree,
    styles,
    colors,
    text,
  }, { maxTextLength: textLength });

  const output = args.output;
  if (output) {
    await Deno.writeTextFile(output, report);
    return;
  }
  console.info(report);
}

function renderNode(
  node: TreeNode,
  lookups: LookupTables,
  lines: string[],
  context: { depth: number; parent: NodeAnnotations; maxTextLength: number },
) {
  const indent = "  ".repeat(context.depth);
  lines.push(`${indent}${node.id} ${node.name} ${node.type}`);

  const annotations = getAnnotations(node, lookups);
  pushChangedAnnotation(
    lines,
    indent,
    "size",
    annotations.size,
    context.parent.size,
    context.depth,
  );
  pushChangedAnnotation(
    lines,
    indent,
    "layout",
    annotations.layout,
    context.parent.layout,
    context.depth,
  );
  pushChangedAnnotation(
    lines,
    indent,
    "space",
    annotations.space,
    context.parent.space,
    context.depth,
  );
  pushChangedAnnotation(
    lines,
    indent,
    "paint",
    annotations.paint,
    context.parent.paint,
    context.depth,
  );

  const asset = getCollapsibleAsset(node, lookups);
  if (asset) {
    lines.push(`${indent}  asset ${asset.kind}`);
    if (asset.colors.length > 0) {
      lines.push(`${indent}  paint colors ${asset.colors.join(",")}`);
    }
    return;
  }

  const children = node.children ?? [];
  if (children.length === 0) {
    const text = lookups.texts.get(node.id);
    if (text) {
      lookups.visitedTextIds.add(text.id);
      const styleId = lookups.textStyles.idsByNode.get(node.id);
      const styleRef = styleId ? ` [${styleId}]` : "";
      lines.push(
        `${indent}  text${styleRef} "${
          truncateOneLine(text.text, context.maxTextLength)
        }"`,
      );
    }
  }

  for (const child of children) {
    renderNode(child, lookups, lines, {
      depth: context.depth + 1,
      parent: annotations,
      maxTextLength: context.maxTextLength,
    });
  }
}

function getAnnotations(
  node: TreeNode,
  lookups: LookupTables,
): NodeAnnotations {
  const style = lookups.styles.get(node.id);
  const color = lookups.colors.get(node.id);

  return {
    size: formatSize(style),
    layout: formatLayout(style),
    space: formatSpace(style),
    paint: formatPaint(style, color),
  };
}

function pushChangedAnnotation(
  lines: string[],
  indent: string,
  label: keyof NodeAnnotations,
  value: string | undefined,
  parentValue: string | undefined,
  depth: number,
) {
  if (!value) {
    return;
  }
  if (depth > 0 && value === parentValue) {
    return;
  }
  lines.push(`${indent}  ${label} ${value}`);
}

function buildLookupTables(input: AnnotatedTreeInput): LookupTables {
  const styles = new Map<string, FigStyleNode>();
  for (const style of normalizeStyles(input.styles)) {
    styles.set(style.nodeId, style);
  }

  const colors = new Map<string, FigColorNode>();
  for (const color of input.colors?.nodes ?? []) {
    colors.set(color.nodeId, color);
  }

  const texts = new Map<string, FigTextNode>();
  for (const text of input.text?.nodes ?? []) {
    texts.set(text.id, text);
  }

  return {
    styles,
    colors,
    texts,
    textStyles: buildTextStyleRegistry(styles, colors, texts),
    visitedTextIds: new Set(),
  };
}

function normalizeStyles(
  styles: FigStylesResult | FigStyleNode | undefined,
): FigStyleNode[] {
  if (!styles) {
    return [];
  }
  if ("nodes" in styles && Array.isArray(styles.nodes)) {
    return styles.nodes;
  }
  if ("nodeId" in styles) {
    return [styles];
  }
  return [];
}

function formatSize(style: FigStyleNode | undefined): string | undefined {
  const box = style?.absoluteBoundingBox;
  if (box?.width !== undefined && box.height !== undefined) {
    return `${formatNumber(box.width)}x${formatNumber(box.height)}`;
  }

  const width = style?.css?.width;
  const height = style?.css?.height;
  if (width && height) {
    return `${width.replace("px", "")}x${height.replace("px", "")}`;
  }
  return undefined;
}

function formatLayout(style: FigStyleNode | undefined): string | undefined {
  const css = style?.css;
  const layout = style?.layout;
  if (!css && !layout) {
    return undefined;
  }

  const parts: string[] = [];
  const mode = stringValue(layout?.mode) ??
    css?.["flex-direction"]?.toUpperCase();
  if (mode) {
    parts.push(mode);
  }

  const sizing = [
    stringValue(layout?.layoutSizingHorizontal),
    stringValue(layout?.layoutSizingVertical),
  ].filter(Boolean).join("/");
  if (sizing) {
    parts.push(sizing);
  }

  const primary = stringValue(layout?.primaryAxisAlignItems);
  const counter = stringValue(layout?.counterAxisAlignItems);
  if (primary || counter) {
    parts.push(`align ${[primary, counter].filter(Boolean).join("/")}`);
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function formatSpace(style: FigStyleNode | undefined): string | undefined {
  const css = style?.css;
  if (!css) {
    return undefined;
  }

  const parts: string[] = [];
  if (css.gap) {
    parts.push(`gap ${css.gap}`);
  }
  if (css.padding) {
    parts.push(`padding ${css.padding}`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function formatPaint(
  style: FigStyleNode | undefined,
  color: FigColorNode | undefined,
): string | undefined {
  const parts: string[] = [];
  const css = style?.css;
  if (css?.["background-color"]) {
    parts.push(`bg ${css["background-color"]}`);
  }
  if (css?.["box-shadow"]) {
    parts.push(`shadow ${css["box-shadow"]}`);
  }
  if (!css?.["background-color"] && color?.fills && color.fills.length > 0) {
    parts.push(`fills ${dedupe(color.fills).join(",")}`);
  }
  if (color?.strokes && color.strokes.length > 0) {
    parts.push(`strokes ${dedupe(color.strokes).join(",")}`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function getCollapsibleAsset(
  node: TreeNode,
  lookups: LookupTables,
): { kind: string; colors: string[] } | undefined {
  if (!isSvgLikeAsset(node, lookups)) {
    return undefined;
  }

  return {
    kind: "svg/icon",
    colors: collectDescendantColors(node, lookups),
  };
}

function isSvgLikeAsset(node: TreeNode, lookups: LookupTables): boolean {
  if (hasTextDescendant(node, lookups)) {
    return false;
  }

  const style = lookups.styles.get(node.id);
  const size = getNodeSize(style);
  const isSmall = size !== undefined &&
    size.width <= ICON_ASSET_MAX_SIZE &&
    size.height <= ICON_ASSET_MAX_SIZE;
  const name = node.name.toLowerCase();
  const hasSvgName = name.endsWith(".svg");
  const hasIconInstanceShape = node.type === "INSTANCE" && isSmall;

  if (!hasSvgName && !hasIconInstanceShape) {
    return false;
  }

  const children = node.children ?? [];
  if (children.length === 0) {
    return hasSvgName || hasIconInstanceShape;
  }

  return descendantsAreVectorOnly(node);
}

function descendantsAreVectorOnly(node: TreeNode): boolean {
  for (const child of node.children ?? []) {
    if (!isVectorDetailType(child.type)) {
      return false;
    }
    if (!descendantsAreVectorOnly(child)) {
      return false;
    }
  }
  return true;
}

function isVectorDetailType(type: string): boolean {
  return [
    "BOOLEAN_OPERATION",
    "ELLIPSE",
    "FRAME",
    "GROUP",
    "LINE",
    "POLYGON",
    "RECTANGLE",
    "STAR",
    "VECTOR",
  ].includes(type);
}

function hasTextDescendant(node: TreeNode, lookups: LookupTables): boolean {
  let hasText = false;
  visitTree(node, (child) => {
    if (child.type === "TEXT" || lookups.texts.has(child.id)) {
      hasText = true;
    }
  });
  return hasText;
}

function getNodeSize(
  style: FigStyleNode | undefined,
): { width: number; height: number } | undefined {
  const box = style?.absoluteBoundingBox;
  if (box?.width !== undefined && box.height !== undefined) {
    return { width: box.width, height: box.height };
  }

  const width = parsePixelValue(style?.css?.width);
  const height = parsePixelValue(style?.css?.height);
  if (width !== undefined && height !== undefined) {
    return { width, height };
  }
  return undefined;
}

function parsePixelValue(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value.replace("px", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function collectDescendantColors(
  node: TreeNode,
  lookups: LookupTables,
): string[] {
  const colors: string[] = [];
  visitTree(node, (child) => {
    const color = lookups.colors.get(child.id);
    colors.push(...color?.fills ?? []);
    colors.push(...color?.strokes ?? []);
  });
  return dedupe(colors);
}

function buildTextStyleRegistry(
  styles: Map<string, FigStyleNode>,
  colors: Map<string, FigColorNode>,
  texts: Map<string, FigTextNode>,
): TextStyleRegistry {
  const idsByNode = new Map<string, string>();
  const idsBySignature = new Map<string, string>();
  const stylesById = new Map<string, string>();

  for (const nodeId of texts.keys()) {
    const signature = formatTextStyle(styles.get(nodeId), colors.get(nodeId));
    if (!signature) {
      continue;
    }

    let styleId = idsBySignature.get(signature);
    if (!styleId) {
      styleId = `T${idsBySignature.size + 1}`;
      idsBySignature.set(signature, styleId);
      stylesById.set(styleId, signature);
    }
    idsByNode.set(nodeId, styleId);
  }

  return { idsByNode, stylesById };
}

function formatTextStyle(
  style: FigStyleNode | undefined,
  color: FigColorNode | undefined,
): string | undefined {
  const css = style?.css;
  if (!css) {
    return undefined;
  }

  const fontFamily = css["font-family"];
  const fontWeight = css["font-weight"];
  const fontSize = css["font-size"];
  const lineHeight = css["line-height"];
  const letterSpacing = css["letter-spacing"];
  const fill = color?.fills?.[0];
  const parts: string[] = [];

  if (fontFamily) {
    parts.push(fontFamily);
  }
  if (fontWeight) {
    parts.push(fontWeight);
  }
  if (fontSize && lineHeight) {
    parts.push(`${fontSize}/${lineHeight}`);
  } else if (fontSize) {
    parts.push(fontSize);
  }
  if (letterSpacing) {
    parts.push(`ls ${letterSpacing}`);
  }
  if (fill) {
    parts.push(`fill ${fill}`);
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function findUnplacedTexts(lookups: LookupTables): FigTextNode[] {
  const result: FigTextNode[] = [];
  for (const text of lookups.texts.values()) {
    if (!lookups.visitedTextIds.has(text.id)) {
      result.push(text);
    }
  }
  return result;
}

async function readStyles(
  file: string,
  ids: string[],
): Promise<FigStylesResult> {
  const nodes: FigStyleNode[] = [];
  for (const chunk of chunkIds(ids)) {
    nodes.push(...await readStylesChunk(file, chunk));
  }
  return { count: nodes.length, nodes };
}

async function readStylesChunk(
  file: string,
  ids: string[],
): Promise<FigStyleNode[]> {
  if (ids.length === 0) {
    return [];
  }

  try {
    const result = await runFigJson<FigStylesResult | FigStyleNode>([
      "styles",
      file,
      "--node-ids",
      ids.join(","),
      "--format",
      "json",
    ]);
    return normalizeStyles(result);
  } catch (error) {
    if (ids.length === 1) {
      console.warn(
        `Skipping styles for ${ids[0]}: ${messageFromUnknown(error)}`,
      );
      return [];
    }

    const middle = Math.floor(ids.length / 2);
    return [
      ...await readStylesChunk(file, ids.slice(0, middle)),
      ...await readStylesChunk(file, ids.slice(middle)),
    ];
  }
}

async function runFigJson<T>(args: string[]): Promise<T> {
  const output = await new Deno.Command("fig", { args }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    throw new Error(stderr.trim() || stdout.trim() || `fig ${args[0]} failed`);
  }
  return JSON.parse(stdout) as T;
}

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let length = 0;

  for (const id of ids) {
    const nextLength = length + id.length + 1;
    if (chunk.length > 0 && (chunk.length >= 80 || nextLength > 6_000)) {
      chunks.push(chunk);
      chunk = [];
      length = 0;
    }
    chunk.push(id);
    length += id.length + 1;
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function visitTree(node: TreeNode, visitor: (node: TreeNode) => void) {
  visitor(node);
  for (const child of node.children ?? []) {
    visitTree(child, visitor);
  }
}

function isStyleTargetType(type: string): boolean {
  return [
    "FRAME",
    "GROUP",
    "SECTION",
    "COMPONENT",
    "COMPONENT_SET",
    "INSTANCE",
    "TEXT",
  ].includes(type);
}

function formatPath(
  ancestors: Array<{ name: string }> | undefined,
  root: TreeNode,
): string | undefined {
  if (!ancestors || ancestors.length === 0) {
    return undefined;
  }
  return [
    ...ancestors.map((ancestor) => ancestor.name.replaceAll("\b", "")),
    root.name,
  ].join(" > ");
}

function truncateOneLine(text: string, maxLength: number): string {
  const oneLine = text.replaceAll(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function parseTextLength(value: string | undefined): number {
  if (!value) {
    return MAX_TEXT_LENGTH;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 10) {
    throw new Error("--text-length must be an integer >= 10");
  }
  return parsed;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(3)));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  console.info(`Usage:
  deno run --allow-run=fig --allow-write source/skills/figma/scripts/annotated_tree.ts <file-or-url> --node-id <id> [--output report.md]

Options:
  --node-id, -n       Root node ID
  --text-length       Max inline leaf text length. Defaults to ${MAX_TEXT_LENGTH}.
  --output, -o        Write markdown report to a file instead of stdout
`);
}
