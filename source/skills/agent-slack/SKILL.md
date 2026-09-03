---
name: agent-slack
description: agent-slack CLI로 Slack(슬랙) 메시지 조회, 검색, 작성, 수정 시 사용
allowed-tools: Bash(agent-slack message get:*), Bash(agent-slack message list:*), Bash(agent-slack search:*), Bash(agent-slack help:*), Bash(agent-slack message compose:*), Bash(agent-slack message draft list:*), Bash(agent-slack message react add:*), Bash(agent-slack message react remove:*), Bash(agent-slack auth:*)
---

# 기본 원칙

- URL, 채널명, `ts`, 워크스페이스 중 무엇이 있는지 먼저 확인
- 워크스페이스가 여러 개면 채널명 사용 시 `--workspace` 사용
- 전체 검색보다 `--channel`, `--after`, `--before`로 범위를 먼저 좁히기

# 메시지 조회

```bash
# 단건 메시지
agent-slack message get "https://workspace.slack.com/archives/C123/p1700000000000000"

# 스레드 전체
agent-slack message list "https://workspace.slack.com/archives/C123/p1700000000000000"

# 채널과 `ts`로 단건 조회:
agent-slack message get "general" --workspace "myteam" --ts "1770165109.628379"
```

# 최근 메시지 확인

```bash
agent-slack message list "general" --workspace "myteam" --limit 20 --resolve-users
```

- 최근 메시지는 시간순으로 반환
- 사람 이름이 중요하면 `--resolve-users` 사용

# 메시지 검색

```bash
# 채널 범위를 좁힌 검색
agent-slack search messages "배포 실패" --channel "alerts" --after 2026-01-01 --before 2026-02-01

# 메시지와 첨부파일 함께 검색
agent-slack search all "incident review" --channel "eng" --limit 10
```

- 검색 결과가 많으면 날짜 범위 또는 작성자 조건 추가
- 첨부 파일이 있으면 로컬 다운로드 경로가 함께 반환될 수 있음

# 메시지 작성

```bash
# 유저에게 초안 전송. 명령어 실행 수락 불필요 (브라우저 편집기, 비대화 환경에선 send와 동일)
agent-slack message compose "general"
agent-slack message compose "https://workspace.slack.com/archives/C123/p1700000000000000" "[배포 알림] ..."

# 슬랙 앱 초안함에 저장, 전송 안 함
agent-slack message draft create "general" "[배포 알림] ..."

# 채널로 전송
agent-slack message send "general" "배포 확인 완료"

# 링크·미디어 미리보기 억제 (send, compose 공통)
agent-slack message send "general" "릴리즈 노트: https://example.com" --no-unfurl

# 스레드 답글 전송
agent-slack message send "https://workspace.slack.com/archives/C123/p1700000000000000" "제가 할게요."

# 메시지 수정
agent-slack message edit "https://workspace.slack.com/archives/C123/p1700000000000000" "오늘 할게요."

# 채널과 `ts`로 수정
agent-slack message edit "general" "수정된 내용" --workspace "myteam" --ts "1770165109.628379"

# 리액션 추가/제거 (emoji: rocket, :rocket:, 🚀 모두 가능)
agent-slack message react add "C123" "complete" --ts "1770165109.628379"
```

- 여러 줄 본문은 `\n` 문자열 대신 본문에 없는 구분자로 인용한 here-document를
  사용해 실제 개행을 한 인자로 전달

## 초안 완료 확인

- `Draft editor` 출력은 유저가 초안 검토 중이라는 의미
- 명령 종료 결과의 `sent: true` 확인. `cancelled: true`면 유저 취소
  - 진행 중 세션을 반환하는 환경에서는 같은 세션 결과를 이어서 확인
- 성공 여부 불명 시 `message get/list/search`로 게시 여부와 `ts` 확인 후 재시도

## 메시지 포맷: 슬랙 mrkdwn

```
- `<https://example.com|표시 텍스트>`
- _기울임_, *볼드*, ~취소선~
- `code`, 트리플 백틱 코드 가능

> 인용

HTML 엔티티 필요 문자: &amp;, &lt;, &gt;

- 채널 멘션: <#C123ABC456>
- 유저 멘션: <@U012AB3CD>
- 유저 그룹 멘션: <!subteam^SAZ94GDB8>
```

# 에러 대응

```bash
curl -fsSL https://raw.githubusercontent.com/stablyai/agent-slack/main/install.sh | sh # 설치
agent-slack auth test # 인증 임포트 및 로그인 유저 확인
agent-slack help message # 도움말 확인
```

- 정확한 채널/메시지 필요 시 채널 ID 또는 메시지 URL을 다시 받습니다.
