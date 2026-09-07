# C01 작업공간 안정 읽기와 목록 중복 읽기 제거

구현 상태: 이 계획은 완료됐다. [구현·측정 결과](/Users/seunghanee/Documents/secumon/design/chapters/C01-workspace-stable-read-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-workspace-read-verification.json). 아래는 구현 전에 작성한 기준이며 이후 구현을 다시 요청하는 항목이 아니다.

2026-09-07 · 후속 구현 계획 · 이 문서 외 제품·시험·빌드 변경 및 실행 없음

**`FileWorkspaceStore`의 read/list를 한 번의 안정 읽기와 레코드 검증 경로로 합친다.** 현재 목록은 파일마다 경로를 알아내려고 읽고 파싱한 뒤 `#read`에서 다시 읽고 파싱한다. 이를 `HostMetadataFiles.readStableRegularFile`로 연결하면서 동일 레코드의 파일명·내용·업무 식별자를 한 번에 검증한다. 변경되지 않은 파일의 중복 읽기 제거가 목표이며 실행 시간이나 전체 I/O가 개선됐다고 미리 주장하지 않는다.

[작업공간 파일 경계 계획](C01-workspace-file-boundary-plan.md)에 남긴 읽기 후속 단위다. 완료된 directory/lock/sync 통합 검증의 결과와 구분한다. 기존 하드링크 호환은 이번에 **명시적으로 유지**하며, 파일 생성·게시·삭제·자동 복구·Windows native 지원까지 연결했다는 뜻이 아니다.

## 현재 코드에서 보존할 계약

기준은 [`file-workspaces.ts`의 `#read/#list`](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-workspaces.ts:109)와 [`workspace-contracts.ts`](/Users/seunghanee/Documents/secumon/runtime/src/application/workspace-contracts.ts:7)다. 아래 행 번호는 작성 시점 기준이다. 이 계획은 선행 소스의 검증을 확정한 뒤 실행한다.

| 구분 | 현재 동작 | 다음 구현 |
|---|---|---|
| 직렬화 한도 | `S = ceil(maxFileBytes × 4 / 3) + 65536`. base64와 JSON metadata를 포함한 파일 전체 한도. 기본 raw 한도 1,048,576 bytes | 동일 S를 공통 읽기의 `maximum`으로 전달. S가 raw 한도를 대체하지 않음 |
| 원문 한도·용량 | 디코딩한 bytes에 `maxFileBytes`를 다시 적용. stage는 파일 개수 128, attempt 합계 16,777,216 bytes 기본 한도도 검사 | 읽기 통합 때문에 개수·합계·기본값을 변경하지 않음 |
| 파일 안전성 | no-follow/nonblocking open, 일반 파일, 현재 UID, group/other 접근 금지 | 공통 `access:'private'` 사용. 보관 중인 files 디렉터리 참조를 사용하고 참조가 없으면 내부 오류로 실패 |
| 하드링크 | `#read`와 `#list` 모두 nlink 상한·외부 링크 위치를 검사하지 않음 | 저장소 내부의 고정 `allowLinkedFile: () => true` 정책으로 기존 허용 유지. 모델/도구 입력이나 사용자 옵션으로 제공하지 않음. 일반 파일·UID·private 검사와 읽기 안정성 검사는 그대로 적용 |
| JSON·schema | UTF-8 `Buffer.toString` → JSON.parse → strict `recordSchema`. 파일 속성은 `WorkspaceFileSchema` 검증 | 같은 파싱·schema 사용. fatal UTF-8, 새 정규화·추가 필드 조건을 넣지 않음 |
| JSON checksum | checksum을 제외한 `{schemaVersion,file,contentBase64}`를 JSON.stringify한 SHA-256 비교 | 동일 직렬화/해시 규칙 유지. 저장된 형식을 다시 쓰지 않음 |
| base64·원문 | decode 후 재encode한 문자열과 원래 base64가 같아야 함. byteLength와 원문 SHA-256도 일치 | 단순 decode 성공으로 축소하지 않음. 빈 원문도 현 계약대로 검증 |
| 업무 식별 | file.workId·attemptId·path가 요청한 scope/path와 일치해야 함 | read는 요청 path와 비교. list는 검증한 동일 record의 path와 실제 파일명 hash를 연결하고 work/attempt를 비교 |
| 실제 파일명 | `${sha256(path)}.json`; 목록은 정확한 64자리 소문자 hex 이름만 허용 | 논리 경로를 OS 하위 경로로 바꾸지 않음. list의 파일명↔path hash 검사 유지 |
| pending·목록 | 목록 순회 중 `.pending` 이름은 `workspace_incomplete_write`, 그 밖의 잘못된 이름은 `workspace_layout_invalid`. 정렬된 논리 path로 반환 | 그대로 유지. `stage/removeAttempt`도 내부 list를 통해 같은 거절을 유지. public read에는 원래 없는 전체 디렉터리 pending 검색을 추가하지 않음 |
| 재호출·정리 | 동일 stage는 같은 파일 속성으로 합류하고 내용/속성이 다르면 충돌. removeAttempt는 정확한 manifest와 비교 후 삭제 | 읽기 결과 형식과 이 판정들을 유지. 잠금·sync·cleanupError 정책을 다시 설계하지 않음 |

하드링크 허용은 링크가 안전하다는 새로운 판정이 아니다. 기존 파일과의 호환 정책이다. 외부 하드링크 금지, 정상 pending 쌍만 허용, 링크 개수 제한 같은 강화는 별도 변경으로 남긴다. 공통 경계는 반환 시점까지 같은 파일명·객체·메타데이터와 크기가 안정적인지 검사하므로, 기존에 없던 교체/변경 검출은 아래처럼 명시한다.

## 최소 구현 흐름

`#read`와 `#list`가 함께 쓰는 작은 내부 함수에 **files 참조, 단일 저장 파일명, workId, attemptId, 호출 종류(read/list), 선택 요청 path**를 전달한다. 호출 종류는 오류 호환을 위한 내부 값이며 공개 API에 추가하지 않는다.

1. 보관한 files 참조로 `readStableRegularFile`을 호출한다. 공통 함수 자체의 최대 두 번 읽기 시도를 사용하고 추가 retry 루프를 두지 않는다.
2. 안정적으로 반환된 bytes를 한 번 JSON.parse/schema 검사한다.
3. list에서는 이 record의 path를 해시하여 실제 파일명과 먼저 비교한다. 현재 목록의 파일명 불일치 거절을 유지한다.
4. 동일 record의 checksum, 정규 base64, byteLength, 원문 SHA-256, work/attempt/요청 path, raw 한도를 검증하고 `{file, bytes}`를 반환한다.
5. `#read`는 기존 반환 형태를 사용한다. `#list`는 readdir 한 번과 기존 이름 검사를 유지하면서 각 파일에 이 함수를 한 번 호출해 file만 모은다. 검증을 끝낸 record를 다시 파일에서 읽거나 다시 파싱하지 않는다.

S는 내부에서 계산한 한도이지만, 현재 options 검사는 각 값의 양의 safe integer만 확인한다. 매우 큰 설정에서 S가 공통 버퍼의 허용 범위를 넘을 수 있다. 이를 파일 손상/부재로 숨기거나 기본 옵션에 임의의 새 작은 상한을 넣지 않는다. 연결 시 공통 `invalid_request`를 내부 한도/설정 문제로 드러내고, 실제 지원 범위를 바꾸는 설정 정책은 별도 명시한다.

## 오류 매핑과 명시할 변화

현재 디렉터리용 `#boundaryFailure`를 파일 오류에 그대로 적용하면 파일 거절이 `workspace_directory_unsafe`로 잘못 표시된다. 읽기 전용 호환 매핑을 둔다. 디렉터리 단계 오류는 기존 디렉터리 매핑으로 전달한다.

| 상황 | 현재 read | 현재 list | 다음 의미 |
|---|---|---|---|
| 첫 파일 open의 ENOENT | `workspace_file_unavailable` | `workspace_file_unsafe` | 각각 유지. 목록에 보였던 파일이 사라져도 조용히 건너뛰지 않음 |
| 첫 open의 EACCES/ELOOP 등 | `workspace_file_unsafe` | `workspace_file_unsafe` | 코드 유지, 가능한 원 cause 보존 |
| 일반 파일·UID·private 거절 | `workspace_file_unsafe` | `workspace_file_unsafe` | 유지 |
| 직렬화 S 초과 | `workspace_file_too_large` | 초기 검사에서 `workspace_file_unsafe` | 호출 종류에 따라 기존 차이 유지 |
| 원문 raw 한도 초과 | `workspace_file_too_large` | 최종 #read에서 같은 코드 | 유지 |
| JSON/schema/checksum/base64/길이/원문 hash 실패 | `workspace_file_integrity_failure` | 같은 코드 | 유지 |
| 파일명 hash 또는 work/attempt/path 불일치 | `workspace_file_identity_mismatch` | 같은 코드 | 유지 |
| 안정 읽기 두 번 모두 변경됨 | 기존에는 포괄적 전후 객체 검사가 없음; 길이 불일치만 integrity 오류 | 두 독립 읽기 사이 변화에 따라 결과가 달라질 수 있음 | 파일 단계 `changed`는 **`workspace_file_changed`**로 제안. 원 경계 오류를 cause로 보관하고 성공·부재로 바꾸지 않음 |
| open 이후 named 파일 소실 | 기존 read는 열린 fd의 데이터를 반환할 수도 있음 | 두 번째 open 결과에 좌우됨 | `operation:'read'`의 missing도 파일 변경으로 거절. 첫 open 부재와 구분 |
| fstat/read/close 등의 I/O 실패 | 원 오류가 전달됨 | 첫 fstat/close는 원 오류지만, 첫 readFileSync는 parse와 같은 catch에 들어가 integrity로 바뀜 | **실제 파일 I/O는 read/list 모두 원 cause 전달**로 제안. list의 첫 read I/O를 데이터 손상으로 오표시하던 부분은 명시적 변경. 정상 파싱 실패는 계속 integrity |
| files 디렉터리 자체 교체·권한 변경 | 바깥 fence에서 검출 | 바깥 fence에서 검출 | 공통 읽기 도중 검출한 `operation:'directory'`도 기존 directory 오류. 파일 변경 코드로 뭉개지 않음 |

`unsupported_platform`과 발급되지 않은 참조/잘못된 내부 요청은 기존 미지원·내부 경계 실패를 유지한다. 주작업 오류 뒤 lock 해제도 실패하면 기존 이중 실패 표현의 `code`, `cause`, `cleanupError`를 유지한다. 새 파일 변경 오류가 자동 retry/복구를 허가하는 신호가 되지는 않는다.

## 목록 정합성과 계측의 범위

공통 읽기는 **파일 하나를 읽는 동안의 안정성**을 검사한다. list의 readdir와 여러 파일 읽기 전체가 한 시점의 snapshot이 되는 것은 아니다. 정상 `FileWorkspaceStore` 호출끼리는 같은 attempt 잠금으로 조정되지만, 이를 따르지 않는 직접 파일 변경·다른 하드링크 쓰기·검사 사이 경로 교체까지 원자적으로 막지는 못한다. 목록에 없던 파일이 열거 후 추가되면 이번 결과에 포함되지 않을 수 있다. 이 단위에 디렉터리 snapshot/version, 재열거 루프, manifest 트랜잭션을 추가하지 않는다.

반환된 WorkspaceFile은 체크포인트 영수증이나 artifact/state commit 완료가 아니다. list로 얻은 manifest는 기존 removeAttempt에서 다시 비교하며, 여러 파일 삭제의 원자성도 새로 주장하지 않는다.

| 같은 안정 fixture에서 측정할 항목 | 변경 전 | 변경 후 확인 목표와 주의 |
|---|---|---|
| list의 파일 open | 파일당 2회 | 안정 성공 시 1회. 공통 재시도 시 2회까지 별도 표시 |
| 전달된 직렬화 bytes | 파일당 약 2Sᵢ | 안정 성공 시 Sᵢ. Sᵢ는 실제 파일 길이이며 설정 상한 S와 구분. 버린 재시도의 bytes도 포함 |
| record JSON.parse/schema 진입 | 파일당 2회 | 안정 반환 bytes당 1회. 파싱/검증을 없애서 줄이지 않음 |
| 실제 read 호출 | readFileSync 내부 구현에 의존 | 공통 readSync의 EOF 확인과 크기 증가 검출용 한 byte 때문에 논리 읽기 1회가 OS read 1회라는 뜻은 아님 |
| 파일·디렉터리 metadata 검사 | 기존 fstat와 외부 fence | 추가 fstat/lstat·참조 재확인 수를 diagnostics/격리 계측으로 별도 기록. 전체 metadata I/O 감소를 가정하지 않음 |
| 시간·메모리 | 같은 호스트/Node/fixture의 실측 기준 | 파일 수·크기·캐시 조건과 반복 분포를 함께 기록. bytes/open/parse 감소만으로 전체 latency 개선을 단정하지 않음 |

측정은 원본을 보존한 동일 합성 fixture와 격리 worker에서 수행한다. 기존 버전도 파일 open, readFileSync가 돌려준 bytes, parse 진입을 계측하고 공통 diagnostics와 의미가 다른 카운터를 섞지 않는다. 구성·stage를 계측 구간 밖에서 준비하고 read/list 구간을 분리한다. 전역 diagnostics 차분에 다른 저장소 작업이 섞이지 않도록 격리하며 새 제품 전역 카운터나 캐시는 도입하지 않는다.

[직전 NAS 전체 TAP 시간 분석](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-workspace-boundary-linux-nas-20260907/prior-suite-timing.json)에서 가장 긴 항목은 file-journal 협업 시나리오(최대 약 36.6초)였으나 읽기 중복이 원인인지는 측정하지 않았으며, 이번 2회→1회 안정 읽기는 workspace 목록의 데이터 중복 읽기를 줄이는 목표로 한정하고 전체 런타임·모든 도구의 지연 개선을 약속하거나 이 과거 시간을 현재 단위의 통과 근거로 사용하지 않는다.

## 구현·검증 순서

1. 선행 directory/lock/sync의 검증 소스를 확정한 뒤 위 read/list 공통 경로와 파일 오류 매핑만 구현한다. 공개 WorkspaceStore, record schema, 저장 파일, 기본 한도는 유지한다.
2. 정상 read/list·동일 stage 재호출·manifest 정리와 함께 exact S/raw 경계, 잘못된 JSON·checksum·비정규 base64·byteLength·SHA·파일명/work/attempt/path를 검증한다. 외부 hardlink 및 2개를 넘는 링크도 기존 호환대로 읽히고 `.pending` 목록은 계속 거절해야 한다.
3. 격리 fs 경합으로 한 번 변경 후 안정/두 번 변경/읽는 도중 소실·부모 교체와 EACCES/EIO를 확인한다. 오류 후 lock 정리·원본 보존·이중 실패 표현을 검사하며 새 검증 때문에 영수증이나 파일을 다시 게시하지 않는다.
4. 안정 파일 한 개와 여러 개 목록에서 open/bytes/parse를 전후 비교하고 추가 metadata 비용을 함께 보고한다. 이어 기존 workspace·담당 저장소·체크포인트 회귀와 최종 소스의 필수 검증을 조정한다. 현재 진행 중인 검증을 이 후속 구현의 통과로 재사용하지 않는다.

파일 생성·hardlink 게시·삭제 API 추출, 자동 stale-lock 복구, async artifact 어댑터, SQLite, Windows native ACL/핸들 구현은 이 단위에 포함하지 않는다.
