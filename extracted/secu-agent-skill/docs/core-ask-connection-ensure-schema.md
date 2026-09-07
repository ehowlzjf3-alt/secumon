# CORE-ASK: `connection(namespace, ensure_schema=False)` — 런타임 writer 의 lazy-DDL 회피

> digisecu 세션 발신. #1 눈(skill_quality) read-model 의 codex 적대검증 #6 후속.
> **additive·opt-in** (기본값 = 현행 동작 그대로). 배포 안전 계약을 코드로 못박는 건.

## 배경 / 문제

`PostgresStateAdapter.connection`(postgres_adapter.py:31)은 `skill_*` 네임스페이스에 대해 **매 커넥션마다
`_orch.apply_schema(ns)` 를 호출**한다(lazy 멱등). 이게 "migrator(명시 apply)와 runtime writer(DML)를
분리"라는 우리 배포 계약과 정면충돌한다:

- **hook-first 배포**(명시 migrator 전에 워커가 먼저 뜸): 새 워커 프로세스의 첫 `connection("skill_quality")`가
  `apply_schema` 에 진입 →
  - writer DSN 이 **DDL 권한 보유**면 → 요청 처리 중 `CREATE SCHEMA … / CREATE TABLE …` 실행
    (schema_orchestrator.py:157~, advisory lock). **"명시 apply_schema, lazy 금지" 계약 위반 + race.**
  - writer DSN 이 **DML-only**면 → CREATE 권한 없어 `apply_schema` 예외 → 스킬 quality_events 의
    best-effort try/except 가 삼킴 → **이벤트 조용히 유실**. 게다가 실패 시 `_SCHEMA_READY_NS`(state.py:485)에
    등록 안 되므로(schema_orchestrator.py:183은 성공 후 add) **매 이벤트마다 실패한 CREATE 를 반복 시도**.
- CLI(`quality_events --apply-schema`)로 스키마를 준비해도 그 ready 상태는 **다른 워커 프로세스에 전달 안 됨**
  (`_SCHEMA_READY_NS` 는 프로세스 로컬).

즉 현재는 "runtime writer 가 스키마를 안 만든다"를 코드가 **보장하지 못한다**. 배포 순서에 의존한 암묵 계약뿐.

## ASK: 커넥션에 `ensure_schema` 플래그 (opt-in, 기본 True=현행)

```python
# postgres_adapter.py
@contextmanager
def connection(self, namespace: str = "core", *, ensure_schema: bool = True):
    ns = _orch.validate_namespace(namespace)
    from secu_agent import state
    if ns.startswith("skill_"):
        if ns not in _orch.registered_namespaces():
            raise LookupError(f"persistence namespace not registered: {ns!r}")
        if ensure_schema:                 # ← 기존 동작
            _orch.apply_schema(ns)
        # ensure_schema=False: DDL/validate 스킵 — 명시 migrator 가 이미 provisioning 했다고 신뢰.
        #   미provisioning 이면 이후 SELECT/INSERT 가 42P01 로 실패(호출측 best-effort 가 처리) —
        #   실패한 CREATE 반복이 아니라 깨끗한 fail-safe.
    with state._connect_postgres() as conn:   # core 부트스트랩은 여기서 여전히 선행(무관)
        ...
```

- `state.connection`(state.py:981) 래퍼에도 `ensure_schema` 패스스루.
- `registered_namespaces()` in-memory 등록 확인은 **유지**(search_path 의미 보존). 스킵하는 건
  `apply_schema`(DB DDL/validate) 뿐.
- 이건 quality 전용이 아니라 **범용 코어 capability** — 어떤 스킬 네임스페이스 writer 든 lazy-DDL 을
  opt-out 할 수 있다. migrator/runtime 권한 분리의 코어측 토대.

**스킬측 사용(별도, digisecu 반영 예정):** quality_events INSERT 경로는 `connection("skill_quality",
ensure_schema=False)` 로 열고, DDL 은 오직 명시 `apply_quality_schema()`(→ `apply_schema`)로만.

## (선택) 곁들임: 실패 캐시로 반복 CREATE 방지

`ensure_schema=True` 유지 경로라도, `apply_schema` 실패를 프로세스 로컬로 1회 기억해 **매 커넥션 재시도**를
막는 negative-cache 를 두면 DML-only 오배포 시 로그 폭주/부하를 줄인다(위 ASK 없이도 독립 가치).

## 수용 기준

1. `connection(ns, ensure_schema=False)` 는 `apply_schema` 를 **호출하지 않는다**(mock/spy 로 확인).
   미등록 ns 는 여전히 LookupError.
2. 기본 `ensure_schema=True` 는 byte-for-byte 기존 동작(회귀 없음, 기존 skill_* lazy provisioning 보존).
3. schema 미provisioning + `ensure_schema=False` + SELECT/INSERT → 깨끗한 undefined_table 에러
   (반복 CREATE 시도 없음).
4. 코어 스위트 green.

## 비목표

DB 롤/권한 프로비저닝(운영) · quality 스킬 배선(digisecu) · gateway(자체 ReadOnlyPool 사용, `connection()`
미경유라 무관).
