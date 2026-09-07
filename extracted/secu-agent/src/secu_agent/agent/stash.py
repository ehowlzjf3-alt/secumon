"""큰 tool 결과를 evidence_dir 에 파일로 떨구고 LLM 엔 요약만 돌려줌."""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime
from pathlib import Path

# v3.30-A: Claude Code 정렬. 작은 결과 (≤50KB) 는 그대로 inline — agent 가 본문 전체
# 봐서 추측 안 해도 됨. N entry DB list 같은 케이스에서 head 500 만 보고 거짓
# narration 했던 거 해결. 50KB 초과한 진짜 거대한 결과만 stash.
#
# v3.58: 임계 env 튜닝. 50KB 는 gpt-oss 130K 컨텍스트 기준 — codex 처럼 컨텍스트 큰
# 모델은 SA_TOOL_INLINE_MAX 를 올려 stash 빈도↓ → read_evidence_file 되돌아읽기
# 라운드트립↓ → 체감 속도↑. 단 누적 재전송 비용은 여전하니 무한정 X (상한 클램프).
_DEFAULT_INLINE_MAX = 50_000
_INLINE_MAX_CLAMP = 500_000  # 이 이상은 누적 재전송 비용이 stash 이득을 넘어섬


def tool_result_inline_max() -> int:
    """현재 inline 임계 (env SA_TOOL_INLINE_MAX override, 50KB~500KB 클램프)."""
    raw = os.environ.get("SA_TOOL_INLINE_MAX")
    if not raw:
        return _DEFAULT_INLINE_MAX
    try:
        val = int(raw)
    except ValueError:
        return _DEFAULT_INLINE_MAX
    return max(_DEFAULT_INLINE_MAX, min(val, _INLINE_MAX_CLAMP))


# 하위호환 — 기존 import 처(테스트 등)용 기본 상수. 실전 분기는 함수 사용.
TOOL_RESULT_INLINE_MAX = _DEFAULT_INLINE_MAX


def json_structure_summary(parsed: object, depth_limit: int = 4) -> str:
    def describe(v: object, depth: int) -> str:  # noqa: PLR0911
        if depth > depth_limit:
            return "..."
        if isinstance(v, dict):
            keys = list(v.keys())
            items = [f"{k}: {describe(v[k], depth + 1)}" for k in keys[:20]]
            more = "" if len(keys) <= 20 else f", ... +{len(keys) - 20} more keys"
            return "{" + ", ".join(items) + more + "}"
        if isinstance(v, list):
            n = len(v)
            if n == 0:
                return "[]"
            sample = describe(v[0], depth + 1)
            return f"[n={n} items, sample: {sample}]"
        if isinstance(v, str):
            preview = v.replace("\n", " ")[:40]
            return f'"{preview}{"..." if len(v) > 40 else ""}" ({len(v)} chars)'
        if v is None:
            return "null"
        return type(v).__name__

    return describe(parsed, 0)


def stash_large_result(tool_name: str, raw: str, evidence_dir: Path) -> tuple[str, Path]:
    parsed: object | None = None
    suffix = ".txt"
    try:
        parsed = json.loads(raw)
        suffix = ".json"
    except (json.JSONDecodeError, ValueError):
        pass

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    short = uuid.uuid4().hex[:6]
    evidence_dir.mkdir(parents=True, exist_ok=True)
    path = evidence_dir / f"{ts}_{tool_name}_{short}{suffix}"
    path.write_text(raw, encoding="utf-8")

    try:
        rel_path = str(path.relative_to(evidence_dir.resolve()))
    except ValueError:
        rel_path = str(path)

    lines: list[str] = [
        f"[결과 크기 {len(raw):,} chars — 컨텍스트 절약을 위해 파일로 저장함]",
        f"path: {rel_path}   (read_file/grep의 `path` 인자에 이 값을 그대로 넘길 것)",
        "",
    ]
    if parsed is not None:
        if isinstance(parsed, list) and len(parsed) == 1:
            lines.append("(list[1] wrapper — 아래는 first item 구조)")
            structure = json_structure_summary(parsed[0])
        else:
            structure = json_structure_summary(parsed)
        lines.append(f"structure: {structure}")
    lines.append("")
    # v3.30-A: stash 발생 = 50KB 초과 (희귀). head/tail 충분히 보여서
    # 본문 안 봐도 패턴 판단 가능하게.
    lines.append("--- head (2000 chars) ---")
    lines.append(raw[:2000])
    if len(raw) > 4000:
        lines.append("...")
        lines.append("--- tail (1000 chars) ---")
        lines.append(raw[-1000:])
    lines.append("")
    lines.append(
        f"**읽는 법**: `read_file(path='{rel_path}', offset=..., limit=...)` 또는 "
        f"`grep(pattern='...', path='{rel_path}')`. 위 `path:` 값을 **정확히 그대로** "
        f"복사해서 넘겨라."
    )
    return "\n".join(lines), path
