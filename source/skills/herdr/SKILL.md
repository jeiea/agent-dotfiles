---
name: herdr
description: 코드 탐색이 아닌 작업 위임 시 HERDR_ENV=1이면 herdr pane으로 호출
allowed-tools: Bash(herdr *)
---

# 전제

- `test "${HERDR_ENV:-}" = 1` 실패 시 중단, 내장 서브에이전트 사용

# 대상 선택

1. 유저가 기존 에이전트 사용 요청 시 조회

   ```sh
   herdr agent list
   ```

   - `cwd`는 대상 선택 단서로 참고
   - 이름이 중복되면 고유 `pane_id`를 `<target>`으로 사용
   - 상태·화면 확인: `herdr agent get <target>`

2. 요청 없거나 재사용 대상 없으면 pane 분할·새 에이전트 시작

   - 지원 kind: `herdr agent` 출력
   - `herdr pane layout --current`의 `$HERDR_PANE_ID` rect 기준 가로 여유면
     right, 그 외 down

   ```sh
   herdr pane split --current --direction right --cwd "$PWD" --no-focus
   herdr agent start <name> --kind <kind> --pane <pane_id> -- <agent-args...>
   ```

   - 새 pane ID: split 응답 `.result.pane.pane_id`
   - 이름: `[a-z][a-z0-9_-]{0,31}`, live 중 유일

# 소통

1. 위임·후속 요청

   ```sh
   herdr agent prompt <target> "<지시>" --wait --timeout 300000
   ```

   - 새 작업은 자기완결적 지시, 기존 맥락은 변경점·종료 조건 중심
   - `--wait`: idle|done|blocked 정착까지 대기
   - 병렬 위임: 위 명령을 pane별 백그라운드 셸로 동시 실행 후 회수
   - prompt 뒤 별도 `agent wait` 금지. 전환 전 idle에 즉시 반환 가능

2. blocked·stalled·timeout·unknown 시 해소까지 반복

   - `herdr agent get <target>`과 아래 결과 회수로 판정
   - blocked: 텍스트 질문엔 prompt, UI 선택지엔
     `herdr agent send-keys <target> esc` 등 키 입력 후
     `herdr agent wait <target> --until idle --until done --timeout 300000`
   - stalled: 추가 prompt로 재시도
   - timeout에 working이면 `herdr agent wait <target> --timeout 300000` 재대기
   - unknown: 화면 기준 작업 중이면 재대기, 응답 완료면 결과 회수
   - `agent_not_running`·timeout·unknown만으로 재위임·실패 판정 금지

# 결과 회수

```sh
herdr agent read <target> --source recent-unwrapped --lines 120
```

- 부족하면 `--lines` 증가

# 정리

- 직접 만든 pane: 화면에서 완료 확인 후 `herdr pane close <pane_id>`
- 기존 에이전트 pane 유지

# 금지

- 유저 focus 이동(`--no-focus` 유지)
- 직접 만들지 않은 pane·tab·workspace 조작·종료
