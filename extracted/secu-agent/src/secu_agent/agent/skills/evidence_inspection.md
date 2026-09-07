---
name: evidence_inspection
description: evidence_dir 안에 떨어진 산물 (strace log, sandbox 결과, 의심 파일 사본) 정적 분석 도구 사용법.
domain: core
when_to_use: sandbox / discovery / review 후 evidence_dir 산물 분석 필요할 때.
---

## 도구 선호 순서

1. **read_evidence_file** — 파일 line 단위 read (offset / limit). 단일 파일 내용 확인.
2. **grep_evidence** — 정규식 / 리터럴 검색. 여러 파일 한 번에. 가장 자주 쓸 도구.
3. **bash_evidence** — `file` / `awk` / `sort` 같은 ad-hoc pipe 가 필요할 때만. is_destructive=True → 사용자 ask.

가능하면 grep_evidence > bash_evidence. bash 는 호스트 명령 → 위험 패턴 사전 차단되지만 그래도 무겁다.

## 절대 규칙

- 모든 경로는 **evidence_dir 기준 상대경로**. `../etc/passwd` 같은 절대경로 / traversal 거부 (path_escape).
- hidden file (`.git`, `.env`, `.harness`) 접근 불가 — audit / 시스템 파일 보호.
- evidence_dir **밖** 파일은 못 봄. SMB share 의 실제 파일은 별도 도구 (read_file_quick / triage tool) 거쳐서.

## 패턴 예시

**sandbox 결과 strace log 의심 syscall 찾기**:
```
grep_evidence(pattern="(connect|sendto|execve|unlink)", path="sandbox/")
```

**의심 파일 크기 / mime 확인**:
```
bash_evidence(command="file run_*.json")
```

**파일 한 줄 한 줄 보기**:
```
read_evidence_file(path="sandbox/run_1747234.json", offset=0, limit=200)
```

## 사이즈 / timeout cap

- read_evidence_file: 2MB cap. 넘으면 too_large.
- grep_evidence: max_matches 200 (조절 가능).
- bash_evidence: 30s timeout 기본, 50KB stdout cap.

cap 초과 시 도구가 알아서 끊음 — agent 가 결과 분할해서 다시 호출하면 됨.

## 관련

- [[sandbox_usage]] — evidence_dir/sandbox/run_*.json 이 sandbox 결과
- [[anti_patterns]] — 호스트 직접 cat 금지
