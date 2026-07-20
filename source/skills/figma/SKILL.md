---
name: figma
description: Read-only Figma REST API workflows for file inspection, audits, token extraction, typography analysis, component listing, asset export, comment retrieval, text extraction, text search, node style inspection, node diffing, and combined node inspection. Use when a user provides a Figma file key or URL and needs implementation-facing design data without opening Figma manually.
---

# Figma CLI

Use the local `fig` command for fast Figma analysis and exports.

Use an EAFP workflow: run the most direct `fig ...` command for the task first,
then recover from errors if the command fails. Do not spend a turn pre-checking
installation, auth, or every flag when the intended command can reveal the exact
problem.

## Core command picker

- Need a screenshot: `fig export`
- Need copy text: `fig text`
- Need CSS-like values (resolved instance values): `fig styles`
- Need resolved fill/stroke colors fast: `fig colors`
- Need one-shot implementation details: `fig inspect`
- Need hierarchy/tree: `fig tree`
- Need feedback threads: `fig comments`
- Need to find where text appears: `fig search`
- Need to compare before/after nodes: `fig diff`
- Need file-level metadata/pages: `fig info` (no `--node-id`)
- Need design-system health checks: `fig audit`
- Need typography inventory: `fig typography`
- Need design tokens: `fig tokens`
- Need component inventory: `fig components`
- Need quick summary: `fig quick`
- Need tree with changed properties and leaf text: `scripts/annotated_tree.ts`

## User intention

Match Figma at node level, not just approximate visual style. Compare and
implement typography/font weight, added or removed nodes, dividers, spacing, and
conditional elements. Remove existing UI nodes that are not present in Figma,
and add Figma-visible structural nodes such as 1px dividers as real DOM/CSS
elements.

## Use URL or file key directly

Every command accepts either:

- file key: `5264IJYvl05aFGo7uC5X7G`
- full URL: `https://www.figma.com/design/5264IJYvl05aFGo7uC5X7G/...`

## Most useful workflows

### 1) Comments -> implementation

```bash
fig comments <file-or-url> --unresolved
fig inspect <file-or-url> --node-id <node-id-from-comment>
fig export <file-or-url> --node-ids <same-node-id> --format png --retina
```

Why: `comments` gives feedback, `inspect` gives code-ready details, `export`
gives visual confirmation.

### 2) Copy change only

```bash
fig text <file-or-url> --node-id <node-id>
```

Why: this is copy/pasteable text. PNG export is not.

### 3) Exact spacing, padding, radius, colors for one element

```bash
fig styles <file-or-url> --node-id 2039-16736
```

### 3b) Exact spacing/colors for multiple elements at once

```bash
fig styles <file-or-url> --node-ids 2039:16736,2039:6114,2039:6200
```

### 3c) Resolved fills/strokes for one node and children

```bash
fig colors <file-or-url> --node-id 2039:16736
fig colors <file-or-url> --node-id 2039:16700 --depth 2
```

### 4) Find all nodes containing phrase, then inspect one

```bash
fig search <file-or-url> --text "Shortened copy"
fig inspect <file-or-url> --node-id <match-node-id>
fig inspect <file-or-url> --node-id <match-node-id> --deep
fig inspect <file-or-url> --node-id <match-node-id> --recursive 2
```

### 5) Compare two versions of a node

```bash
fig diff <file-or-url> --node-ids 2039:16736,2039:6114
```

### 6) Layout replication (hierarchy -> styles -> export)

```bash
fig tree <file-or-url> --node-id 2039-16700 --depth 3
fig styles <file-or-url> --node-ids 2039:16701,2039:16702,2039:16703
fig export <file-or-url> --node-ids 2039:16700 --format png --retina
```

Optional close-up crop:

```bash
fig export <file-or-url> --node-ids 2039:16700 --format png --crop 0,0,800,120
```

### 7) Annotated tree for implementation

When the user gives a node ID and wants to understand everything relevant
without re-querying child frames, prefer the bundled annotated tree script.

Basic usage:

```bash
deno run --allow-run=fig --allow-write source/skills/figma/scripts/annotated_tree.ts \
  <file-or-url> \
  --node-id <node-id> \
  --output scratch.local.md
```

Options:

- `--node-id`, `-n`: root node ID to inspect.
- `--output`, `-o`: markdown output path. Use `scratch.local.md` for temporary
  local analysis.
- `--text-length`: max inline leaf text length. Defaults to `120`.

Output shape:

```txt
<node-id> <name> <type>
  size <width>x<height>
  layout <direction> <horizontal-sizing>/<vertical-sizing> align <...>
  space gap <...>, padding <...>
  paint bg <...> / fills <...> / strokes <...>
  text [T1] "leaf text"
```

Why: it combines `tree`, `styles`, `colors`, and `text` into one
implementation-facing tree. Each node shows changed `size`, `layout`, `space`,
and `paint`; text is attached to leaf text nodes. Text nodes reference a
deduplicated `## Text Styles` registry such as `text [T4] "Headline"` so
repeated font styles do not bloat the tree.

Small vector-only instances or `.svg` frames are collapsed as `asset svg/icon`
instead of expanding their internal vector paths. The script keeps the asset
name, size, and summarized colors.

Manual fallback:

```bash
fig tree <file-or-url> --node-id <node-id> --depth 4 --format json
fig inspect <file-or-url> --node-id <node-id> --recursive 3 --format json
fig styles <file-or-url> --node-ids <root-and-key-child-ids> --format json
fig colors <file-or-url> --node-id <node-id> --depth 4 --format json
fig text <file-or-url> --node-id <node-id> --format json
```

## Scope rules (important)

- `--node-id` works on: `audit`, `typography`, `comments`, `text`, `search`,
  `styles`, `colors`, `inspect`, `tree`
- `--node-ids` works on: `export`, `diff`, `styles`
- `--page` works on: `info`, `audit`, `comments`, `text`, `search`,
  `components`, `tree`
- `fig info` does not support `--node-id`
- For `text` and `search`, use `--node-id` or `--page`, not both
- `--page` does not work on: `styles`, `inspect`, `export`, `diff`, `tokens`,
  `typography`
- `--crop` works only on `export` with `--format png`

## Node ID format tips

- Both formats are accepted: `2005-5651` and `2005:5651`
- `diff` needs two IDs separated by comma: `--node-ids 2005:5651,2005:6000`

## JSON-friendly examples

```bash
fig comments <file-or-url> --unresolved --format json
fig inspect <file-or-url> --node-id 2039-16736 --format json
fig styles <file-or-url> --node-id 2039-16736 --format json
fig styles <file-or-url> --node-ids 2039:16736,2039:6114 --format json
fig colors <file-or-url> --node-id 2039:16700 --depth 2 --format json
fig tree <file-or-url> --node-id 2039:16700 --depth 3 --format json
fig diff <file-or-url> --node-ids 2039:16736,2039:6114 --format json
```

## Node discovery fallback

- Preferred: `fig tree <file-or-url> --node-id <id> --depth 3`
- If tree output is unavailable, node IDs are often near each other. Example
  fallback pattern: `fig inspect <file-or-url> --node-id 2070:20929` then try
  `2070:20930`, `2070:20931`, etc.

## `fig info --page` behavior

- `fig info <file-or-url> --page "<name>"` now lists top-level items on that
  page with IDs and types, not just count.

## `fig styles` sample output

```css
.figma-node-2039-16736 {
  width: 160px;
  height: 48px;
  padding: 12px 20px 12px 20px;
  border-radius: 8px;
  background-color: #0d6efd;
  font-size: 16px;
}
```

## Error handling and recovery

Handle errors after trying the direct command.

- `fig: command not found`, `command not found: fig`, or similar missing binary
  error: tell the user to install the CLI with
  `pnpm add -g @iannuttall/figma-cli`, then retry the original `fig ...`
  command.
- `FIGMA_TOKEN is not configured`: tell the user to run:

  ```bash
  fig auth
  source ~/.zshrc
  ```

  Then retry the original `fig ...` command.
- `Node <id> not found`: confirm the node ID from `fig comments`, `fig search`,
  or Figma inspect panel.
- `unknown option --node-id` on `fig info`: expected; `info` is file/page level
  only.
- Unknown or changed flags: inspect the command-specific help, then retry with
  the corrected flag.

  ```bash
  fig <command> --help
  ```
