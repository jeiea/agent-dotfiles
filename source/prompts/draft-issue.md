---
name: draft-issue
description: 유저 선호를 맞춰 깃헙 이슈 초안 작성
allowed-tools: Bash(gh api *) Bash(git remote *) Bash(gh issue list *) Bash(gh issue view *) Bash(gh issue create *) Bash(open *) Bash(xdg-open *)
---

# 사전 조사

- 닫힌 걸 포함해 중복 이슈, 논의(Discussion) 검색
  - 있다면 먼저 제시하고 진행 여부 확인
  - 이미 확인해 없을 것 같다면 생략

# 이슈 초안 작성

- 기존 이슈의 언어·제목 관례 사용. 없으면 README 언어 사용
- .github/ISSUE_TEMPLATE 또는 .github/DISCUSSION_TEMPLATE 안 가장 적절한 템플릿
  선택, 없으면 아래 섹션을 `##`으로 사용
  - 템플릿은 본문 형식에 반영
  - 라벨이 있는 YAML 템플릿을 고른 경우 라벨 추가를 위해 다음 URL을 열거나 제공
    후 폼 입력 내용 제시
    - `https://github.com/<owner>/<repo>/issues/new?template=<파일명>&title=<URL 인코딩 제목>`
    - `https://github.com/<owner>/<repo>/discussions/new?category=<카테고리>`
    - 유저가 생성 완료 후 최종 마크다운 형태로 수정
- 섹션: 아래 내용을 템플릿 섹션에 대응하고, 대응할 곳 없는 섹션은 추가
  - 배경(Background): 변경 동기, 변경해야하는 이유, 이야기의 시작 등
  - 성격에 따라 아래 중 하나 선택
    - 재현 방법(Steps to reproduce)
      - 실제 동작을 일으키는 틀리지 않는 최소 환경과 재현 과정
      - 반복 검증으로 최소 필요 조건 추출
    - 시나리오(Scenario): 기능이 필요한 상황과 사용 흐름
  - 기대 동작(Expected behavior)
  - 실제 동작(Actual behavior)
  - 부가 정보(Additional context): 비교 스크린샷 표, 로그 등 보충 자료
- URL은 설명 문구에 연결
  - 이슈·PR은 제목 미리보기를 위해 직접 삽입
- GFM이므로 개행은 문단 구분이 아닌 개행 지양
- 사람이 읽는 비용을 고려해 중복없이 간결히 작성
  - 불가피한 10줄 초과 첨부는 &lt;details&gt; 활용

# 검토

- 각 부분이 정말 독자에게 필요한지 확인 후 가능한 생략

# 폼 띄우기

- `gh issue create --web --title "<title>" --body-file - && echo 'Form opened.'`에
  작성한 본문을 표준 입력으로 전달
- 유저가 브라우저에서 추후 이슈를 만들도록 추가 확인 없이 종료
