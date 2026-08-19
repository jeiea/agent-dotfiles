---
name: claude
description: 프론트엔드 코드 작성, 조율자, 맥락 조사자로 특화된 Claude(클로드) 호출. 도구 사용이 가능하니 사전 조사보다 배경과 맥락을 건네주고 위임.
allowed-tools: Bash(claude *) Bash(openssl rand -hex 4) Bash(jq *) Bash(herdr *) Skill(herdr) Read(/tmp/*)
---

작업 디렉토리의 CLAUDE.md 맥락을 공유하는 중첩 Claude Code
프로세스(서브에이전트) 실행

`test "${HERDR_ENV:-}" = 1`이면 herdr 환경, 아니면 비herdr 환경. 공통 항목은 둘
다 적용, 비herdr 절차는 herdr 환경에서 미사용.

## 사용 케이스

- 현재 세션에 편향되지 않은 새 관점 필요 시
- 프론트엔드 시각적 코드 작성 시

## 공통

### 프롬프트 내용

- `\n` 이스케이프 금지. 셸 인자에서 리터럴 `\n`으로 전달되므로 여러 줄은 실제
  개행(heredoc, quoted 개행)으로 작성
- 역할, 종료 조건 명확히 기술
- 가용 도구 차이가 있을 수 있어 도구에서만 얻을 수 있는 맥락은 최대한 전달. 가령
  Claude 쪽 권한 또는 도구 제한으로 테스트를 실행할 수 없다면 테스트 직접 실행
  결과 첨부

### 플래그

- `--model <model>`: `best` 우선. 사용량 오류 시 `opus`로 원래 요청 그대로
  재시도
- `--effort <level>`: `xhigh`(계획), `high`(구현, 리뷰), `medium`
- `--permission-mode <mode>`
  - `dontAsk`: 읽기만 필요 시. Read·Glob·Grep·읽기 전용 Bash 기본 허용, 그 외
    프롬프트 대상 자동 거부. 웹 조사 시
    `'--allowedTools=WebSearch,WebFetch(domain:*)'` 추가
  - `bypassPermissions`: 쓰기 필요 시
- `'--allowedTools=Bash(git diff)'`: 허용 도구 목록
- `'--disallowedTools=Skill(codex-tools:codex)'`: 종속 세션, 즉 결과를 기다리는
  세션인 경우 스킬 재귀 사용, 서브에이전트 무한 포크 방지를 위해 포함
- `--add-dir <path>`: 추가 디렉토리 접근 허용
- `--resume <session_id>`: 세션 재개

### 호출 시 판단 항목

1. 위험도에 따른 권한, effort 수준
2. 메인 세션 또는 서브 세션 병렬 진행 가능성

## herdr 환경

- `herdr` 스킬 지침대로 herdr pane/agent에서 중첩 실행
- `herdr agent start ... --` 뒤에 위 모델·effort·권한·도구·경로 플래그를 동일
  기준으로 선택해 전달
- 프롬프트 전달, 로깅, 대기, 결과 회수, 세션 관리는 herdr에 위임

## 비herdr 절차

- 긴 프롬프트나 여러 줄 프롬프트는 `- <<'EOF' ... EOF` 형식으로 stdin에 전달.
  짧은 단문 프롬프트만 argv 위치 인자로 전달
- 조금이라도 이전 호출과 관련있으면 해당 세션 ID 재사용. 완전히 새 관점이 필요한
  경우만 예외
- `stream-json`은 `--verbose`와 함께 사용하며 jsonl로 저장. 최종 `result`
  이벤트에서 세션 ID, 응답, 비용 추출

```sh
# 1. 출력 파일명 생성 (별도 Bash 호출)
openssl rand -hex 4
# → e.g. a1b2c3d4

# 2. 첫 실행 (리터럴 경로)
claude -p --model best --verbose --output-format stream-json --effort high '--disallowedTools=Skill(codex-tools:codex)' "Implement scratch" >/tmp/a1b2c3d4.jsonl 2>/tmp/a1b2c3d4.log

# 3. 세션 ID, 응답, 모델별 USD 비용 추출
jq -r 'select(.type == "result") | .session_id, .result, ({modelUsd: ((.modelUsage // {}) | with_entries(.value = (.value.costUSD // 0)))} | @json)' /tmp/a1b2c3d4.jsonl

# 4. 세션 재개 + stream-json (리터럴 경로 + heredoc)
claude -p --model best --verbose --output-format stream-json --effort high '--disallowedTools=Skill(codex-tools:codex)' --resume sess_abc123 - <<'EOF' >/tmp/a1b2c3d4b.jsonl 2>>/tmp/a1b2c3d4.log
Reflect follow-ups.
Append suggestions.
EOF
jq -r 'select(.type == "result") | .session_id, .result, ({modelUsd: ((.modelUsage // {}) | with_entries(.value = (.value.costUSD // 0)))} | @json)' /tmp/a1b2c3d4b.jsonl
```

### 로깅

- 실행 전 `openssl rand -hex 4`로 고유 출력/로그 파일명 생성
- stderr는 첫 호출에서 `2>`, 같은 로그를 쓰는 재개 호출에서 `2>>`로 캡처
- 실패, 예상치 못한 동작, 또는 명시적 요청 시 로그 파일 확인
- `result`가 `null`이면 `.subtype`과 stderr 로그 확인
- 세션 재개 시 출력 파일은 덮어쓰지 않도록 suffix 변경 (`a1b2c3d4b.jsonl` 등)
- jq로 `result` 이벤트의 세션 ID와 모델별 비용 확인

### 타임아웃

- `result` 이벤트 또는 프로세스 종료까지 대기
- 10분 동안 새 이벤트가 없고 프로세스가 살아 있으면 마지막 이벤트와 stderr를
  유저에게 보고하고 재시도 여부 확인
- 사용자 중단, 프로세스 종료, 명확한 에러 외에는 `kill`, 재시도, permission mode
  변경, 대체 위임 금지
