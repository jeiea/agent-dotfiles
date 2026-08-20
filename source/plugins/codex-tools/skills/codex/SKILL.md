---
name: codex
description: 계획자, 검토자, 디버깅 전문가인 코덱스(Codex)를 호출. 도구 사용이 가능하니 사전 조사보다 배경과 맥락을 건네주고 위임.
allowed-tools: Bash(codex *) Read(/tmp/*) Bash(openssl rand -hex 4) Bash(herdr *) Skill(herdr)
---

작업 디렉토리의 AGENTS.md 맥락을 공유하는 중첩 Codex 프로세스(서브에이전트) 실행

`test "${HERDR_ENV:-}" = 1`이면 herdr 환경, 아니면 비herdr 환경. 공통 항목은 둘
다 적용, 비herdr 절차는 herdr 환경에서 미사용.

## 사용 케이스

- 심화 추론이 필요한 계획 또는 아키텍처 결정
- 다양한 가설 탐색이 필요한 디버깅
- 현재 세션에 편향되지 않은 새 관점 필요 시

## 공통

### 프롬프트 내용

- `\n` 이스케이프 금지. 셸 인자에서 리터럴 `\n`으로 전달되므로 여러 줄은 실제
  개행(heredoc, quoted 개행)으로 작성
- 역할, 종료 조건 명확히 기술
- 종속 세션, 즉 결과를 기다리는 세션인 경우 스킬 재귀 사용, 서브에이전트 무한
  포크 방지를 위해 금지 스킬 명시(예: claude)
- 가용 도구 차이가 있을 수 있어 도구에서만 얻을 수 있는 맥락은 최대한 전달. 가령
  `--sandbox read-only`에선 테스트를 실행할 수 없으니 `workspace-write`를 쓰거나
  테스트 직접 실행 결과 첨부

### 전역 플래그 (exec 앞에 삽입)

- `--approve-for-me`: 항상 추가. 승인 요청을 자동 검토하고 기본 샌드박스를
  `workspace-write`로 설정
- `--search`: 웹 검색 허용. 이유가 없는 한 허용합니다. (기본: `false`)
- `--config model_reasoning_effort=<level>`: 계획 시 `xhigh`, 이외 `high`
- `--add-dir <path>`: 추가 디렉토리 허용
- `--cd <path>`: 작업 디렉토리 설정

### exec 플래그 (exec 뒤에 삽입)

- `--sandbox`: `read-only` | `workspace-write`
  - 도구 사용을 허용하지만 수정을 의도하지 않는 경우 `workspace-write`를
    사용하고 이 요청에 한해 수정하지 말라는 지시 강조.
- `--skip-git-repo-check`: Git 저장소 외부에서 코덱스 실행 허용

### 호출 시 판단 항목

1. 위험도에 따른 권한, effort 수준
2. 메인 세션 또는 서브 세션 병렬 진행 가능성

## herdr 환경

- `herdr` 스킬 지침대로 herdr pane/agent에서 중첩 실행
- `herdr agent start ... --` 뒤에 위 전역 플래그 전달
  - `--approve-for-me`가 `workspace-write`를 설정하므로 충돌하는 `--sandbox`
    생략
- 시작 직후 `/rename <원래 세션 ID> <위임 목적>` 형식으로 세션 명명:
  `herdr agent prompt <target> '/rename <원래 세션 ID> <이름>'`
  - 원래 세션 ID: 호출자 자신의 세션 ID. `$CODEX_THREAD_ID` 또는 claude의 경우
    스크래치패드 경로의 UUID
  - `--wait` 금지. 즉시 처리라 상태 변화가 없어 stalled 오류만 발생
- 프롬프트 전달, 로깅, 대기, 결과 회수, 세션 관리는 herdr에 위임

## 비herdr 절차

- 프롬프트는 항상 `- <<'PROMPT' ... PROMPT` 형식으로 stdin에 전달. argv 프롬프트
  금지
  - stdin·argv 동시 전달 시 병합(`<stdin>` 블록)으로 의도치 않은 프롬프트 생성
  - argv만 전달해도 stdin이 비TTY로 열려 있으면(백그라운드 셸 등) EOF 대기 교착.
    "Reading additional input from stdin..." 후 무한 대기가 증상. 부득이 argv
    사용 시 `< /dev/null` 필수
- 조금이라도 이전 호출과 관련이 있으면 해당 세션 ID 재사용. 완전히 새 관점이
  필요한 경우만 예외
- 유저 입력 세션 ID가 유효한 UUID가 아니라면 유저에게 먼저 확인
- `--approve-for-me`는 전역에, `--sandbox`는 `exec` 뒤에 배치해 플래그 충돌 방지

```sh
# 1. 로그 파일명 생성
openssl rand -hex 4
# → e.g. a1b2c3d4

# 2. 첫 실행
codex --approve-for-me --search --config model_reasoning_effort=xhigh exec --sandbox read-only - <<'PROMPT' 2>>/tmp/a1b2c3d4.log
claude 재호출 금지.
작업 목록 및 계획을 알려주세요
PROMPT

# 3. 세션 ID 추출
grep 'session id: ' /tmp/a1b2c3d4.log | cut -d' ' -f3
# → e.g. e2d892ab-46ad-42d1-83ca-f5727d969c38

# 4. 세션 재개
codex --approve-for-me --search --config model_reasoning_effort=xhigh exec --sandbox read-only resume e2d892ab-46ad-42d1-83ca-f5727d969c38 - <<'EOF' 2>>/tmp/a1b2c3d4.log
A 태스크를 완료했습니다.
리뷰해주세요.
EOF
```

### 로깅

- 실행 전 `openssl rand -hex 4`로 고유 로그 파일명 생성
- stderr 캡처용으로 `2>>/tmp/${filename}.log` 추가
- 실패, 예상치 못한 동작, 또는 명시적 요청 시 로그 파일 확인
- 로그 중 `session id:`를 포함한 라인에서 세션 ID 확인 가능

### 타임아웃

- 별도 요청이 없다면 최소 20분 설정
