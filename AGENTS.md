# AGENTS.md

여러 코딩 어시스턴트가 설정, 프롬프트, 스킬, 플러그인 형식이 달라 통합 관리하는
개인 설정 저장소.

## 목표

동일시 가능한 설정을 단일 원천에서 최대한 편리하게 관리하도록 지원

동일시 불가능한 설정을 위한 개별화 방법 지원

## 구조

```txt
agent-files/
├ source/                     # 공유 원본 (여기를 편집)
│ ├ settings.toml             # 활성 client와 plugin 선택
│ ├ agents/                   # 에이전트와 메인 지시
│ ├ prompts/                  # 재사용 프롬프트
│ ├ skills/                   # 모든 client에 포함할 공용 스킬
│ ├ plugins/                  # 선택적·원격 리소스 묶음
│ ├ remotes.manifest.json     # 원격 plugin source 선언
│ ├ remotes.lock.json         # 벤더링한 원격 revision
│ └ rules.toml                # permcheck 도구 허용 규칙
└ clients/                    # client별 빌드 산출물. 수정 금지
```

CLI 도구(soa)는 별도 저장소: https://github.com/jeiea/soa `$SOA_URL`
환경변수(mise.toml)로 raw GitHub URL 참조. 인증은 `.env`의 `DENO_AUTH_TOKENS`.

## 리소스 관리

- `source/skills/<name>/SKILL.md`: 작업 절차와 트리거. 필요한 `scripts/`,
  `references/`, `assets/`를 같은 스킬 디렉터리에 배치
- `source/prompts/<name>.md`: 모든 활성 client에 포함할 프롬프트. client 형식에
  맞게 command, prompt 또는 skill로 렌더링
- `source/agents/<name>.md`: 공용 에이전트. `settings.toml`의 `main_agent`는
  client 메인 지시 파일이 되고 나머지는 일반 agent로 렌더링
- `source/agents/<name>.local.md`: 같은 이름의 agent 뒤에 덧붙일 로컬 지시.
- 모든 client에 필요한 리소스는 위 top-level 디렉터리에 두고, 선택적 리소스는
  `source/plugins/<name>/` 안에 같은 `skills|prompts|agents` 구조로 배치
- client별 plugin은 `settings.toml`의 `clients.<name>.plugins`에서 선택.
  평탄화되는 client에서 리소스 이름이 겹치면 빌드 에러
- 원격 리소스는 `remotes.manifest.json`에 논리 plugin source로 선언하고
  `source/plugins/`에 벤더링. 추가·제거에는 `soa plugins add|remove`와
  `soa plugins source add|remove` 사용

## 명령

```sh
deno task build                   # 기본 설정 빌드
deno task install                 # 기본 설정 설치
deno task plugins -- list         # 논리 플러그인 조회
deno task test                    # source/ 내 테스트
```

## permcheck 연동

`source/rules.toml`은 permcheck 훅이 사용하는 도구 허용 규칙 파일. permcheck는
매치되지 않은 호출을 audit log에 `decision: "passthrough"`로 기록.

**반복 작업**: audit log의 passthrough 항목을 분석해 `source/rules.toml`에 패턴
반영.

- 사용자가 audit이라고만 간단히 지시하면 최근 30줄 또는 최근 30분 이내 항목을
  기준으로 확인
- audit log 경로: 설치된 rules 설정의 `log_path` 필드
  (~/.config/permcheck/rules.local.toml 존재 가능)
- permcheck 프로젝트: 별도 저장소. 수정 필요 시 유저에게 경로 확인
- passthrough 항목 필터: `rg '"decision":"passthrough"' <audit_log_path>`
- reason `unmatched: <command>`의 명령어가 현재 permcheck test를 통과하면 제외
- 반영 시 기존 패턴 중복 여부, deny 규칙과의 충돌 확인, `[[tests]]` 추가
- 유저에게 반영 항목 사전 확인 시 reason 필드 적극 제시
