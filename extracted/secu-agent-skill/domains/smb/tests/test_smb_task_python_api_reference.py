"""`smb_task_python` 이 **자기가 바인딩하는 모듈의 시그니처**를 워커에게 준다.

배경(2026-08-17 실측) — W34 재수집 후 smb 런 56건 중 **54건(96%)** 이 sandbox 안에서
API 오류를 냈다. 상위 원인이 전부 "모양을 몰라서" 다:

    38  No module named 'state'                     ← `from state import …`
    21  files_for_share() got an unexpected keyword argument 'suspicious_only'
    10  'dict' object has no attribute 'path'       ← state.* 는 dict 를 준다
    10  directories_for_share() takes 1 positional argument but 2 were given
     7  'dict' object has no attribute 'id'
     5  cannot unpack non-iterable SmbFile object   ← smb.walk_share 는 객체를 준다
     5  fetch_file() missing 1 required keyword-only argument: 'max_bytes'

`smb_task_python` 의 description 은 함수 **이름만 산문으로 나열**했다:

    "files_for_share, hits_for_file, share_files_filtered, file_set_review, … 등"

시그니처도, 키워드-전용 표시도, 반환형도 없었다. 워커는 추측할 수밖에 없었고
그 시행착오로 턴 예산을 태웠다(halt 한 건은 4턴을 전부 여기에 썼다).

⚠️ 참고 — `suspicious_only` 는 **존재하는 인자다.** 다만 `files_for_share` 가 아니라
`share_files_filtered` 의 것이다. 이름만 나열하면 워커가 인자를 이웃 함수로 옮겨 붙인다.

★ 형제 도구 `smb_python` 에도 같은 스니펫이 있는데 거기서는 `secu_agent.state`
(엔진 모듈)를 introspect 해서 **state 블록이 통째로 비어 나온다** — 실제 sandbox 바인딩은
`service.state_domain` 이다. 그 도구는 현재 워커에게 주어지지 않아(운영자 전용) 피해가
없었지만, **introspect 대상과 bind 대상이 갈리면 참조표가 조용히 비는 것**이 이 버그의
모양이다. 그래서 아래 `test_reference_introspects_the_module_execute_binds` 가 그 일치를
직접 검사한다.
"""
from __future__ import annotations

import inspect

import pytest

from domains.smb.plugin.tools import smb_task_tools as t


@pytest.fixture(scope="module")
def ref() -> str:
    return t._BOUND_API_REFERENCE


def test_reference_is_actually_present_in_the_tool_description(ref) -> None:
    assert ref.strip(), "참조표가 비었다 — 워커는 함수 모양을 추측하게 된다"
    assert ref in t.SmbTaskPythonTool.description


@pytest.mark.parametrize("fn", [
    "files_for_share", "directories_for_share", "hits_for_file",
    "share_files_filtered", "file_set_review", "add_file_hits",
])
def test_reference_gives_full_signature_for_the_misused_state_helpers(ref, fn) -> None:
    """★ 이름만이 아니라 **인자까지** 보여야 한다."""
    assert f"state.{fn}(" in ref, f"{fn} 시그니처가 참조표에 없다"


@pytest.mark.parametrize("fn", ["walk_share", "fetch_file", "fetch_file_bytes"])
def test_reference_gives_full_signature_for_the_misused_smb_helpers(ref, fn) -> None:
    assert f"smb.{fn}(" in ref


def test_reference_warns_that_the_namespaces_are_not_importable(ref) -> None:
    """실측 1위(38건): `from state import …`."""
    assert "No module named 'state'" in ref
    assert "이미 바인딩된 객체" in ref


def test_reference_warns_about_dict_versus_object_returns(ref) -> None:
    """★ 이 구분이 없으면 `f['path']` 와 `f.path` 를 계속 헷갈린다."""
    assert "list[dict]" in ref and "SmbFile" in ref
    assert "f['path']" in ref and "f.path" in ref


def test_reference_warns_about_keyword_only_arguments(ref) -> None:
    """`directories_for_share(share_id, limit)` → TypeError(10건)."""
    assert "키워드 전용" in ref


def test_suspicious_only_is_shown_on_the_function_that_actually_has_it(ref) -> None:
    """⚠️ 21건이 `files_for_share(suspicious_only=…)` 였다 — 이웃 함수 인자였다."""
    files_line = next(l for l in ref.splitlines() if l.startswith("state.files_for_share("))
    filtered_line = next(l for l in ref.splitlines() if l.startswith("state.share_files_filtered("))
    assert "suspicious_only" not in files_line
    assert "suspicious_only" in filtered_line


def test_reference_introspects_the_module_execute_binds() -> None:
    """★★ 참조표가 조용히 비는 것을 막는 유일한 불변식.

    `execute` 가 바인딩하는 모듈과 참조표가 introspect 하는 모듈이 **같아야** 한다.
    형제 도구 `smb_python` 은 이게 갈려서 state 블록이 통째로 비어 있다.
    """
    exec_src = inspect.getsource(t.SmbTaskPythonTool.execute)
    ref_src = inspect.getsource(t._build_bound_api_reference)
    assert "from service import state_domain as state" in exec_src
    assert "from service import state_domain as _state" in ref_src, (
        "참조표가 sandbox 에 바인딩되는 모듈이 아닌 다른 모듈을 introspect 한다 — "
        "그러면 블록이 조용히 빈다(smb_python 의 실제 버그)"
    )


def test_every_listed_helper_really_exists_on_the_bound_module() -> None:
    """죽은 이름을 주면 워커가 없는 함수를 부른다 — 추측보다 나쁘다."""
    from service import state_domain as state

    from domains.smb.plugin.agent_types import smb

    for line in t._BOUND_API_REFERENCE.splitlines():
        for prefix, mod in (("state.", state), ("smb.", smb)):
            if line.startswith(prefix) and "(" in line:
                name = line[len(prefix):line.index("(")]
                assert callable(getattr(mod, name, None)), f"{prefix}{name} 이 실제로 없다"


# ── 반환 모양 ─────────────────────────────────────────────────────────────
# 2차 실측(21:19 참조표 배포 후 56런): 시그니처만으로는 부족했다. 앞선 오류들
# (No module named 'state' 40→0, suspicious_only 22→0, dict/객체 18→0)은 사라졌지만
# 남은 오류가 전부 **반환값의 모양**을 몰라서였다 — 필드/키는 시그니처에 안 나온다:
#     56  Error: 'files'                                ← 키는 'items'
#     10  'tuple' object has no attribute 'success'     ← fetch_file 은 평문 튜플
#      7  'ScanResult' object has no attribute 'total'  ← total 은 저 dict 것


def test_reference_documents_the_return_shapes(ref) -> None:
    assert "반환 모양" in ref


def test_walk_share_fields_match_the_real_dataclass(ref) -> None:
    import dataclasses

    from domains.smb.plugin.agent_types import smb

    for f in dataclasses.fields(smb.SmbFile):
        assert f.name in ref, f"SmbFile.{f.name} 이 참조표에 없다"


def test_fetch_file_is_documented_as_a_plain_tuple(ref) -> None:
    """★ 실측 10건 — 워커가 `.success` 를 찾는다. 실제로는 (status, body) 튜플이다."""
    from domains.smb.plugin.agent_types import smb

    assert smb.FetchOutcome == tuple[str, str], (
        "FetchOutcome 이 더 이상 튜플이 아니다 — 참조표의 '평문 튜플' 설명을 고쳐라"
    )
    assert "status, body = smb.fetch_file" in ref


def test_share_files_filtered_keys_match_the_real_return(ref) -> None:
    """★ 실측 56건(최다) — 워커가 `['files']` 를 찾는다. 실제 키는 `items` 다."""
    import inspect

    from service import state_domain as state

    src = inspect.getsource(state.share_files_filtered)
    assert '"items"' in src and '"total"' in src, (
        "share_files_filtered 반환 키가 바뀌었다 — 참조표를 같이 고쳐라"
    )
    assert '"files"' not in src
    assert "'items'" in ref and "'files' 아님" in ref


def test_fetch_file_bytes_fields_match_the_real_dataclass(ref) -> None:
    """★ 3차 실측 18건 — 워커가 `.body` 를 찾는다. 실제 필드는 `data` 다.

    ②·③차 수정 뒤 남은 최다 오류였다. 반환 **타입 이름**만 알려주면 부족하고
    필드까지 줘야 멈춘다는 것이 세 번 연속 확인됐다.
    """
    import dataclasses

    from domains.smb.plugin.agent_types import smb

    names = {f.name for f in dataclasses.fields(smb.SmbFileBytes)}
    assert "data" in names and "body" not in names, (
        "SmbFileBytes 필드가 바뀌었다 — 참조표의 '.data 다ㅡ.body 없음' 을 고쳐라"
    )
    for n in names:
        assert n in ref, f"SmbFileBytes.{n} 이 참조표에 없다"


def test_scan_result_fields_match_the_real_object(ref) -> None:
    """★ 실측 7건 — 워커가 `.total` 을 찾는다. ScanResult 에는 없다."""
    from secu_agent import detectors

    r = detectors.scan_text("password=hunter2secret\n", label="probe")
    public = {a for a in dir(r) if not a.startswith("_") and not callable(getattr(r, a, None))}
    assert "total" not in public, "ScanResult 에 total 이 생겼다 — 참조표 경고를 고쳐라"
    for f in ("hits", "has_findings", "bytes_scanned"):
        assert f in public and f in ref


def test_hit_fields_match_the_real_dataclass(ref) -> None:
    import dataclasses

    from secu_agent import detectors

    for f in dataclasses.fields(detectors.Hit):
        assert f.name in ref, f"Hit.{f.name} 이 참조표에 없다"


def test_reference_failure_does_not_break_the_tool(monkeypatch) -> None:
    """참조표를 못 만들어도 도구는 살아야 한다(부가 기능이다).

    ⚠️ 이 테스트를 두 번 틀리게 썼다.
      ① `sys.modules` 캐시 때문에 import 문이 실행되지 않아 헛통과.
      ② `from service import state_domain` 의 `__import__` 인자는 **`"service"`** 이고
         `state_domain` 은 `fromlist` 에 온다 — 모듈명으로 거르면 안 걸린다.
    그래서 `fromlist` 를 본다.
    """
    import builtins
    real = builtins.__import__

    def boom(name, globals=None, locals=None, fromlist=(), level=0):
        if "state_domain" in (fromlist or ()):
            raise ImportError("simulated")
        return real(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", boom)
    assert t._build_bound_api_reference() == ""
