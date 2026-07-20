---
name: list-issue-comments
allowed-tools: Bash(gh api *) Bash(git remote *) Bash(gh issue view *)
description: 권한 요청 마찰없이 깃헙 이슈 본문과 코멘트 조회. 코멘트에 추가 맥락이 있을 수 있어 gh cli 대신 사용.
---

# 1. 인자 확인

이슈 번호를 알 수 없으면 중단하고 요청합니다.

조직, 저장소를 아직 모르면 아래 명령어로 확인합니다.

```bash
git remote -v
```

# 2. 조회

```bash
gh api repos/{ORG}/{REPO}/issues/{ISSUE_NUMBER} --jq '{ user_login: .user.login, title, body, created_at } | with_entries(select(.value | values))'
gh api repos/{ORG}/{REPO}/issues/{ISSUE_NUMBER}/comments --jq '.[] | { user_login: .user.login, body, id, created_at } | with_entries(select(.value | values))'
```

## 사용 예시

- 유저: https://github.com/microsoft/TypeScript/issues/62546 요약해줘 → 조회 후 요약
