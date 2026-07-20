---
name: worktree-first
description: 새 워크트리에서 작업. 본문 읽을 필요 없음.
---

# 원칙

- 대상 저장소의 현재 HEAD를 기본 기준으로 새 브랜치와 worktree 생성
- 사용자가 기준 revision이나 브랜치를 지정하면 우선 적용
- 기존 작업 트리와 겹치지 않는 형제 경로, 충돌하지 않는 작업용 브랜치 이름 사용
- 기존 작업 트리의 미커밋 변경은 복사, 이동, 수정하지 않음
  - 작업에 해당 변경이 필요하면 worktree 생성 전 사용자에게 처리 방법 확인
- 생성 후 파일 수정, 명령 실행, 검증, 커밋을 모두 새 worktree에서 수행
- 사용자 요청 없이 worktree나 브랜치 정리 금지

# 절차

1. 저장소 루트, 현재 HEAD, 기존 worktree, 작업 트리 상태 확인
2. 작업 내용을 나타내는 경로와 브랜치 이름 결정
3. `git worktree add -b <branch> <path> <revision>` 실행
4. 새 worktree를 작업 디렉터리로 사용하고 요청 수행
5. 결과와 함께 worktree 경로, 브랜치, 기준 revision 보고
