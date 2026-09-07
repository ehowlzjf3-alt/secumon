# ADR 0006 — 출근지(Workplaces): 자체 web 전량 · 등록형 · 디렉토리 분리

- 상태: Accepted (M1)
- 관련: §0(직원의 책상), §3-3, §6, §9, ADR 0001

## 맥락
finding/report를 어디에·어떤 톤으로 보여줄지 결정 필요. 기존 secu-agent-skill에는 도메인별 webapp(SMB :8767 등)이 있으나 다크 바닐라JS라 우리 인사기록부 톤과 충돌하고, 수정은 §6(무수정) 위반. 사용자 요구: 톤온톤·확장성 필수.

## 결정
"출근지(workplace)" 개념 채택:
- **기존 skill webapp 폐기** — 우리 web이 finding/report 표현을 **전량** 담당. (skill 저장소는 무수정 보존하되 webapp은 미사용. 점검 **로직**은 여전히 무수정 재사용 — 엔진/스킬 파드가 데이터 생산.)
- **데이터는 `state_domain` read-only 유일 경로**(M4 Python 게이트웨이). 로직 재구현 아님 = 이미 기록된 데이터의 톤 맞춘 표현.
- **출근지 = 등록형 워크스페이스** — 서술자(`{key, label, domain, accent, icon, employee}`)로 등록. 허브에서 "＋ 출근지 추가"로 등록.
- **제네릭 워크스페이스 엔진 1벌** + **출근지별 디렉토리 분리**(`web/src/workspaces/<domain>/`), skill의 `domains/` 규율 이식.

## 근거
- 톤온톤: 전부 우리 톤 네이티브 렌더(iframe·리스킨 불필요).
- 확장성: 새 도메인 = 디렉토리 1개 + 등록(코드 최소).
- 가벼움: N개 앱이 아니라 제네릭 뷰 1벌 + 서술자·데이터.
- §6 준수: 점검 로직 무수정, 우리는 표현만. §3-3 준수: state_domain 유일 경로.

## 결과
- §9 확정 이동: "기존 webapp 프록시/딥링크 재사용" → **폐기, 자체 렌더**. (원본 웹앱은 필요 시 "심화 운영" 선택적 딥링크로만 후순위 검토.)
- M1: 출근지 허브 + 제네릭 워크스페이스를 **mock**으로 프로토타입. 실 state_domain 연동은 M4.
- 트레이드오프: state_domain 스키마를 따라가는 표현을 우리가 소유(제네릭이라 부담 최소).
- 승격 로드맵: WorkspaceDescriptor는 M2에 `contracts` + control-plane 등록 레지스트리로 승격(현 M1은 web-local mock).
