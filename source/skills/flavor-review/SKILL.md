---
name: flavor-review
description: 직접 구현한 코드 리뷰 시 사용. peer-review 의존
allowed-tools: Skill(peer-review)
---

# 절차

다음 요청을 `peer-review`에 전달

- 일반 코드 검토
  - 요구 충족
  - 오류·모순·누락 여부
  - 핵심 테스트, 문서 반영
  - 회귀, 경계 조건, diff 밖 코드, 외부 시스템 등 잠재 결함
  - 성능, 자원, 오류 처리, 보안
  - UI/UX, 상호 운용성, 장애 허용, 변경 전략
- 변경에 유관 flavor가 있을 때 별도 검토
  - 각 flavor 이름과 원문 전달
  - 각 지적에 근거 flavor 인용
  - 위반 + 비권고형 원문 → Must fix now
  - 위반 + 권고형 원문 → Consider
  - 사소하더라도 최대 10가지 제안

# 재판정 시

- peer-review 검증 후 flavor 지적 판정
  - 위반: 근거 flavor 원문이 권고형이면 `Consider`, 아니면 `Must fix now`
  - 위반 아님: `Consider` 또는 기각
  - 확인 불가: `Follow-up`
- 순 코드 증가로만 해결 가능한 제안: 결함·위반 해소 아니면 기각
