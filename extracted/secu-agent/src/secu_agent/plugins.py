"""v3.82 U2: plugin 부트스트랩 — SA_PLUGINS 모듈 로드 (재부착 운반체).

코어는 등록 API(프로토콜+게이트)만 소유하고 도메인은 등록형 어댑터로 주입된다
(통일 원리). 이 모듈은 그 등록 호출이 실행되는 운반체다: `SA_PLUGINS` 에 나열된
모듈을 프로세스 시작 시 1회 import 하고, plugin 모듈은 import 부수효과로
register_agent_type / register_finding_category / register_skill_unlock_tools /
register_delivery_sink / register_fanout_adapter (+후속 훅)를 호출한다.

- 실패 = fail-loud: import 에러는 `PluginLoadError` 로 시작을 중단시킨다
  (silent skip 금지 — skills loader 와 동일 원칙).
- 중복 로드 = 멱등 (이미 로드된 entry 는 재실행 없음). 등록 충돌은 각 등록
  API 의 중복=명시 에러가 처리한다.
- entry 형식: 콤마/경로구분자 구분. `pkg.mod` (importable 모듈) 또는
  `/path/to/bootstrap.py` (미설치 plugin repo 용 파일 경로).

진입점 연결: cli.main(web/knox-bridge/mcp/skill/eval 포함), agent 워커 cli,
web create_app (uvicorn --reload 의 fresh process 대비).
"""
from __future__ import annotations

import importlib
import importlib.util
import logging
import os
import re
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

PLUGINS_ENV = "SA_PLUGINS"

# 로드 완료 entry → 해석된 소스 (모듈명 또는 파일 절대경로). 프로세스 수명.
_LOADED: dict[str, str] = {}


class PluginLoadError(RuntimeError):
    """plugin import 실패 — 호출측은 시작을 중단해야 한다 (fail-loud)."""


def _parse_entries(raw: str) -> list[str]:
    # SA_SKILLS_DIRS 와 동일하게 pathsep/콤마 둘 다 허용
    return [e.strip() for e in raw.replace(os.pathsep, ",").split(",") if e.strip()]


def _module_name_for_file(path: Path) -> str:
    return "th_plugin_" + re.sub(r"[^0-9A-Za-z_]", "_", path.stem)


def _import_file(entry: str) -> str | None:
    path = Path(entry).expanduser()
    if not path.exists():
        raise PluginLoadError(f"plugin 파일 없음: {entry}")
    resolved = str(path.resolve())
    name = _module_name_for_file(path)
    prev = _LOADED.get(name)
    if prev == resolved:
        return None  # 동일 파일 재로드 — 멱등 skip
    if prev is not None:
        raise PluginLoadError(
            f"plugin 모듈명 충돌: {name} — {prev} 와 {resolved} 가 같은 이름으로 적재됨"
        )
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise PluginLoadError(f"plugin spec 생성 실패: {entry}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as e:  # noqa: BLE001 — 등록 충돌 포함 전부 fail-loud 래핑
        sys.modules.pop(name, None)
        raise PluginLoadError(f"plugin import 실패 ({entry}): {e!r}") from e
    _LOADED[name] = resolved
    return name


def _import_module(entry: str) -> str | None:
    if _LOADED.get(entry) == entry:
        return None
    try:
        importlib.import_module(entry)
    except Exception as e:  # noqa: BLE001
        raise PluginLoadError(f"plugin import 실패 ({entry}): {e!r}") from e
    _LOADED[entry] = entry
    return entry


def load_plugins(raw: str | None = None) -> list[str]:
    """SA_PLUGINS(또는 raw 인자) 의 plugin 모듈을 import. 반환=이번에 로드된 이름.

    멱등: 같은 entry 는 프로세스당 1회만 실행된다. 실패는 PluginLoadError —
    부분 성공 상태로 계속 진행하지 말 것 (이미 로드된 모듈의 등록은 유지됨).
    """
    if raw is None:
        raw = os.environ.get(PLUGINS_ENV, "")
    loaded: list[str] = []
    for entry in _parse_entries(raw):
        if os.sep in entry or entry.endswith(".py"):
            name = _import_file(entry)
        else:
            name = _import_module(entry)
        if name is not None:
            loaded.append(name)
            logger.info("plugin 로드: %s (%s)", name, entry)
    return loaded
