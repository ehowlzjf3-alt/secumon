"""GoalManager — Ralph loop (hermes-agent goals.py 패턴 포팅).

자율 loop 의 핵심 두 phase:
  Phase A: decompose — goal text → 자세한 checklist
  Phase B: evaluate — assistant 응답 + 현재 checklist → updates / new_items

LLM 호출 후 strict JSON parse. parse 실패 시 caller 가 fail-open 결정.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import Message, SystemMessage, UserMessage, TextBlock
from secu_agent.agent.llm.types import (
    LLMRequest, StreamError, StreamMessageStop, StreamTextDelta,
)


# ============================================================
# 상수
# ============================================================

ITEM_PENDING = "pending"
ITEM_COMPLETED = "completed"
ITEM_IMPOSSIBLE = "impossible"
TERMINAL_ITEM_STATUSES = frozenset({ITEM_COMPLETED, ITEM_IMPOSSIBLE})
VALID_ITEM_STATUSES = frozenset({ITEM_PENDING, ITEM_COMPLETED, ITEM_IMPOSSIBLE})

ADDED_BY_JUDGE = "judge"
ADDED_BY_USER = "user"
ADDED_BY_FALLBACK = "fallback"


# ============================================================
# Prompts (Phase A — decompose)
# ============================================================

DECOMPOSE_SYSTEM_PROMPT = (
    "당신은 자율 운영 에이전트의 엄격한 judge 다. judge 의 가장 먼저 할 일은 사용자가 "
    "준 goal 을 **매우 자세하고 검증 가능한 완료 기준 checklist** 로 분해하는 것이다. "
    "각 항목은 제3자가 에이전트 출력만 보고 명백히 done/not-done 판정할 수 있을 만큼 "
    "구체적이어야 한다.\n\n"
    "철저하라. 항목 수가 적은 것보다 많은 것이 낫다. 사용자가 준 도메인/범위/제약을 "
    "그대로 따르되, 여기서 특정 도메인의 절차를 새로 가정하지 마라. 하위 단계, "
    "엣지 케이스, 품질 기준, 검증 단계, 보고 항목, 실패/불가능 판정 기준을 결과물 "
    "단위로 쪼개라. 너무 자세하게 분해해서 일부 항목이 impossible 마크되는 건 OK — "
    "너무 듬성해서 에이전트가 일찍 done 선언하는 게 위험.\n\n"
    "응답은 한 줄 JSON object 만:\n"
    '{"checklist": [{"text": "<항목>"}, {"text": "<항목>"}, ...]}'
)

DECOMPOSE_USER_PROMPT_TEMPLATE = (
    "Goal:\n{goal}\n\n"
    "가장 엄격하고 자세한 완료 기준 checklist 를 만들어라. 최소 5개, 더 많을수록 좋다. "
    "각 항목은 완료된 작업에 대한 단일 검증 가능 statement 여야 한다."
)


# ============================================================
# Prompts (Phase B — evaluate)
# ============================================================

EVALUATE_SYSTEM_PROMPT = (
    "당신은 자율 운영 에이전트의 goal 진행을 평가하는 엄격한 judge 다. goal 은 자세한 "
    "checklist 가 있다. 현재 pending 인 각 항목에 대해 evidence 가 충분히 보이는지 결정.\n\n"
    "사용자가 중간에 추가한 criteria 가 있으면 그것도 완료 조건이다. criteria 와 checklist "
    "중 하나라도 근거 없이 충족되지 않았으면 done 으로 보지 마라. criteria 를 새 checklist "
    "항목으로 승격해야 한다고 판단하면 new_items 에 추가하라.\n\n"
    "엄격하되 비합리적이지 않게. evidence 가 합리적으로 분명할 때만 pending → "
    "completed / impossible 로 flip 하라. 합리적 evidence 예:\n"
    "- 에이전트의 직전 응답에 작업 결과 명시\n"
    "- 직전 turn 의 tool_call stdout 에 명백한 작업 흔적\n"
    "- 이전 turn 의 tool call 로 이미 완료된 작업 — 매 turn 재증명 요구 X\n\n"
    "단순 의도 ('다음에 X 하겠다') 는 completed 아니다.\n"
    "impossible 은 환경/제약상 불가능을 증명할 때만 (단순히 안 한 게 아님).\n\n"
    "새로 발견된 완료 기준이 있으면 new_items 에 추가 OK. 단 엄격하게 — 진짜 완료 "
    "기준에 속하는 것만.\n\n"
    "STICKINESS: 이미 completed / impossible 인 항목은 frozen. updates 에 포함 X. "
    "사용자만 되돌릴 수 있음.\n\n"
    "응답은 한 줄 JSON object 만:\n"
    '{"updates": [{"index": <i>, "status": "completed|impossible", "evidence": "<왜>"}, ...], '
    '"new_items": [{"text": "<새 항목>"}, ...], '
    '"reason": "<한 문장 overall 사유>"}\n'
    "updates 빈 배열 OK. new_items 빈 배열 OK. reason 은 필수."
)

EVALUATE_USER_PROMPT_TEMPLATE = (
    "Goal:\n{goal}\n\n"
    "사용자 추가 criteria / subgoals:\n{criteria_block}\n\n"
    "현재 checklist (번호는 1-base, 그대로 index 필드로 사용):\n{checklist_block}\n\n"
    "에이전트의 가장 최근 응답 (snippet):\n{response}\n\n"
    "각 pending 항목과 추가 criteria 를 평가. evidence 구체적으로 인용."
)

# F2: judge 를 **실제 증거**에 접지하는 옵션 prefix — 확정 findings 가 **있을 때만**
# 프롬프트 앞에 붙는다(additive). 없으면 원본 프롬프트 그대로(fail-open — 회귀 없음).
# 주의: finding 을 하드 요구하지 않는다 — informational·무발견·coverage·보고서 완료는
# finding 이 없어도 criteria 근거로 정당(과차단 방지, codex 리뷰).
EVALUATE_EVIDENCE_PREFIX = (
    "이번 점검에서 **실제로 확정된 findings** (증거 게이트 통과 = 검증된 사실):\n"
    "{evidence_block}\n\n"
    "완료(done) 판정 시 위 확정 findings 로 교차검증하라 — 응답에 '찾았다/했다'고 쓰여 "
    "있어도 해당 finding 이 위에 없으면 근거가 약하다(산문 주장 ≠ 증거). 단 finding 이 "
    "없어도 정당한 goal(무발견 확인·coverage·보고서·분석 등)은 criteria 근거로 done 가능.\n\n"
)


# ============================================================
# 데이터
# ============================================================


@dataclass
class ChecklistItem:
    text: str
    status: str = ITEM_PENDING
    added_by: str = ADDED_BY_JUDGE
    added_at: float = 0.0
    completed_at: float | None = None
    evidence: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "status": self.status,
            "added_by": self.added_by,
            "added_at": self.added_at,
            "completed_at": self.completed_at,
            "evidence": self.evidence,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ChecklistItem":
        text = str(data.get("text", "")).strip() or "(empty)"
        status = str(data.get("status", ITEM_PENDING)).strip().lower()
        if status not in VALID_ITEM_STATUSES:
            status = ITEM_PENDING
        added_by = str(data.get("added_by", ADDED_BY_JUDGE)).strip().lower()
        if added_by not in (ADDED_BY_JUDGE, ADDED_BY_USER, ADDED_BY_FALLBACK):
            added_by = ADDED_BY_JUDGE
        return cls(
            text=text, status=status, added_by=added_by,
            added_at=float(data.get("added_at", 0.0) or 0.0),
            completed_at=(
                float(data["completed_at"])
                if data.get("completed_at") is not None else None
            ),
            evidence=data.get("evidence"),
        )


@dataclass
class DecomposeResult:
    items: list[ChecklistItem] = field(default_factory=list)
    parse_failed: bool = False
    raw: str = ""


@dataclass
class EvaluateResult:
    updates: list[dict[str, Any]] = field(default_factory=list)  # {index, status, evidence}
    new_items: list[ChecklistItem] = field(default_factory=list)
    reason: str = ""
    parse_failed: bool = False
    raw: str = ""


# ============================================================
# LLM helper — system+user 두 메시지 호출, text 모아 반환
# ============================================================


# adaptive judge routing 상수. base 는 기존 고정값. cap 은 **대부분 게이트웨이가 지원하는
# 16384(2x base)** 로 보수적 — 결과는 절대 cap 을 넘지 않으므로 16k 한도 backend 도 안전.
# 더 큰 출력이 필요/가능하면 SA_GOAL_JUDGE_MAX_TOKENS 로 상향, 8192-한도 backend 는 base 로
# 낮춰(=스케일 비활성) 조정한다.
_JUDGE_MAX_TOKENS_BASE = 8192
_JUDGE_MAX_TOKENS_CAP_DEFAULT = 16384
_ADAPTIVE_ITEM_FLOOR = 20  # 이 항목수까지는 base 로 충분 — 초과분만 예산 가산


def _judge_max_tokens_cap() -> int:
    """adaptive judge 출력 예산 상한. SA_GOAL_JUDGE_MAX_TOKENS 로 조정(기본 16384,
    최소 = base 8192). 하드웨어/게이트웨이 한도에 맞춰 낮출 수 있다."""
    raw = (os.environ.get("SA_GOAL_JUDGE_MAX_TOKENS") or "").strip()
    if not raw:
        return _JUDGE_MAX_TOKENS_CAP_DEFAULT
    try:
        value = int(raw)
    except ValueError:
        return _JUDGE_MAX_TOKENS_CAP_DEFAULT
    return max(_JUDGE_MAX_TOKENS_BASE, value)


def _adaptive_judge_max_tokens(*, checklist_len: int, evidence_chars: int) -> int:
    """judge 출력 예산을 판정 복잡도에 맞춘다(adaptive routing). 큰 checklist(항목마다
    update JSON) + 긴 증거는 출력이 커져 base(8192)에서 truncate→파싱실패 위험 → 예산 상향.
    작은 판정은 base 유지(모델이 일찍 멈춰 실사용/비용 무변).

    **effort 는 low 고정**(파싱 안전 불변식 — high 는 hidden reasoning 이 출력 예산을 태우고,
    minimal 은 chat.completions 게이트웨이 미지원이라 backend 불일치). 그래서 난이도 적응은
    reasoning dial 이 아니라 **출력 예산**으로 한다.

    적용 범위(정직): 이 예산은 chat.completions 게이트웨이 judge(oss/gauss)에 효과가 있다.
    **기본 codex(Responses API) judge 는 max_tokens 를 안 실어(자체 출력 예산 관리) 이 값이
    사실상 no-op** — codex 의 기존 출력예산/truncation 동작에 영향을 주지 않는다(무해). 즉 이
    슬라이스는 게이트웨이 fallback judge 의 대형-판정 truncation 파싱실패를 줄이는 안전망이다.
    (모델 라우팅 자체는 기존 SA_JUDGE_PROFILE 로 이미 가능 — 이 예산 적응이 그 위에 붙는다.)"""
    # base(8192)는 보통 크기 checklist 를 이미 덮는다 → 임계(_ADAPTIVE_ITEM_FLOOR) 초과분과
    # 긴 증거에만 예산을 더한다. 작은/보통 판정은 정확히 base(비용/동작 무변).
    extra_items = max(0, checklist_len - _ADAPTIVE_ITEM_FLOOR)
    est = _JUDGE_MAX_TOKENS_BASE + extra_items * 300 + evidence_chars // 3
    return max(_JUDGE_MAX_TOKENS_BASE, min(_judge_max_tokens_cap(), est))


async def _judge_call(
    *, client: LLMClient, system_prompt: str, user_text: str,
    max_tokens: int = 8192,
) -> str:
    """judge LLM 한 번 호출. 누적된 TextDelta 반환."""
    messages: list[Message] = [
        UserMessage(content=[TextBlock(text=user_text)]),
    ]
    req = LLMRequest(
        messages=messages,
        system=system_prompt,
        tools=None,
        max_tokens=max_tokens,
        temperature=0.0,
        # v3.53-19: judge 는 기계적 추출 작업이라 reasoning 을 낮춘다. operator 의
        # reasoning_effort=high 를 그대로 물려받으면 reasoning 토큰이 출력 예산을
        # 전부 태워서(측정: reasoning 19k자 / content 0자 / stop=max_tokens) JSON
        # 본문이 비거나 중간에 truncate → 파싱 실패. low + 넉넉한 max_tokens 로
        # reasoning 을 수백 자로 눌러 본문이 온전히 나오게 한다.
        #   response_format=json_object: 설명 텍스트 안 붙이게 (미지원이면 fail-open).
        vendor_params={
            "response_format": {"type": "json_object"},
            "reasoning_effort": "low",
        },
    )
    chunks: list[str] = []
    async for ev in client.stream(req):
        if isinstance(ev, StreamTextDelta):
            chunks.append(ev.text)
        elif isinstance(ev, StreamError):
            raise RuntimeError(f"{ev.kind}: {ev.message}")
        elif isinstance(ev, StreamMessageStop):
            break
    return "".join(chunks).strip()


# ============================================================
# JSON 파서 — judge response 추출
# ============================================================


def _iter_balanced_json_objects(raw: str):
    """Yield balanced {...} spans while respecting JSON strings."""
    start = -1
    depth = 0
    in_str = False
    escape = False
    for i, ch in enumerate(raw):
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0 and start >= 0:
                yield raw[start:i + 1]
                start = -1


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    """raw text 안에서 첫 번째 JSON object 추출. 못 찾으면 None."""
    if not raw:
        return None
    # 빠른 path — 통째로 JSON
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    # 균형 잡힌 `{...}` 후보를 순서대로 시도. 앞쪽에 코드/예시 brace 가 섞여도
    # 뒤쪽의 실제 judge JSON 을 살릴 수 있다.
    for candidate in _iter_balanced_json_objects(raw):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    # truncation 복구 — 본문이 max_tokens 로 잘려 닫는 괄호가 없을 때.
    # 마지막 완결된 `}` 까지 자르고 열린 [ / { 를 균형 맞춰 닫아 재파싱.
    repaired = _repair_truncated_json(raw)
    if repaired is not None:
        try:
            parsed = json.loads(repaired)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return None
    return None


def _repair_truncated_json(raw: str) -> str | None:
    """truncate 된 JSON object 를 salvage. 문자열 안 괄호는 무시하고 stack 으로
    열린 [ / { 를 닫아준다. 마지막 완결 element 뒤 미완성 토큰은 버린다."""
    start = raw.find("{")
    if start < 0:
        return None
    s = raw[start:]
    stack: list[str] = []
    in_str = False
    escape = False
    last_safe = -1  # element 경계( } 또는 ] 직후)로 안전하게 자를 수 있는 위치
    for i, ch in enumerate(s):
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
            last_safe = i  # 닫힌 직후까지는 온전
        elif ch == "," and len(stack) <= 2:
            last_safe = i - 1  # 마지막 완결 element 끝
    if last_safe < 0:
        return None
    trimmed = s[: last_safe + 1]
    # trimmed 기준 다시 stack 계산해서 닫기
    stack = []
    in_str = False
    escape = False
    for ch in trimmed:
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]" and stack:
            stack.pop()
    closers = "".join("}" if c == "{" else "]" for c in reversed(stack))
    return trimmed + closers


# ============================================================
# Phase A — decompose
# ============================================================


async def decompose(
    *, client: LLMClient, goal_text: str,
) -> DecomposeResult:
    """goal text → checklist. fail-open: parse 실패 시 빈 리스트 + parse_failed=True."""
    user_text = DECOMPOSE_USER_PROMPT_TEMPLATE.format(goal=goal_text)
    try:
        raw = await _judge_call(
            client=client,
            system_prompt=DECOMPOSE_SYSTEM_PROMPT,
            user_text=user_text,
            max_tokens=8192,
        )
    except Exception as e:
        return DecomposeResult(parse_failed=True, raw=f"llm error: {e}")
    parsed = _extract_json_object(raw)
    if not parsed or not isinstance(parsed.get("checklist"), list):
        return DecomposeResult(parse_failed=True, raw=raw)
    now = time.time()
    items: list[ChecklistItem] = []
    for entry in parsed["checklist"]:
        if isinstance(entry, str):
            text = entry.strip()
        elif isinstance(entry, dict):
            text = str(entry.get("text", "")).strip()
        else:
            continue
        if not text:
            continue
        items.append(ChecklistItem(
            text=text, status=ITEM_PENDING, added_by=ADDED_BY_JUDGE,
            added_at=now,
        ))
    if not items:
        return DecomposeResult(parse_failed=True, raw=raw)
    return DecomposeResult(items=items, parse_failed=False, raw=raw)


def fallback_decompose(goal_text: str, *, raw: str = "") -> DecomposeResult:
    """Deterministic checklist used when the judge response cannot be parsed."""
    goal = " ".join(str(goal_text or "").split())
    if len(goal) > 180:
        goal = goal[:177] + "..."
    templates = [
        f"goal 범위와 제약이 확인되고 작업 기록에 명시되어 있다: {goal or '사용자 goal'}",
        "처리 대상 목록 또는 큐가 확인되고 처리 순서와 남은 건수가 기록되어 있다.",
        "각 처리 단위의 조사 결과가 성공, 실패, 접근 불가로 구분되어 증거와 함께 기록되어 있다.",
        "확정 finding은 lifecycle/report에 제출되고, 오탐 또는 미확정 후보는 제외 근거가 기록되어 있다.",
        "최종 응답에 완료 항목, 미완료 또는 차단 항목, 남은 대상, 다음 조치가 요약되어 있다.",
    ]
    now = time.time()
    return DecomposeResult(
        items=[
            ChecklistItem(
                text=text,
                status=ITEM_PENDING,
                added_by=ADDED_BY_FALLBACK,
                added_at=now,
            )
            for text in templates
        ],
        parse_failed=False,
        raw=raw,
    )


# ============================================================
# Phase B — evaluate
# ============================================================


# evaluate 시 응답 snippet 길이 cap — 너무 길면 judge context 폭발.
_EVALUATE_RESPONSE_CHARS_CAP = 4000


def _format_checklist_block(items: list[ChecklistItem]) -> str:
    """1-base 번호 + status + text. pending 만 강조해서 LLM 이 잘 보게."""
    if not items:
        return "(empty checklist)"
    lines: list[str] = []
    for i, it in enumerate(items, start=1):
        marker = {
            ITEM_PENDING: "[ ]",
            ITEM_COMPLETED: "[x]",
            ITEM_IMPOSSIBLE: "[!]",
        }.get(it.status, "[?]")
        lines.append(f"{i}. {marker} {it.text}")
    return "\n".join(lines)


def _format_criteria_block(criteria: list[str] | None) -> str:
    cleaned = [str(c).strip() for c in criteria or [] if str(c).strip()]
    if not cleaned:
        return "(추가 criteria 없음)"
    return "\n".join(f"{i}. {text}" for i, text in enumerate(cleaned, start=1))


def _cap_response(text: str) -> str:
    if len(text) <= _EVALUATE_RESPONSE_CHARS_CAP:
        return text
    keep = _EVALUATE_RESPONSE_CHARS_CAP - 80
    return (
        text[:keep]
        + f"\n\n…(truncated — original {len(text)} chars)"
    )


async def evaluate(
    *, client: LLMClient, goal_text: str,
    checklist: list[ChecklistItem], assistant_text: str,
    criteria: list[str] | None = None,
    evidence_digest: str = "",
) -> EvaluateResult:
    """checklist + assistant 응답 → updates / new_items. fail-open: parse 실패 시 빈 updates.

    F2: evidence_digest = 이번 점검에서 확정된 findings 요약(마스킹됨) — judge 를 실제
    증거에 접지해 산문 주장이 아닌 검증된 사실로 완료를 판정하게 한다(back-compat: 기본 "").
    """
    if not checklist:
        # checklist 없으면 평가할 게 없음 — freeform 모드는 caller 가 처리
        return EvaluateResult(parse_failed=False, reason="empty checklist")

    base = EVALUATE_USER_PROMPT_TEMPLATE.format(
        goal=goal_text,
        criteria_block=_format_criteria_block(criteria),
        checklist_block=_format_checklist_block(checklist),
        response=_cap_response(assistant_text),
    )
    # F2: 확정 findings 가 있을 때만 증거 접지 prefix 를 앞에 붙인다(additive/fail-open).
    digest = (evidence_digest or "").strip()
    user_text = (
        EVALUATE_EVIDENCE_PREFIX.format(evidence_block=digest) + base
        if digest else base
    )
    try:
        raw = await _judge_call(
            client=client,
            system_prompt=EVALUATE_SYSTEM_PROMPT,
            user_text=user_text,
            # adaptive routing: 큰 checklist/증거일수록 출력 예산 상향(truncation 파싱실패 방지).
            max_tokens=_adaptive_judge_max_tokens(
                checklist_len=len(checklist), evidence_chars=len(digest),
            ),
        )
    except Exception as e:
        return EvaluateResult(parse_failed=True, raw=f"llm error: {e}")
    parsed = _extract_json_object(raw)
    if not parsed:
        return EvaluateResult(parse_failed=True, raw=raw)

    # updates
    updates_out: list[dict[str, Any]] = []
    raw_updates = parsed.get("updates")
    if isinstance(raw_updates, list):
        for u in raw_updates:
            if not isinstance(u, dict):
                continue
            try:
                idx = int(u.get("index"))  # 1-base
            except (TypeError, ValueError):
                continue
            if idx < 1 or idx > len(checklist):
                continue
            status = str(u.get("status", "")).strip().lower()
            if status not in (ITEM_COMPLETED, ITEM_IMPOSSIBLE):
                continue
            # stickiness — 이미 terminal 인 항목은 update 무시
            if checklist[idx - 1].status in TERMINAL_ITEM_STATUSES:
                continue
            evidence = u.get("evidence")
            if evidence is not None:
                evidence = str(evidence)
            updates_out.append({
                "index": idx, "status": status, "evidence": evidence,
            })

    # new_items
    new_items_out: list[ChecklistItem] = []
    raw_new = parsed.get("new_items")
    now = time.time()
    if isinstance(raw_new, list):
        for entry in raw_new:
            if isinstance(entry, str):
                text = entry.strip()
            elif isinstance(entry, dict):
                text = str(entry.get("text", "")).strip()
            else:
                continue
            if not text:
                continue
            new_items_out.append(ChecklistItem(
                text=text, status=ITEM_PENDING, added_by=ADDED_BY_JUDGE,
                added_at=now,
            ))

    reason = str(parsed.get("reason", "") or "").strip()
    return EvaluateResult(
        updates=updates_out, new_items=new_items_out,
        reason=reason, parse_failed=False, raw=raw,
    )


# ============================================================
# checklist apply — evaluate 결과를 list 에 반영
# ============================================================


_DEFAULT_CHECKLIST_MAX = 100
CHECKLIST_MAX_ENV = "SA_GOAL_CHECKLIST_MAX"


def _norm_item_text(text: str) -> str:
    return " ".join(str(text).strip().lower().split())


def _checklist_max() -> int:
    """체크리스트 최대 항목 수 — 무한 증식 안전 상한. 운영자가 큰 목표를
    위해 상향할 수 있다(0/무효 = 기본 100). audit #5 참조."""
    raw = os.environ.get(CHECKLIST_MAX_ENV, "").strip()
    try:
        v = int(raw)
    except ValueError:
        v = 0
    return v if v > 0 else _DEFAULT_CHECKLIST_MAX


def apply_evaluate(
    checklist: list[ChecklistItem], result: EvaluateResult,
) -> tuple[list[ChecklistItem], int]:
    """evaluate 결과를 in-place 가 아니라 새 리스트로 반영.
    return: (new_checklist, num_flipped)

    flip 은 항상 in-place 교체(길이 불변)이므로 호출부는
    `added = len(new) - len(checklist)` 로 실제 추가 수를 알 수 있다.

    audit #5: new_items 는 기존 항목/서로 간 **정규화 텍스트로 dedup** 하고,
    체크리스트 크기 상한(`SA_GOAL_CHECKLIST_MAX`)을 넘기지 않는다. judge 가
    같은 항목을 반복 재방출하거나 distinct 항목을 무한 추가해 무진전 안전종료
    (ralph)를 무력화하던 종료 갭을 닫는다.
    """
    out: list[ChecklistItem] = []
    flips_by_idx: dict[int, dict[str, Any]] = {
        u["index"]: u for u in result.updates
    }
    now = time.time()
    for i, item in enumerate(checklist, start=1):
        flip = flips_by_idx.get(i)
        if flip and item.status == ITEM_PENDING:
            out.append(ChecklistItem(
                text=item.text,
                status=flip["status"],
                added_by=item.added_by,
                added_at=item.added_at,
                completed_at=now,
                evidence=flip.get("evidence") or item.evidence,
            ))
        else:
            out.append(item)
    flipped = sum(
        1 for old, new in zip(checklist, out)
        if old.status != new.status
    )
    cap = _checklist_max()
    seen = {_norm_item_text(it.text) for it in out}
    for ni in result.new_items:
        if len(out) >= cap:
            break
        key = _norm_item_text(ni.text)
        if not key or key in seen:
            continue  # 중복/공백 항목은 추가하지 않음 (재방출 드리프트 차단)
        seen.add(key)
        out.append(ni)
    return out, flipped


def all_terminal(checklist: list[ChecklistItem]) -> bool:
    """모든 항목이 completed/impossible 면 goal done."""
    if not checklist:
        return False
    return all(it.status in TERMINAL_ITEM_STATUSES for it in checklist)


def is_fallback_only_checklist(checklist: list[ChecklistItem]) -> bool:
    """True when the checklist came only from deterministic parse-failure fallback."""
    return bool(checklist) and all(it.added_by == ADDED_BY_FALLBACK for it in checklist)


def count_pending(checklist: list[ChecklistItem]) -> int:
    return sum(1 for it in checklist if it.status == ITEM_PENDING)


def count_completed(checklist: list[ChecklistItem]) -> int:
    return sum(1 for it in checklist if it.status == ITEM_COMPLETED)


# ============================================================
# Continuation prompt
# ============================================================


CONTINUATION_PROMPT_TEMPLATE = (
    "[goal 계속 진행]\n"
    "Goal: {goal}\n\n"
    "사용자 추가 criteria / subgoals:\n"
    "{criteria}\n\n"
    "Checklist 진행 ({done}/{total} 완료):\n"
    "{checklist}\n\n"
    "체크 안 된 항목과 사용자 criteria 를 진행하라. 항목 done 여부는 너가 선언 X — "
    "judge 가 evidence 보고 마크한다. 환경상 진짜 불가능한 항목이면 그 사유를 설명하라 "
    "(judge 가 impossible 마크). 사용자 입력이 꼭 필요해서 막혔으면 명확히 말하고 stop.\n\n"
    "**연속성 규칙 (중요)**: 직전 turn 에 진행하던 작업 단위(예: 한 대상/사이트/항목)를 "
    "**끝까지 마무리한 뒤** 다음으로 넘어가라. 이 continuation 때문에 진행 중이던 대상을 "
    "버리고 다른 대상으로 점프하지 마라 — 그러면 모든 대상이 얕게만 처리된다. 또한 해당 "
    "작업의 skill(있다면)의 깊이·절차 규칙을 계속 지켜라 (필요하면 skill 을 다시 view). "
    "'다음 대상으로' 보다 '지금 대상을 제대로 끝까지'가 우선이다."
)


def build_continuation_prompt(
    goal_text: str, checklist: list[ChecklistItem],
    criteria: list[str] | None = None,
) -> str:
    done = count_completed(checklist)
    total = len(checklist)
    block = _format_checklist_block(checklist)
    return CONTINUATION_PROMPT_TEMPLATE.format(
        goal=goal_text,
        criteria=_format_criteria_block(criteria),
        done=done,
        total=total,
        checklist=block,
    )


# ============================================================
# v3.54 — web-batch 단일타깃 driver
# ============================================================

# de-domain: 도메인 batch goal 분류기(_*_BATCH_MARKERS/is_*_batch_goal)와
# 단일타깃 continuation 빌더는 secu-agent-skill 로 적출됨 —
# (적출 원형: secu-agent-skill/engine_extracts/goal_manager_domain.py)


def pause_goal_for_user_cancel(session_id: int) -> bool:
    """명시적 cancel(ESC/X/새채팅/지시수정) 시 active goal 을 paused 로.

    cancel note 는 LLM 만 보는 반면 batch driver(plugin 도메인 driver)는
    LLM 을 거치지 않는 코드 결정론으로 active goal 을 재가동한다 — goal 자체를
    pause 해야 '취소했는데 다음 아무 메시지에 batch 재동작'이 죽는다.
    재개는 goal(action='resume') 명시로만. 반환: 실제로 pause 했는지.
    (watchdog hang 자동재개 경로는 이 함수를 부르지 않는다 — 의도된 자동재개 유지.)
    """
    from secu_agent import state  # local import — 순환/모듈 의존 최소화

    try:
        goal = state.goal_get_active(session_id)
        if not goal or goal.get("status") != "active":
            return False
        paused = state.goal_pause(
            session_id, reason="사용자 cancel — 자동 진행 중단",
        )
        if paused:
            state.chat_message_add(
                session_id, role="system",
                content={"text": (
                    "goal pause: 사용자 cancel — 재개는 goal(action='resume')"
                )},
            )
        return bool(paused)
    except Exception:
        return False  # pause 실패가 cancel 자체를 막으면 안 됨
