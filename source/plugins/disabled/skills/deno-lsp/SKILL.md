---
name: deno-lsp
allowed-tools: Bash(deno run:*)
description: Deno LSP로 타입 정보, 진단, 정의 이동 제공
---

Deno LSP 서버와 통신하여 코드 분석 정보를 제공합니다.

## 사용법

### 타입 정보 (hover)

```bash
deno run -A ~/.claude/skills/deno-lsp/lsp-client.ts hover <파일경로> <줄> <열>
```

심볼의 타입, JSDoc 등 정보를 반환합니다.

### 진단 (diagnostics)

```bash
deno run -A ~/.claude/skills/deno-lsp/lsp-client.ts diagnostics <파일경로>
```

파일의 에러, 경고 등을 반환합니다.

### 정의 이동 (definition)

```bash
deno run -A ~/.claude/skills/deno-lsp/lsp-client.ts definition <파일경로> <줄> <열>
```

심볼의 정의 위치를 반환합니다.

## 참고

- 줄/열은 1-based index
- 프로젝트 루트는 deno.json(c) 위치로 자동 감지
