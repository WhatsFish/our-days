"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { SpecialMaterial } from "../../lib/special-media";

const base = "/our-days";
const sendLabels: Record<string, string> = {
  scheduled: "已定时，等待发送", sending: "正在提交", accepted: "平台已接受",
  failed: "失败，未自动重试", unknown: "结果未知，禁止自动重发",
};
type Library = { items: SpecialMaterial[]; total: number; page: number };
async function api<T>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "请求失败");
  return result;
}

export function SpecialWorkspace() {
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [library, setLibrary] = useState<Library | null>(null);
  const [page, setPage] = useState(1);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const refresh = useCallback(async () => {
    const data = await api<Library>(`special?page=${page}`);
    setLibrary(data); setPage(data.page);
  }, [page]);
  useEffect(() => {
    void api<{ role: string | null }>("session").then(data => setRole(data.role))
      .catch(error => setError(error.message)).finally(() => setLoading(false));
    return () => xhrRef.current?.abort();
  }, []);
  useEffect(() => {
    if (role === "admin") void refresh().catch(error => setError(error.message));
  }, [role, refresh]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setBusy(true); setError("");
    try { await api("login", { role: "admin", password }); setRole("admin"); }
    catch (error) { setError(error instanceof Error ? error.message : "登录失败"); }
    finally { setBusy(false); }
  }
  function upload(event: FormEvent) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) return;
    if (!file.size || file.size > 25 * 1024 * 1024) { setError("请选择不超过 25MB 的图片"); return; }
    setBusy(true); setProgress(0); setError(""); setNotice("");
    const xhr = new XMLHttpRequest(); xhrRef.current = xhr;
    xhr.open("POST", `${base}/api/special/upload`); xhr.timeout = 120000;
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) setProgress(Math.min(99, Math.round(event.loaded / event.total * 100)));
    };
    xhr.onload = () => {
      void (async () => {
        try {
          let result: { id?: string; duplicate?: boolean; error?: string };
          try { result = JSON.parse(xhr.responseText); }
          catch { throw new Error("无法确认服务器响应，请刷新特殊素材列表，不要立即重复上传"); }
          if (xhr.status < 200 || xhr.status >= 300) throw new Error(result.error ?? `上传失败（HTTP ${xhr.status}）`);
          if (!result.id) throw new Error("无法确认保存结果，请刷新列表后检查");
          setProgress(100);
          setNotice(result.duplicate ? "这张图已存在于特殊素材库，不会重复保存；尚未安排发送。" :
            "上传成功，成品原图已保存到特殊素材库。没有加入日常队列，也没有自动发送。");
          if (input.current) input.current.value = "";
          setTitle("");
          if (page !== 1) setPage(1); else await refresh();
        } catch (error) { setError(error instanceof Error ? error.message : "上传失败"); }
        finally { setBusy(false); xhrRef.current = null; }
      })();
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => {
      setError("连接中断，无法确定是否保存成功。请先刷新特殊素材列表检查，避免重复上传。");
      setBusy(false); xhrRef.current = null;
    };
    const form = new FormData();
    form.set("file", file); form.set("title", title.trim() || file.name);
    xhr.send(form);
  }
  return <main className="shell">
    <header className="masthead"><h1>鱼羊日记 · 特殊素材</h1><a href={base}>返回管理后台</a></header>
    <p>生日贺图、节日卡片等成品图单独存放在这里，不进入日常照片队列、不参与循环。</p>
    {error && <p className="alert error" role="alert">{error}</p>}
    {notice && <p className="alert" role="status">{notice}</p>}
    {loading ? <p role="status">正在检查登录状态…</p> : role !== "admin" ?
      <section className="card login"><h2>管理员登录</h2><p className="muted">使用现有管理员配对码，收信人不能访问这些素材。</p>
        <form onSubmit={login}><label>管理员配对码<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
          <button disabled={busy}>{busy ? "登录中…" : "登录特殊素材库"}</button></form></section> : <>
      <section className="card"><h2>上传特殊素材</h2>
        <p className="muted">支持静态 JPEG / PNG / WebP，单张最多 25MB。原文件完整保留，预览不加边框、不加文案。这里仅保存素材，定时发送需另行安排。</p>
        <form onSubmit={upload}><fieldset disabled={busy}>
          <label>素材名称<input value={title} onChange={event => setTitle(event.target.value)} maxLength={160} placeholder="例如：生日零点贺图" /></label>
          <label>选择成品图片<input ref={input} type="file" accept=".jpg,.jpeg,.png,.webp" required /></label>
          <button aria-busy={busy}>{busy ? progress < 99 ? `上传中 ${progress}%` : "正在保存…" : "保存到特殊素材库"}</button>
        </fieldset></form>
        {busy && <div role="status"><p>正在上传并保存，请勿关闭页面…</p><progress value={progress} max={100} aria-label="特殊素材上传进度" /></div>}
      </section>
      <section className="card"><div className="section-heading"><h2>已保存的特殊素材 · {library?.total ?? 0} 张</h2>
        <button className="quiet" disabled={busy} onClick={() => {
          setError(""); void refresh().catch(error => setError(error.message));
        }}>刷新列表</button></div>
        {library?.items.map(item => <article className="row" key={item.id}>
          <a href={`${base}/api/special/${item.id}/preview`} target="_blank" rel="noreferrer">
            <img className="mini" src={`${base}/api/special/${item.id}/preview`} alt={item.title} /></a>
          <div><strong>{item.title}</strong><p className="muted">{item.width} × {item.height} · {(Number(item.original_bytes) / 1024 / 1024).toFixed(2)} MB · {new Date(item.created_at).toLocaleString("zh-CN")}</p>
            {!item.sends?.length && <p className="muted">独立保存，尚未安排发送</p>}
            {item.sends?.map(send => <p key={send.id} className="muted">
              {new Date(send.send_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间） ·
              {sendLabels[send.status] ?? send.status}
              {send.error_code ? ` · ${send.error_code}` : ""}
            </p>)}</div>
          <a href={`${base}/api/special/${item.id}/original`}>下载原文件</a>
        </article>)}
        {library && !library.items.length && <p className="empty">暂无特殊素材，上传后会显示在这里。</p>}
        {library && <div className="pagination"><button className="quiet" disabled={busy || page <= 1} onClick={() => setPage(n => n - 1)}>上一页</button>
          <span>第 {library.page} / {Math.max(1, Math.ceil(library.total / 20))} 页</span>
          <button className="quiet" disabled={busy || page * 20 >= library.total} onClick={() => setPage(n => n + 1)}>下一页</button></div>}
      </section>
    </>}
  </main>;
}
