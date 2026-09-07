# CORE-ASK: platform.devops_target `last_hunt_at → last_task_at` 리네임 미적용 (github SSO 완주 블로커)

> digisecu 세션 발신. **github SSO-task 워커 실행 즉시 claim 단계에서 죽는 블로커.** platform 소유
> 테이블이라 스킬이 손대면 P2 W2 락스텝 위반 → **코어(platform 마이그) 소관.** additive·멱등.

## 증상 (라이브)

github SSO-task 워커 1타깃 실행 → **claim 단계에서 즉사**:
```
psycopg.errors.UndefinedColumn: column "last_task_at" does not exist
LINE 1: ...claimed_at < $5)) AND (cycle_scanned_at IS NULL OR last_task_...
  at state_domain.devops_target_claim_next (skill) → devops_target 클레임 SQL
```
- 워커는 뜨지도 못함(0 turn) — 부모 fanout 이 `claim_next` 에서 예외 → PlanCompleted 없이 크래시.
- **전 devops_target 클레임 공통**(github SSO + confluence SSO 둘 다 이 테이블).

## 근본 원인 = 코어 platform 마이그 갭 (구 DB 컬럼 리네임 누락)

라이브 확인:
```
devops_target (schema=platform) 컬럼: [..., last_hunt_at, ...]   # 구 이름 잔존
  has last_hunt_at: True    has last_task_at: False
```
- 코어 canonical DDL 은 이미 `last_task_at`(`secu-agent/src/secu_agent/state.py:579`). → **신규 DB 는 정상.**
- 코어 부트스트랩 마이그 블록(`state.py:868-878`)은 형제 리네임을 함:
  `hunter→agent_type`(:872), `finding_lifecycle.hunt_type→task_type`(:876). **그러나
  `devops_target.last_hunt_at → last_task_at` 리네임이 없다.** → 구 DB(이 라이브)는 영영 last_hunt_at.
- 스킬은 자기 소유 테이블만 수렴 리네임함(`state_domain.py:977-981`: dev_web_target/web_target_domain).
  devops_target 은 **platform 소유라 스킬이 의도적으로 제외**(P2 W2 락스텝, `state_domain.py:771` 주석).
  → 그래서 platform.devops_target 은 코어가 안 하면 아무도 안 한다.

## ASK (최소·멱등, 형제 마이그와 동일 패턴)

코어 platform 마이그 지점(`state.py:868-878` 형제 리네임 옆, 또는 platform R2-1 마이그 블록)에
**스키마 한정** 멱등 가드 리네임 추가:
```python
try:
    raw.execute("ALTER TABLE platform.devops_target RENAME COLUMN last_hunt_at TO last_task_at")
except Exception:
    pass  # 이미 리네임/부재 → 무시 (RENAME 은 IF EXISTS 미지원, 형제 :870-878 와 동일 격리)
```
- search_path 이 core 라(`state.py:867`) **반드시 `platform.` 한정**.
- 스킬의 dev_web_target/web_target_domain 리네임(`state_domain.py:979`)과 동일 패턴 — devops_target 만
  platform 소유라 코어에 있어야 한다.
- 부트스트랩 시 1회 적용 → 이 라이브 DB 수렴. 신규 DB 는 이미 last_task_at 이라 무영향(멱등).

## 함의 / 범위
- github SSO-task + confluence SSO-task 완주의 **선결 조건**(claim 자체가 안 됨).
- confluence keyword_search 는 별도 테이블(confluence_search_target)이라 무관 — 이미 완주 확인됨.
- (권고) 같은 hunt→task 리네임 시대의 **다른 platform 테이블에 last_hunt_at 잔존이 더 있는지** 감사
  (예: 다른 SSO/devops 계열). 있으면 같은 가드 일괄.

## 수용 기준
1. 부트스트랩 후 `platform.devops_target` 에 `last_task_at` 존재, `last_hunt_at` 부재(멱등 재실행 안전).
2. 신규 DB(이미 last_task_at) 회귀 없음.
3. 라이브 재현: github SSO-task 워커가 claim 성공(UndefinedColumn 소멸) → 실행 진입.
4. 코어 스위트 green.

## 비목표
- 스킬측 배선(digisecu — 없음, 클레임 SQL 은 이미 last_task_at 기대) · github 워커 로직 · ④/② (별건, 머지됨).
