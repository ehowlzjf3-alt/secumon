# ADR 0008 — 에이전트 taxonomy · 오케스트레이션 조직 · A2A/DB 통신

- 상태: Accepted (M1, 진행하며 보완)
- 관련: §0, §3-1, §3-5, §3-7, §3-8, ADR 0002·0007
- 배경: 사용자와 조직/에이전트 모델 합의.

## 결정
**1. 임직원 vs 잡 구분 — LLM 판단 유무:**
- **디지털 임직원(LLM·persona 있음)**: 도메인 **오케스트레이터**(매니저), **전략 에이전트**(도메인별 타깃 전략), **워커**(task/report/reply-verify — 엔진 v3.85+ 어휘, 구 hunt→task), **조직기능 임직원**(HR 등).
- **잡/도구(코드전용, LLM 없음)**: **collector**(enumerate·list·walk). 오케스트레이터·전략 에이전트가 **수행하는 잡** — 조직도에 "직원" 아님.

**2. 조직도 = 오케스트레이션 트리:**
```
보안운영팀장 (사람)
├─ HR 담당 (채용·배치·해고 · 회사 단위 · 승인 게이트)
└─ <도메인> 오케스트레이터
     ├─ 전략 에이전트 (도메인 타깃 전략 · collector 잡 수행)
     ├─ task 워커 · report 워커 · reply-verify 워커  (온디맨드 fresh · 워커 재사용 금지)
     · collector = 도구/잡
```
HR은 회사 단위(도메인 교차), 전략 에이전트는 **도메인별**(오케스트레이터 하위).

**3. 통신 — 두 평면:**
- **제어/오케스트레이션 = A2A**: 담당자↔워커 위임·start/pause·상태/heartbeat·워커 디스커버리. 신규 설계.
- **데이터/작업 핸드오프 = DB 큐(state_domain) + claim lock**: collector→task→report→reply. durable, 크로스워커 중복 방지(§3-8). A2A로 대체하지 않음.

**4. 워커 lifecycle:** 작업 할당 시 **온디맨드 fresh 실행**(요청마다 새 파드/Job 또는 상시 러너 내부 spec당 새 subprocess). **생명·예산은 컨트롤플레인 소유**(§3-1 하이브리드). 담당자는 위임/제어만.

> **정정(M3 발견):** 최초 "핫 스타트(warm pool)"로 적었으나, **엔진(secu-agent)은 warm process pool을 금지**한다(worker_pool.py — SSO 서킷브레이커/lockout이 **프로세스 사망 시에만** 리셋되므로 워커 재사용은 상태 누수·안전 위험). 따라서 "1 spec = fresh 프로세스"가 KEEP 불변식이며, 여기서 warming은 **노드/이미지 pre-pull(scale-from-zero 빠른 기동)** 만 허용한다. 프로세스/워커 재사용(warm pool)은 금지. KEDA 등 진짜 scale-to-zero는 M3 과다범위(후순위).

**5. HR 에이전트:** hire/place/terminate = 컨트롤플레인 lifecycle 호출·제안. 위험 행동(해고·실채용)은 **승인 게이트** 뒤(사람 승인). → 플랫폼 관리 기능이 디지털 임직원으로 personify.

## 결과
- **§decision-6 갱신**: "1임직원=1파드" → **"1도메인 = 오케스트레이터 + N 워커 파드(+전략), A2A 제어 + DB 데이터"**.
- 실 A2A·온디맨드 fresh 워커·에이전트 런타임 = **M3+**. **M1 = 조직도를 이 taxonomy로 mock**.
- 진행하며 보완(워커 세밀도·명명·조직기능 확장 등).
