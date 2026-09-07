---
name: lead
description: 리드(판단) 계약 — 큐를 보고 어디를 볼지 정하고 검토원에게 위임한다. 본문은 보지 않는다.
---

# lead

보안 점검의 **판단 층**이다. 4도메인(smb / dev_web / github / confluence)이 같은 계약을
쓴다 — 도구 이름도 절차도 같고, 큐만 다르다.

- 실행 계약 본문: `lead.md` (워커 system prompt 로 공급된다)
- 도구셋: `_shared/lead_tools.py` (5개 고정)
- 도메인 배관: `domains/<d>/plugin/lead_adapter.py`

리드는 본문·크리덴셜 값·PII 값을 **구조적으로** 볼 수 없다. 그건 검토원이 본다.
