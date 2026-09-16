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
  - 프롬프트 없이 명령을 먼저 실행한 뒤 표준 입력으로 추가하면 실패
- 클로드 호출자는 스크래치패드 경로 UUID를 `--caller-id`로 전달

# 위임 명령

- 일반 위임은 아래 스크립트만 사용
  - `herdr agent start/prompt/read` 직접 조립은 delegate 디버깅 같은 예외에만
- Herdr 신규·종료 세션의 관리 pane 생성부터 prompt 제출까지와 pane 정리는
  소켓별로 직렬화
  - Herdr가 주입하는 절대 `HERDR_SOCKET_PATH` 기준
  - 소켓 옆 `.delegate-pane.lock` 파일은 남지만 OS 잠금은 프로세스 종료 시 해제

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
```

# 세션 확인과 정리

```sh
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts status <SESSION_ID>
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts wait <SESSION_ID> --timeout 20m
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts logs <SESSION_ID> --lines 200
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts close <SESSION_ID>
```

- 공개 식별자는 코덱스·클로드 네이티브 세션 ID 하나
- `close`의 pane 잠금 대기는 최대 60초이며 초과 시 `timeout` 반환
- `status`의 `blocked`는 관찰 성공
  - `prompt`·`wait`의 `agent_blocked`는 사용자 입력 필요
- 종료된 세션을 `--permission write`로 재개 시 `--confirm-escalation` 필요
- 같은 종료 세션의 동시 재개는 먼저 잠금을 얻은 호출만 진행
  - 나머지는 `live_session_ambiguous` 반환
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
  - 100ms 대기, 재시도, rename, 자동 정리는 `prompt --timeout`의 전체 상한을
    공유하며 timeout 판정 뒤 후속 Herdr 호출 없음
  - 호출자 취소와 timeout이 함께 성립하면 호출자 취소 우선
  - 각 `agent start --timeout`은 남은 전체 제한 시간과 30초 중 작은 양의 정수
  - 현재 Herdr 전용 오류 코드가 없어 정확한 문구로 판별. Herdr가 문구를 바꾸면
    준비 경합이어도 재시도·`retry` 기록이 생기지 않으며, 전용 구조화 오류 코드나
    pane 생성의 셸 준비 보장이 제공되면 이 판별 제거
- `prompt`·`wait` 성공 시 관리 pane과 빈 관리 탭 자동 정리
  - 수동 프롬프트 여부 무관
  - 대화는 네이티브 JSONL에 남아 다음 `prompt <SESSION_ID>`가 새 pane에서 재개
- `agent start` 또는 최초 `agent prompt` 실패 시 이번 호출이 만든 pane만
  best-effort로 정리하고, 새 탭이었다면 빈 탭도 정리
  - 정리 실패는 원래 시작·prompt 오류와 retry 기록을 덮지 않음
  - 기존 빈 관리 pane과 다른 호출의 pane은 정리하지 않음
- 다른 pane이 작업 중이거나 활성 확인 불가면 정리 보류
  - `tab_close_blocked` 경고와 방해 pane 목록 반환
  - 다른 pane 자동 취소·이동·종료 없음
- 호출자 취소·전체 timeout 외 정리 실패는 주 작업 결과에 영향 없음
  - 일반 실패는 `cleanup_failed` 경고만 반환
- 관리 탭 이름은 호출자 네이티브 세션 ID
  - 변경 시 관리 제외, `unmanaged_tab` 경고
  - 복구는 이름을 되돌린 뒤 `close`

# 표시 이름

- `--name`은 Herdr 에이전트 이름이 아닌 네이티브 세션 표시 이름
- 클로드: 새 시작·종료 뒤 재개 시 `<caller-id> <name>` 시작 옵션
  - 실행 중 클로드 불가
- 코덱스: 완료 뒤 `/rename` 가능한 범위에서 전송
  - `prompt` 중단 뒤 후속 `wait`에서도 이름을 적용하려면 같은 `--name` 재전달
  - 일반 실패는 결과·경고 없음. 호출자 취소·전체 timeout은 prompt 오류로 반환
