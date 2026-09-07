/**
 * CRD ↔ zod schema-diff 게이트 (M3.2).
 *
 * operator CRD(controller-gen 생성물)의 enum·안전 CEL이 contracts(zod) SSOT와 어긋나면 실패한다.
 * Go(operator)와 TS(control-plane)가 같은 CR을 각자 정의하므로, 드리프트하면 live 드라이버가
 * 무효 phase를 DB에 쓰거나(목록 API 500) 안전 불변식이 조용히 사라질 수 있다. 이 게이트가 그물망.
 *
 * 검사(codex/렌즈 확정):
 *  1) spec.desired.enum  == DesiredState.options            (정확 집합, 순서무관)
 *  2) status.phase.enum  ⊆  LifecycleState.options \ {Hired} (operator는 'Hired'를 emit하지 않음)
 *  3) 안전 CEL 문자열 존재: Terminated 탈출금지 · employeeId immutable (enum-diff가 못 잡는 회귀 방지)
 *
 * 실행: CI에서 `make manifests`(CRD 재생성) **직후** — 커밋된 stale YAML이 아니라 방금 생성물을 검사.
 *   pnpm --filter @digisecu/control-plane schema-gate
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DesiredState, LifecycleState } from "@digisecu/contracts";

const CRD_URL = new URL(
  "../../operator/config/crd/bases/runtime.digisecu.local_digitalemployees.yaml",
  import.meta.url,
);

function fail(msgs: string[]): never {
  // eslint-disable-next-line no-console
  console.error("❌ schema-diff 게이트 실패:\n  - " + msgs.join("\n  - "));
  process.exit(1);
}

const raw = readFileSync(fileURLToPath(CRD_URL), "utf8");
const doc = parse(raw) as {
  spec?: { versions?: Array<{ name?: string; schema?: { openAPIV3Schema?: Record<string, any> } }> };
};

const errors: string[] = [];

// 버전 스키마 탐색(v1alpha1 우선, 없으면 첫 버전).
const versions = doc.spec?.versions ?? [];
const version = versions.find((v) => v.name === "v1alpha1") ?? versions[0];
const schema = version?.schema?.openAPIV3Schema;
if (!schema) fail(["CRD openAPIV3Schema 를 찾을 수 없음 — CRD 생성물 구조 변경?"]);

const desiredEnum: unknown = schema.properties?.spec?.properties?.desired?.enum;
const phaseEnum: unknown = schema.properties?.status?.properties?.phase?.enum;

const asStrArray = (v: unknown, label: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    fail([`${label} enum 을 CRD에서 읽지 못함(경로 변경?)`]);
  }
  return v as string[];
};

// 1) spec.desired == DesiredState (정확 집합, 순서무관).
const desiredCrd = new Set(asStrArray(desiredEnum, "spec.desired"));
const desiredZod = new Set<string>(DesiredState.options);
for (const d of desiredCrd) if (!desiredZod.has(d)) errors.push(`spec.desired: CRD '${d}' 가 zod DesiredState에 없음`);
for (const d of desiredZod) if (!desiredCrd.has(d)) errors.push(`spec.desired: zod '${d}' 가 CRD에 없음`);

// 2) status.phase ⊆ LifecycleState \ {Hired} (operator는 관측 전 상태 'Hired'를 emit하지 않음).
const phaseCrd = new Set(asStrArray(phaseEnum, "status.phase"));
const lifeZod = new Set<string>(LifecycleState.options); // 'Hired' 포함
for (const p of phaseCrd) {
  if (!lifeZod.has(p)) errors.push(`status.phase '${p}' 가 zod LifecycleState에 없음 — live observe가 무효 enum을 DB에 쓸 위험`);
}
if (phaseCrd.has("Hired")) errors.push("status.phase에 'Hired' 존재 — operator는 관측 phase로 Hired를 emit하면 안 됨(hire 초기값 전용)");

// 3) 안전 불변식 CEL 문자열 존재(enum-diff가 못 잡는 안전규칙 회귀 차단).
if (!raw.includes("cannot transition out of Terminated")) errors.push("Terminated 탈출금지 CEL rule 누락(안전 불변식)");
if (!raw.includes("employeeId is immutable")) errors.push("employeeId immutable CEL rule 누락(안전 불변식)");

if (errors.length) fail(errors);

// eslint-disable-next-line no-console
console.log(
  `✅ schema-diff 게이트 통과 — spec.desired==DesiredState{${[...desiredZod].join(",")}}, ` +
    `status.phase⊆LifecycleState\\{Hired}, 안전 CEL(Terminated 탈출금지·employeeId immutable) 존재`,
);
