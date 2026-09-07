"""Sub-agent definition loader — markdown frontmatter 기반.

agents/<name>.md frontmatter:
    ---
    name: smb_share_master       # file basename 과 일치
    description: ...             # AgentTool list 결과에 표시
    task_type: smb_share_master  # 기존 task_type 매핑 — system_prompt + registry 분기에 사용
    when_to_use: ...             # LLM 이 어떤 상황에서 spawn 할지 가이드
    input_keys: [share_id, ...]  # spec["target"] 에 들어갈 key 들 (검증용)
    profile: o4-mini             # (선택, v3.81 T1c) 이 sub-agent 전용 LLM profile —
                                 # AgentTool 이 워커에 --profile-name 으로 전달
    ---

    본문 — agent 의 시스템 보조 / 행동 가이드 (현재는 미사용, 향후 v3.13+ 에서 system_prompt 합성에 통합 가능)
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)
_KV_RE = re.compile(r"^([a-z_][a-z0-9_]*):\s*(.*)$", re.MULTILINE)
log = logging.getLogger("secu_agent.agent.agents")

_DEFAULT_AGENTS_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True, slots=True)
class AgentDef:
    name: str
    description: str
    task_type: str
    when_to_use: str
    input_keys: tuple[str, ...]
    body: str
    path: Path
    # v3.81 T1c: sub-agent 별 LLM profile (빈 문자열 = 워커 기본 선택 로직)
    profile: str = ""


def _parse_list_field(value: str) -> tuple[str, ...]:
    """frontmatter `input_keys: [a, b, c]` → tuple. 빈 값이면 ()."""
    s = value.strip()
    if not s:
        return ()
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1]
    else:
        inner = s
    return tuple(p.strip().strip("\"'") for p in inner.split(",") if p.strip())


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str] | None:
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return None
    fm_text = m.group(1)
    body = m.group(2).strip()
    fields: dict[str, str] = {}
    for km in _KV_RE.finditer(fm_text):
        fields[km.group(1).strip()] = km.group(2).strip()
    return fields, body


def load_agents(
    agents_dir: Path | str | None = None,
) -> list[AgentDef]:
    """agents_dir 안의 *.md 파일을 AgentDef 로 파싱. None → 패키지 default."""
    d = Path(agents_dir) if agents_dir is not None else _DEFAULT_AGENTS_DIR
    if not d.exists() or not d.is_dir():
        return []
    out: list[AgentDef] = []
    for md in sorted(d.glob("*.md")):
        try:
            text = md.read_text()
        except OSError:
            continue
        parsed = _parse_frontmatter(text)
        if parsed is None:
            continue
        fields, body = parsed
        name = fields.get("name", "").strip()
        if not name or md.stem != name:
            # ★ 조용히 넘기면 그 sub-agent 는 '없는' 셈이 되고, AgentTool 은 not_found
            # 만 돌려준다 — 왜 없는지는 아무 데도 안 남는다. 이름 불일치는 언제나 실수다.
            log.warning(
                "agents/%s: frontmatter name=%r 이 파일명(%s)과 달라 무시된다 — "
                "둘을 같게 맞춰라(이 파일의 sub-agent 는 호출 불가 상태다)",
                md.name, name or "(없음)", md.stem,
            )
            continue
        task_type = fields.get("task_type", "").strip()
        if not task_type:
            continue
        out.append(AgentDef(
            name=name,
            description=fields.get("description", "").strip(),
            task_type=task_type,
            when_to_use=fields.get("when_to_use", "").strip(),
            input_keys=_parse_list_field(fields.get("input_keys", "")),
            body=body,
            path=md,
            profile=fields.get("profile", "").strip(),
        ))
    return out


def get_agent(
    name: str, *, agents_dir: Path | str | None = None,
) -> AgentDef | None:
    for a in load_agents(agents_dir):
        if a.name == name:
            return a
    return None
