# LLM 백엔드 — 어디를 보고 있나

워커·에이전트가 실제로 호출하는 LLM 이 어디서 오는지, 그리고 **그 구성이 이 저장소에 없는 이유**를 적어둔다.
장애 났을 때 "왜 워커가 다 멈췄지" 를 여기서 시작할 수 있게 하는 게 목적이다.

## 호출 경로

```
워커/에이전트
  └→ 사내 LiteLLM 게이트웨이  https://gateway.security.samsungds.net/v1
       ├─ internal-gemma4                 ← 사내. vision 가능(이미지 근거 워커의 대체 슬롯)
       ├─ external-claude-* · external-gpt-*   ← **쓰지 않는다**
       └─ private-deepseek-v4-seunghanee  ← DGX Spark 2노드 사설 배포. 현 워커 기본
```

리드만 게이트웨이를 안 거친다 — `codex` 프로파일은 `chatgpt.com/backend-api/codex` 로
OAuth 직결한다(MWG 프록시 경유).

프로파일 정의는 엔진 `config/llm_profiles.yaml`(코어 소유, 이 저장소 밖). 인증키는 `LITELLM_API_KEY`.
**검토원(워커)은 게이트웨이 경유로만 호출한다** — Spark 백엔드 직결도 되지만 키 관리·관측성
때문에 쓰지 않는다. `internal-gausso3.2`·`internal-gausso4.1`·`internal-gpt-oss` 는 2026-08-20
은퇴했다(프로필 정의 삭제 — 이름만 남겨두면 조용히 버려진다).

## 역할마다 다른 모델을 쓴다

축이 셋이다. `SA_CHAT_PROFILE` 하나로는 표현이 안 된다.

| 역할 | env | 2026-08-22 현재 | 왜 |
|---|---|---|---|
| 검토원/워커 (읽기) | `SA_CHAT_PROFILE` + `_CHAIN` | `deepseek,gemma` | 파일 본문·크리덴셜 값을 본다 → **사내/사설만** |
| 리드 (판단) | `SA_LEAD_PROFILE` + `_CHAIN` | `codex` | 좌표(IP·경로·repo·크기)만 본다. 본문은 구조적으로 못 받는다 |
| vision 대체 | env 없음(코드 기본) | `gemma` | deepseek 은 이미지를 400 으로 거부 → 이미지가 근거인 워커만 자동 대체 |

리드가 사외(chatgpt.com)로 나가는 게 안전한 이유는 프롬프트가 아니라 **세 겹**이다 —
①리드 도구셋에 본문 반환 도구가 없다 ②봉투 필드 집합이 닫혀 있다 ③값은 마스킹된다.
셋 다 `docs/probes/egress_audit.py` 가 실제 요청 바이트로 검사한다.

### 바꾸는 법

`secu-agent/.env` 한 곳만 고친다. 프리셋 전문은 같은 저장소 `.env.example` 의
"역할별 LLM 프로파일" 블록에 있다 — 쓸 블록 하나만 주석 해제하면 된다.

| 프리셋 | 워커 | 리드 | 쓸 때 |
|---|---|---|---|
| **[A]** | `deepseek,gemma` | `codex` | 기본 |
| **[B]** | `gemma` | `gemma` | codex OAuth 가 죽었거나 **사외 egress 를 0 으로** |
| **[C]** | `deepseek,gemma` | `deepseek` (체인 없음) | **리드 모델 A/B**. 사외 egress 0 |
| **[D]** | 그대로 | `""` | 역할 분리를 끈다(전역 하나로, Phase 3 이전 동작) |

주의 셋:

- `SA_LEAD_PROFILE` 이 설정되면 리드는 **전역 체인을 물려받지 않는다**(폴백 없음).
  폴백을 원하면 `SA_LEAD_PROFILE_CHAIN` 을 명시한다. 의도적이다 — codex 로 시작해
  gemma 로 조용히 넘어가면 어느 모델이 판단했는지 로그로 구분되지 않는다.
  **[C] 로 A/B 를 돌 때는 그 체인을 절대 설정하지 않는다** — 폴백이 뛰는 순간 측정이
  무의미해진다. 검토원 체인은 그대로 둔다(A/B 대상이 아니고, 간헐 500 방어가 더 중요).
- 모델을 리드로 쓸 수 있는지는 `secu-agent-skill/docs/probes/lead_profile_probe.py` 로
  확인한다 — 폴백 부재·실제 서빙 프로파일·**도구 호출 여부**를 본다. 리드는 산문이
  아니라 도구로 일하므로 텍스트만 내는 모델은 배선이 돼도 못 쓴다.
  2026-08-22 실측: codex·deepseek 둘 다 PASS.
- **없는 프로파일 이름은 조용히 버려진다.** 안 깨지고 사내 기본으로 fail-safe 하므로
  오타가 티나지 않는다. 바꾼 뒤 `cli doctor` 로 확인할 것.
- 프로파일을 새로 추가하면 `config/llm_profiles.yaml.example` **에도** 넣어야 한다.
  실물 yaml 은 gitignore 라 커밋에 안 남는다 — 재설치하면 example 에 있는 것만 복원된다
  (`tests/test_llm_profile_presets.py` 가 이 갈라짐을 잡는다).

## DGX Spark 사설 배포 (`private-deepseek-v4-seunghanee`)

DGX Spark(GB10) 2대를 QSFP 로 직결하고 Ray 로 묶어 vLLM 이 `deepseek-v4-flash` 를 TP=2 로 서빙한다.

- 구성·운영 문서 **정본**: [`AI-for-Security/private-llm-hands-on`](https://github.samsungds.net/AI-for-Security/private-llm-hands-on)
  → `serve-two-sparks/` (기동 가이드) · `serve-two-sparks/OPERATIONS.md` (운영 편)
- 노드에도 사본이 있다: 각 노드 `~/spark-vllm-deploy/`
- **이 저장소에는 두지 않는다.** 서빙 인프라는 digisecu 와 독립적이고, 다른 팀도 같은 가이드를 쓴다.

### 워커 관점에서 알아둘 것

| | |
|---|---|
| tool calling | 정식 지원(`--tool-call-parser deepseek_v4`). 필수필드 충족·교정 지시 순응 확인됨 |
| 컨텍스트 | 1,048,576 |
| vision | **미지원** — 이미지 증거가 필요한 도메인은 다른 프로파일을 쓸 것 |
| 동시성 | `--max-num-seqs 16`. 팬아웃 병렬도를 그 아래로 잡는다 |
| 응답 특성 | tool_calls 가 있을 때 `content` 가 `None` 으로 온다(정상). `reasoning_content` 는 안 보낸다 |

### 장애 시 첫 확인

```bash
curl -s --noproxy '*' https://gateway.security.samsungds.net/v1/models   # 게이트웨이가 죽었나
ssh spark2 'sudo systemctl status spark-vllm-head'                       # 서빙 유닛
ssh spark2 'sudo docker exec vllm nvidia-smi -L'                         # GPU 접근 (★ apt/daemon-reload 직후 필수)
```

세 번째가 핵심이다 — `apt` 나 `systemctl daemon-reload` 가 컨테이너의 GPU 디바이스 권한을 지우면
**서빙은 한동안 멀쩡하다가 나중에 죽는다.** 2026-07-24 에 이것 때문에 26일간 백엔드가 죽어 있었다.
자세한 사슬은 위 `OPERATIONS.md` §1.

## 이미지 쪽 주의

워커 이미지에는 `.env` 가 들어가지 않는다(`deploy/engine/build.sh`). 자격증명은 실행 시 주입한다 —
`deploy/engine/run-worker.sh` 가 정문이고, 손으로 `docker run` 하면 32키가 조용히 사라진다.
