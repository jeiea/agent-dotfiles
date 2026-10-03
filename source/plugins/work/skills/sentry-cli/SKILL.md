---
name: sentry-cli
description: Sentry API와 sentry-cli로 이슈, 이벤트, 스택트레이스 조회 시 사용
allowed-tools: Bash(sentry-cli info:*), Bash(sentry-cli help:*)
---

# 기본 원칙

- 조회는 curl + jq로 API 직접 호출. sentry-cli는 토큰 발급·확인 용도
  - CLI `issues list`는 정렬 불가, 유저·이벤트 수와 스택트레이스 미지원
- 토큰은 `sentry-cli login`이 저장한 `~/.sentryclirc` 사용

```bash
TOKEN=$(awk -F= '/^token/{print $2}' ~/.sentryclirc)
API=https://sentry.io/api/0
```

# org·프로젝트 확인

```bash
sentry-cli info   # 인증, 토큰 스코프 확인

curl -sf -H "Authorization: Bearer $TOKEN" "$API/organizations/" |
  jq -r '.[] | [.id, .slug] | @tsv'

# 이슈 조회의 project 파라미터에 쓸 숫자 ID 확인
curl -sf -H "Authorization: Bearer $TOKEN" "$API/organizations/<org>/projects/" |
  jq -r '.[] | [.id, .slug] | @tsv'
```

# 이슈 조회

```bash
# 30일 영향 유저 수 상위 이슈. sort: user|freq|new|date
# query 생략 시 is:unresolved 기본, 빈 값은 전체
# query 문법: https://docs.sentry.io/concepts/search/ (sort는 문법 외 별도 파라미터)
curl -sf -H "Authorization: Bearer $TOKEN" \
  "$API/organizations/<org>/issues/?project=<project_id>&statsPeriod=30d&sort=user&limit=5&query=" |
  jq -r '.[] | [.id, .shortId, .userCount, .count, .title] | @tsv'

# shortId → 이슈 ID, 웹 링크
curl -sf -H "Authorization: Bearer $TOKEN" \
  "$API/organizations/<org>/issues/?project=<project_id>&query=issue:<SHORT-ID>" |
  jq -r '.[] | [.id, .userCount, .permalink] | @tsv'

# 이슈 최신 이벤트의 스택트레이스 (마지막 프레임이 throw 지점)
curl -sf -H "Authorization: Bearer $TOKEN" \
  "$API/organizations/<org>/issues/<issue_id>/events/latest/" |
  jq -r '.title, (.entries[] | select(.type == "exception") | .data.values[]
    | .stacktrace.frames[-10:][]
    | "  \(.function // "?") (\(.filename // .absPath // "?"):\(.lineNo // "?"))")'
```

- 소스맵 미적용 이벤트는 난독화된 청크 경로만 표시 → 다른 이벤트 또는 릴리스
  소스맵 확인
- 유저에게 이슈 공유 시 `permalink` 사용

# 에러 대응

```bash
sentry-cli login   # 브라우저로 토큰 재발급
```

- 401/403: `sentry-cli info`로 토큰 스코프 확인 (이슈 조회에 `event:read`,
  `org:read`, `project:read` 필요)
- 404: org 슬러그·프로젝트 ID 오타 또는 접근 권한 없음
