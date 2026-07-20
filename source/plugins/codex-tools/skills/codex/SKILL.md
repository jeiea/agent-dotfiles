---
name: codex
description: 계획자, 검토자, 디버깅 전문가인 코덱스(Codex)를 호출. 도구 사용이 가능하니 사전 조사보다 배경과 맥락을 건네주고 위임.
allowed-tools: Bash(codex *) Read(/tmp/*) Bash(openssl rand -hex 4)
---

작업 디렉토리의 AGENTS.md 맥락을 공유하는 중첩 Codex 프로세스(서브에이전트) 실행

## 사용 케이스

- 심화 추론이 필요한 계획 또는 아키텍처 결정
- 다양한 가설 탐색이 필요한 디버깅
- 현재 세션에 편향되지 않은 새 관점 필요 시

## 사용법

프롬프트는 항상 `- <<'PROMPT' ... PROMPT` 형식으로 stdin에 전달한다. argv 위치
인자로 프롬프트를 넘기거나 `-`와 argv를 섞지 말 것 — codex는 stdin과 argv가
동시에 오면 둘을 병합(`<stdin>` 블록)해 의도치 않은 프롬프트를 만들거나 stdin
대기로 타임아웃한다.

```shell
# 1. 로그 파일명 생성
openssl rand -hex 4
# → e.g. a1b2c3d4

# 2. 첫 실행
codex --search --config model_reasoning_effort=xhigh exec --sandbox read-only - <<'PROMPT' 2>>/tmp/a1b2c3d4.log
작업 목록 및 계획을 알려주세요
PROMPT

# 3. 세션 ID 추출
grep 'session id: ' /tmp/a1b2c3d4.log | cut -d' ' -f3
# → e.g. e2d892ab-46ad-42d1-83ca-f5727d969c38

# 4. 세션 재개
codex --search --config model_reasoning_effort=xhigh exec --sandbox read-only resume e2d892ab-46ad-42d1-83ca-f5727d969c38 - <<'EOF' 2>>/tmp/a1b2c3d4.log
A 태스크를 완료했습니다.
리뷰해주세요.
EOF
```

가용 도구 차이가 있을 수 있어 도구에서만 얻을 수 있는 맥락은 최대한 전달. 가령
`--sandbox read-only`에선 테스트를 실행할 수 없으니 `workspace-write`를 쓰거나
테스트 직접 실행 결과 첨부.

조금이라도 이전 호출과 관련이 있으면 해당 세션 ID를 재사용. 완전히 새 관점이
필요한 경우만 예외.

유저 입력 세션 ID가 유효한 UUID가 아니라면 유저에게 먼저 확인.

비대화형 모드에서 `codex exec`는 승인을 요청하지 않습니다. 기본값은 `read-only`
모드(파일 편집, 네트워크 접근 불가)입니다.

## 로깅

- 실행 전 `openssl rand -hex 4`로 고유 로그 파일명 생성
- stderr 캡처용으로 `2>>/tmp/${filename}.log` 추가
- 실패, 예상치 못한 동작, 또는 명시적 요청 시 로그 파일 확인
- 로그 중 `session id:`를 포함한 라인에서 세션 ID 확인 가능

## 타임아웃

별도 요청이 없다면 최소 20분 설정

## 전역 플래그 (exec 앞에 삽입)

- `--search`: 웹 검색 허용. 이유가 없는 한 허용합니다. (기본: `false`)
- `--config model_reasoning_effort=<level>`: 계획 시 `xhigh`, 이외 `high`
- `--add-dir <path>`: 추가 디렉토리 허용
- `--cd <path>`: 작업 디렉토리 설정

## exec 플래그 (exec 뒤에 삽입)

- `--sandbox`: `read-only` | `workspace-write` | `danger-full-access`
  - 도구 사용을 허용하지만 수정을 의도하지 않는 경우 `workspace-write`를
    사용하고 이 요청에 한해 수정하지 말라는 지시 강조.
- `--skip-git-repo-check`: Git 저장소 외부에서 코덱스 실행 허용

## 호출 시 판단 항목

1. 서브에이전트가 적합한 작업 범위인지
2. 병렬화 가능한지
3. 위험도에 따른 샌드박스 수준 및 플래그
