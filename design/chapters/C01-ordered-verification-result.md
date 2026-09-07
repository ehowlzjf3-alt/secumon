# C01 순차 검증·수정 기록

2026-09-08 · checkpoint368. **선택한 macOS 로컬 범위 80/80 통과, 동시8CLI 최초 실행 20회 통과**. 최종 build5와 구조 검사188개/위반0이다. 담당 격리·setup/clone·backend 고정·호스트 등록·복원 재등록에 실제 관측한 SQLite 보조 파일 삭제 경합 회귀를 더했다. 실제 모델·DB 서버·사내 연결·원격 운영체제는 호출하지 않았다. [최종 증거](../../runtime/evidence/C01-ordered-checkpoint.json) · [80개 원로그](../../runtime/evidence/C01-ordered-target4.log).

이번 제품 교정은 SQLite 기본 옵션, 원 저장소를 검사한 뒤 초기화 기록을 게시하는 순서, 최초 등록 중 잠깐 생기는 pending 재조회, 삭제 중인 SQLite 보조 파일 경로 재조회다. 기존 소유·권한·정본 식별 검사는 유지했다. 시험의 복사 권한을 고쳤고 실제 unlink 관측을 사용하는 회귀3종을 추가했다. 아래 실패 원로그는 원인과 수정 근거로 보존한다.

첫 실행은 기존 최종 빌드와 현재 소스 지문이 같은지 확인한 뒤 수행했다. 69개 중 36통과·33실패, 취소/건너뜀0, 프로세스 exit1이다. [원로그](../../runtime/evidence/C01-ordered-target1.log) · [진행 증거](../../runtime/evidence/C01-ordered-checkpoint.json).

공통 SQLite 열기 함수가 옵션 생략 시 `new DatabaseSync(path, undefined)`를 호출해 `ERR_INVALID_ARG_TYPE`으로 실패했다. 함수의 기본 옵션을 빈 객체로 고쳤다. 등록 시험3개는 복사본의 private 권한이 보존되지 않아 ID 판정 전에 실패했다. 시험 전용 복사 helper에서 원본 권한·원문을 보존하고 양쪽 전체 내용을 대조하도록 고쳤으며 기존 거절 기준은 유지했다.

교정 후 build1(session52925)은 exit0, 같은6파일의 target2(session32984)는 **69개 중63통과·6실패**, 취소/건너뜀0, exit1이다. [두 번째 원로그](../../runtime/evidence/C01-ordered-target2.log). 원본/복사본 ID 검사와 로컬 백업·복원 재등록 9개는 통과했다. 남은5개는 잘못된 원 저장소를 거절하기 전에 빈 runtime-leases 및 storage-selection을 게시하는 순서 문제다. 기존 읽기 검사와 pending/maintenance 확인을 선행하고 실제 bind는 lease 안에서 다시 검사하도록 수정 중이다. 나머지1개는 동시8CLI의 정상 등록 게시 중 pending을 즉시 거절한 경합이며 유한한 재조회로 교정 중이다. 실패 원로그와 준비한 시험은 보존한다.

세 번째 실행은 **68/69 통과**, 코어 타입 검사 exit0·구조 검사188개/위반0이다. 남은 동시8CLI 시험의 오류가 `agent_storage_path_unsafe`로 바뀌어 같은 시험만 진단했다. 초기10회와 다음2회는 통과했지만 13번째에서 `memory.sqlite-journal`, regular=true, symbolicLink=false, links=0, mode=0600, owned=true를 포착했다. [실제 경합 원로그](../../runtime/evidence/C01-concurrent-diagnostic-13.log). 파일 조회 중 SQLite가 보조 파일을 unlink해 경로 관측과 stat 수집이 겹친 경우다.

알려진 보조 파일 이름만, private·동일 소유·일반 파일인 nlink=0 관측에 대해 경로를 최대3회 추가 조회하도록 수정했다. 부재면 기존 ENOENT 처리로 이어가고 새 파일이 나타나면 기존 strict 검사를 통과해야 한다. 정본 DB, 링크2 이상, 공개 권한, symlink·다른 소유자의 거절은 유지한다. 실제 unlink 뒤 열린 fd의 stat을 사용하는 결정적 회귀3종(삭제 후 정상 조회·위험한 교체 거절·계속 삭제 상태면 유한 거절) 모두 통과했다. 수정 후 관련7파일80개와 별도 동시 최초 실행20회도 통과했다. 수정 전 진단 반복을 최종 인수로 계산하지 않는다.

이번 결과로 C01의 전체 플랫폼 인수를 통과 처리하지 않는다. SQLite 읽기 검사는 owner/schema를 쓰지 않지만 기존 WAL 조정용 보조 파일 가능성까지 없애는 약속은 아니다. 현재 Linux/native Windows와 마지막 통합 회귀는 뒤 단계에 남는다. C02는 기존 session/compact 시험과 준비한 임시 등록표를 재사용한다.
