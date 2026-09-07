---
name: sandbox_usage
description: 의심 파일을 호스트에서 직접 안 까보고 ai-sandbox microVM 안에서 실행하는 원칙.
domain: core
when_to_use: SMB / web / 기타 task 에서 의심스러운 ELF / 스크립트 / archive 발견 시. 사용자가 "이 파일 위험해 보이는데" 류 표현.
---

## 절대 규칙

1. **호스트에서 직접 cat / less / python / bash 절대 금지.**
   - SMB · 깃허브 · 외부에서 가져온 파일은 _전부 untrusted_ 로 간주.
   - run_in_sandbox 거치지 않은 실행 = 보안 사고 가능성.

2. **is_destructive=True — 사용자 승인 필수.**
   - 도구가 자동으로 ask 결정 반환. 절대 우회하지 말 것.

## 언제 부르나

- ELF 바이너리 (`magic == ELF`, `file` 결과 'executable')
- 스크립트 (`.sh`, `.py`, `.ps1`, `.bat`, `.vbs`)
- archive (`.zip`, `.tar.gz`, `.7z`) — 안에 의심 실행 가능 파일
- 의심 매크로 (`.docm`, `.xlsm`)
- "잘 모르겠는 binary" — 일단 sandbox 통과시켜 strace 결과 본다

## 어떻게 부르나

```
run_in_sandbox(
  file_path="/abs/path/to/suspicious.sh",
  command="bash /tmp/sample",         # VM 안에서 실행할 명령
  timeout_sec=60,                     # 기본 120, 짧게 잘라 결정적
  rationale="SMB share 에서 발견한 출처불명 ELF, autorun 패턴 의심"
)
```

결과: exit_code + stdout/stderr + strace 요약 + evidence_dir/sandbox/run_*.json 영속화.

## 사용자에게 보고할 때

- 항상 결과 + rationale 같이 보고. 사용자가 본인 환경에서 다시 안 까보도록.
- 의심 syscalls / network 시도 / file write 패턴은 finding 으로 박제.

## 비활성화 시 graceful

AI_SANDBOX_DIR 환경변수 미설정 / 설치 미완 = ToolError(kind="forbidden") 반환.
이 경우 사용자에게 "ai-sandbox 셋업 필요" 안내 후 절대 호스트에서 우회 시도 X.

## 관련

- [[anti_patterns]] — 호스트 직접 까보기 절대 ✗
- [[enterprise_security_policy]] — charter_ref 기록 의무
