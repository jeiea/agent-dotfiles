---
name: draft-pr
description: 유저에게 PR 초안 폼을 띄웁니다
allowed-tools: Bash(git:*) Bash(gh pr create:*) Bash(gh pr view:*) Bash(deno:*) Bash(yarn:*) Bash(pnpm:*) Skill(get-pr-changes)
---

# 맥락 수집

1. 예상 PR 변경 내역을 get-pr-changes 스킬로 확인
   - 포함해야 할 미커밋 변경사항이 있으면 먼저 커밋
2. 제품 방향성에 영향을 주는 경우 figma, notion, slack 중 가용한 도구 전부에서
   최근 1달 이내 관련 자료, 근거 수집
3. notion, slack 링크가 있으면 배경 확인을 위해 내용 확인
4. 사전 검증(린트, 테스트)이 가능하면 진행

# PR 리뷰

리뷰를 위한 코드 수정이 필요하면 유저 확인 먼저 구하기

아래 기준으로 peer-review

1. diff 미포함 코드, 외부 시스템 요소도 고려해 잠재된 까다로운 점을 나열
   - 코드 품질과 모범 사례
   - 잠재적 버그 또는 이슈
   - 성능
   - 보안
   - 테스트 커버리지
   - README 등 문서 업데이트 여부
2. 저장소에서 확인 가능한 예상 이슈 확인 후 타당하거나 확인이 불가능한 경우
   남기기
3. 남은 이슈를 중요도순 정렬, 저장소 설정과 CI/CD 고려해 작업 계획 제안

리뷰 결과를 제공하고 수정 제안이 있을 때만 진행 여부를 묻습니다

# PR 설명 및 제목 생성

- .github/pull_request_template.md 형식에 따라 GFM으로 작성
- 섹션별로 해당하는 내용이 없다면 비움
- 섹션: PR 템플릿에 대응시키거나 템플릿이 없을 시 사용
  - 배경: 변경 동기(예: 근거 URL, 재현 가능한 문제, 실패 명령어, 에러 핵심 발췌)
  - 변경점: 독립적인 변경 의도마다 한 항목
    - 가급적 압축
  - 코멘트: 추론, 고민, 폐기한 대안, 리뷰어에게 유용한 정보 등
  - 테스트 방법: commit-flavor의 검증 섹션을 따름
- 항목당 1줄씩 간결히 작성, 마크다운 링크 적극 사용

# 폼 띄우기

- `git push --force-with-lease <current branch> || git push --set-upstream origin --force-with-lease <current branch>`
- `gh pr create --web -a @me --title <title> --body-file - && echo 'Form opened.'`
  명령어에 작성한 설명을 heredoc으로 입력합니다
- 유저가 브라우저에서 추후 PR을 만들도록 추가 확인 없이 종료
