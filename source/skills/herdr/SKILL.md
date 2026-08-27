---
name: herdr
description: 코드 탐색이 아닌 작업 위임 시 `echo "herdr=${HERDR_ENV:-off}"` 출력이 herdr=1이면 herdr CLI 사용
allowed-tools: Bash(herdr *)
---

예외 상황 등의 정보 필요 시 `herdr --skill` 확인.

# 대상 선택

유저가 기존 에이전트를 지정하면 `herdr agent list`로 조회:

- `cwd`를 대상 선택 단서로 사용
- 클로드·코덱스 세션 ID는 `pane_id` 아닌 `agent_session.value`

# 프롬프트

- `\n` 이스케이프 대신 실제 개행 사용
- 새 작업은 자기완결적 지시, 후속 작업은 변경점·종료 조건 중심
- 병렬 위임은 pane별 백그라운드 셸에서 동시 실행 후 회수
- `agent prompt --wait` 뒤 별도 `agent wait` 금지. 전환 전 idle에 즉시 반환 가능

# 상태 처리

`blocked`, `stalled`, `timeout`, `unknown`이면 `agent get`과 `agent read`로 확인
후 해소까지 반복:

- `blocked`: 텍스트 질문은 prompt, UI 선택지는 `agent send-keys` 후 wait
- `stalled`: 반복 read에서 화면 변화 없을 때만 추가 prompt. 장시간 작업은 재대기
- `timeout`: working이면 재대기
- `unknown`: 화면상 작업 중이면 재대기, 응답 완료면 회수
- `agent_not_running`, `timeout`, `unknown`만으로 재위임·실패 판정 금지

# 정리

- 직접 만든 pane은 완료 확인 후 닫고, 기존 pane은 유지
- working 대상에 독촉·조기 답변 요구 금지
- 직접 만들지 않은 pane·tab·workspace 조작·종료 금지
