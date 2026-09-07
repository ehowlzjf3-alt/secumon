# 도메인 콘텐츠 추출 플랜 — secu-agent → secu-agent-skill

2026-06-12. 사용자 결정: 엔진(secu-agent)을 도메인-프리 코어로 만들고, 도메인 콘텐츠(점검 플레이북·프롬프트·에이전트 md·도메인 툴 .py·agent_types·키워드 사전)를 이 repo 로 물리 이동.
재부착 plugin API 는 후속 단계 — 도메인 기능의 일시적 상실 허용. 이동은 파일시스템 move + 엔진 repo `git rm`. 패키지 상대구조 보존(재부착이 기계적이 되도록).

원 분석 출처: 별도 세션 플랜 + 메인 세션 보완 3건(아래 Stage 4.5, 커밋 선행, 잔여 트립).

## 레이아웃 (이 repo)

```
agent_types/                              # src/secu_agent/agent_types/
tools/                                # 도메인 .py 만
prompts/                              # 도메인 system_*.txt
agents/                               # 도메인 *.md
skills/                               # 도메인 skill 디렉토리 + service_tasking.md
detectors/document_sensitivity.py     # C.1 추출
engine_extracts/                      # goal_manager 도메인 빌더, ralph 도메인 phase, github_verify.py 등 코드 적출분
docs/                                 # 이 플랜 + 엔진에서 옮겨온 점검 문맥 설계 원자료
tests/                                # 엔진에서 옮겨온 도메인 테스트 (재부착 전 inert)
```

## 단계 (각 단계 후 엔진 repo import 가능 유지, 단계별 커밋)

- **Stage 0** — 베이스라인: 도메인 테스트 사전 식별 grep, import 체크 캡처. (스위트는 직전 1956 green 확인됨)
- **Stage 1** — 순수 leaf 콘텐츠 (Python importer 0): skills 도메인 디렉토리(smb_tasking/github_tasking/confluence_tasking/web_tasking/service_tasking.md), 도메인 prompts(system_smb*·system_web·system_services), 도메인 agents(smb_*.md).
  KEEP: anti_patterns/enterprise_security_policy/evidence_inspection/plan_mode/sandbox_usage/finding_narrative, system_package_sandbox/operator_core/system_operator/system_generic/system_finding_narrator, finding_narrator.md. samsung_ds_network.md 는 내용 보고 결정(사이트 인텔이면 이동).
- **Stage 1.5** — master_tools.py 의 generic 클래스(SessionSearchTool 등) 코어 모듈로 구출 (operator/finding_narrator registry 의존).
- **Stage 2** — `agent/tools/__init__.py` 절단 (단일 import seam): 도메인 import 삭제, 도메인 task_type branch 삭제(by_type → generic fallback: ScanText+SubmitFinding), operator branch 도메인 툴 prune. KEEP branch: package_sandbox/finding_narrator/operator. 검증 D.1.
- **Stage 3** — orphan 이동: agent_types/ 전체, 도메인 tools .py(~22), github_verify.py. + **C.1** document_sensitivity 추출(text_scan lazy import + graceful degrade, detectors/__init__ 재export 제거) + **C.2** url_safety 신규 코어 모듈 추출(validate_url_safe/_is_internal_host/URLSafetyError/_probe_web_resources — pivot.py·browser_tool.py repoint). **url_safety 하드블록(file://·loopback·link-local·metadata·.local)은 안전하중 — 반드시 코어 잔류.**
- **Stage 4** — 표면 de-domain: schema/finding.py task_type Literal→str, agent/cli.py task_type allowlist·도메인 dispatch·smb builder 제거, top-level cli.py 도메인 서브커맨드(task/scan smb/smb/walk/triage/review/cred) 제거, prompts/__init__ candidates dict 정리, pyproject 도메인 전용 의존성(impacket 등) 제거.
- **Stage 4.5 (메인 세션 보완)** — ralph_controller 도메인 batch phase 6종 + goal_manager 도메인 프롬프트 빌더/키워드 테이블 적출 → engine_extracts/. DB 활성 도메인 goal pause 안내. 이유: import 그래프는 깨끗해도 행동(claim churn — 기존 DB 타깃 행을 generic registry 절름발이 subagent 로 소모)과 텍스트(점검 플레이북 상수)가 엔진에 남음.
- **Stage 5 (잔여 트립)** — CONTRACTS.md 도메인 안전 주석 일반화(세부는 이 repo SAFETY-NOTES.md 로), docs/design 점검 문맥 원자료(01/02 리뷰·raw verdicts·digest) 이 repo docs/ 로 이동, 메인 설계문서·README 도메인 운영 표현 정리.
- **Stage 6** — 도메인 테스트 tests/ 로 이동, conftest 정리, 엔진 풀 스위트 green 확인.

## 명시적 scope 제외 (최소 컷)

- **C.3** state.py 도메인 테이블/claim 함수: 추출 안 함 (interleaved DDL + 마이그레이션 — 분리 고위험, inert). 재부착 단계에서 plugin schema hook 으로.
- **C.4** web UI 도메인 대시보드 (web/routes·services 7파일): 남김 — state 만 import, DB 뷰어 축. 원하면 후속 단위.

## 검증 (D절)

- D.1 import 청결성: `import secu_agent.agent.tools` + build_registry_for_task('operator'/'package_sandbox'/'finding_narrator') + 코어 모듈 전체 import OK
- D.2 KEEP 파일 도메인 import 잔류 0 + `grep -rn impacket src/` 0
- D.3 KEEP 파일 공격 텍스트 잔류 0 (도메인 프롬프트/skills/agents/agent_types 부재 확인)
- D.4 기능 스모크: `secu-agent --help/doctor/status`, operator 프롬프트+registry 빌드
- D.5 엔진 풀 스위트 green (도메인 테스트는 이 repo 로 이동됨)

## 엔진 쪽 전제 (완료)

추출 시작 전 엔진 repo 커밋 5건 내려앉힘: e095d4e(v3.79 잔여) → cdc6d97(0c) → 1e288bf(0d) → 546c082(1주차) → 0f42eb7(Slice1). v3.80 트랙 영향: Slice2 는 "fan-out 헬퍼 + 어댑터 프로토콜 + Fake 어댑터"로 재정의, 첫 실활성화·Slice3 측정 게이트는 재부착 후.
