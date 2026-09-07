/** TanStack Query — control-plane 왕복 훅 + 공유 QueryClient + M1.2 mutation 계층. */
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuditQuery, TicketStatus, TriageStatus } from "@digisecu/contracts";
import {
  addTriageNote,
  setTicketStatus,
  fetchAudit,
  fetchAuditLog,
  fetchGatewayFinding,
  fetchMailBody,
  fetchSmbTree,
  fetchFindingCategoryCounts,
  fetchFindingWeeks,
  fetchReportCycles,
  fetchWorkspacePipeline,
  fetchWorkspaceReports,
  fetchGatewayFindings,
  fetchGatewayStats,
  fetchPipelineSync,
  fetchHealth,
  fetchQualityCandidates,
  fetchQueueDepth,
  fetchReadiness,
  fetchRuntimeActivity,
  fetchRuntimePresence,
  fetchSources,
  fetchTriageBatch,
  fetchWorkspacePayload,
  setTriageStatus,
} from "./api";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

export function useAudit(limit = 20) {
  return useQuery({ queryKey: ["audit", limit], queryFn: () => fetchAudit(limit) });
}

export function useAuditLog(q: AuditQuery = {}) {
  return useQuery({ queryKey: ["auditLog", q], queryFn: () => fetchAuditLog(q) });
}

// B8: refetchInterval 로 주기 폴링 — 최초 성공 후 DB가 끊겨도 화면이 무기한 초록으로 남지 않게.
export function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: fetchHealth, retry: 0, staleTime: 10_000, refetchInterval: 15_000 });
}

export function useReadiness() {
  return useQuery({ queryKey: ["readiness"], queryFn: fetchReadiness, retry: 0, staleTime: 10_000, refetchInterval: 15_000 });
}

// ── M4 게이트웨이 훅 — retry:0(다운 시 빠르게 isError→mock 폴백). 별개 백엔드(/gw). ──
export function useQueueDepth() {
  return useQuery({ queryKey: ["gw", "queueDepth"], queryFn: fetchQueueDepth, retry: 0, staleTime: 30_000 });
}

export function useGatewayFindings(
  q: {
    taskType?: string; status?: string; category?: string; limit?: number; offset?: number;
    week?: string; severity?: string; srcKey?: string;
  } = {},
  opts: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["gw", "findings", q],
    queryFn: () => fetchGatewayFindings(q),
    enabled: opts.enabled ?? true,
    retry: 0,
    staleTime: 30_000,
  });
}

/** 리포트 스레드(주차 필터). */
export function useWorkspaceReports(
  key: string | undefined, cycleKey: string | null,
  opts: { enabled?: boolean; limit?: number } = {},
) {
  // ⚠️ 기본 300 은 한 화면에 다 그리면 15,000px 가 넘는다(smb 509 스레드). 호출측이 정하게 한다.
  const limit = opts.limit ?? 300;
  return useQuery({
    queryKey: ["gw", "workspaceReports", key, cycleKey, limit],
    queryFn: () => fetchWorkspaceReports(key as string, { cycleKey: cycleKey ?? undefined, limit }),
    enabled: (opts.enabled ?? true) && !!key,
    retry: 0,
    staleTime: 30_000,
  });
}

/** 파이프라인 흐름(큐 status 분포). */
export function useWorkspacePipeline(key: string | undefined, cycleKey: string | null) {
  return useQuery({
    queryKey: ["gw", "workspacePipeline", key, cycleKey],
    queryFn: () => fetchWorkspacePipeline(key as string, cycleKey ?? undefined),
    enabled: !!key,
    retry: 0,
    staleTime: 30_000,
  });
}

/** 리포트 주차 목록 + 상태 분포. */
export function useReportCycles(key: string | undefined, cycleKey: string | null) {
  return useQuery({
    queryKey: ["gw", "reportCycles", key, cycleKey],
    queryFn: () => fetchReportCycles(key as string, cycleKey ?? undefined),
    enabled: !!key,
    retry: 0,
    staleTime: 60_000,
  });
}

/** 카테고리별 건수(칩 숫자). 필터가 바뀌면 같이 다시 센다. */
export function useFindingCategoryCounts(
  q: { taskType?: string; since?: number; week?: string; severity?: string },
  opts: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["gw", "findingCategoryCounts", q],
    queryFn: () => fetchFindingCategoryCounts(q),
    enabled: opts.enabled ?? true,
    retry: 0,
    staleTime: 30_000,
  });
}

/** 주차 목록 — 선택기 옵션. 주차는 자주 안 바뀌므로 길게 캐시. */
export function useFindingWeeks(taskType?: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["gw", "findingWeeks", taskType],
    queryFn: () => fetchFindingWeeks(taskType),
    enabled: opts.enabled ?? true,
    retry: 0,
    staleTime: 5 * 60_000,
  });
}

/** 단건 finding 상세(마스킹 hits 포함). numeric id일 때만 fire(mock id는 skip). */
export function useGatewayFinding(id: number | null) {
  return useQuery({
    queryKey: ["gw", "finding", id],
    queryFn: () => fetchGatewayFinding(id as number),
    enabled: id != null,
    retry: 0,
    staleTime: 30_000,
  });
}

/** 발송 요청 본문. 펼친 스레드에서만 부른다(목록 전체를 부르면 게이트웨이가 죽는다). */
export function useMailBody(domain: string, threadId: number | null) {
  return useQuery({
    queryKey: ["gw", "mailBody", domain, threadId],
    queryFn: () => fetchMailBody(domain, threadId as number),
    enabled: threadId != null,
    retry: 0,
    staleTime: 60_000,
  });
}

/** 노출 표면(smb 전용). srcKey 가 없거나 smb 가 아니면 아예 안 부른다. */
export function useSmbTree(srcKey: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["gw", "smbTree", srcKey],
    queryFn: () => fetchSmbTree(srcKey as string),
    enabled: !!srcKey && enabled,
    retry: 0,
    staleTime: 60_000,
  });
}

export function useWorkspacePayload(key: string | undefined) {
  return useQuery({
    queryKey: ["gw", "workspacePayload", key],
    queryFn: () => fetchWorkspacePayload(key as string),
    enabled: !!key,
    retry: 0,
    staleTime: 30_000,
  });
}

/** 도메인 런타임 상태(4도메인). presence 신선도 위해 주기 폴링. 게이트웨이 다운 시 isError→UI 숨김. */
export function useRuntimePresence() {
  return useQuery({ queryKey: ["gw", "runtimePresence"], queryFn: fetchRuntimePresence, retry: 0, staleTime: 20_000, refetchInterval: 30_000 });
}

/** 도메인 런타임 활동 피드(pipeline_run). domain 있을 때만 fire. */
export function useRuntimeActivity(domain: string | undefined, limit = 20) {
  return useQuery({
    queryKey: ["gw", "runtimeActivity", domain, limit],
    queryFn: () => fetchRuntimeActivity(domain as string, limit),
    enabled: !!domain,
    retry: 0,
    staleTime: 20_000,
  });
}

// ── 트리아지 오버레이(제품 소유) — control-plane 영속. 게이트웨이 finding과 별개 축. ──
/** 배치 조회 — refs(finding:th:<id>) 있을 때만 fire. staleTime 짧게(쓰기 즉시반영). */
export function useTriageBatch(refs: string[]) {
  const key = [...refs].sort().join(",");
  return useQuery({
    queryKey: ["triage", key],
    queryFn: () => fetchTriageBatch(refs),
    enabled: refs.length > 0,
    staleTime: 10_000,
  });
}

function useInvalidateTriage() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["triage"] });
    void qc.invalidateQueries({ queryKey: ["audit"] });
    void qc.invalidateQueries({ queryKey: ["auditLog"] });
  };
}

export function useSetTriageStatus() {
  const invalidate = useInvalidateTriage();
  // onSettled(성공·실패 모두 무효화): version_conflict(409) 후에도 최신 version 을 다시 받아와
  // 재시도가 stale version 으로 계속 실패하는 함정을 막는다(codex probe #6).
  return useMutation({
    mutationFn: (v: { findingRef: string; status: TriageStatus; expectedVersion: number }) =>
      setTriageStatus(v.findingRef, v.status, v.expectedVersion),
    onSettled: invalidate,
  });
}

/**
 * 티켓 상태 지정 — 사람이 필터 어휘로 티켓 상태를 바꾼다.
 *
 * ⚠️ 무효화 대상이 **게이트웨이 sources** 다(트리아지가 아니다). 상태의 정본은 도메인 DB 라
 *    게이트웨이를 다시 읽어야 화면이 바뀐다 — 트리아지만 무효화하면 눌러도 그대로 보인다.
 * ⚠️ 감사 이력도 무효화한다 — 워크스페이스의 "운영자 조치 이력" 에 방금 누른 것이 바로 뜬다.
 */
export function useSetTicketStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { domain: string; threadId: number; status: TicketStatus }) =>
      setTicketStatus(v.domain, v.threadId, v.status),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["gw", "sources"] });
      // ★ 키가 둘이다 — 전역 이력은 `audit`, 워크스페이스의 스레드별 이력은 `auditLog`.
      //   하나만 무효화하면 방금 누른 변경이 워크스페이스 이력에 안 뜬다.
      void qc.invalidateQueries({ queryKey: ["audit"] });
      void qc.invalidateQueries({ queryKey: ["auditLog"] });
    },
  });
}

export function useAddTriageNote() {
  const invalidate = useInvalidateTriage();
  return useMutation({
    mutationFn: (v: { findingRef: string; body: string }) => addTriageNote(v.findingRef, v.body),
    onSuccess: invalidate,
  });
}

/** 명부·상세·승인·조직도·감사 캐시를 함께 무효화 (쓰기 후 UI 즉시 반영). */
function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["employees"] });
    void qc.invalidateQueries({ queryKey: ["employee"] });
    void qc.invalidateQueries({ queryKey: ["approvals"] });
    void qc.invalidateQueries({ queryKey: ["org"] });
    void qc.invalidateQueries({ queryKey: ["audit"] });
    void qc.invalidateQueries({ queryKey: ["auditLog"] });
  };
}

// ── SOAR 콘솔 읽기 훅 ────────────────────────────────────────────────────────
// 게이트웨이는 retry:0 (선례 유지) — 읽기 전용이라 재시도해도 나아지지 않고, 실패를 빨리
// 드러내는 편이 낫다. staleTime 은 30s(운영 화면이라 너무 오래 붙들지 않는다).

/** 개요 집계 — 4도메인 1회. 사이드바 숫자도 이걸 쓴다(목록을 세지 않는다). */
export function usePipelineSync() {
  return useQuery({
    queryKey: ["gw", "pipeline", "sync"],
    queryFn: fetchPipelineSync,
    retry: 0,
    staleTime: 30_000,
  });
}

export function useGatewayStats() {
  return useQuery({
    queryKey: ["gw", "stats"],
    queryFn: fetchGatewayStats,
    retry: 0,
    staleTime: 30_000,
  });
}

/** 대상(src) 목록 — 티켓. */
export function useSources(
  q: {
    domain?: string;
    threadState?: "none" | "reported" | "ready" | "awaiting" | "replied" | "closed";
    srcKey?: string;
    q?: string;
    category?: string;
    severity?: "critical" | "high";
    assignee?: "none" | "resolved";
    order?: "firstSeen" | "findings" | "critical" | "lastSeen" | "stale";
    limit?: number;
    offset?: number;
  } = {},
  opts: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["gw", "sources", q],
    queryFn: () => fetchSources(q),
    enabled: opts.enabled ?? true,
    retry: 0,
    staleTime: 30_000,
  });
}

/** 티켓 상세 — srcKey 한 건. 목록에서 넘어오지 않고 직접 열어도(새로고침) 동작해야 한다. */
export function useSource(srcKey: string | undefined) {
  const q = useSources({ srcKey, limit: 1 }, { enabled: !!srcKey });
  return { ...q, item: q.data?.items?.[0] ?? null, ownerLookup: q.data?.ownerLookup ?? "ok" };
}

/** candidate 품질 — 에이전트 화면의 핵심. windowDays 기본 30(최근 한 달). */
export function useQualityCandidates(windowDays = 30) {
  return useQuery({
    queryKey: ["gw", "quality", windowDays],
    queryFn: () => fetchQualityCandidates(windowDays),
    retry: 0,
    staleTime: 60_000,
  });
}
