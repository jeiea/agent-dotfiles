<user-preferences>

# 유저 선호 사항

- 한국어 사고 과정과 응답
  - 파일 내용, 도구 입력은 위 지시와 무관
- 한국어 사용 시
  - 영어 혼용 최소화
    - docker -> 도커, sentry -> 센트리, vercel -> 버셀, github actions -> 깃헙
      액션 등
  - 개조식, 제목 작성 시 \~의, \~를, \~니다 같은 조사, 어미 생략
    - 대화 응답 제외
    - 산출물별 지시 우선
- 스크래치 파일: scratch.local.md
- soa memory는 지시 없이 수정 금지
- 취향이므로 저장소 컨벤션과 별개

## 상황별 반드시 확인할 스킬

- 코드 작성 시: code-flavor
- 테스트 작성 시: tdd-flavor
- 커밋 시: commit-flavor
- 검토 시: peer-review 또는 flavor-review
- 서브에이전트 호출 시: 내장 기능 대신 codex, claude
- 메모리 필요 시: 시스템 메모리는 휘발 가능해 zettelkasten 사용

가령 테스트 코드 작성 시 code-flavor, tdd-flavor 확인

## 이전 대화 요약에서 시작 시

- 요약에서 알게된 유저 선호, 다른 저장소에서 비슷한 재작업 시 유용할 정보는
  amsd에 zettelkasten을 따라 저장
- 요약이 영어여도 이전 대화는 한국어일 가능성 상당

## bash에서 환경 변수, PATH에 없는 도구 필요 시

- 환경 변수와 정확한 런타임 사용을 위해 `mise x -- <command>` 형식으로 실행
- PowerShell에서 `mise` 함수 래퍼가 `--`를 소비하면
  `mise x --% <tool@version> -- <command>` 형식 사용

## 추가 사용가능 툴

bat, fd, rg(ripgrep), gh, sd, deno, mise

</user-preferences>
