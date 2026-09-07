# 메일 egress 정책 — 단일 기준 (SSOT)

메일 발송 제약이 **세 곳에 흩어져 축마다 달랐다**(2026-08-15 실측). 이 문서가 기준이고,
설정 파일들은 여기를 가리킨다. **값을 바꿀 땐 여기부터 고치고 아래 3곳을 맞춘다.**

## 현재 정책

> **실 자산담당자에게 메일이 나가면 안 된다.** 수신자는 `dssoc@samsung.com` 과
> `shaneee.baek@samsung.com`(운영자 본인) **둘뿐**이다.

```
SA_DELIVERY_RECIPIENT_ALLOW="dssoc@samsung.com,shaneee.baek@samsung.com"
SMB_/GITHUB_/CONFLUENCE_/DEV_WEB_REMEDIATION_MAIL_MODE="normal"
```

## ★★ 지금 안 나가는 이유는 **드라이런이 아니라 화이트리스트 2개다**

가장 자주 오해하는 지점이고, 2026-08-24 에 두 세션이 **동시에** 틀렸다.

```
SA_DELIVERY_AUTOSEND_SINKS="knox_mail"      ← 로컬 .env 에 이미 켜져 있다
```

자율발송은 **켜져 있다.** 실 담당자 722명에게 안 나가는 건 `RECIPIENT_ALLOW` 가 정확히
두 주소이기 때문이고, 화이트리스트 밖 수신자는 배달 계층이 dry-run 초안으로 떨어뜨린다.

⇒ **그 목록을 넓히는 순간 그날부터 실 담당자에게 나간다.** 특히 `@samsung.com` 을 넣으면
   코어가 suffix 매칭하므로 전사가 한 번에 열린다(아래 절).

⚠️ 예외 하나: `mail_thread` #21(`codex/pop3-inbox-test-…`)은 담당자가 `shaneee.baek` 라
   화이트리스트를 **통과한다**. 현재 주차 큐엔 안 잡히지만 전체 주차로 돌리면 나간다.

⚠️ 스크립트에서 `SA_DELIVERY_AUTOSEND_SINKS=""` 로 덮어쓰고 있다면, **그게 유일한 차단인지
   `/proc/<pid>/environ` 으로 확인하라.** 그 override 를 "기본값" 으로 착각하기 쉽다.

## 수신처 모드 — `dssoc_only` 는 폐기됐다 (2026-08-24)

정책이 **"DSSOC 에게만 보내는 것은 드라이런 때뿐"** 으로 확정되면서 값 체계가 바뀌었다.
규칙 SSOT 는 `service/services/owner_recipients.py:delivery_targets`.

| 반환 `mode` | 뜻 |
|---|---|
| `normal` | 담당자 + Cc DSSOC — 정상 |
| `dry_run` | 자율발송 꺼짐 — 어차피 안 나가므로 DSSOC 로만 (구 `dssoc_only` 의 실제 뜻) |
| `no_owner` | 담당자 해석 실패로 DSSOC 로만 — **정책이 아니라 사고다** |

**자율발송 ON ∧ `normal` 아님 → `DeliveryPolicyError` 로 멈춘다.** 조용히 DSSOC 로만 보내면
담당자는 영영 못 듣고 화면엔 "통보 완료" 로 남기 때문이다. 그게 예전 **기본값**이었다.

⇒ **설정 파일에 4도메인 키를 전부 적어야 한다.** 키가 없으면 자율발송을 켜는 순간
   그 도메인의 배달이 멈춘다. `mail-send-safe.yaml` 은 자율발송을 켜는 파일이라 특히 그렇다.

## 게이트는 2축이다 — 둘 다 닫아라

| 축 | 변수 | 하는 일 |
|---|---|---|
| ① 수신자 정책 | `<도메인>_REMEDIATION_MAIL_MODE` | `normal`= To=owner/Cc=DSSOC. **4도메인 전부 필요** — 없으면 자율발송 시 예외(위 절) |
| ② egress 게이트 | `SA_DELIVERY_*` | sink opt-in + charter(설정 시) + **RECIPIENT_ALLOW 전원매칭** + redact scan, 전부 fail-closed |

한 축만 닫아도 "지금은" 안전할 수 있지만, **다른 축이 열려 있으면 그 축을 건드리는 순간
사고가 난다.** 실제로 2026-08-15 이전 상태가 그랬다(아래).

## ⚠️⚠️ `@도메인` 항목은 그 도메인 **전체**를 연다

코어 `_recipient_allowed`(`secu-agent/src/secu_agent/agent/delivery.py:140`)는
`lstrip("@")` 후 **도메인 suffix 매칭**을 한다.

```python
e = entry.lower().lstrip("@")            # "@samsung.com" → "samsung.com"
if domain == e or domain.endswith("." + e):
    return True                          # samsung.com 주소 전부 통과
```

⇒ **실 담당자 발송 금지 단계에서는 정확한 주소만 적는다. `@도메인` 금지.**

⚠️ 좁힐 때 **SOC 주소를 명시적으로 넣어라.** 2026-08-15 이전 값에는 `dssoc@samsung.com` 이
아예 없었고 `@samsung.com` 에 얹혀 통과하고 있었다 — 도메인 항목만 지우면 정상 발송까지 막힌다.

## 설정 위치 3곳 (전부 이 문서와 일치해야 함)

| 위치 | 적용 대상 | 값 |
|---|---|---|
| `secu-agent-skill/.env` | **로컬 실행**(드라이버·스크래치패드) | allow=2주소 · **autosend=`knox_mail`(켜져 있음)** · mode=4도메인 `normal` |
| `secu-agent-skill/deploy/k8s/base/runtime-configmap.yaml` | k8s 기본 | autosend=`""`·allow=`""`(fail-closed) · mode=4도메인 `normal` |
| `digisecu-employee/deploy/engine/mail-send-safe.yaml` | k8s **실발송 활성화** ConfigMap | allow=2주소 · autosend=`knox_mail` · mode=4도메인 `normal` |

세 곳 모두 **4도메인 키를 전부** 갖는다(2026-08-24 정리). 예전엔 SMB 하나뿐이었고, 그 상태로
`mail-send-safe.yaml` 을 적용하면 나머지 셋이 예외로 멈췄다.

⚠️ `secu-agent/.env`(엔진)에는 이 변수들이 **없다**. 엔진은 무수정 대상이고,
값은 스킬/배포 쪽에서만 준다.

### 해소된 불일치 (2026-08-24)

예전엔 `mail-send-safe.yaml` 만 `SMB_REMEDIATION_MAIL_MODE: normal` 이고 나머지가
`dssoc_only` 라 축①/축②가 어긋나 있었다. 정책 확정으로 **세 곳 모두 4도메인 `normal`** 이 됐다.
축② (`SA_DELIVERY_*`)가 실제 차단을 맡고, 축①은 "누구에게 보낼 메일인가" 만 정한다.

## 왜 설정파일을 하나로 못 합치나 (2026-08-15 조사)

> 아래 조사는 **`docs/CONFIG-OWNERSHIP.md` 로 확장·정리됐다**(같은 날 오후, 중복 7 → 0).
> 키 소유권의 최신 기준은 그 문서다. 이 절은 메일 관련 부분의 배경 기록으로 남긴다.

파일 **개수**는 구조상 줄일 수 없다 — `secu-agent/.env`(엔진 소유·무수정),
`skill/.env`(로컬 실비밀·gitignore), k8s ConfigMap(파일이 아니라 클러스터 오브젝트),
`.env.example`(문서용)은 각각 역할이 다르다.

**진짜 문제는 개수가 아니라 "같은 키가 여러 곳에 있는 것"이었다.** `load_runtime_env` 는
**skill/.env → engine/.env** 순으로 읽고 `if key not in os.environ` 이라 **먼저 잡힌 값이
이긴다** — 양쪽에 있으면 엔진 값은 조용히 죽는다.

조사 결과 엔진 `.env` 의 중복분 상당수가 **死값**이었다(엔진 코드 참조 0곳):

| 키 | 엔진 코드 참조 | 조치 |
|---|---|---|
| `SMB_USERNAME` | 0곳 | **엔진 .env 에서 제거함** (2026-08-15) |
| `SMB_PASSWORD` | 1곳(`secret_redact` 마스킹 **이름**만, 접속에 안 씀) | **제거함** |
| `GITHUB_TOKEN` · `SMB_MAX_*` | 0곳 | 값 동일이라 방치(제거해도 무방) |
| `SECU_AGENT_PG_DSN` · `SA_PLUGINS` | 실제 사용 | 양쪽 필요 — 값 일치 유지 |

⚠️ SMB 크리덴셜이 갈려 있던 게 왜 위험했나: `skill/.env` 가 없거나 이름이 바뀌면
`load_runtime_env` 가 엔진 값으로 폴백해 **스킬 코드가 다른 계정으로 SMB 접속**을 시도한다.
비밀번호가 안 맞으면 **AD lockout**. 지금은 `dssoc` 단일 소스다.

재발 방지는 `service/tests/test_env_hygiene.py` 가 맡는다(값은 출력하지 않고 키만 비교).

## `dry_run` 은 설정 스위치가 아니다

코드의 `dry_run`(`service/agents/reply_verify_agent.py:175`)은 **발송 도구 응답에서 사후
감지하는 모드**다. "지금 dry_run 이라 안전하다"는 성립하지 않는다. 안전은 위 2축이 만든다.

## 로컬 실행 시 실제로 막고 있는 것

`scratchpad/run_worker.sh` 가 매 실행마다 `SA_DELIVERY_AUTOSEND_SINKS=""` 를 강제하고,
TASK 드라이버는 `deliver` 를 호출하지 않는다(구조적 무발송). **이 둘은 방어심층이지
정책이 아니다** — 러너 없이 report/mail 스테이지를 직접 돌리면 위 2축만 남는다.

⚠️ 2026-08-24: 이 override 를 **기본값으로 착각한 사고**가 있었다. `.env` 에는 이미
`knox_mail` 이 켜져 있는데, 손으로 돌릴 때마다 `SINKS=""` 를 붙여 왔더니 "지금은 드라이런"
이라고 믿게 됐다. 실제 차단은 `RECIPIENT_ALLOW` 였다. **확인 방법은 하나다** —
돌고 있는 프로세스의 `/proc/<pid>/environ` 을 직접 본다.

## 검증

```bash
PYTHONPATH=/home/shaneee.baek/project/secu-agent-skill \
SA_ENGINE_DIR=/home/shaneee.baek/project/secu-agent \
/home/shaneee.baek/project/secu-agent/.venv/bin/python - <<'PY'
from service.runtime_env import load_runtime_env; load_runtime_env(load_plugins=False)
from secu_agent.agent.delivery import _recipient_allowed, _env_csv, RECIPIENT_ALLOW_ENV
allow = _env_csv(RECIPIENT_ALLOW_ENV)
for a in ("dssoc@samsung.com", "shaneee.baek@samsung.com", "someone.else@samsung.com"):
    print(a, _recipient_allowed(a, allow))     # True, True, False 여야 한다
PY
```

실발송 이력 확인: `mail_message` 의 `direction='out'` 을 `mail_to` 로 집계.
(2026-08-15 기준 269건 = dssoc 255 · shaneee 14 · 실 담당자 **0**)

관련: `docs/LESSONS-LEARNED.md` 3-5

---

## 2026-08-24 변경 — 다른 세션이 알아야 할 것

a2a 로 알리려 했으나 승인 전에 만료돼 여기 남긴다. 커밋: `e6bdf7b` `a357ddc` 및 후속.

### 수신처 정책 (사용자 확정)

**To = 담당자, Cc = DSSOC.** DSSOC 단독은 **드라이런 때뿐**이다.
`dssoc_only` 모드는 폐기됐다 — 자율발송이 켜졌는데 mode≠normal 이면 `DeliveryPolicyError`
로 멈춘다. 실발송 중 DSSOC 에만 보내면 담당자는 통보를 못 받는데 화면엔 통보 완료로 남는다.

`<도메인>_REMEDIATION_MAIL_MODE` 를 **4도메인 전부** 적어야 한다. 키가 없는 도메인은
배달이 멈춘다(설계 의도). 예전엔 SMB 하나뿐이라 이 ConfigMap 을 적용하면 나머지 셋이
조용히 죽었다.

### DSSOC 폴백 제거

`remediation_mail` 의 `if not recipients: recipients = list(dssoc)` 를 지웠다.
**담당자를 모르는 상태를 발송 성공으로 만들던 자리**다. 이제 비면 빈 채로 돌려주고
엔진 `apply_egress_gate` 가 "TO 수신자가 없습니다" 로 막는다 → **발송 실패로 남는다.**

⚠️ 회신 경로 4곳(confluence 리포터·github 스캐너·dev_web 회신·안내 에이전트)이
`reply_targets` 하나를 공유한다. **Cc 에 DSSOC 가 붙는다** — `payload.cc` 나
`outbound["mail_cc"]` 를 단언하는 테스트가 있으면 값이 달라진다.

### ★ 스레드는 수신처를 모르는 채로 태어난다

`dev_web_submit_finding_tool._default_recipient()` 와
`smb_submit_finding_tool._build_phase_recipient()` 를 걷어냈다. 후자는 docstring 이 스스로
*"Development default: queue report-mail threads to DSSOC, not owners"* 라고 적혀 있었다 —
**개발 기본값이 운영까지 살아남았다.**

실측(2026-08-24):

| 테이블 | 전체 | recipient=dssoc | NULL | 실제 발송(awaiting_reply) |
|---|---|---|---|---|
| `dev_web_report_thread` | 137 | **137** | 0 | **0** |
| `mail_thread` | 510 | **510** | 0 | 241 |
| `github_report_thread` | 991 | 20 | 176 | — (434종, 건강) |

dev_web 은 **한 건도 안 보냈는데** 전부 "DSSOC 로 보냄" 으로 기록돼 있었다.

파급:
- 게이트웨이 `deliveryTarget` 이 안 보낸 스레드까지 "DSSOC" 로 그린다.
- `dev_web/webapp/routes/targets.py:112` 의 `has_request_mail` 은
  `request_message_id or recipient` 인데 발송 경로가 `request_message_id` 를 명시적으로
  None 으로 둔다. recipient 가 유일한 근거인데 그게 상수였으니 **항상 True** 였다.

⚠️ **과거 행은 소급 복원이 불가능하다**(실제 수신자 기록이 없다). SMB 의 발송된 241행은
DSSOC 가 **참**이다(그때는 `dssoc_only` 모드였다) — 지우지 말 것.
새로 만들어지는 스레드부터 NULL 이고, 발송 후 실제 수신자가 적힌다.

### dev_web 기록이 수신자를 지어내고 있었다

`dev_web_report_agent._report_fields` 가 `subject` 는 실제 deliver 호출에서 읽으면서
`recipient` 만 DSSOC env 에서 읽었다. 기존 테스트가 그 조작을 단언하고 있었다 —
가짜 호출은 `owner@` 에 보내는데 통과 조건이 `dssoc@` 였다.
이제 `payload["recipients"]` 를 그대로 적는다. 되먹임 차단으로, 저장된 recipient 가
`is_dssoc()` 면 담당자로 읽지 않는다.

### 담당자 판정이 env 를 따라간다

`is_internal` 이 `NON_OWNER_LOCALPARTS = ("dssoc",)` **리터럴만** 보고 있었다.
팀함 주소를 env 로 바꾸면 그 주소가 담당자로 통과하고, `delivery_targets` 가
mode="normal" 로 To=팀함·Cc=팀함 을 돌려준다. 이제 `is_dssoc()` 를 함께 본다
(리터럴은 백스톱으로 유지).

같은 드리프트를 하루에 셋 고쳤다 — `state_domain._service_owner_recipient_hint`,
게이트웨이 `domains.is_dssoc`(사본 2벌), 그리고 여기.

### 안 건드린 것

**4도메인 메일 본문** — 사용자 지시로 보류. `scanner.py:1709` 의
`_report_html(recipient=owner_recipient or recipient)` 은 본문이라 그대로 뒀다.
담당자가 DSSOC 로 풀리면 메일 본문에 "담당자: dssoc@…" 가 찍힐 수 있다.
