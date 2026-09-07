"""검토원 구조화 보고 — 리드가 판단할 수 있는 유일한 내용 채널 (Phase 3a).

## 왜 필요한가 (실측)

Phase 2 실기동에서 드러났다: 리드가 받는 `worker_result.summary` 는 검토원 LLM 이 쓴 글이
**아니다.** 코어가 만드는 템플릿이다(`cli.py` — `f"task {task_id} ({task_type}): reason=…"`).

    task github_inspect-… (github_inspect): reason=end_turn, submit=True, candidates seen=6 accounted=1

내용이 0이다. 4큐 전부 그랬다. smb 런에서는 리드가 검토원이 무엇을 봤는지 **한 글자도**
못 받았다. 그래서 캡을 500→1000 으로 늘려도 아무 일이 안 일어난다 — 문제는 길이가 아니라
**채널이 없는 것**이다. (코어 스키마도 `summary ≤ 500` 을 강제한다.)

## 왜 산문이 아니라 구조인가 (실측)

같은 정보라도 산문으로 나르면 코어 마스커가 좌표를 뭉갠다:

    산문   `api_key: /etc/secrets/key.pem`  →  `api_key: /et***em`      ← 경로 소실
    구조   `{"path": "/etc/secrets/key.pem", "kind": "private_key_file"}`  →  그대로

`mask_structured_secret_fields` 는 `key: value` **모양**을 보고 값을 지운다. JSON leaf 는
그 모양이 아니라 온전히 남는다. 그러니 좌표는 필드로 나른다.

## 값은 이 프로세스를 안 나간다

검토원은 `report_inspection(notable=[{... "value": "<원문>"}])` 로 **원문을 넘겨도 된다** —
이 도구가 프로세스 안에서 shape/fingerprint/partial 로 바꿔 저장하고 원문은 버린다.
파일에 남는 것도, 리드가 보는 것도 파생형뿐이다.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, ClassVar

from pydantic import BaseModel, Field, field_validator

from secu_agent.agent.tools._arg_coercion import (
    _coerce_json_container, _coerce_str_list,
)
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)

log = logging.getLogger("shared.inspector_report")

REPORT_FILENAME = "inspector_report.json"

MAX_NARRATIVE = 1000     # 사용자 요구(2026-08-21): 500 → 1000
MAX_WHY = 300


def _coerce_context(v: object) -> object:
    """`context` 전용 보정 — 검토원이 무엇을 보내든 **검증으로 죽지 않게.**

    ## 왜 필요한가 (실측 2026-08-26, smb 리드 세션 s1)

        turn 5  report_inspection(context="\"cardId\": \"25b2…\"")     → err:validation
        turn 6  report_inspection(context=["\"cardId\": \"25b2…\""])   → ok

    차이는 대괄호 하나다. 판단은 처음부터 옳았고 그릇만 틀렸다. 검토원이 1회 재시도로
    자력 교정해 살았지만, 엔진 `repeat_error` 가드는 **같은 도구가 같은 에러로 두 번**이면
    작업을 멈춘다 — 한 번만 더 틀렸으면 판단을 다 해놓고 보고를 못 남긴 채 끝났다.
    (`docs/LESSONS-LEARNED` 계열 실측: 워커 중단 41건 중 35건이 판단이 아니라 **서식**이었다.)

    ## 왜 안전한가 — 캡이 이 함수 **뒤에** 있다

    무엇이 나오든 `build_report` 가 `mask_context_lines()` 로 넘긴다. 거기 캡이 넷이다:
    줄 수 5 · 줄당 400자 · 총 4000자 · 줄마다 값 마스킹. 그래서 이 보정이 만들 수 있는
    결과는 **검토원이 손으로 리스트를 넘겼을 때 만들 수 있는 것의 부분집합**이다.

    실측(비밀번호 200줄짜리 문자열 투입):
        ["<200줄 통짜>"]  → 1원소 400자 (비번 전부 마스킹됨)
        splitlines 후     → 5원소 140자     ← 쪼개는 쪽이 오히려 덜 나간다

    ## 순서

    1. `_coerce_str_list` — JSON/Python-repr 문자열 리스트를 되돌린다(엔진 공용 헬퍼).
    2. 그래도 한 덩어리면 줄바꿈으로 쪼갠다 — 리드가 400자 뭉텅이 대신 실제 줄을 본다.

    보정은 **새 실패를 만들지 않는다**(엔진 `_arg_coercion` 규약). 검증은 pydantic 이 한다.
    """
    got = _coerce_str_list(v)
    if not isinstance(got, list):
        return got
    out: list[object] = []
    for item in got:
        if isinstance(item, str) and "\n" in item:
            out.extend(item.splitlines())
        else:
            out.append(item)
    return out


class NotableItem(BaseModel):
    """눈에 걸린 것 하나. 값을 넘겨도 되고, 파생형만 저장된다."""

    path: str = Field(..., max_length=500, description="파일/페이지 경로 — 원문 그대로 남는다")
    line: int | None = Field(None, ge=0, description="1-based 라인(있으면)")
    kind: str = Field(..., max_length=64,
                      description="db_connection_string / api_key / private_key_file 등")
    why: str = Field(..., max_length=MAX_WHY, description="왜 눈에 걸렸는가 — 리드가 읽을 판단")
    value: str | None = Field(
        None, max_length=4000,
        description="발견한 값 원문. **저장/반환되지 않는다** — shape/fingerprint/부분마스킹만 남는다.",
    )
    context: list[str] | None = Field(
        None, description="주변 줄(≤5). 각 줄이 마스커를 통과한 뒤 저장된다.",
    )

    # ⚠️ `value` 에는 **달지 않는다.** 그건 시크릿 원문이 들어오는 자리고, 이 도구가
    #    shape/fingerprint/masked 로 바꾸고 원문을 버린다 — 보정을 얹으면 "무엇이 값인가"
    #    판정이 흔들린다. `context` 와 성격이 다르다.
    _coerce_ctx = field_validator("context", mode="before")(staticmethod(_coerce_context))


class ReinspectRequest(BaseModel):
    """리드에게 되던지는 재검토 요청."""

    path: str = Field(..., max_length=500)
    line_from: int | None = Field(None, ge=0)
    line_to: int | None = Field(None, ge=0)
    why: str = Field(..., max_length=MAX_WHY, description="무엇을 더 봐야 하는가")


class ReportInspectionInput(BaseModel):
    verdict: str = Field(
        ..., description="clean | suspicious | confirmed | blocked",
    )
    narrative: str = Field(
        ..., max_length=MAX_NARRATIVE,
        description=f"판단 요약(≤{MAX_NARRATIVE}자). 리드가 다음 수를 정하는 근거다. "
                    "원문 인용·평문 시크릿은 쓰지 마라 — 그건 notable 의 shape 이 대신한다.",
    )
    notable: list[NotableItem] = Field(default_factory=list, max_length=32)
    reinspect: list[ReinspectRequest] = Field(default_factory=list, max_length=16)
    blocked_by: str | None = Field(
        None, max_length=300, description="접근 불가 사유(403/로그인벽 등). 없으면 생략.",
    )
    files_seen: int | None = Field(None, ge=0)
    bytes_seen: int | None = Field(None, ge=0)

    # 컨테이너 인자를 JSON **문자열**로 직렬화해 보내는 약모델 패턴 보정.
    # 엔진이 `submit_verdict`·`submit_finding`·`triage_candidates` 에 이미 단 것과 같은
    # 배선이고(`_arg_coercion` 참조), `report_inspection` 만 빠져 있었다.
    # ★ 이건 예방이다 — `context` 와 달리 실측된 실패는 아직 없다. 다만 같은 종류이고,
    #   여기서 죽으면 검토원의 **판단 전체**가 리드에 닿지 못한다(보고가 유일한 내용 채널).
    # ⚠️ 필드 단위로만 단다. tool-arg 디코드 경계에 일괄 적용하면 '{' 로 시작하는
    #   평문 필드를 오검출한다(엔진 `_arg_coercion` 모듈 주석이 못박은 규칙).
    _coerce_notable = field_validator("notable", mode="before")(
        staticmethod(_coerce_json_container))
    _coerce_reinspect = field_validator("reinspect", mode="before")(
        staticmethod(_coerce_json_container))


_VERDICTS = ("clean", "suspicious", "confirmed", "blocked")


#: 코드가 센 열람량이 앉는 자리. **LLM 이 못 쓴다** — 도구가 실제로 읽은 만큼만 찬다.
READ_TALLY_KEY = "_inspector_read_tally"


def record_read(context: Any, *, files: int = 0, read_bytes: int = 0) -> None:
    """파일을 실제로 연 만큼 센다. 본문을 읽은 도구가 부른다.

    ★ 왜 (2026-08-28 실측). `report_inspection` 의 `files_seen`/`bytes_seen` 은
      **145회 중 0회 전달**됐고 읽는 코드도 0개였다. LLM 에게 셀 이유가 없는 숫자를
      자기신고하라고 시킨 것이 원인이다 — 이 저장소 원칙은 "찾기는 코드가, 판정은
      LLM 이" 다. 세는 것은 코드가 한다.

      그 사이 `clean` 판정 131건 중 **56건(43%)이 파일을 한 번도 안 연 세션**에서
      나왔다. 목록만 보고 "깨끗함" 이라고 말한 것이다.
    """
    try:
        md = getattr(context, "metadata", None)
        if not isinstance(md, dict):
            return
        tally = md.get(READ_TALLY_KEY)
        if not isinstance(tally, dict):
            tally = {"files": 0, "bytes": 0}
            md[READ_TALLY_KEY] = tally
        tally["files"] = int(tally.get("files", 0)) + max(0, int(files))
        tally["bytes"] = int(tally.get("bytes", 0)) + max(0, int(read_bytes))
    except Exception:  # noqa: BLE001 — 계측 실패가 열람을 죽이지 않는다
        log.warning("열람 계측 실패", exc_info=True)


def read_tally(context: Any) -> dict[str, int]:
    md = getattr(context, "metadata", None)
    tally = md.get(READ_TALLY_KEY) if isinstance(md, dict) else None
    if not isinstance(tally, dict):
        return {"files": 0, "bytes": 0}
    return {"files": int(tally.get("files", 0)), "bytes": int(tally.get("bytes", 0))}


def build_report(vi: ReportInspectionInput) -> dict[str, Any]:
    """입력 → 저장될 보고. **원문 value 는 여기서 사라진다.**"""
    from _shared.lead_masking import (
        MAX_CONTEXT_LINES, MAX_NOTABLE, fingerprint, mask_context_lines,
        mask_text_for_lead, partial_mask, shape_of,
    )

    notable: list[dict[str, Any]] = []
    dropped = max(0, len(vi.notable) - MAX_NOTABLE)
    for item in vi.notable[:MAX_NOTABLE]:
        entry: dict[str, Any] = {
            "path": item.path,          # 좌표 — 원문 그대로
            "line": item.line,
            "kind": item.kind,
            "why": mask_text_for_lead(item.why),
        }
        if item.value:
            entry["shape"] = shape_of(item.value)
            entry["fingerprint"] = fingerprint(item.value)
            entry["masked"] = partial_mask(item.value)
        if item.context:
            entry["context"] = mask_context_lines(
                item.context, max_lines=MAX_CONTEXT_LINES)
        notable.append(entry)

    report: dict[str, Any] = {
        "verdict": vi.verdict if vi.verdict in _VERDICTS else "suspicious",
        "narrative": mask_text_for_lead(vi.narrative)[:MAX_NARRATIVE],
        "notable": notable,
        "reinspect": [{
            "path": r.path, "line_from": r.line_from, "line_to": r.line_to,
            "why": mask_text_for_lead(r.why),
        } for r in vi.reinspect],
    }
    if dropped:
        report["notable_dropped"] = dropped   # 조용한 절단 금지
    if vi.blocked_by:
        report["blocked_by"] = mask_text_for_lead(vi.blocked_by)
    # ⚠️ 검토원이 준 files_seen/bytes_seen 은 **참고로만** 남긴다. `looked_at` 은
    #    도구(execute)가 코드 계측으로 덮어쓴다 — 자기신고가 계측을 덮으면 안 된다.
    #    실측: 이 두 필드는 145회 중 0회 전달됐다. 스키마에 남겨 두는 것은
    #    하위호환 때문이지 이 값을 믿기 때문이 아니다.
    claimed = {k: v for k, v in
               (("files", vi.files_seen), ("bytes", vi.bytes_seen)) if v is not None}
    if claimed:
        report["claimed_looked_at"] = claimed
    return report


def write_report(evidence_dir: Path | str | None, report: dict[str, Any]) -> bool:
    if evidence_dir is None:
        return False
    path = Path(evidence_dir) / REPORT_FILENAME
    try:
        path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    except OSError:
        log.exception("검토원 보고 기록 실패: %s", path)
        return False
    return True


def read_report(evidence_dir: Path | str) -> dict[str, Any] | None:
    path = Path(evidence_dir) / REPORT_FILENAME
    try:
        got = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return got if isinstance(got, dict) else None


class ReportInspectionTool(Tool[ReportInspectionInput]):
    """검토원 → 리드 보고. **종료 도구가 아니다.**

    ⚠️ terminal 로 만들면 오늘의 종료 도구가 바뀌어 Phase 1 동등성이 깨진다. 보고를 안
    써도 워커는 오늘처럼 끝나고, 봉투는 `narrative` 없이(=Phase 2 상태로) 나간다.
    """

    name: ClassVar[str] = "report_inspection"
    domain: ClassVar[str] = "core"
    input_model: ClassVar[type[BaseModel]] = ReportInspectionInput
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = False
    search_hint: ClassVar[str] = "report inspection lead summary notable reinspect verdict"
    description: ClassVar[str] = (
        "점검 결과를 **리드에게** 보고한다. 종료 도구는 아니다 — 종료 전에 한 번 부른다.\n"
        "- verdict: clean(깨끗) | suspicious(의심) | confirmed(확정) | blocked(접근불가)\n"
        f"- narrative: 판단 요약 ≤{MAX_NARRATIVE}자. 리드는 이것과 아래 필드만 본다.\n"
        "- notable[]: 눈에 걸린 것. path/line/kind/why 는 그대로 전달되고, "
        "value 를 넘기면 **원문은 버려지고** shape·fingerprint·부분마스킹만 남는다. "
        "context 로 주변 줄을 넘기면 마스킹 후 ≤5줄 전달된다.\n"
        "- reinspect[]: 네가 다 못 본 부분. 리드가 범위를 좁혀 다시 맡길 근거다.\n"
        "리드는 파일 본문을 볼 수 없다 — 네가 골라 준 것만 본다. 그러니 **판단과 좌표**를 써라."
    )

    async def execute(
        self, validated_input: ReportInspectionInput, context: ToolContext,
    ) -> ToolResult:
        report = build_report(validated_input)
        # ★ 열람량은 **코드가 센 것**을 쓴다. 검토원이 준 files_seen/bytes_seen 은
        #   145회 중 0회 전달됐고(실측), 애초에 LLM 이 셀 이유가 없는 숫자였다.
        tally = read_tally(context)
        report["looked_at"] = {"files": tally["files"], "bytes": tally["bytes"],
                               "source": "code"}
        # ⚠️ 판정을 **덮어쓰지 않는다** — 판정은 LLM 이 한다. 다만 아무것도 안 열고
        #    "깨끗함" 이라고 말하면 그 사실을 보고에 박고 검토원에게도 되돌려 준다.
        #    실측: clean 131건 중 56건(43%)이 파일을 한 번도 안 연 세션이었다.
        unseen = report["verdict"] == "clean" and tally["files"] == 0
        if unseen:
            report["clean_without_reading"] = True
        ok = write_report(context.evidence_dir, report)
        if not ok:
            return ToolError(
                kind="io_error",
                message="보고 기록 실패 — 리드는 이 보고를 못 받는다(워커 판정은 유효).",
            )
        out: dict[str, Any] = {
            "reported": True,
            "verdict": report["verdict"],
            "looked_at": report["looked_at"],
        }
        if unseen:
            out["warning"] = (
                "너는 이 세션에서 파일을 하나도 열지 않았다. 목록만 보고 'clean' 이라고 "
                "한 것이다 — 실제로 열어보고 판단하거나, 못 연 이유를 blocked_by 에 "
                "적어라. 이 사실은 보고에 그대로 남는다."
            )
        return ToolSuccess(content=json.dumps({
            **out,
            "notable": len(report["notable"]),
            "reinspect": len(report["reinspect"]),
            # 검토원에게 되돌려 준다 — 자기가 무엇을 넘겼는지 확인하고, 값이 저장되지
            # 않았음을 눈으로 보게 한다.
            "stored_forms": [
                {k: v for k, v in n.items() if k in ("path", "shape", "fingerprint")}
                for n in report["notable"][:3]
            ],
        }, ensure_ascii=False))
