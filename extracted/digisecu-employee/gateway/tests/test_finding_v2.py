"""finding/report 고도화(카테고리·담당자·리포트) 단위 테스트 — 무DB.

담당자(assignee)는 **표시 전용·발송 아님**. codex 반영: recipient≠담당자(dssoc 절대 담당자 금지),
owner_recipient/asset_owner 만 담당자, 이메일은 검증된 단일 사내 메일박스만, finding_ids 정확 멤버십."""
import pytest

from digisecu_gateway import taxonomy as tx
from digisecu_gateway.repos import finding_repo as fr
from digisecu_gateway.repos import workspace_repo as wr


class FakePool:
    """resolve_owner 용 최소 duck-typed 풀."""
    def __init__(self, one=None, all_=None):
        self._one = one
        self._all = all_ or []

    def fetch_one(self, sql, params=None):
        return self._one

    def fetch_all(self, sql, params=None):
        return self._all


# ── taxonomy 파리티(엔진 finding_taxonomy 복제 드리프트 감시) ──
def test_taxonomy_parity_keys_and_labels():
    # secret 은 credential 로 병합돼 출력 어휘에서 제외(사용자 결정).
    assert tx.known_keys() == {
        "pii", "credential", "web_vuln", "misconfig",
        "internal_system", "attack_surface", "semiconductor_process", "business_confidential",
    }
    assert "secret" not in tx.known_keys()
    expected = {
        "credential": "크리덴셜 노출", "pii": "개인정보 노출",
        "web_vuln": "웹 취약점", "misconfig": "설정 오류", "internal_system": "내부 시스템 정보",
        "attack_surface": "공격 표면", "semiconductor_process": "공정 정보",
        "business_confidential": "경영 기밀",
    }
    for c in tx.all_categories():
        assert expected[c["key"]] == c["label"]


def test_secret_merged_into_credential():
    # secret 은 credential 로 canon 된다(표시·분류·필터 전 경로).
    rep, allc = tx.classify(["secret"])
    assert rep["key"] == "credential" and [c["key"] for c in allc] == ["credential"]
    assert tx.categories_from_extra({"hits": [{"category": "secret"}]}) == ["credential"]
    assert tx.categories_from_extra({"hit_categories": ["secret"]}) == ["credential"]
    assert tx.canon_param("secret") == "credential"
    # 필터 확장: credential 요청은 DB 원시 'secret' 태그까지 매칭.
    assert set(tx.expand_db_values("credential")) == {"credential", "secret"}
    assert tx.expand_db_values("misconfig") == ["misconfig"]


def test_taxonomy_priority_and_unknown_dropped():
    rep, allc = tx.classify(["secret", "credential"])
    assert rep["key"] == "credential" and [c["key"] for c in allc] == ["credential"]  # 병합→중복제거
    rep, _ = tx.classify(["pii", "semiconductor_process"])
    assert rep["key"] == "semiconductor_process"  # 공정 7 > pii 5
    rep, allc = tx.classify(["bogus", "unknown"])
    assert rep is None and allc == []  # 미지 키 드롭
    # 전체는 우선순위 내림차순
    _, allc = tx.classify(["misconfig", "credential", "pii"])
    assert [c["key"] for c in allc] == ["credential", "pii", "misconfig"]


def test_categories_from_extra_variants():
    # secret→credential 병합 반영.
    assert tx.categories_from_extra({"hits": [{"category": "pii"}, {"category": "secret"}, {"x": 1}]}) == ["pii", "credential"]
    # confluence 폴백
    assert tx.categories_from_extra({"hit_categories": ["business_confidential", "bogus"]}) == ["business_confidential"]
    assert tx.categories_from_extra({"foo": 1}) == []


def test_detail_category_unclassified_when_no_hits():
    import json
    row = {"id": 1, "task_type": "github", "asset": "a", "asset_kind": "repo", "severity": "high",
           "summary": "s", "status": "open", "owner": None, "ticket_ref": None,
           "first_seen": 1.0, "last_seen": 1.0, "seen_count": 1, "has_evidence": False,
           "extra_json": json.dumps({})}
    m = fr._to_finding_detail(row)
    assert m.category.key == "unclassified" and m.category.label == "미분류"
    assert m.categories == []


# ── 담당자(assignee) 해석 ──
def test_assignee_smb_resolved():
    pool = FakePool(one={"user_name": "김수민", "user_dept": "부서X", "email": "sum.kim@samsung.com"})
    a = fr.resolve_owner(pool, task_type="smb", asset="smb://10.11.61.46/Users", finding_id=1)
    assert a.status == "resolved" and a.name == "김수민" and a.email == "sum.kim@samsung.com"
    assert a.sourceLabel == "Splunk 매칭"


def test_assignee_smb_bad_ip_or_hostname_unresolved():
    # 옥텟 초과·비-IP 호스트는 unresolved(DNS/퍼지 금지)
    assert fr.resolve_owner(FakePool(), task_type="smb", asset="smb://999.1.1.1/x", finding_id=1).status == "unresolved"
    assert fr.resolve_owner(FakePool(), task_type="smb", asset="smb://host.name/x", finding_id=1).status == "unresolved"


def test_assignee_smb_no_match_unresolved():
    assert fr.resolve_owner(FakePool(one=None), task_type="smb", asset="smb://10.1.1.1/x", finding_id=1).status == "unresolved"


def test_assignee_smb_secret_in_name_masked_bad_email_rejected():
    pool = FakePool(one={"user_name": "이름 AKIAIOSFODNN7EXAMPLE", "user_dept": "d",
                         "email": "a@samsung.com, evil@x.com"})
    a = fr.resolve_owner(pool, task_type="smb", asset="smb://10.1.1.1/x", finding_id=1)
    assert "AKIAIOSFODNN7EXAMPLE" not in (a.name or "")  # name redact
    assert a.email is None  # 리스트형 이메일 거부
    assert a.status == "resolved"  # name 있으면 resolved


def test_assignee_github_owner_and_ambiguous():
    pool = FakePool(all_=[{"owner_recipient": "a@samsung.com"},
                          {"owner_recipient": "a@samsung.com"},
                          {"owner_recipient": "b@samsung.com"}])
    a = fr.resolve_owner(pool, task_type="github", asset="github:x", finding_id=1)
    assert a.status == "resolved" and a.email == "a@samsung.com" and a.ambiguous is True
    assert a.sourceLabel == "커밋 작성자"


def test_assignee_github_no_owner_unresolved():
    assert fr.resolve_owner(FakePool(all_=[]), task_type="github", asset="github:x", finding_id=1).status == "unresolved"


def test_assignee_dev_web_dssoc_only():
    a = fr.resolve_owner(FakePool(), task_type="dev_web", asset="x", finding_id=1)
    assert a.status == "dssoc_only" and a.email is None


def test_assignee_dssoc_owner_recipient_not_treated_as_owner():
    # 적대검증 반영: owner_recipient 가 dssoc/soc 계열이면 담당자로 표시하지 않는다.
    a = fr.resolve_owner(FakePool(all_=[{"owner_recipient": "dssoc@samsung.com"}]),
                         task_type="github", asset="g", finding_id=1)
    assert a.status == "unresolved" and a.email is None
    a2 = fr.resolve_owner(FakePool(one={"user_name": None, "user_dept": None, "email": "soc-team@samsung.com"}),
                          task_type="smb", asset="smb://10.1.1.1/x", finding_id=1)
    assert a2.email is None


def test_assignee_name_newlines_collapsed():
    a = fr.resolve_owner(FakePool(one={"user_name": "홍길동\r\n주입", "user_dept": "부서\tX", "email": "a@samsung.com"}),
                         task_type="smb", asset="smb://10.1.1.1/x", finding_id=1)
    assert a.name is not None and "\n" not in a.name and "\r" not in a.name
    assert a.dept is not None and "\t" not in a.dept


# ── owner 이메일 검증(단일 사내 메일박스만) ──
@pytest.mark.parametrize("email,ok", [
    ("sum.kim@samsung.com", True),
    ("a@b.co", True),
    ("dssoc@samsung.com", True),          # 유효 메일(담당자 여부는 delivery 로직이 별도 판정)
    ("a@samsung.com, b@samsung.com", False),  # 리스트
    ("Kim <a@samsung.com>", False),        # 표시명
    ("a@samsung.com\r\nBcc: x@evil.com", False),  # CRLF/Bcc 주입
    ("nope", False),
    ("a@" + "x" * 300 + ".com", False),    # 과길이
    ("a@b", False),                         # TLD 없음
    ("  a@samsung.com  ", True),            # 공백 트림
])
def test_owner_email_validation(email, ok):
    assert (fr._owner_email(email) is not None) == ok


# ── 발송대상(고정 라벨) · finding 수 ──
def test_delivery_target_dssoc_never_owner():
    assert wr._delivery_target("dssoc@samsung.com", None) == "DSSOC"
    assert wr._delivery_target("dssoc_p1@samsung.com", None) == "DSSOC"  # startswith
    assert wr._delivery_target("kim@samsung.com", "kim@samsung.com") == "담당자 개별"
    assert wr._delivery_target("kim@samsung.com", "dssoc@samsung.com") == "DSSOC"  # dssoc owner→발송대상
    assert wr._delivery_target(None, None) is None


def test_report_item_owner_email_present_but_dssoc_excluded():
    # 사용자 결정: 사내 사이트라 목록에도 담당자 이메일 노출 허용(안전장치 유지: 검증·dssoc 제외).
    from digisecu_gateway.models import ReportThreadItem
    assert "ownerRecipient" in ReportThreadItem.model_fields
    # dssoc 계열 owner_recipient 는 담당자로 노출되지 않는다(발송대상 라벨로만).
    row = {"id": 1, "status": "reported", "severity": "high", "subject_tag": "t", "label": "repo",
           "finding_id": 1, "finding_summary": None, "updated_at": None,
           "recipient": "dssoc@samsung.com", "owner_recipient": "dssoc@samsung.com",
           "notified_at": None, "finding_ids": "[1]"}
    item = wr._to_report(row, "github")
    assert item.ownerRecipient is None and item.deliveryTarget == "DSSOC"
    # 실 담당자는 노출
    row2 = {**row, "recipient": "kim.cs@samsung.com", "owner_recipient": "kim.cs@samsung.com"}
    item2 = wr._to_report(row2, "github")
    assert item2.ownerRecipient == "kim.cs@samsung.com" and item2.deliveryTarget == "담당자 개별"


def test_finding_count_union_dedup():
    assert wr._finding_count(5, "[5]") == 1
    assert wr._finding_count(5, "[5,6,7]") == 3
    assert wr._finding_count(5, None) == 1
    assert wr._finding_count(None, "[1,1,2]") == 2
    assert wr._finding_count(5, "garbage") == 1
    assert wr._finding_count(5, '["6","7"]') == 3   # 문자열 정수
    assert wr._finding_count(None, "[]") == 1        # 폴백 최소 1
    assert wr._finding_count(None, '[true, {"x":1}]') == 1  # bool/객체 제외 → 폴백


# ── 담당자 이메일이 리스트 응답엔 없다(디렉터리 덤프 방지) ──
def test_list_finding_has_no_assignee_field():
    # 리스트 모델(GatewayFinding)엔 assignee 필드 자체가 없다 — detail 전용.
    from digisecu_gateway.models import GatewayFinding
    assert "assignee" not in GatewayFinding.model_fields
