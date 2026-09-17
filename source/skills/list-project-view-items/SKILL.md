---
name: list-project-view-items
description: 깃헙 조직 프로젝트 뷰 URL의 필터·슬라이스·Priority 정렬을 반영해 화면 순서대로 항목 조회 시 사용
allowed-tools: Bash(deno run *) Bash(mise exec -- deno run *)
---

다음 명령으로 조회

```sh
deno run --allow-run=gh {SKILL_BASE_DIR}/scripts/list_project_view_items.ts \
  '<PROJECT_VIEW_URL>' [--limit <COUNT>]
```

- `gh project item-list` 기본 순서를 뷰 정렬로 간주 금지
- 네이티브 이슈 필드인 Priority까지 조회해 옵션 순서로 정렬
- 같은 Priority에서는 프로젝트 항목 상대 순서 유지
- 지원하지 않는 필터·슬라이스·정렬은 추정하지 않고 명령 오류 보고
