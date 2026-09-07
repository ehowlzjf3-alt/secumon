"""FastAPI /gw 앱 — state_domain read 게이트웨이.

경계: control-plane과 별개 프로세스, 127.0.0.1 바인드 기본. Bearer 토큰 fail-closed(codex #5).
프로덕션 authn/authz/tenant 격리는 후속 하드닝(현 digisecu는 로컬 세션·SSO 없음).
게이트웨이는 read-only SELECT만 — 어떤 write/notify/mail-send 경로도 노출하지 않는다.
"""
from __future__ import annotations

import hmac
import re
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response

from .config import Config
from .db import ReadOnlyPool
from .domains import DOMAIN_TASK_TYPES, DOMAINS
from .models import (
    FindingList,
    GatewayFindingDetail,
    GatewayStats,
    MailBody,
    QualityCandidates,
    QueueDepthList,
    ReportThreadItem,
    RuntimeActivityList,
    RuntimePresence,
    SmbTree,
    SourceList,
    WorkspacePayload,
    SyncList,
)
from . import quality_service, runtime_service, stats_service, taxonomy
from .repos import (
    finding_repo, mail_body_repo, queue_repo, report_repo, smb_tree_repo, source_repo,
    sync_repo, workspace_repo,
)

# srcKey 는 게이트웨이가 만든 불투명 해시(sha256 앞 16자) — 형태 밖 값은 SQL 에 닿기 전에 거른다.
_SRC_KEY_RE = re.compile(r"^[0-9a-f]{16}$")

_cfg: Config | None = None
_pool: ReadOnlyPool | None = None


def _get_pool() -> ReadOnlyPool:
    if _pool is None:
        raise HTTPException(status_code=503, detail="gateway pool not ready")
    return _pool


def _require_token(authorization: str | None = Header(default=None)) -> None:
    """Bearer 토큰 검증 — 상수시간 비교, fail-closed."""
    assert _cfg is not None
    expected = f"Bearer {_cfg.token}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def _check_src_key(src_key: str | None) -> None:
    """형태 검증 — 게이트웨이가 낸 값만 되받는다(무의미 스캔·주입 방지, category 파라미터와 같은 규칙)."""
    if src_key is not None and not _SRC_KEY_RE.match(src_key):
        raise HTTPException(status_code=422, detail="invalid srcKey")


def _require_domain(domain: str) -> str:
    if domain not in DOMAINS:
        raise HTTPException(status_code=404, detail=f"unknown domain: {domain}")
    return domain


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _cfg, _pool
    _cfg = Config.load()  # fail-closed: DSN/토큰 없으면 여기서 중단
    _pool = ReadOnlyPool(_cfg)
    _pool.open()
    try:
        yield
    finally:
        _pool.close()
        _pool = None


def create_app() -> FastAPI:
    app = FastAPI(title="digisecu-gateway", version="0.0.0", lifespan=lifespan)

    # ── liveness/readiness — control-plane과 분리, digisecu_control 미접촉 ──
    @app.get("/gw/healthz")
    def healthz() -> dict:
        return {"service": "digisecu-gateway", "status": "live"}

    @app.get("/gw/readyz")
    def readyz() -> dict:
        pool = _get_pool()
        try:
            ok = pool.ping()  # threat_hunter로 SELECT 1(read-only)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=503, detail=f"db not ready: {e!r}") from e
        return {"ready": ok, "db": "threat_hunter"}

    # ── 축2: finding(마스킹) ──
    @app.get("/gw/findings", response_model=FindingList, dependencies=[Depends(_require_token)])
    def list_findings(
        status: str | None = Query(default=None),
        taskType: str | None = Query(default=None),
        category: str | None = Query(default=None),
        since: float | None = Query(default=None),
        week: str | None = Query(default=None),
        severity: str | None = Query(default=None),
        # 대상(src) 한 곳으로 좁히기 — 대시보드/티켓에서 넘어오는 링크가 쓰는 축.
        srcKey: str | None = Query(default=None),
        # 상한 200 은 낮았다 — 한 주차 run 만도 그걸 넘는다(2026-W34 github 1,466건).
        limit: int = Query(default=50, ge=1, le=1000),
        offset: int = Query(default=0, ge=0),
    ) -> FindingList:
        _check_src_key(srcKey)
        task_types = None
        if taskType is not None:
            _require_domain(taskType)  # taskType=도메인 → 해당 도메인의 task_type 집합(github=jenkins 포함)
            task_types = DOMAIN_TASK_TYPES[taskType]
        if category is not None:
            # canon(secret→credential 병합) 후 allowlist 검증. 미지 키는 거부(무의미 스캔·주입 방지).
            category = taxonomy.canon_param(category)
            if category is None:
                raise HTTPException(status_code=422, detail="unknown category")
        return finding_repo.list_findings(
            _get_pool(), status=status, task_types=task_types, category=category,
            since=since, week=week, severity=severity, src_key=srcKey,
            limit=limit, offset=offset,
        )

    @app.get("/gw/findings/categories", dependencies=[Depends(_require_token)])
    def finding_categories(
        taskType: str | None = Query(default=None),
        status: str | None = Query(default=None),
        since: float | None = Query(default=None),
        week: str | None = Query(default=None),
        severity: str | None = Query(default=None),
        srcKey: str | None = Query(default=None),
    ) -> dict[str, object]:
        """카테고리별 건수 — 칩에 숫자를 달기 위한 것.

        같은 필터(taskType/status/since/week/severity)를 함께 받아 **화면에 지금 걸린
        조건 그대로** 센다. ⚠️ finding 하나가 여러 카테고리를 가질 수 있어 합계 ≠ 총계.
        """
        _check_src_key(srcKey)
        tts = (taskType,) if taskType else None
        counts = finding_repo.category_counts(
            _get_pool(), status=status, task_types=tts, since=since, week=week,
            severity=severity, src_key=srcKey)
        return {"counts": counts, "labels": taxonomy.labels()}

    @app.get("/gw/findings/weeks", dependencies=[Depends(_require_token)])
    def finding_weeks(taskType: str | None = Query(default=None)) -> dict[str, list[str]]:
        """관측된 주차 목록(최신순) — UI 주차 선택기용.

        형식은 smb 파이프라인의 `cycle_key` 와 동일(`2026-W34`)해서 8767 화면과 같은 주를
        가리킨다. 기준은 `last_seen` — "그 주 run 이 관측한 노출".
        """
        tts = (taskType,) if taskType else None
        return {"weeks": finding_repo.list_weeks(_get_pool(), tts)}

    @app.get(
        "/gw/findings/{finding_id}",
        response_model=GatewayFindingDetail,
        dependencies=[Depends(_require_token)],
    )
    def get_finding(finding_id: int, response: Response) -> GatewayFindingDetail:
        # 마스킹된 상세라도 캐시/공유 방지(codex): 브라우저·중간 캐시에 남기지 않는다.
        response.headers["Cache-Control"] = "no-store"
        f = finding_repo.get_finding(_get_pool(), finding_id)
        if f is None:
            raise HTTPException(status_code=404, detail="finding not found")
        return f

    # ── 축0: 대상(src) — 티켓의 단위. finding 축과 달리 4도메인이 균형 있게 보이는 유일한 축. ──
    @app.get("/gw/sources", response_model=SourceList, dependencies=[Depends(_require_token)])
    def list_sources(
        response: Response,
        domain: str | None = Query(default=None),
        threadState: str | None = Query(default=None),
        srcKey: str | None = Query(default=None),
        q: str | None = Query(default=None, max_length=200),
        category: str | None = Query(default=None),
        severity: str | None = Query(default=None),
        assignee: str | None = Query(default=None),
        order: str = Query(default="findings"),
        limit: int = Query(default=50, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
    ) -> SourceList:
        """대상 목록(서버 group-by). 담당자·통보 상태까지 한 행에 붙여 낸다.

        마스킹 라벨(`src`)과 되묻기 키(`srcKey`)가 분리돼 있다 — 필터는 반드시 srcKey 로.
        """
        if domain is not None:
            _require_domain(domain)
        _check_src_key(srcKey)
        # 담당자 이메일이 실려 나가므로 상세와 같은 취급(캐시 금지).
        response.headers["Cache-Control"] = "no-store"
        try:
            return source_repo.list_sources(
                _get_pool(), domain=domain, thread_state=threadState, src_key=srcKey,
                q=q, category=category, severity=severity, assignee=assignee,
                order=order, limit=limit, offset=offset,
            )
        except ValueError as e:  # 미지 threadState/category — 조용히 전체를 내지 않고 거부
            raise HTTPException(status_code=422, detail=str(e)) from e

    # ── 노출 표면(smb) — 발견 목록이 "무엇이 걸렸나" 면 이건 "어디까지 열려 있나" 다. ──
    @app.get("/gw/sources/{src_key}/smb-tree", response_model=SmbTree,
             dependencies=[Depends(_require_token)])
    def smb_tree(src_key: str, response: Response) -> SmbTree:
        """한 SMB 호스트의 공유 → 디렉터리.

        ⚠️ 호스트 원문이 아니라 **srcKey** 로만 되묻는다(라벨은 마스킹값이라 충돌한다).
        ⚠️ 경로는 마스킹하지 않는다 — 사용자 결정(2026-08-25). 같은 값을 :8767 이 이미
           같은 사내 ACL 안에서 원문으로 보여준다.
        ⚠️ 그래도 캐시는 막는다 — 경로가 공정 정보를 담을 수 있다.
        """
        _check_src_key(src_key)
        response.headers["Cache-Control"] = "no-store"
        return smb_tree_repo.smb_tree(_get_pool(), src_key=src_key)

    # ── 발송 요청 본문 — ★ "발송본" 이 아니다(읽기 시점 재마스킹). ──
    @app.get("/gw/reports/{key}/{thread_id}/body", response_model=MailBody,
             dependencies=[Depends(_require_token)])
    def report_body(key: str, thread_id: int, response: Response) -> MailBody:
        """스레드 1건의 발송 요청 본문.

        저장값은 `deliver()` 호출 **전** payload 라 egress redact 이전이다. 실제로 나간
        본문은 DB 어디에도 없으므로, 여기서 `masking.redact()` 를 다시 걸어 내보낸다
        (사용자 결정 2026-08-25). 화면 값은 실제 나간 메일보다 **더** 가려져 있다.
        """
        _require_domain(key)
        response.headers["Cache-Control"] = "no-store"
        return mail_body_repo.mail_body(_get_pool(), domain=key, thread_id=thread_id)

    # ── 개요 집계 — 4도메인 1회. 도메인 루프로 짜면 32왕복이라 pool_max=4 를 굶긴다. ──
    @app.get("/gw/pipeline/sync", response_model=SyncList, dependencies=[Depends(_require_token)])
    def pipeline_sync(response: Response) -> SyncList:
        """도메인별 가장 최근 보고 패스의 단계별 카운터.

        "열린 finding 19,808 vs 이번 주 보고 85" 의 간극을 설명하는 값이다 —
        파이프라인이 이미 세고 있었는데 `pipeline_run.detail` 에만 남고 아무도 안 읽었다.
        ⚠️ `parsed=False` 는 "못 읽었다" 이지 "0" 이 아니다. 운영량이라 no-store.
        """
        response.headers["Cache-Control"] = "no-store"
        return sync_repo.latest_sync(_get_pool())

    @app.get("/gw/stats", response_model=GatewayStats, dependencies=[Depends(_require_token)])
    def gateway_stats(response: Response) -> GatewayStats:
        """개요 한 판 — 발생/조치·도메인별 대상·주차별 유입·분류 분포.

        `remediationBasis` 로 "조치 완료" 를 무엇으로 셌는지 같이 낸다(도메인마다 근거가 다르다).
        운영량 정보라 no-store.
        """
        response.headers["Cache-Control"] = "no-store"
        return stats_service.stats(_get_pool())

    # ── 축1: 업무/큐(대기 깊이) ──
    @app.get("/gw/queue/depth", response_model=QueueDepthList, dependencies=[Depends(_require_token)])
    def queue_depth() -> QueueDepthList:
        return queue_repo.queue_depth_all(_get_pool())

    @app.get(
        "/gw/workspaces/{key}/reports",
        response_model=list[ReportThreadItem],
        dependencies=[Depends(_require_token)],
    )
    def workspace_reports(
        key: str,
        response: Response,
        cycleKey: str | None = Query(default=None),
        limit: int = Query(default=300, ge=1, le=1000),
    ) -> list[ReportThreadItem]:
        """리포트 스레드만 — 주차 전환 시 payload 전체(발견사항 포함) 재조회를 피한다."""
        _require_domain(key)
        response.headers["Cache-Control"] = "no-store"
        return workspace_repo.list_reports(_get_pool(), key, limit=limit, cycle_key=cycleKey)

    @app.get("/gw/workspaces/{key}/pipeline", dependencies=[Depends(_require_token)])
    def workspace_pipeline(
        key: str, cycleKey: str | None = Query(default=None),
    ) -> dict[str, object]:
        """파이프라인 흐름 — 큐 status 분포 + 주차 목록 + **리포트 단계·실행 이력**.

        status 어휘는 도메인마다 다르므로 손나열하지 않고 실제 값을 그대로 낸다.
        `terminal` 은 그 status 가 종결(=대기 아님)인지 — domains.py 의 SSOT 를 따른다.

        ★ `report`/`components` 는 여기에 **덧붙였다**. `/gw/pipeline/{domain}` 을 따로 내면
          같은 뜻의 라우트가 둘이 된다 — 축이 다를 뿐(큐 vs 리포트 스레드) 사람이 보는 것은
          "이 도메인 파이프라인 현황" 하나다. 기존 응답 키는 그대로라 additive 다.
        """
        _require_domain(key)
        pool = _get_pool()
        overview = report_repo.pipeline_overview(pool, key)
        return {
            "domain": key,
            "cycleKey": cycleKey,
            "cycles": queue_repo.queue_cycle_keys(pool, key),
            "stages": queue_repo.status_breakdown(pool, key, cycleKey),
            # 리포트 스레드 축 — 큐(stages)와 다른 축이다.
            "report": {
                "stageCounts": overview.stageCounts,
                "groupCounts": overview.groupCounts,
                "threadTotal": overview.threadTotal,
            },
            # pipeline_run 실행 이력. sinceLastRunSeconds 는 heartbeat staleness 와 다른 축.
            "components": [c.model_dump() for c in overview.components],
        }

    @app.get("/gw/reports/{key}/{thread_id}", dependencies=[Depends(_require_token)])
    def report_detail(key: str, thread_id: int) -> dict[str, object]:
        """리포트 스레드 1건 상세.

        목록(`/gw/workspaces/{key}/payload` 의 reports)과 **별개 표현**이다. 본문 원문은
        내려주지 않는다 — 저장값이 egress redact 이전이라 `body.redaction="pre_egress"` 로
        그 사실만 계약하고, 표시는 마스킹 경계를 다시 세운 뒤 별도 슬라이스로 간다.
        """
        _require_domain(key)
        found = report_repo.get_report(_get_pool(), key, thread_id)
        if found is None:
            raise HTTPException(status_code=404, detail="report thread not found")
        return found.model_dump()

    @app.get("/gw/workspaces/{key}/report-cycles", dependencies=[Depends(_require_token)])
    def report_cycles(key: str, cycleKey: str | None = Query(default=None)) -> dict[str, object]:
        """리포트 주차 목록 + 상태 분포 — 8767 mail 탭의 주차 선택기 이식분.

        주차 기준은 8767 과 동일한 `last_cycle_key` 라서 두 화면의 "W34" 가 같은 집합이다.
        """
        pool = _get_pool()
        _require_domain(key)
        return {
            "cycles": workspace_repo.report_cycle_keys(pool, key),
            "cycleKey": cycleKey,
            "statusCounts": workspace_repo.report_status_counts(pool, key, cycleKey),
        }

    # ── 축3: 워크스페이스 payload(구조는 control-plane 소유) ──
    @app.get(
        "/gw/workspaces/{key}/payload",
        response_model=WorkspacePayload,
        dependencies=[Depends(_require_token)],
    )
    def workspace_payload(
        key: str,
        response: Response,
        since: float | None = Query(default=None),
        week: str | None = Query(default=None),
        cycleKey: str | None = Query(default=None),
        findingLimit: int = Query(default=60, ge=1, le=1000),
        reportLimit: int = Query(default=50, ge=1, le=1000),
    ) -> WorkspacePayload:
        _require_domain(key)
        # 마스킹 payload(finding summary·리포트 라벨 등)라도 캐시/공유 방지 — 상세와 일관(codex 적대검증).
        response.headers["Cache-Control"] = "no-store"
        # since: /gw/findings 와 동일 의미(last_seen >=) — "이번 run 만 보기".
        # 목록 상한이 60/50 하드코딩이라 run 결과가 잘려 보이던 것을 파라미터화.
        return workspace_repo.workspace_payload(
            _get_pool(), key, since=since, week=week, cycle_key=cycleKey,
            finding_limit=findingLimit, report_limit=reportLimit,
        )

    # ── 도메인 런타임 상태·활동(platform.pipeline_*) — 개인 아님, 공유 워커 기준. sql/002 GRANT 필요. ──
    @app.get("/gw/runtime/presence", response_model=RuntimePresence, dependencies=[Depends(_require_token)])
    def runtime_presence() -> RuntimePresence:
        return runtime_service.presence(_get_pool())

    @app.get(
        "/gw/runtime/domains/{domain}/activity",
        response_model=RuntimeActivityList,
        dependencies=[Depends(_require_token)],
    )
    def runtime_activity(domain: str, limit: int = Query(default=20, ge=1, le=100)) -> RuntimeActivityList:
        _require_domain(domain)
        return runtime_service.domain_activity(_get_pool(), domain, limit)

    # ── candidate 품질 read-model(#1 눈) — skill_quality VIEW(worker_candidate_quality).
    #    v3.90 침묵 게이트의 "판정은 오케스트레이터 위임"을 받는 표면. sql/003 GRANT 필요.
    #    응답은 enum/카운트/UUID/epoch 만(무 free-text). 운영량 정보라 no-store. ──
    @app.get(
        "/gw/quality/candidates",
        response_model=QualityCandidates,
        dependencies=[Depends(_require_token)],
    )
    def quality_candidates(
        response: Response,
        windowDays: int = Query(default=7, ge=1, le=30),
    ) -> QualityCandidates:
        response.headers["Cache-Control"] = "no-store"
        return quality_service.candidates(_get_pool(), windowDays)

    return app


def main() -> None:
    import uvicorn

    cfg = Config.load()
    uvicorn.run(create_app(), host=cfg.host, port=cfg.port, log_level="info")


if __name__ == "__main__":
    main()
