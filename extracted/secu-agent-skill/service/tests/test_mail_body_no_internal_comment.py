"""메일 본문에 HTML 주석이 실려 나가지 않는다 — 4도메인 공용.

## 왜 (2026-08-24)

dev_web 메일 템플릿에 내가 넣은 `<!-- 회신 안내는 여기 한 곳뿐이다 … -->` 가
**담당자 메일 본문에 그대로 실려 나갔다.** 우리에게만 의미 있는 내부 메모다.

잡은 건 그걸 노린 테스트가 아니라 `test_회신_안내가_한_번만_나온다` 가 "회신" 을
2회로 센 **우연**이었다. 주석이 다른 위치·다른 문구였으면 안 걸렸다.

> 노린 게 아닌 테스트가 잡았다는 건, 노린 테스트가 없다는 뜻이다.

그래서 이 파일이 있다. 렌더러에 경고 주석을 다는 것으로는 다음번을 못 막는다.

## 같이 고친 것 — 안 보이는 잘림 표시

github·confluence 는 본문이 길면 `<!-- … report body truncated -->` 를 붙였다.
**주석은 메일 클라이언트에서 안 보인다** — 담당자는 본문이 잘린 줄도 몰랐고,
잘려 나간 조치 대상을 놓쳤다. 보이는 문단으로 바꿨다.
"""
from __future__ import annotations

import inspect
import re

# 메일 본문을 만드는 함수들. 새 도메인이 생기면 **여기 추가한다.**
_RENDERERS = (
    ("smb", "service.services.smb_remediation_report", "_render_html"),
    ("dev_web", "domains.dev_web.plugin.tools.dev_web_report_tools", "_html_report"),
    ("github", "domains.services.github.application.scanner", "_report_html"),
    ("confluence", "domains.services.confluence.application.reporter", "_report_html"),
)

# 소스에서 docstring/주석을 걷어낸 뒤 남는 `<!--` 만 문제다.
_PY_COMMENT = re.compile(r"^\s*#.*$", re.M)


def _source_without_comments(fn) -> str:
    src = inspect.getsource(fn)
    src = _PY_COMMENT.sub("", src)
    doc = inspect.getdoc(fn)
    if doc:
        for line in doc.splitlines():
            src = src.replace(line, "")
    return src


def test_4도메인_렌더러가_HTML주석을_만들지_않는다() -> None:
    """★ 본체. 템플릿 문자열에 `<!--` 가 있으면 그대로 발송된다."""
    import importlib

    offenders = []
    for domain, module, func in _RENDERERS:
        fn = getattr(importlib.import_module(module), func)
        if "<!--" in _source_without_comments(fn):
            offenders.append(f"{domain}:{module}.{func}")
    assert not offenders, (
        f"메일 본문에 HTML 주석이 들어간다 — 내부 메모가 담당자에게 간다: {offenders}"
    )


def test_본문_잘림은_담당자에게_보인다() -> None:
    """주석으로 표시하면 담당자는 잘린 줄도 모른다."""
    from domains.services.confluence.application import reporter as cf
    from domains.services.github.application import scanner as gh

    for mod in (gh, cf):
        out = mod._mail_body("x" * (mod._MAIL_BODY_LIMIT + 10))
        assert "<!--" not in out, f"{mod.__name__}: 잘림 표시가 여전히 주석이다"
        assert "일부만 표시" in out, f"{mod.__name__}: 잘렸다는 사실이 안 보인다"
        # 안 잘리면 아무것도 안 붙는다.
        assert mod._mail_body("짧은 본문") == "짧은 본문"


def test_렌더러_목록이_실제_함수를_가리킨다() -> None:
    """위 목록이 낡으면 이 파일 전체가 조용히 무의미해진다."""
    import importlib

    for domain, module, func in _RENDERERS:
        mod = importlib.import_module(module)
        assert callable(getattr(mod, func, None)), f"{domain}: {module}.{func} 없음"
