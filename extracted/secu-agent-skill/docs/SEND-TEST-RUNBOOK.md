# 실발송 운영 기록 — 세 경로, 세 정책

> 사용자 결정 2026-08-31. **SMB 부터 도메인별 순차 테스트**를 하고, 나머지 3도메인도
> 같은 절차를 쓴다.

```
수동 발송   → 실제 담당자에게    (사람이 승인했다)
회신·재검증 → 모두에게 열림
최초 발송   → 닫혀 있다
```

⚠️ 메일은 회수 경로가 없다. 이 문서는 **끄는 법**을 같이 적는다.

---

## 1. 왜 허용목록으로는 통제할 수 없나

수동 발송이 실제 담당자에게 나가려면 `SA_DELIVERY_RECIPIENT_ALLOW` 를 열어야 한다.
그 순간 최초 대량 발송을 막는 건 **컴포넌트 플래그 하나뿐**이 된다 — 누가 켜면 그만이고
그러면 큐가 통째로 실존 임직원에게 나간다.

2026-08-31 실측 대기 큐:

| 도메인 | 담당자가 붙은 발송 대기 |
|---|---|
| smb | 48 |
| github | 552 |
| confluence | 44 |
| dev_web | 71 |

그래서 통제를 **허용목록에서 "발송 종류"로** 옮겼다.

## 2. 게이트 구조

경로가 두 갈래로 갈린다 — 이게 이 설계의 전부다.

```
최초 발송   owner_recipients.delivery_targets()   ← 게이트 여기
              4도메인 래퍼가 전부 이걸 지난다
              자동이면 SA_INITIAL_REPORT_AUTOSEND 없이는 담당자에게 안 간다
              수동이면 manual=True → 통과

회신·재검증 remediation_mail.reply_targets()      ← 게이트 없음
              받은 메일의 상대에게 답한다. 항상 열려 있다.
```

| 값 | 뜻 |
|---|---|
| `mode="initial_closed"` | 자동 최초 발송이 닫혀 담당자에게 안 보냈다(DSSOC 만) |
| `mode="normal"` | 담당자(To) + DSSOC(Cc) |
| `mode="no_owner"` | 담당자를 못 찾았다 — **정책이 아니라 사고다** |
| `mode="dry_run"` | 자율발송 꺼짐 |

⚠️ 기본이 **닫힘**이다. 애매한 값(`0`·`false`·빈 문자열)도 닫힘으로 읽는다 —
   열림 쪽으로 해석하면 사고가 조용히 난다. `service/tests/test_initial_send_gate.py`
   가 이 전부를 고정한다.

## 3. 스위치

```bash
# .env — 발송 자체를 여는 스위치 (수동·회신 공통)
SA_DELIVERY_AUTOSEND_SINKS=knox_mail
SA_DELIVERY_RECIPIENT_ALLOW=<전체 주소 나열>     # ⚠️ 접미(@samsung.com)는 전사 개방이다

# 자동 최초 발송을 열 때만 (기본 미설정 = 닫힘)
SA_INITIAL_REPORT_AUTOSEND=1
```

`control_flag` (누가 시도하는가):

| 컴포넌트 | 무엇 | 테스트 중 |
|---|---|---|
| `mail` | smb 최초 발송 러너 | OFF |
| `github.report` / `confluence.report` / `dev_web_report` | 각 도메인 최초 발송 | OFF |
| `reply_verify` / `reverify` | smb 답장·재검증 | ON |
| `github.recheck` / `confluence.recheck` / `dev_web_reverify` | 각 도메인 재검증 | 해당 차례에 ON |

★ 방어가 두 겹이다 — **코드 게이트**(무엇이 나갈 수 있는가)와 **컴포넌트 플래그**
  (누가 시도하는가). 하나만 믿지 마라. 플래그만 있던 시절이 위험했던 이유가 1번이다.

## 4. 수동 발송 경로

```
콘솔 버튼 → /api/mail-sends (승인 생성) → 승인 → control-plane 이 CLI 를 execFile
          → CLI 가 load_runtime_env() 로 .env 를 **스스로** 읽음 → deliver()
```

- **컴포넌트 플래그와 무관하다.** `mail` 이 OFF 여도 수동 발송은 나간다.
- `console_send` 가 `manual=True` 를 넘겨 최초 발송 게이트를 통과한다.
- egress 게이트(허용목록·PII 스캔)는 **그대로 지난다** — 우회 경로가 아니다.

## 5. 순차 테스트 절차 (도메인마다)

```
① 그 도메인 최초 발송 컴포넌트 OFF 확인
② 회신 컴포넌트 ON
③ 콘솔에서 티켓을 골라 수동 발송 — 몇 건만
④ mail_message(direction='out', agent_verdict='sent') 로 실제 발송 확인
⑤ 담당자 답장 → 회신 에이전트가 처리하는지 관찰
⑥ 다음 도메인
```

## 5-1. 큐를 돌리는 것 — 러너 한 벌 (2026-08-31)

메일 큐(조치요청·재검증)는 **4도메인 공용 러너 하나**가 돈다.

    service/agents/thread_pipeline_runner.py --poll-sec 60

    도메인      조치요청          재검증
    smb         mail              reverify
    github      github.report     github.recheck
    confluence  confluence.report confluence.recheck
    dev_web     dev_web_report    dev_web_reverify

옛 경로(각 도메인 러너의 report·recheck 스텝, `scripts/dev_web_loop.sh` 의 메일 블록)는
**폐기했다**. 도메인 러너에는 그 도메인에만 있는 일(발견·스캔·담당자·space/sso)만 남았고,
`scripts/dev_web_loop.sh` 는 발견 전용이다. 둘을 같이 켜면 같은 스레드를 둘이 잡는다.

⚠️ 러너를 켠다고 메일이 나가지 않는다. 발송 여부는 §2 게이트가 정한다.

### 순서가 밀린다

한 프로세스가 도메인을 차례로 돈다. dev_web 한 패스가 길면(스레드당 최대 30분 ×
한 번에 5건) smb 차례가 그만큼 밀린다. 특정 도메인을 급히 돌려야 하면 그 레인만
따로 띄운다 — 같은 코드다.

    python -m service.agents.thread_pipeline_runner --only smb --poll-sec 60

### 로그로 확인한다

    [thread-runner] mail handled=3 errors=0 status=reported

`handled` 이 계속 0 이면 큐에 claim 할 게 없다는 뜻이다. smb 는 `draft` 가 아니라
`reported` 를 잡는다 — 초안이 큐로 **승격**돼야 보인다(§5-2).

## 5-2. smb 초안이 큐에 안 올라올 때

smb 만 단계가 하나 더 있다: `draft` → (host 의 점검이 다 끝나면) → `reported`.

    python -c "from service.runtime_env import load_runtime_env; load_runtime_env(); \
      from service.services.smb_draft_report import promote_ready_host_drafts; \
      print(promote_ready_host_drafts())"

러너가 매 패스 이걸 부르므로 보통은 손댈 일이 없다. 결과의 `waiting` 은 아직 훑는
중인 host 다(정상). 옛 주기 초안은 **일부러** 안 올린다 — 지난주 스캔을 오늘 사실처럼
보내지 않기 위해서다.

## 6. 끄는 법 (사고 시)

```bash
SA_DELIVERY_AUTOSEND_SINKS=      # 비우면 어떤 경로로도 안 나간다 (수동 포함)
```

⚠️ 러너들은 **기동 시점의 env** 를 들고 있다. `.env` 만 고치면 이미 떠 있는
   프로세스에는 반영되지 않는다 — **러너를 재기동해야 한다.**
