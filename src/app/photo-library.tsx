"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Photo } from "../lib/domain";
import { captureLabel } from "../lib/photo-metadata";

const base = "/our-days";
async function request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${base}/api/${route}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store", signal,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "请求失败");
  return result as T;
}
const statusLabel = (photo: Photo) => photo.used ? "已使用 / 已安排" : photo.approved ? "待发送" : "待确认";
type Page = { photos: Photo[]; total: number; page: number };

export function PhotoLibrary({ aiEnabled, aiWithPhoto, revision, refresh, selectedId, select }: {
  aiEnabled: boolean; aiWithPhoto: boolean; revision: object; refresh: () => Promise<void>;
  selectedId: string | null; select: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Photo | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError("");
    void request<Page>(`photos?page=${page}&status=${filter}&q=${encodeURIComponent(search)}`, undefined, abort.signal)
      .then(result => { setData(result); setPage(result.page); })
      .catch(error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "素材加载失败"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [page, filter, search, reload, revision]);
  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    const abort = new AbortController();
    setSelected(null);
    void request<Photo>(`photo/${selectedId}`, undefined, abort.signal).then(setSelected)
      .catch(error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "照片加载失败"); });
    return () => abort.abort();
  }, [selectedId]);
  const changed = useCallback(async () => { setReload(n => n + 1); await refresh(); }, [refresh]);
  const rows = data?.photos ?? [];
  const selectedIndex = rows.findIndex(photo => photo.id === selectedId);
  return <section className="card library">
    <div className="section-heading"><h2>素材库</h2><span className="muted">{data ? `${data.total} 张符合条件 · 每页 20 张` : "正在加载"}</span></div>
    <form className="library-toolbar" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setPage(1); }}>
      <label>搜索素材<input type="search" value={query} onChange={event => setQuery(event.target.value)} maxLength={120} placeholder="搜索日期、地点、事件说明或文案" /></label>
      <label>状态<select value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }}>
        <option value="all">全部素材</option><option value="unreviewed">待确认</option><option value="ready">待发送</option><option value="used">已使用 / 已安排</option>
      </select></label>
      <button className="quiet">搜索</button>
    </form>
    {error && <p className="alert error" role="alert">{error}<button className="quiet" onClick={() => setReload(n => n + 1)}>重新加载</button></p>}
    {loading && <p role="status">正在加载素材…</p>}
    <div className="table-scroll" aria-busy={loading}>
      <table className="admin-table material-table"><thead><tr><th>照片</th><th>时间 / 地点</th><th>推送文案</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>{rows.map(photo => <tr key={photo.id}>
          <td><button className="thumbnail-button" aria-label={`编辑${photo.date_label || "照片"}`} onClick={() => select(photo.id)}><img className="mini" loading="lazy" src={`${base}/api/media/${photo.id}/thumb`} alt="" /></button></td>
          <td>{photo.date_label || "未填写日期"}<br /><span className="muted">{photo.place_label || "未填写地点"}</span></td>
          <td className="material-caption">{photo.caption || <span className="muted">尚无文案</span>}</td>
          <td><span className="badge">{statusLabel(photo)}</span></td>
          <td><button className="quiet" disabled={loading} onClick={() => select(photo.id)}>编辑</button></td>
        </tr>)}</tbody></table>
    </div>
    {!loading && !error && !rows.length && <p className="empty">没有符合条件的素材。</p>}
    <div className="pagination">
      <button className="quiet" disabled={loading || page <= 1} onClick={() => setPage(n => n - 1)}>上一页</button>
      <span>第 {data?.page ?? page} / {Math.max(1, Math.ceil((data?.total ?? 0) / 20))} 页</span>
      <button className="quiet" disabled={loading || page * 20 >= (data?.total ?? 0)} onClick={() => setPage(n => n + 1)}>下一页</button>
    </div>
    {selectedId && selected && <PhotoDetail key={selected.id} photo={selected} aiEnabled={aiEnabled} aiWithPhoto={aiWithPhoto} refresh={changed}
      close={() => select(null)} previous={selectedIndex > 0 ? () => select(rows[selectedIndex - 1].id) : undefined}
      next={selectedIndex >= 0 && selectedIndex < rows.length - 1 ? () => select(rows[selectedIndex + 1].id) : undefined} />}
    {selectedId && !selected && (error ? <button className="quiet" onClick={() => select(null)}>取消打开照片</button> : <p role="status">正在打开照片…</p>)}
  </section>;
}

function PhotoDetail({ photo, aiEnabled, aiWithPhoto, refresh, close, previous, next }: {
  photo: Photo; aiEnabled: boolean; aiWithPhoto: boolean; refresh: () => Promise<void>; close: () => void;
  previous?: () => void; next?: () => void;
}) {
  const initial = { date_label: photo.date_label || captureLabel(photo.captured_raw), place_label: photo.place_label || photo.metadata_place || "",
    facts: photo.facts, caption: photo.caption, approved: photo.approved };
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [working, setWorking] = useState<"save" | "ai" | "place" | "delete" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [style, setStyle] = useState("温柔");
  const [elapsed, setElapsed] = useState(0);
  const [beforeAI, setBeforeAI] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const workingRef = useRef(working); workingRef.current = working;
  function leave(action: () => void) {
    if (workingRef.current) return;
    if (!dirtyRef.current || window.confirm("有尚未保存的修改，放弃修改并离开？")) action();
  }
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirtyRef.current || workingRef.current) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    if (working !== "ai") return;
    const timer = setInterval(() => setElapsed(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, [working]);
  async function run(kind: NonNullable<typeof working>, work: () => Promise<void>) {
    setWorking(kind); setError(""); setFeedback("");
    try { await work(); }
    catch (error) { setError(error instanceof Error ? error.message : "操作失败，请重试"); }
    finally { setWorking(null); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await run("save", async () => {
      await request("photo", { id: photo.id, ...form });
      setSaved(form);
      setFeedback(form.approved ? "已保存，素材已确认。历史发送内容不会改变。" : "已保存草稿，尚未加入待发送队列。");
      await refresh();
    });
  }
  const hasGPS = photo.latitude != null && photo.longitude != null;
  return <dialog ref={dialog} className="photo-dialog" aria-labelledby="photo-editor-title" onCancel={event => { event.preventDefault(); leave(close); }}>
    <div className="editor-header"><div><h2 id="photo-editor-title">编辑素材</h2><span className="muted">{statusLabel(photo)}{dirty ? " · 有未保存修改" : ""}</span></div>
      <div className="actions"><button className="quiet" disabled={!!working || !previous} onClick={() => previous && leave(previous)}>上一张</button>
        <button className="quiet" disabled={!!working || !next} onClick={() => next && leave(next)}>下一张</button>
        <button className="quiet" disabled={!!working} onClick={() => leave(close)}>关闭</button></div></div>
    <form onSubmit={save}>
      <fieldset disabled={!!working} className="editor-body">
        <aside className="editor-photo"><img src={`${base}/api/media/${photo.id}/display`} alt="当前素材" />
          <details><summary>原始拍摄信息</summary><p>拍摄时间：{photo.captured_raw || "原图未提供"}<br />GPS：{hasGPS ? "已识别" : "原图未提供"}</p>
            <p>原图信息仅供参考；手动补充后会随保存生效。</p></details>
          {!photo.used && <details className="delete-section"><summary>删除素材</summary><p>永久删除原图，不可恢复。</p>
            <button type="button" className="quiet danger" onClick={() => {
              if (window.confirm("永久删除这张未使用的照片及原图？")) void run("delete", async () => {
                await request("photo/delete", { id: photo.id }); await refresh(); close();
              });
            }}>永久删除</button></details>}
        </aside>
        <div className="editor-fields">
          <div className="form-grid"><label>拍摄时间<input value={form.date_label} maxLength={80} placeholder="可手动补充"
            onChange={event => setForm({ ...form, date_label: event.target.value })} /></label>
            <label>地点<input value={form.place_label} maxLength={120} placeholder="城市或景点"
              onChange={event => setForm({ ...form, place_label: event.target.value })} /></label></div>
          {hasGPS && <button type="button" className="quiet" onClick={() => {
            if (window.confirm("将约百米精度的 GPS 发送给 OpenStreetMap / Nominatim 解析城市？不发送照片。")) void run("place", async () => {
              const result = await request<{ place: string; source: string }>("photo/place", { id: photo.id, consent: true });
              setForm({ ...form, place_label: result.place }); setFeedback(`城市已填入，请核对后保存。${result.source} · © OpenStreetMap contributors`);
            });
          }}>根据 GPS 解析城市</button>}
          <label htmlFor="photo-facts">当时发生了什么</label><textarea id="photo-facts" value={form.facts} maxLength={3000} onChange={event => setForm({ ...form, facts: event.target.value })}
            placeholder="补充照片背后的真实经历，AI 会结合画面写文案；这段说明不会直接印在照片上。" />
          <div className="ai-toolbar"><div><label htmlFor="caption-style">文案风格</label><select id="caption-style" value={style} onChange={event => setStyle(event.target.value)}><option>温柔</option><option>朴实</option><option>俏皮</option></select></div>
            <button type="button" className="quiet" disabled={!aiEnabled || (!aiWithPhoto && !form.facts.trim())} aria-busy={working === "ai"} onClick={() => {
              if (form.caption.trim() && !window.confirm("AI 生成成功后会替换当前文案草稿（可撤销），是否继续？")) return;
              setElapsed(0);
              void run("ai", async () => {
                const result = await request<{ draft: string }>("ai", { id: photo.id, style, facts: form.facts,
                  date_label: form.date_label, place_label: form.place_label, consent: true });
                setBeforeAI(form.caption); setForm({ ...form, caption: result.draft, approved: false });
                setFeedback("AI 文案已填入下方。核对或修改后，保存草稿或确认加入队列。");
              });
            }}>{working === "ai" ? `生成中 · ${elapsed} 秒` : "AI 生成并填入文案"}</button></div>
          <p className="muted">{aiEnabled ? aiWithPhoto ?
            "看图生成：发送去掉 EXIF/GPS 的压缩照片，以及当前事件说明、拍摄时间和地点。背景可留空，无需先保存；模型请求超时为 60 秒。" :
            "当前模型使用纯文字：只发送事件说明和填写的时间地点，不发送照片。无需先保存；模型请求超时为 30 秒。" :
            "AI 尚未启用，请到「API 与系统配置」保存密钥并启用。手写文案不受影响。"}</p>
          <label htmlFor="photo-caption">推送文案</label><textarea id="photo-caption" className="caption-input" value={form.caption} maxLength={3000}
            onChange={event => setForm({ ...form, caption: event.target.value, approved: false })} placeholder="实际印在照片下方的文字，也可以直接手写。" />
          {beforeAI !== null && <button type="button" className="quiet" onClick={() => { setForm({ ...form, caption: beforeAI, approved: false }); setBeforeAI(null); setFeedback("已恢复生成前的文案草稿。"); }}>撤销 AI 填入</button>}
          <label className="check"><input type="checkbox" checked={form.approved} onChange={event => setForm({ ...form, approved: event.target.checked })} />已核对内容，保存后加入待发送队列{photo.used ? "（已使用素材不会重复发送）" : ""}</label>
        </div>
      </fieldset>
      <div className="editor-footer">
        <div aria-live="polite">{working && <p role="status">{working === "ai" ? `正在生成文案 · ${elapsed} 秒，请稍候…` : working === "save" ? "正在保存…" : working === "place" ? "正在解析城市…" : "正在删除…"}</p>}
          {error && <p className="alert error" role="alert">{error}。当前草稿已保留。</p>}
          {feedback && <p className="alert" role="status">{feedback}</p>}</div>
        <div className="actions"><button disabled={!!working}>{working === "save" ? "保存中…" : form.approved ? "保存并确认素材" : "保存草稿"}</button>
          <button type="button" className="quiet" disabled={!!working} onClick={() => setPreview(!preview)}>{preview ? "收起预览" : "预览当前草稿"}</button>
          <span className="muted">{dirty ? "尚未保存" : "无未保存修改"}</span></div>
        {preview && <div className="draft-preview"><img src={`${base}/api/media/${photo.id}/display`} alt="草稿照片" />
          <p className="muted">{[form.date_label, form.place_label].filter(Boolean).join(" · ")}</p><p className="caption">{form.caption || "尚无文案"}</p>
          <p className="muted">内容预览；实际推送使用拍立得图片排版。</p></div>}
      </div>
    </form>
  </dialog>;
}
