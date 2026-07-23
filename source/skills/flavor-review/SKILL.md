---
name: flavor-review
description: 직접 구현한 코드 리뷰 시 사용. peer-review 의존
allowed-tools: Skill(peer-review)
---

# 절차

다음 요청을 `peer-review`에 전달

- 일반 코드 검토
  - 기본 기준 포함
  - 회귀·경계 조건 등 잠재적 결함
  - 사용자 영향·오류 처리·호환성
  - 성능·자원·안정성·보안
  - 테스트·문서·변경 전략의 충분성
- 변경에 유관 flavor가 있을 때 별도 검토
  - 기본 기준 제외
  - 각 flavor 이름과 원문 전달
  - 각 flavor 항목의 준수 여부와 대안을 폭넓게 제시
  - 각 지적에 근거 flavor 항목 인용
  - 판정 정보 부족·해석 여지: 확인 사항과 함께 `Follow-up`
  - 확인된 위반: `Must fix now`
  - 위반 아닌 개선·취향: `Consider`
