"""submit_finding — agent의 종료 도구. evidence_dir/finding.json 작성."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, ClassVar

from pydantic import BaseModel, ValidationError, field_validator

from secu_agent.agent.candidate_ledger import record_candidates_accounted
from secu_agent.agent.evidence_judgment import (
    browser_verification_exempt,
    browser_verification_required,
    judge_task_finding,
)
from secu_agent.agent.finding_followup import FindingSignal, append_finding_signal
from secu_agent.agent.harness.submissions_log import record_submission
from secu_agent.agent.finding_provenance import with_agent_provenance
from secu_agent.agent.schema.finding import TaskFinding
from secu_agent.agent.tools._arg_coercion import _coerce_json_container
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from secu_agent.detectors.text_scan import mask_deep, mask_scanned_text
from secu_agent.finding_taxonomy import canonical_task_type

# F3: 영속 표현에서 verbatim 유지할 비민감 라우팅/식별 필드(enum·짧은 식별자).
# location/target 등 URL 은 마스킹 대상(자격증명-in-URL 만 마스킹, 호스트는 보존됨).
_PERSIST_PRESERVE_KEYS = frozenset({
    "task_type", "task_id", "category", "kind", "severity", "verdict",
    "asset_kind", "charter_ref", "fingerprint", "finding_id",
})


class SubmitFindingInput(BaseModel):
    finding: TaskFinding

    # gauss/gpt-oss 가 중첩 객체 finding 을 JSON **문자열**로 직렬화해 보내는
    # 패턴 보정('{'-접두만 시도, 평문/파싱실패는 원문 보존 → 검증은 pydantic).
    # submit_verdict 의 container 필드들과 동일 배선 — 라이브 확인: 미보정 시
    # validation ×2 → repeat_error_halt 로 워커가 finding 0 으로 죽는다.
    _coerce_finding = field_validator("finding", mode="before")(
        staticmethod(_coerce_json_container)
    )


def _gate_override_reason(finding: object) -> str:
    """에이전트가 규칙 거부를 뒤집으며 남긴 근거. 없으면 빈 문자열.

    `finding.extra["gate_override"]["reason"]` 에서 읽는다 — 도메인 도구가 근거 길이를
    검사한 뒤 찍는 도장이다. 코어는 **있는지만** 본다: 무엇을 충분한 근거로 볼지는
    도메인 정책이고, 여기서 다시 판단하면 정책이 두 곳에 생긴다.
    """
    try:
        extra = getattr(finding, "extra", None) or {}
        got = (extra.get("gate_override") or {}).get("reason") or ""
    except Exception:  # noqa: BLE001 — 도장 읽기 실패가 제출을 죽이지 않는다
        return ""
    return str(got).strip()


class SubmitFindingTool(Tool[SubmitFindingInput]):
    name: ClassVar[str] = "submit_finding"
    domain: ClassVar[str] = "core"
    description: ClassVar[str] = (
        "확인된 finding 하나를 기록한다.\n"
        "**여러 대상(사이트/호스트)을 순차 점검 중이면 대상마다 호출하고, 호출 후에도 "
        "멈추지 말고 다음 대상으로 계속 진행하라** — submit_finding 은 작업 종료 신호가 "
        "아니라 'finding 1건 적재'다. (단일 task sub-agent 에서만 1회 호출 후 종료)\n"
        "필수: task_type, severity, summary, hits. task_id 는 안 줘도 자동 생성.\n"
        "**target = 이 finding 을 발견할 때 조사 중이던 대상**(점검한 사이트/호스트/공유). "
        "발견된 hit.location 과 다를 수 있다 — 예: site-A 점검 중 그 robots.txt 에서 외부 "
        "host-B 참조를 발견하면 target=site-A, hit.location=host-B. 리포트에서 '어느 대상 "
        "점검 중 나왔나'(도메인) 와 '무엇이 발견됐나'(발견사항) 를 구분하므로 꼭 채워라.\n"
        "각 hit 필수: category, kind, location (발견 위치 — URL/파일경로). "
        "민감값은 masked 에 마스킹해 넣고, location 은 반드시 채운다.\n"
        "severity는 가장 심각한 hit 기준. hits에는 진짜 노출만 — false positive 제거 후.\n"
        "**이메일·이름·사번 같은 단순 ID 만(비밀번호/토큰/주민번호·카드·계좌 동반 없이) 노출, "
        "또는 자동차 번호/차량 번호판만 노출된 경우는 finding 아님 — "
        "OSS 라이선스·저작권·README·AUTHORS 의 연락처 이메일, commit author 이메일은 finding 아님 — "
        "제외하라.** 주민번호/카드/계좌/전화, 또는 실제 secret/credential/공정·경영자료 노출만 보고한다.\n"
        "**summary 와 recommended_actions 는 반드시 한국어로 작성** — 운영팀이 finding "
        "화면에서 바로 읽고 조치한다. summary = 어떤 부분이 왜 위험한가 (노출 내용 + 악용 "
        "시나리오). recommended_actions = 구체적·실행가능한 조치 목록 (한국어, 우선순위 순, "
        "추상적 표현 금지).\n"
        "베이스 category: secret, pii, credential, web_vuln, misconfig, internal_system, "
        "attack_surface (+ plugin 이 등록한 도메인 분류 — skill 가이드 참조). "
        "민감정보·기밀자료는 masked 또는 preview 증거가 필요하고, web_vuln/exposed_file은 "
        "HTML fallback 이 아닌 실제 본문 증거가 필요.\n"
        "**파일/저장소의 secret/credential 은 반드시 deep-dive 후 제출**: scan_hits/"
        "필드명/`value_present`는 후보일 뿐이다. 원문을 읽고(도구는 해당 도메인 skill "
        "가이드 참조) 실제 값이 있는 key=value/PEM 라인을 "
        "마스킹해 hit.preview/masked에 넣어라. URL/host와 id/pw/token 조합이 같이 있으면 "
        "read-only GET 또는 로그인-form endpoint 한정 POST 검증 결과를 hit.validation "
        "(credential_reachability)에 포함하라. 값이 빈 password 필드, 드라이버 템플릿, "
        "단순 옵션명은 제출 금지."
    )
    input_model: ClassVar[type[BaseModel]] = SubmitFindingInput
    search_hint: ClassVar[str] = "submit finding finalize verdict terminate"
    is_read_only: ClassVar[bool] = False

    async def execute(self, validated_input: SubmitFindingInput, context: ToolContext) -> ToolResult:
        try:
            f = validated_input.finding
        except ValidationError as e:
            # ⚠️ f 가 없다 — 장부에 적을 finding 정보 자체가 없는 유일한 경로다.
            record_submission(
                context.evidence_dir, tool=self.name, exit_path="validation_error",
            )
            return ToolError(kind="validation", message=str(e))

        def _log(exit_path: str, judgment: Any = None) -> None:
            """제출 시도를 장부에 남긴다. **모든** return 앞에 하나씩.

            예전엔 거부되면 아무 파일도 안 남았다 — 거부 return 이 finding.json
            경로를 정하는 줄보다 위라서(실측: 거부 run 172개 중 143개에 finding.json 없음).
            """
            record_submission(
                context.evidence_dir,
                tool=self.name,
                exit_path=exit_path,
                verdict=getattr(judgment, "verdict", "") or "",
                reason_code=getattr(judgment, "reason_code", "") or "",
                should_persist=getattr(judgment, "should_persist", None),
                task_type=f.task_type,
                asset=f.hits[0].location if f.hits else (f.target or f.task_id or ""),
                hit_categories=[h.category for h in f.hits],
                hit_outcomes=[o.to_dict() for o in getattr(judgment, "hit_outcomes", ())],
                override_present=bool(_gate_override_reason(f)),
            )
        # 정책 A 강제: SSO/web finding 대상 호스트를 browser 로 실제 열어본 적 없으면 거부.
        # 키워드 스캔/probe 만으로 finding 올리던 오탐(#27 plam = 실제 '권한 없음'인데
        # 소스 키워드만 매칭) 차단. browser_action(navigate)/browser_query 가 방문 host 를
        # ctx.metadata['_web_browser_hosts'] 에 기록한다.
        # v3.82 U3a: 대상 task_type 은 plugin 이 register_browser_verified_task_type 으로
        # 등록한다 (구 하드코딩: web/devops/github/confluence — SSO 점검 plugin 소유).
        # ⚠️ "API-스캔 finding 은 asset 이 비-URL 이라 host 없음으로 자동 면제" 라고
        # 적혀 있던 자리다. **거짓이었다** (2026-08-27 실측): `_host_of` 는 스킴 없는
        # 어떤 문자열이든 첫 세그먼트를 호스트로 만들어낸다 —
        #   'DataService/hue-customization'     -> 'dataservice'
        #   'desktop/core/src/desktop/views.py' -> 'desktop'
        # 그래서 그 면제는 target 과 **모든** hit.location 이 빈 문자열일 때만 발동했고,
        # location 은 사실상 필수 필드라 실무에서 한 번도 안 걸렸다. github repo 스캔
        # 워커는 존재하지 않는 호스트('dataservice')를 브라우저로 열라는 요구를 받고
        # 제출 14건이 14건 다 죽었다.
        # 면제는 이제 등록형이다 — 판단 근거는 자산 문자열이 아니라 **수집 방식**이고,
        # 그건 도메인이 안다(evidence_judgment.register_browser_verification_exemption).
        if browser_verification_required(f.task_type) and not browser_verification_exempt(
            f, context,
        ):
            gate_err = _require_browser_verification(f, context)
            if gate_err is not None:
                _log("browser_gate")
                return gate_err
        judgment = judge_task_finding(f)
        override = _gate_override_reason(f)
        if judgment.verdict == "rejected" or (
            judgment.verdict == "suspected" and not judgment.should_persist
        ):
            # ★ 규칙 거부를 **에이전트가 뒤집을 수 있다** (2026-08-27).
            #
            #   판정 주체는 LLM 이다. 에이전트가 본문·경로·HEAD 생존을 보고 "진짜 유출"
            #   이라 판단했는데 정규식이 거부해 사라지면, 그건 최종 판정권이 규칙에
            #   있다는 뜻이고 "verify 는 LLM 이 한다" 와 모순이다.
            #
            #   ⚠️ 규칙을 없애지는 않는다 — 실적이 있다(실험 오탐 149건 중 142건 차단).
            #      거부는 그대로 하되, 근거를 단 뒤집기만 통과시킨다. 근거 요구는
            #      도메인 도구가 한다(길이·문구 정책은 도메인 소관).
            if not override:
                actions = "; ".join(judgment.required_actions)
                suffix = f" next: {actions}" if actions else ""
                _log("judgment_rejected", judgment)
                return ToolError(
                    kind="validation",
                    message=(
                        "evidence judgment rejected finding submission: "
                        f"{judgment.verdict} — {judgment.reason}.{suffix}"
                    ),
                )
        out_path = context.evidence_dir / "finding.json"
        try:
            payload = f.model_dump(mode="json")
            payload["evidence_judgment"] = judgment.to_dict()
            if override:
                # ⚠️ 뒤집은 사실을 남긴다. 안 남기면 나중에 "규칙이 맞았나 LLM 이
                #    맞았나" 를 되짚을 수 없고, 그게 규칙을 고칠 유일한 재료다.
                payload["evidence_judgment"]["overridden_by_agent"] = override
            # F3: 판정은 이미 raw 로 끝났다(정확도 유지). 여기부터는 **영속 표현**이므로
            # 재귀 마스킹 — 모델이 masked/preview/summary 등에 넣은 평문 PII/secret 이
            # finding.json 에 남지 않게 한다. 비민감 라우팅 필드는 preserve.
            payload = mask_deep(payload, preserve_keys=_PERSIST_PRESERVE_KEYS)
            out_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as e:
            _log("io_error", judgment)
            return ToolError(kind="io_error", message=str(e))
        if not judgment.should_persist:
            record_candidates_accounted(
                context.metadata, bucket="submitted", count=max(1, len(f.hits)),
            )
            _log("nonpersist_success", judgment)
            return ToolSuccess(
                content=(
                    f"finding.json written ({len(f.hits)} hits, severity={f.severity}); "
                    f"no lifecycle finding ({judgment.verdict}: {judgment.reason})"
                ),
            )
        try:
            from secu_agent import state

            asset = f.hits[0].location if f.hits else f.task_id
            asset_kind = _asset_kind_from_location(asset) if f.hits else "task"
            # v3.74: 'devops' 등 umbrella task_type 을 자산기준으로 정규화(github/confluence/
            # jenkins). 게이트는 위에서 원본 task_type 으로 이미 통과 → 회귀 없음. 저장/리포트
            # 만 canon 으로 태깅돼 confluence 자산은 confluence 탭, github 자산은 github 탭.
            canon_task_type = canonical_task_type(f.task_type, asset)
            extra = f.model_dump(mode="json")
            extra["evidence_judgment"] = judgment.to_dict()
            extra = with_agent_provenance(extra, context.metadata)
            # F3: DB 영속 전 재귀 마스킹(finding.json 과 동일 경계). fingerprint 는
            # 아래 raw asset/category 로 별도 계산되므로 dedup 무영향.
            extra = mask_deep(extra, preserve_keys=_PERSIST_PRESERVE_KEYS)
            # 같은 asset 에서 성격이 다른 발견(category 다름)만 개별 finding 으로 유지.
            # discriminator = hit category 집합 (kind 제외 — 모델이 같은 데이터에
            # contact_info/person_name 처럼 kind 만 다르게 붙여 중복 생기던 문제).
            discriminator = "|".join(sorted({h.category for h in f.hits}))
            fp = state.finding_fingerprint(
                task_type=canon_task_type, asset=asset, asset_kind=asset_kind,
                discriminator=discriminator,
            )
            finding_id, created = state.finding_upsert(
                task_type=canon_task_type,
                asset=asset,
                asset_kind=asset_kind,
                severity=f.severity,
                summary=mask_scanned_text(f.summary),  # F3: DB summary 컬럼 마스킹
                fingerprint=fp,
                evidence_ref=str(out_path),
                extra=extra,
            )
        except Exception as e:
            _log("io_error", judgment)
            return ToolError(kind="io_error", message=f"finding lifecycle write failed: {e}")
        # de-domain v3.84 #3: finding enrichment(구 pivot — 라이브 내부 표면 GET probe)은
        # 등록형. 코어는 등록된 enricher 를 순회 호출만 하고 도메인 로직(URL 표면 추출/
        # probe)은 모른다. record-only, 실패해도 finding 자체는 성공. 등록 없음=enrichment
        # 없음(도메인-프리). enricher 는 blocking 가능 → to_thread offload.
        pivot_exposed = 0
        try:
            from secu_agent.agent.finding_enrichment import (
                ENRICHMENT_META_KEYS, run_finding_enrichers,
            )

            hits_for_enrich = [h.model_dump(mode="json") for h in f.hits]
            enrichments = await asyncio.to_thread(
                run_finding_enrichers,
                asset=asset, summary=f.summary, hits=hits_for_enrich,
            )
            for enr in enrichments:
                # descriptor(모두 optional) — 미선언 구 enricher 는 pivot 기본값 보존.
                slot = str(enr.get("slot") or "pivot")
                payload = enr.get("payload")
                if payload is None:  # payload 미선언 → 메타키 뺀 나머지가 payload
                    payload = {k: v for k, v in enr.items()
                               if k not in ENRICHMENT_META_KEYS} or enr
                state.finding_attach_enrichment(finding_id, payload, slot=slot)
                pivot_exposed += int(
                    enr.get("signal_count", enr.get("exposed_count", 0)) or 0
                )
        except Exception:
            pivot_exposed = 0
        append_finding_signal(
            context.metadata,
            FindingSignal(
                source_tool=self.name,
                task_type=canon_task_type,
                asset=asset,
                asset_kind=asset_kind,
                severity=f.severity,
                status=(
                    "confirmed" if judgment.verdict == "confirmed"
                    else "suspected"
                ),
                confidence=1.0 if judgment.verdict == "confirmed" else 0.5,
                finding_id=finding_id,
                evidence_ref=str(out_path),
                summary=f.summary,
                recommended_actions=tuple(f.recommended_actions or ()),
                report_updated=True,
                pivot_exposed=pivot_exposed,
                has_narrative=_has_narrative(f),
            ),
        )
        record_candidates_accounted(
            context.metadata, bucket="submitted", count=max(1, len(f.hits)),
        )
        action = "created" if created else "deduped"
        _log("persist_success", judgment)
        return ToolSuccess(
            content=(
                f"finding.json written ({len(f.hits)} hits, severity={f.severity}); "
                f"lifecycle {action} id={finding_id}"
            ),
        )


def _has_narrative(f: TaskFinding) -> bool:
    """v3.76: finding 이 4부 위험내용(risk_narrative) 중 하나라도 채웠는지."""
    rn = getattr(f, "risk_narrative", None)
    if rn is None:
        return False
    try:
        data = rn.model_dump(mode="json")
    except Exception:
        return False
    return any(isinstance(v, str) and v.strip() for v in data.values())


def _host_of(value: str) -> str:
    from urllib.parse import urlparse
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        return (urlparse(raw if "://" in raw else f"//{raw}").hostname or "").lower()
    except Exception:
        return ""


def _require_browser_verification(f: TaskFinding, context: ToolContext):
    """web finding: 대상 호스트를 browser 로 실제 열어본 적 있어야 제출 허용 (정책 A).

    target(점검 대상) 호스트 우선, 없으면 hit.location 호스트들로 판단.
    browser_action(navigate)/browser_query 가 metadata['_web_browser_hosts'] 에 기록.
    """
    visited = {
        str(h).lower()
        for h in (context.metadata.get("_web_browser_hosts") or [])
        if isinstance(h, str)
    }
    target_host = _host_of(getattr(f, "target", "") or "")
    if target_host:
        required = {target_host}
    else:
        required = {_host_of(h.location) for h in f.hits}
        required.discard("")
    if not required:
        return None  # 호스트 식별 불가 — 게이트 적용 안 함
    if required & visited:
        return None
    sample = sorted(required)[0]
    return ToolError(
        kind="validation",
        message=(
            f"web finding 거부 — 대상 호스트({sample})를 browser 로 실제 열어본 기록이 없다. "
            "키워드 매칭/probe 만으로 finding 금지 (정책 A). 먼저 browser_action(action='navigate', "
            f"url='https://{sample}') 로 접속해 browser_query(action='snapshot')로 화면을 확인하라. "
            "'권한 없음'/로그인/빈 화면이면 finding 이 아니다. 실제로 인증 없이 데이터가 "
            "보일 때만, 그 화면에서 관찰한 구체 증거로 다시 제출하라."
        ),
    )


def _asset_kind_from_location(location: str) -> str:
    if location.startswith(("http://", "https://")):
        return "url"
    if "://" in location:
        return location.split("://", 1)[0]
    return "location"
