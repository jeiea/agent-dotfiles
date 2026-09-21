---
name: delegate
description: 코드 탐색 외 작업의 코덱스·클로드 세션 위임, 기존 위임의 후속 요청·확인·정리, 독립 관점·다른 모델 검토 시 사용
allowed-tools: Bash(herdr *) Bash(deno run *)
---

- herdr는 터미널 멀티플렉서 CLI
  - 예외 상황 정보는 `herdr --skill` 확인

# 에이전트 선택

- 현재 세션과 다른 모델 우선
  - 다른 모델 호출 불가 또는 같은 모델 요구 시 같은 모델
  - 두 모델 모두 호출 불가 시 서브에이전트
- `--agent` 명시
  - `auto`는 프롬프트 키워드 추정이라 위 규칙 미반영
  - codex: 계획·검토·디버깅·원인 분석
  - claude: 프론트엔드 코드 작성·조율·넓은 맥락 조사
- 이전 호출과 조금이라도 관련 있으면 새 세션 대신 기존 세션에 후속 요청
- 중첩 실행은 작업 디렉터리의 `AGENTS.md`(코덱스)·`CLAUDE.md`(클로드) 맥락 공유

# 프롬프트 작성

- 선행 조사는 위임 대상에 맡기고 역할·배경·확인한 사실·작업·종료 조건 전달
  - 호출자만 접근 가능한 정보와 실행 결과 포함
  - 읽기 전용에서 불가한 검증은 결과 전달 또는 `--permission write`
- 종속 세션에 delegate 스킬 등 다른 에이전트 재위임 금지 명시
- 본문은 heredoc 표준 입력 또는 `--prompt-file`
  - `\n` 이스케이프 대신 실제 개행
  - 명령을 먼저 실행한 뒤 표준 입력을 나중에 넣으면 실패
- 클로드 호출자는 스크래치패드 경로 UUID를 `--caller-id`로 전달

# 명령

- 일반 위임은 아래 스크립트만 사용
  - `herdr agent start/prompt/read` 직접 조립은 delegate 디버깅 같은 예외에만
- 현재 codex일 경우 제한 시간 오류를 대비해 exec_command의 전체 출력·종료 상태
  확인
- 옵션 의미, 출력 필드, 오류·경고 코드 대응은 각 하위 명령 `--help`
- 식별자는 코덱스·클로드 네이티브 세션 ID
- `prompt`·`wait` 성공 시 pane 자동 정리, 대화는 남아 같은 ID로 재개
  - `close`는 중단 또는 자동 정리 실패 시

```sh
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts prompt --help

# 새 동기 작업
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts prompt \
  --agent codex --permission read-only <<'PROMPT'
<역할, 맥락, 작업, 종료 조건>
PROMPT

# 같은 대화에 작업 중 또는 종료 뒤 후속 요청
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts prompt <SESSION_ID> <<'PROMPT'
<변경점, 후속 작업, 종료 조건>
PROMPT

deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts status <SESSION_ID>
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts wait <SESSION_ID> --timeout 20m
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts logs <SESSION_ID> --lines 200
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts close <SESSION_ID>
```
