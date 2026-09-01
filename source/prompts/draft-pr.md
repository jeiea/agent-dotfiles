---
name: draft-pr
description: 유저에게 PR 초안 폼을 띄웁니다
allowed-tools: Bash(git:*) Bash(gh pr create:*) Bash(gh pr view:*) Bash(deno:*) Bash(yarn:*) Bash(pnpm:*) Skill(get-pr-changes) Skill(flavor-review)
---

# 맥락 수집

1. 예상 PR 변경 내역을 get-pr-changes 스킬로 확인
   - 포함해야 할 미커밋 변경사항이 있으면 먼저 커밋
2. 제품 방향성에 영향을 주는 경우 figma, notion, slack 중 가용한 도구 전부에서
   최근 1달 이내 관련 자료, 근거 수집
3. notion, slack 링크가 있으면 배경 확인을 위해 내용 확인

# PR 제목, 설명 생성

- .github/pull_request_template.md 형식에 따라 GFM으로 작성
- 섹션별로 해당하는 내용이 없다면 비움
- 섹션: PR 템플릿에 대응시키고 대응이 없어도 보존
  - 배경: 변경 동기(예: 원인 URL, 문제 인식 시점, 재현 가능한 문제, 실패 명령어,
    에러 핵심 발췌)
    - 수정 사항 관련 내용 금지
  - 변경점: 독립적인 변경 의도마다 한 항목
  - 코멘트: 추론, 고민, 폐기한 대안, 리뷰어에게 유용한 정보 등
  - 테스트 방법: commit-flavor의 검증 섹션을 따름
- 개조식으로 간결히 작성, 한 문장이어도 어미, 조사 보존
- 양식이 아닌 모든 내용이
  - 각 항목이 왜? 라는 의문이 들지 않아야 함
  - 또는 메타적 측면, 검증 정보 중 하나라도 포함해야 함
  - 아니면 생략
- URL 바로 삽입보다 URL 내용 설명 링크 선호
  - 이슈/PR URL은 제목 정보가 부가되므로 선택

# PR 리뷰

- flavor-review로 검토 후 수정 제안이 있을 때만 진행 여부 질의
- 추가로 이 스킬 전체를 기준으로, PR 제목과 설명을 산출물로써 1회만 리뷰 요청
  - 스킬을 임의 요약하지 말고 스킬을 언급하거나 전체 발췌
- 요청별로 이미 통과했다면 생략 가능

# 폼 띄우기

- `git push --force-with-lease <current branch> || git push --set-upstream origin --force-with-lease <current branch>`
- `gh pr create --web -a @me --title <title> --body-file - && echo 'Form opened.'`
  명령어에 작성한 설명을 heredoc으로 입력합니다
- 유저가 브라우저에서 추후 PR을 만들도록 추가 확인 없이 종료
