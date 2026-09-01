---
name: codex
description: 계획자, 검토자, 디버깅 전문가인 코덱스(Codex) 호출. 도구 사용이 가능하니 사전 조사보다 배경과 맥락을 건네주고 위임. herdr 환경에선 herdr 스킬 의존.
allowed-tools: Bash(codex *) Read(/tmp/*) Bash(openssl rand -hex 4) Bash(herdr *) Skill(herdr)
---

작업 디렉토리의 `AGENTS.md` 맥락을 공유하는 중첩 Codex 실행

# herdr에서 새로 호출

`test "${HERDR_ENV:-}" = 1`이면 pane 생성 후 실행:

```sh
# pane_id: 응답 .result.pane.pane_id (예: w24:pC)
herdr pane split --pane "$HERDR_PANE_ID" --direction down --cwd "$PWD" --no-focus
herdr agent start <name> --kind codex --pane <pane_id> -- \
  --approve-for-me --search --config model_reasoning_effort=high
herdr agent prompt <name> '/rename <호출자 세션 ID> <위임 목적>'
herdr agent prompt <name> "$(cat <<'PROMPT'
<역할, 맥락, 작업, 종료 조건>
PROMPT
)" --wait --timeout 1200000
herdr agent read <name> --source recent-unwrapped --lines 120
```

- `agent start` 뒤 플래그는 전역 플래그. `--approve-for-me`가
  `workspace-write`를 설정하므로 `--sandbox` 생략
- `/rename` 직후 `--wait` 금지. 상태 변화 전이라 stalled 오류 발생 가능
- 호출자 세션 ID: `$CODEX_THREAD_ID`, 클로드는 스크래치패드 경로의 UUID
- `--direction` 필수. 기본 `down`, 유저 지정 시 따름
- 상태 처리, 결과 회수, 정리는 herdr 스킬 적용

# 비herdr에서 새로 호출

```sh
# 로그 파일명 생성
openssl rand -hex 4
# → a1b2c3d4

codex --approve-for-me --search --config model_reasoning_effort=high \
  exec --sandbox read-only - <<'PROMPT' 2>>/tmp/a1b2c3d4.log
claude와 codex 재호출 금지.
계획자로서 작업 목록과 계획을 제시하세요.
PROMPT
```

- 테스트 등 쓰기 가능한 도구가 필요하면 `--sandbox workspace-write`. 수정은 원치
  않으면 프롬프트에서 금지
- Git 저장소 밖이면 `exec` 뒤에 `--skip-git-repo-check`
- 실행 제한 시간은 별도 요청 없으면 최소 20분

# 비herdr 세션 재개

조금이라도 이전 호출과 관련 있으면 새 호출 대신 재개:

```sh
codex --approve-for-me --search --config model_reasoning_effort=high \
  exec --sandbox read-only resume <세션 UUID 또는 이름> - <<'PROMPT' \
  2>>/tmp/a1b2c3d4.log
A 작업을 완료했습니다.
결과를 검토하세요.
PROMPT
```

# 프롬프트 작성

- `\n` 이스케이프 대신 실제 개행 사용
- 종속 세션에는 재귀 호출 방지용 금지 스킬 명시
- 호출자가 가진 도구 전용 정보와 실행 결과 전달
- `read-only`에서 테스트 불가하므로 결과 전달 또는 `workspace-write` 사용

# 플래그 선택

```text
전역 플래그 (`exec` 앞)
--approve-for-me                         항상 사용
--search                                 특별한 이유 없으면 사용
--config model_reasoning_effort=xhigh    계획·아키텍처
--config model_reasoning_effort=high     검토·디버깅 등
--cd <path>                              작업 디렉토리
--add-dir <path>                         추가 디렉토리 허용

exec 플래그 (`exec` 뒤)
--sandbox read-only                      읽기 전용
--sandbox workspace-write                쓰기·테스트 필요
--skip-git-repo-check                    Git 저장소 밖에서 실행
```

- 비herdr 프롬프트는 항상 `- <<'PROMPT'`로 stdin 전달
- argv 프롬프트는 비TTY stdin의 EOF 대기 또는 stdin 병합으로 의도와 달라질 수
  있음. 불가피하면 `< /dev/null`

# 로그 확인

세션 재개 시 `/tmp/<이름>.log`의 `session id:` 확인. 그 외 실패, 예상 밖 동작,
명시적 요청 때만 로그 확인
