# C01 Linux 실제 시험과 공통 경로 수정

2026-09-06 · 구현/검증 기록 · 실제 Linux 전체 시험 통과 · C01 부분 완료

이 문서는 경로 수정 시점의 기록이다. 후속 [새 담당 복제 결과](/Users/seunghanee/Documents/secumon/design/chapters/C01-clone-result.md)에서 clone 구현과 새 수정본 전체 2,523개 검증을 완료했다.

## 구현 변경

1. `local-file-paths.ts`에 저장소 루트 분해와 journal 파일명 판별을 모았다. workspace와 file-journal에서 `/agent`·`C:\agent`의 첫 글자가 잘리는 문제를 수정하고, 파일시스템 전체 루트를 담당 저장소로 쓰는 것을 명시적으로 거절한다. journal 읽기 계측은 Windows 구분자도 파일명으로 판별한다.
2. `check-architecture.mjs`는 OS 경로 구분자를 사용한다. 이전에는 Windows 경로에서 검사 파일 수가 0인데도 성공할 수 있었다. 이제 검사 대상이 0개인 경우 실패한다.
3. MCP 대역 시험 두 파일과 공통 fixture의 `/private/tmp` 고정을 제거했다. 부모와 자식의 임시 디렉터리를 명시적으로 일치시키고, 허용 temp root 아래만 감사 파일을 쓰는 경계를 유지했다. 하위 경로 허용·바깥 및 이름 접두사만 같은 형제 경로 거부를 추가 검증한다.
4. state-query의 동시 변경 시험은 같은 내용의 빠른 재쓰기가 반드시 timestamp를 바꾼다고 가정했다. 파일 시스템에 따라 변화가 관측되지 않아, 실제 파일을 다시 쓴 후 매번 명시적으로 mtime을 바꾸도록 주입을 수정했다. 런타임의 읽기 재시도나 무결성 검사를 완화하지 않았다.
5. 두 번째 전체 Linux 시험에서 journal의 임시 링크 정리 중 시각 정보가 같은 경우를 발견했다. 읽기 전후 메타데이터 비교에 nlink(같은 파일을 가리키는 링크 수)를 추가해 이 변화도 재확인한다. 회귀 시험은 실제 링크 수 2→1을 확인하고 시각 정보는 같게 보이도록 고정하여 저장장치의 tick에 의존하지 않고 한 번의 재시도를 검증한다.

## 시험 준비에서 수정한 점

초기 복사본의 guidance 누락으로 CLI 5개가 실패했다. 기본 지침 두 파일을 보충했다. 이후 전체 시험에서는 과거 IO 비교의 provenance 자료 5개가 누락되어 12개 시험이 등록 전에 종료됐다. 이 자료는 합성 측정치·코드 해시 목록·계측 코드, 합계 333,125 bytes이며 기존 fixture의 SHA-256을 대조했다. 전체 evidence나 과거 원본 압축본을 전송하지 않고 필요한 다섯 파일만 보충했다.

시험 배포용 목록과 제품 배포용 목록은 다르다. C06에서 제품의 필수 guidance/정적 자산과 시험의 고정 기준 자료를 각각 manifest에 포함해야 한다. 임의의 담당 설정이나 실제 기억/대화 파일을 검증 번들에 넣지 않는다.

## 검증 증거와 범위

| 실행 | 결과 | 해석 |
| --- | --- | --- |
| 최초 Linux C01 대상 | 19/24 통과, CLI 5개 실패 | guidance 전송 누락, 원 실패 로그 보존 |
| guidance 보충 후 Linux 대상 | 24/24 통과 | 현재 C01 등록·저장과 기존 합성 CLI |
| 첫 Linux 전체 | 2,426/2,468 통과, 실패 42 | MCP 40, IO 모듈 등록 실패 1, 변경 시점 시험 1. IO 12개 미등록으로 정상 전체 시험 수와 다름 |
| macOS 경로/저장 영향 범위 | 106/106, 추가 기존 CLI 5/5 | 경로 수정 11개 새 사례 포함 |
| macOS MCP 수정 대상 | 43/43 | 새 temp root 경계 시험 포함 |
| macOS state-query 수정 대상 | 28/28 | 명시적인 반복 변경과 재시도 한계 |
| 두 번째 Linux 전체 | 2,490/2,491 통과, 실패 1 | 임시 링크 정리 시각이 같으면 재확인되지 않는 journal 사례. attempt-2에 보존 |
| nlink 보강 후 macOS 저장/복구 | 70/70 | 시간이 같게 보이는 실제 링크 정리, 기존 journal fault·저장소 공통 계약 포함 |
| 계층 검사 실제 CLI fixture | 정상 1개 승인, 잘못된 의존성/빈 대상 3개 정상 거부 | 성공만 확인하지 않고 실패 검출도 확인 |
| Windows 경로 API 시뮬레이션 | 과거 0개 검사 성공 재현, 현재 125개 검사/금지 import·빈 대상 거부 | macOS에서 경로 API를 바꾼 재현, native Windows 실행 아님 |
| 최종 수정본 Linux 전체 | **2,491/2,491 통과**, 실패/취소/skip/todo 0 | 2026-09-06 23:52 KST 종료, exit 0. 관련 106개·타입·계층 125파일·CLI fixture 4개·합성 4시나리오/22판정도 통과 |

최종 검증 sourceDigest는 `987e6cc8d2e22d1cef9606af7eba69f8a297f34e58e23cb8efc91b4cb5fa5709`, build filesDigest는 `9808e14c1a8cd8c532c5d4eb35167901fd9e619c950c97ae5e89c5cb9e17a6e1`(1,020파일)이다. 2026-09-06T14:41:30.508Z 시작해 14:52:05.797Z 종료했다. 소스/빌드를 고정한 상태로 NAS의 빌드→관련 시험→타입/계층→전체 시험→fixture를 실행했고, 회수 후 로컬 소스/빌드와 별도 정적 자산 7개 해시도 다시 대조했다. 전체 시험 파일 병렬 수는 2였다. 직전 실패 결과를 보존하며 과거 macOS 전체 2,479개 통과를 최신 소스의 전체 통과로 소급하지 않는다.

확정 결과는 [Linux 검증 JSON](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-linux-native-verification.json), 원 로그는 [전체 시험](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-linux-nas-20260906/final/all-tests.log)에 있다. lint는 미설정이다. 시험 프로세스 잔여 0, 기존 Node v18.20.4 유지, 시험 루트 0700을 확인하고 SSH 제어 연결을 종료했다. 테스트 복사본과 Node 24는 전용 폴더에 보존했다.

로컬 기록: `runtime/evidence/C01-paths-*.log`, `C01-mcp-portability-local.log`, `C01-state-query-portability-local.log`, `C01-portability-build-pin.json`, `C01-architecture-cli-local.json`, `C01-architecture-path-simulation.json`. Linux 원 실패/실행기는 `runtime/evidence/C01-linux-nas-20260906/`에 보존한다.

이 경로 수정 당시에는 Windows ACL/핸들/원자 게시 어댑터, clone, file-journal 담당 연결과 지속 세션이 남아 있었다. clone은 위 후속 단위에서 구현했다. 실제 모델/API·사내 MCP/Knox·공개 배포는 수행하지 않았으며 C01 전체와 C01~C10 goal은 진행 중이다.
