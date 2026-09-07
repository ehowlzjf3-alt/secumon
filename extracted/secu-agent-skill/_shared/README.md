# _shared — 도메인 횡단(cross-cutting) 콘텐츠

특정 도메인(smb/web/services) 하나에 속하지 않고 **여러 도메인이 같이 쓰는** 콘텐츠.
재배치(레이어별 평면 → 도메인 skill 번들) 시 도메인 밖으로 뺀 것.

## 레이아웃

| 디렉토리 | 내용 | 재부착(엔진 복귀) 시 |
|---|---|---|
| `detectors/` | `document_sensitivity.py` (문서 신호 키워드 사전), `sensitive_terms.py` (반도체/경영 민감어휘 사전) | 엔진이 try/except 옵셔널 import — 부재 시 generic 신호만으로 graceful degrade. 복귀 위치: `secu_agent/detectors/`. |
| `skills/` | `samsung_ds_network.md` (사내망 IP 정책, domain=core), `anti_patterns.md` (✓/✗ 행동 박물관, domain=core) | 도메인 무관 참조 skill — 어느 도메인 점검에서도 로드. |
| `config/` | `targets.yaml`(+`.example`) — smb/web/github/jenkins/confluence 타깃이 한 파일에 섞임 | 도메인별 분할 후보지만 현재는 통합 유지. |
| `eval/` | `domain_report_update_after_finding.yaml`, `plan_mode_heavy_review.yaml` — 특정 점검 도메인이 아니라 finding 리포트/plan-mode 동작 검증 | — |
| `tests/` | `test_document_sensitivity.py`(detector 사전), `test_memory_tools.py`·`test_chat_session_skill_inject.py`·`test_cooperative_cancel.py`·`test_delegate_tool.py` (도메인 무관 엔진 동작) | 재부착 전 inert (엔진 패키지 필요). |

## 3축 라벨 메모

- `detectors/*` — 진짜 도메인 데이터(키워드 사전)지만 **어느 도메인에도 안 묶이는 횡단 사전**이라 `_shared`.
- `skills/*` — `domain: core` 명시. 횡단 참조.
- `config/targets.yaml` — 도메인 혼합. 분할은 후속.

> (C) 코어 환원 후보(`operator_tools`/`domain_report_tool`/`entity_tools`)는 `_shared` 가
> **아니다** — 이동하지 않고 루트 `tools/` 에 그대로 두고 `docs/REVIEW-core-candidates.md` 에
> 기록만 한다(엔진 트랙 T4 가 코어 복귀 결정).
