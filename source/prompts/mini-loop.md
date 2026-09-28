---
name: mini-loop
description: 구현·검토 역할을 분리해 복잡한 작업을 반복 수행. delegate, report-flavor, commit-flavor, flavor-review, code-flavor 의존
allowed-tools: Skill(delegate) Skill(report-flavor) Skill(commit-flavor) Skill(flavor-review) Skill(code-flavor)
---

# 원칙

- 조율자로서 역할 위임, 응답 수신, 유저 질의, 정정·재작업 직접 조율
- 구현·검토 세션 분리
- 응답 대기 중 시간·탐색량을 이유로 독촉하거나 범위 축소 금지
- 검증 수단 실행을 위해 모든 위임에 쓰기 권한 허용
- 필수 아닌 개선점은 발견 단계와 무관하게 상황·재검토 조건만 제안 목록에 기록
  - 현재 작업 목록·완료 조건에서 제외

# 역할별 delegate

- 구현: `--agent codex`
- 검토: `--agent claude`

# 절차

완료된 단계 확인 후 이어서 시작

1. 유저에게 report-flavor로 예상 변경 공유
   - code-flavor의 ponytail스러운 최소안 고려
   - 신규 파일 3개 이상 예상 시 컨펌 요청
2. 적절한 커밋 단위로 나눠 구현자에게 구현, 테스트·린트·정적 검사 요청
3. commit-flavor 후 flavor-review로 요청·예상 변경·구현 결과 검토
   - 일반 검토 요청 기준에 계획의 적정성 추가
   - 배타적 대안은 요구와 flavor 기준으로 하나만 선택
   - 같은 작업 항목은 검토 결과 반영 후 Must fix now 5개 이상일 때만 재검토
4. 커밋 단위 소진까지 2·3단계 반복
5. 검토·검증 불가 시 사유와 잔여 위험 보고
6. 종료 보고에 제안 목록과 후속 작업 포함
