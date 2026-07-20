---
name: list-pr-comments
allowed-tools: Bash(gh pr view *) Bash(gh api *) Bash(git remote *)
description: 권한 요청 마찰없이 깃헙 PR 리뷰 코멘트 조회. PR 코멘트라고만 했을 시 list-issue-comments 스킬 동시 사용 필요.
---

### 1. 저장소, PR 번호 확인

조직, 저장소, 또는 PR 번호를 아직 모르면 아래 명령어로 확인합니다.

```bash
git remote -v
gh pr view --json number -q .number 2>/dev/null || echo "no-pr"
```

- GitHub CLI가 인증되지 않은 경우: `gh auth login` 안내
- 권한이 없는 private repo인 경우: 접근 권한 확인 요청
- PR을 찾을 수 없는 경우: 유저에게 PR 번호 확인 요청

### 2. PR 코멘트 조회

```bash
gh api repos/{ORG}/{REPO}/pulls/{PR_NUMBER}/comments --jq '.[] | { user_login: .user.login, body, commit_id, path, line, start_line, position, created_at } | with_entries(select(.value | values))'
```

## 사용 예시

- 유저: PR 코멘트 내용을 해결해줘 → 조회 후 해결합니다
