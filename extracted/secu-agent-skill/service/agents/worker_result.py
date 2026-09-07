"""워커 → 부모 결과 채널(`worker_result.json`)의 **유일한 쓰기 경로**.

## 왜 하나여야 하나

이 파일은 코어 계약상 워커가 부모에게 말할 수 있는 유일한 채널이다 — 부모는 워커
transcript 를 절대 받지 않고 이것만 읽는다(`secu_agent.agent.schema.worker_result`).
그리고 reader 는 **fail-closed** 다: 누락/깨짐/스키마 위반이 전부 실패로 취급돼
해당 타깃의 claim 이 풀린다. 즉 쓰기가 틀리면 "결과가 나빴다"가 아니라 **타깃이
소실된다.**

## 통합 전 상태 (2026-08-20 실측)

`_write_worker_result` 정의가 8개 워커에 **8벌** 있었고, 이 공용 모듈을 쓰는 파일은
1개뿐이었다. 8벌이 서로 같지도 않았다:

  - 5벌: `json.dumps` + `write_text` 로 **손수 기록** → 코어 스키마를 우회한다.
    · 원자성 없음 — crash 시 truncated 파일이 남는다(코어는 tmp+os.replace).
    · clamp 없음 — 음수 카운트·초과 evidence_paths 를 그대로 쓴다.
    · `summary[:500]` 을 각자 손으로 했다(한 곳이라도 빠지면 스키마 위반).
  - 2벌: 코어 `build_worker_result` 위임(정상 경로).
  - 3벌: 침묵 장부(`candidates_seen`/`candidates_accounted`)를 넣으려고 손수 기록.
    ⚠️ 그런데 **코어 빌더가 이미 두 필드를 지원한다** — 우회할 이유가 없었다.

그래서 손수 기록은 얻는 것 없이 원자성·clamp·검증만 잃고 있었다.

## 계약

`build_worker_result` 는 **데이터 유래 필드는 clamp, 코드 유래 모순은 raise** 한다
(빈 summary→placeholder, 500자 절단, 음수→0 / status↔rc 모순은 ValidationError).
후자는 호출부 버그라 삼키지 않는다 — 기존에 코어 빌더를 쓰던 두 워커와 같은 동작이다.
반면 **I/O 실패는 삼킨다**: 죽음을 보고하는 경로에서 디스크 오류로 예외가 나면 부모는
`missing`(=crash 단정)만 보고 원인을 영구히 잃는다.
"""
from __future__ import annotations

from pathlib import Path


def write_worker_result(
    evidence_dir: Path,
    *,
    status: str,
    summary: str,
    findings: int = 0,
    rc: int = 0,
    turns: int = 0,
    tokens_in: int = 0,
    tokens_out: int = 0,
    candidates_seen: int = 0,
    candidates_accounted: int = 0,
    completion_reason: str | None = None,
    evidence_paths: list[str] | None = None,
) -> None:
    """코어 WorkerPool 결과 계약을 원자적으로 기록한다.

    candidates_seen/accounted: v3.90 침묵 장부 — seen>0 & accounted==0 은 clean 이
    아니라 **무해명 침묵**이다. 헌팅 워커(smb/github/confluence/dev_web task)가 채운다.
    """
    from secu_agent.agent.schema.worker_result import (
        build_worker_result,
        write_worker_result as _write,
    )

    result = build_worker_result(
        rc=rc,
        status=status,  # type: ignore[arg-type]
        summary=summary,
        findings_count=findings,
        turns_used=turns,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        candidates_seen=candidates_seen,
        candidates_accounted=candidates_accounted,
        completion_reason=completion_reason,
        evidence_paths=evidence_paths,
    )
    try:
        _write(Path(evidence_dir), result)
    except OSError:
        # 죽음 보고 경로에서 I/O 예외를 올리면 부모는 missing(crash 단정)만 본다.
        # 스키마 위반(ValidationError)은 위에서 이미 올라갔다 — 그건 호출부 버그다.
        pass
