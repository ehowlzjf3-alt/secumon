/**
 * 콘솔 발송 실행 — 승인된 요청을 파이썬 CLI 로 넘긴다.
 *
 * ## 왜 자식 프로세스인가
 *
 * 실제 발송은 엔진 `deliver()` 안에서만 일어난다(게이트 2축·redact 스캔·dry-run 폴백이
 * 전부 거기 있다). control-plane 은 Node 라 그걸 직접 못 부른다. 콘솔 스택에 파이썬
 * 서비스를 하나 더 띄우는 대신 CLI 를 부르기로 했다(사용자 결정 2026-08-25).
 *
 * ## ⚠️ 이 방식의 유일한 위험 = 인자 주입
 *
 * 그래서 여기서 지키는 것:
 *  1. `execFile` + **배열 인자**. `shell` 을 절대 켜지 않는다 — 켜는 순간 `;`·`$()` 가 산다.
 *  2. spawn **전에** 어휘·타입을 검증한다. CLI 도 다시 검증하지만(방어심층) 여기서 먼저 막는다.
 *  3. 메일 내용(수신자·제목·본문)은 **넘기지 않는다.** 넘기면 그게 곧 2026-08-25 에 지운
 *     `/api/findings/owner-mail-send` 다 — 요청 본문을 그대로 Knox MCP 로 보내던 문.
 *  4. 타임아웃·출력 상한. 자식이 매달리면 요청 스레드가 같이 매달린다.
 *
 * ## 종료코드는 "발송 여부" 가 아니라 "실행 여부"
 *
 *   0  실행됨 — 결과는 stdout 의 mode("sent" | "dry_run")
 *   2  시작조차 못 함(스레드 없음·본문 없음·수신자 없음)
 *   3  인자가 어휘 밖
 *
 * ★ 게이트가 막아 dry_run 이 된 것은 **오류가 아니다.** 그걸 실패로 접으면 화면이
 *   "고장" 과 "정책상 안 나감" 을 못 가른다.
 */
import { execFile } from "node:child_process";

/** 4개 도메인. CLI 의 `choices` 와 1:1 — 한쪽만 늘면 조용히 갈린다. */
const DOMAINS = new Set(["smb", "github", "confluence", "dev_web"]);

/** 자식이 매달리면 요청도 매달린다. SMB 는 본문을 그 자리에서 만들어 오래 걸릴 수 있다. */
const TIMEOUT_MS = Number(process.env.MAIL_SEND_TIMEOUT_MS ?? 120_000);

/** stdout 상한. CLI 는 JSON 한 줄만 내지만, 고장 났을 때 메모리를 안 먹게. */
const MAX_BUFFER = 4 * 1024 * 1024;

export type MailSendOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: number; error: string };

function pythonBin(): string {
  return process.env.MAIL_SEND_PYTHON ?? "python3";
}

function skillDir(): string {
  return process.env.MAIL_SEND_SKILL_DIR ?? "/home/shaneee.baek/project/secu-agent-skill";
}

function enginePath(): string {
  return process.env.MAIL_SEND_ENGINE_SRC ?? "/home/shaneee.baek/project/secu-agent/src";
}

/**
 * 승인된 발송을 실행한다.
 *
 * ⚠️ **DB 트랜잭션 안에서 부르지 말 것.** 메일은 회수 경로가 없어서, 롤백이 '보낸 메일' 을
 *    되돌리지 못한 채 DB 만 되돌아간다. 승인 커밋이 **끝난 뒤** 별도 단계로 부른다.
 */
/**
 * 오류 문자열을 자른다 — ★ **끝을 남긴다.**
 *
 * 앞 300자만 남기던 시절, 파이썬 트레이스백의 실제 원인(마지막 줄)이 통째로 잘렸다.
 * 콘솔엔 "요청 실패 (422) — send_failed" 만 뜨고 사유는 감사 로그에도 없었다
 * (2026-08-31: 원인은 증거 디렉토리 권한이었는데, 그걸 알아내려고 재현을 따로 해야 했다).
 * 트레이스백은 **머리가 아니라 꼬리**가 답이다.
 */
function tailOf(text: string, cap = 600): string {
  if (text.length <= cap) return text;
  return `…(앞부분 생략)\n${text.slice(-cap)}`;
}

export function runMailSend(
  domain: string,
  threadId: number,
  requestedBy: string,
): Promise<MailSendOutcome> {
  // ── spawn 전 검증. CLI 도 다시 보지만 여기서 먼저 막는다(방어심층). ──
  if (!DOMAINS.has(domain)) {
    return Promise.resolve({ ok: false, code: 3, error: `unknown domain: ${domain}` });
  }
  if (!Number.isSafeInteger(threadId) || threadId < 1) {
    return Promise.resolve({ ok: false, code: 3, error: `invalid threadId: ${threadId}` });
  }

  const args = [
    "-m",
    "service.console_send_cli",
    "--domain",
    domain,
    "--thread-id",
    String(threadId),
    "--requested-by",
    // 감사용 문자열. CLI 가 제어문자를 다시 벗기지만 여기서도 자른다.
    // ⚠️ 문자 클래스에 **리터럴 제어문자**를 쓰면 안 된다 — 파일에 저장되면서
    //    `[^@-^_^?]`(**부정** 클래스!)로 바뀌어 거의 전부를 지우고 있었다.
    //    코드포인트 이스케이프로만 쓴다.
    String(requestedBy ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200),
  ];

  return new Promise((resolve) => {
    execFile(
      pythonBin(),
      args,
      {
        cwd: skillDir(),
        // ★ `shell` 을 켜지 않는다(기본 false). 켜는 순간 인자가 셸 문법으로 해석된다.
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: {
          ...process.env,
          PYTHONPATH: `${skillDir()}:${enginePath()}`,
          // ⚠️ 발송 env(`*_REMEDIATION_MAIL_MODE`·`SA_DELIVERY_*`)는 여기서 안 넘긴다 —
          //    CLI 가 `load_runtime_env()` 로 **스스로** 읽는다. 부모 환경에 기대면
          //    같은 스레드가 담당자 대신 DSSOC 로 가고 화면엔 "보냈다" 로 남는다(실측).
        },
      },
      (err, stdout, stderr) => {
        const raw = String(stdout ?? "").trim();
        let parsed: Record<string, unknown> | null = null;
        try {
          // CLI 는 JSON 한 줄만 낸다. 여러 줄이 오면 마지막 줄을 쓴다(경고가 섞일 수 있다).
          const line = raw.split("\n").filter(Boolean).pop() ?? "";
          parsed = line ? (JSON.parse(line) as Record<string, unknown>) : null;
        } catch {
          parsed = null;
        }

        if (!err) {
          if (parsed && typeof parsed.mode === "string") {
            resolve({ ok: true, result: parsed });
            return;
          }
          resolve({ ok: false, code: 1, error: `발송 결과를 해석하지 못했습니다: ${raw.slice(0, 300)}` });
          return;
        }

        // 종료코드 2·3 = 실행 실패. CLI 가 {"error": ...} 를 낸다.
        const code = typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : 1;
        const detail =
          (parsed && typeof parsed.error === "string" && parsed.error) ||
          tailOf(String(stderr ?? "").trim()) ||
          err.message;
        resolve({ ok: false, code, error: detail });
      },
    );
  });
}


/**
 * 담당자 지정 실행 — 승인된 요청을 파이썬 CLI 로 넘긴다.
 *
 * `runMailSend` 와 같은 이유로 자식 프로세스다: 담당자 해석은 **Knox API**(사내 MCP
 * 게이트웨이)를 타는데 control-plane 도 게이트웨이도 그걸 못 부른다.
 *
 * 종료코드 규약도 같다 — 0 반영됨 / 2 못 함(스레드 없음·Knox 에 없는 ID) / 3 어휘 밖.
 */
export function runOwnerAssign(
  domain: string,
  threadId: number,
  knoxId: string,
  requestedBy: string,
): Promise<MailSendOutcome> {
  if (!DOMAINS.has(domain)) {
    return Promise.resolve({ ok: false, code: 3, error: `unknown domain: ${domain}` });
  }
  if (!Number.isSafeInteger(threadId) || threadId < 1) {
    return Promise.resolve({ ok: false, code: 3, error: `invalid threadId: ${threadId}` });
  }
  // ⚠️ Knox ID 는 사용자 입력이다. 셸을 안 쓰므로(execFile) 인용은 필요 없지만,
  //    제어문자와 길이는 여기서 자른다 — CLI 도 다시 자른다(방어심층).
  const id = String(knoxId ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
  if (!id) {
    return Promise.resolve({ ok: false, code: 3, error: "knoxId is empty" });
  }

  const args = [
    "-m", "service.owner_set_cli",
    "--domain", domain,
    "--thread-id", String(threadId),
    "--knox-id", id,
    "--requested-by",
    String(requestedBy ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200),
  ];

  return new Promise((resolve) => {
    execFile(
      pythonBin(),
      args,
      {
        cwd: skillDir(),
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, PYTHONPATH: `${skillDir()}:${enginePath()}` },
      },
      (err, stdout, stderr) => {
        const raw = String(stdout ?? "").trim();
        let parsed: Record<string, unknown> | null = null;
        try {
          const line = raw.split("\n").filter(Boolean).pop() ?? "";
          parsed = line ? (JSON.parse(line) as Record<string, unknown>) : null;
        } catch {
          parsed = null;
        }
        if (!err) {
          if (parsed && parsed.owner) {
            resolve({ ok: true, result: parsed });
            return;
          }
          resolve({ ok: false, code: 1, error: `담당자 지정 결과를 해석하지 못했습니다: ${tailOf(raw)}` });
          return;
        }
        const code = typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : 1;
        const detail =
          (parsed && typeof parsed.error === "string" && parsed.error) ||
          tailOf(String(stderr ?? "").trim()) ||
          err.message;
        resolve({ ok: false, code, error: detail });
      },
    );
  });
}

/**
 * 티켓 상태 지정 — 콘솔에서 사람이 고른 상태를 도메인 스레드에 반영한다.
 *
 * `runOwnerAssign` 과 같은 형태다. 다른 점 하나: **status 는 닫힌 어휘**라
 * 자유문자열 소독이 필요 없다 — 대신 어휘 밖이면 여기서 거른다(CLI 도 다시 거른다).
 */
export function runTicketStatus(
  domain: string,
  threadId: number,
  status: string,
  requestedBy: string,
): Promise<MailSendOutcome> {
  if (!DOMAINS.has(domain)) {
    return Promise.resolve({ ok: false, code: 3, error: `unknown domain: ${domain}` });
  }
  if (!Number.isSafeInteger(threadId) || threadId < 1) {
    return Promise.resolve({ ok: false, code: 3, error: `invalid threadId: ${threadId}` });
  }
  // ⚠️ 닫힌 어휘. 계약(TicketStatus)·CLI(choices)·여기 셋이 같은 값을 들어야 한다 —
  //    한 곳만 늘리면 다른 두 곳이 조용히 거른다(set_owner 를 세 곳에 넣던 그 자리다).
  if (!["ready", "awaiting", "replied", "closed"].includes(status)) {
    return Promise.resolve({ ok: false, code: 3, error: `unknown status: ${status}` });
  }

  const args = [
    "-m", "service.ticket_status_cli",
    "--domain", domain,
    "--thread-id", String(threadId),
    "--status", status,
    "--requested-by",
    String(requestedBy ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200),
  ];

  return new Promise((resolve) => {
    execFile(
      pythonBin(),
      args,
      {
        cwd: skillDir(),
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, PYTHONPATH: `${skillDir()}:${enginePath()}` },
      },
      (err, stdout, stderr) => {
        const raw = String(stdout ?? "").trim();
        let parsed: Record<string, unknown> | null = null;
        try {
          const line = raw.split("\n").filter(Boolean).pop() ?? "";
          parsed = line ? (JSON.parse(line) as Record<string, unknown>) : null;
        } catch {
          parsed = null;
        }
        if (!err) {
          if (parsed && typeof parsed.status === "string") {
            resolve({ ok: true, result: parsed });
            return;
          }
          resolve({ ok: false, code: 1, error: `상태 변경 결과를 해석하지 못했습니다: ${tailOf(raw)}` });
          return;
        }
        const code = typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : 1;
        const detail =
          (parsed && typeof parsed.error === "string" && parsed.error) ||
          tailOf(String(stderr ?? "").trim()) ||
          err.message;
        resolve({ ok: false, code, error: detail });
      },
    );
  });
}
