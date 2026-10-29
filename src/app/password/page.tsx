"use client";

import { useEffect, useState, type FormEvent } from "react";

export default function PasswordPage() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setToken(new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== form.get("confirm")) { setError("两次输入的密码不一致"); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch("/our-days/api/admin/password", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "密码设置失败");
      setToken(""); setDone(true);
    } catch (error) { setError(error instanceof Error ? error.message : "网络异常，请重新提交"); }
    finally { setBusy(false); }
  }
  return <main className="shell"><section className="card login"><h1>设置管理员密码</h1>
    {done ? <><p className="alert" role="status">密码已设置。旧管理员配对码和旧登录状态已失效，以后使用 admin 和新密码登录。</p>
      <a href="/our-days">前往登录并管理照片</a></> : <>
      <p>用户名固定为 <strong>admin</strong>。密码由你自己设置并记住，不需要发到聊天中。</p>
      <p className="muted">至少 12 个字符，建议用密码管理器生成独有的强密码。此设置链接一次有效，完成后失效。</p>
      {error && <p className="alert error" role="alert">{error}</p>}
      {!token ? <p role="status">请使用完整的临时密码设置链接打开此页；刷新会清除临时凭证，可重新打开原链接。</p> :
        <form onSubmit={submit}><fieldset disabled={busy}>
          <label>用户名<input value="admin" readOnly autoComplete="username" /></label>
          <label>新密码<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required /></label>
          <label>再次输入新密码<input name="confirm" type="password" autoComplete="new-password" minLength={12} maxLength={256} required /></label>
          <button>{busy ? "保存中…" : "保存密码"}</button>
        </fieldset></form>}
    </>}
  </section></main>;
}
