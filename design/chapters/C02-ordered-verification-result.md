# C02 순차 검증·수정 기록

2026-09-08 · checkpoint369. 지속 세션·compact의 기존 4파일 **30/30 통과**, CLI·Web 연결 **5/5 통과**로 선택한 macOS 로컬 범위는 총 35개 통과했다. 전체 목표와 운영 환경 인수는 미완료다. [최종 증거](../../runtime/evidence/C02-ordered-checkpoint.json).

SQLite와 파일 저널에서 작업 X를 완료하고 Y에서 여러 차례 compact한 뒤 Z로 재시작해도 원문과 인용이 이어졌다. 각 작업의 목표·근거·실행 기록·자원 장부는 분리됐다. compact 응답 저장 및 게시 직후 프로세스를 강제 종료하는 기존 시험에서도 저장된 응답을 재사용하고 사용량을 한 번만 정산했다. 담당·사용자·명시적인 새 세션의 격리, 원문과 접수 기록의 불일치 거절, 원문을 근거로 삼지 않은 요약 거절도 포함한다. [원로그](../../runtime/evidence/C02-ordered-target1.log).

시험 준비에서 기존 세 파일의 `openAgentStores` 5곳에 임시 호스트 등록표를 주입했다. 세션 동작이나 판정은 바꾸지 않았다. CLI·Web 시험에는 `runAgentCli` → `runLocalCli` → `openAgentLocalProfile`의 기존 신뢰된 호스트 옵션을 전달하고 전용 시험 launcher가 같은 임시 등록표를 사용하도록 연결했다. 일반 설치 명령은 기본 등록표를 그대로 사용하며 제품 환경변수 우회 설정은 추가하지 않았다.

첫 30개는 C01 build5의 소스 지문 `9771651a909c5511a433a07f0a1d36d32f17334c4e6ac3fef53a2bca57d100e2`에서 실행했다. 호스트 옵션 연결 뒤 C02 build1(session24669)은 exit0, 소스 지문은 `e49c5e5a55a1d15baf06d258d881433e363ca7d605e9a7f01c4f413d74f02336`이다. [빌드](../../runtime/evidence/C02-ordered-build1.log) · [빌드 지문](../../runtime/evidence/C02-ordered-build1-manifest.json).

두 번째 실행(session30543)은 exit0, 5개 모두 통과·실패/취소/건너뜀0이다. SQLite·파일 저널의 CLI 프로세스 재시작과 Web 재접속에서 같은 대화가 유지됐다. 추가 입력 재전송은 원문을 한 번만 기록했고, 새 세션과 다른 담당·사용자는 이전 작업에 접근하지 못했다. Web 로그인 상태가 만료돼도 영구 대화는 이어지는 점을 확인했다. [CLI·Web 원로그](../../runtime/evidence/C02-ordered-target2.log). 첫 30개에서 사용한 세션 핵심 코드는 이후 변경하지 않아 같은 시험을 반복하지 않았다. 다음 순서는 C03의 개인 기억·이관·복구다.

모든 시험은 macOS arm64·Node v24.20.0의 로컬 임시 데이터와 대역 응답을 사용한다. CLI·Web 시험의 Web 요청도 로컬 서버 대상이다. 실제 모델 품질, Linux/native Windows, 사내 서비스와 마지막 통합 회귀는 이 결과로 통과 처리하지 않는다.
