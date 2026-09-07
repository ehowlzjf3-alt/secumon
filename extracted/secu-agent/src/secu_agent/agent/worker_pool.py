"""v3.80 Slice1: WorkerPool — 타깃당 subprocess 워커의 롤링 as-completed 풀.

부모 orchestrator(Ralph 루프)가 타깃을 claim 한 뒤 이 풀로 워커를 spawn 한다.
풀은 도메인 불문 generic — claim / task_spec 생성 / 요약은 호출부(Slice2
어댑터) 몫이고, 여기는 프로세스 수명주기만 책임진다: spawn / 완료 수확
(as-completed, 라운드 배리어 없음) / backstop timeout / SIGTERM→grace→SIGKILL
/ PID 추적·고아 정리.

계약 (agent/CONTRACTS.md "v3.80 워커 계약"):
- 풀은 claim 하지 않는다 — next_spec 콜러블(부모의 claim_next)을 **항상 순차
  1회씩** 호출할 뿐, 동시 호출이 없다 (claim 원자성 논쟁 자체를 제거).
- **spawn 된(또는 claim 후 spawn 못 한) spec 1개당 WorkerCompletion 정확
  1개.** 어떤 실패 경로(spawn 실패/crash/SIGKILL/취소)도 완료를 삼키지
  않는다 — 부모의 claim 해제와 goal_record_turn(타깃=1turn)이 이 invariant
  에 걸려 있다.
- 결과는 worker_result.json 단일 채널 fail-closed (`schema.worker_result`).
  워커 stdout/stderr 는 부모 메모리(PIPE)가 아니라 evidence_dir 의 로그
  파일로만 흘린다 — 컨텍스트 경계: 부모는 transcript 를 받지 않는다.
- 취소: `cancel()` → 전 워커 SIGTERM → grace(기본 5s, 워커가 error_cancel
  을 기록할 기회) → SIGKILL. 완료는 전부 yield 된다 (claim 해제용).
- next_spec(claim) 예외 시에도 활성 워커는 정상 drain — 완료를 전부 yield
  한 뒤에야 예외를 재전파한다 (완료 유실 = 타깃 중복 재점검 경로).
- **웜 풀 금지 (efficiency-audit KEEP #7)**: 1 spec = fresh subprocess 1개,
  재사용 경로 없음 — web SSO 서킷브레이커(login_halted)가 프로세스 종료로만
  리셋되기 때문. fresh-subprocess 가 의도된 격리 경계다.
- 동시성 캡 k 는 호출부가 실측 기반으로 정한다 (고정 하드캡 없음 —
  PARTIAL-REVERSE #6). 보수 시작 K=2.

backstop timeout 기본값은 0c 와 같은 `SA_SUBAGENT_TIMEOUT_SEC`(600s) —
계층: 워커 내부 idle 120s < wall-clock 300s (자체 graceful 종료) < 부모
backstop. backstop 발동은 워커가 자기 watchdog 도 못 돌리는 wedge 전용.

이 슬라이스는 기계 선반입 — 플래그/호출부 연결은 Slice2 (현재 미호출).
"""
from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import logging
import os
import signal
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from secu_agent.agent.schema.worker_result import (
    WorkerResult,
    WorkerResultInvalid,
    read_worker_result,
)
from secu_agent.agent.tools.base import subagent_timeout_sec

log = logging.getLogger(__name__)

# 워커 출력 파일명 (evidence_dir 안) — 부모 컨텍스트로 역류 금지, 디버깅 전용.
WORKER_STDOUT_LOG = "worker_stdout.log"
WORKER_STDERR_LOG = "worker_stderr.log"

_MAX_DETAIL = 500

# SIGKILL 후 최종 proc.wait() 를 기다리는 상한 (초). 운영자 튜닝용 knob.
WORKER_KILL_WAIT_ENV = "SA_WORKER_KILL_WAIT_SEC"
_WORKER_KILL_WAIT_DEFAULT = 10.0


def _worker_kill_wait_sec() -> float:
    """SIGKILL 후 최종 proc.wait() 를 bound 하는 상한 (초).

    un-killable 워커(D-state/uninterruptible I/O — stuck NFS 등)는 SIGKILL
    을 받고도 proc.wait() 이 영영 반환 안 돼, bound 없는 최종 await 이 풀
    전체를 wedge 시킨다 (이후 완료 yield 불가 → 롤링 풀 정지). 이 상한을
    넘기면 대기를 포기하고 proc.returncode(None 가능)로 진행한다 — spec 당
    완료 1개 invariant 는 그대로 유지된다.
    `subagent_timeout_sec()` 와 같은 os.environ 패턴 (호출마다 재평가).
    """
    raw = os.environ.get(WORKER_KILL_WAIT_ENV, "")
    try:
        v = float(raw)
        if v > 0:
            return v
    except ValueError:
        pass
    return _WORKER_KILL_WAIT_DEFAULT

# outcome 은 "프로세스가 어떻게 끝났나", result 는 "계약 결과가 뭐였나" —
# 직교한다. 예: cancelled 인데 워커가 grace 안에 error_cancel 을 쓰면
# result 는 유효한 WorkerResult (부분 결과 수용 가능).
WorkerOutcome = Literal[
    "exited",            # 스스로 종료 (rc 가 곧 워커의 말)
    "backstop_timeout",  # 부모 backstop 발동 → SIGTERM→grace→SIGKILL
    "cancelled",         # cancel() 경로 → SIGTERM→grace→SIGKILL (또는 spawn 생략)
    "spawn_failed",      # 프로세스를 못 띄움 (exec/log 파일 OSError)
    "pool_error",        # 풀 내부 버그 — invariant 사수용 fail-closed 완료
]

NextSpec = Callable[[], "WorkerSpec | None | Awaitable[WorkerSpec | None]"]


@dataclass(frozen=True, slots=True)
class WorkerSpec:
    """워커 1개(=타깃 1개)의 실행 사양. 풀은 내용을 해석하지 않는다.

    payload 는 부모 전용 opaque 패스스루 (claim 핸들/타깃 메타) —
    WorkerCompletion.spec.payload 로 그대로 돌아온다.
    env 는 부모 환경에 **덧씌울** 항목만 (None = 그대로 상속).
    timeout_sec=None → `SA_SUBAGENT_TIMEOUT_SEC`(기본 600s).
    """

    label: str
    argv: tuple[str, ...]
    evidence_dir: Path
    env: Mapping[str, str] | None = None
    cwd: Path | None = None
    timeout_sec: float | None = None
    payload: Any = None

    def __post_init__(self) -> None:
        if not self.argv:
            raise ValueError(f"argv 가 비어 있다: label={self.label!r}")


@dataclass(frozen=True, slots=True)
class WorkerCompletion:
    """워커 1개의 종결 보고 — spec 당 정확 1개 (invariant).

    rc 음수 = 시그널 종료 (-15 SIGTERM / -9 SIGKILL). rc=None 은 프로세스가
    아예 안 떴거나(spawn_failed/cancel 직후 생략) 풀 내부 오류.
    """

    spec: WorkerSpec
    result: WorkerResult | WorkerResultInvalid
    outcome: WorkerOutcome
    rc: int | None
    pid: int | None
    duration_sec: float


def _proc_starttime(pid: int) -> int | None:
    """/proc/<pid>/stat 의 starttime(field 22) — PID 재사용 구분자.

    프로세스 부재/zombie/파싱 불가/비리눅스 → None. reap 은 None 을 절대
    kill 하지 않는다 — 오살보다 누수가 낫다 (zombie 는 이미 죽은 것).
    """
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(
            encoding="ascii", errors="replace",
        )
    except OSError:
        return None
    # comm(field 2)은 괄호/공백을 포함할 수 있다 — 마지막 ')' 뒤에서 split.
    try:
        rest = stat.rsplit(")", 1)[1].split()
        if rest[0] == "Z":
            return None
        return int(rest[19])  # field 22 (rest[0] 이 field 3)
    except (IndexError, ValueError):
        return None


_IS_POSIX = os.name == "posix"
# Windows 엔 signal.SIGKILL 이 없다(AttributeError). 비POSIX 는 os.kill 이
# SIGTERM=TerminateProcess 뿐이라 KILL→TERM 매핑이 안전 (codex 리뷰 #3).
_SIGTERM = signal.SIGTERM
_SIGKILL = getattr(signal, "SIGKILL", signal.SIGTERM)


def _proc_pgid_sid(pid: int) -> tuple[int | None, int | None]:
    """(pgid, sid) — 비POSIX/부재/권한오류 → (None, None)."""
    if not _IS_POSIX:
        return None, None
    try:
        return os.getpgid(pid), os.getsid(pid)
    except OSError:
        return None, None


def _is_isolated_group_leader(pid: int, *, starttime: int | None = None) -> bool:
    """pid 가 우리가 start_new_session 으로 만든 **격리 세션/그룹의 리더**인가 —
    `killpg` 안전 판정 (F5-C). 전부 충족해야 True:

      · starttime 일치(주어지면 — signal 직전 PID 재사용 차단)
      · pgid == pid (그룹 리더)
      · sid == pid (세션 리더 = start_new_session 성공한 격리 그룹)
      · pgid ≠ 우리(부모/풀) 프로세스그룹 — 절대 우리 그룹엔 안 보낸다

    실패 시 False → 호출부는 killpg 금지, 단일 PID fallback (부모/풀·PID재사용
    오살 방지 — codex 리뷰: 검증된 PGID 에만 killpg). 비POSIX 는 항상 False.
    """
    if not _IS_POSIX:
        return False
    if starttime is not None and _proc_starttime(pid) != starttime:
        return False
    pgid, sid = _proc_pgid_sid(pid)
    if pgid is None or sid is None or pgid != pid or sid != pid:
        return False
    try:
        if pgid == os.getpgrp():
            return False
    except OSError:
        return False
    return True


class WorkerPool:
    """롤링 as-completed subprocess 풀 — `run()` 1회용.

    사용 (Slice2):
        pool = WorkerPool(k, pid_registry=run_dir / "worker_pids.json")
        async with contextlib.aclosing(pool.run(claim_next)) as gen:
            async for completion in gen:
                ...  # 부모: 결과 판정 → goal_record_turn / claim 해제

    조기 break 는 aclosing 으로 감쌀 것 — aclose 가 잔여 워커를 비상
    종료한다 (그 완료들은 yield 불가 → claim 회수는 stale reclaim 백스톱).
    """

    def __init__(
        self,
        k: int,
        *,
        term_grace_sec: float = 5.0,
        pid_registry: Path | None = None,
        create_subprocess: Callable[..., Awaitable[Any]] | None = None,
    ) -> None:
        if k < 1:
            raise ValueError(f"k 는 1 이상이어야 한다: {k}")
        if term_grace_sec < 0:
            raise ValueError(f"term_grace_sec 음수 불가: {term_grace_sec}")
        self._k = k
        self._term_grace_sec = term_grace_sec
        self._pid_registry = pid_registry
        self._create = create_subprocess or asyncio.create_subprocess_exec
        self._cancel_ev = asyncio.Event()
        self._live_pids: dict[int, dict[str, Any]] = {}
        self._ran = False

    # ── 취소 ─────────────────────────────────────────────────────────

    def cancel(self) -> None:
        """취소 요청 (idempotent, 즉시 반환).

        전 워커가 각자 SIGTERM → grace → SIGKILL 시퀀스에 들어가고
        (grace 는 병렬 — 워커 수만큼 누적되지 않음), 완료는 전부 run()
        에서 yield 된다. 호출부는 완료를 끝까지 소비한 뒤 claim 해제 →
        goal pause 순으로 마무리한다 (CONTRACTS.md 워커 계약 5).
        """
        self._cancel_ev.set()

    @property
    def cancelled(self) -> bool:
        return self._cancel_ev.is_set()

    # ── 메인 루프 ────────────────────────────────────────────────────

    async def run(self, next_spec: NextSpec) -> AsyncIterator[WorkerCompletion]:
        """롤링 실행 — 아무 워커나 끝나는 즉시 완료를 yield 하고 슬롯을 채운다.

        next_spec 은 부모의 claim 1회 (sync/async 모두 가능). None = "지금
        줄 것 없음" — **영구 아님**: 완료가 날 때마다 다시 묻는다 (stale
        reclaim 등으로 큐가 다시 찰 수 있다). 종료는 이중 조건에서만:
        next_spec=None ∧ 활성 워커 0 (동시 완료 race 차단, 설계 v2).

        next_spec 이 예외를 던지면(claim DB 장애 등) 신규 claim 만 멈추고
        **활성 워커는 전부 정상 drain — 완료를 끝까지 yield 한 뒤** 그
        예외를 다시 던진다. 즉시 전파하면 이미 헌트를 끝낸 워커의 완료가
        유실돼 부모가 turn 기록/claim 해제를 못 하고 stale reclaim 이 같은
        타깃을 재점검한다 (invariant 위반 경로 — 적대 리뷰에서 확정).
        """
        if self._ran:
            raise RuntimeError("WorkerPool.run 은 1회용 — 새 인스턴스를 만들 것")
        self._ran = True
        # 기동 시 1회: 직전 부모 crash 가 이 registry 경로에 남긴 고아 워커를 정리한다
        # (reap_orphan_workers 계약 = 풀 가동 前 startup 전용, starttime 정확일치만 kill).
        # 워커를 spawn 하기 전(= registry 를 새로 쓰기 전) 딱 한 번. 파일 없으면 즉시
        # no-op. 동기 grace-sleep 이 이벤트루프를 막지 않도록 스레드로 offload한다.
        if self._pid_registry is not None:
            try:
                await asyncio.to_thread(reap_orphan_workers, self._pid_registry)
            except Exception as e:  # 백스톱 — reap 실패가 헌트를 막지 않는다
                log.warning("startup 고아 워커 reap 실패 (무시): %r", e)
        active: dict[asyncio.Task[WorkerCompletion], WorkerSpec] = {}
        claim_error: Exception | None = None
        try:
            while True:
                # 풀 채우기 — claim 은 순차 1회씩 (동시 claim 없음)
                while (
                    claim_error is None
                    and not self._cancel_ev.is_set()
                    and len(active) < self._k
                ):
                    try:
                        spec = await self._call_next_spec(next_spec)
                    except Exception as e:
                        # CancelledError 는 BaseException — 여기 안 잡힘 (전파)
                        claim_error = e
                        log.error(
                            "next_spec(claim) 예외 — 신규 claim 중단, 활성 "
                            "워커 %d개 drain 후 재전파: %r", len(active), e,
                        )
                        break
                    if spec is None:
                        break
                    if self._cancel_ev.is_set():
                        # claim 직후 cancel — spawn 은 생략하되, claim 해제는
                        # 호출부 몫이라 fail-closed 완료로 반드시 반납한다.
                        yield WorkerCompletion(
                            spec=spec,
                            result=WorkerResultInvalid(
                                reason="missing",
                                detail="cancel 후 spawn 생략 — claim 해제 대상",
                            ),
                            outcome="cancelled",
                            rc=None, pid=None, duration_sec=0.0,
                        )
                        continue
                    t = asyncio.create_task(self._run_one(spec))
                    active[t] = spec
                if not active:
                    if claim_error is not None:
                        raise claim_error
                    return
                done, _ = await asyncio.wait(
                    set(active), return_when=asyncio.FIRST_COMPLETED,
                )
                for t in done:
                    yield self._completion_of(t, active.pop(t))
        finally:
            if active:
                # 조기 break/aclose — 고아 방지만 가능 (yield 불가 시점)
                await self._emergency_shutdown(active)

    @staticmethod
    async def _call_next_spec(next_spec: NextSpec) -> WorkerSpec | None:
        r = next_spec()
        if inspect.isawaitable(r):
            r = await r
        return r

    def _completion_of(
        self, t: asyncio.Task[WorkerCompletion], spec: WorkerSpec,
    ) -> WorkerCompletion:
        try:
            return t.result()
        except Exception as e:
            # _run_one 이 못 막은 풀 버그 — invariant(완료 1개) 사수
            log.exception(
                "worker task 내부 오류 — fail-closed 완료로 대체: label=%s",
                spec.label,
            )
            return WorkerCompletion(
                spec=spec,
                result=WorkerResultInvalid(
                    reason="missing",
                    detail=f"pool 내부 오류: {e!r}"[:_MAX_DETAIL],
                ),
                outcome="pool_error", rc=None, pid=None, duration_sec=0.0,
            )

    # ── 워커 1개 수명주기 ────────────────────────────────────────────

    async def _run_one(self, spec: WorkerSpec) -> WorkerCompletion:
        start = time.monotonic()
        proc: Any = None
        pid: int | None = None
        try:
            try:
                proc = await self._spawn(spec)
            except OSError as e:
                log.warning(
                    "worker spawn 실패: label=%s argv0=%s: %r",
                    spec.label, spec.argv[0], e,
                )
                return WorkerCompletion(
                    spec=spec,
                    result=WorkerResultInvalid(
                        reason="missing",
                        detail=f"spawn 실패: {e!r}"[:_MAX_DETAIL],
                    ),
                    outcome="spawn_failed", rc=None, pid=None,
                    duration_sec=time.monotonic() - start,
                )
            pid = proc.pid
            self._pids_register(pid, spec.label)
            timeout = (
                spec.timeout_sec if spec.timeout_sec is not None
                else subagent_timeout_sec()
            )
            outcome, rc = await self._wait_or_kill(proc, timeout)
            result = read_worker_result(spec.evidence_dir)
            if isinstance(result, WorkerResultInvalid):
                log.warning(
                    "worker 결과 fail-closed: label=%s outcome=%s rc=%s "
                    "reason=%s — claim 해제 대상",
                    spec.label, outcome, rc, result.reason,
                )
            return WorkerCompletion(
                spec=spec, result=result, outcome=outcome, rc=rc, pid=pid,
                duration_sec=time.monotonic() - start,
            )
        except asyncio.CancelledError:
            # emergency shutdown 의 task.cancel() 경로 — 고아 금지
            # F5-C: 그룹 SIGKILL 로 워커+chromium 손자 동시 회수(검증된 그룹만).
            if proc is not None:
                group = self._verified_group_pgid(proc)
                self._signal_worker(proc, hard=True)
                self._group_kill_stragglers(group)
            raise
        except Exception as e:
            log.exception("worker 실행 중 풀 내부 오류: label=%s", spec.label)
            if proc is not None:  # F5-C: 그룹 SIGKILL (chromium 손자 포함)
                group = self._verified_group_pgid(proc)
                self._signal_worker(proc, hard=True)
                self._group_kill_stragglers(group)
            return WorkerCompletion(
                spec=spec,
                result=WorkerResultInvalid(
                    reason="missing",
                    detail=f"pool 내부 오류: {e!r}"[:_MAX_DETAIL],
                ),
                outcome="pool_error",
                rc=proc.returncode if proc is not None else None,
                pid=pid, duration_sec=time.monotonic() - start,
            )
        finally:
            if pid is not None:
                self._pids_unregister(pid)

    async def _spawn(self, spec: WorkerSpec) -> Any:
        env = None
        if spec.env is not None:
            env = {**os.environ, **dict(spec.env)}
        # stdout/stderr 는 evidence_dir 파일로 — 컨텍스트 경계 + 폭주 출력의
        # 부모 메모리 점유 방지. 파일 핸들은 자식이 dup 하므로 바로 닫는다.
        out_path = spec.evidence_dir / WORKER_STDOUT_LOG
        err_path = spec.evidence_dir / WORKER_STDERR_LOG
        kwargs: dict[str, Any] = dict(
            stdin=asyncio.subprocess.DEVNULL,
            stdout=None,  # placeholder — 아래 with 안에서 파일 핸들로 교체
            stderr=None,
            env=env,
            cwd=str(spec.cwd) if spec.cwd is not None else None,
        )
        if _IS_POSIX:
            # F5-C: 워커를 새 세션/프로세스그룹 리더로 만든다(setsid). 워커가 띄운
            # chromium 손자가 같은 프로세스그룹에 묶여, 취소/backstop/부모 crash 시
            # 검증된 killpg 로 워커+chromium 을 함께 회수한다(고아 방지). 웜풀 금지·
            # fresh subprocess 원칙은 그대로 — 격리만 강화(SAFETY-KEEP 정렬).
            kwargs["start_new_session"] = True
        with open(out_path, "ab") as out, open(err_path, "ab") as err:
            # stdout/stderr 는 evidence_dir 파일로 — 컨텍스트 경계 + 폭주 출력의
            # 부모 메모리 점유 방지. 파일 핸들은 자식이 dup 하므로 바로 닫는다.
            kwargs["stdout"] = out
            kwargs["stderr"] = err
            return await self._create(*spec.argv, **kwargs)

    async def _wait_or_kill(
        self, proc: Any, timeout_sec: float,
    ) -> tuple[WorkerOutcome, int | None]:
        waiter = asyncio.ensure_future(proc.wait())
        cancel_waiter = asyncio.ensure_future(self._cancel_ev.wait())
        try:
            done, _ = await asyncio.wait(
                {waiter, cancel_waiter},
                timeout=timeout_sec,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if waiter in done:
                return "exited", waiter.result()
            if cancel_waiter in done:
                log.info(
                    "worker 취소 — SIGTERM (grace %.1fs): pid=%s",
                    self._term_grace_sec, proc.pid,
                )
                return "cancelled", await self._terminate(proc, waiter)
            log.warning(
                "worker backstop timeout %.0fs — SIGTERM (grace %.1fs): pid=%s",
                timeout_sec, self._term_grace_sec, proc.pid,
            )
            return "backstop_timeout", await self._terminate(proc, waiter)
        finally:
            cancel_waiter.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await cancel_waiter

    def _verified_group_pgid(self, proc: Any) -> int | None:
        """proc 가 우리가 만든 검증된 격리 그룹 리더면 그 pgid(=pid), 아니면 None.

        killpg 는 **유효한 기록 starttime**(소유·PID재사용 방어)이 있고 topology
        (pid==pgid==sid ∧ ≠우리그룹)까지 맞을 때만 허용한다(codex 리뷰: starttime
        없는 topology-only killpg 금지).
        """
        if proc.returncode is not None:
            return None
        pid = proc.pid
        starttime = self._live_pids.get(pid, {}).get("starttime")
        if starttime is not None and _is_isolated_group_leader(
            pid, starttime=starttime,
        ):
            return pid
        return None

    def _signal_worker(self, proc: Any, *, hard: bool) -> None:
        """워커에 시그널 (F5-C). 검증된 격리 그룹 리더면 **그룹 전체**(`killpg`)로
        보내 손자(chromium)까지 함께 회수하고, 아니면 단일 PID(`proc.terminate/kill`)
        로 fallback 한다. 검증 실패 시 killpg 를 절대 안 해 부모/풀·PID재사용 오살을
        막는다. killpg 는 검증된 고정 pid(=pgid)로 보낸다(재조회 getpgid 아님).
        hard=True → SIGKILL, False → SIGTERM (Windows 는 둘 다 terminate/kill 로 매핑).
        """
        if proc.returncode is not None:
            return
        pgid = self._verified_group_pgid(proc)
        if pgid is not None:
            try:
                os.killpg(pgid, _SIGKILL if hard else _SIGTERM)
                return
            except ProcessLookupError:
                return
            except OSError:
                pass  # → 단일 PID fallback
        with contextlib.suppress(ProcessLookupError, OSError):
            if hard:
                proc.kill()
            else:
                proc.terminate()

    def _group_kill_stragglers(self, pgid: int | None) -> None:
        """리더 종료 후에도 그룹에 남은 손자(chromium)를 회수 (F5-C 그룹-소멸 grace).

        TERM 前에 검증해 캡처한 pgid 만 받는다. `killpg(pgid, 0)` 존재확인이
        성공하면 = 그룹에 아직 프로세스가 있음 → 그 pgid 는 **재사용 불가 상태**
        (비어야 재사용됨)이므로 SIGKILL 이 안전하다. 존재확인↔KILL 사이 극좁은
        TOCTOU(그룹이 그 찰나에 비고 숫자 PGID 가 새 리더로 재사용)는 남으며, 절대적
        오살 배제는 cgroup/supervisor 수준 경계가 필요하다 — 그 잔여는 F5-B(토큰
        검증 chromium reaper)가 belt-and-suspenders 로 덮는다.
        """
        if pgid is None:
            return
        try:
            os.killpg(pgid, 0)  # 존재 확인 (비었으면 ProcessLookupError)
        except (ProcessLookupError, OSError):
            return  # 그룹 비었음 → 손자 없음 → 아무것도 안 함
        log.warning(
            "worker 그룹 잔여 프로세스(손자) 회수 — 그룹 SIGKILL: pgid=%s", pgid,
        )
        with contextlib.suppress(ProcessLookupError, OSError):
            os.killpg(pgid, _SIGKILL)

    async def _terminate(self, proc: Any, waiter: asyncio.Future) -> int | None:
        """SIGTERM → grace → SIGKILL. 워커가 grace 안에 error_cancel/timeout
        을 worker_result.json 에 쓸 기회를 준다 (CONTRACTS.md 워커 계약 3·5).
        F5-C: 격리 그룹 리더면 그룹 시그널로 chromium 손자까지 회수."""
        # TERM 前에 검증된 격리 그룹을 캡처한다 — 리더가 살아있을 때만 검증 가능하고,
        # 리더가 grace 안에 먼저 죽어도(손자만 생존) 아래 그룹-소멸 grace 로 회수한다.
        group = self._verified_group_pgid(proc)
        self._signal_worker(proc, hard=False)
        try:
            await asyncio.wait_for(
                asyncio.shield(waiter), timeout=self._term_grace_sec,
            )
        except TimeoutError:
            log.warning(
                "worker grace %.1fs 초과 — SIGKILL: pid=%s",
                self._term_grace_sec, proc.pid,
            )
            # 리더가 아직 살아 있으면 그룹 SIGKILL 로 chromium 손자까지 함께 회수(F5-C).
            self._signal_worker(proc, hard=True)
            # SIGKILL 후 최종 wait 도 bound 한다 — un-killable(D-state/stuck
            # NFS) 워커는 proc.wait() 이 영영 반환 안 해, bound 없는 await 이
            # 풀 전체를 wedge 시킨다 (이후 완료 yield 불가). 상한 초과 시
            # 대기를 포기하고 rc(None 가능)로 진행 — 완료 1개 invariant 유지.
            kill_wait = _worker_kill_wait_sec()
            try:
                await asyncio.wait_for(
                    asyncio.shield(waiter), timeout=kill_wait,
                )
            except TimeoutError:
                log.warning(
                    "worker SIGKILL 후 %.1fs 내 미회수 — D-state 의심, "
                    "대기 포기 (완료는 정상 진행): pid=%s", kill_wait, proc.pid,
                )
                # shield 로 살아남은 waiter 는 여전히 pending — cancel 해
                # pending-task 경고를 막는다 (실제 프로세스 reap 은 event
                # loop child watcher 몫, 이 future 취소와 무관).
                waiter.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await waiter
        # 그룹-소멸 grace (F5-C, codex 리뷰 #2): 리더가 grace 안에 TERM 으로 먼저
        # 죽고 손자(chromium)만 TERM 을 무시하며 남은 케이스를 여기서 회수한다.
        # TERM 前 캡처한 검증 그룹만 대상 — 리더 생존 케이스는 위 SIGKILL 로 이미 처리.
        self._group_kill_stragglers(group)
        return proc.returncode

    async def _emergency_shutdown(
        self, active: dict[asyncio.Task[WorkerCompletion], WorkerSpec],
    ) -> None:
        """generator 조기 종료(break/aclose) 경로 — 완료를 yield 할 수 없는
        시점이라 고아 방지만 한다. 버려진 claim 은 stale reclaim 백스톱 몫."""
        log.warning(
            "WorkerPool 조기 종료 — 활성 워커 %d개 비상 종료 (완료 유실: "
            "claim 회수는 stale reclaim)", len(active),
        )
        self._cancel_ev.set()
        done, pending = await asyncio.wait(
            set(active), timeout=self._term_grace_sec + 10.0,
        )
        for t in pending:
            t.cancel()
        if pending:
            await asyncio.wait(pending, timeout=5.0)

    # ── PID 추적 (부모 crash 대비 백스톱 — 리스크 #4) ────────────────

    def _pids_register(self, pid: int, label: str) -> None:
        pgid, sid = _proc_pgid_sid(pid)  # F5-C: 그룹 회수용 (부모 crash 백스톱)
        self._live_pids[pid] = {
            "starttime": _proc_starttime(pid), "label": label,
            "pgid": pgid, "sid": sid,
        }
        self._pids_flush()

    def _pids_unregister(self, pid: int) -> None:
        self._live_pids.pop(pid, None)
        self._pids_flush()

    def _pids_flush(self) -> None:
        if self._pid_registry is None:
            return
        try:
            if not self._live_pids:
                self._pid_registry.unlink(missing_ok=True)
                return
            payload = json.dumps(
                {str(p): m for p, m in self._live_pids.items()},
                ensure_ascii=False,
            )
            tmp = self._pid_registry.parent / (self._pid_registry.name + ".tmp")
            tmp.write_text(payload, encoding="utf-8")
            os.replace(tmp, self._pid_registry)
        except OSError as e:
            # 추적은 부모 crash 대비 백스톱 — 기록 실패가 헌트를 막으면 안 됨
            log.warning(
                "worker PID registry 기록 실패 (%s): %r", self._pid_registry, e,
            )


def _reap_signal(pid: int, starttime: int | None, *, hard: bool) -> bool:
    """고아 워커에 시그널 (startup reaper 용, F5-C). **identity(pid+starttime)를
    먼저 확인** — 불일치/None 이면 PID 재사용 가능성이라 아무 신호도 안 보낸다
    (codex 리뷰 #1: 재사용을 감지하고도 새 PID 를 죽이던 fallback 결함 수정).
    동일 프로세스가 확정되면 검증된 격리 그룹 리더는 `killpg`(chromium 손자 포함),
    아니면 단일 PID. hard=True → SIGKILL. 보냈으면 True."""
    if starttime is None or _proc_starttime(pid) != starttime:
        return False  # identity 불일치 → 무신호 (오살 금지)
    sig = _SIGKILL if hard else _SIGTERM
    if _is_isolated_group_leader(pid, starttime=starttime):
        try:
            os.killpg(pid, sig)
            return True
        except ProcessLookupError:
            return False
        except (PermissionError, OSError):
            pass  # → 단일 PID fallback (동일 프로세스 확정이므로 안전)
    try:
        os.kill(pid, sig)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def reap_orphan_workers(registry: Path, *, grace_sec: float = 5.0) -> list[int]:
    """기동 시 1회 — 직전 부모 crash 가 남긴 고아 워커(+chromium 손자) 정리.

    registry 의 (pid, starttime) 이 /proc 과 정확히 일치하는 프로세스만
    SIGTERM → grace → SIGKILL. starttime 불일치/확인 불가 = PID 재사용
    가능성 → 건드리지 않는다 (오살 금지). F5-C: 그 pid 가 검증된 격리 세션/
    그룹 리더면 killpg 로 chromium 손자까지 함께 회수한다. 풀이 도는 동안
    호출 금지 — 기동 시 전용 (registry 는 풀 인스턴스 전용 경로).
    반환: SIGTERM 을 보낸 pid 목록.
    """
    try:
        raw = registry.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except OSError as e:
        log.warning("worker PID registry 읽기 실패 (%s): %r", registry, e)
        return []
    try:
        data = json.loads(raw)
        entries = dict(data) if isinstance(data, dict) else {}
    except ValueError:
        entries = {}

    verified: dict[int, int] = {}
    for pid_s, meta in entries.items():
        try:
            pid = int(pid_s)
        except (TypeError, ValueError):
            continue
        recorded = meta.get("starttime") if isinstance(meta, dict) else None
        if not isinstance(recorded, int):
            continue
        if _proc_starttime(pid) != recorded:
            continue
        verified[pid] = recorded

    signalled: list[int] = []
    for pid, starttime in verified.items():
        if _reap_signal(pid, starttime, hard=False):
            signalled.append(pid)
    if signalled:
        log.warning("고아 워커 %d개 SIGTERM: %s", len(signalled), signalled)

    deadline = time.monotonic() + grace_sec
    pending = {pid: verified[pid] for pid in signalled}
    while pending and time.monotonic() < deadline:
        for pid in list(pending):
            if _proc_starttime(pid) != pending[pid]:
                del pending[pid]
        if pending:
            time.sleep(0.05)
    for pid in pending:
        log.warning("고아 워커 grace 초과 — SIGKILL: pid=%s", pid)
        # 리더가 아직 살아 검증되면 그룹 SIGKILL(chromium 포함), 아니면 단일.
        _reap_signal(pid, pending[pid], hard=True)

    registry.unlink(missing_ok=True)
    return signalled
