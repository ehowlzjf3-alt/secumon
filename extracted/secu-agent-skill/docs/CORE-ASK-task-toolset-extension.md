# CORE-ASK — `register_task_toolset_extension` (operator 등 core-owned task_type 확장 seam)

> ## ⊘ WITHDRAWN — 불필요 판정 (core v3.88 — 2026-07-13)
>
> **결론**: `register_task_toolset_extension` 신규 seam 은 **불필요**하다. v3.88 클린 설계는
> core-owned `operator` 도구셋을 **변형하지 않고** 도메인 도구를 두 경로로 노출한다:
>
> 1. **`register_skill_unlock_tools(skill, tools)`** (`agent/skills/__init__.py:52`) — skill 선택 시
>    도구 언락. `smb_tasking` skill 이 `smb_subnet_sweep`·`smb_host_sweep`·`smb_owner_lookup`·
>    `smb_python` 를 언락(스킬 부트스트랩 `DEFAULT_UNLOCK_TOOLS_BY_SKILL` 배선 완료). operator 는
>    core-owned 그대로 두고, **skill 스코프**로 도메인 도구가 붙는다.
> 2. **`register_fanout_adapter`** — 배치 discovery 는 어댑터가 collector(`sweep_core.
>    run_smb_discovery_core`)를 직접 구동. 즉 `run_smb_discovery`·`subnets` **를 operator chat
>    도구로 노출할 필요 자체가 소멸**(어댑터가 그 일을 함).
>
> 원 요청의 "operator 레지스트리에 넣어야 한다"는 전제가 de-domain 이전(operator=순수 디스패처)
> 모델의 잔재였다. v3.88 에선 skill-unlock/fanout 이 정답. **codex 안전요건(중복 fail-closed·
> capability 게이트 보존)은 두 기존 seam 이 이미 충족**.
>
> **후속(드리프트 정리)**: 폐기 메커니즘을 단언하는 Group B 테스트 4종을 v3.88 메커니즘으로 재작성/제거:
> - `test_smb_owner_lookup_tool` → `smb_tasking` skill_unlock 멤버십 단언으로 재작성(도구 reachable).
> - `test_run_smb_discovery_tool`·`test_subnets_*` → operator/smb_agent_type 멤버십 단언 폐기(어댑터 구동).
> - `test_image_inspect_tool_smb` → `smb_inspect_image` reachability 를 v3.88 경로(smb_task 워커 도구셋)
>   로 확인·재작성. **감사 필요**: 이 도구가 어느 등록 도구셋에도 없으면 실(實) 배선 갭 — 별도 처리.
>
> _아래는 원(原) 요청 기록 — 이력 보존용._
> ---

> 대상: secu-agent 코어 세션. 스킬이 core-owned task_type(특히 `operator`)에 도메인 도구를
> **추가**할 수 있는 확장점 요청. codex 적대적 리뷰 반영.

## 갭

de-domain 후 스킬은 `register_task_toolset(task_type, provider)` 로 **자기 소유** task_type
(smb_share_master·smb_file_inspect 등)은 등록할 수 있다. 그러나 **core-owned task_type
(`operator`)에 도메인 도구를 추가**할 방법이 없다:

- `register_task_toolset` 은 **replace/중복거부**다: 같은 key 재등록 시 `ValueError`
  (`core .../agent/tools/__init__.py:112`). 게다가 코어 테스트가 `operator` override 를
  명시적으로 금지한다.
- public compose/get/append seam 이 없다. 스킬이 private `_operator_tools` 를 import 해
  unregister→re-register 하는 것은 순서의존적이고 아키텍처상 부정확(codex).

결과: operator 가 직접 쓰는 도메인 도구(`smb_inspect_image`, 그리고 smb_agent_type v3.24
deprecation 이후 operator 가 직접 처리하기로 한 `run_smb_discovery`/`subnets`/`smb_owner_lookup`)
를 operator 레지스트리에 넣을 방법이 없다 → 런타임 orphan.

## 요청: `register_task_toolset_extension(task_type, provider)`

코어가 base 도구셋 + 등록된 extension 들을 **병합**해 노출하는 확장 seam 제공.

```python
# core: agent/tools/__init__.py
_TASK_TOOLSET_EXTENSIONS: dict[str, list[Provider]] = {}

def register_task_toolset_extension(task_type: str, provider: Provider) -> None:
    """base(register_task_toolset)에 도구를 추가. base 없이도 가능. 이름 중복은 실패."""
    _TASK_TOOLSET_EXTENSIONS.setdefault(task_type, []).append(provider)

# build_registry_for_task 내부:
classes = list(base_provider() if base else _GENERIC_FALLBACK_TOOLS)
for ext in _TASK_TOOLSET_EXTENSIONS.get(task_type, ()):
    classes.extend(ext())
# 이름 충돌 시 fail-closed (조용한 shadow 금지 — codex)
```

### codex 안전 요건
- **이름 중복 fail-closed**: base 와 extension, 또는 extension 간 tool name 충돌 → 에러(조용한
  override/shadow 금지).
- **destructive/capability 보존**: extension 도구도 invoker permission·checkpoint 게이트를 그대로
  통과한다(registration 이 게이트 우회 아님). `smb_inspect_image` 는 non-destructive·
  non-read-only·capability-free — operator 노출 안전.
- operator 의 §6(마스킹 seal·egress allowlist·strict task context)은 tool 계층에서 강제 —
  extension 이 우회 불가.

## 스킬 측 (seam 착수 후)
- 부트스트랩에서 `register_task_toolset_extension("operator", operator_smb_tools)` 등록:
  `SmbInspectImageTool` + (smb_agent_type deprecation 반영) `RunSmbDiscoveryTool`/`SubnetsTool`/
  `SmbOwnerLookupTool`.
- 테스트 정합(seam 랜딩 후):
  - `test_image_inspect_registered_for_operator` → operator 에 smb_inspect_image 노출 확인.
  - `test_run_smb_discovery_registered_*`·`test_subnets_in_smb_agent_type_registry`·
    `test_smb_owner_lookup_registered_*` → **deprecated smb_agent_type 대신 operator** 멤버십으로
    재작성(smb_agent_type.md 는 v3.24 DEPRECATED).

## 착수 전 스킬 임시조치
위 4 테스트를 **xfail(reason=register_task_toolset_extension CORE-ASK + smb_agent_type deprecated)**
표기 → 스위트 그린 유지 + 갭 가시화.
