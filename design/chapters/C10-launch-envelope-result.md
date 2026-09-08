# C10 고정 CLI 전달과 compact 세션의 엔진 전환

2026-09-08 · checkpoint386. **이 소단위 구현·로컬 검증 완료**이며 전체 C10/goal 완료가 아니다. 기준선은 `8d474bbe05aa430725a01cec851cfafe73439f70`이다. 실제 모델/API 중단과 외부 서비스 미연결을 유지했다.

## 구현한 동작

`secumon-agent dispatch --directory 담당 -- 내부명령 …`을 추가했다. 이전 입구는 외곽만 읽고 선택 엔진에 내부 argv를 그대로 넘긴다. 선택 엔진은 자신의 parser로 내부 명령을 읽고 실제 담당의 정규화 경로가 외곽과 같은지 확인한다. 내부 담당 생략 시 외곽 경로를 사용하며 실제 cwd·stdin/stdout/stderr·호스트 콜백 전달은 기존 경계를 유지한다.

도움말·오류·관리 명령을 같은 null로 취급하지 않도록 공유 parser의 분류를 나눴다. 내부 lifecycle/repair/clone/중첩 dispatch/독립 work 저장소는 거절하고, 새 엔진에도 없는 옵션은 그 엔진의 기존 오류 처리로 끝난다. 엔진 선택·등록·pin/release 검사·프로세스 종료 처리는 기존 구현을 재사용했다. 외곽 profile 검사는 먼저 metadata와 기억 이관 fence를 조회할 수 있으므로 저장소 조회가 전혀 없다고 주장하지 않는다.

## 현재 확인한 실제 로컬 흐름

정상 bundler/installer로 만든 A/B 한 쌍에, B만 아는 시험 옵션과 실제 답변 formatter 차이를 **B의 manifest 생성 전** 넣었다. 두 설치의 지문이 다르고 원 A는 변경되지 않았음을 확인했다. A에서 정정 요청→추가 질문→명시 답변을 받은 뒤 실제 읽기 결과를 채택한 미완료 업무에서 합성 compact를 수행했다. 그 이후 backup/update/register→원 A 입구의 B 선택→같은 세션 재열기→이전 업무 완료→새 후속 요청을 실행했다.

- B 전용 옵션은 A의 일반 명령 파서에서 거절되지만 dispatch에서는 B가 실제 처리했다.
- 원 대화 이력·요약과 인용·명시 개인 기억·담당 및 호스트 신원·근거·원문 bytes·이전 영수증을 보존했다.
- 진행 업무는 모델 호출 2회(그중 compact 1회)에서 3회로 늘어 완료됐고 도구 호출은 1회로 유지돼 재조회하지 않았다.
- 새 업무는 이전 목표와 사용량을 합치지 않았다. 이전 A의 정정 답변이 원문 tail 밖에 있어도 summary 인용을 실제 B 입력으로 사용했다. 같은 입력 재전달은 추가 실행·compact·전달을 만들지 않았다.
- 네 업무의 합성 모델 호출 합계 7회(그중 compact 1회), 도구 합계 1회다. 실제 모델 판단 품질·운영 비용 측정은 아니다.

## 검증 기록

신규 고유 **4개**·직접 관련 **55개**, 합계 **59개**가 통과했다. build1 exit0·신규4/관련55, 코어 타입 exit0·계층199개/위반0이다. [build1 소스 대조](../../runtime/evidence/checkpoint386-build1-source.json)는 Node v24.20.0 darwin arm64의 2,388파일을 확인했다. 소스 지문은 `582cd55bdda0ca0da30a3d6d599f992441f8eb587f1ce6fdde60a62be977d2b7`이다.

새 dispatch 시험의 기본 CLI 프로세스에 기존 home 격리 preload를 빠뜨려 시험 담당 등록 두 개가 사용자 registry에 생성됐다. 같은 시험 임시 경로·시각·단일 파일·SHA를 대조하여 두 원 기록과 비어 있는 UUID 디렉터리만 정리했다. 다른 등록은 변경하지 않았다. 기존 preload를 연결하고 선택 담당의 실제 세션 owner를 더 명시적으로 단언한 뒤 **build2 exit0·해당 3개 재시험 통과**를 확인했다. 제품 동작 변경은 아니다.

최종 [build2 소스 대조](../../runtime/evidence/checkpoint386-final-source.json)는 2,388파일 일치, `afb1d1a58aaa2fb34f6191b950fef3df87a6f645b7418bb05f24b2a76a9c991d`이다. **59개를 최종 소스에서 모두 재실행한 것은 아니다.** 제품과 A/B 시험 소스는 build1 이후 그대로여서 큰 설치 전환/55개 회귀를 반복하지 않았다. 실패한 시험은 없으며 시험 격리 교정 이력은 그대로 남긴다. 활성 build/test는 없다.

## 남은 범위

[자동 최초 pin과 npm release 준비](C10-initial-pin-plan.md)는 다음 별도 구현이다. 저장 schema 이행, 미확정 외부 효과, C09 종료 의미/저널·이력 비용, C05 권한 재허용 후 완료, C06 기억 HTTP/권한/브라우저, 현재 Linux/native Windows·실제 PostgreSQL/사내 연동·운영 설치와 최종 통합은 남는다. 이번 전환은 실제 로컬 설치 파일과 SQLite를 사용했으며 Linux/native Windows·실제 모델 품질의 인수가 아니다.

[계획](C10-launch-envelope-plan.md) · [사용법](C10-launch-envelope-usage.md) · [체크포인트](../../runtime/evidence/checkpoint386.json)
