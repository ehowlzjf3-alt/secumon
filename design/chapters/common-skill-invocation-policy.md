# Codex 공통 스킬의 자동 호출 제한

2026-09-06 · 개발 도구 설정 변경 · Secumon 제품 스킬 기능과 별개

사용자는 공통 스킬이 꼭 필요한 순간이 아니라면 사용하지 않아도 되며 끌 수 있는지 질문했다. 자동 호출을 끄고 명시 호출은 유지하는 설정을 적용했다. 스킬 자체나 플러그인을 삭제하지 않았으며 전체 스킬을 일괄 비활성화한 것도 아니다.

## 확인한 기존 상태

- 사용자 전역 AGENTS.md가 일반 계획·아키텍처 검토·구현 검증에서 특정 공통 스킬을 사용하도록 지시했다.
- clean-architecture, feature-implementer, verify-implementation의 agents/openai.yaml에는 자동 호출 제한이 없었다.
- merge-worktree와 push-worktree는 이미 allow_implicit_invocation: false였다.
- 스킬별 실제 토큰 소비량을 측정하지 않았으므로 전체 사용량 증가를 스킬 하나의 원인으로 확정하지 않는다.

## 적용한 변경

세 공통 스킬의 agents/openai.yaml에 policy.allow_implicit_invocation: false를 추가했다. 사용자 전역 AGENTS.md에서는 특정 스킬을 반드시 사용하는 문장을 제거하고, 공통 워크플로 스킬 다섯 개는 명시 호출용으로 남겼다. 계획·기존 구조 존중·필요한 시험/타입 검사는 계속 수행한다. 전문 도구 사용에 꼭 필요한 다른 스킬과 상위 도구 지침은 별도로 따른다.

- [전역 작업 지침](/Users/seunghanee/.codex/AGENTS.md)
- [계획 스킬 호출 설정](/Users/seunghanee/.agents/skills/feature-implementer/agents/openai.yaml)
- [아키텍처 스킬 호출 설정](/Users/seunghanee/.agents/skills/clean-architecture/agents/openai.yaml)
- [검증 스킬 호출 설정](/Users/seunghanee/.agents/skills/verify-implementation/agents/openai.yaml)

공식 문서상 allow_implicit_invocation: false는 암시적 호출을 막고 명시적인 $스킬이름 호출은 유지한다. 완전히 비활성화하려면 config.toml의 skills.config에서 해당 SKILL.md 경로에 enabled = false를 사용할 수 있지만 이번에는 적용하지 않았다. [OpenAI 스킬 설정 문서](https://learn.chatgpt.com/ko-KR/docs/build-skills).

## 반영 범위와 복원

이 설정은 이 Mac의 사용자 공통 스킬과 전역 지침에 적용된다. 프로젝트별 별도 지침이나 플러그인/시스템 스킬 전체를 수정하지 않았다. 현재 대화에 이미 주입된 내용이 소급해 제거되지는 않는다. 파일 변경과 구문은 확인하고, 이미 실행 중인 앱의 모든 작업이 새 설정을 읽었다고 주장하지 않는다. 다음 작업에서 확인하고 변경이 보이지 않으면 Codex를 다시 시작한다.

원본 네 파일과 해시는 [백업 명세](/Users/seunghanee/.codex/backups/2026-09-06T13-14-56-966Z-common-skill-policy/manifest.json)에 보존했다. 되돌릴 때는 현재 파일의 추가 변경 여부를 비교한 뒤 대응하는 원본을 복원한다. 토큰 절감량이나 앱 재로딩 결과를 이번 파일 검사만으로 측정했다고 표시하지 않는다.
