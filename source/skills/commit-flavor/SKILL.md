---
name: commit-flavor
description: git commit, amend 전 스킬 내용을 확인해 유저 선호 사항 확인 후 커밋
allowed-tools: Bash(git log *) Bash(git show *) Bash(git status *) Bash(git diff *) Bash(git add *) Bash(git commit *) Bash(gh * view *)
---

유저가 스킬만 언급 시 커밋하라는 의미

# 커밋 메시지 작성 시

- 최근 커밋을 확인해 양식, 언어 따르기
  - 최초 커밋이라면 `feat: add new feature` 언어와 형식으로 작성
- conventional commit 관련
  - test: 테스트 관련 부분만 수정해야 함
  - feat: 새 테스트 케이스를 추가해야 함
  - refactor: 테스트 코드 변경이 없어야 함
  - fix: 테스트와 프로덕션 코드를 둘 다 수정함 또는 그 외
  - chore: 코드 변경이 없어야 함
  - style: 저장소 린트, 스타일 규칙 변경
- 본문에 한해서
  - 제목 언어 사용
  - 섹션이 2개 이상이면 `[배경]`처럼 섹션 제목을 추가해 분리
  - 섹션
    - `배경`, `Background`
      - 피그마, 슬랙, 이슈 URL 등 근거 및 참고 자료
      - 이전 방식의 문제
    - `코멘트`, `Comment`
      - 시행착오, 유저 의도
      - 이 커밋하고만 연관된 유저 프롬프트 등
    - `검증`, `Verification`: 변경 의도와 요구사항을 검증한 방법, 명령어, 그
      결과 등
      - 요구사항 확인에 가까운 순 최대 3개
      - 린트, 타입 검사, 포맷, `git diff --check`는 생략
      - 제3자가 재현 가능해야 함
  - 전부 커밋 내용에서 알 수 있는 정보면 해당 섹션 생략
- URL은 서드파티 추적 인자가 아닌 한 해시까지도 최대한 보존
- 이슈, PR 코멘트, 슬랙 스레드 URL 같은 배경 또는 '왜'를 '무엇'보다 포함하려
  노력
  - 선호: 레이스 컨디션 방지
  - 지양: exists 제거
- 실제 변경에 기여한 것으로 확인한 모델 정보를 중복 없이 추가
  - `AI-assistant: {models}`
  - 설계, 구현, 리뷰 순으로 배치, 즉 설계한 모델을 먼저 기입
  - codex gpt는 다음 명령어로 모델 버전 확인
    `rg '^model\s*=\s*"([^"]+)"' ~/.codex/config.toml -r '$1'`

## 내용 구상 후 체크리스트

- 로컬 경로같은 민감 정보 익명화
- 중복없이 간결히 작성
- 재현성이 낮은 정보, 가령 오케스트레이션이나 유저 스킬 언급 배제

## 예시

```
feat: expand button for touch ux

- [x] `pnpm test -- src/e2e.test.ts` - pass
- [x] `pnpm exec playwright test src/e2e.test.ts --project=chromium --project=webkit` - margin change verified

AI-assistant: GPT-5.5
```

```
refactor: 임포트 맵 키 경고 해결

[배경]
--import-map에 deno.json을 넘기면 WHATWG Import Map 스펙에 없는
키(name, version, tasks 등)에 대한 경고 발생.
`- Import map: Invalid top-level key "tasks". Only "imports" and "scopes" can be present.`

[검증]
- [x] `deno run cli/main.ts` - 경고 제거 확인

AI-assistant: GPT-5.5, Opus 4.6
```

# 커밋 후

- 파워쉘 환경이면 커밋 메시지에 이스케이핑 이슈가 생겼는지 다시 확인
