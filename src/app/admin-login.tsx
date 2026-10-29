"use client";

import { useState, type FormEvent } from "react";

export function AdminLogin({ busy, submit }: { busy: boolean; submit: (event: FormEvent<HTMLFormElement>) => void }) {
  const [reader, setReader] = useState(false);
  return <section className="login card">
    <h2>{reader ? "收信人登录" : "管理员登录"}</h2>
    <form onSubmit={submit}>
      <input type="hidden" name="role" value={reader ? "reader" : "admin"} />
      {!reader && <label>用户名<input name="username" defaultValue="admin" autoComplete="username" required maxLength={80}
        autoCapitalize="none" spellCheck={false} /></label>}
      <label>{reader ? "收信人配对码" : "密码"}<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
      <button disabled={busy}>{busy ? "登录中…" : "登录"}</button>
    </form>
    {!reader && <p className="muted">用户名固定为 admin，使用你自己设置的密码，可在任意设备登录。登录状态保留 7 天，过期后重新输入密码即可。</p>}
    <button className="quiet" type="button" disabled={busy} onClick={() => setReader(!reader)}>{reader ? "返回管理员登录" : "收信人入口"}</button>
  </section>;
}
