---
name: flavor-review
description: 직접 구현한 코드 리뷰 시 사용. peer-review 의존
allowed-tools: Skill(peer-review) Skill(commit-flavor)
---

# 절차

1. 검토 대상 확정
   - 미커밋 변경은 `commit-flavor`로 커밋 후 포함
2. 다음을 각각 `peer-review` 요청. 요청마다 검토자 세션 분리
   - 요청 1: 일반 코드 검토
     - 요구 충족
     - 오류·모순·누락 여부
     - 핵심 테스트, 문서 반영
     - 회귀, 경계 조건, diff 밖 코드, 외부 시스템 등 잠재 결함
     - 성능, 자원, 오류 처리, 보안
     - UI/UX, 상호 운용성, 장애 허용, 변경 전략
   - 요청 2: 변경에 유관 취향(flavor) 있을 때 취향 검토. 커밋이면
     `commit-flavor` 포함
     - 각 취향 이름과 원문 전달
     - 각 지적에 근거 취향 인용
     - 위반 + 비권고형 원문 → Must fix now
     - 위반 + 권고형 원문 → Consider
     - 사소하더라도 최대 10가지 제안
3. 재판정 시 순 코드 증가로만 해결 가능한 제안은 결함·위반 해소 아니면 후속
   작업으로 보류
4. 반영 후 `commit-flavor`로 amend 또는 추가 커밋
