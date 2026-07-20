---
name: deno-tips
description: jsr 문서 확인 방법, 신규 프로젝트 템플릿, 로컬 의존성 오버라이드 등 deno 사용 전 알아두면 좋은 방법입니다.
---

# 기타

- 의존성은 `npm:` 보다 `jsr:` 선호
- `NO_COLORS=1 deno test` 등으로 색상 문자 노이즈 제거 가능
  - PowerShell: `$env:NO_COLOR='1'; deno test; Remove-Item Env:NO_COLOR`

# 유저 선호 디노 프로젝트 템플릿

- [references/deno.json](references/deno.json),
  [references/lint-staged.config.ts](references/lint-staged.config.ts) 참고
- lint-staged 연동 후 확인:
  ```bash
  deno check lint-staged.config.ts
  deno lint lint-staged.config.ts
  deno fmt --check deno.json deno.lock lint-staged.config.ts
  deno task hooks:pre-commit
  deno task check:lint-staged
  ```

# 상황별 선호 패키지

- `jsr:@jeiea/snippets`: runGitCommand
- `jsr:@optique/run`, `jsr:@optique/core`: CLI 파서 라이브러리, @std/cli 대신
  사용

# 로컬 의존성 오버라이드

- 로컬 JSR/npm 패키지 테스트는 `deno.json`의
  [`links`](https://docs.deno.com/runtime/reference/deno_json/#overriding-packages)에
  경로를 추가해 게시 없이 의존성 대체. workspace root에서만 유효하며 대상
  패키지의 `name` 메타데이터 필요
- extends와 함께 써도 유용

# jsr

```bash
NO_COLORS=1 deno doc jsr:@scope/name # 모듈 문서 확인
NO_COLORS=1 deno doc --filter symbol jsr:@scope/name/subpath # 특정 심볼 확인
deno doc --json jsr:@scope/name/subpath | deno eval 'const d=JSON.parse(await new Response(Deno.stdin.readable).text())'
```

## 메타 파일

403이 뜰 수 있고 그 경우 deno eval fetch로 우회 가능

- 패키지 전체 버전 목록: https://jsr.io/@scope/name/meta.json
- 특정 버전의 파일 목록, 모듈 그래프, exports 맵:
  https://jsr.io/@scope/name/0.1.2_meta.json
- plain text 소스 필요 시: https://jsr.io/@scope/name/0.1.2/src/mod.ts

# 외부 스킬

`https://github.com/denoland/skills` 레포에는 Deno 기반 개발에 맞춘 Agent
Skills가 정리되어 있습니다.

- `deno-guidance`: Deno/JSR 기본 원칙
- `deno-deploy`: Deno Deploy 배포 흐름
- `deno-frontend`: Fresh/Preact/Tailwind 패턴
- `deno-sandbox`: `@deno/sandbox` 실행 가이드
- `deno-project-templates`: 템플릿 기반 시작 가이드
- `deno-expert`: 리뷰/디버깅 체크리스트
