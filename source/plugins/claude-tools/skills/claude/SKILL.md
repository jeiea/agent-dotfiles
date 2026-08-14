---
name: claude
description: 프론트엔드 코드 작성, 조율자, 맥락 조사자로 특화된 Claude(클로드) 호출. 도구 사용이 가능하니 사전 조사보다 배경과 맥락을 건네주고 위임.
allowed-tools: Bash(claude *) Bash(openssl rand -hex 4) Bash(jq *) Bash(herdr *) Read(/tmp/*)
---

작업 디렉토리의 CLAUDE.md 맥락을 공유하는 중첩 Claude Code
프로세스(서브에이전트) 실행.

## 사용 케이스

- 현재 세션에 편향되지 않은 새 관점 필요 시
- 프론트엔드 시각적 코드 작성 시

## herdr 환경

- `test "${HERDR_ENV:-}" = 1`이면 `herdr --skill` 확인 후 그 지침대로 herdr
  pane/agent에서 중첩 실행
- `herdr agent start ... --` 뒤에도 후술 모델·effort·권한·도구·경로 플래그를
  동일 기준으로 선택해 전달
- 로깅·세션 관리도 herdr에 위임. 플래그 판단 외 이하 절차는 비herdr 환경 기준

## 사용법

긴 프롬프트나 여러 줄 프롬프트는 `- <<'EOF' ... EOF` 형식으로 stdin에 전달. 짧은
단문 프롬프트만 argv 위치 인자로 전달.

```shell
# 1. 출력 파일명 생성 (별도 Bash 호출)
openssl rand -hex 4
# → e.g. a1b2c3d4

# 2. 첫 실행 (리터럴 경로)
claude -p --model best --verbose --output-format stream-json --effort high '--disallowedTools=Skill(codex),Skill(codex-tools:codex)' "Implement scratch" >/tmp/a1b2c3d4.jsonl 2>/tmp/a1b2c3d4.log

# 3. 세션 ID, 응답, 모델별 USD 비용 추출
jq -r 'select(.type == "result") | .session_id, .result, ({modelUsd: ((.modelUsage // {}) | with_entries(.value = (.value.costUSD // 0)))} | @json)' /tmp/a1b2c3d4.jsonl

# 4. 세션 재개 + stream-json (리터럴 경로 + heredoc)
claude -p --model best --verbose --output-format stream-json --effort high '--disallowedTools=Skill(codex),Skill(codex-tools:codex)' --resume sess_abc123 - <<'EOF' >/tmp/a1b2c3d4b.jsonl 2>>/tmp/a1b2c3d4.log
Reflect follow-ups.
Append suggestions.
EOF
jq -r 'select(.type == "result") | .session_id, .result, ({modelUsd: ((.modelUsage // {}) | with_entries(.value = (.value.costUSD // 0)))} | @json)' /tmp/a1b2c3d4b.jsonl
```

가용 도구 차이가 있을 수 있어 도구에서만 얻을 수 있는 맥락은 최대한 전달. 가령
Claude 쪽 권한 또는 도구 제한으로 테스트를 실행할 수 없다면 테스트 직접 실행
결과 첨부.

조금이라도 이전 호출과 관련있으면 해당 세션 ID 재사용. 완전히 새 관점이 필요한
경우만 예외.

`stream-json`은 `--verbose`와 함께 사용하며 jsonl로 저장. 최종 `result`
이벤트에서 세션 ID, 응답, 비용 추출.

## 로깅

- 실행 전 `openssl rand -hex 4`로 고유 출력/로그 파일명 생성
- stderr는 첫 호출에서 `2>`, 같은 로그를 쓰는 재개 호출에서 `2>>`로 캡처
- 실패, 예상치 못한 동작, 또는 명시적 요청 시 로그 파일 확인
- `result`가 `null`이면 `.subtype`과 stderr 로그 확인
- 세션 재개 시 출력 파일은 덮어쓰지 않도록 suffix 변경 (`a1b2c3d4b.jsonl` 등)
- jq로 `result` 이벤트의 세션 ID와 모델별 비용 확인

## 타임아웃

- `result` 이벤트 또는 프로세스 종료까지 대기
- 10분 동안 새 이벤트가 없고 프로세스가 살아 있으면 마지막 이벤트와 stderr를
  유저에게 보고하고 재시도 여부 확인
- 사용자 중단, 프로세스 종료, 명확한 에러 외에는 `kill`, 재시도, permission mode
  변경, 대체 위임 금지

## 플래그

- `--model <model>`: `best` 우선. 사용량 오류 시 `opus`로 원래 요청 그대로
  재시도.
- `--effort <level>`: `xhigh`(계획), `high`(구현, 리뷰), `medium`
- `--permission-mode <mode>`
  - `acceptEdits`: 보호된 디렉토리를 제외한 파일 읽기 및 편집 (별도 지시 없을 시
    기본)
  - `bypassPermissions`: 보호된 디렉토리 쓰기를 제외한 모든 작업
  - `default`: 파일 읽기
- `'--allowedTools=Bash(git diff)'`: 허용 도구 목록
- `'--disallowedTools=Skill(codex),Skill(codex-tools:codex)'`: Codex에서 재귀
  호출 방지 차원 항상 포함
- `--add-dir <path>`: 추가 디렉토리 접근 허용
- `--resume <session_id>`: 세션 재개

## 호출 시 판단 항목

1. 위험도에 따른 권한, effort 수준
2. 프롬프트에 역할, 종료 조건이 명확한지
3. 메인 세션 또는 서브 세션 병렬 진행 가능성
