---
name: jenkins
description: 사내 Jenkins CI 노출 점검 — job config·console log·credentials.xml 에서 시크릿/내부정보. "jenkins 점검" 시작 전 view.
domain: jenkins
when_to_use: Jenkins(CI/빌드) 점검 시작 전. job config / build console / credential binding 점검.
triggers: jenkins; 젠킨스; ci; build job; jenkinsfile; console log
---

> ⚠️ 이 파일은 **로드되는 skill 이 아니다**. `domains/` 는 skill 탐색 경로가 아니라
> (`_skill_search_dirs()` 는 `domains/<d>/skills` 만 본다) 여기 있는 SKILL.md 는
> `skill(action='view', ...)` 로 열 수 없다. 사람이 읽는 도메인 개요다.
> 워커가 실제로 여는 계약은 `skills/<name>/` 아래에 있다.


# jenkins_tasking — entry

사내 **Jenkins** 의 job config, 최근 build console log, credentials 바인딩에서 시크릿·
내부 시스템정보 노출을 점검한다. github/confluence 와 같은 services 우산 아래 per-service
sub-skill. 공통 원칙은 상위 `service_tasking`(services SKILL) 참조.

## 워크플로우

1. `jenkins_task_scan()` 또는 `jenkins_task_scan(job_names=[...])` 로 시작 —
   job config.xml + 최근 build console log 를 detector 로 훑어 finding 자동 적재.
   특정 build URL/번호가 이미 보이면
   `jenkins_task_scan(build_targets=[{"job_full_name":"...","build_number":N}], scan_configs=False)`
   로 해당 console log만 API detail 조회하고 recent-build 목록으로 넓히지 않는다.
   exact build console 을 찾지 못하면 0건 정상으로 넘기지 않고 errors에 남긴다.
   config.xml, build 목록, console log 중 일부 detail 조회가 실패하면 해당 phase를
   errors에 남기고 가능한 나머지 detail 조회는 계속한다.
   결과 payload/evidence 의 scan_status/recommended_target_status 를 확인해
   ok/partial/error 대상을 SMB 대시보드처럼 구분한다.
2. finding 이 있으면 todo 갱신: job owner, credential binding 전환, 최근 build 확산 확인.
3. 필요할 때만 `jenkins_fetch_job_config`, `jenkins_fetch_console` 로 특정 evidence deep-dive.

## jenkins finding 분류

① job config.xml 에 평문 시크릿/토큰/비번 하드코딩
② console log 에 시크릿 echo / 환경변수 dump / 내부 호스트·엔드포인트 노출
③ credentials.xml 노출 / credential binding 과다 스코프
④ Jenkinsfile 내 시크릿·deploy key

## 오탐 룰 (severity 강등/제외)

- placeholder/예시 값(`${SECRET}`, `changeme`, `xxx`) → 제외/강등.
- 키워드·파일명 매칭만으론 finding 금지 — 실제 본문 확인한 것만.
- 마스킹 스니펫 + 위치만. 전체 로그 인용 금지.

## scope

- read-only. credential 능동 사용/검증 금지 — 노출 내용 record-only.
- charter_ref 없는 점검 금지. (상세: services `safety.md`.)

> 이 sub-skill 은 재배치 시 신설(기존 skill 디렉토리 없었음). 도구 시그니처는
> `plugin/tools/jenkins_tools.py` · `plugin/agent_types/jenkins.py` 본문 참조.
