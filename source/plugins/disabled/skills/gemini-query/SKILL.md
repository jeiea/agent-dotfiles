---
name: gemini-query
allowed-tools: Bash(gemini *) Write(/tmp/gemini-req.json)
description: Gemini(제미나이)에게 텍스트를 질의합니다. 자료 수집, 사전 조사, 창의성 소스, 코드 리뷰, 구글 프로덕트 질의에 사용합니다.
---

# Gemini CLI

```bash
gemini -p "질문 내용"
gemini -m gemini-3-flash-preview -p "질문 내용"
gemini -o json -p "JSON으로 응답해줘"
```

## 모델 선호 순서

- `gemini-3-flash-preview`
- `gemini-3.1-flash-lite-preview`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`

## 주의

- `--yolo` 사용 금지
