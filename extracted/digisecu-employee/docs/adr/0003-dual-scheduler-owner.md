# ADR 0003 — 이중 스케줄러 주인: 하이브리드

- 상태: Accepted (M0)
- 관련: §3-5, DISCOVERY-AND-DECISIONS §7

## 맥락
paperclip의 heartbeat + wakeup 큐와 secu-agent의 자체 스케줄러(60초 폴링 tick + croniter + self-wakeup 도구, 코드온리 cron collector)가 공존. "스케줄링의 주인"을 정해야 함.

## 결정
**하이브리드**:
- 컨트롤플레인(회사)이 파드 **생명·예산·heartbeat**를 관측/제어. wakeup 큐 = 파드 실행 허가 / pause / 예산 정지의 통제 축.
- 파드 **내부**는 엔진 자체 cron/self-wakeup으로 도메인 반복(SMB collector 300s, task loop 등)을 자율 수행.
- 컨트롤플레인은 per-target 점검 cadence를 **재구현하지 않는다**(§1 무수정 / §6 준수).

## 근거
- 은유 정합: "회사가 근무·예산을 통제, 직원이 자기 업무 리듬을 자율 수행".
- 엔진 스케줄러 재구현은 §1(무수정)·§6 위반. 대체(컨트롤플레인이 파드 내부 무력화)는 우회 위험.
- 관측만(파드 완전 자율)은 예산 하드스톱·pause 강제력이 약함.

## 결과
- 컨트롤플레인 heartbeat와 skill 기존 `pipeline_heartbeat`(state_domain)를 분리 유지하되 web에서 합성 표시.
- 예산 초과 시: 컨트롤플레인이 CR spec을 `Paused`로 patch → 오퍼레이터가 파드 스케일 0/삭제(ADR 0002).
