---
name: finding_narrative
description: 기존 finding 의 4부 위험내용을 finding_narrator subagent 로 백필. "finding 위험내용 정리/채워줘" 발화 시 view.
domain: core
when_to_use: 운영팀이 finding 의 위험내용(데이터 정체/발견 방법/악용 경로/확인 방법)을 채워달라고 할 때. 이미 쌓인 finding 의 narrative 백필.
triggers: 위험내용; 위험 내용; finding 정리; narrative; 위험내용 채우; 위험내용 정리; 4부
---

# finding_narrative — entry

이미 DB 에 쌓인 finding(증거/hits/pivot 결과는 있지만 4부 위험내용이 비어있는)에 운영팀이 읽을
위험내용을 채워넣는 워크플로우. 직접 쓰지 말고 **finding_narrator subagent 에 배치 위임**한다
(context isolation + GET-only/마스킹 도구 제한).

## 워크플로우

1. **대상 선별**: narrative 가 비어있는 finding 을 찾는다 — `domain_report` 또는 finding 조회로
   `risk_narrative` 키가 없는 것(특히 confirmed + 고심각도)을 우선. 운영팀이 특정 id 를 지정하면 그것.
2. **배치 분할**: 한 번에 **~10개** finding_id 씩 묶는다(너무 많으면 context 폭주).
3. **위임**:
   ```
   agent(action='run', subagent_type='finding_narrator', input={'finding_ids': [101, 102, ...]})
   ```
   narrator 가 각 finding 을 read → 분석 → `enrich_finding` 으로 4부 위험내용/증거해설/pivot 해석을 채운다.
4. 배치가 많으면 2~3 을 반복(다음 10개). 완료 후 결과 요약.

## 규칙 (narrator 가 강제하지만 operator 도 인지)

- narrator 는 **새 점검을 하지 않는다** — 이미 기록된 증거만 읽고 해석을 채운다(GET-only, record-only).
- **마스킹**: narrative 는 평문 시크릿/PII 값이 아니라 '유형/분류'만 서술. narrator 도구 레지스트리가
  submit_finding/pivot/browser-write 를 미노출해 구조적으로 강제.
- 증거로 못 만드는 항목은 **생략**(가짜 템플릿 금지). UI 는 있는 것만 렌더.

## 신규 finding 은?

web/smb 딥다이브로 **새 finding 을 submit_finding 할 때**는 그 자리에서 `risk_narrative`/`evidence_notes`/
`pivot_interpretation` 를 같이 채워라(narrator 백필은 과거분 보정용). 신규는 발견 맥락이 살아있을 때 쓰는 게 정확하다.
