---
name: claude
description: 프론트엔드 코드 작성, 조율자, 맥락 조사자로 특화된 Claude(클로드) 호출. 도구 사용이 가능하니 사전 조사보다 배경과 맥락을 건네주고 위임. herdr 환경에선 herdr 스킬 의존.
allowed-tools: Bash(claude *) Bash(openssl rand -hex 4) Bash(jq *) Bash(herdr *) Skill(herdr) Read(/tmp/*)
---

작업 디렉토리의 `CLAUDE.md` 맥락을 공유하는 중첩 Claude Code 실행

# herdr에서 새로 호출

`test "${HERDR_ENV:-}" = 1`이면 herdr 스킬에 따라 pane 생성 후 실행:

```sh
herdr agent start <name> --kind claude --pane <pane_id> -- \
  --model best --effort high --permission-mode dontAsk \
  --name "<호출자 세션 ID> <위임 목적>" \
  '--disallowedTools=Skill(codex-tools:codex)'
herdr agent prompt <name> "$(cat <<'PROMPT'
<역할, 맥락, 작업, 종료 조건>
PROMPT
)" --wait --timeout 1200000
herdr agent read <name> --source recent-unwrapped --lines 120
```

- 모델·추론 강도·권한·도구·경로·이름 플래그는 작업에 맞게 조정
- 호출자 세션 ID: `$CODEX_THREAD_ID`, 클로드는 스크래치패드 경로의 UUID
- pane 선택·생성, 상태 처리, 결과 회수, 정리는 herdr 스킬 적용

# 비herdr에서 새로 호출

```sh
# 출력 파일명 생성
openssl rand -hex 4
# → a1b2c3d4

claude -p --model best --verbose --output-format stream-json --effort high \
  --permission-mode dontAsk \
  --name "<호출자 세션 ID> <위임 목적>" \
  '--disallowedTools=Skill(codex-tools:codex)' - <<'PROMPT' \
  >/tmp/a1b2c3d4.jsonl 2>/tmp/a1b2c3d4.log
<역할, 맥락, 작업, 종료 조건>
PROMPT

jq -r 'select(.type == "result") | .session_id, .result, ({modelUsd: ((.modelUsage // {}) | with_entries(.value = (.value.costUSD // 0)))} | @json)' \
  /tmp/a1b2c3d4.jsonl
```

- 짧은 단문만 argv 전달. 긴 문장과 여러 줄은 stdin 사용

# 비herdr 세션 재개

조금이라도 이전 호출과 관련 있으면 새 호출 대신 재개:

```sh
claude -p --model best --verbose --output-format stream-json --effort high \
  --permission-mode dontAsk \
  '--disallowedTools=Skill(codex-tools:codex)' --resume <session_id> - \
  <<'PROMPT' >/tmp/a1b2c3d4b.jsonl 2>>/tmp/a1b2c3d4.log
A 작업을 완료했습니다.
결과를 검토하세요.
PROMPT

jq -r 'select(.type == "result") | .session_id, .result, ({modelUsd: ((.modelUsage // {}) | with_entries(.value = (.value.costUSD // 0)))} | @json)' \
  /tmp/a1b2c3d4b.jsonl
```

- 재개 출력은 덮어쓰지 않도록 접미사 변경

# 프롬프트 작성

- `\n` 이스케이프 대신 실제 개행 사용
- 종속 세션에는 재귀 호출 방지용 금지 스킬 명시
- 호출자의 도구로 획득한 접근 거부 가능한 정보와 실행 결과 전달

# 플래그 선택

```text
--model best                         우선 사용; 사용량 오류면 opus로 같은 요청 재시도
--effort xhigh                       계획
--effort high                        구현·검토
--permission-mode dontAsk            사전 허용 도구만 실행
--permission-mode bypassPermissions  격리된 쓰기 작업
--allowedTools=<tools>               추가 허용 도구
--disallowedTools=<tools>            금지 도구
--add-dir <path>                     추가 디렉토리
--name <name>                        <호출자 세션 ID> <위임 목적>
```

- `dontAsk`에서 웹 조사 시 `'--allowedTools=WebSearch,WebFetch(domain:*)'` 추가
- `bypassPermissions`는 컨테이너·VM 등 격리 환경에서만 사용

# 결과·오류 처리

- `result` 이벤트 또는 프로세스 종료까지 대기
- 10분간 새 이벤트 없이 프로세스가 살아 있으면 마지막 이벤트와 stderr 보고 후
  재시도 여부 확인
- `result`가 `null`이면 `.subtype`과 stderr 확인
- 사용자 중단·프로세스 종료·명확한 오류 외에는 강제 종료, 재시도, 권한 변경,
  대체 위임 금지
- 로그는 실패, 예상 밖 동작, 명시적 요청 때만 확인
