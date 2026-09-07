import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// web dev 서버는 /api 를 control-plane(8080), /gw 를 M4 게이트웨이(8091)로 프록시 → 동일 출처, CORS 불필요.
// 경계: control-plane(digisecu_control)과 게이트웨이(threat_hunter read-only)는 **별개 백엔드**다.
// /gw Bearer 토큰은 프록시가 서버측에서 주입한다(브라우저에 토큰 미노출). 미설정 시 헤더 없이 전달→게이트웨이가 401(fail-closed).
const GW_TARGET = process.env.GATEWAY_URL ?? "http://127.0.0.1:8091";
const GW_TOKEN = process.env.GATEWAY_TOKEN ?? "";
// P4 하드닝: 승인자 토큰. 브라우저(사람)→vite→control-plane 경로에만 서버측 주입 →
// 승인/반려는 사람만(자율 에이전트는 control-plane 직접호출이라 토큰 없음→403). 미설정=dev 무인증.
const CP_TARGET = process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:8080";
const APPROVER_TOKEN = process.env.APPROVER_TOKEN ?? "";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // IPv4 루프백으로 고정 — control-plane(127.0.0.1:8080)과 인터페이스 통일.
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: CP_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            // 승인자 토큰 서버측 주입(브라우저 미노출). approve/reject만 검사하나 전 /api에 실어도 무해.
            if (APPROVER_TOKEN) proxyReq.setHeader("authorization", `Bearer ${APPROVER_TOKEN}`);
          });
        },
      },
      "/health": CP_TARGET,
      "/readyz": CP_TARGET,
      "/gw": {
        target: GW_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (GW_TOKEN) proxyReq.setHeader("authorization", `Bearer ${GW_TOKEN}`);
          });
        },
      },
    },
  },
});
