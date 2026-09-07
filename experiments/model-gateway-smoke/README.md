# 모델 연결 시험

2026-09-05 · TypeScript 독립 실험 · 제품 코어와 사내 모델 연동은 아직 구현 전

**현재 상태: 사용자 요청으로 이 연결 시험을 종료했다.** 추가 키 탐색·API 호출은 진행하지 않는다. 아래 코드와 결과는 기록으로 보존하며, 다시 시험하려면 사용자의 새 재개 요청이 필요하다. 전체 에이전트 재설계 계획은 유지한다.

**로컬 검증은 통과했고 실제 OpenAI 요청은 첫 호출에서 HTTP 401로 중단됐다.** 두 프로젝트에서 발견한 키는 같은 값이었다. 현재 키로 gpt-4o-mini 사용 권한을 확인하지 못했다. 401만으로 키의 폐기·잘못된 복사 등 정확한 원인을 단정하지 않는다.

## 현재 결과

| 검사 | 결과 |
|---|---|
| `npm run typecheck` | 통과 |
| `npm test` | 로컬 합성 검사 8개 통과 |
| `npm run smoke` | 첫 API 호출 HTTP 401, 자동 재시도 없음 |
| 텍스트·도구 호출·구조화 답변 | 실제 모델 응답 검증은 인증 문제로 막힘 |
| 사내 오픈소스 모델 | endpoint/model/인증 설정 미제공, 미시험 |

[실제 실행 결과](/Users/seunghanee/Documents/secumon/experiments/model-gateway-smoke/smoke-result.json) · [로컬 검증/보존 확인](/Users/seunghanee/Documents/secumon/experiments/model-gateway-smoke/verification.json)

## 실행

현재 호스트의 Node.js v25.8.0에서 TypeScript를 직접 실행한다. Python·PostgreSQL·OpenAI SDK·에이전트 프레임워크는 런타임 의존성이 아니다. 이 실험의 호스트 버전은 제품 지원 버전 선정 결과가 아니다. 개발 의존성은 package-lock.json에 고정했다.

```sh
cd /Users/seunghanee/Documents/secumon/experiments/model-gateway-smoke
npm ci --ignore-scripts
npm run typecheck
npm test
npm run smoke
```

마지막 명령은 실제 OpenAI API 요청을 발생시킨다. 실행당 최대 3회, 각 출력 최대 256 tokens, 각 요청 20초, 재시도 0회다. 첫 오류에서 나머지 단계도 중단한다. smoke-result.json은 가장 최근 실행 결과로 갱신된다. 영구 실행 장부/누적 예산 관리 기능은 제품 코어에서 별도로 구현해야 한다.

`local.settings.json`은 **키가 들어 있는 기존 파일 경로만** 저장하며 gitignore 대상이다. 현재 참조는 `/Users/seunghanee/Documents/app_dev/ai-threat-hunter-masked/.env`다. 원본 `.env`와 과거 프로젝트는 수정하지 않았다. 재시험에는 유효한 키가 설정된 `.env`를 준비하고 이 참조를 지정하면 된다. 키 원문을 채팅·명령 인자에 넣을 필요가 없다.

해당 `.env`의 `OPENAI_API_KEY`와 `OPENAI_BASE_URL` 또는 `OPENAI_API_BASE`를 해석한다. 셸 코드로 실행하지 않는다. base URL이 공식 OpenAI origin인지 확인하고 실제 요청은 `https://api.openai.com/v1/chat/completions`로 고정한다. 사내 모델 키를 이 실행기에 넣지 않는다. 사내 연결 프로필은 별도로 구현/검증해야 한다.

## 시험 내용

1. 합성 요청으로 `READY` 텍스트 응답 확인.
2. `lookup_fixture`를 명시해 function calling 형식과 `SYN-001` 인자 확인. 로컬 dispatcher가 이름·인자를 검증한 뒤 값 7을 반환.
3. tool call ID와 결과를 이어 전달하고 `{ "answer": 7, "evidence_id": "SYN-001" }`를 JSON Schema 형식으로 받는지 확인. JSON 형식뿐 아니라 값과 근거 ID도 코드로 검증.

실제 DB/파일 조회·MCP·사내 자료는 없다. 두 번째 단계는 도구를 **명시한 시험**이므로 자율적인 도구 선택 능력을 입증하지 않는다. 세 단계 성공도 장기 업무 성공률·계획/가설·compact/재개를 입증하지 않는다.

공식 문서는 gpt-4o-mini의 function calling과 Structured Outputs 지원을 설명한다. 실제 이 키의 접근성과 출력 동작은 별도 시험 결과로 판단한다. [모델 문서](https://developers.openai.com/api/docs/models/gpt-4o-mini), [Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

## 사내 모델로 확장할 때

| 검증 축 | 확인할 내용 |
|---|---|
| 연결 프로필 | provider, endpoint, model, 인증 참조, 자료 반출 범위, 제한을 묶어 지정 |
| API 형식 | Chat Completions/Responses 등 wire 형식은 adapter가 변환. ‘OpenAI 호환’ 명칭만으로 통과 처리하지 않음 |
| 구조화 출력 | JSON Schema 지원 여부와 실제 준수율 분리. 미지원 시 제한된 JSON 생성+코드 검증+재요청 예산 평가 |
| 도구 | native tool calling, 병렬 호출, tool 결과 연결을 각각 확인. 미지원 시 검증된 행동 제안 형식을 사용하는 별도 방식 평가 |
| 컨텍스트/기억 | 실제 한도·잘림·다국어 길이·compact 후 의무/근거 복원 확인. 모델의 자체 대화 저장에 코어 상태를 의존시키지 않음 |
| 실패/비용 | refusal·길이 종료·timeout·취소·usage 누락을 구분. 누락 usage를 0으로 간주하지 않음 |
| 품질 | 같은 합성 업무, 근거 기준, 호출/시간/비용 예산으로 모델별 반복 평가 |

이 실험의 `ChatGateway`는 공식 OpenAI endpoint로 제한한 임시 adapter다. 범용 모델 포트나 fallback 전체가 구현된 것은 아니다. 이후 코어는 모델별 capability를 조회하되, 도구 인자·권한·근거·상태 변경·완료 검증을 코드에서 수행한다. 모델 능력이 부족할 때 무제한 재요청으로 보완하지 않는다.

gpt-4o-mini는 여기서 작은 모델의 외부 연결 기준선이다. 사내 오픈소스 모델과 모델 크기/학습/서빙/토큰 처리 방식이 같지 않으므로 대체 검증으로 사용할 수 없다.

이 기록은 [P0-03 선택을 위한 사전 실험](/Users/seunghanee/Documents/secumon/design/03-migration-plan.md)에 해당한다. P0-03 전체 ADR·P1-06 코어 통합은 완료하지 않았고 기존 작업 목록의 상태는 유지한다.

## 사용자 제공 키의 추가 시험

사용자가 후속 메시지로 제공한 별도 키도 2026-09-05에 시험했다. 키는 터미널 echo를 끈 stdin으로 전달했고 원본 .env/local.settings.json을 변경하거나 키를 프로젝트 파일에 복사하지 않았다. `node smoke.ts --key-stdin` 첫 요청에서 HTTP 401로 중단됐으며 후속 호출/재시도는 없다. [추가 실행 결과](/Users/seunghanee/Documents/secumon/experiments/model-gateway-smoke/supplied-key-result.json)를 기존 파일 키의 실패 기록과 분리했다. 타입 검사·로컬 검사 8개도 재통과했다.

`--key-stdin` 모드는 한 줄 입력을 받고 최대 60초 기다린다. 키를 명령 인자로 전달하지 않는다. 터미널 입력을 사용할 때는 호출 측에서 echo를 비활성화해야 한다. 이후 실험에서도 비밀 저장/전달 방식을 별도로 지정하며, 이 옵션은 키 저장 기능이 아니다.
