---
name: herdr
description: 코드 탐색이 아닌 작업 위임 시 delegate CLI 사용
allowed-tools: Bash(herdr *) Bash(deno run *)
---

예외 상황 등의 정보 필요 시 `herdr --skill` 확인.

# 작업을 위임하는 방법

일반 위임은 아래 스크립트만 사용한다. 직접 `herdr agent start/prompt/read`를
조립하는 절차는 delegate 디버깅 같은 예외 상황에만 사용한다.

```sh
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts prompt --help

# 새 동기 작업
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts prompt \
  --permission read-only <<'PROMPT'
<역할, 맥락, 작업, 종료 조건>
PROMPT

# 새 작업을 분리하고 나중에 회수
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts prompt \
  --permission write --detach <<'PROMPT'
<역할, 맥락, 작업, 종료 조건>
PROMPT
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts wait <SESSION_ID>

# 같은 대화에 작업 중 또는 종료 뒤 후속 요청
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts prompt <SESSION_ID> <<'PROMPT'
<변경점, 후속 작업, 종료 조건>
PROMPT
```

프롬프트 본문은 표준 입력 또는 `--prompt-file`로 전달한다. `\n` 문자열 대신 실제
개행을 사용한다. 클로드에서 호출할 때는 스크래치패드 경로 UUID를 `--caller-id`로
명시한다.

# session을 확인하고 정리하는 방법

```sh
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts status <SESSION_ID>
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts wait <SESSION_ID> --timeout 20m
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts logs <SESSION_ID> --lines 200
deno run -A {SKILL_BASE_DIR}/scripts/delegate.ts close <SESSION_ID>
```

- 공개 식별자는 코덱스·클로드 native session ID 하나뿐이다.
- `status`의 `blocked`는 관찰 성공이다. `prompt`·`wait`의 `agent_blocked`는
  사용자 입력이 필요한 상태다.
- 종료된 session을 `--permission write`로 재개할 때는 `--confirm-escalation`을
  함께 지정한다. live session의 권한·모델·추론 강도는 후속 prompt에서 바꿀 수
  없다.
- 작업 중 수동 prompt를 보내도 된다. 동기 `prompt`와 `wait`는 호출 뒤 관찰된
  모든 사람 prompt가 끝난 뒤 정리한다.
- 완료 판정은 native 사람 prompt record를 확인한 다음 Herdr 상태와 native 파일이
  500ms 동안 함께 변하지 않는지 보는 휴리스틱이다.
- `logs`는 pane 화면이 아니라 native JSONL의 사람·최종 assistant 대화를
  렌더한다. `result`는 렌더한 전체 대화이고 `--lines`는 그 결과의 마지막 N줄만
  반환한다. pane 종료 뒤에도 사용할 수 있다.

# 자동 정리와 복구

동기 `prompt` 성공과 분리 작업의 `wait` 성공은 managed pane과 빈 관리 탭을 자동
정리한다. 수동 prompt가 있었어도 조건은 같다. 대화는 native JSONL에 남으므로
다음 `prompt <SESSION_ID>`가 새 pane에서 같은 session을 재개한다.

- 관리 탭 이름은 호출자 native session ID와 정확히 같다.
- 사용자가 탭 이름을 바꾸면 관리 대상에서 제외되며 `unmanaged_tab` warning이
  반환된다. 자동 정리를 다시 원하면 탭 이름을 호출자 ID로 되돌린 뒤 `close`를
  실행한다.
- 다른 `working`·`blocked`·`unknown` agent pane이나 active 여부를 확인할 수 없는
  일반 pane이 있으면 `tab_close_blocked` warning과 모든 blocker가 반환된다. 다른
  pane은 자동으로 취소·이동·종료하지 않는다.
- 정리 명령 실패는 주 작업 성공을 바꾸지 않고 `cleanup_failed` warning으로
  반환된다.
- managed session pane에서 대화를 계속하려면 `--detach`를 사용한다. 동기 성공 뒤
  pane을 보존하는 옵션은 없다.

# 표시 이름

`--name`은 Herdr agent 이름이 아니라 native session 표시 이름이다. 클로드는 새
시작·종료 뒤 재개 시 `<caller-id> <name>`을 시작 옵션으로 받는다. live
클로드에는 사용할 수 없다.

코덱스는 작업 완료 뒤 `/rename`을 best effort로 전송한다. 분리한 코덱스 작업에
표시 이름이 필요하면 호출자가 같은 `--name`을 후속 `wait`에 다시 전달한다. 표시
이름 변경 실패는 작업 결과나 warning을 만들지 않는다.
