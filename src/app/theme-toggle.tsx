"use client";

import { useEffect, useState } from "react";

const key = "our-days-theme";
export function ThemeToggle() {
  const [theme, setTheme] = useState("light");
  const [warning, setWarning] = useState("");
  useEffect(() => {
    const sync = () => setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const systemChanged = () => {
      try {
        if (!localStorage.getItem(key)) {
          document.documentElement.dataset.theme = preference.matches ? "dark" : "light";
          sync();
        }
      } catch { setWarning("浏览器禁止保存外观偏好，本次切换仍然有效"); }
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== key) return;
      document.documentElement.dataset.theme = event.newValue === "dark" ? "dark" :
        event.newValue === "light" ? "light" : preference.matches ? "dark" : "light";
      sync();
    };
    sync();
    preference.addEventListener("change", systemChanged);
    window.addEventListener("storage", storageChanged);
    return () => {
      preference.removeEventListener("change", systemChanged);
      window.removeEventListener("storage", storageChanged);
    };
  }, []);
  function change() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem(key, next); setWarning(""); }
    catch { setWarning("浏览器禁止保存外观偏好，本次切换仍然有效"); }
  }
  return <div className="theme-control">
    <button className="quiet theme-toggle" type="button" onClick={change}
      aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"} title={warning || "切换外观"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        {theme === "dark" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> :
          <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />}
      </svg><span>{theme === "dark" ? "浅色模式" : "深色模式"}</span>
    </button>
    {warning && <span className="theme-warning" role="status">{warning}</span>}
  </div>;
}
