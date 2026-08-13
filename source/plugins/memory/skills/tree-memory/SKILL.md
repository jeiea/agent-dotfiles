---
name: tree-memory
description: 유저가 트리 메모리 추가·수정 또는 적용 위치 확인을 지시할 때 사용
---

- 유저 지시 외 임의 추가 금지
- 세션 시작 또는 특정 파일 접근 시 자동 주입
- 정확한 위치는 `soa memory resolve <기존 경로>`로 확인
  - `_memory.md`: 해당 폴더 이하
  - `<name>.memory.md`: 같은 폴더의 `<name>`, `*.<name>`
