---
name: mini-loop
description: 계획·구현·검토 역할을 분리해 복잡한 작업을 반복 수행. delegate, peer-review, flavor-review, code-flavor 의존
allowed-tools: Skill(delegate) Skill(peer-review) Skill(flavor-review) Skill(code-flavor)
---

# 원칙

- 조율자로서 역할 위임, 응답 수신, 유저 질의, 정정·재작업 직접 조율
- 구현·이후 검토에 계획자 세션 재사용 금지
- 응답 대기 중 시간·탐색량을 이유로 독촉하거나 범위 축소 금지
- 검증 수단 실행을 위해 모든 위임에 쓰기 권한 허용
- 범위 추가 시 code-flavor의 포함 기준 적용 후 계획 갱신
- 필수 아닌 개선점은 발견 단계와 무관하게 상황·재검토 조건만 제안 목록에 기록
  - 현재 작업 목록·완료 조건에서 제외

# delegate 선호 순서

- 계획: `--agent claude --model fable`, `--agent codex --model gpt-6-astra`
- 구현·검토: `--agent codex`

# 절차

합의된 계획, 계획 검토, 구현 여부를 확인해 적절한 단계부터 시작

1. 계획자에게 유저 요구 원문을 전달해 계획 파일 작성 요청
   - 또는 합의된 계획 파일 작성
   - 요구·기존 계약을 만족하는 최소 계획에서 시작
2. 코드 구현 계획이면 다음 기준으로 peer-review
   - code-flavor의 ponytail스러운 최소안이 맞는지
3. 구현자에게 계획 파일 구현과 테스트·린트·정적 검사 요청
4. commit-flavor 후 flavor-review로 계획과 구현 결과 검토
   - 일반 검토 요청 기준에 계획의 적정성 추가
   - 배타적 대안은 요구와 flavor 기준으로 하나만 선택
   - 같은 작업 항목은 검토 결과 반영 후 Must fix now 5개 이상일 때만 재검토
5. 계획의 작업 목록 소진까지 3·4단계 반복
6. 검토·검증 불가 시 사유와 잔여 위험 보고
7. 종료 보고에 제안 목록과 후속 작업 포함
