# 최종 통합 확인 사용법과 인수 경계

새 사용자 명령이나 설정은 없다. 문서 저장 방식을 사용하는 기존 담당은 같은 API·CLI·Web 경로에서 디렉터리 참조 재사용을 적용받는다. 기본 SQLite 선택은 바꾸지 않았다. 문서를 직접 편집하는 배치와 DB를 사용하는 배치를 속도 표 하나만으로 우열 판단하지 않는다.

웹에서 기억 버전이나 원문이 바뀌면 안내의 `개인 기억 상태 확인`을 열어 최신 기억을 검색하고 `이번 업무에 사용`을 누른다. 해당 기억 없이 진행하려면 `이번 업무 선택 해제`를 누른다. 이 동작은 장기기억을 삭제하지 않는다. 권한 오류는 정상 연결 권한을 복원한 뒤 새로고침한다. 단순 새로고침·재접속은 업무 실행 명령을 자동으로 보내지 않는다.

HTTP 서버를 다시 연 경우 새 로그인 URL로 문서를 다시 로드해야 한다. 같은 탭/origin의 저장된 선택 업무 복원을 확인했으며 다른 브라우저·다른 origin·탭 저장소 삭제 후의 복원까지 보장하지 않는다.

## 개발 환경에서 같은 확인을 재실행할 때

이미 통과한 시험을 정기적으로 다시 돌리라는 지시가 아니다. 관련 코드를 바꿨을 때 다음 명령을 사용한다. `runtime/`에서 Node 24.20.0으로 빌드한 뒤 실행하며, 시험·서버가 살아 있는 동안 `dist/`를 다시 빌드하지 않는다.

```sh
npm run build
npm run typecheck:core
npm run check:architecture
node --test --test-concurrency=1 --test-reporter=tap \
  dist/tests/document-directory-read-cost.test.js \
  dist/tests/agent-final-record-links.test.js \
  dist/tests/personal-knowledge-service.test.js \
  dist/tests/document-knowledge-storage.test.js \
  dist/tests/document-knowledge-boundaries.test.js \
  dist/tests/document-personal-memory-presentation.test.js \
  dist/tests/personal-memory-context.test.js
```

동일 HTTP 비용을 측정할 때 `SECUMON_MEASUREMENT_PATH`를 결과 파일의 절대 경로로 지정한다. `SECUMON_BASELINE_SOURCE`는 검사하려는 실제 `dist/build-manifest.json`의 소스 지문을 지정하는 선택 값이다.

```sh
SECUMON_MEASUREMENT_PATH="$PWD/evidence/memory-http-local.json" \
node --import ./evidence/C06-final-memory-measure.mjs \
  --test --test-concurrency=1 --test-reporter=tap \
  --test-name-pattern='two deployments keep same-ID' \
  dist/tests/agent-deployment-entry.test.js
```

화면 fixture는 PTY 터미널에서 `node evidence/C06-memory-recovery-browser-fixture.mjs`로 실행한다. 출력된 일회성 로그인 URL은 로컬 브라우저에서만 연다. stdin에 `{"op":"snapshot"}`, `{"op":"revise"}`, `{"op":"deny"}`, `{"op":"allow"}`, `{"op":"reconnect"}`, `{"op":"stop"}`을 보낸다. 두 번째 revise 전에 화면에서 현재 기억을 선택해야 한다. 서버의 직접 상태 변경은 시험 준비이고, 재선택·해제·새로고침은 실제 제품 화면에서 수행한다.

이 fixture는 고정 로컬 자료만 쓰고 모델·원천 도구를 실행하지 않는다. 로그인 token을 기록하거나 Git에 넣지 않는다. NAS 확인은 동일 소스·컴파일 파일 지문을 먼저 대조한 후 네 파일(기록 연결·디렉터리 비용·문서 저장·문서 경계)만 실행했다. macOS 모드/rename 검사를 native Windows 검증으로 간주하지 않는다.
