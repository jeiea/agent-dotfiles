---
name: list-project-view-items
description: 깃헙 조직 프로젝트 뷰 URL의 필터·슬라이스·단일선택 정렬을 반영해 항목 순서 조회 시 사용
allowed-tools: Bash(deno run *) Bash(mise exec -- deno run *)
---

다음 명령으로 조회

```sh
deno run --allow-run=gh {SKILL_BASE_DIR}/scripts/list_project_view_items.ts \
  '<PROJECT_VIEW_URL>' [--limit <COUNT>]
```

- 저장된 뷰 설정과 URL의 `filterQuery`·`query`·`sliceBy`·`sortedBy` 반영
- 프로젝트·조직 이슈의 단일선택 필드 정렬 지원
- 같은 정렬 값에서는 프로젝트 항목 상대 순서 유지
  - 화면의 동률 순서와 다를 수 있음
- 필드 없는 `sliceBy[value]`, 다중·비단일선택 정렬 등은 추정 없이 오류 보고
- 출력: `position`, `sortField`, `sortValue`, 이슈 번호·제목·URL JSON 배열
