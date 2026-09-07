# CORE-ASK: `gemma` 프로파일 추가 + 워커 기본 프로파일 재검토

> digisecu 세션 발신 (2026-08-15). **요청은 두 개고, 첫 번째만으로도 충분히 가치가 있습니다.**
>
> 1. `config/llm_profiles.yaml` 에 **`gemma` 프로파일 추가** (게이트웨이에 이미 서빙 중, 설정만 없음)
> 2. `.env` 의 워커 기본 프로파일 `SA_CHAT_PROFILE=gauss-o32` **재검토**
>
> 2번은 `.env:83-85` 주석이 근거로 든 벤치 결과가 **재측정에서 뒤집혀서** 드리는 요청입니다.

---

## 1. 요청 — `gemma` 프로파일 추가

게이트웨이(`/v1/models`)가 이미 `internal-gemma4` 를 서빙합니다. 같은 엔드포인트·같은 인증이라
**설정 한 블록**이면 됩니다. `config/llm_profiles.yaml` 의 `gauss-o41` 다음에:

```yaml
  # 사내 security 게이트웨이 Gemma4. gauss-o32/o41 과 동일 엔드포인트·인증.
  # v3.95 재측정에서 github 워커 완주 8/8·후보정산 73%·평균 144s 로 3종 중 1위.
  gemma:
    base_url: https://gateway.security.samsungds.net/v1
    model: openai/Gemma4-260430
    auth:
      mode: api_key
      api_key: ${LITELLM_API_KEY}
    proxy: null
    verify_ssl: false
    timeout: 300
    trust_env: false
    reasoning_effort: medium
```

지금은 이 프로파일이 엔진 설정에 없어서, 쓰려면 스킬이 `SA_CHAT_PROFILES_PATH` 로 **전체 사본**을
따로 들고 있어야 합니다(드리프트 위험). 엔진 설정 단일소스 원칙상 여기 있는 게 맞다고 봅니다.

---

## 2. 요청 — 워커 기본 프로파일 재검토

`.env:83-85` 현재 주석:

> `# GaussO3.2 벤치: 빈-content 0/3·평균 더 빠름·판단품질 8/8. O4.1 은 예산소진 빈-content 2/3`

**재측정 결과가 이 결론을 정반대로 뒤집었습니다.** 아래가 근거입니다.

### 2-a. 빈-content 재측정 — o32 가 5/6, o41 이 0/6

같은 자극(도구 2개를 든 채 "후보 40건 중 다음 행동을 도구로 호출하라"), `max_tokens=4096`, 각 6회.
스트림 이벤트를 분류해 **text/tool 델타가 하나도 없고 reasoning 델타만 나온 콜**을 셌습니다.

| 모델 | 정상 | **빈-content(추론만)** | 도구 호출 |
|---|---|---|---|
| `internal-gausso3.2` | 1/6 | **5/6** | 1/6 |
| `internal-gemma4` | 6/6 | 0 | 6/6 |
| `internal-gausso4.1` | 6/6 | 0 | 6/6 |
| `internal-gpt-oss` | 6/6 | 0 | 6/6 |

빈-content 콜의 reasoning 델타는 **2,025~2,080개**, 정상 콜은 110~337개였습니다.
gauss-o32 는 살아남은 경우조차 **6번 중 1번만 도구를 호출**하고 나머지는 텍스트로 답합니다.

### 2-b. 설정으로는 못 고칩니다 (둘 다 실측 기각)

- **`max_tokens` 상향**: 4,096 → 16,384 로 4배 늘렸더니 reasoning 델타도 2,070 → 8,200 으로
  **정확히 4배**. 빈-content 5/8 → 4/8 로 거의 그대로. 주는 만큼 다 씁니다.
- **`reasoning_effort` 인하**: medium / low / minimal 에서 폭주 4/6 · 5/6 · 4/6 — **무관**했습니다.

즉 예산 부족이나 강도 과다가 아니라 **모델 고유의 추론 폭주**로 보입니다.

### 2-c. 이게 워커를 실제로 죽입니다

빈-content 턴은 엔진 입장에서 "텍스트-only 턴"이라 계약 리마인더 캐스케이드로 들어갑니다.
`max_candidate_ledger_reminders = 2` / `max_terminal_tool_reminders = 2`(engine.py:218,221)이므로
**빈 턴 3회 누적이면 `contract_violation` 으로 태스크가 죽습니다.**

라이브 확인 — github 워커 8런의 턴 분류:

| 런 | 총 턴 | **빈 턴** | 텍스트-only 턴 | 결과 |
|---|---|---|---|---|
| A | 5 | **3** | 0 | `contract_violation` |
| B | 5 | **3** | 0 | `contract_violation` |
| 나머지 6런 | 17~36 | 0~1 | 0~1 | 정상 |

⚠️ 참고로 **계약이 전제하는 "종료 도구를 산문으로 서술" 케이스는 8런 통틀어 1회뿐**이었습니다.
계약 자체는 정확히 작동하지만, 실제로 잡히는 사건은 "모델이 아무것도 못 냄"입니다.
(계약 메시지의 원인 귀속이 실제와 다르다는 관찰일 뿐, **동작 변경 요청은 아닙니다** —
가드는 유효하고 저희도 유지가 맞다고 봅니다.)

### 2-d. github 도메인 3파전 — gemma 가 전 축 1위

같은 타깃 8개 × 3모델 = 24셀. 셀마다 타깃을 `pending`·`cycle_scanned_at=NULL` 로 되돌려
**셋이 같은 repo** 를 보게 했고, 모델 순서는 타깃마다 회전시켰습니다.

| 모델 | 정상 완주 | halt | abort | 후보 정산 | **정산율** | 평균 초 |
|---|---|---|---|---|---|---|
| **gemma** | **8/8** | 0 | 0 | 43/59 | **73%** | **144** |
| gpt-oss | 6/8 | 2 | 0 | 31/69 | 45% | 236 |
| gauss-o41 | 6/8 | 0 | 2 | 14/49 | 29% | 388 |

정산율 = 워커가 관측한 후보 중 실제로 제출/기각 처리한 비율(침묵 게이트 지표).

**한계 명시**: 이 8개 타깃은 전부 클린이라 **findings 가 0** 이었습니다. 따라서 비교된 것은
**완주·처리 성실도**이고, "진짜 유출 탐지력"은 이 실험으로 비교하지 못했습니다.
gauss-o32 가 같은 날 실제 유출(Knox Messenger 운영계 토큰, finding #18869)을 찾아낸 것도 사실입니다.

### 제안

`SA_CHAT_PROFILE` 기본을 `gemma` 로, 체인을 `gemma,gauss-o41,gpt-oss` 로 두는 것을 제안드립니다.
다만 이건 **사장님 판단 영역**이고, 저희(스킬)는 1번(프로파일 추가)만 되면 워커별 기본값을
스킬에서 배선할 수 있습니다(dev_web/smb 에 이미 쓰는 `llm_profile=` 경로).

---

## 검증 방법

프로파일 추가 후:

```bash
export PYTHONPATH=/home/shaneee.baek/project/secu-agent-skill
export SA_ENGINE_DIR=/home/shaneee.baek/project/secu-agent
PY=/home/shaneee.baek/project/secu-agent/.venv/bin/python

# 1) 프로파일이 로드되는지
$PY -c "from secu_agent.agent.llm.profile import load_profiles; \
        print(list(load_profiles('$SA_ENGINE_DIR/config/llm_profiles.yaml')))"

# 2) 빈-content 재현 프로브 (scratchpad/model_probe.py, PROBE_MODELS 로 모델 지정)
```

재현 스크립트는 **이 저장소에 함께 커밋**했습니다 — `docs/probes/`
(`empty_probe.py` 이벤트 분류 · `model_probe.py` 모델별 폭주율, 사용법은 `docs/probes/README.md`).

```bash
PROBE_N=6 $PY docs/probes/model_probe.py     # 위 2-a 표 재현
```

3파전(2-d)은 digisecu 세션 scratchpad 의 A/B 하니스(`ab_experiment.py`/`ab_round3.py`)에
의존해서 여기 담지 않았습니다 — 필요하시면 그 세션에서 `gh3way.py`+`gh3way_score.py` 로 재실행합니다.

## 무엇을 요청하지 **않는지**

- 계약(`terminal_contract.py` · candidate ledger) 동작 변경 — 가드는 유효합니다.
- `repeat_error.py` 완화 — 그것도 제 역할을 하고 있습니다.
- 리마인더 예산(`max_*_reminders`) 상향 — 원인을 안 고치고 증상만 늦추는 것이라 반대합니다.
