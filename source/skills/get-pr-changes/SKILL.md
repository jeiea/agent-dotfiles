---
name: get-pr-changes
allowed-tools: Bash(deno run *) Bash(mise exec -- deno run *) Bash(git *) Bash(jj *)
description: PR 생성 시 포함되는 변경 또는 열려있는 PR 변경 확인. 동일한 의도의 git diff, log 대신 사용.
---

'gitStatus: This is the git status at the start of the conversation'으로
시작하는 지시의 Main branch는 부정확하므로 다음 명령어 정보를 우선합니다.

`deno run -A {SKILL_BASE_DIR}/scripts/cli.ts get-pr-changes [--base <branch>]`
