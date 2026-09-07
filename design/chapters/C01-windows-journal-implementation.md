# Windows file-journal 연결

2026-09-08 현재 Windows file-journal의 실제 읽기·기록 게시를 native 파일 API에 연결했다. 제품 구현을 저장한 상태이며, 이 작업에서 시험·빌드·Windows 실행은 하지 않았다. 공통 native ABI 3과 스트림 helper는 다른 담당의 통합 범위다. 그 모듈과 바이너리를 포함한 최종 빌드 및 실제 Windows 관측은 아직 별도 검증 대상이다.

`FileJournalStateRepository`는 Windows에서 새 `WindowsJournalFiles`를 사용한다. 디렉터리는 native handle을 보유한 mutation scope로 열고 생성하며, 목록도 native names API로 읽는다. 일반 Node의 mode 비트·UID·inode·hardlink를 Windows 접근 제어의 근거로 쓰지 않는다. 원 기록은 native ACL/reparse/link 검사와 스트림 reader를 거쳐 읽고, 앞뒤 파일 identity·changeToken·크기와 캐시에 저장한 identity를 대조한다. 기존 checksum, previousHash, revision 연속성, 원 명령 영수증 및 `validateCommit`·`validateStateTransition` 검사도 그대로 적용한다.

기록은 한 파일에 이어 쓰는 형식이 아니다. revision마다 별도 immutable JSON 파일을 만든다. Windows 스트림 writer가 최대 1MiB 단위로 후보에 append한 뒤 `prepare()`로 실제 flush와 검사를 마친다. 이 시점에 기존 `candidate_synced` 관측 hook을 호출한다. 그 뒤 현재 store/디렉터리를 다시 확인하고 같은 후보 handle을 최종 revision 이름으로 no-replace 게시한다. 이름 선점이 실패하면 원 영수증을 다시 읽어 duplicate·idempotency conflict·revision conflict를 판단한다. 기존 정본을 교체하거나 새 revision으로 자동 재시도하지 않는다. 이 CAS 방식에는 별도의 mutable append lock이나 파일 교체가 필요하지 않다. native 후보 handle과 디렉터리의 공유 모드·소유권 검사를 재사용한다.

기본 기록 상한 64MiB와 캐시 상한 32MiB는 유지한다. legacy native publish의 4MiB 제한으로 기록을 잘라 내지 않는다. ABI 3 스트림의 파일 상한은 1GiB이고, Windows에서 이보다 큰 명시적 maxRecordBytes 설정은 디렉터리 생성 전에 거절한다. 읽기 결과를 반환하는 기존 repository API는 전체 기록 Buffer를 필요로 하므로 스트리밍 전송이 프로세스 메모리 사용을 일정하게 만든다는 뜻은 아니다.

Windows의 내구성 정책은 `process-crash`다. 후보 내용의 FlushFileBuffers와 게시 후 원문 확인은 수행하지만 디렉터리 namespace의 전원 장애 내구성은 보장하지 않는다. `durability()`는 이 정책과 namespace barrier 미지원 여부를 반환한다. 성공 후 `published` hook은 실제로 호출하며, `directory_synced` hook은 Windows에서 호출하지 않는다. 원 POSIX 파일 생성·fsync·link·unlink 경로와 세 단계 관측은 그대로 남아 있다. Windows read fence의 `completeMetadataPublication`은 현재 native handle 검사를 수행하고 directorySynced를 참으로 보고하지 않는다.

게시 이후 오류 또는 게시 결과가 불명확한 오류는 원 FileMutationFault의 publication 상태와 원인을 보존한 `journal_commit_unknown`으로 전달한다. 다음 열기에서는 원 revision과 command ID/digest를 읽어 실제 결과를 판단해야 한다. 초기 format 게시의 같은 경계는 `journal_initialization_unknown`이다. unpublished 후보 cleanup은 native가 자기 handle로만 수행하며, 모호한 게시 결과를 없던 기록으로 만들지 않는다. header 초기화 중 남은 원 POSIX UUID.pending 및 Windows .secumon-init-UUID.pending은 식별된 이름만 허용한다. format이 없으면 완전한 header/owner 후보인지 확인하며, 부분 기록·다른 owner를 성공으로 취급하지 않는다.

`journal-ownership.ts`의 독립 preflight도 Windows에서는 native 디렉터리 목록과 읽기를 사용한다. 읽은 디렉터리 reference는 종료 시 명시적으로 닫는다. 초기화 중 후보가 아직 exclusive handle로 열려 있는 공유 위반은 최대 20회·회당 5ms 범위의 기존 초기화 재검사에 포함하고, 계속 실패하면 원 오류를 보존한다. repository close와 생성 실패도 보유 디렉터리 reference를 닫고 cleanup 오류를 숨기지 않는다. close와 이미 진행 중인 commit 전체를 drain하는 새로운 보장은 추가하지 않았다. 관측 hook에서 close가 일어나면 이후 store 검사에서 차단하며, 이미 게시한 기록은 불명확한 완료로 남길 수 있다.

후속 검증은 기본 64MiB 기록 중 4MiB 초과 원문, 빈/기존 store 열기, 같은 revision의 별도 프로세스 선점, 각 candidate/게시 단계의 실제 종료·재개, 부분/모호한 후보, 권한/링크/파일 교체, read 도중 변이, publication 이후 guard/close 실패의 원인 보존을 포함한다. Windows native 목록 상한 65,536개는 디렉터리 전체 discovery의 현재 상한이다. 현재 구조는 모든 work 및 revision 파일 이름을 읽으므로 이 상한을 넘는 큰 저장소를 지원하려면 별도 목록 paging이 필요하다. 이번 연결에서 이 한도를 숨기거나 전체 scan을 무제한으로 바꾸지 않았다. POSIX 결과와 Windows 실제 결과는 각각 후속 검증해야 하며, 구현만으로 그 결과를 통과 처리하지 않는다.
