---
name: ntn
description: 노션(Notion) CLI `ntn`으로 노션 페이지와 데이터베이스 조회, 수정
allowed-tools: Bash(ntn whoami:*), Bash(ntn doctor:*), Bash(ntn help:*), Bash(ntn login:*), Bash(ntn pages get:*), Bash(ntn datasources resolve:*), Bash(ntn datasources query:*), Bash(ntn api v1/pages/*), Bash(ntn api v1/data_sources/*)
---

# 원칙

- 설치, 인증 상태 확인보다 요청한 작업을 실행하고 에러 메시지 참고
- 생성, 수정, 삭제성 작업 전 유저에게 변경안을 보여주고 승낙 요청
- 스키마 필요 작업은 먼저 실제 스키마나 현재 페이지 조회
- 페이지 삭제, 휴지통 이동, archive PATCH는 유저가 명시적으로 요청한 경우에만
  실행

# 페이지 작업

```bash
ntn whoami
ntn pages get <page-id-or-url>
ntn pages create --parent page:<parent-page-id> < page.md
ntn pages create --parent data-source:<data-source-id> < page.md
```

- 페이지 수정 전 현재 내용 먼저 조회
- ntn pages는 페이지 속성 설정, 템플릿 확인 불가. 필요 시 ntn api 사용.

# 데이터 소스 작업

```bash
ntn datasources resolve <database-id-or-url> --json
ntn api v1/data_sources/<data-source-id>
ntn datasources query <data-source-id> --limit 20
ntn datasources query <data-source-id> \
  --filter '{"property":"상태","select":{"equals":"진행 중"}}'
```

여러 데이터 소스가 반환되면 제목과 스키마로 고릅니다. URL의 `v=` 값은 보통 뷰
ID입니다.

# API 작업

```bash
ntn api v1/pages/<page-id>
ntn api v1/pages --data '<json-body>'
```

- 속성 타입은 조회한 스키마에 맞추기

```json
{
  "parent": {
    "data_source_id": "<data-source-id>"
  },
  "properties": {
    "Name": {
      "title": [
        {
          "text": {
            "content": "<title>"
          }
        }
      ]
    }
  },
  "children": []
}
```

# 에러 대응

- `command not found`: 설치 또는 PATH 문제로 보고 `pnpm add -g ntn` 등을 안내
- 인증 또는 토큰 에러: `ntn doctor` 실행, 필요 시 `ntn login` 또는
  `NOTION_API_TOKEN` 설정 안내
- 브라우저 로그인 불가: `ntn login --no-browser`를 안내
- `object_not_found`, `unauthorized`, 공유 관련 에러: 대상 접근 권한과 토큰
  종류를 확인
- `data_sources: []`: 데이터 소스 ID를 추측하지 말고 유저에게
  [노션에서 직접 확인](https://developers.notion.com/guides/data-apis/working-with-databases#adding-pages-to-a-data-source)하도록
  안내
- `Unsupported view type`: 뷰 ID 우회 중단, 데이터 소스 접근 권한 먼저 해결
- 불확실 옵션은 `ntn help <command>`로 확인
