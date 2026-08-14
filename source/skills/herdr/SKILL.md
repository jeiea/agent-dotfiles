---
name: herdr
description: 코드 탐색이 아닌 작업 위임 시 HERDR_ENV=1이면 herdr pane으로 호출
allowed-tools: Bash(herdr *)
---

# 전제

- `test "${HERDR_ENV:-}" = 1` 실패 시 중단, 내장 서브에이전트 사용
- 지원 kind 목록은 `herdr agent` 출력 참조

# 절차

1. pane 분할. `herdr pane layout --current` 응답 `.result.layout.panes[]` 중
   `$HERDR_PANE_ID` rect 기준 가로 여유면 right, 그 외 down

   ```sh
   herdr pane split --current --direction right --cwd "$PWD" --no-focus
   ```

   새 pane ID: 응답 `.result.pane.pane_id`

2. 에이전트 시작. 이름: `[a-z][a-z0-9_-]{0,31}`, live 중 유일

   ```sh
   herdr agent start <name> --kind <kind> --pane <pane_id> -- <agent-args...>
   ```

3. 위임. 지시는 자기완결적으로 작성

   ```sh
   herdr agent prompt <name> "<지시>" --wait --timeout 300000
   ```

   - `--wait`: idle|done|blocked 정착까지 대기
   - 병렬 위임: 위 명령을 pane별 백그라운드 셸로 동시 실행 후 회수
   - prompt 뒤 별도 `agent wait` 금지. 전환 전 idle에 즉시 반환 가능

4. blocked·stalled·timeout·unknown 시. 해소까지 반복

   - `herdr agent get <name>`과 아래 read로 화면 확인
   - blocked: 텍스트 질문엔 위 prompt로 응답, UI 선택지엔
     `herdr agent send-keys <name> esc` 등 키 입력 후
     `herdr agent wait <name> --until idle --until done --timeout 300000`
   - stalled: 추가 prompt로 재시도
   - timeout에 working이면 `herdr agent wait <name> --timeout 300000` 재대기
   - unknown: 화면 기준 작업 중이면 재대기, 응답 완료면 5로 진행
   - timeout·unknown은 완료 아님. 화면 확인 전 pane 종료 금지

5. 결과 읽기

   ```sh
   herdr agent read <name> --source recent-unwrapped --lines 120
   ```

   - `--lines` 증가로도 안 보이면 alternate screen
   - 응답을 임시 Markdown 파일로 쓰고 경로만 답하라 요청 후 파일 읽기

6. 정리: `herdr pane close <pane_id>`

# 금지

- 유저 focus 이동(`--no-focus` 유지)
- 직접 만들지 않은 pane·tab·workspace 조작·종료
