---
name: skill-sharpner
description: 스킬 신규 작성 또는 벤치마킹으로 반복 개선 시 사용
---

사용자 현재 단계 파악 후 필요한 단계부터 진행. 사용자 희망이나 작업 성격에 따라
평가 생략·축소 가능.

# 원칙

- 몇몇 사례보다 다양한 실제 요청에 통하는 규칙 지향
- 효용 없는 지시 제거
- 반복 작업은 `scripts/`로 자동화
- 강제 표현보다 이유 설명

# 1. 의도 확인

아래의 예상을 제시하고 모호하면 컨펌

- 트리거
- 입력
- 출력
- 오류 처리, 의존 도구
- 평가 방법

# 2. 작성 시

## 구조

```text
skill-name/
├── SKILL.md
│   ├── YAML frontmatter: name, description
│   └── 실행 지침
├── scripts/       # 반복·결정적 작업
├── references/    # 필요할 때 읽을 상세 자료
└── assets/        # 출력용 서식·이미지·글꼴
```

- `name`: 기존 스킬 수정 시 이름과 디렉터리명 유지
- `description`: 하는 일과 트리거 상황 모두 기재. 트리거 정보는 본문 대신 여기에
  집중
- 본문: 실행에 필요한 판단과 절차만 기재

## 점진적 공개

1. name, description: 항상 노출
2. `SKILL.md`: 트리거 시 로드, 500줄 이내 권장
3. assets, references: 필요할 때만 로드·실행

- 큰 자료는 `references/`로 분리하고 읽을 조건 명시
- 여러 변형 지원 시 references로 분리
- 출력 형식이 중요하면 정확한 서식과 최소 예시 제공

초안 작성 후 중복, 과적합, 불필요한 강제, 빠진 전제 재검토.

# 3. 평가 설계

실제 사용자가 말할 법한 요청 2~3개 제안 후 사용자 확인. 초기 요청만
`evals/evals.json`에 저장:

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "실제 작업 요청",
      "expected_output": "기대 결과",
      "files": []
    }
  ]
}
```

전체 형식은 `references/schemas.md` 참고. 주관적 품질에 억지 정량 기준 추가
금지.

# 4. 실행과 검토

중간에 끊지 말고 한 흐름으로 진행. 별도 스킬 테스트 명령 대신 아래 절차 사용.

## 결과 생성

스킬 디렉터리 형제 위치에 `<skill-name>-workspace/` 생성:

```text
<skill-name>-workspace/
├── skill-snapshot/                    # 기존 스킬 최초본
└── iteration-N/
    └── <eval-name>/
        ├── eval_metadata.json
        ├── with_skill/outputs/
        └── without_skill/outputs/ | old_skill/outputs/
```

- 하위 에이전트 사용 가능 시 모든 스킬 적용본·기준본을 한 차례에 병렬 실행
- 신규 스킬 기준본: 스킬 없음
- 기존 스킬 기준본: 수정 전 스냅숏
- 디렉터리명은 번호 대신 평가 목적을 드러내는 이름 사용
- 입력 파일과 사용자 관심 산출물을 각 실행 지시에 명시

`eval_metadata.json`:

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name",
  "prompt": "작업 요청",
  "assertions": []
}
```

## 실행 중

- 기다리는 동안 객관적 검증 항목 작성
- `eval_metadata.json`, `evals/evals.json`에 검증 항목 반영
- 검증 항목의 의미와 정성·정량 검토 방법 사용자에게 설명
- 완료 알림의 `total_tokens`, `duration_ms`를 즉시 각 실행의 `timing.json`에
  저장

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

## 채점과 집계

1. `agents/grader.md`에 따라 각 실행 채점. 자동 검증 가능한 항목은 스크립트 사용
2. `grading.json`의 검증 결과 필드는 반드시 `text`, `passed`, `evidence` 사용
3. 스킬 제작기 디렉터리에서 벤치마크 집계:

```sh
python -m scripts.aggregate_benchmark <workspace>/iteration-N --skill-name <name>
```

4. 적용본을 대응 기준본보다 먼저 배치
5. `agents/analyzer.md`에 따라 무의미한 검증, 높은 분산, 시간·토큰 상충 분석

## 사용자 검토

`eval-viewer/generate_review.py`로 정성 결과와 `benchmark.json`을 함께 제공.
별도 HTML 작성 금지.

```sh
python eval-viewer/generate_review.py <workspace>/iteration-N \
  --skill-name "<name>" \
  --benchmark <workspace>/iteration-N/benchmark.json
```

- 화면 없는 환경: `--static <output.html>`
- 2차 이상: `--previous-workspace <workspace>/iteration-(N-1)`
- 사용자가 제출한 `feedback.json`을 작업 공간에 저장
- 빈 피드백은 만족으로 해석. 구체적 불만 있는 사례 우선 개선
- 서버 실행 시 검토 완료 후 종료

# 5. 반복 개선

피드백과 실행 기록에서 원인 일반화:

- 특정 평가에만 맞춘 규칙 대신 재사용 가능한 원리 반영
- 시간·토큰만 쓰는 지시 제거
- 필요한 행동의 이유 전달
- 실행마다 되풀이한 보조 작업은 `scripts/`로 묶기

수정 후 새 `iteration-N/`에서 전체 평가와 적절한 기준본 재실행. 이전 작업 공간을
비교 화면에 연결. 다음 중 하나면 종료:

- 사용자 만족
- 피드백 없음
- 의미 있는 개선 없음

엄밀한 비교 요청 시 `agents/comparator.md`, `agents/analyzer.md`에 따라 출처를
가린 비교 수행.

# 6. 트리거 설명 최적화

스킬 완성 후 필요 시 제안.

1. 실제적이고 충분히 복잡한 요청 20개 작성
   - 트리거 대상과 비대상 균형
   - 비대상은 키워드가 겹치는 근접 사례 중심
   - 길이, 말투, 명시성 다양화

```json
[
  { "query": "사용자 요청", "should_trigger": true },
  { "query": "근접 비대상 요청", "should_trigger": false }
]
```

2. `assets/eval_review.html`의 자리표시자 교체 후 사용자 검토
   - `__EVAL_DATA_PLACEHOLDER__`
   - `__SKILL_NAME_PLACEHOLDER__`
   - `__SKILL_DESCRIPTION_PLACEHOLDER__`
3. 스킬 제작기 디렉터리에서 지원 환경일 때 실행:

```sh
python -m scripts.run_loop \
  --eval-set <trigger-eval.json> \
  --skill-path <skill-path> \
  --model <current-model-id> \
  --max-iterations 5 \
  --verbose
```

현재 세션 모델 사용. 학습 점수보다 보류 평가 점수가 높은 `best_description`
선택. 적용 전후 설명과 점수 보고. 필요한 명령줄 도구 없으면 생략.

# 7. 환경별 조정

- 하위 에이전트 없음: 평가를 순차 직접 실행, 기준 비교·정량 벤치마크·맹검 생략,
  대화에서 정성 검토
- 화면 없음: 검토기를 정적 HTML로 생성
- 읽기 전용 설치본 수정: 쓰기 가능한 임시 위치로 복사
- 패키징 지원 시 `python -m scripts.package_skill <skill-folder>` 실행 후
  `.skill` 경로 제공

환경 차이와 무관하게 초안 → 실제 요청 평가 → 사용자 검토 → 개선 흐름 유지.
