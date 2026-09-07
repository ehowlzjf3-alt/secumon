# ADR 0001 — 웹 스택: React/TS 풀스택 (paperclip식)

- 상태: Accepted (M0)
- 관련: §4, DISCOVERY-AND-DECISIONS §5

## 맥락
1순위 목표는 "디지털 임직원을 잘 표현"하는 것(리치 UI: 조직도·승인 큐·실시간 상태·메일 스레드). 후보 A(React/TS 풀스택), B(FastAPI+경량 프론트), C(하이브리드)를 표현력·실시간성·언어일원화·자산재사용·계약공유 관점으로 비교.

## 결정
**후보 A**: web·컨트롤플레인·오케스트레이터 호출부를 TypeScript로 통일.
- 프론트: React 19 + Vite 6 + Tailwind v4 + shadcn 패턴 + TanStack Query + react-router 7.
- 백엔드: Express 5 + Drizzle + PostgreSQL.
- 계약: zod 단일 진실원(`contracts/`)을 web·control-plane이 직접 공유.
- 도메인 상태(secu-agent-skill `state_domain` 28테이블) 접근만 **M4에 얇은 Python read 게이트웨이**로 도입(§3-3 유일 경로 준수).

## 근거
- 계약=단일 진실원(§3-3)에서 zod 직접 공유가 가장 강함(C의 OpenAPI→타입 생성보다 드리프트 리스크 없음).
- 언어 이원화 우려는 저비용: 컨트롤플레인이 엔진 코드를 import하지 않고 파드 스펙 주입 + 공유 Postgres + REST로만 붙는다.
- paperclip UI/스키마/**k8s sandbox-provider 드라이버**(TS) 재사용 가능.
- M0~M3는 fake execute + mock 드라이버라 도메인 상태가 없어 순수 TS로 충분 → Python 표면은 정확히 필요한 M4에 도입.

## 결과
- 장점: 표현력·실시간성·계약공유 최상, 자산 재사용.
- 비용: 엔진(Python)과 언어 이원화. 도메인 상태 접근에 M4 Python 게이트웨이 1개 추가.
- 폐기안: B(바닐라JS 확장성 한계), C(계약 드리프트 리스크).
