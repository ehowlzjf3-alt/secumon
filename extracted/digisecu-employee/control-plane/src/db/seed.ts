/**
 * 시드 러너 — digisecu_control 에 명부 스냅샷 적재. 재실행 가능(전체 교체).
 * 실행: pnpm --filter @digisecu/control-plane seed
 */
// env(CONTROL_PG_DSN) 로드는 ./client 가 import 시점에 수행.
import { db, pool } from "./client.js";
import { employees, tools } from "./schema.js";
import { SEED_EMPLOYEES, SEED_TOOLS } from "./roster-seed.js";

async function main() {
  // 전체 교체를 단일 트랜잭션으로(A10) — 중간 실패 시 명부가 부분 삭제 상태로 남지 않도록 원자화.
  await db.transaction(async (tx) => {
    // 부모/자식 무결성 위해 tools → employees 순으로 비우고, employees → tools 순으로 채운다.
    await tx.delete(tools);
    await tx.delete(employees);

    await tx.insert(employees).values(
      SEED_EMPLOYEES.map((e) => ({
        id: e.id,
        name: e.name,
        title: e.title ?? null,
        kind: e.kind,
        domain: e.domain ?? null,
        persona: e.persona ?? null,
        role: e.role ?? null,
        status: e.status ?? null,
        // 시드는 이미 수렴 상태(observed=desired). paused presence → Paused(B7).
        lifecycle: e.status === "paused" ? "Paused" : "Running", // observed phase
        desired: e.status === "paused" ? "Paused" : "Running", // 의도 (M3.0)
        hotStart: e.hotStart ?? false,
        accent: e.accent ?? null,
        workspaceKey: e.workspaceKey ?? null,
        managerId: e.managerId ?? null,
      })),
    );

    await tx.insert(tools).values(
      SEED_TOOLS.map((t) => ({ id: t.id, name: t.name, role: t.role, ownerId: t.ownerId })),
    );
  });

  console.log(`[seed] employees=${SEED_EMPLOYEES.length}, tools=${SEED_TOOLS.length} 적재 완료`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error("[seed] 실패:", err);
    pool.end();
    process.exit(1);
  });
