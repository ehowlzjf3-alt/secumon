"""S4: GET / → 번들 HTML 서빙 (vanilla JS가 /api/*로 데이터 fetch)."""
from __future__ import annotations


def test_index_returns_html(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers.get("content-type", "")
    body = r.text
    # 헤더 + 한국어 페이지
    assert "Enterprise Security Agent" in body
    # JS 가 알아서 fetch 하니까 inline 데이터는 안 박아도 됨 — 코어 finding API 호출 흔적만 확인
    assert "/api/findings" in body


def test_index_removes_nonfunctional_side_views(client):
    r = client.get("/")
    assert r.status_code == 200
    body = r.text
    assert 'data-mode="findings"' not in body
    assert 'data-mode="approvals"' not in body
    assert 'data-mode="scheduler"' not in body
    assert 'data-mode="reports"' not in body
    assert "/api/approvals" not in body
    assert "/api/scheduler/runs" not in body
    assert "finding-status" not in body
    assert "approval-audit-area" not in body
    assert "scheduler-runs-area" not in body
    assert "report-bundle-area" not in body
    assert "openEvidence" not in body
    assert "/api/evidence" not in body


def test_index_exposes_approval_ui_hooks(client):
    r = client.get("/")
    assert r.status_code == 200
    body = r.text
    assert "ApprovalRequested" in body
    assert "sendApprovalDecision" in body
    assert "markApprovalResolved" in body
    assert "approval-card" in body
    assert "approval ${payload.approval_id}" not in body


def test_index_exposes_tool_and_reasoning_timeline(client):
    body = client.get("/").text
    assert "ReasoningChunk" in body
    assert "ToolCallStarted" in body
    assert "ToolCallCompleted" in body
    assert "startReasoningChunk" in body
    assert "createToolStep" in body
    assert "renderHistoryToolEvent" in body
    assert "chat-step" in body


def test_index_keeps_loop_bookkeeping_out_of_chat_timeline(client):
    body = client.get("/").text
    assert "TurnStarted" in body
    assert "LoopCompleted" in body
    assert "turn ${payload.turn || ''} started" not in body
    assert "addStep('loop completed'" not in body


def test_index_exposes_busy_input_events(client):
    r = client.get("/")
    assert r.status_code == 200
    body = r.text
    assert "TurnInputQueued" in body
    assert "TurnRevisionAccepted" in body
    assert "SystemNote" in body
    assert "입력 대기열에 추가됨" in body
    assert "현재 작업을 새 입력으로 다시 시작" in body


def test_index_exposes_new_chat_controls(client):
    r = client.get("/")
    assert r.status_code == 200
    body = r.text
    assert 'id="chat-new"' in body
    assert 'id="chat-new-inline"' in body
    assert "startNewChat" in body
    assert "ChatSessionReset" in body


def test_index_exposes_session_delete_control(client):
    body = client.get("/").text
    assert 'id="session-delete"' in body
    assert "deleteCurrentSession" in body
    assert "method: 'DELETE'" in body
    assert "/api/chat/sessions/${sid}" in body
    assert "종료?" in body
    assert "채팅 기록은 유지" in body


def test_index_exposes_unified_finding_report_menu(client):
    # v3.82 U3b: 단일 Findings 진입점 + view 상태 저장/복원 (URL ?view=findings&finding_id=).
    body = client.get("/").text
    assert 'id="report-menu"' in body
    assert 'id="report-modal"' in body
    assert "loadFindingReport" in body
    assert "REPORT_STATE_KEY" in body
    assert "savedReportState" in body
    assert "finding_id" in body


def test_index_v3_74_removes_reports_section(client):
    """v3.74: Reports 섹션(Seed Demo / Review Bundle) + finding-bundle UI 완전 제거."""
    body = client.get("/").text
    assert "Review Bundle" not in body
    assert "Seed Demo Findings" not in body
    assert 'id="demo-seed"' not in body
    assert 'id="report-bundle-open"' not in body
    assert "seedDemoFindings" not in body
    assert "reportBundleUrl" not in body
    assert "demoFixtureUrl" not in body
    assert "/api/reports/finding-bundle" not in body
    assert "/api/demo-fixtures" not in body


def test_index_u3b_no_domain_api_leftovers(client):
    """v3.82 U3b: 코어 슬림화(engine+chat) — 도메인 API/UI 잔재 회귀 가드."""
    body = client.get("/").text
    assert "api/smb" not in body
    assert "owner-mail" not in body
    assert "/api/findings/aggregate" not in body
    assert "api/domain-reports" not in body
    assert "api/domains" not in body
    assert "FIELD_ORDER" not in body
    assert "renderSmb" not in body
    assert "loadLegacySmb" not in body
    assert "smb-report" not in body
    assert "smb_access" not in body


def test_index_u3b_generic_findings_list(client):
    """v3.82 U3b: 제네릭 finding 목록 — GET /api/findings + 상태 필터 + 인라인 read-only 상세."""
    body = client.get("/").text
    # 코어 제네릭 API 만 사용
    assert "'/api/findings'" in body
    # 상태 필터 select — 변경 시 ?status= 재조회
    assert 'id="findings-status-filter"' in body
    assert "FINDING_STATUSES" in body
    assert "'open', 'triaged', 'false_positive', 'accepted_risk', 'remediated'" in body
    # 목록 컬럼: id / task_type / 심각도 / 상태 / 자산 / 요약 / 최근 발견(last_seen)
    assert "task_type" in body
    assert "last_seen" in body
    assert "<th>심각도</th>" in body
    assert "<th>상태</th>" in body
    assert "<th>자산</th>" in body
    assert "<th>요약</th>" in body
    assert "<th>최근 발견</th>" in body
    # 행 클릭 → 인라인 상세 토글 (PATCH 편집 없음 — U5 에서)
    assert "data-finding-idx" in body
    assert "finding-row" in body
    assert "toggleFindingDetail" in body
    assert "renderFindingDetail" in body
    assert "data-finding-detail" in body
    # 단일 메뉴 진입점
    assert 'id="findings-open"' in body
    assert "발견사항 목록" in body


def test_index_updates_todo_panel_in_place(client):
    r = client.get("/")
    assert r.status_code == 200
    body = r.text
    assert "upsertTodoPanel" in body
    assert ".loop-op.todo" in body
    assert "todo-list" in body
    assert 'id="todo-panel"' not in body


def test_index_exposes_conversational_agents_view(client):
    body = client.get("/").text
    assert 'data-mode="agents"' in body
    assert "agent-create" in body
    assert "/api/chat/sessions" in body
    assert "openAgent" in body
    assert "currentSessionId" in body


def test_index_removes_domain_result_board_and_quick_prompts(client):
    body = client.get("/").text
    assert 'data-mode="domains"' not in body
    assert 'id="domain-result-menu"' not in body
    assert 'data-mode="domain-results"' not in body
    assert "/api/domains/overview" not in body
    assert "domains-area" not in body
    assert "renderSelectedDomainResult" not in body
    assert "openAgentForDomain" not in body
    assert "quick-prompts" not in body
    assert "오피스/개발망 탐색" not in body
    assert "정기 스케줄" not in body
    assert "리포트 작성" not in body


def test_index_v3_43_bg_completion_banner(client):
    """v3.43-P6: bg process 완료 banner 렌더 + 이어가기/무시 버튼."""
    body = client.get("/").text
    assert "renderBgCompletionBanner" in body
    assert "BgTaskCompleted" in body
    assert "data-bg-continue" in body
    assert "data-bg-dismiss" in body
    assert "sendUserText" in body


def test_index_v3_42_reasoning_collapsed_by_default(client):
    """v3.53-10: 묶음 wrapper 부활 — details 로 한 turn 묶고 default open."""
    body = client.get("/").text
    # wrapper details — turn 묶음
    assert "det.open = true" in body
    assert "step-loop" in body
    # 같은 turn 안 reasoning chunk 누적용 cache 는 유지
    assert "group._reasoningOp" in body
    # snapshot 추출 함수
    assert "updateTodoSnapshotFromResult" in body
    # snapshot 초기화 변수
    assert "_latestTodoSnapshot" in body


def test_index_chat_enter_sends_shift_enter_newline(client):
    body = client.get("/").text
    assert 'id="chat-input"' in body
    assert "ev.key === 'Enter'" in body
    assert "!ev.shiftKey" in body
    assert "ev.preventDefault()" in body
    assert "sendUserText()" in body
    assert "Shift+Enter inserts a newline" in body


def test_index_escape_cancels_active_turn(client):
    body = client.get("/").text
    assert "cancelActiveTurn" in body
    assert "ev.key !== 'Escape'" in body
    assert "cancelActiveTurn('escape')" in body
    assert "ESC cancel requested" not in body


def test_index_restores_chat_operation_chrome(client):
    body = client.get("/").text
    assert 'id="chat-session-chip"' in body
    assert 'id="chat-queue-state"' in body
    assert 'id="chat-turn-state"' in body
    assert 'id="chat-reconnect"' in body
    assert "refreshChatChrome" in body


def test_index_chat_uses_internal_scroll_layout(client):
    body = client.get("/").text
    assert "height: 100dvh" in body
    assert "overflow: hidden" in body
    assert "grid-template-rows: auto minmax(0, 1fr) auto" in body
    assert ".chat-pane" in body
    assert "overflow: auto" in body


def test_index_keeps_collapsed_tool_steps_visible(client):
    """v3.53-5: step-block 가벼운 톤 (min-height 0). loop-latest CSS 잔존."""
    body = client.get("/").text
    assert ".step-block, .chat-step" in body
    # v3.53-5: 무거운 wrapper chrome (min-height 38px, det.open) 제거됨
    assert "min-height: 38px" not in body
    assert "det.open = false" not in body
    # CSS class 자체는 남아있음 (잔존, 미사용)
    assert "loop-latest" in body


def test_index_coalesces_todo_and_archives_old_operations(client):
    body = client.get("/").text
    assert "timeline-archive" in body
    assert "Earlier operations" in body
    assert "compactTimelineSteps" in body
    # v3.53-8: keep 8 → 1. 최신 op 만 timeline, 나머지 archive.
    assert "const keep = 1" in body
    assert "shouldDisplayToolEvent" in body
    assert "createOperationGroup" in body
    assert "ensureOperationGroup" in body
    assert "updateOperationGroupSummary" in body
    assert "parseTodoResult" in body
    assert "todo-list" in body
    assert ".todo-item" in body
    assert "upsertTodoRunning" in body


def test_index_renders_todo_as_visible_vertical_checklist(client):
    body = client.get("/").text
    assert "todo-panel-header" in body
    assert ".todo-list" in body
    assert "display: grid" in body
    assert "white-space: normal" in body
    assert "overflow-wrap: anywhere" in body
    assert "todo-mark" in body


def test_index_displays_tool_todo_reasoning_inside_loop_card(client):
    body = client.get("/").text
    assert "step-loop" in body
    assert "loop-body" in body
    assert "loop-op" in body
    # v3.53-10: wrapper summary = 최신 op 텍스트 (loop-latest span)
    assert "loop-latest" in body
    assert "loop-todo-summary" in body
    assert "loop-todo-preview" in body
    assert ".step-block.step-loop:not([open]) .loop-body" in body
    assert ".step-block.step-loop[open] .loop-todo-preview" in body
    # v3.66 에서 죽은 updateLoopTodoSummary 제거됨 (단일 sticky todo 패널로 대체) — stale 단언 삭제.
    assert "renderTodoItems" in body
    # v3.66: wrapper 의 "todo X/Y" echo 제거됨(단일 sticky 패널) — stale 단언 삭제.
    assert "normalizeEventName" in body
    assert "reasoning_delta" in body
    assert "StreamReasoningDelta" in body
    assert "payload.name === 'todo'" in body


# ---------------------------------------------------------------------------
# v3.82 U5: GUI(웹 채팅 셸) 개선
# ---------------------------------------------------------------------------

def test_index_u5_rest_header_auth(client):
    """v3.82 U5: REST 인증 — ?token= 쿼리 대신 Authorization: Bearer 헤더."""
    body = client.get("/").text
    assert "Authorization" in body
    assert "Bearer" in body
    # 구버전 쿼리 토큰 append 제거 (access log 유출 표면)
    assert "searchParams.set('token'" not in body
    # WS 는 그대로 subprotocol smuggling 유지
    assert "th-token." in body


def test_index_u5_markdown_renderer(client):
    """v3.82 U5: 외부 라이브러리 없는 sanitizing 마크다운 렌더러."""
    body = client.get("/").text
    assert "function renderMarkdown" in body
    assert "function mdInline" in body
    # 스트리밍은 textContent, turn 종료 시 재렌더
    assert "finalizeAssistantMessage" in body
    # escape 먼저 → 변환 — sanitize-by-construction
    assert "sanitize-by-construction" in body
    assert "mdInline(escapeHtml(" in body
    # http/https 만 <a> — javascript: 등은 클릭 불가
    assert "https?:" in body
    assert "noopener noreferrer" in body
    # 코드펜스 → <pre><code> (escape 경유)
    assert "<pre><code>${escapeHtml(" in body
    # CDN/외부 스크립트 없음
    assert "<script src=" not in body
    assert "cdn." not in body


def test_index_u5_goal_lifecycle_banners(client):
    """v3.82 U5: Goal 라이프사이클 1급 배너 — 분해/일시정지/완료/계속."""
    body = client.get("/").text
    assert "GoalDecomposed" in body
    assert "GoalPaused" in body
    assert "GoalDone" in body
    assert "GoalContinuation" in body
    assert "renderGoalBanner" in body
    # 일시정지 배너의 재개 버튼 — '이어서 진행' 텍스트를 user 메시지로 전송
    assert "이어서 진행" in body
    # 톤: 분해=파랑, 일시정지=노랑, 완료=초록
    assert "goal-decomposed" in body
    assert "goal-paused" in body
    assert "goal-done" in body
    # 체크리스트 패널 연결은 기존 그대로
    assert "GoalChecklistUpdated" in body


def test_index_u5_session_rename_and_archived_browser(client):
    """v3.82 U5: 세션 rename(✎/더블클릭→PATCH label) + 보관 브라우저(복원)."""
    body = client.get("/").text
    assert "renameSession" in body
    assert "method: 'PATCH'" in body
    assert "dblclick" in body
    # 보관 포함 토글 — include_archived=true 재조회 + dim 표시 + 복원
    assert 'id="show-archived"' in body
    assert "보관 포함" in body
    assert "showArchived ? 'true' : 'false'" in body
    assert "restoreSession" in body
    assert "status: 'active'" in body
    assert "복원" in body
    assert ".agent-row.archived" in body


def test_index_u5_agent_type_and_skill_selectors(client):
    """v3.82 U5: 새 세션 생성 폼 — agent_type select + label + skills 입력."""
    body = client.get("/").text
    assert 'id="agent-agent_type"' in body
    assert 'id="agent-skills"' in body
    # agent_types 는 GET /api/chat/sessions 응답에서 채움
    assert "data.agent_types" in body
    assert "parseSkillsInput" in body
    # 400 → 서버 detail 그대로 노출
    assert "e.detail" in body
    # settings.skills 있는 세션엔 🧩 chip (title=전체 목록)
    assert "skill-chip" in body
    assert "🧩" in body


def test_index_u5_profile_chip_from_api(client):
    """v3.82 U5: 프로필 칩 API화 — 하드코딩 제거, /api/profile 로 채움."""
    body = client.get("/").text
    assert "/api/profile" in body
    assert "loadProfileChip" in body
    assert 'id="profile-chip"' in body
    # 401/오류 시 표시
    assert "프로필 ?" in body
    # 하드코딩 잔재 제거
    assert "o4-mini" not in body
    assert "context 130K" not in body
    assert 'id="profile-name"' not in body


def test_index_u5_ws_auto_reconnect_backoff(client):
    """v3.82 U5: WS 자동 재연결 — 지수 backoff (1s→…→30s), open 시 리셋."""
    body = client.get("/").text
    assert "scheduleWsReconnect" in body
    assert "wsReconnectDelayMs" in body
    assert "WS_RECONNECT_MAX_MS" in body
    assert "30000" in body
    assert "재연결 중" in body
    # 명시적(사용자) 종료/소켓 교체 시엔 재연결하지 않음
    assert "_intentionalClose" in body
    assert "closeWs({ intentional: true })" in body


def test_index_u5_approval_mode_toggle(client):
    """v3.82 U5: 승인 모드 토글 — localStorage 보존 + WS ?approval_mode= 전달."""
    body = client.get("/").text
    assert 'id="approval-mode"' in body
    assert "th_approval_mode" in body
    assert "approval_mode" in body
    for mode in ("ask", "auto", "smart", "deny"):
        assert f'value="{mode}"' in body
