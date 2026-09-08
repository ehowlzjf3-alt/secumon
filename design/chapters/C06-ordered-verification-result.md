# C06 — 대화 입구·설치·두 담당 배치 검증 결과

2026-09-08 · checkpoint376. 이번 선택의 **고유 시험 16/16 통과**를 확인했다. 구성은 Knox 12개(build3) + 두 담당 배치 첫 시험 1개와 설치 2개(build2) + 개인 기억 배치 1개(build6)이며, 실패 후 재실행을 더하지 않는다. macOS/Node v24.20.0의 아래 서로 다른 빌드 결과를 합쳐 기록한 것으로, 최종 소스에서 16개를 모두 다시 실행한 결과는 아니다. [실행 계획](C06-entry-deployment-plan.md) · [V06 요구](C06-C10-verification-plan.md#c06) · [종료 관측](../../runtime/evidence/checkpoint376.json).

| 소스·실행 | 실제 결과 | 판정과 교정 |
| --- | --- | --- |
| build2 · [Knox target1](../../runtime/evidence/C06-ordered-target1.log) | 10/12 통과, 2실패 | 거절해야 할 업무의 run이 자기 세션의 무관한 pending 명령을 먼저 적용함. close 시작 뒤 새 입력도 facade에서 막히지 않고 하위 `execution_authority_denied`까지 진행함. 두 제품 경로를 교정. |
| build2 · [배치 target2](../../runtime/evidence/C06-ordered-target2.log) | 1/2 통과, 1실패 | 목적·도구·스킬·업무/세션 재열기 시험은 통과. 개인 기억 시험은 foreign source를 실제 `session_unavailable`에서 거절하는데 `knowledge_unavailable`만 기대한 fixture 오류. |
| build2 · [설치 target3](../../runtime/evidence/C06-ordered-target3.log) | 2/2 통과, exit0 | 원 npm tarball의 실제 격리 전역 설치와 기존 오프라인 bundle 설치. 66995.849666 ms. |
| build3 · [Knox target4](../../runtime/evidence/C06-ordered-target4.log) | 12/12 통과, exit0 | 두 제품 교정 후 전체 Knox 선택을 다시 확인. 9446.4425 ms. |
| build3 · [개인 기억 선택 target5](../../runtime/evidence/C06-ordered-target5.log) | 0/1 통과, 1실패 | 첫 기대 오류 교정 뒤 HTTP 선택이 `409/personal_memory_not_selectable`로 거절됨. fixture의 호스트 actor가 `allowWrites:false`인 채 선택을 요청한 경계를 교정. |
| build4 · [target6](../../runtime/evidence/C06-ordered-target6.log) | 0/1 통과, 1실패 | 명시 호스트 권한 교정 뒤 빈 오류로 실패, 전체 26553.800042 ms. 이 로그만으로 시간 초과 원인을 확정하지 않음. |
| build5 · [진단 target7](../../runtime/evidence/C06-ordered-target7.log) | 0/1 통과, 1실패 | 진단만 추가. research 업무의 HTTP POST `/commands`가 경과 20070 ms에 `TimeoutError`; 응답 상태 없음, 관측 modelInputs 3/sourceReads 1. 전체 26847.1355 ms. |
| build6 · [target8](../../runtime/evidence/C06-ordered-target8.log) | 1/1 통과, exit0 | session47925. 실패·취소·skip 0. subtest 31191.558667 ms, 전체 31325.265208 ms. 완료·격리·원자료 보존 assertion을 유지한 선택 재실행. |

빌드 지문은 [build2 manifest](../../runtime/evidence/C06-ordered-build2-manifest.json)의 `761d1e11dbb55e55a1d0095a4fc683b6242353c8509ecfae05cbf6e063e16fdb`, [build3 manifest](../../runtime/evidence/C06-ordered-build3-manifest.json)의 `fde7e0e618d5b9145e725e0aad61baa95441959f49f2f721fc1fd23e7f24bd7c`다. 최초 build1의 새 설치 helper TS7022는 `Response` 명시 타입으로 고쳤고 build2가 통과했다. 배치 첫 시험과 설치를 build3에서 다시 실행한 것으로 계산하지 않는다.

후속 지문은 [build4 manifest](../../runtime/evidence/C06-ordered-build4-manifest.json)의 `53b019920405ed36b54d2e789118ad076797212a97334caef503fd4546b2efe9`, [build5 manifest](../../runtime/evidence/C06-ordered-build5-manifest.json)의 `d16bf1f2bf6615ad33a5a05cfa10226e4bca81bc915af80981c1acd942db2366`, [build6 manifest](../../runtime/evidence/C06-ordered-build6-manifest.json)의 `bd6d79657c11b1cf6f17d6bb6a863267834fb64564287e235e7460fcbad4ea99`다. build6은 exit0이며, 기억을 사용하는 `/commands` HTTP 대기만 60초로 조정하고 선택 시험에 180초 종료 상한을 두었다. 31.325초는 두 담당을 다룬 **시험 전체 시간**이고 개별 HTTP 지연 측정값이 아니다. 상한 변경은 속도 개선이 아니며, 앞서 확인한 20초 초과 응답 지연은 별도 성능 후속으로 남긴다.

## 확인한 사용자 동작

[Knox 공개 입구](../../runtime/src/presentation/agent-knox.ts)는 접수 원문과 안내를 먼저 저장하고, 명시 run에서 실행한다. SQLite/file-journal의 중복 접수·재접속, 전달 unknown의 명시 flush/lookup과 후속 재시도, 조회만으로 실행·전달을 바꾸지 않는 경계, 목표/제어 버전, 동시 run 거절을 [12개 시험](../../runtime/src/tests/knox-entry.test.ts)으로 확인했다. 전송은 로컬 대역이며 실제 Knox 호출은 아니다.

교정한 run은 현재 업무의 인증 사용자·담당·세션·원 대화 binding을 **pending 세션 복구보다 먼저** 확인한다. 아직 업무가 생성되지 않은 원 접수도 해당 pending 요청의 binding을 확인한 뒤 기존 복구를 사용한다. close는 시작 시점에 새 호출을 `messenger_closed`로 막고 기존 profile 종료를 재사용한다. 같은 인증 사용자에게 호스트가 다른 route에 같은 sessionId를 명시하면 이력 연속성은 허용하지만, 기존 업무의 status/run/control에는 원 실행 binding이 계속 필요하다. 이를 모든 route 간 이력이 물리적으로 분리된 결과로 설명하지 않는다.

[두 담당 배치 첫 시험](../../runtime/src/tests/agent-deployment-entry.test.ts)은 공통 엔진을 바꾸지 않고 SQLite 상태+documents 개인 기억 담당과 file-journal 상태+SQLite 개인 기억 담당을 별도 디렉터리·DB·agentId/scope로 구성했다. 서로 다른 목적·읽기 도구·explicit/on-demand 선택 스킬을 일반 HTTP 실행에 전달하고, 상대 업무·문맥이 섞이지 않으며 재접속·중복 실행 때 새 모델/도구 호출이 없음을 확인했다. board/archive/peers/missions/a2a는 비활성이며 업무 결과가 개인 기억에 자동 저장되지 않는다.

두 번째 시험은 각 담당의 원 세션 입력을 기존 신뢰된 `personalKnowledge` 서비스로 같은 기억 ID에 저장한 뒤, 일반 HTTP 목록·본문 조회·재열기·명시 선택과 후속 업무를 확인했다. 모델에는 자기 담당의 기억만 `user_requested_memory_not_verified_evidence`로 전달되고 독립 근거로 승격되지 않으며, 기억의 원 업무는 그대로 보존됐다. fixture는 기존 계약에 맞춰 명시 `allowWrites:true`와 실제 write/effect 등록을 제공했다. 쓰기 도구는 allowedTools에 넣지 않았고 실행 권한 거절 및 write/validation/effect 조회 콜백 0회를 확인했다. **새로운 기억 전용 권한 모델을 구현한 것은 아니다.**

[설치 상세 결과](C06-installation-acceptance-result.md)는 원본 `npm pack` → 실제 npm 전역 bin/version/setup → uninstall/reinstall → 같은 미완료 work/session·원응답·자료 보존과 명시 재개를 확인했다. 원 사용자 캐시는 읽고 필요한 패키지 원 bytes·메타데이터를 임시 캐시에 복사했으며, 실제 사용자 전역 경로는 변경하지 않았다. 별도 시험은 `bundleAgentEngine/installAgentEngine`의 반환 command·자산·재설치 후 identity 보존을 확인했다. npm 배포물과 의존성을 포함한 bundle은 다른 배포 경로다. 설치된 Web의 HTML/CSS/JS는 loopback HTTP 응답 bytes까지 확인했으며 브라우저 렌더링 인수는 아니다.

## 남은 항목

- 이번 로컬 선택 16개는 통과했다. 기억을 사용하는 명시 실행의 20초 초과 지연 원인·비용·개선은 별도 후속이며, 대기 상한을 늘린 결과로 성능 목표 달성을 주장하지 않는다.
- V06 브라우저 렌더링·실제 사용자 조작, 현재 Linux 및 native Windows 설치/입구 실행, 변경을 합친 최종 통합은 별도 확인이다. 과거 플랫폼 통과를 이번 소스 결과로 옮기지 않는다.
- 실제 Knox/사내 MCP 규격·인증·전송과 실제 모델/API 품질은 미검증이며 실제 모델/API 중단 지시를 유지한다. 원 npm 패키지의 외부 registry 게시·가용성, 빈 캐시 오프라인 설치, 버전 간 업그레이드도 이번 인수 밖이다.
- [C05 권한 재부여 후 명시 재개 완주](C05-collection-permission-resume-plan.md)는 기존 차단·원문 보존 결과와 구분한 잔여다. 이번 C06 결과로 닫지 않는다. 다음 C07은 [별도 검증 준비](C07-ordered-verification-preparation.md)를 따르며 이 결과는 C01–C10 전체 완료 선언이 아니다.
