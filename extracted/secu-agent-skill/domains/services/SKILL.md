---
name: services
description: GitHub Enterprise, Jenkins, and Confluence tasking workflow.
domain: services
when_to_use: Operator request mentions GitHub, repo, Jenkins, CI job, Confluence, wiki, page, or collaboration-system tasking.
triggers: github, git hub, repo, repository, jenkins, ci, build job, confluence, wiki, space_key, page_id, 협업, 레포, 저장소, 젠킨스, 컨플루언스, 위키
---

> ⚠️ 이 파일은 **로드되는 skill 이 아니다**. `domains/` 는 skill 탐색 경로가 아니라
> (`_skill_search_dirs()` 는 `domains/<d>/skills` 만 본다) 여기 있는 SKILL.md 는
> `skill(action='view', ...)` 로 열 수 없다. 사람이 읽는 도메인 개요다.
> 워커가 실제로 여는 계약은 `skills/<name>/` 아래에 있다.


# service_tasking

사내 협업 시스템(GitHub Enterprise / Jenkins / Confluence)의 코드, CI, 문서에서
자격증명, PII, 내부 시스템 정보, 중요 업무정보 노출을 찾는 도메인 skill 이다.

> **per-service sub-skill** (재배치 시 분리): `github/SKILL.md`(name=github_tasking) ·
> `confluence/SKILL.md`(name=confluence_tasking) · `jenkins/SKILL.md`(name=jenkins_tasking, 신설).
> 공통 KEEP 하중은 `safety.md`. 이 본체는 공통 service 레이어(high-level scan 우선 →
> low-level deep-dive)를 소유하고, 서비스별 상세는 각 sub-skill 이 소유한다.

## 공통 원칙

- 보이는 도구만 사용한다. 없는 도구 이름을 만들지 않는다.
- raw credential 을 입력으로 받지 않는다. 필요한 credential 은 env-ref 또는 사전 구성된
  service account 를 사용한다.
- 먼저 high-level scan 도구를 사용한다. `github_task_scan`, `jenkins_task_scan`,
  `confluence_task_scan` 은 detector scan, sanitized evidence, domain report update,
  finding signal 생성을 한 번에 수행한다.
- low-level list/fetch 도구는 high-level scan 이후 특정 repo/job/page를 deep dive 할 때만
  사용한다.
- detector 결과는 후보 신호다. 예시/template 값과 주변 맥락을 확인한 뒤 검증 todo 또는
  deep-dive todo 로 이어간다.
- high-level scan finding 은 이미 report state 에 반영된다. 같은 turn 에서는 중복
  report update 보다 검증, 영향 범위 확인, owner/ticket 추적 todo 를 우선한다.

## GitHub

1. `github_task_scan(org)` 또는 `github_task_scan(repos=[...])` 로 시작한다.
2. finding 이 있으면 todo 를 갱신해 live 여부 검증, rotation scope, sibling repo 확산
   조사를 이어간다.
3. 필요한 경우에만 `gh_fetch_blob`, `gh_recent_commits` 로 특정 evidence 를 deep dive 한다.

주요 후보:

- `.env`, `terraform.tfvars`, `application.properties`, `Jenkinsfile`, `kubeconfig`,
  `config/`, `secret`, `credential`.
- commit patch 에 추가 후 삭제된 secret.

## Jenkins

1. `jenkins_task_scan()` 또는 `jenkins_task_scan(job_names=[...])` 로 시작한다.
2. finding 이 있으면 todo 를 갱신해 job owner, credential binding 전환, 최근 build 확산
   여부를 확인한다.
3. 필요한 경우에만 `jenkins_fetch_job_config`, `jenkins_fetch_console` 로 특정 evidence 를
   deep dive 한다.

## Confluence

1. `confluence_task_scan(space_keys=[...])` 또는 `confluence_task_scan(page_ids=[...])` 로
   시작한다.
2. finding 이 있으면 todo 를 갱신해 page owner, credential activity, linked page/attachment
   확산 여부를 확인한다.
3. 필요한 경우에만 `confluence_fetch_page`, `confluence_fetch_attachment` 로 특정 evidence 를
   deep dive 한다.
4. 문서의 keyword hit 만으로 severity 를 올리지 말고 주변 맥락을 확인한다.

## False Positive 회피

- `${SECRET}`, `xxx`, `your-token-here`, `changeme`, `AKIAIOSFODNN7EXAMPLE` 같은
  예시 값은 finding 에서 제외하거나 severity 를 낮춘다.
- archived/sample/example/test repo 는 맥락을 보고 severity 를 낮춘다.
- 페이지나 로그 전체를 인용하지 않는다. 필요한 masked snippet 과 위치만 남긴다.
