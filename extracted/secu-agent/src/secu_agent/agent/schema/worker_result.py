"""v3.80 Slice0d: worker_result.json 계약 — 워커→부모 유일 결과 채널.

Slice1 WorkerPool 에서 워커(타깃당 subprocess 1개)가 종료할 때 자기
evidence_dir 에 쓰는 종료 보고. 부모 orchestrator 는 워커 transcript 를
절대 받지 않고 이 파일 하나만 읽는다 (컨텍스트 경계).

**fail-closed**: 파일 없음 / 깨짐 / 스키마 위반 = 전부 실패로 취급 —
해당 타깃의 claim 을 해제해 재점검 대상으로 돌린다. `inspection_result.json`
패턴(master_tools.py DelegateFileReviewTool)의 일반화. agent_result.json
(fail-open, 없어도 rc 보고로 성공 처리)과의 비대칭은 의도된 것 — 그쪽은
보조 채널, 이쪽은 유일 채널이라 누락을 성공으로 읽으면 타깃이 소실된다.

status 의미:
- ok:           terminal 까지 정상 완료 (rc=0 강제 — 불일치는 스키마 위반)
- error_budget: 자체 예산(턴/토큰/idle/wall-clock) 소진 — graceful 자체종결,
                부분 결과는 유효
- error_crash:  예외/실패 종료 — summary 에 원인
- error_cancel: 취소 신호(SIGTERM/abort) 수신, grace 안에 기록 성공
- timeout:      워커가 스스로 timeout 으로 분류한 종료. 부모 backstop 발화
                (SIGKILL 등) 시엔 이 파일 자체가 안 써짐 → reader 가
                "missing" 으로 fail-closed (워커가 자기 죽음을 기록할 수
                없는 경우를 status 로 표현하지 않는다).

이 슬라이스는 스키마+reader 선반입 (무동작) — 소비자는 Slice1 WorkerPool.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal

from pydantic import (
    BaseModel, ConfigDict, Field, ValidationError, field_validator,
    model_validator,
)

WORKER_RESULT_FILENAME = "worker_result.json"

# 워커가 쓰는 파일이지만 부모 루프가 매 완료마다 읽는다 — 폭주 워커가
# 거대 파일로 부모 메모리를 잡는 것 방지. summary≤500 계약상 정상 파일은
# 수 KB 면 충분.
_MAX_RESULT_BYTES = 1 * 1024 * 1024
_MAX_SUMMARY = 500
_MAX_EVIDENCE_PATHS = 200
_MAX_DETAIL = 500
_MAX_COMPLETION_REASON = 64

WorkerStatus = Literal[
    "ok", "error_budget", "error_crash", "error_cancel", "timeout",
]

# ── v3.90 후속(CORE-ASK ASK-2): 종료 사유 스키마 승격 어휘 ─────────────────
# 정규화된 completion_reason 의 **권고** 어휘 — 코어가 상수로 소유한다.
# 필드 자체는 free `str | None`(미지값 통과)이라 이 집합은 강제가 아니라
# 소비자(스킬 read-model)가 GROUP BY 할 안정 어휘일 뿐이다. 도메인 writer 는
# 자기 값을 넣어도 reader(extra 아님)가 거부하지 않는다.
#   · timeout 은 스킬/워커측 writer 가 채운다(코어 CLI 경로는 self-timeout
#     을 status 로 안 씀 — 죽으면 파일 자체가 missing 이라).
#   · max_turns 는 코어가 실제로 내보내는 예산-소진 사유(max_tokens 의
#     sibling)라 어휘에 포함한다 — 권고 리스트의 코어측 확장.
COMPLETION_REASONS = frozenset({
    "end_turn", "contract_violation", "max_tokens", "max_turns",
    "cancelled", "timeout", "crash", "no_completion", "unknown",
    "no_work",
})

# 엔진 LoopStopReason(events.py) → 정규화 어휘. 매핑에 없으면 원값을 그대로
# 통과시킨다(미지값 허용) — 정보 손실보다 pass-through 가 낫다.
_LOOP_STOP_TO_COMPLETION = {
    "aborted": "cancelled",   # 워커 budget watchdog(토큰/idle/wall-clock) abort
    "stream_error": "crash",  # LLM stream 실패
    # end_turn / contract_violation / max_tokens / max_turns / no_completion 은 그대로.
}


def normalize_completion_reason(reason: str | None) -> str | None:
    """엔진/워커 종료 사유 → completion_reason 어휘로 정규화.

    None/빈문자열 → None. 매핑에 있으면 치환, 없으면 원값 통과(미지값 허용).
    길이는 clamp(_MAX_COMPLETION_REASON) — Field max_length 와 정합.
    """
    if reason is None:
        return None
    r = str(reason).strip()
    if not r:
        return None
    return _LOOP_STOP_TO_COMPLETION.get(r, r)[:_MAX_COMPLETION_REASON]


def _evidence_path_problem(p: str) -> str | None:
    """evidence path 위반 사유 (None = 정상). 스키마 검증과 빌더가 공유."""
    if not p or "\x00" in p:
        return f"빈/NUL evidence path: {p!r}"
    pp = PurePosixPath(p)
    if pp.is_absolute() or ".." in pp.parts:
        return (f"evidence path 는 evidence_dir 상대경로여야 하고 "
                f"'..' 금지: {p!r}")
    return None


class WorkerResult(BaseModel):
    """워커 1개(=타깃 1개)의 종료 보고.

    extra="forbid": 워커/부모는 같은 설치본에서 spawn 되므로 버전 스큐가
    없다 — 모르는 필드는 계약 드리프트, fail-closed 로 잡는다.
    """

    model_config = ConfigDict(extra="forbid")

    rc: int
    status: WorkerStatus
    summary: str = Field(..., min_length=1, max_length=_MAX_SUMMARY)
    findings_count: int = Field(..., ge=0)
    turns_used: int = Field(..., ge=0)
    tokens_in: int = Field(..., ge=0)
    tokens_out: int = Field(..., ge=0)
    # candidate ledger (침묵 게이트): 관찰 후보 수 / 해명된(제출+기각) 수.
    # seen>0 & accounted==0 = 무해명 침묵 — 부모는 clean 으로 읽으면 안 된다.
    # 구 워커(미기록)는 default 0 — 스키마 하위호환.
    candidates_seen: int = Field(0, ge=0)
    candidates_accounted: int = Field(0, ge=0)
    # CORE-ASK ASK-2: 정규화 종료 사유 — 지금까지 summary 문자열 파싱뿐이라
    # 도메인 워커가 _INCOMPLETE_REASONS 분류표를 복붙해 갖던 것을 스키마로
    # 단일 어휘화. free str(미지값 통과, COMPLETION_REASONS 는 권고). 구 워커
    # (미기록)는 None — 하위호환.
    completion_reason: str | None = Field(
        None, max_length=_MAX_COMPLETION_REASON,
    )
    # candidates 계수의 시맨틱 버전 — 후일 counter 단위 변경 시 소비자가 구/신
    # 데이터를 구분(GROUP BY)하기 위한 신호. None = 미기록(구 워커).
    metrics_version: int | None = Field(None, ge=0)
    evidence_paths: list[str] = Field(
        default_factory=list, max_length=_MAX_EVIDENCE_PATHS,
        description="워커 evidence_dir 기준 상대경로 (예: 'audit.log.jsonl')",
    )

    @field_validator("evidence_paths")
    @classmethod
    def _paths_relative_no_escape(cls, v: list[str]) -> list[str]:
        for p in v:
            problem = _evidence_path_problem(p)
            if problem:
                raise ValueError(problem)
        return v

    @model_validator(mode="after")
    def _ok_requires_rc0(self) -> WorkerResult:
        if self.status == "ok" and self.rc != 0:
            raise ValueError(
                f"status=ok 인데 rc={self.rc} — 성공 주장과 종료코드 불일치"
            )
        return self


@dataclass(frozen=True, slots=True)
class WorkerResultInvalid:
    """fail-closed 판정 — 부모는 이걸 받으면 타깃 claim 해제 (재점검)."""

    reason: Literal["missing", "too_large", "parse", "schema"]
    detail: str
    type: Literal["invalid"] = "invalid"


def build_worker_result(
    *, rc: int, status: WorkerStatus, summary: str,
    findings_count: int = 0, turns_used: int = 0,
    tokens_in: int = 0, tokens_out: int = 0,
    candidates_seen: int = 0, candidates_accounted: int = 0,
    completion_reason: str | None = None,
    metrics_version: int | None = None,
    evidence_paths: list[str] | None = None,
) -> WorkerResult:
    """워커 터미널/except/SIGTERM-grace 경로용 clamping 빌더.

    워커가 죽음을 보고하는 경로에서 보고 자체가 ValidationError 로 사라지면
    부모는 missing(crash 단정)만 보고 원인을 영구 상실한다 — 그래서 데이터
    유래 필드는 거부 대신 clamp 한다: 빈 summary → placeholder, 500자 절단,
    음수 카운트 → 0, 무효/초과 evidence_paths 제외·절단(사실은 summary 에
    표기). status↔rc 모순 같은 코드 유래 오류는 그대로 ValidationError —
    그건 호출부 버그다. Slice1 워커는 직접 생성 대신 이걸 쓴다.
    """
    raw_paths = list(evidence_paths or [])
    clean = [p for p in raw_paths if _evidence_path_problem(p) is None]
    dropped = len(raw_paths) - len(clean)
    truncated = max(0, len(clean) - _MAX_EVIDENCE_PATHS)
    clean = clean[:_MAX_EVIDENCE_PATHS]

    suffix = ""
    if dropped or truncated:
        suffix = f" [evidence_paths: 무효 {dropped}개 제외, {truncated}개 절단]"
    s = (summary or "").strip() or "<no message>"
    s = s[: _MAX_SUMMARY - len(suffix)] + suffix

    # completion_reason 은 데이터 유래 — 거부(ValidationError→결과 유실) 대신
    # clamp. 빈문자열 → None(어휘상 "미기록"과 동일 취급).
    reason = (completion_reason or "").strip()[:_MAX_COMPLETION_REASON] or None
    mv = max(0, metrics_version) if metrics_version is not None else None

    return WorkerResult(
        rc=rc, status=status, summary=s,
        findings_count=max(0, findings_count),
        turns_used=max(0, turns_used),
        tokens_in=max(0, tokens_in),
        tokens_out=max(0, tokens_out),
        candidates_seen=max(0, candidates_seen),
        candidates_accounted=max(0, candidates_accounted),
        completion_reason=reason,
        metrics_version=mv,
        evidence_paths=clean,
    )


def write_worker_result(evidence_dir: Path, result: WorkerResult) -> Path:
    """원자적 기록 — tmp 후 os.replace.

    crash 중 부분 기록된 파일이 truncated-but-valid JSON 으로 읽히는 것
    방지. (부분 기록 자체는 reader 의 parse fail-closed 가 잡지만,
    완전한 파일만 본 이름으로 보이게 해서 그 경로 자체를 없앤다.)
    """
    path = evidence_dir / WORKER_RESULT_FILENAME
    tmp = path.parent / (path.name + ".tmp")
    tmp.write_text(result.model_dump_json(), encoding="utf-8")
    os.replace(tmp, path)
    return path


def read_worker_result(evidence_dir: Path) -> WorkerResult | WorkerResultInvalid:
    """fail-closed reader — 누락/깨짐/스키마 위반 전부 WorkerResultInvalid.

    예외를 던지지 않는다: 부모 as-completed 루프에서 워커 N개 결과를
    연속 처리하므로, 한 워커의 깨진 결과가 루프를 끊으면 안 된다.
    detail 은 전 분기 ≤500자 — 깨진 파일 내용이 부모 audit/컨텍스트로
    역류하는 것 방지.
    """
    path = evidence_dir / WORKER_RESULT_FILENAME
    try:
        size = path.stat().st_size
    except (FileNotFoundError, NotADirectoryError):
        return WorkerResultInvalid(
            reason="missing",
            detail=f"{path} 없음 — 워커가 결과를 못 씀 (crash/SIGKILL/backstop)",
        )
    except OSError as e:
        # 워커 죽음이 아닐 수 있다 (권한/EIO 등 환경 장애) — crash 로
        # 단정하면 환경 장애 시 '전 워커 crash' 오진단 audit 이 된다.
        return WorkerResultInvalid(
            reason="missing",
            detail=f"{path} stat 실패 (환경 장애 가능): {repr(e)[:_MAX_DETAIL]}",
        )
    if size > _MAX_RESULT_BYTES:
        return WorkerResultInvalid(
            reason="too_large",
            detail=f"{path} {size}B > {_MAX_RESULT_BYTES}B",
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError) as e:
        # RecursionError: 중첩폭탄('['*100k 는 1MB 캡 아래) — ValueError
        # 계열이 아니라 따로 잡아야 no-throw 가 유지된다. detail 캡 필수:
        # UnicodeDecodeError 의 repr 은 실패한 bytes 전체를 담는다 (~4MB).
        return WorkerResultInvalid(reason="parse", detail=repr(e)[:_MAX_DETAIL])
    try:
        return WorkerResult.model_validate(data)
    except ValidationError as e:
        return WorkerResultInvalid(reason="schema", detail=str(e)[:_MAX_DETAIL])
