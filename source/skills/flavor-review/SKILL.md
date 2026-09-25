---
name: flavor-review
description: 직접 구현한 코드 리뷰 시 사용. peer-review 의존
allowed-tools: Skill(peer-review) Skill(commit-flavor) Skill(code-flavor)
---

# 검토 역할

- 일반: 사용자 요구 기준으로 기능 정합성·회귀 검증
  - 필수 수정: code-flavor의 ponytail 규칙 또는 구체적인 중대 피해에 한정
  - 검토 관점: 테스트·문서, 경계 조건·변경 밖 코드·외부 연동, 성능·자원·보안,
    UI/UX·상호 운용·장애 허용·변경 전략
  - 미예측 오류: 소비처에 실패 전달
    - 진단 수단 확보
    - 공통 처리 우선 고려
- 취향: 구현·테스트·커밋의 표현·구성에 대한 취향 준수만 판정
  - 코드·문서·기존 검증 기록의 정적 검토. 정합성 판단·실행 검증은 일반 검토 담당
  - 취향 원문은 산출물 평가 기준. 검토자의 구현·검증 수행 지시로 적용 금지
  - 각 지적에 직접 대응하는 취향 원문 인용
  - 비권고형 위반 → Must fix now, 권고형 위반 → Consider
  - 사소한 제안 포함 최대 10가지

# 절차

1. 검토 대상 확정
   - 미커밋 변경을 commit-flavor로 커밋 후 포함
   - 커밋 불필요 시 완료 후 이전 상태로 복원
2. 위 역할·범위를 위임문에 포함해 각각 peer-review
   - 취향 검토는 변경에 유관 취향이 있을 때만 요청
   - 취향 이름·원문 전달. 커밋이면 commit-flavor 포함
3. 반영 후 commit-flavor로 amend 또는 추가 커밋. `Follow-up`은 통합 보고
