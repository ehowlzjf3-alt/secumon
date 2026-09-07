"""github 시크릿 finding 정오탐 게이트 — 생성 경로들이 **공유**하는 단일 규칙.

## 왜 별도 모듈인가

2026-07-23 에 게이트를 결정론 스캔 경로에만 달았는데 실제로 도는 건 도구 경로였다.
그래서 오탐 149건을 만든 경로는 그대로 무방비였다. 규칙을 두 벌 쓰면 또 어긋나므로
여기 한 곳에 두고 쓰는 쪽이 import 한다.

## 2026-08-27: 결정론 경로가 사라졌다

`scanner._persist_scan_findings`(clone+detector, LLM 없음)는 **삭제됐다**(967줄).
규칙 게이트를 통과하는 것과 "에이전트가 판단했다" 는 다른 사실인데, 그 경로는 후자를
영영 만족할 수 없었다 — 오늘까지 27,414건을 넣었고 그중 판정을 거친 것은 7건이었다.

남은 소비자는 둘이다:

1. `service_task_tools::_persist_scanned_findings` — 스캔 도구. github 은 이제
   **등록하지 않고** 후보만 돌려준다. 게이트는 후보 단계 노이즈를 줄이는 데 쓴다.
2. `plugin/github_secret_evidence_judge` — `github_submit_finding` → 코어
   `judge_task_finding` 경로. **에이전트가 제출한 것**만 여기 온다.

## 무엇을 거르나 (실측 기반)
관측 정밀도 2.6%(진짜 4 / 오탐 149). 오탐의 정체는 **key-name 기반 generic 매치** —
코드·문서·example 의 `password` 변수, 주석, shell 명령치환, 템플릿 플레이스홀더,
`max_tokens` 같은 ML 어휘. 값 형상이 이미 검증된 구조화-시크릿만 통과시킨다.

실험 오탐 149건 역적용 결과: 기본 규칙 136/149(91%) → 보강 규칙 포함 **142/149(95%)**.
사람이 실검토해 KEEP 판정한 진짜 4건(#18333 #18343 #18393 #18562)은 전원 생존.

## v3.92(2026-07-29) 2차 보강 — 통과 hit 10,099건 역적용으로 고름
`.mjs` 가 코드 경로 규칙에서 빠져 있어 itdevsec/SecuLens 오탐 27건이 통째로 샜다
(워커 자신은 "27건 모두 기각"으로 닫았는데 finding 은 남았다). ESM/CJS 확장자 추가 +
값 형상 3종(코드 구두점 종결·코드 연산자 포함·전부 마스킹) 추가.
효과: SecuLens 27→2, 전체 finding 9,881→9,817, 진짜 4건 **전원 생존**.

⚠️ 규칙 문자를 고를 때 **base64 문자집합(A-Za-z0-9+/=)과 비밀번호 특수문자는 쓰면 안 된다.**
초안이 `!`/`?` 를 코드 구두점에 넣어 실제 비밀번호 `1q2w*e4r!` 를 죽였고, `==`/`++` 를
연산자에 넣어 base64 값 1,090건을 죽였다. 둘 다 실데이터 역적용으로 잡았다.

## v3.94(2026-07-30) 3차 보강 — fixture/vendor 경로 + submit_finding 경로 합류
게이트가 붙은 곳은 **스캔 경로 두 곳**뿐이었다. LLM 이 직접 부르는 `submit_finding`
(코어 `judge_task_finding`)은 값 형상만 보고 **경로 맥락을 전혀 안 본다**. 실측: submit
경로 github finding 10건 중 3건이 오탐이고 셋 다 `_STRUCTURED_SECRET_KINDS` 라
**이 게이트로도 안 걸렸다**(구조화 시크릿은 경로 무관 통과였기 때문).

  #18788 `tests/test_search_compressor.py`  database_url_with_password (테스트 픽스처)
  #18823 `.../ThirdParty/IOS/include/FIROptions.h` google_api_key (Firebase SDK 공개 헤더)
  #18693 `.env.example`                    database_url_with_password (샘플 설정)

⇒ ①`_FIXTURE_OR_VENDOR_PATH_RE` 를 **구조화 시크릿에도** 적용(계약 변경).
  ②`repo_relative_path()` 로 blob URL → repo 상대경로 정규화(submit 경로는 location 이
    전체 URL 이라 `#L60` 때문에 `\\.py$` 류가 조용히 발화하지 못했다).
  ③submit 경로는 `plugin/github_secret_evidence_judge.py` 가 이 모듈을 호출한다.

⚠️ 이 규칙은 `_CODE_OR_SAMPLE_PATH_RE` 보다 **훨씬 좁아야** 한다. 넓은 쪽을 구조화
시크릿에 먹이면 KEEP 판정된 **#18333(진짜 private key, `.java`)이 죽는다**. 그래서
"확장자" 가 아니라 "픽스처/샘플/벤더 **디렉터리·접미**" 만 본다.

## v3.95(2026-08-16) 4차 — 공개 인증서 자료
finding #18900 `jerryan-leem/pub/ca-cert.pem`: PEM 인증서 **한 덩어리**를 detector 가
`high_entropy_string` **8조각**으로 쪼갰다(base64 본문이라 전부 고엔트로피). 8개의 비밀이
아니라 하나의 인증서다. 인증서는 배포용 신뢰앵커라 **공개가 전제**고, 유출되는 건 개인키다.

왜 기존 규칙이 못 잡았나: `high_entropy_string` 분기는 **경로만** 본다
(`return not _CODE_OR_SAMPLE_PATH_RE.search(path)`). `ca-cert.pem` 은 코드/샘플 경로가
아니라 그대로 통과했다. 값 형상도 못 본다 — 조각 하나(`MIIE****…CQYD`)만 보면
인증서인지 개인키인지 구분이 안 된다(둘 다 DER base64 라 `MII` 로 시작한다).

⇒ **이 규칙만 문서 본문을 본다**(`any_reportable_hit(..., document=...)`).
  `is_public_certificate_material()` 가 `BEGIN CERTIFICATE`/`PUBLIC KEY` 를 찾되
  **개인키 마커가 하나라도 있으면 무조건 False**. 이 순서를 뒤집으면 KEEP #18333
  (`javasource/.../Util.java` 의 진짜 private key)이 죽는다.

⚠️ 경로/확장자로 판단하지 않았다. `.pem` 은 `privkey.pem` 도 쓰는 확장자고, 실측에서
   후보 93건 중 3건이 `public_key.pem` 이었다 — 파일명 휴리스틱은 **양방향으로 틀린다**.

역적용(github finding 18,112건): 차단 **0건**, KEEP 4건 전원 생존. 0건인 이유는 저장된
finding 에 파일 본문이 없어 규칙이 발동할 수 없기 때문이다 — **안전 확인이지 소급 정리가
아니다.** 같은 부류로 보이는 open finding 93건은 본문 재확인(워커 recheck) 대상으로 남는다.

## ⚠️ confluence 에 쓰지 말 것
`_CODE_OR_SAMPLE_PATH_RE` 가 `.md` 를 제외하는데 confluence 근거는 위키 본문이라
전량 제외돼 버린다. 호출부에서 반드시 `task_type == "github"` 로 한정한다.

kill-switch: `SA_GITHUB_SECRET_GATE=0` (전부 통과 = 게이트 이전 동작).
"""
from __future__ import annotations

import os
import re

# 값 형상이 검증된 진짜 시크릿 — 경로 무관 통과.
_STRUCTURED_SECRET_KINDS = frozenset({
    "github_pat", "github_oauth", "gitlab_pat", "private_key_block", "rsa_private_key",
    "ssh_private_key", "database_url_with_password", "aws_access_key_id",
    "aws_secret_access_key", "google_api_key", "slack_token", "stripe_key",
    "npm_token", "jwt",
})
# key-name 만 보고 잡는 generic 매치 — 오탐의 주력.
_GENERIC_KEYNAME_KINDS = frozenset({
    "generic_password_assignment", "generic_config_secret_assignment",
    "generic_password_envline",
})
# github secret finding 대상이 아닌 저가치 PII.
_LOW_VALUE_KINDS = frozenset({
    "email", "person_name_with_label", "person_name", "address_with_label",
})

# 값이 시크릿이 아니라 코드/문서 형상: 메서드콜·주석·연산자·URN·세미콜론 종결.
_CODE_MASK_RE = re.compile(r"\(\s*\)|/\*|\*/|->|::|=>|;\s*$|urn:|function\b|return\b")
# 소스코드/문서/샘플 경로(진짜 시크릿이 있을 곳이 아님).
_CODE_OR_SAMPLE_PATH_RE = re.compile(
    # v3.92: `mjs|cjs|mts|cts` 추가. `js|ts` 는 있는데 **ESM/CJS 확장자만 빠져** 있었다.
    # 실측 itdevsec/SecuLens 는 전 파일이 `.mjs` 라 경로 규칙이 아예 발화하지 않았고,
    # 그 repo 하나에서 오탐 27건이 통과했다(`.js` 였으면 전부 걸렸다).
    r"(?i)\.(?:java|kt|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|go|rb|cs|cpp|cc|c|h|hpp"
    r"|md|rst|xml|gradle|smali|dex)$"
    r"|(?:^|/)(?:test|tests|example|examples|sample|samples|mock|mocks|fixture|fixtures|docs?)/"
    r"|\.(?:example|sample|template|dist)$|apks?/"
)

# ── 보강 규칙(2026-07-27) ────────────────────────────────────────────────
# 기본 규칙이 놓친 오탐 13건의 실제 형태에서 도출. masked 는 앞4+****+뒤4 라
# 접두/접미가 보존되므로 형상 판정이 가능하다.
#   shell 명령치환   '$(_r*****oken'  '$(ge****ken)'  '$(py****3 -c'
#   템플릿 플레이스홀더 '__DS*************EN__'  '__GE***********RD__'
#   ML/파서 어휘      'max_**kens'(max_tokens)  'args*******kens'(args.tokens)
# 이들은 `path=''`(commit_patch)라 경로 규칙이 아예 발화하지 못하는 케이스가 많아
# **값 형상**으로 잡아야 한다.
_CMD_SUBST_RE = re.compile(r"\$\(|\$\{|`")
_PLACEHOLDER_RE = re.compile(r"\A__.*__\Z|\A<.*>\Z|\A\{\{.*\}\}\Z")
# ⚠️ 접두 어휘만 보면 안 된다. 초안은 `n` 단독 대안 + optional 구분자였는데,
# 그러면 `N7Q9pL4x…` 같은 **고엔트로피 시크릿이 전부 오탐 처리**된다(리포 테스트가 잡음).
# 그래서 "어휘로 시작"과 "토큰 이름으로 끝남"을 **둘 다** 요구한다.
# masked 는 앞4+****+뒤4 라 `max_tokens` → `max_**kens`, `args.tokens` → `args*******kens`.
_NON_CRED_TOKEN_RE = re.compile(
    r"(?i)\A(?:max|min|num|total|count|args?|self|input|output|prompt|"
    r"completion|context|chunk|batch|eos|bos|pad|special|sub|access_log)"
    r"[_.*].*(?:oken|okens|kens)\Z"
)
_CODE_CALL_RE = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*\($|\.\w+\($")

# ── 보강 규칙 2차(2026-07-29) ────────────────────────────────────────────
# 통과 hit 10,099건에 후보 규칙을 역적용해 **실측으로** 고른 것들이다.
# 초안 두 개가 진짜 시크릿을 죽여서 폐기했다 — 그 흔적을 남긴다:
#   ✗ `!`/`?` 종결을 코드로 판정 → 실제 비밀번호 `1q2w*e4r!` `post***s12!` 를 죽였다
#   ✗ `==`/`++` 를 연산자로 판정 → **base64 패딩**이라 `sha5…Ww==` 등 1,090건을 죽였다
# ⇒ 규칙 문자는 **base64 문자집합(A-Za-z0-9+/=)과 비밀번호 특수문자에 없는 것**만 쓴다.
#
# R-a 코드 구두점으로 끝남 — 시크릿 값은 `)` `[` `||` `,` 로 끝나지 않는다.
_CODE_TAIL_RE = re.compile(r"[)(\[\]{}|&<>;,]\s*$|\s:\s*$")
# R-b 코드 연산자/호출/정규식 리터럴이 값 안에 있다. `(` `|` `&` `>` 는 base64 에 없다.
_CODE_OPERATOR_RE = re.compile(r"\|\||&&|=>|\.\w+\(|\w+\(")
# R-c 근거가 통째로 마스킹돼 형상 판정 자체가 불가능 — 시크릿이라는 증거가 0이다.
_NO_EVIDENCE_RE = re.compile(r"\A\*+\Z")


# ── fixture/vendor 경로(2026-07-30) ─────────────────────────────────────
# 구조화 시크릿에도 적용되는 유일한 경로 규칙이라 **좁게** 유지한다.
# 확장자는 절대 넣지 않는다 — `.java`/`.py` 를 넣으면 #18333(진짜 private key,
# `javasource/.../Util.java`)·#18393(진짜 ghp_ PAT, `scripts/feedback_store.py`)이 죽는다.
# 디렉터리 경계(`tests/`·`vendor/`)와 파일명 규약(`test_*`·`*_test.*`), 샘플 접미만 본다.
_FIXTURE_OR_VENDOR_PATH_RE = re.compile(
    r"(?i)"
    r"(?:^|/)tests?/"                       # tests/ · test/
    r"|(?:^|/)__tests__/"                   # jest 관례
    r"|(?:^|/)spec/"                        # rspec/jasmine 관례
    r"|(?:^|/)test_[^/]*$"                  # pytest test_foo.py
    r"|(?:^|/)[^/]*_test\.[a-z0-9]+$"       # go/java foo_test.go
    r"|(?:^|/)conftest\.py$"
    r"|\.(?:example|sample|template|dist)$"  # .env.example 류
    # 벤더링된 서드파티 트리 — 우리 시크릿이 아니라 남의 SDK 다.
    r"|(?:^|/)(?:thirdparty|third_party|3rdparty|vendor|vendored|node_modules"
    r"|pods|bower_components|externals?)/"
)

# ⚠️ fixture/vendor 규칙에서 **면제**되는 kind — 코어가 하드 가드하는 민감 PII.
# `evidence_judgment._is_identifier_only_pii` 는 "진짜 민감 PII 는 어떤 등록 정책도 제외할
# 수 없다"를 코어 하드 가드로 두고 있다. 이 게이트는 **시크릿** 정오탐 전용이므로 그 판단을
# 가로채면 안 된다 — PII 정오탐은 `plugin/pii_evidence_judge.py` 와 코어 계약 소관이다.
#
# 실측(역적용)으로 드러난 사례: `output/test_20250918_201202.csv` (계측 결과 CSV) 5,007건이
# 파일명이 `test_` 로 시작한다는 이유만으로 fixture 규칙에 걸렸다. 전부 이미 false_positive
# 로 정리된 건이라 실해는 없었지만, **규칙이 RRN 을 죽일 수 있다**는 사실 자체가 계약 위반이다.
_FIXTURE_RULE_EXEMPT_KINDS = frozenset({
    "kr_rrn", "credit_card", "bank_account_with_label", "kr_phone",
    "passport", "ssn", "resident_registration_number",
})

# ── 공개 인증서 자료(2026-08-16) ────────────────────────────────────────
# ⚠️ 이 규칙만 **문서 본문**을 본다. 나머지는 kind/masked/path 만 본다.
#
# 실측 계기: finding #18900 `jerryan-leem/pub/ca-cert.pem` — PEM 인증서 한 덩어리를
# detector 가 `high_entropy_string` **8조각**으로 쪼갰다(base64 본문이라 전부 고엔트로피).
# 8개의 비밀이 아니라 하나의 인증서다. 게이트의 `high_entropy_string` 분기는 **경로만**
# 보기 때문에(`ca-cert.pem` 은 코드/샘플 경로가 아님) 그대로 통과했다.
#
# 인증서·공개키는 **공개가 전제**다(배포용 신뢰앵커·SSL 체인). 유출이 되는 건 개인키다.
#
# ★ 개인키가 한 조각이라도 섞이면 **절대 제외하지 않는다.** KEEP #18333 이 정확히
#   그 경우다(`javasource/.../Util.java` 안의 진짜 private key). 인증서와 개인키를
#   한 규칙으로 묶으면 진짜 유출이 죽는다.
# ★ 경로/확장자로 판단하지 않는다 — `.pem` 은 `privkey.pem` 도 쓰는 확장자다.
#   (같은 이유로 fixture 규칙도 확장자를 안 본다. 위 주석 참조.)
_PRIVATE_KEY_MARKER_RE = re.compile(r"(?i)BEGIN[ A-Z0-9]*PRIVATE KEY")
_PUBLIC_CERT_MARKER_RE = re.compile(
    r"(?i)BEGIN (?:TRUSTED |X509 )?CERTIFICATE"
    r"|BEGIN CERTIFICATE REQUEST"
    r"|BEGIN PUBLIC KEY"
    r"|BEGIN (?:RSA |DSA |EC )?PUBLIC KEY"
    r"|BEGIN DH PARAMETERS"
)


def is_public_certificate_material(text: str) -> bool:
    """이 본문이 **공개 인증서 자료**뿐인가 (개인키가 섞이면 False).

    True 면 그 문서에서 나온 `high_entropy_string`/`certificate` hit 은 시크릿이 아니다
    — base64 인증서 본문을 detector 가 조각낸 것이기 때문이다.

    ⚠️ 개인키 마커가 하나라도 있으면 **무조건 False**. 이 순서를 뒤집지 말 것.
    """
    t = str(text or "")
    if not t:
        return False
    if _PRIVATE_KEY_MARKER_RE.search(t):
        return False
    return bool(_PUBLIC_CERT_MARKER_RE.search(t))


# 공개 인증서 본문에서 나오면 시크릿이 아닌 kind. 그 외 kind(예: 같은 파일에 섞인
# aws_secret_access_key)는 평소 규칙대로 판정한다 — 인증서 파일이라고 전부 봐주지 않는다.
_CERT_BODY_NOISE_KINDS = frozenset({"high_entropy_string", "certificate", "x509_certificate"})

# blob/blame/raw/tree URL → repo 상대경로. `<owner>/<repo>/blob/<ref>/` 까지 버린다.
_REPO_BLOB_URL_RE = re.compile(
    r"(?i)^https?://[^/]+/[^/]+/[^/]+/(?:blob|blame|raw|tree)/[^/]+/(?P<path>.+)$"
)
# scan 경로 asset 표기(`github:owner/repo/path` · `github:owner/repo/commit/<sha>:path`).
_GITHUB_ASSET_RE = re.compile(r"(?i)^github:[^/]+/[^/]+/(?P<path>.+)$")


def repo_relative_path(location: str) -> str:
    """finding hit 의 `location` 에서 repo 상대경로만 뽑는다.

    submit_finding 경로의 location 은 **전체 blob URL** 이다:
      `https://github.samsungds.net/o/r/blob/main/tests/t.py#L60` → `tests/t.py`
    정규화 없이 경로 규칙을 먹이면 `#L60` 때문에 접미 규칙(`\\.py$`·`\\.example$`)이
    **조용히 발화하지 않는다** — 오탐이 통과한 실제 원인 중 하나.

    blob URL 이 아니면(예: `.git/config` 노출 URL, 이미 상대경로) host 만 벗기고
    나머지는 보존한다 — 판단 불가한 걸 억지로 자르지 않는다(보수적).
    """
    raw = str(location or "").strip()
    if not raw:
        return ""
    raw = raw.split("#", 1)[0].split("?", 1)[0]
    m = _REPO_BLOB_URL_RE.match(raw)
    if m:
        return m.group("path")
    m = _GITHUB_ASSET_RE.match(raw)
    if m:
        # commit_patch 형식은 `commit/<sha>:path` — `:` 뒤가 실제 파일 경로.
        path = m.group("path")
        if path.lower().startswith("commit/") and ":" in path:
            return path.split(":", 1)[1]
        return path
    if raw.lower().startswith(("http://", "https://")):
        rest = raw.split("://", 1)[1]
        return rest.split("/", 1)[1] if "/" in rest else ""
    return raw


def gate_disabled() -> bool:
    return os.environ.get("SA_GITHUB_SECRET_GATE", "1").strip().lower() in {
        "0", "false", "no", "off",
    }


def _code_shaped_value(masked: str) -> str | None:
    """값 형상만으로 '시크릿이 아님'이 확정되면 사유, 아니면 None."""
    m = (masked or "").strip()
    if not m:
        return None
    if _CMD_SUBST_RE.search(m):
        return "shell_command_substitution"
    if _PLACEHOLDER_RE.match(m):
        return "template_placeholder"
    if _NON_CRED_TOKEN_RE.match(m):
        return "non_credential_token_vocab"
    if _CODE_CALL_RE.search(m):
        return "code_call_expression"
    if _NO_EVIDENCE_RE.match(m):
        return "fully_masked_no_evidence"
    if _CODE_TAIL_RE.search(m):
        return "code_punctuation_tail"
    if _CODE_OPERATOR_RE.search(m):
        return "code_operator_in_value"
    return None


def is_reportable_secret(kind: str, masked: str, path: str) -> bool:
    """이 hit 을 github 시크릿 finding 으로 올릴 가치가 있나.

    두 경로 공용. `kind`/`masked`/`path` 는 원시 문자열이라 ScanFinding 이든
    service_task 의 hit dict 든 그대로 넣을 수 있다.
    """
    if gate_disabled():
        return True
    kind = str(kind or "").strip().lower()
    masked = str(masked or "")
    # v3.94: 정규화를 **여기 한 곳**에서 한다 — 호출부(스캔 2곳 + submit judge)가 각자
    # 하면 또 어긋난다. 이미 상대경로면 no-op 이라 스캔 경로는 byte-for-byte 동일.
    path = repo_relative_path(path)

    if kind in _LOW_VALUE_KINDS:
        return False  # 이메일/이름 등은 github secret finding 대상 아님
    # v3.94: 픽스처/샘플/벤더 경로는 **구조화 시크릿이라도** 우리 시크릿이 아니다.
    # 여기가 구조화 통과보다 앞에 있는 것이 이 보강의 핵심 — 뒤에 두면 #18788/#18823/
    # #18693 처럼 kind 가 구조화면 경로를 못 본다. 규칙은 좁게 유지할 것(위 주석 참조).
    if kind not in _FIXTURE_RULE_EXEMPT_KINDS and _FIXTURE_OR_VENDOR_PATH_RE.search(path):
        return False
    if kind in _STRUCTURED_SECRET_KINDS:
        return True   # 값 형상 검증된 진짜 시크릿(픽스처/벤더 경로 외에는 경로 무관)
    # 여기부터는 generic/미지 kind — 값 형상이 코드면 경로와 무관하게 오탐.
    if _code_shaped_value(masked):
        return False
    if kind in _GENERIC_KEYNAME_KINDS:
        return not (_CODE_MASK_RE.search(masked) or _CODE_OR_SAMPLE_PATH_RE.search(path))
    if kind == "high_entropy_string":
        return not _CODE_OR_SAMPLE_PATH_RE.search(path)
    # 미지 kind: 저가치/코드 경로가 아니면 보수적으로 유지.
    return not _CODE_OR_SAMPLE_PATH_RE.search(path)


def is_reportable_submitted_secret(kind: str, masked: str, location: str) -> bool:
    """`submit_finding`(LLM 서술형) 경로 전용 판정 — **fixture/vendor 규칙만** 적용한다.

    ## 왜 스캔 경로와 규칙이 다른가 (실측으로 강제된 설계)
    스캔 경로의 `kind` 는 detector 가 내는 **닫힌 집합**이라 `_STRUCTURED_SECRET_KINDS`
    화이트리스트가 성립한다. submit 경로의 `kind` 는 **모델이 지어낸 문자열**이다 —
    `grafana_api_token`·`auth_token`·`database_password` 처럼 목록에 없는 이름이 온다.
    그 미지 kind 를 스캔 경로 규칙에 태우면 "미지 → 코드/문서 경로면 제외" 분기로 떨어져
    **진짜 유출이 죽는다.**

    실제로 죽을 뻔한 것: #18866 — `skills/…/skill.md` 의 Grafana 서비스계정 토큰
    (`glsa_…` 전체 값 + 동작하는 curl 명령). `.md` 라는 이유만으로 차단됐다.
    문서 파일에 붙여넣은 실토큰은 **전형적인 유출 경로**지 오탐이 아니다.

    ⇒ 여기서는 값 형상 판정을 코어에 맡긴다. 코어 `judge_task_finding` 의
    `_has_hardened_credential_value` 가 이미 값 형상(PEM/토큰 접두/key=value)을 요구하므로,
    이 게이트가 더할 수 있는 유일한 정보는 **경로 맥락**(픽스처·샘플·벤더)뿐이다.
    """
    if gate_disabled():
        return True
    kind = str(kind or "").strip().lower()
    path = repo_relative_path(location)

    if kind in _LOW_VALUE_KINDS:
        return False
    if kind in _FIXTURE_RULE_EXEMPT_KINDS:
        return True   # 민감 PII 는 코어 하드 가드 소관 — 경로로 죽이지 않는다
    # 값 자체가 공개 인증서면 시크릿이 아니다(개인키가 섞이면 이 함수가 False 를 준다).
    # submit 경로는 모델이 hit 에 값 전문을 담으므로 여기서는 masked 만으로 판정 가능하다.
    if is_public_certificate_material(str(masked or "")):
        return False
    if _FIXTURE_OR_VENDOR_PATH_RE.search(path):
        return False
    # 값이 명백히 코드/플레이스홀더면 거부(경로 무관) — 이건 스캔 경로와 같은 판단이다.
    return not _code_shaped_value(str(masked or ""))


def any_reportable_hit(hits: object, path: str, *, document: str | None = None) -> bool:
    """hit 목록 중 하나라도 통과하면 finding 을 유지한다.

    hit 은 dict(`kind`/`masked`) 또는 같은 속성을 가진 객체 둘 다 받는다.
    hit 이 하나도 없으면 **유지**한다 — 이 게이트는 시크릿 hit 정오탐 전용이고,
    hit 없는 finding 의 처리는 코어 judge 소관이다.

    `document` 는 hit 이 나온 **파일 본문**(선택). 주면 공개 인증서 판정을 할 수 있다 —
    개별 hit 의 masked 조각(`MIIE****…CQYD`)만으로는 인증서인지 알 수 없기 때문이다.
    안 주면 기존 동작 그대로다(호출부가 본문을 못 구하는 경로는 무영향).
    """
    if gate_disabled():
        return True
    cert_only = is_public_certificate_material(document or "")
    seen = False
    for h in hits or []:  # type: ignore[union-attr]
        if isinstance(h, dict):
            kind, masked = h.get("kind"), h.get("masked")
        else:
            kind, masked = getattr(h, "kind", None), getattr(h, "masked", None)
        if kind is None and masked is None:
            continue
        seen = True
        # 공개 인증서 본문이면 그 base64 조각은 비밀이 아니다. 단, 같은 파일에 섞인
        # 다른 kind(진짜 키·토큰)는 아래에서 평소 규칙대로 계속 본다.
        if cert_only and str(kind or "").strip().lower() in _CERT_BODY_NOISE_KINDS:
            continue
        if is_reportable_secret(str(kind or ""), str(masked or ""), path):
            return True
    return not seen
