# 산출물 검증 결과

## C04 모델 문맥 창

모델 입력·출력·총 문맥 창을 구분하고, 필수 상태와 현재 원문이 들어가는지 먼저 확인한 뒤 과거 대화 compact를 연결했다. 같은 준비 결과를 재사용하며 실제 요청은 게시 후 다시 측정한다. macOS Node24 신규 **71/71**·관련 **704/704**, NAS Linux Node24 전체 **3,209/3,209**을 같은 소스로 통과했다. [C04 문맥 창 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-context-window-result.md) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C04-context-window-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-window-linux-nas-20260907/verification.json). 다음은 [등록된 모델 프로필과 일반 입구 연결 검토](/Users/seunghanee/Documents/secumon/design/chapters/C04-after-window-review.md)다. 실제 모델/API 시험은 중단 상태이며 C04 전체·Windows·PostgreSQL·사내 연동과 전체 goal은 미완료다.

신규 1차의 fixture 소유 등록 누락과 기대값 오류, 2차의 file-journal 60초 timeout을 원로그와 함께 보존했다. 소스 변경 없이 제한된 병렬도에서 신규 전체가 통과했다. 시간 초과의 단일 원인을 확정하지 않는다. NAS 원로그/결과9개 회수와 전용 프로세스 감사·SSH 종료를 확인했다. 실제 모델의 tokenizer 정확도·요약/답변 품질·실사용 성능과 브라우저 렌더링은 이 결과의 범위 밖이다.

## C04 일반 요청 첫 흐름

2026-09-07 일반 요청 → 주 모델 턴 → 직접 답변·질문·검증된 계획 → 기존 도구 실행 → 응답 검토·전달을 연결했다. 작업이 끝나도 같은 세션의 원문·요약을 다음 요청에 사용한다. 같은 소스에서 macOS 신규 **100/100**·관련 **636/636**, NAS 실제 Linux/Node24 전체 **3,138/3,138**을 통과했다. [C04 첫 흐름 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-general-turn-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-turn-linux-nas-20260907/verification.json) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C04-general-turn-usage.md). 다음은 [모델 입력 한도와 compact 조정](/Users/seunghanee/Documents/secumon/design/chapters/C04-context-window-plan.md)이다. 합성 모델로 계약을 확인했으며 실제 모델/API 시험은 중단 상태다. C04 전체·Windows·PostgreSQL·사내 연동 및 전체 goal의 남은 범위는 유지한다.

NAS 신규 100/100·관련 636/636와 필수 8단계가 통과했다. 원로그/결과 9개를 회수하고 전용 프로세스 감사와 SSH 종료를 확인했다. Web은 실제 HTTP 시험을 통과했으나 Mac 잠금으로 화면 렌더링은 검증하지 못했다. 최초 타입 검사·시험 실패와 교정은 결과 문서에 남긴다. 로컬 신규 시험의 정확한 종료 시각·각 시험 직전 pin·실제 시험 Node 버전은 수집되지 않았으므로 관측 시각·동결 빌드의 사후 대조·원로그와 구분한다. NAS 환경과 실행 종료는 원 runner가 기록했다.

## C03 D3 개인 기억 이관

2026-09-07 기존 SQLite 개인 기억을 문서 저장으로 명시적으로 옮기는 D3 흐름을 검증했다. 검증된 백업 → 원 SQLite 개인 기억 쓰기 제한 → 문서 초기 기록 검증 → 활성화로 이어지며 같은 ID·영수증·세션·compact를 보존한다. NAS 실제 Linux/Node24에서 **전체 3,038/3,038**, 신규 **38/38**, 관련 **315/315**을 같은 소스로 통과했다. [D3 결과](/Users/seunghanee/Documents/secumon/design/chapters/C03-personal-memory-migration-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C03-migration-verification.json) · [이관 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C03-memory-migrate-usage.md). 다음은 [C04 일반 요청과 답변 연결](/Users/seunghanee/Documents/secumon/design/chapters/C04-general-turn-plan.md)이다. PostgreSQL과 Windows 연결·실기 검증, C05 호출 비용 개선은 남겨 두며 C03 전체와 전체 goal은 완료가 아니다. 실제 모델/API 시험 중단을 유지한다.

원 SQLite/문서 저장소와 실제 자식 프로세스 종료를 사용하는 합성 내용 시험이다. 백업·fence·seed·활성화의 재개, compact/세션/영수증 보존, clone·이동, 원본 파일 불변과 빈 DB fallback 거절을 확인했다. SIGKILL·주입 I/O 오류를 전원 장애나 실사용 성능 검증으로 확대하지 않는다. 브라우저 렌더링은 이번 단위에서 실행하지 않았고 실제 CLI/HTTP와 정적 UI 계약을 확인했다. 이전 D2 원인 미확정 관측은 확정 증거의 priorD2에 유지한다.

## C03 D2 문서 초안 적용

2026-09-07 문서로 내보낸 개인 기억의 초안을 편집하고 CLI/Web에서 명시적으로 적용하는 흐름을 연결했다. 편집 내용과 요청 ID를 고정한 뒤 기존 원문 접수·기억 정정·영수증 조회로 이어가며, 중단 후 같은 요청을 재개할 수 있다. NAS 실제 Linux/Node24에서 **전체 3,000/3,000**, 관련 **306/306**을 같은 소스로 통과했다. [초안 적용 결과](/Users/seunghanee/Documents/secumon/design/chapters/C03-document-draft-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C03-drafts-verification.json). 다음은 기존 SQLite 개인 기억의 명시적 문서 이관이다. SQLite 기본값·대화 원문·업무 기억 구분은 유지하며 PostgreSQL·Windows·호출 비용 개선은 남아 있다. 실제 모델/API 시험은 중단 상태이며 C03 전체와 전체 goal은 진행 중이다.

실제 CLI·HTTP API, 고정 요청의 원문/기억 중복 방지, 편집 내용 재개, 8개 실제 프로세스 종료 경계와 두 상태 저장소를 확인했다. 이번 브라우저 렌더링은 실행하지 않았다. 첫 NAS 관련 시험의 원문 snapshot 경합은 제한된 동일 요청 재검증과 결정적 시험으로 수정했다. build3의 첫 관련 시험(target2)에서 기존 concurrent CLI first storage opens(SQLite) 4개 중 1개가 agent_storage_path_unsafe로 실패했다. 정확한 throw 원인은 미확정이다. 독립 API 10묶음·40 worker와 원 CLI 경로를 관측한 관련 재시험 target3(299/299)에서는 재현하지 못했다. 원인 추측으로 파일·소유권 검사를 완화하거나 초기화 코드를 변경하지 않았다. 이 비결정적 macOS 초기화 실패는 미해결 관측으로 남기며 재발 시 원 stack/메타데이터를 확인한다. NAS 전체 attempt2의 MCP read-tools 파일은 17개 자연 완료 뒤 약336초 정체하여 정확한 자식 PID를 진단용 SIGTERM으로 종료했다. 전체2982/2983·실패1을 보존했다. 같은 build3 단독 관측시험은28/28로 자연 완료했다. 이후 문서 목록 경합을 수정한 build4의 최종 NAS 전체3000/3000·관련306/306도 통과했으며 MCP 종료 시 미완료 phase/FS는 없었다. 원 MCP 정체 원인은 여전히 미확정이다. MCP/SDK 코드를 추측으로 수정하지 않았고, 관측 preload의 타이밍 영향과 상세 로그 한도를 유지해 기록한다. 세 번째 NAS 관련시험은297/299로 실패했다. 원 등록 오류의 중첩 cause와 writer 대기의 자식 오류는 원로그에 없어 두 실패의 유일한 원인을 단정하지 않는다. 별도 고정 재현에서는 정상 canonical hardlink 게시 후 낡은 pending-only 목록으로 owner와 namespace를 읽으면 unsafe/read가 발생함을 각각 확인했다. 공통 읽기 경계는 같은 checked 디렉터리의 제한된 이름 목록이 실제 달라질 때만 원 cause를 보존한 changed/read로 전체 재검증한다. 링크·소유자 허용 조건과 재시도 상한은 유지했다. 자식 IPC/조기 종료의 원 stderr 진단도 보강했고, 신규7개 회귀를 포함한 로컬306/306·최종NAS관련306/306·전체3000/3000을 확인했다.

최종 NAS exec4062 종료 2026-09-07T02:56:35.548Z. 원로그/결과 8개 해시와 소스/빌드 지문, 관측 가능한 전용 프로세스 0·SSH 종료(접근 불가 peer는 별도 기록)를 확인했다. macOS 전체 시험과 native Windows·실제 모델·운영 검증은 미실행이다.

## C03 D1 문서 개인 기억

2026-09-07 새 담당에서 개인 기억의 문서 저장 방식을 명시적으로 선택할 수 있게 연결했다. SQLite가 기본이며, 문서 선택 시 개인 기억은 Markdown 정본에, 업무 기억은 SQLite에 저장한다. NAS 실제 Linux/Node24에서 **전체 2,941/2,941**, 관련 **199/199**을 같은 소스로 통과했다. [문서 기억 결과](/Users/seunghanee/Documents/secumon/design/chapters/C03-document-memory-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C03-documents-verification.json). 다음은 편집 초안의 명시 적용이며, 문서 읽기 비용 개선·이관·PostgreSQL·Windows 연결은 남아 있다. 실제 모델/API 시험은 중단 상태이며 C03 전체와 전체 goal은 진행 중이다.

macOS 관련 199개와 NAS 전체 회귀를 확인했다. 새 구성의 Web은 실제 HTTP API로 검증했고 이번 브라우저 렌더링은 실행하지 않았다. 첫 관련 시험의 4프로세스 초기화 경합(197/198)은 원로그를 보존하고 제한된 임시파일 재관찰과 결정적 회귀를 추가해 수정했다. 원로그 8개·정적자산 7개·소스/빌드 지문 대조, 시험 프로세스 0·SSH 종료를 확인했다. 단회 계측의 반복 읽기는 [비용 검토](chapters/C03-document-memory-cost-notes.md)에 기록했다.

## C03 개인 기억 첫 사용자 흐름

2026-09-07 개인 기억의 명시 등록→새 대화 회상→정정·잊기를 CLI/Web·기억 도구·실제 입력 문맥에 연결했다. NAS 실제 Linux/Node24에서 **전체 2,888/2,888**, 신규 관련 **52/52**을 통과했다. [개인 기억 결과](/Users/seunghanee/Documents/secumon/design/chapters/C03-personal-memory-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C03-personal-verification.json). 기본 SQLite를 유지하며 다음은 문서 기억과 명시 등록형 PostgreSQL이다. 단회 계측의 중복 읽기와 Web 오류 표시 문제는 C05/C06에 남긴다. 실제 모델/API 시험은 중단 상태이며 C03 전체와 전체 goal은 진행 중이다.

수정본 macOS 관련52개·코어/구조143개, 같은 소스의 실제 Web 관찰과 단회 공개 포트 계측을 포함한다. 첫 시험 기대 오류3개와 broad review waiver 결함의 실패 재현·수정 기록을 보존했다. Web stale 선택 오류표시와 중복 읽기 비용은 잔여이며 운영 품질 통과로 표현하지 않는다.

## C02 반복 compact

2026-09-07 반복 compact를 기존 모델 호출·정산·복구와 연결했다. 같은 세션의 원문을 보존하며 앞부분 요약과 최근 입력을 조합하고, 작업 완료 뒤에도 문맥을 이어간다. NAS 실제 Linux/Node24에서 **전체 2,836/2,836**, 신규 compact **46/46**을 통과했다. [반복 compact 결과](/Users/seunghanee/Documents/secumon/design/chapters/C02-session-compact-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C02-compact-verification.json). 첫 Linux 초기화 경합 실패는 고정 재현·최소 수정하고 원로그를 보존했다. 다음은 [C03 개인 기억의 등록·회상·정정·잊기](/Users/seunghanee/Documents/secumon/design/chapters/C03-personal-memory-plan.md)다. 실제 모델/API 시험은 재개하지 않았으며 C01/C02 전체 및 전체 goal은 진행 상태를 유지한다.

- 최종 소스 2193685e0a64d0f88e40113b2838afc03c8c24b8430d6a6c36847613b77e0967 / build a8ffa413f7bef69302103f3f39bbf1738dfa74756d47d6435ff1404e0bb04d70 / 1248파일. 원로그8개와 정적자산7개 대조, 전용 프로세스0·SSH 정리 확인.
- macOS 최초 신규42/46·기존 회귀127, 수정 후 표면9, 최종 초기화 관련43개를 소스별로 기록했다. 브라우저와 1회 합성 계측은 build2 증거이며 최종 소스로 소급하지 않는다.
- 첫 Linux2830/2831 실패와 초기화 경합 baseline 재현을 보존했고 최종 전체 검증으로 재확인했다. 모델 의미 품질·native Windows·사내 연동·전원 장애 검증은 아니다.

## C02 지속 세션 첫 흐름

2026-09-07 작업 X 완료 뒤 재시작하고 같은 세션에서 Y를 요청하면 원문 대화와 전달된 응답이 Y의 모델 입력으로 이어지도록 연결했다. NAS 실제 Linux/Node24에서 **전체 2,785/2,785**, 신규 관련 **48/48**을 통과했다. [지속 세션 결과](/Users/seunghanee/Documents/secumon/design/chapters/C02-persistent-session-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C02-session-verification.json). 현재 문맥은 원문을 제한된 크기로 조합하며, 다음은 [반복 compact 계획](/Users/seunghanee/Documents/secumon/design/chapters/C02-session-compact-plan.md)이다. C02 전체·C01 Windows/호스트 격리·C03~C10은 진행 또는 대기 상태이며 전체 goal은 유지한다. 실제 모델/API 시험은 재개하지 않았다.

신규48개는 세션 흐름8·실제 SIGKILL6·실제 저장소 경계10·문맥/모델 대역10·SQLite9·CLI/Web5다. macOS에서는 핵심43개(첫 빌드)와 표면 수정 후5개를 검증했고 최종 소스의 별도 전체 시험은 실행하지 않았다. 최종 소스는 NAS에서 빌드·코어 타입·계층130개/위반0·CLI fixture4개·통합 fixture4시나리오/22판정을 통과했다. 원 로그8개·정적자산7개·source18c2aa2f... / buildca20f6b0... /1200파일을 대조했다.

첫 Web 시험2개 실패는 로컬 model 문맥 공개 정책 누락을 수정해 해결했다. 실패 로그와 중간 소스의 검증은 보존한다. 실제 브라우저에서 두 작업·새로고침·동일 세션 이력을 확인했으며 합성 실행 결과를 자연어 모델 품질로 취급하지 않는다. NAS 종료 2026-09-06T22:00:56.986Z, 22:01:34.166Z 시험 프로세스0·root0700·기본Node18 유지와 SSH 정리를 확인했다. 실제 Windows/모델/API/Knox/전원 장애 검증은 미실행이다.

## C01 최초 설정 생성·게시·재개 및 Windows 선행 모듈

2026-09-07 담당 설정의 생성·덮어쓰기 없는 게시·후보 정리·중단 후 동일 ID 재개를 연결했다. NAS 실제 Linux/Node24에서 **전체 2,737/2,737**, 관련 **133/133**, macOS 관련 **133/133**을 통과했다. [설정·복구 결과](/Users/seunghanee/Documents/secumon/design/chapters/C01-setup-mutations-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-setup-mutations-verification.json). [Windows 선행 구현](/Users/seunghanee/Documents/secumon/design/chapters/C01-windows-native-progress.md)은 Rust 모듈과 컴파일/로컬 검사까지 마쳤고 실제 Windows 실행과 런타임 연결은 남아 있다. 다음은 [C02 지속 세션 계획](/Users/seunghanee/Documents/secumon/design/chapters/C02-persistent-session-plan.md)다. C01의 플랫폼·실행 격리 잔여와 전체 goal은 계속 진행 중이다.

새27개(공통13·setup14, 실제SIGKILL3 포함). source7224d97d... / builddcb50d2c... /1158파일. 원로그8개·정적자산7개를 대조했다. 첫 관련 시험의 오류 관측 수정과 첫 NAS 빌드의 전송 부가파일 문제는 원 증거를 보존했다. 최종NAS 종료 2026-09-06T19:07:48.481Z, 회수/SSH 정리 완료. Windows Rust4개·macOS addon6개·Windows target Cargo check는 실제 Windows 실행과 구분한다.

## C01 작업 파일 안정 읽기·중복 조회 제거

2026-09-07 작업 파일 read/list를 공통 안정 읽기와 한 번의 레코드 검증으로 연결했다. 같은 합성 목록의 파일 열기·파싱·전달 bytes는 절반으로 줄었고, 추가 메타데이터 확인 비용은 별도로 기록했다. NAS 실제 Linux/Node24에서 **전체 2,710/2,710**, 관련 **163/163**, macOS 관련 **163/163**을 통과했다. [구현·측정 결과](/Users/seunghanee/Documents/secumon/design/chapters/C01-workspace-stable-read-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-workspace-read-verification.json). 다음은 [최초 설정의 생성·게시·중단 후 재개](/Users/seunghanee/Documents/secumon/design/chapters/C01-host-file-mutations-plan.md)다. Windows native·호스트 실행 격리·지속 세션과 이후 챕터는 남아 있으며 C01 전체와 goal은 진행 중이다.

신규41개(읽기 경합/오류19·레코드/한도/호환22). 종료 2026-09-06T18:12:04.654Z. source835c88d2... / build149aa7f3... /1140파일과 정적자산14개 확인. Linux paired 비교8쌍×5표본에서 입력/결과/검증입력을 대조했다. 파일별 안정 읽기 검증이며 목록 전체 snapshot·전원 장애·Windows 실행의 보장은 아니다. 원 로그 회수, 시험 프로세스0·기본Node18 확인과 SSH 정리를 완료했다.

## C01 작업 파일 디렉터리·잠금·동기화

2026-09-07 작업 파일 저장소의 폴더 참조·호출별 잠금·동기화를 공통 파일 어댑터에 연결했다. 사라진 폴더 재생성, 잠금 소실 후 잘못된 성공, 해제 오류에 의한 원실패 유실을 막고 다음 호출의 잠금을 보존한다. NAS 실제 Linux/Node24에서 **전체 2,669/2,669**, 관련 **122/122**, macOS 관련 **122/122**를 통과했다. [구현·검증 결과](/Users/seunghanee/Documents/secumon/design/chapters/C01-workspace-directory-lock-sync-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-workspace-boundary-verification.json). 다음은 [작업 파일 안정 읽기·목록 중복 I/O 제거](/Users/seunghanee/Documents/secumon/design/chapters/C01-workspace-read-boundary-plan.md)다. Windows native·호스트 실행 격리·지속 세션과 이후 챕터는 남아 있으며 C01 전체와 goal은 진행 중이다.

신규31개(디렉터리/잠금17·sync/오류11·실제SIGKILL3). 종료 2026-09-06T17:45:07.928Z. source a6b89d53... / build a1981502... /1131파일 및 정적자산7개 확인. 중단 뒤 잠금/원본 보존·거절과 자동 잠금 복구를 구분한다. 실제 모델/API·사내 서비스·Windows native·전원 차단 검증은 실행하지 않았다.

## C01 파일 저널 담당 연결과 저장 방식 고정

2026-09-07 파일 저널을 담당별 상태 저장소에 연결하고 첫 저장 방식을 고정했다. 담당용 v2 owner와 기존 독립 v1 호환, clone의 빈 저장소, 소유/저장 방식 불일치 거절을 연결했다. NAS Debian 12/x64/ext4/Node24.20.0에서 **전체 2,580/2,580**, 관련 **192/192**, macOS 관련 **192/192**를 통과했다. [파일 저널 담당 연결 결과](/Users/seunghanee/Documents/secumon/design/chapters/C01-file-journal-binding-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-journal-binding-verification.json). 다음은 [공통 파일 경계의 첫 추출](/Users/seunghanee/Documents/secumon/design/chapters/C01-file-boundary-extraction-plan.md)이며 네이티브 Windows·지속 세션·실제 모델/사내 연동은 별도 미완료 범위다. C01 전체는 진행 중이다.

신규57개, 실제 프로세스 종료12사례(자동재개10·보존거절2). 종료 2026-09-06T16:06:40.078Z. source80a2d62d... / build6acbc8d1... /1065파일 및 정적자산7개 확인. SQLite 읽기 전용 owner 확인의 WAL 조정 파일과 hot-journal 복원 요구를 구분한다. 최초 CLI backend 선택은 C06, 자동 복원/이행은 C03/C10 잔여다.

## C01 새 담당 복제와 명시 재개

2026-09-07 00:27 KST, NAS Debian 12 / Linux 6.12.30+ / x64 / ext4 / Node 24.20.0에서 **2,523/2,523 통과·실패/취소/skip/todo 0**. 빌드·관련 138/138·코어 타입·계층 125파일/위반 0·계층 CLI 사례 4개·합성 fixture 4/22도 통과했다. macOS 관련 시험은 56/56이며 최신 소스의 macOS 전체 시험은 별도로 실행하지 않았다. 신규 32개에는 실제 프로세스 종료 후 복구 10개가 포함된다. 전체 Node 시험 파일 병렬 2, lint 미설정이다.

source fee85e7d... / build c645b1ac... / 1035파일과 정적 자산 7개의 해시를 회수 후 대조했다. 원본 설정·스킬 재사용과 새 ID·빈 상태/기억/채널·산출물, 중단 후 같은 ID 재개, 기존 v1 호환과 충돌 보존을 확인했다. 시험 프로세스 잔여 0과 기존 Node 유지 확인 후 SSH 연결을 닫았다. [동작과 결과](/Users/seunghanee/Documents/secumon/design/chapters/C01-clone-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-clone-verification.json).

Windows 파일 경계/실제 실행, 수동 폴더 복사의 중복 ID 운영, file-journal 담당 연결, 전체 사용자 입력 대화 이력·지속 세션·실제 모델/사내 연동은 별도 남은 범위다. C01 전체 완료로 표시하지 않는다.

## C01 Linux 실제 전체 검증과 경로/파일 읽기 수정

2026-09-06 23:52 KST, NAS Debian 12 / Linux 6.12.30+ / x64 / ext4 / Node 24.20.0에서 **2,491/2,491 통과·실패/취소/skip/todo 0**. 빌드, 관련 106/106, 코어 타입, 계층 125파일/위반 0, 실제 계층 CLI fixture 4개, 합성 4시나리오/22판정도 통과했다. 전체 Node 시험은 파일 병렬 2로 실행했고 lint는 미설정이다. sourceDigest 987e6cc8..., build filesDigest 9808e14c...와 별도 정적 자산 7개를 회수 뒤 대조했다. [수정/실패 이력](/Users/seunghanee/Documents/secumon/design/chapters/C01-portability-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-linux-native-verification.json).

NAS 기존 Node는 변경하지 않았고 시험 프로세스 잔여 0을 확인한 뒤 SSH 연결을 닫았다. 전용 시험 폴더는 보존했다. native Windows, clone, 지속 세션과 실제 모델/사내 연동, 설치/상주 운영은 별도 미완료 범위다. ext4의 관측 mount 옵션에 nobarrier가 있어 프로세스 중단 복구를 전원 장애 내구성으로 해석하지 않는다. C01과 전체 goal은 진행 중이다.

## C01 첫 단위 — 담당 등록과 SQLite 기본 저장 연결

2026-09-06 macOS/Node 24.20.0 첫 단위의 당시 검증. 신규 19개·기존 CLI 포함 24/24, 필수 전체 2479/2479·실패/취소 0, 코어 타입 검사, 안쪽 계층 125파일/위반 0, 4개 fixture/22판정 통과. 당시 sourceDigest 0f49c4ca...의 소스/build manifest 일치를 확인했다. 이후 Linux 수정/전체 결과는 위 기록을 따른다. 네이티브 Windows, clone, 작업 간 지속 세션, 실제 모델/사내 연결은 미검증 또는 미구현이며 C01 전체는 진행 중이다. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C01-workspace-result.md) · [증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-workspace-local-verification.json).

## v0.50 — 역할 간 자원 배정 권한과 정산

이번 [역할 간 자원 배정·정산 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-budget-authority-result.md)에서 별도 자료 권한을 가진 역할에 자원을 배정하고, 해당 역할 runtime으로 중단·사용량 정산·미사용 반환을 연결했다. 권한 철회·응답 유실·하위 위임·compact/reopen을 검증했다. 전체 **2416/2416**, 관련 **168/168**, 신규 **62개**가 통과했다. **P4-01은 진행 중**이며 다음은 [게시판 수락과 에이전트 자원 관리 연결](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-funding-plan.md)이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-budget-authority-local-verification.json).

Node 24.20.0, native verify exit 0, 385168.136875ms. 코어 타입·계층 123/위반 0·fixture 4/22 통과, lint 미설정. 신규 62개 중 60개는 역할 runtime 경계, 2개는 영속 위임 계약이다. 기존 budget process-crash suite를 함께 실행했으며 신규 프로세스 강제 종료 사례를 추가했다고 주장하지 않는다. 실제 모델·게시판 funding adapter·에이전트 자원 관리 도구는 별도 미완료 범위다.

## v0.49 — 요청 발견과 사건 기반 재개

이번 [요청 발견·재개 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-wake-result.md)에서 제한된 요청 조회와 영속 구독·알림을 연결했다. 중복/누락 알림, 처리 중 권한 변경, compact/reopen과 작업 수명을 검증했다. 전체 **2354/2354**, 관련 **48/48**, 신규 **48개**가 통과했다. **P4-01은 진행 중**이며 다음은 [역할 간 예산과 수락 조건](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-budget-plan.md)이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-wake-local-verification.json).

Node 24.20.0, native verify exit 0, 369908.69325ms. 코어 타입·계층 121/위반 0·fixture 4/22 통과. 신규 48개에는 소유 board worker SIGKILL 2개가 포함된다. host refresh의 영속 재개 검증이며 상시 역할 dispatcher·자율 추론·실제 사내 연결 검증은 아니다.

## v0.48 — 협업 요청과 작업 의무

이번 [협업 요청·의무 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-obligations-result.md)에서 요청·수락·답변·확인·거절·취소 도구를 각 작업의 의무와 연결했다. 응답 유실 뒤 의무를 복원하고, 대기와 답변 작성/확인을 구분한다. 전체 **2,306/2,306**, 관련 **167/167**, 신규 30개가 통과했다. **P4-01은 진행 중**이며 다음은 [요청 발견과 사건 기반 재개](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-wake-plan.md)다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-obligations-local-verification.json).

Node 24.20.0, native verify exit 0, 351758.285167ms. 코어 타입·계층 116/위반 0·fixture 4/22 통과. 신규 30개는 두 역할의 정해진 도구 계획을 실행한 로컬 시험이며 모델의 자율 협업 추론이나 실제 사내 연결 검증이 아니다.

## v0.47 — 게시판 게시·철회와 효과 복구

이번 [게시판 쓰기·복구 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-writes-result.md)에서 `core.board.publish`/`core.board.retract`를 runtime에 연결했다. 저장 영수증으로 효과를 확인하고, 응답 유실 때 원래 결과를 보존하며 미실행 종료 기록으로 늦은 중복 저장을 막는다. 전체 **2,276/2,276**, 관련 **195/195**, 신규 40개가 통과했다. **P4-01은 진행 중**이며 다음은 [요청·답변과 작업 의무](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-obligations-plan.md)다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-writes-local-verification.json).

Node 24.20.0, native verify exit 0, 314703.539333ms. 코어 타입·계층 115/위반 0·fixture 4/22 통과. 신규 owned 저장 작업자 SIGKILL 2개이며 전체 executor의 새 SIGKILL 시험은 아니다. 실제 모델/API·사내 서비스·운영 배포는 미실행이다.

## v0.46 — 게시판 읽기와 지속 입력

이번 [게시판 지속 입력 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-inputs-result.md)에서 `core.board.read`를 실제 runtime 호출과 입력 장부에 연결했다. 두 역할의 글·기억·수집 출처를 공통 그래프로 검사하고, 과거 호출·공개 화면·compact/reopen에서도 현재 권한과 원본을 확인한다. 전체 **2,236/2,236**, 관련 **165/165**, 신규 36개가 통과했다. **P4-01은 진행 중**이며 다음은 [게시·요청·답변 도구와 작업 의무](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-writes-plan.md)다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-inputs-local-verification.json).

Node 24.20.0, native verify exit 0, 313362.969541ms. 코어 타입·계층 114/위반 0·fixture 4/22 통과. 관련 시험은 전체 시험에 포함된다. 새 모델/API·사내 서비스·운영 배포 시험은 없으며, 두 runtime의 쓰기/의무/예산/가설 재계획 전체 흐름은 남아 있다.

## v0.45 — 공통 입력 그래프와 기억 도구 취소

이번 [공통 입력 검증 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-input-validation-result.md)에서 유한한 출처 그래프를 구현하고 기억 서비스와 도구 취소에 연결했다. 반복 참조·버전 충돌·자료/권한 변경·만료를 검사하며 호출마다 큐와 취소 상태를 분리한다. 전체 **2,200/2,200**, 관련 **158/158**, 신규 20개가 통과했다. **P4-01은 진행 중**이며 게시판의 지속 입력·runtime 도구와 교차 주체/복합 증명 연결은 다음 작업이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-input-graph-local-verification.json).


## v0.44 — 게시판 조회 범위와 미검증 가설

이번 [게시판 조회 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-pages-result.md)에서 글 수·UTF-8 크기·대상·업무 권한을 제한한 페이지 읽기, 출처 coverage와 미검증 가설 표시를 구현했다. 전체 **2,180/2,180**, 관련 **81/81**, 신규 20개가 통과했다. 두 업무군·두 저장소에서 페이지 이어가기와 권한·철회·조회 중 변경을 확인했다. **P4-01은 진행 중**이며 다음은 runtime 읽기 도구와 지속 입력 검증, 이어서 쓰기·의무·역할 간 예산·compact 연결이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-pages-local-verification.json).


## v0.43 — 게시판 저장·권한·출처

이번 [게시판 저장·권한·출처 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-foundation-result.md)에서 지속되는 두 역할, 공유 대상, 원 출처를 계승하는 게시글과 질문의 수락·응답·확인을 구현했다. 전체 **2,160/2,160**, 관련 **86/86**, 신규 43개가 통과했다. 두 저장소의 실제 worker SIGKILL 복구 2개와 두 업무군의 재열기·충돌·철회도 확인했다. **P4-01은 진행 중**이며 다음은 에이전트 도구·작업 의무·예산·compact/reopen 연결이다. 실제 모델/API·사내 MCP·Knox·A2A 연동 검증은 남아 있다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-local-verification.json).

Node 24.20.0, native verify exit 0, 301744.081834ms. 코어 타입·계층 108파일/위반0·fixture 4/22 통과. 관련 86개는 전체에 포함된다. 현재 소스/빌드 일치와 네 역할별 협업 사례를 기록했다. 게시판 요청은 아직 WorkState 의무와 연결하지 않았으며 P4-01 전체 완료로 처리하지 않는다.

## v0.42 — 전체 수집 조건과 저장 응답 복원

이번 [전체 수집·응답 복원 결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-settlement-result.md)에서 승인된 유한 목록의 수집 완료 조건과 저장 응답의 재호출 없는 복원을 연결했다. 전체 **2,117/2,117**, 관련 **154/154**, 신규 28개가 통과했다. 실제 로컬 worker SIGKILL 복구 시험은 11개이며 기본 6조합을 별도 기록했다. 다음 로컬 단위는 **P4-01 두 에이전트와 게시판**이다. P3-01의 사내 연결·HTTP/OAuth·쓰기 계약과 실제 모델 검증은 남아 있으며 전체 P0–P6는 진행 중이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-settlement-local-verification.json).

Node 24.20.0, native verify exit 0, 299241.139625ms. 코어 타입·계층 103파일/위반0·fixture 4/22 통과. 현재 소스/빌드 일치와 기본 복구 6조합의 모델·복원 원격 호출 0 및 소유 프로세스/임시 파일 정리를 확인했다. 과거 구현/압축/검증 기록의 전수 대조는 수행하지 않았다.

## v0.41 — MCP 제한 대기와 명시 재개

이번 [MCP 대기·재개 결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-waits-result.md)에서 제한 응답의 재개 시각을 저장하고 모델 호출 없이 기다린 뒤 남은 항목을 이어가는 경로를 구현했다. 전체 **2089/2089**, 관련 **110/110**, 실제 로컬 worker SIGKILL 복원 4개가 통과했다. 과거 Python 구현 전체를 비교하지 않고 현재 기능과 새 코어의 회귀를 검증했다. P3-01과 전체 P0–P6는 진행 중이다. 실제 모델·사내 MCP·Knox와 상시 스케줄러는 이번 검증에 포함하지 않았다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-waits-local-verification.json).

## v0.40 — MCP collection 원본·명시 재개

이번 [MCP collection 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-collections-result.md)에서 기존 수집 장부에 실제 로컬 MCP의 batch/page를 연결했다. 전체 **2,040/2,040·실패/취소0**, 신규48개·관련127개가 통과했다. 개별 원응답 검증, 빈 페이지 보존, 부분 항목만 재조회, 등록 교체 중 전송 거절과 실제 worker SIGKILL 복구6개를 확인했다. SDK/lock과 이전 원본·정본을 보존한다. P3-01은 부분 검증/진행 중이고 다음은 rate-limit 대기와 명시 재개다. 사내 MCP·모델·Knox·운영 검증은 아니다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-collections-local-verification.json).

## v0.39 — 로컬 MCP 단발 읽기와 원본 proof

이번 [MCP 단발 읽기 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-adapter-result.md)에서 공식 SDK의 실제 로컬 stdio 서버를 기존 도구·호출 장부·원본 proof에 연결했다. 전체 **1,992/1,992·실패/취소0**, 신규42개·관련58개가 통과했다. 문서/관측×두 저장소의 원본·근거 채택, 정책 변경·취소·목록 변경·크기/동시성 제한·명시 재연결과 저장 결과 재검증을 확인했다. SDK client/server2.0.0 추가는 의도한 lock 변경이며 기존 원본과 정본을 보존한다. P3-01은 부분 검증/진행 중이다. 다음은 MCP batch/page와 ReadCollections의 cursor·부분 결과·명시 재개 연결이다. 실제 사내 MCP·모델·Knox·운영 검증은 아니다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-local-verification.json).

Node24.20.0 npm run verify exit0, 274506.735333ms. 코어 타입·안쪽 계층98파일/위반0·합성4시나리오/22판정 통과. 신규 read28/client14, 관련58(6007.401917ms)은 전체 분모에 중복 가산하지 않는다. 측정44개 row의 자식45개 시작/종료를 확인했다. 이전 전체 실행은 전송/종료 오류 처리 수정 전 판본으로 exit143 중단했고 소유15개 PID의 잔여0을 확인했다. 첫 관련57/57과 중간실패도 보존했다.

## v0.38 — 실제 계측 Web driver와 동일 목표 비교

이번 [로컬 Web driver 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-local-web-driver-result.md)에서 기존 실행·증거·이어가기 코어를 실제 계측 HTML 앱과 Chrome에 연결했다. 전체 **1,950개 시험·실패/취소0**, 신규·관련20개, 별도 실제 browser **17/17**이 통과했다. 두 저장소의 같은 목표8셀 모두 입력2·저장1로 완료했고 개별 도구3회→batch2회, Web bridge13→10회를 관측했다. 저장후 응답 유실의 정산·입력 없는 verify, reload·앱 재열기와 사람의 연속 입력·브라우저 fill도 검증했다. 1280/390/320px 화면 검수와 소유 서버/브라우저 종료를 확인했다. DOM 자동화이며 native OS·사내 화면·모델/API 검증은 아니다. P3-04는 부분 검증/진행 중이고 다음 로컬 챕터는 P3-01 MCP 재사용 adapter다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-local-web-driver-local-verification.json).

Node24.20.0 npm run verify exit0, 267380.279834ms. 실제 browser17개는 별도분모이며 신규 native suite20개에 중복 가산하지 않는다. 초기 browser 부재0/14, 응답유실주입12/14, 중간16/16과 최종17/17을 구분하고, in-app fill 수정으로 중단한 전체검증 exit143도 보존했다. 원본/기록/source-build 정적 검사는 이번 정본을 따른다.

## v0.37 — P3-04 실제 이어가기와 복구

이번 [실제 이어가기 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-continuation-runner-result.md)에서 v2 checkpoint와 실제 continue/verify를 연결했다. 원 입력의 기한·누적 한도를 유지하고 부모당 하나의 후속 작업만 예약하며, 적용된 입력은 반복하지 않는다. 현재 조건을 새로 확인하는 verify는 입력 0회다. 전체 **1,930개 시험·실패 0**, 신규 77개·최종 관련 143개, 코어 타입 검사·안쪽 계층 98파일/위반 0·합성 4시나리오/22판정이 통과했다. 실제 SIGKILL 복구 6개와 정산 후 진행 장부 갱신·중복 credit 방지도 검증했다. P3-04는 부분 검증/진행 중이며 실제 GUI·모델/API·사내 서비스는 미실행이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-runner-local-verification.json).

Node 24.20.0 npm run verify exit 0, 268403.600375ms. 첫 관련 138/141, 두 번째 182/185, 세 번째 135/137 실패 기록을 보존했다. 오래된 관찰의 v2 예약 기록 기대와 기존 오류 상태를 맞추고, 가상 입력 기한과 병렬 시험의 실제 watchdog을 분리했다. 첫 전체 검증은 1,929개 통과·1개 시간 초과 취소였으며, depth2 복구 시험의 바깥 완료 대기 한도를45초에서120초로 늘린 뒤 전체 검증을 다시 수행했다. 강제 종료 뒤 검증 정산을 진행 장부에 반영하는 누락을 수정했다. 원 입력 deadline은 늘리지 않았고, 중복 정산이 새 진전·목표 근거가 되지 않도록 검증했다.

## v0.36 — P3-04 후속 작업 계약과 근거 소비

이번 [후속 작업 계약·근거 소비 학습 결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-continuation-boundary-result.md)에서 부모당 단일 후속 claim과 CAS 계약, compact/reopen의 원본 참조 보존, 자료·공개·기억·전송의 효과 증명 검사를 연결했다. 실패 처리된 과거 증명도 검사하고, 원 업무가 소비한 기억의 개정·철회를 유한한 원출처 원장으로 재검증한다. 전체 **1,853개 시험·실패 0**, 신규 82개·최종 관련 197개, 코어 타입 검사·안쪽 계층 97파일/위반 0·합성 4시나리오/22판정이 통과했다. 실제 continue/verify 도구와 v2 runner는 미지원이며 해당 실행을 명시 거절한다. P3-04는 partially_verified/in_progress, 전체 완료 작업은 9개다. 다음은 원 시간·누적 시도 한도를 보존하는 v2 checkpoint와 실제 단일 successor 실행이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-boundary-local-verification.json). 실제 모델/API 시험은 중단 상태다.

최종 Node 24.20.0 npm run verify exit 0, 207453.42025ms. 신규 시험은 계약 14·context/복원 20·지원 전 실행 차단 8·원출처 소비 12·전송 8·기억 custody 20개다. 중간 targeted 32/40, 48/48, 165/169, 191/197 기록을 보존했고 마지막 197/197 이후 전체 검증을 수행했다. fixture의 공개 경계, 조회 사용량 및 index cache 기대를 정정했으며, 과거 proof 실패 후 실행용 resume의 거절은 강화한 계약으로 기록했다. 기본 Node 25.8.0의 첫 build는 중간 기록이고 최종 검증은 고정 Node 24.20.0이다. 실제 successor runner·GUI·모델/API·새 비용 비교는 미실행이다.

## v0.35 — P3-04 명시 런타임 효과 대조

이번 [명시 런타임 대조 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-runtime-reconciliation-result.md)에서 저장된 입력 영수증을 별도 읽기 예약·실행·정산에 연결했다. 원 입력과 결과를 보존하고, 증명이 사라지면 실행·모델·완료·압축·화면·전달 경계에서 다시 차단한다. 전체 **1,771개 시험·실패 0**, 코어 타입 검사·안쪽 계층 96파일/위반 0·합성 4시나리오/22판정이 통과했다. 신규·최종 관련 시험은 115개다. P3-04는 partially_verified/in_progress이며 전체 완료 작업은 9개다. 다음은 단일 successor의 남은 단계 이어가기와 현재 사후 조건 확인이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-runtime-reconciliation-local-verification.json). 실제 모델/API 시험은 중단 상태다.

최종 Node 24.20.0 `npm run verify` exit 0, 191351.012708ms. 계약 11·런타임 16·compact/restore 16·공통 효과 경계 16·SIGKILL 8·ACK/제어 변경 6·화면 6·전달 18·정본 출처 10·늦은 실행/조회 권한 8개를 검증했다. 첫 59/59, 두 번째 97/97, 세 번째 113/115(예산 철회 오류 코드 기대 차이 2개) 기록도 보존한다. 최종 115/115 이후 전체 검증을 수행했다. 실제 GUI/모델·성능 비교는 이번 단위에서 실행하지 않았다.

## v0.34 — P3-04 영속 입력 영수증·조회

이번 [입력 영수증 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-receipts-result.md)에서 합성 앱과 원자 저장하는 operation 영수증, 현재 권한의 읽기 조회, v1 이행·재시작·저장 실패 처리를 연결했다. 전체 **1,656개 시험·실패 0**, 코어 타입 검사·안쪽 계층 92파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 시험은 26개이고 최종 관련 시험은 120개다. P3-04는 partially_verified/in_progress이며 전체 완료 작업은 9개다. 다음은 명시 런타임 효과 대조 예약·정산, 이후 남은 단계 이어가기와 실제 로컬 Web driver다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-receipts-local-verification.json). 실제 모델/API 시험은 중단 상태다.

최종 Node 24.20.0 `npm run verify` exit 0, 153716.278625ms. 새 계약 5·driver 조회 16·저장 장애 3·실제 SIGKILL 2개를 검증했다. 원본 1,973파일과 이전 검증 체인은 별도 정적 기록에서 대조한다. 이번 버전의 실제 GUI/모델·비용 비교는 미실행이며 이전 비용 기록은 v0.33 구현의 관측으로 보존한다.

## v0.33 — P3-04 합성 컴퓨터 유즈 첫 단위

이번 [합성 컴퓨터 유즈 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-use-result.md)에서 관찰·입력·조건 확인과 영속 진행, 결과 증명·compact 원본 검사·강제 종료 복구를 연결했다. 전체 **1,630개 시험·실패 0**, 코어 타입 검사·안쪽 계층 90파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 시험은 94개이며 두 저장소의 동일 목표 4개 비용 관측도 통과했다. P3-04 local_contracts는 partially_verified, 전체 status는 in_progress다. 다음은 명시적 효과 대조와 남은 단계 이어가기이며 실제 로컬 Web driver와 선택 환경 검증은 그 뒤에 연결한다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-use-local-verification.json). 실제 모델/API 시험 중단과 이전 원본/검증 기록 보존을 유지한다.

최종 고정 Node 24.20.0 `npm run verify` exit 0, **1,630/1,630·실패 0**, 154884.600584ms. 신규 targeted 94/94 통과: 계약 8·driver 14·runner 24·compact/복원 16·원본/정산 증명 22·SIGKILL 복구 4·등록/검증 6개다. [호출 비용 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-use-cost-final.json)은 2개 backend × 묶음/개별 4실행이며, 같은 목표·근거·입력 2/저장 1을 유지하면서 도구 호출 3→2를 관측했다. 모델·실제 GUI·사내 서비스 0회. 실제 driver 성능·단계 재개/미확정 효과 대조는 미완료이며 전체 완료 작업 수 9개를 유지한다.

## v0.32 — P3-02 조회 효율과 동시 편집

2026-09-06. 이번 [조회 효율·동시 편집 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-query-control-result.md)에서 사건 metadata 조회·후보 페이지·저널 검증 재사용과 목표/제어 revision의 원자적 검사를 연결했다. 전체 1,536개 시험·코어 타입 검사·안쪽 계층 86파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 시험은 저장 조회 28·원자 제어 17·공개 조회 8개다. 브라우저 변경 관측 8개와 저장소 비용을 별도 기록했다. P3-02 local_contracts는 verified, 전체 status는 in_progress이며 다음 독립 로컬 단위는 P3-04 합성 컴퓨터 유즈 계약·runner다. 실제 모델과 운영 adapter 조건은 남는다.

[조회 효율·동시 편집 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-query-control-result.md) · [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-query-control-local-verification.json) · [브라우저 8개 관측](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-query-control-browser-verification.json) · [저장소 비용](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-query-control-read-cost.json). 최종 verify exit 0, 136301.29025ms. Warm journal의 parse/replay는 32/64→0이지만 본문 read/hash bytes는 그대로다. SQLite 새 조회는 작은 색인과 제한된 ID/metadata를 사용한다. 브라우저는 최종 frontend·최종 DB 이행 전 임시 서버였으며 최종 이행은 repository/HTTP 시험으로 검증했다. 모델/API·사내 서비스 0회, 임시 탭/서버 종료. 전체 완료 작업 9개를 유지한다.

## v0.31 — P3-02 로컬 Web 작업실

2026-09-06. 로컬 Web 작업실의 두 번째 단위를 검증했다. 전체 1,483개 시험·코어 타입 검사·안쪽 계층 85파일/위반 0·합성 4시나리오/22판정이 통과했고 새 시험은 제어기 24·UI 상태 21·HTTP 9·두 저장소 HTTP 통합 2개다. 실제 브라우저에서 접수/결과/질문·제어·CLI 연결·초점·읽는 위치·390/320px를 확인했다. P3-02 전체와 로컬 계약은 아직 진행 중/부분 검증이며 다음은 긴 이력 조회 I/O와 채널 간 목표/모드 동시 변경 경계다.

[학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-web-result.md) · [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-local-verification.json) · [브라우저 15개 관측](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-browser-verification.json) · [SSE 조회 비용](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-read-cost.json). 실제 모델/API·사내 서비스 0회, 임시 검수 탭/서버 종료. 완료 작업 수 9개를 유지하며 기존 기록과 원본을 보존한다.

## v0.30 — P3-02 공통 업무 조회와 CLI 첫 단위

2026-09-06. P3-02 첫 단위의 공통 업무 조회·CLI를 로컬 검증했다. 전체 1,427개 시험과 코어 타입 검사·안쪽 계층 85파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 39개는 서비스 28·CLI 7·표시 4개다. P3-02 전체는 진행 중이며 다음은 로컬 Web/재접속/제어 화면과 브라우저 검수다.

[학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-work-view-result.md) · [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-work-view-local-verification.json). 실제 외부 모델/API·사내 서비스 호출 0회. 원본/lock/이전 검증 기록을 보존했으며 P3-02 local_contracts는 partially_verified, 전체 작업은 in_progress, 완료 작업 수는 9개다. Web 서버·화면·SSE·브라우저 사용성은 이번 단위에서 검증하지 않았다.

## v0.29 — P2-06 로컬 정보 공개 계약

2026-09-06. 전체 1,388/1,388·실패 0, 코어 타입 검사·안쪽 계층 83파일/위반 0·합성 4시나리오/22판정 통과. 새 시험은 공개 서비스 51·실행 경계 38·배치 비교 5·workflow 복구 16개다. A/B/C×두 업무군×두 상태 저장소의 12개 합성 전송 계약 비교도 통과했다.

[학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-boundary-result.md) · [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-boundary-local-verification.json) · [비교 JSON](/Users/seunghanee/Documents/secumon/runtime/evidence/disclosure-final/report.json). 실제 외부 모델/API·사내 서비스 호출 0회. 원문 표면 108개 외부 거절과 내부 열람, 원문 외부 모델 진입 0회, 공개 facts와 파생 관계 보존을 확인했다. source/build hash는 비교 전후 같다. P2-06 local_contracts=verified, 전체 작업=in_progress, 완료 작업 9개다. 모델 품질/조직 정책/실제 adapter 조건은 남고 다음 로컬 단위는 P3-02다.



## v0.28 — P2-05 로컬 전체 실행 평가

2026-09-06. 전체 1,278/1,278·실패 0, 코어 타입 검사·안쪽 계층 80파일/위반 0·합성 4시나리오/22판정 통과. 독립 평가 32·재생 32·실행 통합 39·빌드 대응 7개를 추가했다. 고정 192개 새 실행의 계약 준수와 192개 기록 재생이 모두 통과했다. 목표 완료는 80/192, 완료 가능 기준 80/102이며 잘못된 완료 0이다.

[전체 실행 평가 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-evaluation-result.md) · [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-evaluation-local-verification.json) · [고정 비교](/Users/seunghanee/Documents/secumon/runtime/evidence/evaluation-final/report.json). 소스/빌드 pin과 원본 1,973개·dependency lock·과거 검증 기록을 확인했다. 당시 P2-05 local_contracts=verified, 작업 전체=in_progress, 전체 완료 작업 수 9개를 유지했다. 실제 모델/API·사내 연동을 호출하지 않았고 당시 다음 로컬 작업은 P2-06 정보 경계 비교였다.


2026-09-05 · 분석/설계 산출물 범위 · 아래 기본 표는 v0.2 검증 기록

이후 새 제품 runtime/을 구현하기 시작했다. 다음은 v0.27 당시 로컬 코드 검증의 이력이다. 해당 검증은 [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-budget-local-verification.json)과 [부모·자식 예산 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-budget-result.md)를 따른다. v0.27의 Node 24.20.0 전체 시험 1,168개·실패 0, 코어 별도 타입 검사·안쪽 계층 77파일/위반 0·합성 4시나리오/22판정이 통과했고 현재 소스 183개 hash를 보존했다. 당시 P2-05의 부모/자식 예산 실행 경계와 정산·재시작 단위를 검증했으며 고정 전체 실행 평가와 실제 모델/연동 조건은 남아 있었다. 기존 1,078개 모드/진전 검증 기록은 보존했다. 아래 버전별 표는 당시의 분석/설계 검증 이력이며 현재 전체 제품이나 실제 연동의 완료 판정이 아니다.

| 검증 | 상태 | 증거 |
|---|---|---|
| ZIP CRC | PASS | Python zipfile.testzip(), 실패 멤버 없음 |
| 원본/조각/병합본/추출본 SHA-256 | PASS | 1,973개 파일 비교, 불일치 0 |
| 추출 파일 | PASS | 일반 파일 1,967개. 외부 절대경로 링크 2개는 메타데이터로 보존 |
| 추가 중첩 압축 | PASS | 모든 추출 파일의 첫 512 bytes에서 주요 아카이브 signature 검사, 추가 발견 없음 |
| JSON 산출물 | PASS | JSON 파싱 성공 |
| 문서 로컬 링크/코드블록 | PASS | 로컬 대상·줄 번호 범위·블록 닫힘 확인 |
| 기존 제품 테스트/빌드/타입체크 | NOT RUN | 제품 구현 변경 없는 정적 분석. 환경/의존성 미설정. 일부 conftest는 PostgreSQL 초기화/정리 수행 |
| 실제 MCP/LLM/운영 E2E | NOT RUN | 이번 요청은 분석과 설계이며 운영 접속 검증을 수행하지 않음 |

검증은 Python 표준 라이브러리로 아카이브·해시·파일·문서 링크를 검사했다. 상세 항목과 계수는 `verification-results.json`을 참조한다. 원본 해시는 이번 로컬 복원 일관성의 증거이며 송신자 신원이나 원본의 출처를 인증하는 서명은 아니다.

정적 Tool 선언 160개는 실제 registry로 검증한 capability 수가 아니다. 도구 목록 생성 과정의 AST 파싱 성공도 기능 테스트 통과를 뜻하지 않는다.

현재 소스의 동작·성능·완료율·정보 공개 통제는 P0 이후 격리된 합성 평가와 실제 계약 검증에서 확인해야 한다. 설계 v0.2는 사용자 추가 방향(범용성, 모든 장기 업무, MCP 재사용, skill/컨텍스트 재검토)을 반영했다.

## v0.3 수정 범위

사람 대화 역할과 TypeScript 중심 언어 전환 권고를 설계·플랜·학습·결정 기록에 반영하고 상세 문서 06/07을 추가했다. 원본 제품 파일은 해시 명세와 비교하며, 문서의 로컬 링크·코드블록 닫힘·JSON 파싱을 재확인한다. 이 검사는 Mermaid 시각 렌더링이나 새 TS 런타임의 기능 검증이 아니다. 작업 폴더는 Git 저장소가 아니므로 소스 보존은 git diff 대신 추출 해시로 확인한다.

v0.3 재검증: 원본·조각·병합본·소스 1,973개 파일의 hash/크기가 명세와 일치하고 추출 일반 파일 1,967개를 확인했다. Markdown 11개·JSON 5개를 검사했으며 로컬 링크·줄 번호·코드블록 닫힘·JSON 파싱 오류가 없었다. 정의 정합성은 문서를 읽어 확인했으며 제품 동작 테스트로 간주하지 않는다. 상세 계수와 미실행 항목은 [v0.3 검증 기록](/Users/seunghanee/Documents/secumon/design/revision-v03-verification.json)에 저장했다.

## v0.4 수정과 확인 범위

Python 없는 신규 제품을 비교 기준으로 추가하고, 기존 코드 유지 의무·첫 시제품의 Python 호출 의무를 제거했다. TS 통일/선택 Rust/Python 유지/Rust 중심 백엔드의 비용 비교, 실행 코드 외 규칙·계약·시험 재사용, 제품 실행과 외부 MCP/빌드 의존성의 구분을 반영했다. 기존 시스템 전환은 독립 신규 도입과 구분했다.

원본·조각·병합본·소스 1,973개 파일의 hash/크기 일치를 확인했다. 문서 검증은 로컬 링크·줄 번호·코드블록 닫힘·JSON 파싱이며, 상세 계수는 [v0.4 검증 기록](/Users/seunghanee/Documents/secumon/design/revision-v04-verification.json)에 저장한다. 문서 검사에 호스트 Python을 사용한 것은 새 제품의 언어 선택이나 실행 의존성 시험이 아니다. Python 없는 런타임, 기능·성능·총비용은 아직 구현·측정하지 않았다.

## v0.5 코어·호출·방법론 설계

기존에 분산되어 있던 설계 원칙을 문서 08/09로 연결했다. 보강 범위는 아래와 같다. 이는 문서상 포함 여부의 검토이며 실행 검증 통과를 뜻하지 않는다.

| 사용자 요구 | 설계 위치 |
|---|---|
| goal/state, planner, plan validator, task graph | 08: 책임·입출력, 계획 버전·부분 재계획, 구조/의미 검증 |
| hypotheses, evidence | 08: 질문·관찰·가정·경쟁 가설·반증·판별 질문과 근거 수락 |
| executor, state update, continue/replan/complete | 08: 배정·실행·커밋·제어 결정·완료 검증·대기/취소 |
| compact | 08: 정본 저장·스냅샷·패킷 검증·교체·실패 복구, 가설/반증 보존 |
| tool 호출 효율과 호출 이력 | 09: registry·broker·호출 장부·신선도·재사용·batch/동시성·비용 |
| memory 호출 방법 | 09: 현재 상태·근거 ID·과거 호출·경험 검색의 구분과 쓰기/권한 정책 |
| skill 호출과 업무별 방법론·배치 | 09: 선택 로딩·버전/제약 복원, 방법론 조합·역할/권한/평가 배치 |

전체 설계·플랜·학습·결정·README도 같은 범위로 갱신했다. 정적 문서/JSON/소스 보존 확인 결과는 [v0.5 검증 기록](/Users/seunghanee/Documents/secumon/design/revision-v05-verification.json)에 남긴다. 코어 구현, LLM 품질, 실제 도구·MCP 연동, 메모리 회수율, compact 의미 보존, 호출 효율과 업무 배치의 실제 효과는 아직 미검증이다.

## v0.6 채팅·채널·답변 전달 설계

문서 10을 추가하고 02/03/07/08/README/DECISIONS를 연결했다. CLI/Web/Knox의 접수·결과 중심 표시, 공개 사건 투영, 응답 정책, 전달 장부, 다중 업무·신원·취소, 분석 완료와 답변 전달의 구분을 검토했다. 실제 Knox MCP 계약은 제공되지 않았으며 조회·발송하지 않았다.

합성 문서 비교 예시에서 세 채널 × 네 상태의 표시, 주요 변화 토글과 Web의 진행/비교표 펼침을 브라우저로 확인했다. 폭 736/360/320 및 light/dark의 72개 조합에서 가로 넘침을 검사했다. 이는 로컬 UI 렌더링 검사이며 상태 기계·전송·복구·사용자 가독성 연구를 대신하지 않는다. Tweak 바인딩은 검사 대역을 사용했으며 실제 호스트 UI 연동은 미검증이다. 화면 읽기 도구·실제 키보드 사용성·전체 접근성 적합성은 별도 검증 대상이다.

원본 해시·Markdown 링크·코드블록 닫힘·JSON 파싱 결과와 미실행 항목은 [v0.6 검증 기록](/Users/seunghanee/Documents/secumon/design/revision-v06-verification.json)에 저장한다. 제품 build/test/lint/typecheck, LLM 평가, 실제 MCP/Knox 통합, 전달 신뢰성 시험은 실행하지 않았다. 문서 검사/미리보기에 사용한 호스트 Python은 새 제품 실행 의존성 선택과 무관하다.

## v0.7 실행 모드와 지속성 구분

문서 11에 자동/빠르게/깊게, 지속 실행·모델 호출 자원·예산·알림의 구분, 경량 실행과 승격/변경 계약을 추가했다. 03/08/09/10/README/DECISIONS/WORKLOG를 연결했다. 사용자 질문을 특정 모드의 최종 채택으로 기록하지 않았으며, 단순 업무 과잉 처리와 복잡한 업무 검토 누락을 함께 평가하도록 정리했다.

원본 해시와 문서 링크·코드블록·JSON 파싱의 정적 확인 결과는 [v0.7 검증 기록](/Users/seunghanee/Documents/secumon/design/revision-v07-verification.json)에 저장한다. 제품 build/test/lint/typecheck, 모드 라우팅·전환·예산 상한 동작, LLM 평가, 실제 성능은 미검증이다. 기존 v0.6 대화 시안은 수정하지 않았으며 새 모드 선택 UI를 구현한 것으로 보고하지 않는다.

## v0.8 컴퓨터 유즈 도구 재설계

문서 12를 추가하고 03/08/09/11/README/DECISIONS/WORKLOG에 연결했다. browser_tool.py의 세션·대상 ref·단일 행동 결과·wait·snapshot·capture·screenshot hash diff를 정적으로 확인해 재사용/보강 후보를 구분했다. 파일의 계약을 확인한 것이며 실제 병목이나 전체 시스템의 기능 부재를 증명한 것이 아니다.

목적별 관찰, 행동+필요 결과 확인, 짧은 조건부 묶음, deadline 대기, 대상/초점 재검증, 세션 소유권, 부분 실행/unknown 효과, 기억·compact·모드·원문 경계를 설계에 포함했다. 정적 링크·JSON·코드블록·원본 해시 결과는 [v0.8 검증 기록](/Users/seunghanee/Documents/secumon/design/revision-v08-verification.json)에 저장한다.

제품 build/test/lint/typecheck, 브라우저/OS 조작, 로그인, 실제 MCP 통합, UI 성공률·지연·이미지 비용·호출 절감·정보 경계 E2E 시험은 실행하지 않았다. 기존 v0.6 대화 시안은 그대로 유지했다.

## v0.9 도구 카탈로그와 추가 범위

13/14를 추가하고 README/01/02/03/09/DECISIONS/WORKLOG에 연결했다. 기존 registry/search/discovery의 정적 동작과 테스트를 포함한 목록의 의미를 구분했다. 원본 정적 선언 160개를 테스트 40개와 비테스트 후보 120개(114개 이름, 복수 선언 이름 6개 그룹)로 분류한 tool-catalog-review.json을 추가했다. 경로 분류·직접 선언 AST 메타데이터만 사용했으며 실제 등록·실행 효과·재사용 적합성은 판정하지 않았다.

문서 링크·코드블록·JSON, 후보의 원본 대응·집계, 원본/추출 파일 hash와 기존 v0.6 시안 보존 확인은 [v0.9 검증 기록](/Users/seunghanee/Documents/secumon/design/revision-v09-verification.json)에 저장한다. product build/test/lint/typecheck, 실제 tool registry/MCP·모델 호출·도구 선택률/성능·기억 삭제 전파·재생/복구 시험은 실행하지 않았다. 문서·정적 목록 검사 결과는 설계의 구현 완료나 런타임 안전성 증명으로 확대하지 않는다.

## v0.10 컨텍스트 수명

15를 추가하고 03/08/13/README/DECISIONS/WORKLOG에 연결했다. 미사용 기간과 현재 의존성, 규칙 기반 정리/참조화와 compact, 필수 제약/반증/의무 보호, 정확한 재로딩, 저장/정책 revision·tool-call 연결·실제 전송 입력 검증, 재로딩 진동과 예산을 구체화했다.

원본/추출 파일과 기존 시안 보존, 문서 링크/코드블록/JSON 검사 결과는 [v0.10 검증 기록](/Users/seunghanee/Documents/secumon/design/revision-v10-verification.json)에 저장한다. 제품 코드/테스트·실제 컨텍스트 정리·모델 입력/usage·명세 재로딩·장기 회수율·복구/성능 시험은 실행하지 않았다.

## v0.11 저장소와 복구

16을 추가하고 README/02/03/08/DECISIONS/WORKLOG에 연결했다. 논리 저장 역할/물리 배치, 개인/공유 기억, 상태/사건 커밋과 외부 실행 엔진 소유권, 파일-DB 장애, 검색/권한/수집 cursor, 큐/lease와 외부 효과, 작업 공간, 백업/복원·정정/삭제·버전 이행을 설계했다.

사용자의 PostgreSQL 독립성 요구를 16/README/02/03/06/DECISIONS에 명시했다. 기존 StatePort/adapter와 공용 테스트 설정을 정적으로 확인하고, 업무 의미의 포트·바깥 adapter 주입·원자적 저장 경계·필수 보장/선택 capability·두 영속 구현 적합성 시험을 구체화했다. 06의 기존 언어 그림도 특정 DB 대신 저장 포트를 표시한다. 해당 그림의 렌더링은 별도 실행하지 않았다.

원본/추출 파일과 기존 시안 보존, Markdown 링크/코드블록/JSON 결과는 [v0.11 검증 기록](/Users/seunghanee/Documents/secumon/design/revision-v11-verification.json)에 저장한다. DB/파일/검색 저장소 구축·접속, SQL/제품 테스트, 동시성/장애 주입·실제 복원·RPO/RTO·권한/삭제·외부 효과 복구 검증은 실행하지 않았다.

## v0.12 전체 설계와 구현 순서 통합

03을 구현 순서의 기준으로 다시 정리하고, 22개 요구와 31개 작업의 선행 조건·산출물·통과 기준을 implementation-backlog.json에 저장했다. README/02/04/08/10/12/14/16/DECISIONS/WORKLOG를 연결하고 P3의 단일 에이전트 연동, P4의 협업/A2A/상시 임무, 실제 자료 전 정보 경계를 정리했다. 이전 03은 history에 보존했다.

정적 검사 범위는 원본/추출 hash, 기존 시안 보존, 문서/JSON/링크, 작업 ID·선행 조건·비순환 DAG·요구 매핑과 문서 대응, 미착수 상태, 단계 참조의 일관성이다. 결과는 [v0.12 검증 기록](/Users/seunghanee/Documents/secumon/design/revision-v12-verification.json)에 저장한다. 제품 구현/build/test/lint/typecheck·실제 모델/MCP/DB/Knox·컴퓨터 유즈·저장소 교체·복구/성능 시험은 실행하지 않았다.

## 모델 연결 사전 실험 — v0.12 이후

[독립 TS 실험](/Users/seunghanee/Documents/secumon/experiments/model-gateway-smoke/README.md)에서 타입 검사와 로컬 합성 검사 8개를 수행했다. 실제 `gpt-4o-mini` 요청은 첫 호출에서 HTTP 401로 실패했으며 모델 응답·도구 호출·구조화 출력 검증은 막혔다. 추가 API 요청/다른 모델 호출은 하지 않았다. 사내 모델/MCP/DB/Knox·롱 호라이즌 코어·저장소/compact/복구는 미시험이다. 아래와 별개로 과거 v0.12 문서 검증의 “모델 미실행”은 해당 시점의 기록이다.

[실험 검증 결과](/Users/seunghanee/Documents/secumon/experiments/model-gateway-smoke/verification.json)에 최종 명령/exit code와 원본 보존·문서 연결 확인을 저장한다.


## C05 collection 일반 입구 — 2026-09-08 확정

로컬 신규 183/183·관련 519/519, NAS Linux 신규 183/183·관련 519/519·전체 3,691/3,691 통과. native 세션 51572 actual exit 0과 8단계·9개 파일 회수·SSH 종료를 확인했다. [proof](../runtime/evidence/C05-mcp-collections-linux-nas-20260908/verification.json)와 [게시 검토](../runtime/evidence/C05-mcp-collections-final-publication-review.json)는 같은 source/build를 가리킨다. CLI2·HTTP3 및 문맥/조회 교정을 인수했고 실제 모델/API·사내·Windows·PostgreSQL 및 collection post-send custody 후속은 완료 범위가 아니다.

## C05 collection custody A/B local — 2026-09-07T18:46:58.973Z

Same source b294fd811c503402f54f65ecb5bc9d2a3facae9655368fd77e3c783245c5bc2d: build-b4 exit0, new-b2 54/54 exit0, related-b1 113/113 exit0, core-b1/architecture-b1 exit0. Actual root handles 27875/77061/35050/67246/64827 terminal. [Evidence](../runtime/evidence/C05-mcp-collections-custody-AB-local-result1.json). C crash/profile/general CLI/HTTP and final integrated/Linux remain; no real model/API or chapter/goal completion claim.
