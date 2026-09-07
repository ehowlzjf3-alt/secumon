/**
 * DB 클라이언트 — `digisecu_control` 전용 pg Pool + Drizzle.
 * DSN은 control-plane/.env 의 CONTROL_PG_DSN (gitignore, threat_hunter와 분리).
 *
 * env 로드는 이 모듈에서 수행한다 — ESM import 호이스팅상 이 파일을 import 하는
 * 진입점(index/seed)에서 loadEnvFile()를 호출해도 이 모듈이 먼저 평가되기 때문.
 */
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

// cwd와 무관하게 control-plane/.env 를 로드. 파일이 없어도(외부 env 주입) 기동하도록 ENOENT 무시(B9).
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}

const dsn = process.env.CONTROL_PG_DSN;
if (!dsn) {
  throw new Error("CONTROL_PG_DSN 미설정 — control-plane/.env 를 확인하세요 (digisecu_control DSN).");
}

export const pool = new Pool({ connectionString: dsn });
export const db = drizzle(pool, { schema });
