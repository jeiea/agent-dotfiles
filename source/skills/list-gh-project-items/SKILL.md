---
name: list-gh-project-items
description: 깃헙 프로젝트 필터·슬라이스·단일선택 정렬을 반영해 항목 순서 조회 시 사용
allowed-tools: Bash(deno run *) Bash(mise exec -- deno run *)
---

다음 명령으로 조회

```sh
deno run --allow-run=gh {SKILL_BASE_DIR}/scripts/list_project_view_items.ts \
  '<PROJECT_VIEW_URL>' [--limit <COUNT>]
```
