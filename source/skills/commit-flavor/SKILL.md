---
name: commit-flavor
description: git commit, amend 전 유저 선호 사항 확인 후 커밋
allowed-tools: Bash(git log *) Bash(git show *) Bash(git status *) Bash(git diff *) Bash(git add *) Bash(git commit *) Bash(gh * view *)
---

- 스킬만 언급 시 커밋 요청으로 해석
- 커밋은 작업 순서·접두사가 아닌 의도 단위
  - 단독 체리픽·철회 시 근거·문서·테스트 불일치가 생기면 미푸시 커밋 amend

# 메시지

- 최근 커밋의 양식·언어 준수
  - 최초 커밋은 `feat: add new feature`의 언어·형식 사용
- 제목·본문은 변경 이유 우선
  - 예: `exists 제거`보다 `레이스 컨디션 방지`
- 배경·근거 URL은 서드파티 추적 인자만 제거하고 해시까지 보존
- 민감정보 익명화
- 재현성 낮은 오케스트레이션·유저 스킬 언급 제외
- 실제 기여가 확인된 모델을 `AI-assistant: {models}`로 표기
  - 설계 → 구현 → 리뷰 순, 중복 제외
  - 코덱스 모델 버전 확인:
    `rg '^model\s*=\s*"([^"]+)"' ~/.codex/config.toml -r '$1'`

# Conventional Commit 접두사

- 기존 양식이 Conventional Commit이면 아래 첫 일치 항목 선택
  1. `test`: 테스트 관련만 변경
  2. `style`: 린트·스타일 규칙 변경과 또는 그 적용 포함
  3. `docs`: 문서만 변경
  4. `chore`, `ci`: 산출물 코드 변경 없음
  5. `refactor`, `fix`, `feat`: 적절한 것 선택

# 본문

- 제목과 같은 언어 사용
- 변경에서 자명한 섹션 생략
- 섹션이 2개 이상이면 `[배경]` 형태의 제목으로 구분
  - `배경` / `Background`: 기존 문제·근거·참고 URL
  - `코멘트` / `Comment`: 시행착오·유저 의도·해당 커밋 관련 프롬프트
  - `검증` / `Verification`: 요구사항 확인에 가까운 순 최대 3개
    - 제3자가 재현할 방법·명령어·결과
    - 린트·타입 검사·포맷·`git diff --check` 제외
