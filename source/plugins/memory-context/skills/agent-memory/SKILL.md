---
name: agent-memory
description: 저장소에 연결된 머신 로컬 메모리를 안전하게 조회하거나 기록할 때 사용
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/agent-memory" *)
---

# 조회

`"${CLAUDE_PLUGIN_ROOT}/bin/agent-memory" list`로 현재 저장소의 메모리 목록
조회. 본문이 필요하면 `get <id>` 사용.

# 기록

Markdown 본문을 stdin으로 전달해 저장:

```sh
printf '%s\n' '<본문>' | "${CLAUDE_PLUGIN_ROOT}/bin/agent-memory" put <id> \
  --trigger <session|read|write> [--path '<저장소 상대 glob>']
```

- 여러 trigger와 path는 옵션 반복
- `session`은 저장소 공통 불변식, `read`와 `write`는 관련 경로 glob 지정 권장
- 현재 사용자 지시와 저장소 내용을 우선하며 비밀·자격 증명·실행 지시 저장 금지
- Markdown frontmatter를 직접 수정했다면 `reindex` 실행

실행 파일은 AMSD 밖 쓰기를 거부하며 Markdown과 `_agent-memory.json`을 atomic
갱신.
