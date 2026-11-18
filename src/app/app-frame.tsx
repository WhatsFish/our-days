"use client";

import type { ReactNode } from "react";
import { ThemeToggle } from "./theme-toggle";

const items = [
  { key: "status", label: "运行状态", description: "健康、发送与资源概览", icon: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" },
  { key: "library", label: "队列与素材", description: "管理照片与发送顺序", icon: "M4 3h16v18H4zM4 16l5-5 4 4 3-3 4 4M8 7h.01" },
  { key: "special", label: "特殊素材", description: "成品贺图与独立推送", icon: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z" },
  { key: "history", label: "发送记录", description: "查看投递结果与历史", icon: "M3 11a9 9 0 1 1 2.5 7M3 4v7h7M12 7v5l3 2" },
  { key: "settings", label: "API 与系统配置", description: "定时任务、队列与模型", icon: "M4 7h16M4 17h16M9 4v6M15 14v6" },
];
export function AppFrame({ children, admin, active = "status", busy = false, navigate, logout, refresh }: {
  children: ReactNode; admin: boolean; active?: string; busy?: boolean;
  navigate?: (key: string) => void; logout?: () => void; refresh?: () => void;
}) {
  const current = items.find(item => item.key === active) ?? items[0];
  return <div className={admin ? "app-layout" : "guest-layout"}>
    {admin && <aside className="sidebar">
      <a className="brand" href="/our-days" aria-label="鱼羊日记首页"><span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="3" width="22" height="26" rx="5" /><path d="M10 10h12M10 15h8M11 23h10" /></svg>
      </span><span>鱼羊日记<small>PRIVATE DIARY</small></span></a>
      <p className="nav-caption">工作空间</p>
      <nav className="primary-nav" aria-label="工作区">
        {items.map(item => <a key={item.key} href={item.key === "special" ? "/our-days/special" : `/our-days?view=${item.key}`}
          className={`nav-item${active === item.key ? " active" : ""}`} aria-current={active === item.key ? "page" : undefined}
          aria-disabled={busy || undefined} onClick={event => {
            if (busy) { event.preventDefault(); return; }
            if (navigate && item.key !== "special" && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
              event.preventDefault(); navigate(item.key);
            }
          }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={item.icon} /></svg>
          <span>{item.label}</span></a>)}
      </nav>
      <div className="sidebar-footer"><span className="avatar">A</span><div>管理员<small>admin workspace</small></div>
        {logout && <button className="quiet logout-button" disabled={busy} onClick={logout}>退出</button>}</div>
    </aside>}
    <main className="shell">
      <header className="masthead">
        <div><p className="eyebrow">{admin ? "WORKSPACE / 鱼羊日记" : "鱼羊日记 / PRIVATE DIARY"}</p>
          <h1>{admin ? current.label : "鱼羊日记"}</h1>
          <p className="page-description">{admin ? current.description : "你的照片与每日回忆，在这里管理。"}</p></div>
        <div className="header-actions"><ThemeToggle />
          {refresh && <button className="quiet" disabled={busy} onClick={refresh}>刷新</button>}
          {admin && logout && <button className="quiet mobile-logout" disabled={busy} onClick={logout}>退出</button>}</div>
      </header>
      {children}
    </main>
  </div>;
}
