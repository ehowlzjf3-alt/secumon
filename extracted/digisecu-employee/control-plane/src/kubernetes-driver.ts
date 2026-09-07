/**
 * kubernetes 런타임 드라이버 (M3.2 → M3.3a 도메인 ns 격리).
 *
 * **경계(불변)**: `@kubernetes/client-node` 의존은 이 파일에만 격리(상위는 동적 import). control-plane은
 * CR **spec CRUD + status read**만(child Pod·status write 금지, 격리 리소스 provision은 operator 몫).
 *
 * M3.3a: 임직원 CR을 **도메인 ns `de-domain-<domain>`**에 라우팅한다. 도메인 격리는 cluster-scoped
 * **DomainRuntime CR**(operator가 ns/PSS/RBAC/quota/NetworkPolicy reconcile)로 요청하고, 그 도메인의
 * `status.isolationReady=true` **이후에만** 임직원 CR을 만든다(순서 게이트). ns 자체는 operator가 만든다.
 */
import * as k8s from "@kubernetes/client-node";
import { LifecycleState } from "@digisecu/contracts";
import {
  applyObservedTransition,
  bumpHeartbeat,
  emitReclaimAudit,
  type ManagedEmployee,
  type ObservedPhase,
  type ReclaimTarget,
} from "./runtime-shared.js";

const GROUP = "runtime.digisecu.local";
const VERSION = "v1alpha1";
const API_VERSION = `${GROUP}/${VERSION}`;
const DE_PLURAL = "digitalemployees";
const DE_KIND = "DigitalEmployee";
const DR_PLURAL = "domainruntimes";
const DR_KIND = "DomainRuntime";

/** 도메인 값의 '_'(dev_web)는 DNS-1123 위반 → '-'로 치환. ns 이름·DomainRuntime CR 이름 공통 규칙(operator와 동일). */
const domainSlug = (domain: string): string => domain.replace(/_/g, "-");
/** 도메인 → 격리 ns 이름. operator의 DomainNamespace(domain)와 반드시 동일. */
const domainNs = (domain: string): string => `de-domain-${domainSlug(domain)}`;

/** 매니저가 소비하는 드라이버 인터페이스 — client-node를 노출하지 않는다. */
export interface KubernetesRuntimeDriver {
  syncOnce(live: ManagedEmployee[], reclaim: ReclaimTarget[]): Promise<void>;
}

interface DigitalEmployeeCR {
  metadata?: { name?: string; generation?: number; deletionTimestamp?: string };
  spec?: { employeeId?: string; desired?: string };
  status?: { phase?: string; observedGeneration?: number };
}
interface DomainRuntimeCR {
  status?: { isolationReady?: boolean };
}

const isNotFound = (e: unknown): boolean => e instanceof k8s.ApiException && e.code === 404;

export async function createKubernetesDriver(kubeconfigPath: string): Promise<KubernetesRuntimeDriver> {
  const kc = new k8s.KubeConfig();
  kc.loadFromFile(kubeconfigPath); // 부재/다운 시 throw → 매니저가 잡아 live 비활성(mock 유지, control-plane 생존)
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);

  // spec.desired 한 필드만 병합(image/resources·status 보존).
  const mergePatch = k8s.setHeaderOptions("Content-Type", "application/merge-patch+json");

  // 도메인 격리 요청 + 준비 여부. DomainRuntime CR(cluster-scoped) ensure 후 isolationReady를 읽는다.
  async function ensureDomainRuntimeReady(domain: string): Promise<boolean> {
    const name = domainSlug(domain); // CR 이름은 DNS-safe(dev-web), spec.domain은 enum 원값(dev_web)
    try {
      const cr = (await custom.getClusterCustomObject({ group: GROUP, version: VERSION, plural: DR_PLURAL, name })) as DomainRuntimeCR;
      return cr.status?.isolationReady === true;
    } catch (e) {
      if (!isNotFound(e)) throw e;
      // 없으면 도메인 의도만 생성(operator가 ns/격리를 reconcile). 이번 tick은 아직 미준비.
      await custom.createClusterCustomObject({
        group: GROUP, version: VERSION, plural: DR_PLURAL,
        body: { apiVersion: API_VERSION, kind: DR_KIND, metadata: { name }, spec: { domain } },
      });
      return false;
    }
  }

  async function listCRs(ns: string): Promise<Map<string, DigitalEmployeeCR>> {
    const resp = (await custom.listNamespacedCustomObject({ group: GROUP, version: VERSION, namespace: ns, plural: DE_PLURAL })) as {
      items?: DigitalEmployeeCR[];
    };
    const map = new Map<string, DigitalEmployeeCR>();
    for (const cr of resp.items ?? []) {
      const name = cr.metadata?.name;
      if (name) map.set(name, cr);
    }
    return map;
  }

  /** observe: CR.status.phase → DB.lifecycle. 단일 가드(observedGeneration 일치·비어있지 않음·유효 enum). */
  async function observe(emp: ManagedEmployee, cr: DigitalEmployeeCR | undefined): Promise<void> {
    if (!cr) return; // 관측할 CR 없음 → lifecycle stale 유지(부재로 Terminated 추론 금지)
    const gen = cr.metadata?.generation;
    if (gen === undefined || cr.status?.observedGeneration !== gen) return; // stale-generation flapping 방지
    const phase = cr.status?.phase;
    if (!phase || !LifecycleState.safeParse(phase).success) return; // 빈/미지 enum → 스킵(목록 API 500 방지)
    const next = phase as ObservedPhase;
    if (next === emp.observed) {
      await bumpHeartbeat(emp.id);
      return;
    }
    await applyObservedTransition(emp, emp.observed, next, "live");
  }

  /** applyDesired: DB.desired → CR.spec.desired (DB→CR 단방향). CR은 도메인 ns에 만든다. */
  async function applyDesired(emp: ManagedEmployee, cr: DigitalEmployeeCR | undefined, ns: string): Promise<void> {
    if (!cr) {
      if (emp.desired === "Terminated") return; // 없는데 종료 의도 → 만들 것 없음
      await custom.createNamespacedCustomObject({
        group: GROUP, version: VERSION, namespace: ns, plural: DE_PLURAL,
        body: { apiVersion: API_VERSION, kind: DE_KIND, metadata: { name: emp.id, namespace: ns }, spec: { employeeId: emp.id, desired: emp.desired } },
      });
      return;
    }
    if (cr.spec?.desired !== emp.desired) {
      await custom.patchNamespacedCustomObject(
        { group: GROUP, version: VERSION, namespace: ns, plural: DE_PLURAL, name: emp.id, body: { spec: { desired: emp.desired } } },
        mergePatch,
      );
    }
  }

  return {
    async syncOnce(live: ManagedEmployee[], reclaim: ReclaimTarget[]): Promise<void> {
      // 도메인별 그룹핑 — 도메인 격리가 준비된 경우에만 그 도메인 임직원 CR을 관리.
      // ── SYNC 패스: live 임직원이 있는 도메인만, isolationReady 순서 게이트 ──
      const byDomain = new Map<string, ManagedEmployee[]>();
      for (const e of live) {
        if (!e.domain) continue; // 도메인 없는 임직원(root/hr)은 파드 대상 아님
        (byDomain.get(e.domain) ?? byDomain.set(e.domain, []).get(e.domain)!).push(e);
      }
      for (const [domain, emps] of byDomain) {
        let ready: boolean;
        try {
          ready = await ensureDomainRuntimeReady(domain); // DomainRuntime CR ensure(없으면 생성) + isolationReady
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`[kubernetes-driver] 도메인 ${domain} 격리 확인 실패:`, (e as Error).message);
          continue; // 다음 tick 재시도
        }
        if (!ready) continue; // 격리 미완 → 이 도메인 임직원 CR 생성 보류(순서 게이트)

        const ns = domainNs(domain);
        let crs: Map<string, DigitalEmployeeCR>;
        try {
          crs = await listCRs(ns);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`[kubernetes-driver] ${ns} LIST 실패:`, (e as Error).message);
          continue;
        }
        for (const emp of emps) {
          try {
            const cr = crs.get(emp.id);
            await observe(emp, cr); // observe-먼저 후 applyDesired
            await applyDesired(emp, cr, ns);
          } catch (e) {
            if (isNotFound(e)) continue;
            // eslint-disable-next-line no-console
            console.error(`[kubernetes-driver] ${emp.id} sync 실패:`, (e as Error).message);
          }
        }
      }

      // ── 회수 패스: isolationReady 게이트와 **독립**(DomainRuntime 재생성 금지 — 명시 decommission 무력화 방지).
      //    id 중복 제거(동일 employee 승인 2건이어도 tick당 삭제·감사 1회). ns/CR 소멸(decommission 등)이면 회수 완료로 스킵.
      const reclaimByDomain = new Map<string, ReclaimTarget[]>();
      const seenReclaim = new Set<string>();
      for (const t of reclaim) {
        if (!t.domain || seenReclaim.has(t.id)) continue; // dedup by id
        seenReclaim.add(t.id);
        (reclaimByDomain.get(t.domain) ?? reclaimByDomain.set(t.domain, []).get(t.domain)!).push(t);
      }
      for (const [domain, targets] of reclaimByDomain) {
        const ns = domainNs(domain);
        let crs: Map<string, DigitalEmployeeCR>;
        try {
          crs = await listCRs(ns); // ensureDomainRuntimeReady 안 거침 — 회수는 격리 준비와 무관
        } catch (e) {
          if (isNotFound(e)) continue; // ns 소멸(도메인 decommission) → CR도 없음, 회수 완료로 간주
          // eslint-disable-next-line no-console
          console.error(`[kubernetes-driver] ${ns} 회수 LIST 실패:`, (e as Error).message);
          continue;
        }
        for (const t of targets) {
          const cr = crs.get(t.id);
          if (!cr || cr.metadata?.deletionTimestamp) continue; // 없거나 이미 삭제중 → 멱등 스킵
          try {
            await custom.deleteNamespacedCustomObject({ group: GROUP, version: VERSION, namespace: ns, plural: DE_PLURAL, name: t.id });
            await emitReclaimAudit(t);
          } catch (e) {
            if (isNotFound(e)) continue;
            // eslint-disable-next-line no-console
            console.error(`[kubernetes-driver] ${t.id} 회수 실패:`, (e as Error).message);
          }
        }
      }
    },
  };
}
