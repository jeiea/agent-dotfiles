---
name: buddy
description: 독립 관점 필요 시 사용. claude, codex 의존
allowed-tools: Skill(claude) Skill(codex) Skill(codex-tools:codex)
---

- 현재 세션이 Codex면 `claude`, Claude면 `codex`(`codex-tools:codex`) 스킬 우선
- 같은 모델 요구 시 같은 모델 스킬 사용
- 전부 곤란하면 서브에이전트 사용 허용
