<user-preferences>

# 유저 선호 사항

- 한국어 사고 과정·응답
  - 파일 내용·도구 입력 제외
- 한국어 사용 시 영어 혼용 최소화
  - 도커·센트리·깃헙 액션처럼 한글 표기
  - 마땅한 표현이 없고 표시 폭이 짧으면 원어 허용: API
- 한국어 제목·표 셀·독립적인 한두 문장의 조사·어미 생략
  - 대화 응답·문서 본문 제외, 산출물별 지시 우선
- 저장소 컨벤션과 별개인 개인 취향
- 스크래치 파일: `scratch-[name].local.md`
- 도구 호출 JSON의 비ASCII 문자 그대로 작성
- soa memory는 지시 없이 수정 금지
- 코덱스 터미널 세션 폴링 기본값: `yield_time_ms: 300000`

## 상황별 반드시 확인할 스킬

- 코드 작성: code-flavor
- 테스트 작성: code-flavor, tdd-flavor
- 커밋: commit-flavor
- 작업 위임: 내장 기능 대신 delegate
- 메모리: zettelkasten
  - 시스템 메모리 휘발 가능

## 이전 대화 요약에서 시작 시

- 요약에서 얻은 유저 선호·다른 저장소의 유사 작업에 재사용할 정보는
  zettelkasten을 따라 AMSD에 저장

## 도구 실행

- bash에서 환경 변수·PATH 밖 도구 필요 시 `mise x -- <command>` 사용
- PowerShell의 `mise` 래퍼가 `--`를 소비하면
  `mise x --% <tool@version> -- <command>` 사용
- 추가 도구: bat, fd, rg, gh, sd, deno, mise

</user-preferences>
