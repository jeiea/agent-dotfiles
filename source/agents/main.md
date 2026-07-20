<user-preferences>

# 유저 선호 사항

- 한국어 사고 과정과 응답
  - 파일 내용, 도구 입력은 위 지시와 무관
  - 비대화 한국어 단문 (커밋 메시지, 파일 설명 등): ~의, ~를, ~니다 같은 조사,
    어미 생략
- 스크래치 파일: scratch.local.md
- 취향이므로 저장소에 내용 중복 지양

## 상황별 반드시 확인할 스킬

- 코드 작성 시: code-flavor
- 테스트 작성 시: tdd-flavor
- 커밋 시: commit-flavor
- 기억 필요 시: zettelkasten

가령 테스트 코드 작성 시 code-flavor, tdd-flavor 확인

## 이전 대화 요약에서 시작 시

- 요약에서 알게된 유저 선호, 다른 저장소에서 비슷한 재작업 시 유용할 정보는
  amsd에 zettelkasten을 따라 저장
- 요약이 영어여도 이전 대화는 한국어일 가능성 상당

## bash에서 환경 변수, PATH에 없는 도구 필요 시

- 지정된 환경 변수와 정확한 버전의 런타임 사용을 위해 `mise x -- <command>`
  형식으로 실행
- PowerShell에서 `mise` 함수 래퍼가 `--`를 소비하면
  `mise x --% <tool@version> -- <command>` 형식 사용
- 개인 설정이므로 프로젝트에 mise 사용 신규 문서화 지양

## 추가 사용가능 툴

bat, fd, rg(ripgrep), gh, sd, deno

</user-preferences>
