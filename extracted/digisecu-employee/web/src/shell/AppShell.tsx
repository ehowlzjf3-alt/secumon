import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function AppShell() {
  return (
    <div className="grid h-screen grid-cols-[220px_1fr] bg-paper text-ink">
      <Sidebar />
      <div className="flex min-w-0 flex-col">
        <Topbar />
        {/* min-h-0 이 없으면 flex 자식이 내용 높이만큼 늘어나 내부 스크롤이 안 잡힌다. */}
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
