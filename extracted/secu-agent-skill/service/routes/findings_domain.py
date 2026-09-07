"""/api/findings 도메인 표면 — aggregate + owner-mail 3종 (v3.82 U3d).

엔진 routes/findings.py 에서 도메인 분리분만 유지:
- GET  /api/findings/aggregate     (4분야 dedup 병합 projection)

★ 메일 발송 라우트 3개(`notify-owner`·`owner-mail-draft`·`owner-mail-send`)를 **삭제했다**
  (2026-08-25, 사용자 결정: "드라이런 발송차단은 1개로 통일해서 막고 안 쓰는 건 버리고").

  `owner-mail-send` 는 **게이트를 타지 않는 발송 문**이었다. 수신자·제목·본문을 요청에서
  그대로 받아 `send_owner_mail()` → Knox MCP 로 직행했다 — `apply_egress_gate` 없음 ·
  `SA_DELIVERY_RECIPIENT_ALLOW` 없음 · redact 스캔 없음 · autosend opt-in 없음.
  게다가 토큰 기본값이 리터럴 `devtoken`(`SA_CHAT_TOKEN` 미설정)이고 8767 은 0.0.0.0 바인딩이라,
  실측상 `?token=devtoken` 이 통과했다(503 은 인증 실패가 아니라 MCP 미기동이었다).
  바로 위 `notify-owner` 가 "직접 발송은 비활성화됨" 이라며 410 을 내면서 **그 대체 경로로
  이 문을 안내**하고 있었다.

  ⇒ 이제 Knox MCP 로 가는 길은 **하나뿐**이다:
       deliver() → apply_egress_gate → knox_mail sink → send_owner_mail → MCP
     (`secu_agent/knox/mail_sink.py`. 게이트 2축·redact 스캔·draft 폴백이 전부 그 안에 있다.)

  소비자 확인 후 지웠다: `owner-mail-send` 실사용 0(테스트만) · `notify-owner` 실사용 0(이미
  410 껍데기) · `owner-mail-draft` 유일 소비자가 `service/ui/index_orig.html` 인데 그 파일은
  코드 참조가 0인 죽은 파일이라 같이 지웠다.

generic finding CRUD(GET ''/GET·PATCH /{finding_id})는 엔진 코어 서비스(8765)
소유 — 여기엔 없다. 토큰은 구버전 호환 `?token=` 쿼리 패턴 유지 (check_token).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from secu_agent.web.auth import check_token

from service.services.domain_reports import list_all_findings


router = APIRouter(prefix="/api/findings")


# v3.76: 통합 Findings — 4개 분야 dedup 병합 + facets. token-gated(domain_reports 와 동일).
@router.get("/aggregate")
def findings_aggregate(
    token: str = Query(""),
    limit: int = Query(500, ge=1, le=500),
    include_clean: bool = Query(False),
) -> dict:
    if not check_token(token):
        raise HTTPException(status_code=401, detail="invalid token")
    return list_all_findings(limit=limit, include_clean=include_clean)


