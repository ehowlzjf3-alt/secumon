"""secu-agent-skill plugin 부트스트랩 — 엔진 `SA_PLUGINS` 로드 대상.

엔진(.env): SA_PLUGINS="${HOME}/project/secu-agent-skill/plugin/bootstrap.py"

import 부수효과로 코어 등록 API 를 호출해 도메인을 주입한다 (v3.81 통일 원리:
코어=프로토콜+게이트, 도메인=등록형 어댑터). 등록 항목:

1. agent_type 6종 (smb/web/dev_web/github/jenkins/confluence) — agent_type_registry
2. finding 분류 2종 (semiconductor_process/business_confidential,
   requires_content_evidence=True — 코어 4종과 동일한 content 증거 게이트)
3. 민감어휘 시그널 2종 — _shared/detectors/sensitive_terms.py 사전
4. SMB evidence judge — 구 코어 `_judge_smb_credential_hit` + 프린터드라이버
   INI 휴리스틱 원형 (v3.82 U3a 에서 등록형으로 이동, 약화 금지)
5. browser 검증 게이트 task_type (web/dev_web/devops/github/confluence — 정책 A)
6. skill 기본 unlock 도구 (engine_extracts/skill_default_unlock_tools 원형)
7. task_type canonicalizer — 구 코어 v3.74 자산기준 교정 휴리스틱
   (github/confluence/wiki/jenkins host·prefix, service/services/finding_identity.py)
8. SMB E2E fanout adapters/plans
9. dev_web E2E fanout adapters/plans
10. GitHub E2E fanout adapters/plans
11. Confluence E2E fanout adapters/plans

실패는 전파한다 — 엔진 load_plugins 가 fail-loud 로 시작을 중단시킨다.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from secu_agent.agent.evidence_judgment import (
    register_browser_verification_exemption,
    register_browser_verified_task_type,
    register_category_evidence_judge,
    register_evidence_judge,
)
from secu_agent.agent.llm.instruction_preamble import register_instruction_preamble
from secu_agent.agent.semantic_validation import register_sensitive_term_signal
from secu_agent.agent.skills import register_skill_unlock_tools
from secu_agent.finding_taxonomy import (
    register_finding_category,
    register_task_type_canonicalizer,
)
from secu_agent.agent_type_registry import register_agent_type
from secu_agent.state import register_memory_scope

_REPO = Path(__file__).resolve().parents[1]

# de-domain 재작성(v3.84): skill 도메인 모듈은 skill-상대 경로(domains.*/_shared.*/tools.*/
# service.*/engine_extracts.*)로 서로 import 한다. 엔진이 SA_PLUGINS 로 이 부트스트랩을
# 로드할 때 그 경로들이 resolve 되도록 repo 루트를 sys.path 에 올린다(테스트는 pytest
# pythonpath="." 가 처리 — 런타임 커버).
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))


def _load_repo_module(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, _REPO / rel)
    if spec is None or spec.loader is None:
        raise ImportError(f"skill repo 모듈 로드 실패: {rel}")
    mod = importlib.util.module_from_spec(spec)
    # @dataclass(slots=True) 등이 exec 중 cls.__module__ 를 sys.modules 에서 찾으므로
    # exec_module 전에 등록한다 (멱등 — 같은 이름 재로드 시 덮어씀).
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _register_state_schemas() -> None:
    """스킬 state 네임스페이스 등록 — 단일 소스 `plugin.state_schema_wiring.register_state_schemas` 에 위임.

    등록 로직을 별도 모듈로 분리한 이유: state-schema 등록만 필요한 테스트가 `import plugin.bootstrap`
    (=module-level register_all() 실행)을 하지 않고도 등록할 수 있게 하기 위함(evidence_judge/agent_type
    중복 등록 ValueError 회피). 프로덕션·테스트가 동일 registrar 를 타 계약 검증 일치.
    """
    from plugin.state_schema_wiring import register_state_schemas
    register_state_schemas()


def _bind_extracted_detectors() -> None:
    """de-domain 추출된 detectors 를 엔진 namespace 로 바인딩 (import seam 재연결).

    `_shared.detectors.document_sensitivity` 는 de-domain C.1 에서 skill repo
    `_shared/detectors/document_sensitivity.py` 로 추출됐다(엔진 text_scan 은 plugin
    공급을 try/except 로 받음). 도메인 agent_type/tool(listing_patterns·smb_tools·
    github_scan 등)은 여전히 `_shared.detectors.document_sensitivity` 경로로
    import 하므로, plugin 이 그 이름을 sys.modules 에 등록해 seam 을 잇는다(엔진 무수정).
    이미 엔진(모놀리스 런타임)이 제공하면 건드리지 않는다.
    """
    mod_name = "_shared.detectors.document_sensitivity"
    if mod_name in sys.modules:
        _register_document_scanner(sys.modules[mod_name])
        return
    try:  # 엔진이 직접 제공하면(모놀리스) 그대로 사용.
        mod = importlib.import_module(mod_name)
        _register_document_scanner(mod)
        return
    except ImportError:
        pass
    # @dataclass(slots=True) 가 exec 중 cls.__module__ 를 sys.modules 에서 찾으므로
    # exec_module 전에 등록한다.
    spec = importlib.util.spec_from_file_location(
        mod_name, _REPO / "_shared/detectors/document_sensitivity.py",
    )
    if spec is None or spec.loader is None:
        raise ImportError("document_sensitivity seam 로드 실패")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    _register_document_scanner(mod)


def _bind_pivot_and_register() -> None:
    """de-domain v3.84 #3: skill _shared.pivot 의 run_pivot_for_finding 을 코어
    register_finding_enricher 로 등록 (코어 submit_finding 이 등록형 훅으로 호출).
    pivot 도메인 로직은 skill 소유 — 코어는 훅으로만 안다."""
    try:
        from _shared import pivot as pivot_mod
    except ImportError:
        return
    fn = getattr(pivot_mod, "run_pivot_for_finding", None)
    if fn is None:
        return
    try:
        from secu_agent.agent.finding_enrichment import register_finding_enricher
    except ImportError:
        return  # 구버전 코어엔 enricher 훅 없음.
    register_finding_enricher(fn)


def _register_document_scanner(mod) -> None:
    """de-domain v3.84 #6: 코어 text_scan 은 이제 특정 모듈 경로를 import 하지 않고
    등록형 스캐너를 순회한다 — document_sensitivity 를 그 등록 API 로 붙인다.
    (구버전 코어=경로 import 는 위 sys.modules seam 이 계속 커버 → 하위호환.)"""
    fn = getattr(mod, "scan_document_sensitivity", None)
    if fn is None:
        return
    try:
        from secu_agent.detectors.text_scan import register_text_signal_scanner
    except ImportError:
        return  # 구버전 코어엔 등록 API 없음 — sys.modules seam 이 커버.
    register_text_signal_scanner(fn)


# 같은 이름에 **다른 내용**이 등록된 진짜 충돌 — 멱등 흡수 대상이 아니다.
# 예: `schema namespace already registered with different DDL` 은 스키마가 갈렸다는
# 뜻이라 조용히 넘기면 DB 계약이 두 갈래로 벌어진다.
_HARD_CONFLICTS = ("different DDL",)


def _register_idempotent(fn, *args, **kwargs) -> bool:
    """이미 등록된 이름이면 조용히 넘긴다. 반환: 이번에 등록했으면 True.

    ⚠️ 왜 필요한가 (2026-08-20 실측). 엔진 `load_plugins` 는 멱등이라 프로덕션에서
    `register_all()` 은 1회만 돈다. 그런데 **다른 주체가 먼저 같은 이름을 등록해 둔**
    프로세스가 존재한다:

        secu-agent/tests/web/conftest.py::_plugin_agent_types_registered
          → 도메인 agent_type 을 수동 등록(플러그인 미부착 형상 시뮬레이션)
        그 뒤 client fixture → create_app() → load_plugins() → 여기 → ValueError

    코어 테스트 5건이 이것 때문에 `PluginLoadError: agent_type 'smb' 이미 등록됨` 으로
    죽고 있었다. 그 픽스처도 `except ValueError: continue` 로 방어하지만 **순서가
    반대**라 소용이 없다 — 픽스처가 먼저 등록하고 플러그인이 나중에 터진다.

    코어의 중복 거부 자체는 유지한다(오타·미부착 plugin 을 보이게 하는 UX 게이트).
    다만 "같은 사실을 두 번 선언한 것"은 충돌이 아니므로 plugin 쪽에서 흡수한다.
    다른 ValueError 는 그대로 올린다 — 삼키면 진짜 배선 오류가 숨는다.

    ⚠️ 코어 메시지가 한국어/영어로 갈려 있어(`… 이미 등록됨` vs
    `task_type toolset already registered: …`) 둘 다 본다. 단 `_HARD_CONFLICTS` 는
    **삼키지 않는다** — 같은 이름에 **다른 내용**이 등록된 진짜 충돌이다.
    """
    msg = ""
    try:
        fn(*args, **kwargs)
    except ValueError as e:
        msg = str(e)
        soft = ("이미 등록됨" in msg) or ("already registered" in msg)
        if soft and not any(h in msg for h in _HARD_CONFLICTS):
            return False
        raise
    return True



def _with_report_tool(provider):
    """도메인 도구셋 + 공통 `report_inspection` (Phase 3a).

    검토원이 리드에게 **판단을 전달할 유일한 채널**이다. 없으면 리드는 코어가 만든
    템플릿 summary(`task …: reason=end_turn, submit=True`)만 받는다 — 내용 0.
    종료 도구는 아니다(안 불러도 워커는 오늘처럼 끝난다).
    """
    def _inner():
        from _shared.inspector_report import ReportInspectionTool

        classes = list(provider())
        if ReportInspectionTool not in classes:
            classes.append(ReportInspectionTool)
        return classes
    return _inner


def _inspect_toolsets() -> dict:
    """검토원 task_type → 도구셋 provider. `build_registry_for_task` 가 무인자로 부른다."""
    from domains.dev_web.plugin.toolsets import dev_web_task_tools
    from domains.services.confluence.plugin.toolsets import confluence_task_tools
    from domains.services.github.plugin.toolsets import github_task_tools

    return {
        "dev_web": _with_report_tool(dev_web_task_tools),
        "github": _with_report_tool(github_task_tools),
        "confluence": _with_report_tool(lambda: confluence_task_tools(None)),
        "confluence_search": _with_report_tool(
            lambda: confluence_task_tools("keyword_search")),
    }


def _lead_specs() -> tuple[tuple, ...]:
    """(어댑터 팩토리, 그 도메인의 agents 디렉터리) — 리드 5종.

    `agents_dir` 는 코어 `AgentTool` 이 검토원 정의를 찾는 **유일한** 경로다
    (`load_agents` 는 디렉터리 하나만 본다). 도메인별로 고정해 두면 코어 확장
    (`register_subagent_dir`) 없이 닿으면서, 리드가 남의 도메인 검토원을 spawn 하는
    것도 구조적으로 막힌다.
    """
    from domains.dev_web.plugin.lead_adapter import dev_web_lead_adapter
    from domains.services.confluence.plugin.lead_adapter import (
        confluence_lead_adapter, confluence_search_lead_adapter,
    )
    from domains.services.github.plugin.lead_adapter import github_lead_adapter
    from domains.smb.plugin.lead_adapter import smb_lead_adapter

    return (
        (smb_lead_adapter, _REPO / "domains" / "smb" / "agents"),
        (dev_web_lead_adapter, _REPO / "domains" / "dev_web" / "agents"),
        (github_lead_adapter, _REPO / "domains" / "services" / "github" / "agents"),
        (confluence_lead_adapter,
         _REPO / "domains" / "services" / "confluence" / "agents"),
        (confluence_search_lead_adapter,
         _REPO / "domains" / "services" / "confluence" / "agents"),
    )


def _register_lead_layer() -> None:
    """리드 계약·도구셋 등록 (Phase 2).

    ⚠️ 어댑터 등록이 계약 등록보다 **먼저**여야 한다 — 계약의 user_message 가 어댑터를
    조회하고, 없으면 fail-loud 한다.
    """
    from secu_agent.agent.task_contract import register_task_contract
    from secu_agent.agent.tools import register_task_toolset

    from _shared.lead_adapter import register_lead_adapter
    from _shared.lead_contract import build_lead_contract
    from _shared.lead_tools import lead_tools

    for factory, agents_dir in _lead_specs():
        adapter = factory()
        register_lead_adapter(adapter)
        contract = build_lead_contract(domain=adapter.domain, agents_dir=agents_dir)
        _register_idempotent(register_task_toolset, contract.task_type, lead_tools)
        _register_idempotent(register_task_contract, contract)


def _register_thread_layer() -> None:
    """스레드 어댑터 등록 (조치요청 + 재검증 큐 배관, 4도메인).

    ★ 2026-08-31 — `_shared/thread_adapter.py` 는 2026-08-26 에 계약만 쓰이고
      **호출부가 0** 인 채로 남아 있었다(메모리 `wiring-that-was-never-wired`).
      여기가 그 계약을 살리는 유일한 자리다.

    ⚠️ 팩토리는 전부 **지연 import** 다. application 층(`scanner`/`reporter`)이나
       에이전트를 최상위에서 끌면 부팅 때 무거운 배선이 딸려 온다.
    """
    from _shared.thread_adapter import register_thread_adapter

    from domains.dev_web.plugin.thread_adapter import dev_web_thread_adapter
    from domains.services.confluence.plugin.thread_adapter import confluence_thread_adapter
    from domains.services.github.plugin.thread_adapter import github_thread_adapter
    from domains.smb.plugin.thread_adapter import smb_thread_adapter

    for factory in (
        smb_thread_adapter,
        github_thread_adapter,
        confluence_thread_adapter,
        dev_web_thread_adapter,
    ):
        register_thread_adapter(factory())


def _register_reply_blocks() -> None:
    """회신 본문 블록 등록 — LLM 이 **고르기만** 하는 검증된 문단들.

    ⚠️ 문구는 전부 이미 발송 중인 조치요청 메일에서 온 것이다. 새로 쓰지 마라 —
       최초 메일과 회신이 같은 사안에 다른 절차를 말하면 담당자가 혼란스럽다.
       드리프트는 `service/tests/test_reply_blocks_no_drift.py` 가 잡는다.
    """
    from _shared.reply_body import register_reply_block

    from domains.dev_web.plugin.reply_blocks import dev_web_reply_blocks
    from domains.services.confluence.plugin.reply_blocks import confluence_reply_blocks
    from domains.services.github.plugin.reply_blocks import github_reply_blocks
    from domains.smb.plugin.reply_blocks import smb_reply_blocks

    for factory in (smb_reply_blocks, github_reply_blocks,
                    confluence_reply_blocks, dev_web_reply_blocks):
        for block in factory():
            register_reply_block(block)


def register_all() -> None:
    """전 항목 등록 — bootstrap import 시 1회 실행 (엔진 load_plugins 멱등 보장).

    등록 자체도 **멱등**이다(`_register_idempotent`) — 같은 이름이 이미 있으면 넘긴다.
    """
    # 0. 스킬 state 스키마 순수-메모리 등록 (P2 W2 — DB 무접근·dormant, 컷오버 때 활성).
    _register_state_schemas()

    # 0a. 추출 detectors seam 재연결 (도메인 agent_type/tool import 전에 선행).
    _bind_extracted_detectors()

    # 0b. finding enricher 등록 (de-domain v3.84 #3 — 코어 훅에 skill pivot 배선).
    _bind_pivot_and_register()

    # 1. agent_types
    for name in ("smb", "web", "dev_web", "github", "jenkins", "confluence"):
        _register_idempotent(register_agent_type, name)

    # 1-alias. agent_type → task_type 라우팅 별칭 (코어 v3.85 훅).
    #   'smb' 챗 세션은 operator 레지스트리/프롬프트로 라우팅한다. 원래 코어가
    #   `_CORE_TASK_TYPE_ALIASES` 에 하위호환 시드로 들고 있었는데, 코어에 도메인
    #   이름이 박혀 있는 것이라 2026-08-20 에 여기로 이관했다.
    #   ⚠️ 이건 UX/prompt 라우팅이지 보안 게이트가 아니다.
    from secu_agent.agent_type_registry import register_task_type_alias

    _register_idempotent(register_task_type_alias, "smb", "operator")

    # 1-nostash. 가벼운 enum/list 결과는 stash 하지 않는다 (코어 등록형 훅).
    #   코어 engine 이 도메인 도구 이름 9개를 하드코딩하고 있었고 그중 7개는 이미
    #   존재하지 않는 이름이었다 — 도구가 사라져도 코어는 알 길이 없었다.
    #   여기서 **실재하는 도구만** 등록한다.
    from secu_agent.agent.engine import register_no_stash_tool

    for _t in ("confluence_list_pages", "confluence_list_attachments"):
        _register_idempotent(register_no_stash_tool, _t)

    # 1a. 검토원(inspector) 계약 — Phase 1. 오늘의 도메인 워커를 코어가 sub-agent 로
    #     spawn 할 수 있게 하는 배선이다. 도구셋+계약이 **쌍**으로 있어야 한다:
    #     계약만 있으면 코어가 rc=2 로 죽고(배선 누락 가드), 도구셋만 있으면
    #     `agents/*.md` 가 가리킬 대상이 없어 도달 불가다(구 smb 2단이 그 상태였다).
    #
    #     smb 검토원의 도구셋은 **오늘 워커의 것**(`smb_task_tools`)이다. 구
    #     `smb_file_inspect_tools`(ReadFileContentTool+ReportInspectionTool)는 파일 1개
    #     단위 위임용이라 오늘 워커와 동등하지 않다 — Phase 1 게이트가 "오늘과 동등"이다.
    #     (2026-08-21: 등록→unregister→재등록 하던 왕복을 없앴다. 구 도구셋은 애초에
    #      등록되지 않는다.)
    from secu_agent.agent.task_contract import register_task_contract
    from secu_agent.agent.tools import register_task_toolset

    from domains.dev_web.plugin.inspect_contract import dev_web_inspect_contract
    from domains.services.confluence.plugin.inspect_contract import (
        confluence_inspect_contract, confluence_search_inspect_contract,
    )
    from domains.services.github.plugin.inspect_contract import github_inspect_contract
    from domains.smb.plugin.inspect_contract import smb_inspect_contract
    from domains.smb.plugin.toolsets import smb_task_tools

    _register_idempotent(
        register_task_toolset, "smb_file_inspect", _with_report_tool(smb_task_tools))

    for _factory, _tools in (
        (dev_web_inspect_contract, "dev_web"),
        (github_inspect_contract, "github"),
        (confluence_inspect_contract, "confluence"),
        (confluence_search_inspect_contract, "confluence_search"),
    ):
        _c = _factory()
        _register_idempotent(register_task_toolset, _c.task_type, _inspect_toolsets()[_tools])
        _register_idempotent(register_task_contract, _c)
    _register_idempotent(register_task_contract, smb_inspect_contract())

    # 1a-3. 리드(lead) 계약 — Phase 2. 검토원 위에 얹는 **판단** 층이고, Phase 3 에서
    #       codex(사외 egress)가 앉을 자리다. 그래서 리드 도구셋은 도메인 무관 5개로
    #       고정하고(본문 반환 도구 없음), 검토원 보고는 마스킹 봉투로만 리드에 닿는다.
    _register_lead_layer()

    # 1a-4. 스레드(조치요청·재검증) 계약 — 리드와 같은 결이다. 회신 본문 조립이
    #       이 위에 올라가므로 도메인별 분기 없이 `get_thread_adapter(domain)` 하나로
    #       티켓을 읽는다.
    _register_thread_layer()
    _register_reply_blocks()

    # 1b. memory scope (구 코어 SMB 어휘 host/share/path_pattern — de-domain v3.84 #5).
    #     코어 base 는 global/operator 뿐 — 도메인 scope 는 여기서 등록.
    for scope in ("host", "share", "path_pattern"):
        _register_idempotent(register_memory_scope, scope)

    # 2. finding 분류 (구 코어 enum 2종 — 증거 게이트 동일 수준 복원)
    _register_idempotent(
        register_finding_category,
        "semiconductor_process", label="공정 정보", priority=7,
        requires_content_evidence=True,
    )
    _register_idempotent(
        register_finding_category,
        "business_confidential", label="경영 기밀", priority=6,
        requires_content_evidence=True,
    )

    # 3. 민감어휘 시그널 (_shared 사전)
    terms = _load_repo_module(
        "secu_skill_sensitive_terms", "_shared/detectors/sensitive_terms.py",
    )
    _register_idempotent(
        register_sensitive_term_signal,
        "semiconductor_process", kind="process_keyword_context",
        terms=terms.SEMICONDUCTOR_TERMS,
    )
    _register_idempotent(
        register_sensitive_term_signal,
        "business_confidential", kind="business_keyword_context",
        terms=terms.BUSINESS_TERMS,
    )

    # 4. SMB evidence judge (plugin/smb_evidence_judge.py — 구 코어 원형, 약화 금지)
    judge_mod = _load_repo_module(
        "secu_skill_smb_evidence_judge", "plugin/smb_evidence_judge.py",
    )
    _register_idempotent(register_evidence_judge, "smb", judge_mod.judge_smb_credential_hit)

    # 4b. PII 정오탐 category judge (plugin/pii_evidence_judge.py). category 축
    #     등록형이라 모든 task_type 의 pii hit 이 코어 약한 계약 이전에 통과한다 —
    #     부동소수 소수부/무효 날짜 RRN 등 구조적 오탐 거부(약화 없음, 정상 PII 는 폴백).
    pii_judge_mod = _load_repo_module(
        "secu_skill_pii_evidence_judge", "plugin/pii_evidence_judge.py",
    )
    _register_idempotent(register_category_evidence_judge, "pii", pii_judge_mod.judge_pii_hit)

    # 4c. github 시크릿 정오탐 category judge (plugin/github_secret_evidence_judge.py).
    #     submit_finding(서술형) 경로를 스캔 경로와 **같은 secret_gate 규칙**에 합류시킨다 —
    #     코어 계약은 값 형상만 봐서 테스트 픽스처/.env.example/벤더 SDK 오탐이 통과했다
    #     (#18788 #18823 #18693). github 아닌 task_type 은 None 폴백(confluence 보호).
    gh_secret_judge_mod = _load_repo_module(
        "secu_skill_github_secret_evidence_judge",
        "plugin/github_secret_evidence_judge.py",
    )
    _register_idempotent(register_category_evidence_judge, "secret", gh_secret_judge_mod.judge_secret_hit)

    # 5. browser 검증 게이트 (정책 A — SSO 점검 task_type)
    for ht in ("web", "dev_web", "devops", "github", "confluence"):
        _register_idempotent(register_browser_verified_task_type, ht)

    # 5b. 그 게이트의 **면제** — github API repo 스캔 레인 한정.
    #     같은 task_type 'github' 안에 브라우저를 쥔 SSO 레인과 브라우저가 없는 스캔
    #     레인이 같이 산다. 스캔 레인은 게이트를 만족시킬 방법이 원천적으로 없어서
    #     08-27 제출 14건이 14건 다 죽었다. 판단 근거는 자산 문자열이 아니라 수집
    #     방식이다 — 근거·한계는 browser_gate_exemption.py docstring 참조.
    from domains.services.github.plugin.browser_gate_exemption import (
        github_api_scan_exempt,
    )
    _register_idempotent(register_browser_verification_exemption, github_api_scan_exempt)

    # 6. skill 기본 unlock 도구 (원형 보존 매핑)
    unlock = _load_repo_module(
        "secu_skill_unlock_tools", "engine_extracts/skill_default_unlock_tools.py",
    )
    for skill_name, tools in unlock.DEFAULT_UNLOCK_TOOLS_BY_SKILL.items():
        _register_idempotent(register_skill_unlock_tools, skill_name, tools)

    # 7. task_type canonicalizer (구 코어 v3.74 휴리스틱 원형)
    identity = _load_repo_module(
        "secu_skill_finding_identity", "service/services/finding_identity.py",
    )
    register_task_type_canonicalizer(identity.canonicalize_by_asset)

    # 7b. defensive-security instructions preamble (구 코어 _CODEX_CYBER_PREAMBLE 원형).
    #     de-domain v3.84 #1 — 코어 transport 는 등록된 preamble 을 결합만 한다.
    preamble_mod = _load_repo_module(
        "secu_skill_instruction_preamble", "plugin/instruction_preamble.py",
    )
    register_instruction_preamble(preamble_mod.cyber_preamble)

    # 8. SMB E2E fanout 어댑터 (task=share, mail/reverify=thread; 재부착 hook).
    #    de-domain 엔진에 fanout 모듈 있으면 등록, 모놀리스면 조용히 skip.
    fanout = _load_repo_module(
        "secu_skill_smb_fanout_adapter", "domains/smb/plugin/fanout_adapter.py",
    )
    fanout.register()

    # 9. dev_web E2E fanout 어댑터 (target/report/reverify thread; 엔진 무수정).
    dev_web_fanout = _load_repo_module(
        "secu_skill_dev_web_fanout_adapter", "domains/dev_web/plugin/fanout_adapter.py",
    )
    dev_web_fanout.register()

    # 10. GitHub E2E fanout 어댑터 (repo scan, SSO URL, repo report, repo recheck).
    github_fanout = _load_repo_module(
        "secu_skill_github_fanout_adapter",
        "domains/services/github/plugin/fanout_adapter.py",
    )
    github_fanout.register()

    # 11. Confluence E2E fanout 어댑터 (space API, SSO URL, report, recheck).
    confluence_fanout = _load_repo_module(
        "secu_skill_confluence_fanout_adapter",
        "domains/services/confluence/plugin/fanout_adapter.py",
    )
    confluence_fanout.register()


register_all()
