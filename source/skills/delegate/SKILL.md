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
- 본문은 표준 입력 또는 `--prompt-file`
  - `\n` 이스케이프 대신 실제 개행
- 클로드 호출자는 스크래치패드 경로 UUID를 `--caller-id`로 전달

# 위임 명령

- 일반 위임은 아래 스크립트만 사용
  - `herdr agent start/prompt/read` 직접 조립은 delegate 디버깅 같은 예외에만
- 여러 위임은 순차 시작
  - herdr 전송은 동시 시작 시 pane 충돌

```sh
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts prompt --help

# 새 동기 작업
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts prompt \
  --agent codex --permission read-only <<'PROMPT'
<역할, 맥락, 작업, 종료 조건>
PROMPT

# 새 작업을 분리하고 나중에 회수
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts prompt \
  --agent claude --permission write --detach <<'PROMPT'
<역할, 맥락, 작업, 종료 조건>
PROMPT
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts wait <SESSION_ID>

# 같은 대화에 작업 중 또는 종료 뒤 후속 요청
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts prompt <SESSION_ID> <<'PROMPT'
<변경점, 후속 작업, 종료 조건>
PROMPT
```

# 세션 확인과 정리

```sh
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts status <SESSION_ID>
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts wait <SESSION_ID> --timeout 20m
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts logs <SESSION_ID> --lines 200
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts close <SESSION_ID>
```

- 공개 식별자는 코덱스·클로드 네이티브 세션 ID 하나
- `status`의 `blocked`는 관찰 성공
  - `prompt`·`wait`의 `agent_blocked`는 사용자 입력 필요
- 종료된 세션을 `--permission write`로 재개 시 `--confirm-escalation` 필요
- 실행 중 세션의 권한·모델·추론 강도는 후속 prompt로 변경 불가
- 작업 중 수동 프롬프트 허용
  - 동기 `prompt`·`wait`는 관찰된 사람 프롬프트가 모두 끝난 뒤 정리
- `logs`는 pane 화면이 아닌 네이티브 JSONL의 사람·최종 어시스턴트 대화 렌더
  - `result`는 전체, `--lines`는 마지막 N줄
  - pane 종료 뒤 사용 가능

# 자동 정리와 복구

- 새 관리 탭의 root pane 또는 새로 분할한 관리 pane에서 `agent start`가 정확히
  `agent target pane <pane-id> is not an available shell`로 실패하면 100ms 뒤
  같은 시작을 한 번만 재시도
  - 기존 빈 관리 pane과 다른 시작 오류는 재시도하지 않음
  - 재시도한 호출의 YAML에는 첫 실패를 `retry.reason`으로, 재시도 단계 결과를
    `retry.result: success | failed`로 반환
  - `success`는 start 재시도가 회복됐다는 뜻이며 후속 prompt·session 확인·wait의
    최종 성공과는 별개. 후속 오류가 생겨도 회복 기록 유지
  - 100ms 대기 또는 두 번째 시작 중 중단·실패는 `failed`; 최종 원인은 기존
    최상위 `error`에 반환
  - 100ms 대기와 두 번째 `agent start --timeout 30000` 실행 시간은 delegate 전체
    timeout의 엄격한 상한 밖일 수 있음
  - 현재 Herdr 전용 오류 코드가 없어 정확한 문구로 판별. Herdr가 문구를 바꾸면
    준비 경합이어도 재시도·`retry` 기록이 생기지 않으며, 전용 구조화 오류 코드나
    pane 생성의 셸 준비 보장이 제공되면 이 판별 제거
- 동기 `prompt`·분리 작업 `wait` 성공 시 관리 pane과 빈 관리 탭 자동 정리
  - 수동 프롬프트 여부 무관
  - 대화는 네이티브 JSONL에 남아 다음 `prompt <SESSION_ID>`가 새 pane에서 재개
  - pane 보존은 `--detach`만 가능
- 다른 pane이 작업 중이거나 활성 확인 불가면 정리 보류
  - `tab_close_blocked` 경고와 방해 pane 목록 반환
  - 다른 pane 자동 취소·이동·종료 없음
- 정리 실패는 주 작업 결과에 영향 없음
  - `cleanup_failed` 경고만 반환
- 관리 탭 이름은 호출자 네이티브 세션 ID
  - 변경 시 관리 제외, `unmanaged_tab` 경고
  - 복구는 이름을 되돌린 뒤 `close`

# 표시 이름

- `--name`은 Herdr 에이전트 이름이 아닌 네이티브 세션 표시 이름
- 클로드: 새 시작·종료 뒤 재개 시 `<caller-id> <name>` 시작 옵션
  - 실행 중 클로드 불가
- 코덱스: 완료 뒤 `/rename` 가능한 범위에서 전송
  - 분리 작업은 후속 `wait`에 같은 `--name` 재전달
  - 실패해도 결과·경고 없음
