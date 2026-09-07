import { createBrowserRouter } from "react-router-dom";
import { AppShell } from "../shell/AppShell";
import { RouteError } from "../components/RouteError";
import { Overview } from "../pages/Overview";
import { Tickets } from "../pages/Tickets";
import { TicketDetail } from "../pages/TicketDetail";
import { Findings } from "../pages/Findings";
import { FindingDetail } from "../pages/FindingDetail";
import { Agents } from "../pages/Agents";
import { SendHistory } from "../pages/SendHistory";
import { MailTemplates } from "../pages/MailTemplates";

/**
 * SOAR 콘솔 라우트. 모든 라우트에 errorElement 를 단다 — 한 화면의 크래시가
 * 앱 전체를 흰 화면으로 만들지 않게.
 *
 * 티켓 상세 키는 `srcKey`(게이트웨이가 낸 불투명 해시)다. 원문 src 를 URL 에 쓰면
 * 마스킹 경계 밖으로 새고, 라벨을 쓰면 마스킹 충돌 때문에 남의 티켓이 열린다.
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Overview />, errorElement: <RouteError /> },
      { path: "tickets", element: <Tickets />, errorElement: <RouteError /> },
      { path: "tickets/:srcKey", element: <TicketDetail />, errorElement: <RouteError /> },
      { path: "findings", element: <Findings />, errorElement: <RouteError /> },
      { path: "findings/:id", element: <FindingDetail />, errorElement: <RouteError /> },
      { path: "agents", element: <Agents />, errorElement: <RouteError /> },
      { path: "reports", element: <SendHistory />, errorElement: <RouteError /> },
      { path: "mail-templates", element: <MailTemplates />, errorElement: <RouteError /> },
    ],
  },
]);
