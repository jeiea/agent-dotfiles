---
name: draft-issue
description: 유저 선호를 맞춰 깃헙 이슈 초안 작성
allowed-tools: Bash(gh api *) Bash(git remote *) Bash(gh issue list *) Bash(gh issue view *) Bash(gh issue create *)
---

# 사전 조사

- 닫힌 이슈를 포함해 중복 이슈 검색 후 있다면 먼저 제시하고 진행 여부 확인

# 이슈 초안 작성

- 기존 이슈의 언어·제목 관례 사용. 없으면 README 언어 사용
- .github/ISSUE_TEMPLATE 안 가장 적절한 템플릿 선택, 없으면 아래 섹션을 `##`으로
  사용
  - 마크다운 템플릿은 본문 형식에 반영
  - YAML 이슈 폼은 입력 항목의 label을 제목으로 삼아 마크다운 본문으로 변환
    - 안내용 마크다운 항목과 입력 형식 정의는 본문에서 생략
- 섹션: 아래 내용을 템플릿 섹션에 대응하고, 대응할 곳 없는 섹션은 추가
  - 배경(Background): 변경 동기, 변경해야하는 이유, 이야기의 시작 등
  - 성격에 따라 아래 중 하나 선택
    - 재현 방법(Steps to reproduce): 실제 동작을 일으키는 틀리지 않는 재현 과정
    - 시나리오(Scenario): 기능이 필요한 상황과 사용 흐름
  - 기대 동작(Expected behavior)
  - 실제 동작(Actual behavior)
  - 부가 정보(Additional context): 비교 스크린샷 표, 로그 등 보충 자료
- URL은 설명 문구에 연결
  - 이슈·PR은 제목 미리보기를 위해 직접 삽입

# 폼 띄우기

- `gh issue create --web --title "<title>" --body-file - && echo 'Form opened.'`에
  작성한 본문을 표준 입력으로 전달
- 유저가 브라우저에서 추후 이슈를 만들도록 추가 확인 없이 종료
