---
name: zettelkasten
description: 기억 필요 시, 기존 지식 검색, 작업 후 재사용 지식 저장 시 사용. amsd는 이 스킬의 경로 이름. 시스템 메모리 기능은 초기화 가능성이 있어 이 스킬 우선.
allowed-tools: Bash(mise x node@latest -- qmd *) Bash(qmd *) Bash(git push) Skill(commit-flavor) Skill(commit-flavor *) Read Write(docs/agent/**)
---

저장소 지침, `AGENTS.md`, 작업 지시가 다른 문서 위치나 방식을 지정하면 그 지침
우선.

스킬만 호출하거나 정리 주제가 모호한 경우 현재 대화 정리로 간주.

# 기존 지식 검색

기존 지식 가능성 있으면 새로 쓰기 전에 먼저 `qmd` 검색. qmd 사용 곤란 시
사용자에게 알리고 저장소 내 검색만으로 진행. `mise x node@latest -- qmd ...`
형태 선호. 오류 시 --% 사용 또는 접두사 없는 실행 허용.

권장 순서:

1. `qmd query "<질문>"`로 자연어 검색
2. 필요 시 `qmd search "<정확 키워드>"`로 식별자, 파일명, 고정 용어 검색
3. 필요한 문서만 `qmd get ...` 또는 `qmd multi-get ...`으로 확인

검색 질의 작성 원칙:

- 자연어 질문, 정확 용어, 예상 답변 표현을 섞어 탐색
- 저장소명, 패키지명, 명령어, 오류 문자열처럼 정확도가 중요한 토큰을 포함
- 이미 찾은 문서의 표현을 질의에 재사용

검색 결과가 충분하면 중복 기록 없이 기존 문서 활용.

# 지식 정리

- 코드 이해에 직접 필요한 짧은 불변식은 주석 추가. 작업 흐름, 결정 배경, 디버깅
  절차처럼 범위가 넓은 지식은 문서화 계속 고려.
- 새 주제 생성 전 기존 파일 병합 가능 여부 먼저 확인.
- 여러 위치 중복 기록 지양. 단 중복하지 않도록 분할 기록, 재구조화, 링크 가능.
- 검색 과정 중 재구조화하기 좋은 키워드, 주제 등을 찾았다면 관련 문서 포함 수정,
  이동 가능.
- 적절한 추가 대상을 찾지 못했다면 `AGENT_MEMORY_SHARED_DIR` 환경 변수 경로(이하
  AMSD) 확인 후 새로 기록.
  - AMSD가 깃 저장소면 commit-flavor 후 푸시.
  - 저장소 종속 지식인 경우 AMSD/<저장소 이름>/<주제>로 초기 그룹핑 고려.
- 새 문서화 위치가 `docs/agent/`라면 처음 작성 시
  `qmd collection add <폴더> --name <이름>`으로 색인 추가 여부 확인.
- 기존 qmd 컬렉션에 추가하려면 `qmd collection show <이름>`으로 경로 확인 가능.
  이름을 알 수 없다면 `qmd collection list`로 확인 가능.
- qmd 검색 결과 수정 시 `qmd get --full-path <qmd-uri>` 또는 검색 시
  `--full-path` 사용
  - 불명확하면 `qmd collection show <컬렉션>` 후 collection root에서
    `fd <파일명>` 실행
  - `AGENT_MEMORY_SHARED_DIR`와 qmd collection root는 다를 수 있음
- 폴더별 항목이 3개 초과 시 `README.md`를 한 줄 인덱스로 유지:
  `- [제목](파일.md) - 한 줄 요약`.
- 근처 문서 언어로 작성. 모호하면 유저 사용 언어로 작성.
- 현재 대화 정리 시
  - `YYYY-MM-DD <주제>.md` 에 정리.
  - 재작업 시 유용할 정보, 다시 필요할 가능성이 높은 정보, 실패 시도와 원인 등을
    선별해 간결히 정리.
- 주제가 명확한 경우 `<주제>.md`에 저장.
- 배경, 파악한 유저 의도, 근거, 링크, 제약 최대한 포함.
- 정리 후 `qmd update && qmd embed`로 색인 업데이트. 시간이 걸릴 수 있으니 완료
  대기 불필요.

# 에러 시

- qmd 미설치 시: `pnpm add -g @tobilu/qmd --allow-build=better-sqlite3`로
  설치할지 질문.
- `qmd collection list`에서 AMSD가 컬렉션에 미등록이면 등록할지 사용자에게 질문.
