/** drizzle-kit 설정 — digisecu_control 마이그레이션 생성/적용. */
import { defineConfig } from "drizzle-kit";

// control-plane/.env 의 CONTROL_PG_DSN 로드 (Node 20.12+ 내장).
process.loadEnvFile();

const dsn = process.env.CONTROL_PG_DSN;
if (!dsn) throw new Error("CONTROL_PG_DSN 미설정 (control-plane/.env)");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: dsn },
  verbose: true,
  strict: true,
});
