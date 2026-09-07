"""egress 판정기가 **실제로 도는지** — 일부러 심어서 잡히는지 확인한다.

## 왜 이 파일이 필요한가

판정기가 조용히 안 도는 것이 제일 나쁜 결과다. "깨끗함" 을 반환하기 때문이다.
이 프로젝트에서 이미 세 번 데였다:

  1. 봉투가 정당하게 나른 것을 유출로 셌다(오탐 25건)
  2. 리드가 DB 에서 직접 읽은 좌표를 검토원 소유로 오인했다(오탐 7건)
  3. 그걸 고치다 **정규화가 탐지를 죽여 4큐 전부 가짜 PASS** 가 났다

그리고 2026-08-21 에 네 번째: `_inspector_windows` 가 `sub-*` 만 글롭해서, Phase 4c②
이후 기본 경로인 **세션형 런에서 코퍼스가 0개**가 됐다. 교차 대조가 아무것도 검사하지
않고 PASS 를 반환하고 있었다(실측: `검토원 전용 윈도 0개`).

그래서 이 파일은 판정기를 **판정한다**.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_PROBE = (Path(__file__).resolve().parents[2] / "docs" / "probes"
          / "egress_audit.py")


@pytest.fixture(scope="module")
def probe():
    spec = importlib.util.spec_from_file_location("egress_audit_probe", _PROBE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# 검토원만 봤어야 하는 본문 — 48자 윈도를 넘기려면 충분히 길어야 한다.
BODY = ("def deploy(): conn = connect(host='db01', database='prod_billing_v2', "
        "user='svc_deploy') # 내부 배포 스크립트 본문이며 리드는 이걸 본 적이 없어야 한다")


def _lead_dir(tmp_path: Path, *, result_dir: str, egress_extra: str = "",
              inspector_body: str = BODY) -> Path:
    d = tmp_path / "lead"
    (d / result_dir / ".harness").mkdir(parents=True)
    (d / result_dir / ".harness" / "audit.log.jsonl").write_text(
        json.dumps({"payload": {"name": "smb_task_python",
                                "content_preview": inspector_body}},
                   ensure_ascii=False) + "\n", encoding="utf-8")
    (d / result_dir / "worker_result.json").write_text(
        json.dumps({"status": "ok", "summary": "점검 완료"}), encoding="utf-8")
    (d / "egress.jsonl").write_text(
        json.dumps({"profile": "codex",
                    "body": "리드가 보낸 요청. 타깃은 12.23.72.66 이다. " + egress_extra},
                   ensure_ascii=False) + "\n", encoding="utf-8")
    return d


@pytest.mark.parametrize("result_dir", ["sub-abc", "session-s1-x-smb"])
def test_planted_body_is_caught_in_both_transports(probe, tmp_path, result_dir):
    """★ `session-*` 가 빠져 있어서 세션형 런이 전부 가짜 PASS 였다(2026-08-21)."""
    d = _lead_dir(tmp_path, result_dir=result_dir, egress_extra=BODY)
    r = probe.audit(d)
    assert r["verdict"] == "FAIL", r
    assert r["crossed_total"] >= 1
    assert not r["corpus_empty"]


@pytest.mark.parametrize("result_dir", ["sub-abc", "session-s1-x-smb"])
def test_clean_run_passes(probe, tmp_path, result_dir):
    """과잉 탐지도 결함이다 — 안 샜으면 PASS 여야 한다."""
    d = _lead_dir(tmp_path, result_dir=result_dir)
    r = probe.audit(d)
    assert r["verdict"] == "PASS", r
    assert r["inspector_windows"] > 0, "코퍼스가 비면 검사한 게 없다"


def test_empty_corpus_is_inconclusive_not_pass(probe, tmp_path):
    """★ 검사할 게 없으면 PASS 라고 말하면 안 된다 — 그게 조용한 실패다."""
    d = tmp_path / "lead"
    d.mkdir()
    (d / "egress.jsonl").write_text(
        json.dumps({"profile": "codex", "body": "요청"}) + "\n", encoding="utf-8")
    r = probe.audit(d)
    assert r["corpus_empty"] is True
    assert r["verdict"] == "INCONCLUSIVE", r


def test_envelope_content_is_not_counted_as_a_leak(probe, tmp_path):
    """봉투가 정당하게 나른 요약은 유출이 아니다(2026-08-21 오탐 25건의 원인)."""
    summary = ("검토원 요약: 이 공유의 tar 아카이브 18개를 열어 확인했고 실제 "
               "크리덴셜은 발견되지 않았다. 공정 키워드만 파일명에 있었다.")
    d = tmp_path / "lead"
    (d / "sub-abc").mkdir(parents=True)
    (d / "sub-abc" / "worker_result.json").write_text(
        json.dumps({"status": "ok", "summary": summary}, ensure_ascii=False),
        encoding="utf-8")
    (d / "sub-abc" / ".harness").mkdir()
    (d / "sub-abc" / ".harness" / "audit.log.jsonl").write_text(
        json.dumps({"payload": {"name": "x", "content_preview": summary}},
                   ensure_ascii=False) + "\n", encoding="utf-8")
    (d / "egress.jsonl").write_text(
        json.dumps({"profile": "codex", "body": summary}, ensure_ascii=False) + "\n",
        encoding="utf-8")
    assert probe.audit(d)["verdict"] == "PASS"


# ── v3.98: hit view 좌표 차감이 값까지 눈감지 않는지 ────────────────────

def _hit_lead_dir(tmp_path: Path, payload: dict) -> Path:
    d = tmp_path / "lead"
    (d / "session-s1-x-smb" / ".harness").mkdir(parents=True)
    (d / "session-s1-x-smb" / ".harness" / "audit.log.jsonl").write_text(
        json.dumps({"payload": {"name": "smb_task_python",
                                "content_preview": BODY}},
                   ensure_ascii=False) + "\n", encoding="utf-8")
    (d / "egress.jsonl").write_text(
        json.dumps({"profile": "codex",
                    "body": json.dumps(payload, ensure_ascii=False)},
                   ensure_ascii=False) + "\n", encoding="utf-8")
    return d


def test_hit_view_value_leak_is_still_caught(probe, tmp_path):
    """★ 좌표를 빼 준다고 **값**까지 눈감으면 신규 채널이 무검사가 된다.

    (좌표 차감이 실제로 도는지는 아래 캡처 모양 테스트가 본다 — 여기 쓰던 `body` 단일
    필드 모양은 실제 캡처가 아니라, 그 모양으로 검증하면 없는 경로를 검증하게 된다.)
    """
    d = _hit_lead_dir(tmp_path, {"shapes": [{"value": BODY, "sample_ref": "/x.conf"}]})
    r = probe.audit(d)
    assert r["verdict"] == "FAIL", r


# ── 캡처 기반 차감이 판정기를 눈멀게 하지 않는지 ───────────────────────
#
# 차감 소스를 리드 audit preview(2KB 절단)에서 **egress 캡처 원문**으로 옮겼다.
# 절단이 없어진 대신, "도구 결과를 통째로 빼면 그 도구의 유출을 못 본다" 는 위험이
# 생긴다. 그래서 리드 DB 도구는 **좌표 골격만** 뺀다. 여기서 그걸 고정한다.

def _capture(tool_calls: list[tuple[str, object]]) -> dict:
    """실제 캡처 모양(`request.messages` 안의 tool_use/tool_result)으로 만든다."""
    messages: list[dict] = []
    for i, (name, result) in enumerate(tool_calls):
        tid = f"t{i}"
        messages.append({"role": "assistant", "content": [
            {"type": "tool_use", "id": tid, "name": name, "input": {}}]})
        messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tid, "is_error": False,
             "content": result if isinstance(result, str)
             else json.dumps(result, ensure_ascii=False)}]})
    return {"profile": "codex", "role": "lead", "request": {"messages": messages}}


def _lead_with_capture(tmp_path: Path, tool_calls: list[tuple[str, object]]) -> Path:
    d = tmp_path / "lead"
    (d / "session-s1-x-smb" / ".harness").mkdir(parents=True)
    (d / "session-s1-x-smb" / ".harness" / "audit.log.jsonl").write_text(
        json.dumps({"payload": {"name": "smb_task_python",
                                "content_preview": BODY + " " + LEAKY_PATH}},
                   ensure_ascii=False) + "\n", encoding="utf-8")
    (d / "egress.jsonl").write_text(
        json.dumps(_capture(tool_calls), ensure_ascii=False) + "\n", encoding="utf-8")
    return d


LEAKY_PATH = ("2025/05/Desktop/FactoryAcceptanceReport/"
              "90-114000-03(F)_PROC,ATP,InSb640SMD,HIGH,ELITE_QUO-181693.pdf")


def test_lead_db_tool_coordinates_are_subtracted(probe, tmp_path):
    """실측 gate_smb 8건이 전부 이 경우였다 — 파일 경로는 정책상 허용이다."""
    d = _lead_with_capture(tmp_path, [
        ("target_detail", {"target_id": 1, "files": [
            {"id": 9, "path": LEAKY_PATH, "size": 100}]})])
    r = probe.audit(d)
    assert r["crossed_total"] == 0, r["crossed"]


def test_a_body_leak_through_the_same_tool_is_still_caught(probe, tmp_path):
    """★ 좌표를 빼 준다고 도구 결과를 **통째로** 빼면 이 케이스를 못 본다."""
    d = _lead_with_capture(tmp_path, [
        ("target_detail", {"target_id": 1, "files": [
            {"id": 9, "path": LEAKY_PATH, "size": 100, "excerpt": BODY}]})])
    r = probe.audit(d)
    assert r["verdict"] == "FAIL", r
    assert r["crossed_total"] >= 1


def test_granted_coordinate_reused_in_prose_is_not_a_leak(probe, tmp_path):
    """리드는 받은 좌표를 자기 질문·피벗 근거에 다시 쓴다 — 그게 설계다.

    실측 2026-08-22(r3): 마지막까지 남은 교차 3건이 전부 이것이었다.
        https://dat--acc-dev.cdep.samsungds.net/api-docs   (codex/dev_web)
        re/workspace/platform/config/gpg/arcashield.asc,   (deepseek/smb)
    좌표는 정책상 허용(`lead_masking.EGRESS_ALLOWED`)이고, 리드가 무엇을 가리키는지
    말하려면 좌표를 쓸 수밖에 없다.
    """
    d = _lead_with_capture(tmp_path, [
        ("target_detail", {"files": [{"path": LEAKY_PATH}]})])
    # 리드가 그 경로를 산문(질문)에 다시 적는다
    cap = d / "egress.jsonl"
    cap.write_text(cap.read_text(encoding="utf-8")
                   + json.dumps({"profile": "codex",
                                 "q": f"{LEAKY_PATH} 를 다시 확인해줘"},
                                ensure_ascii=False) + "\n", encoding="utf-8")
    r = probe.audit(d)
    assert r["verdict"] == "PASS", r["crossed"]


def test_body_echoed_in_prose_is_still_caught(probe, tmp_path):
    """★ 좌표 화이트리스트의 안전 조건 — 본문은 공백이 있어 절대 안 들어간다.

    이게 깨지면 "리드가 검토원 본문을 그대로 옮겨 적어도 통과" 가 되고, 그건 이
    판정기가 존재하는 이유 자체를 무효로 만든다.
    """
    d = _lead_with_capture(tmp_path, [
        ("target_detail", {"files": [{"path": LEAKY_PATH}]})])
    cap = d / "egress.jsonl"
    cap.write_text(cap.read_text(encoding="utf-8")
                   + json.dumps({"profile": "codex", "q": BODY},
                                ensure_ascii=False) + "\n", encoding="utf-8")
    r = probe.audit(d)
    assert r["verdict"] == "FAIL", r
    assert r["crossed_total"] >= 1


def test_coordinate_shape_rejects_prose(probe):
    assert probe._is_coordinate("/a/b/c.txt")
    assert probe._is_coordinate("https://h.example/x")
    assert not probe._is_coordinate("def f(): pass  # 본문")   # 공백
    assert not probe._is_coordinate("x" * 250)                # 길이 상한


def test_detector_vocabulary_is_not_a_leak(probe, tmp_path):
    """탐지기 라벨은 리드 뷰의 설계 산물이다 — 검토원 evidence 에도 있다고 누수가 아니다.

    실측 2026-08-22(ab28_deepseek_smb, 리드=deepseek): 교차 36건 중 **끝까지 남은 2건이
    전부 이것**이었다 —

        category:secret,kind:generic_password_assignment
        {category:credential,kind:hardcoded_ssh_password

    `_shared/hit_view.py` 가 리드에게 `{category, kind, verdict, count, files}` 를 주는
    게 설계다. 라벨은 닫힌 어휘고 본문이 아니다.
    """
    d = _lead_with_capture(tmp_path, [
        ("target_hit_summary", {"rollup": [
            {"category": "credential", "kind": "hardcoded_ssh_password",
             "verdict": "pending", "count": 3}]})])
    r = probe.audit(d)
    assert r["verdict"] == "PASS", r["crossed"]


def test_prose_in_a_label_field_is_still_caught(probe, tmp_path):
    """★ 이 차감의 안전 조건 — 이름만 `kind` 면 뭐든 빼주는 게 아니다.

    `_LEAD_DB_FIELDS` 는 값을 무조건 비우지만 라벨 필드는 **라벨 모양일 때만** 비운다.
    누가 `kind` 에 본문을 넣으면 여전히 검사 대상이어야 한다 — 안 그러면 필드 이름
    하나로 판정기를 우회할 수 있다.
    """
    d = _lead_with_capture(tmp_path, [
        ("target_hit_summary", {"rollup": [
            {"category": "credential", "kind": BODY, "count": 1}]})])
    r = probe.audit(d)
    assert r["verdict"] == "FAIL", r
    assert r["crossed_total"] >= 1


def test_label_shape_rejects_prose_and_long_values(probe):
    assert probe._is_label("secret")
    assert probe._is_label("generic_password_assignment")
    assert not probe._is_label("password=hunter2 in /etc/shadow")   # 공백
    assert not probe._is_label("실제 고객 이메일이 들어 있다")            # 공백+한글
    assert not probe._is_label("a" * 65)                             # 길이 상한


def test_hit_summary_value_leak_via_capture_is_caught(probe, tmp_path):
    """신규 채널(v3.98)도 값 자리는 검사 대상으로 남는다."""
    d = _lead_with_capture(tmp_path, [
        ("target_hit_summary", {"shapes": [
            {"sample_ref": LEAKY_PATH, "value": BODY}]})])
    assert probe.audit(d)["verdict"] == "FAIL"


def test_session_envelope_is_subtracted_whole(probe, tmp_path):
    """세션 답은 파일로 안 남는다 — 봉투 차감은 캡처의 도구 결과에서 한다."""
    answer = json.dumps({"summary": BODY, "status": "ok"}, ensure_ascii=False)
    d = _lead_with_capture(tmp_path, [("ask_inspector", answer)])
    r = probe.audit(d)
    assert r["crossed_total"] == 0, r["crossed"]


def test_blank_coordinates_removes_only_coordinates(probe):
    """★ 방향: 건초더미에서 **좌표를** 뺀다. 본문은 남겨야 잡힌다."""
    got = probe.blank_coordinates(
        {"path": "a/b.txt", "line": 3, "excerpt": "본문", "n": [{"url": "u", "x": "본문"}]})
    assert got == {"path": "", "line": 3, "excerpt": "본문",
                   "n": [{"url": "", "x": "본문"}]}


def test_tool_results_are_matched_to_their_tool(probe):
    got = probe.tool_results_by_name([_capture([("a", "ra"), ("b", "rb")])])
    assert got == {"a": ["ra"], "b": ["rb"]}


def test_queue_metadata_is_subtracted_but_body_is_not(probe, tmp_path):
    """큐 메타(`last_reason`)는 리드가 쓰고 읽는 컬럼이다 — 검토원 소유가 아니다.

    실측: gate_confluence 잔여 1건이 이전 런이 남긴 `RuntimeError(...403)` 이었다.
    ★ 같은 결과의 다른 필드에 본문이 실리면 **여전히 잡혀야** 한다.
    """
    err = "RuntimeError(Confluence cql_search failed: HTTP 403 for space ER25SI)"
    d = _lead_with_capture(tmp_path, [
        ("list_targets", {"items": [{"id": 3, "last_reason": err}]})])
    (d / "session-s1-x-smb" / ".harness" / "audit.log.jsonl").write_text(
        json.dumps({"payload": {"name": "x", "content_preview": err + " " + BODY}},
                   ensure_ascii=False) + "\n", encoding="utf-8")
    assert probe.audit(d)["crossed_total"] == 0

    leaky = _lead_with_capture(tmp_path / "b", [
        ("list_targets", {"items": [{"id": 3, "last_reason": err,
                                     "excerpt": BODY}]})])
    (leaky / "session-s1-x-smb" / ".harness" / "audit.log.jsonl").write_text(
        json.dumps({"payload": {"name": "x", "content_preview": err + " " + BODY}},
                   ensure_ascii=False) + "\n", encoding="utf-8")
    assert probe.audit(leaky)["verdict"] == "FAIL"


# ── 단발 위임 봉투의 구조화 필드 (v3.99) ──────────────────────────────

def test_delegate_envelope_subfields_are_subtracted(probe, tmp_path):
    """`report`/`recommendation` 은 검토원이 정당하게 실어 보내는 자리다.

    실측(2026-08-22 b_dev_web/b_confluence): 남은 크로싱이 전부
    `:{deferred_to_lead:true,recommended_status:skipp…` 였다 — 파일 차감이 있는데도
    윈도가 감싼 키(`recommendation:`)를 걸쳐서 안 지워졌다.
    """
    rec = ("발견되지 않음. 모든 주요 엔드포인트에서 인증 벽이 확인되었고 민감 정보 "
           "노출은 없었다. evidence_ref 는 비어 있다.")
    d = _lead_with_capture(tmp_path, [("delegate_inspect", {
        "agent": "a", "summary": "요약",
        "recommendation": {"deferred_to_lead": True, "recommended_status": "skipped",
                           "reason": rec, "queue": "dev_web_target"},
        "report": {"verdict": "clean", "narrative": rec}})])
    (d / "session-s1-x-smb" / ".harness" / "audit.log.jsonl").write_text(
        json.dumps({"payload": {"name": "x", "content_preview": rec + " " + BODY}},
                   ensure_ascii=False) + "\n", encoding="utf-8")
    assert probe.audit(d)["crossed_total"] == 0, probe.audit(d)["crossed"]


def test_delegate_summary_stays_under_test(probe, tmp_path):
    """★ 봉투 필드를 빼 준다고 `summary` 까지 빼면 마스킹 실패가 무검사가 된다."""
    d = _lead_with_capture(tmp_path, [("delegate_inspect", {
        "agent": "a", "summary": BODY,
        "recommendation": {"recommended_status": "skipped"}})])
    assert probe.audit(d)["verdict"] == "FAIL"
