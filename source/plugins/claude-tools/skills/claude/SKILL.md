---
name: claude
description: 코드 작성자, 조율자, 맥락 조사자로 특화된 Claude(클로드) 호출. 도구 사용이 가능하니 사전 조사보다 배경과 맥락을 건네주고 위임.
allowed-tools: Bash(claude *) Bash(openssl rand -hex 4) Bash(jq *) Read(/tmp/*)
---

작업 디렉토리의 CLAUDE.md 맥락을 공유하는 중첩 Claude Code
프로세스(서브에이전트) 실행.

## 사용 케이스

- 기존 코드 구조와 일관성 있는 코드 작성 시
- 여러 에이전트 조율 시

## 사용법

긴 프롬프트나 여러 줄 프롬프트는 `- <<'EOF' ... EOF` 형식으로 stdin에 전달. 짧은
단문 프롬프트만 argv 위치 인자로 전달.

```shell
# 1. 출력 파일명 생성 (별도 Bash 호출)
openssl rand -hex 4
# → e.g. a1b2c3d4

# 2. 첫 실행 (리터럴 경로)
claude -p --verbose --output-format stream-json --effort high '--disallowedTools=Skill(codex)' "Implement scratch" >/tmp/a1b2c3d4.jsonl 2>/tmp/a1b2c3d4.log

# 3. 세션 ID, 응답, 모델별 USD 비용 추출
jq -r 'select(.type == "result") | .session_id, .result, ({modelUsd: ((.modelUsage // {}) | with_entries(.value = (.value.costUSD // 0)))} | @json)' /tmp/a1b2c3d4.jsonl

# 4. 세션 재개 + stream-json (리터럴 경로 + heredoc)
claude -p --verbose --output-format stream-json --effort high '--disallowedTools=Skill(codex)' --resume sess_abc123 - <<'EOF' >/tmp/a1b2c3d4b.jsonl 2>>/tmp/a1b2c3d4.log
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

`stream-json`은 `--verbose`와 함께 사용하며 JSON Lines로 저장. 최종 `result`
이벤트에서 세션 ID, 응답, 비용 추출.

## 로깅

- 실행 전 `openssl rand -hex 4`로 고유 출력/로그 파일명 생성
- stderr는 첫 호출에서 `2>`, 같은 로그를 쓰는 재개 호출에서 `2>>`로 캡처
- 실패, 예상치 못한 동작, 또는 명시적 요청 시 로그 파일 확인
- `result`가 `null`이면 `.subtype`과 stderr 로그 확인
- 세션 재개 시 출력 파일은 덮어쓰지 않도록 suffix 변경 (`a1b2c3d4b.jsonl` 등)
- jq로 `result` 이벤트의 세션 ID와 모델별 비용 확인

## 타임아웃

- `claude -p` 호출 후 무출력이어도 최소 20분 대기
- 20분 전에는 `kill`, 재시도, permission mode 변경, 대체 위임 금지
- 대기 중엔 output/log 파일 크기 확인, stderr tail, 프로세스 생존 확인 같은 읽기
  작업 허용
- 20분 후에도 output/log가 비어 있고 프로세스가 살아 있으면 사용자에게 상황을
  보고한 뒤 재시도 여부 결정
- 사용자가 명시적으로 중단하거나, 프로세스가 종료되었거나, 명확한 에러가 출력된
  경우만 위 대기 규칙의 예외로 함

## 플래그 예시

- `--effort <level>`: `max`(계획), `high`(구현, 리뷰), `medium`
- `--permission-mode <mode>`
  - `acceptEdits`: 보호된 디렉토리를 제외한 파일 읽기 및 편집 (별도 지시 없을 시
    기본)
  - `bypassPermissions`: 보호된 디렉토리 쓰기를 제외한 모든 작업
  - `default`: 파일 읽기
- `'--allowedTools=Bash(git diff)'`: 허용 도구 목록
- `'--disallowedTools=Skill(codex)'`: Codex에서 재귀 호출 방지 차원 항상 포함
- `--add-dir <path>`: 추가 디렉토리 접근 허용
- `--resume <session_id>`: 세션 재개

## 호출 시 판단 항목

1. 서브에이전트가 적합한 작업 범위인지
2. 병렬화 가능한지
3. 위험도에 따른 permission mode, 모델, effort 수준
