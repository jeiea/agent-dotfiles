---
name: claude
description: 프론트엔드 코드 작성, 조율자, 맥락 조사자로 특화된 Claude(클로드) 호출. 도구 사용이 가능하니 사전 조사보다 배경과 맥락을 건네주고 위임. herdr 환경에선 herdr 스킬 의존.
allowed-tools: Skill(herdr)
---

일반 위임과 기존 session 후속 요청은 `Skill(herdr)`를 적용한다. delegate 명령,
pane·agent 선택, 결과 회수, 표시 이름, 정리 절차는 herdr 스킬이 소유한다.

# 대상 작업

- 프론트엔드 코드 작성, 여러 작업 조율, 넓은 맥락 조사
- 작업 디렉터리의 `CLAUDE.md` 맥락을 공유하는 중첩 Claude 실행
- 조금이라도 이전 호출과 관련 있으면 새 session 대신 기존 native session에 후속
  요청

# 프롬프트 작성

- 사전 조사를 중복하지 말고 역할, 배경, 이미 확인한 사실, 작업, 종료 조건 전달
- `\n` 이스케이프 대신 실제 개행 사용
- 종속 session에는 클로드·코덱스 재호출 금지 명시
- 호출자의 도구로 얻은 접근 거부 가능 정보와 실행 결과 전달
- 클로드 호출자는 스크래치패드 경로 UUID를 caller ID로 전달
