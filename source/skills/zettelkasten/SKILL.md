---
name: zettelkasten
description: 기억 필요 시, 기존 지식 검색, 작업 후 재사용 지식 저장 시 사용. amsd는 이 스킬이 쓰는 경로.
allowed-tools: Bash(mise x node@latest -- qmd *) Bash(qmd *) Bash(git push) Skill(commit-flavor) Skill(commit-flavor *) Read Write(docs/agent/**)
---

- 저장소 지침·작업 지시의 문서 위치·방식 우선
- 스킬만 호출하거나 주제가 모호하면 현재 대화 정리

# 검색

- 기존 지식이 있을 만하면 작성 전 `qmd` 검색
  - `mise x node@latest -- qmd ...` 선호
  - 실행 오류 시 `--%` 또는 접두사 없는 실행 허용
  - 사용 곤란 시 유저에게 알리고 저장소 내 검색으로 진행
- `qmd query "<질문>"` → 필요 시 `qmd search "<정확 키워드>"` → 필요한 문서만
  `qmd get`·`qmd multi-get` 순 조회
  - 자연어·정확 토큰·예상 답변·발견한 문서 표현을 조합
- 검색 결과가 충분하면 중복 기록 없이 활용
- 검색 결과 수정 전 `qmd get --full-path <qmd-uri>`로 실제 경로 확인
  - 검색 시 `--full-path` 사용도 가능
  - 불명확하면 `qmd collection show <이름>`의 경로에서 `fd <파일명>` 실행
  - 컬렉션 이름은 `qmd collection list`로 확인
  - 컬렉션 경로와 `AGENT_MEMORY_SHARED_DIR`의 일치 가정 금지

# 저장 위치

- 코드 이해에 직접 필요한 짧은 불변식은 주석, 넓은 지식은 문서화 고려
- 새 파일보다 기존 문서 병합 우선
  - 중복 없이 분할·링크·재구조화, 관련 문서 수정·이동 허용
- 적절한 대상이 없으면 `AGENT_MEMORY_SHARED_DIR`(AMSD)에 저장
  - 저장소 종속 지식은 `<저장소 이름>/<주제>`로 초기 그룹핑 고려
  - AMSD가 깃 저장소면 commit-flavor에 따라 커밋 후 푸시
- `docs/agent/` 최초 작성 시 `qmd collection add <폴더> --name <이름>`으로 색인
  추가 여부 확인

# 기록·색인

- 재사용 가능성이 높은 정보·실패 원인을 선별해 간결히 기록
  - 배경·유저 의도·근거·링크·제약 보존
- 주변 문서 언어 사용, 모호하면 유저 언어 사용
- 대화 정리는 `YYYY-MM-DD <주제>.md`, 명확한 주제는 `<주제>.md` 사용
- 폴더 항목이 3개 초과면 `README.md`에 한 줄 인덱스 유지
  - `- [제목](파일.md) - 한 줄 요약`
- 정리 후 `qmd update && qmd embed` 실행
  - 완료 대기 불필요

# 사용자 확인

- qmd 미설치 시 `pnpm add -g @tobilu/qmd --allow-build=better-sqlite3` 설치 여부
  질문
- `qmd collection list`에 AMSD 미등록 시 등록 여부 질문
