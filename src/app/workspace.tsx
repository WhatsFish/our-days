"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Edition, Photo, Settings, Snapshot } from "../lib/domain";
import type { PublicAI } from "../lib/ai-config";
import { captureLabel } from "../lib/photo-metadata";
import { UploadPanel } from "./upload-panel";

type Role = "admin" | "reader" | null;
type ImportJob = { id: string; status: string; added: number; duplicates: number; errors: string[] };
type Delivery = { id: string; edition_id: string; day: string; status: string; error_code: string | null; attempts: number };
type Dashboard = {
  photos: Photo[]; editions: Edition[]; imports: ImportJob[]; deliveries: Delivery[];
  settings: Settings; worker: { last_tick: string | null; error_code: string | null } | null;
  bytes: number; quotaMb: number; pushEnabled: boolean; pushReady: boolean; pushChannel: string; aiEnabled: boolean; aiCost: string;
  ai: PublicAI;
  nextPhotoId: string | null;
};
const base = "/our-days";
const labels: Record<string, string> = {
  queued: "等待导入", processing: "正在导入", done: "已处理", failed: "失败",
  scheduled: "已排期", cancelled: "已取消", published: "已发布",
  pending: "等待发送", sending: "正在提交", accepted: "平台已接受（不代表已读）",
  delivered: "渠道报告送达（不代表已读）", unknown: "状态未知，禁止自动重发", disabled: "仅网页发布，未发送通知",
};
async function api<T>(route: string, data?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/${route}`, {
    method: data === undefined ? "GET" : "POST",
    headers: data instanceof FormData ? undefined : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
    cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "请求失败");
  return body as T;
}
const value = (form: FormData, key: string) => String(form.get(key) ?? "");

export function Workspace() {
  const [role, setRole] = useState<Role>(null);
  const [loading, setLoading] = useState(true);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [editions, setEditions] = useState<Edition[]>([]);
  const [tab, setTab] = useState("letters");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async (current: Role) => {
    if (!current) return;
    const rows = await api<Edition[]>("editions");
    setEditions(rows);
    if (current === "admin") setDashboard(await api<Dashboard>("admin"));
  }, []);
  const refreshUploads = useCallback(() => refresh("admin"), [refresh]);
  useEffect(() => {
    void api<{ role: Role }>("session").then(async session => {
      setRole(session.role);
      setTab(session.role === "admin" ? "library" : "letters");
      await refresh(session.role);
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [refresh]);
  const pending = dashboard?.imports.some(job => ["queued", "processing"].includes(job.status));
  useEffect(() => {
    if (!pending || role !== "admin" || busy) return;
    const timer = setInterval(() => { void refresh(role).catch(e => setError(e.message)); }, 5000);
    return () => clearInterval(timer);
  }, [pending, role, busy, refresh]);
  async function perform(work: () => Promise<void>, message = "已保存", refreshAfter = true) {
    setBusy(true); setError(""); setNotice("");
    try { await work(); if (refreshAfter) await refresh(role); setNotice(message); }
    catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await perform(async () => {
      const session = await api<{ role: Role }>("login", { role: value(form, "role"), password: value(form, "password") });
      setRole(session.role); setTab(session.role === "admin" ? "library" : "letters"); await refresh(session.role);
    }, "已安全配对");
  }
  if (loading) return <main className="shell"><p className="eyebrow">OUR DAYS</p><h1>正在打开信箱…</h1></main>;
  return <main className="shell">
    <header className="masthead"><div><p className="eyebrow">OUR DAYS / A PRIVATE COLLECTION</p><h1>拾光<span>把平凡的日子，慢慢收藏。</span></h1></div>
      {role && <button className="quiet" disabled={busy} onClick={() => void perform(async () => {
        await api("logout", {}); setRole(null); setDashboard(null); setEditions([]);
      }, "已退出", false)}>退出</button>}
    </header>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert" role="status">{notice}</div>}
    {!role ? <section className="login card">
      <p className="eyebrow">ONLY FOR YOU</p><h2>有些回忆，只想与你分享。</h2>
      <p className="muted">输入单独交给你的配对码。这里的照片不会向访客开放。</p>
      <form onSubmit={signIn}>
        <label>身份<select name="role"><option value="reader">收信人</option><option value="admin">管理照片与来信</option></select></label>
        <label>配对码<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
        <button disabled={busy}>打开信箱</button>
      </form>
    </section> : <>
      <nav className="tabs" aria-label="工作区">
        {(role === "admin" ? [["library", "素材库"], ["history", "发送记录"], ["settings", "设置"]] : [["letters", "回忆相册"]]).map(([key, name]) =>
          <button key={key} disabled={busy} aria-current={tab === key ? "page" : undefined} className={tab === key ? "active" : "quiet"} onClick={() => setTab(key)}>{name}</button>)}
        <button className="quiet refresh" disabled={busy} onClick={() => void perform(async () => {}, "已刷新")}>刷新</button>
      </nav>
      {tab === "letters" && <LetterBox editions={editions} busy={busy} favorite={edition => perform(async () => {
        await api("favorite", { id: edition.id, favorite: !edition.favorite });
      })} />}
      {role === "admin" && dashboard && <>
        <div className="statusbar">
          <span>{dashboard.settings.paused ? "每日自动发送：已暂停" : `每日自动发送：${dashboard.settings.send_time}`}</span>
          <span>{dashboard.pushChannel === "wecom" && dashboard.pushReady ? "企业微信图片通道已配置" : "自动发图通道尚未配置"}</span>
          <span>{(dashboard.bytes / 1024 / 1024).toFixed(1)} / {dashboard.quotaMb} MB</span>
        </div>
        {tab === "library" && <>
          <section className="card">
            <h2>维护素材，其余交给每天的发送任务。</h2>
            <p>待发送 <strong>{dashboard.photos.filter(photo => photo.approved && !photo.used).length}</strong> 张 · 待确认 <strong>{dashboard.photos.filter(photo => !photo.approved).length}</strong> 张</p>
            <p className="muted">填好照片信息和文案，确认“加入待发送”。系统每天按加入顺序选一张未使用的素材，不需要逐日排期，不会自动重复旧照片。素材用完会在运行状态中提示。</p>
            {dashboard.nextPhotoId && <div className="row">
              <img className="mini" src={`${base}/api/media/${dashboard.nextPhotoId}/thumb`} alt="下一张待发送照片" />
              <div><strong>下一张</strong><p className="muted">{dashboard.photos.find(photo => photo.id === dashboard.nextPhotoId)?.caption.slice(0, 60)}</p></div>
            </div>}
            {dashboard.settings.paused && <p className="muted">当前暂停。准备好后在「设置」选择每日时间并开启自动发送。</p>}
          </section>
          <UploadPanel jobs={dashboard.imports} busy={busy} perform={perform} refresh={refreshUploads} />
          {!dashboard.photos.length && <p className="empty">照片库还是空的。第一封来信，从一张照片开始。</p>}
          <div className="photo-grid">{dashboard.photos.map(photo => <PhotoEditor key={photo.id} photo={photo} busy={busy}
            aiEnabled={dashboard.aiEnabled} perform={perform} />)}</div>
        </>}
        {tab === "history" && <SendHistory dashboard={dashboard} busy={busy} perform={perform} />}
        {tab === "settings" && <SettingsPanel dashboard={dashboard} busy={busy} perform={perform} />}
      </>}
    </>}
    <footer>照片与文字仅限已配对的设备查看。传统宜忌与星座小笺仅作民俗、娱乐参考，不构成决策建议。</footer>
  </main>;
}

type Perform = (work: () => Promise<void>, message?: string) => Promise<void>;
function PhotoEditor({ photo, busy, aiEnabled, perform }: { photo: Photo; busy: boolean; aiEnabled: boolean; perform: Perform }) {
  const [preview, setPreview] = useState(false);
  const [draft, setDraft] = useState("");
  const [consent, setConsent] = useState(false);
  const [style, setStyle] = useState("温柔");
  const [placeDraft, setPlaceDraft] = useState(photo.place_label || photo.metadata_place || "");
  const [placeSource, setPlaceSource] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ error: boolean; message: string } | null>(null);
  useEffect(() => { setPlaceDraft(photo.place_label || photo.metadata_place || ""); }, [photo.place_label, photo.metadata_place]);
  const inferredDate = captureLabel(photo.captured_raw);
  return <article className="card photo-card">
    <img src={`${base}/api/media/${photo.id}/thumb`} alt="私密照片预览" loading="lazy" />
    <div className="badge">{photo.used ? "已安排或生成发送记录" : photo.approved ? "待发送" : "待确认"}</div>
    <details><summary>原始信息（仅管理者可见）</summary><p>拍摄时间：{photo.captured_raw || "未找到 EXIF 拍摄时间"}<br />GPS：{photo.latitude == null || photo.longitude == null ? "未找到" : `${photo.latitude}, ${photo.longitude}`}</p>
      <p className="muted">有 EXIF 拍摄时间或内嵌地点时自动预填，不按服务器时区转换。GPS 不会自动发送给外部地图，需点击下方按钮并同意。</p></details>
    <form key={`${photo.caption}:${photo.date_label}:${photo.place_label}:${photo.facts}:${photo.approved}`}
      onChange={() => setSaveFeedback(null)} onSubmit={event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      setSaving(true); setSaveFeedback(null);
      void perform(async () => {
        try {
          await api("photo", {
            id: photo.id, date_label: value(form, "date_label"), place_label: value(form, "place_label"),
            facts: value(form, "facts"), caption: value(form, "caption"), approved: form.has("approved"),
          });
          setSaveFeedback({ error: false, message: `已保存 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}` });
        } catch (error) {
          setSaveFeedback({ error: true, message: error instanceof Error ? error.message : "保存失败，请重试" });
          throw error;
        } finally { setSaving(false); }
      });
    }}>
      <fieldset disabled={busy} className="min-w-0">
      <label>拍摄时间（可修改）<input name="date_label" defaultValue={photo.date_label || inferredDate} maxLength={80} placeholder="例如：大约 2019 年秋天" /></label>
      <p className="muted">{inferredDate ? "已从 EXIF 拍摄时间提取候选，请核对；缺失的时区不作推断。" : "照片未提供可识别的原始拍摄时间；微信转发、截图或导出可能移除 EXIF。建议上传相机原图，或手动补充。"}</p>
      <label>地点<input name="place_label" value={placeDraft} onChange={event => setPlaceDraft(event.target.value)} maxLength={120} placeholder="城市 / 景点；不知道可以留空" /></label>
      <p className="muted">{photo.metadata_place ? "已提取照片内嵌地点，请核对。" : photo.latitude !== null && photo.longitude !== null ? "照片含 GPS，可按需解析为城市；不会从图片画面猜测地址。" : "照片未提供 GPS 或内嵌地点，无法自动还原地址。"}</p>
      {photo.latitude !== null && photo.longitude !== null && <button type="button" className="quiet" disabled={busy} onClick={() => {
        if (window.confirm("将照片 GPS 四舍五入到约百米精度后，发送给 OpenStreetMap / Nominatim 解析城市？不发送原图。候选地点需核对后手动保存。")) {
          void perform(async () => {
            const result = await api<{ place: string; source: string }>("photo/place", { id: photo.id, consent: true });
            setPlaceDraft(result.place); setPlaceSource(result.source); setSaveFeedback(null);
          }, "城市候选已填入；核对后点击照片的保存按钮");
        }
      }}>根据 GPS 解析城市</button>}
      {placeSource && <p className="muted">{placeSource} · 地图数据 © OpenStreetMap contributors</p>}
      <label>当时发生了什么<textarea name="facts" defaultValue={photo.facts} maxLength={3000} placeholder="只写你确认的事实。供整理与 AI 润色使用，不直接展示给收信人。" /></label>
      <label>给她的文案<textarea name="caption" defaultValue={photo.caption} maxLength={3000} placeholder="想对她说的话…" /></label>
      <label className="check"><input type="checkbox" name="approved" defaultChecked={photo.approved} />信息和文案已确认，加入待发送素材</label>
      <div className="actions">
        <button disabled={busy} aria-busy={saving}>{saving ? "保存中…" : "保存"}</button>
        <button type="button" className="quiet" onClick={() => setPreview(!preview)}>预览已保存内容</button>
      </div>
      </fieldset>
      <div aria-live="polite" aria-atomic="true">
        {saving && <p className="muted" role="status">正在保存，请稍候…</p>}
        {!saving && saveFeedback && <p className={saveFeedback.error ? "alert error" : "alert"} role={saveFeedback.error ? "alert" : "status"}>
          {saveFeedback.message}{saveFeedback.error ? "；请检查后重新保存。" : photo.used ? "，历史发送内容保持不变，不会自动重发。" : photo.approved ? "，已加入待发送素材。" : "，确认内容后可勾选加入待发送。"}
        </p>}
      </div>
    </form>
    {preview && <Letter snapshot={{ photo_id: photo.id, date_label: photo.date_label, place_label: photo.place_label, caption: photo.caption, weather: "", almanac: "", star_note: "" }} title="来信预览" />}
    <details><summary>AI 帮我润色（可选）</summary>
      <p className="muted">先保存事件说明。只发送已保存的说明文字，不发送原图；AI 候选不会自动写入或批准。API Key 和模型请在「设置与投递 → AI 服务配置」填写。</p>
      <label>风格<select value={style} onChange={event => setStyle(event.target.value)}><option>温柔</option><option>朴实</option><option>俏皮</option></select></label>
      <label className="check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />本次同意把已保存的说明交给配置的 AI 服务</label>
      <button disabled={busy || !aiEnabled || !consent} onClick={() => void perform(async () => {
        const result = await api<{ draft: string }>("ai", { id: photo.id, style, consent: true }); setDraft(result.draft); setConsent(false);
      }, "候选已生成，请挑选、修改后手动保存")}>{aiEnabled ? "生成候选文案" : "AI 尚未配置"}</button>
      {draft && <pre className="draft">{draft}</pre>}
    </details>
    {!photo.used && <button className="quiet danger" disabled={busy} onClick={() => {
      if (window.confirm("永久删除这张未使用的照片及原图？")) void perform(async () => { await api("photo/delete", { id: photo.id }); }, "已删除");
    }}>删除未使用照片</button>}
  </article>;
}

function Letter({ snapshot, title }: { snapshot: Snapshot; title: string }) {
  return <article className="letter">
    <p className="eyebrow">A MOMENT TO KEEP</p><h2>{title}</h2>
    <img className="letter-photo" src={`${base}/api/media/${snapshot.photo_id}/display`} alt="这一封来信里的照片" />
    <p className="dateline">{[snapshot.date_label, snapshot.place_label].filter(Boolean).join(" · ") || "有些瞬间，不必记得确切的日期。"}</p>
    <p className="caption">{snapshot.caption || "文案还在准备中。"}</p>
    {(snapshot.weather || snapshot.almanac || snapshot.star_note) && <aside><h3>也记得照顾今天的自己</h3>
      {snapshot.weather && <p>{snapshot.weather}</p>}{snapshot.almanac && <p>{snapshot.almanac}</p>}
      {snapshot.star_note && <p>今日小笺：{snapshot.star_note}</p>}</aside>}
  </article>;
}

function LetterBox({ editions, busy, favorite }: { editions: Edition[]; busy: boolean; favorite: (edition: Edition) => Promise<void> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  useEffect(() => { setSelected(new URLSearchParams(window.location.search).get("edition")); }, []);
  const visible = onlyFavorites ? editions.filter(e => e.favorite) : editions;
  const current = selected ? editions.find(e => e.id === selected) : visible[0];
  return <div className="reader">
    <section className="card reader-main">
      {current?.snapshot ? <><Letter snapshot={current.snapshot} title={current.title} />
        <div className="actions"><span className="muted">{current.day}</span><button disabled={busy} className="quiet" onClick={() => void favorite(current)}>{current.favorite ? "已收藏 · 取消" : "收藏这一天"}</button></div></> :
        <div className="empty"><h2>{selected ? "这封来信尚未解锁" : "下一封来信，正在路上。"}</h2><p>准备好的那一天，它会出现在这里。</p></div>}
    </section>
    <aside className="card archive"><h2>已经走过的日子</h2><label className="check"><input type="checkbox" checked={onlyFavorites} onChange={e => { setOnlyFavorites(e.target.checked); setSelected(null); }} />只看收藏</label>
      {visible.map(e => <button key={e.id} className={`archive-link ${current?.id === e.id ? "chosen" : ""}`} onClick={() => setSelected(e.id)}><span>{e.day}</span>{e.title}</button>)}
    </aside>
  </div>;
}

function SettingsPanel({ dashboard: d, busy, perform }: { dashboard: Dashboard; busy: boolean; perform: Perform }) {
  const s = d.settings;
  const [feedback, setFeedback] = useState("");
  return <section className="card">
    <h2>每天什么时候发送？</h2>
    <p className="muted">每天一张，从已确认、未使用的素材中按加入顺序自动选择。你不需要给照片指定日期。开启后从下一个发送时间开始，不补发过去的日子；素材用完会停止，不会反复发送旧照片。</p>
    <form className="form-grid" onSubmit={event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      if (s.paused && form.has("enabled") && !window.confirm("确认开启每日自动发图？将从下一个发送时间开始，每天向服务器已配置的接收者发送一张已确认素材。")) return;
      const coordinate = (key: string) => value(form, key).trim() === "" ? null : Number(value(form, key));
      setFeedback("");
      void perform(async () => {
        try { await api("settings", {
        timezone: value(form, "timezone"), send_time: value(form, "send_time"), paused: !form.has("enabled"),
        weather_lat: coordinate("weather_lat"), weather_lon: coordinate("weather_lon"), weather_city: value(form, "weather_city"),
        almanac: form.has("almanac"), star_note: value(form, "star_note"),
        }); setFeedback("设置已保存"); }
        catch (error) { setFeedback(error instanceof Error ? error.message : "保存失败"); throw error; }
      });
    }}>
      <label>每日发送时间<input name="send_time" type="time" defaultValue={s.send_time} required /></label>
      <label className="check"><input name="enabled" type="checkbox" defaultChecked={!s.paused} disabled={!d.pushEnabled || !d.pushReady || d.pushChannel !== "wecom"} />开启每日自动发送</label>
      <p className="muted wide">当前按 {s.timezone === "Asia/Shanghai" ? "北京时间" : s.timezone} 发送。时区是“几点”的计算规则，不是第二份排期。</p>
      <details className="wide"><summary>可选：天气、每日小笺与时区</summary>
      <label>时区（默认北京时间，一般不用修改）<input name="timezone" defaultValue={s.timezone} required /></label>
      <label>天气城市（不需要可留空）<input name="weather_city" defaultValue={s.weather_city} maxLength={80} /></label>
      <div className="form-grid"><label>城市纬度<input name="weather_lat" type="number" step="any" min="-90" max="90" defaultValue={s.weather_lat ?? ""} /></label>
        <label>城市经度<input name="weather_lon" type="number" step="any" min="-180" max="180" defaultValue={s.weather_lon ?? ""} /></label></div>
      <p className="muted wide">填写的是城市位置，不是她的实时位置。配置后会向 Open-Meteo 请求该城市天气；清空经纬度即可关闭。</p>
      <label className="check wide"><input type="checkbox" name="almanac" defaultChecked={s.almanac} />展示农历与传统宜忌</label>
      <label className="wide">每日小笺（可留空；首版由你编辑，不伪造运势）<textarea name="star_note" maxLength={300} defaultValue={s.star_note} /></label>
      </details>
      <button disabled={busy}>保存设置</button>
      {feedback && <p className="wide alert" role="status">{feedback}</p>}
    </form>
    <hr /><AISettingsPanel config={d.ai} busy={busy} perform={perform} />
    <hr /><details><summary>高级：运行状态与成本</summary>
    <p>最近任务成功：{d.worker?.last_tick ? new Date(d.worker.last_tick).toLocaleString() : "尚未运行"}{d.worker?.error_code && <span className="error-text">错误：{d.worker.error_code}</span>}</p>
    <p>本月 AI 记录 / 预留：${Number(d.aiCost).toFixed(4)}</p>
    <p className="muted">发送通道：{d.pushChannel === "wecom" ? "企业微信应用图片 → 普通微信插件" : "旧版通道（尚未切换）"}。密钥由服务器私密保存；投递状态请看「发送记录」。没有已读追踪。</p>
    </details>
  </section>;
}

function SendHistory({ dashboard: d, busy, perform }: { dashboard: Dashboard; busy: boolean; perform: Perform }) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  return <section className="card">
    <h2>发送记录</h2>
    <p className="muted">这里记录系统生成了什么、是否提交给消息平台，以及失败原因。“平台已接受”不等于手机已收到或对方已读。之前用独立脚本手动发送的演示图不在这里，也不会伪造历史记录。</p>
    {!d.editions.length && <p className="empty">还没有自动发送记录。准备素材并开启每日发送后，这里会出现真实记录。</p>}
    {d.editions.map(edition => {
      const delivery = d.deliveries.find(item => item.edition_id === edition.id);
      return <article key={edition.id}>
        <div className="row">
          <img className="mini" src={`${base}/api/media/${edition.photo_id}/thumb`} alt="" />
          <div><strong>{edition.day}</strong><p className="muted">{delivery ? labels[delivery.status] : edition.status === "scheduled" ? "已指定日期，等待任务" : edition.status === "cancelled" ? "已取消" : "内容已生成，尚无投递记录"}{delivery?.error_code ? ` · ${delivery.error_code}` : ""}</p></div>
          {edition.snapshot && <button className="quiet" onClick={() => setPreviewId(previewId === edition.id ? null : edition.id)}>查看内容</button>}
          {edition.status === "scheduled" && <button className="quiet" disabled={busy} onClick={() => void perform(async () => { await api("cancel", { id: edition.id }); }, "已取消指定日期内容")}>取消</button>}
          {delivery?.status === "failed" && delivery.attempts < 3 && <button className="quiet" disabled={busy} onClick={() => {
            if (window.confirm("确认这条消息未送达并重试？仅支持今天的失败记录，会真实发送消息。")) void perform(async () => { await api("delivery/retry", { id: delivery.id, confirm: true }); }, "已加入重试队列");
          }}>重试</button>}
        </div>
        {previewId === edition.id && edition.snapshot && <Letter snapshot={edition.snapshot} title={edition.title} />}
      </article>;
    })}
  </section>;
}

function AISettingsPanel({ config, busy, perform }: { config: PublicAI; busy: boolean; perform: Perform }) {
  const [provider, setProvider] = useState(config.provider);
  const [apiKey, setApiKey] = useState("");
  const [connection, setConnection] = useState("");
  return <section>
    <h2>AI 服务配置</h2>
    <p className="muted">仅管理员可配置。密钥保存在服务器私密配置中，不会回显给浏览器或提供给收信人。保存配置不会自动调用模型、发送照片或启用微信推送。</p>
    <p className="muted">DeepSeek API Key：<a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">打开官方申请页面</a> · <a href="https://api-docs.deepseek.com/quick_start/pricing" target="_blank" rel="noreferrer">查看模型与计费文档</a></p>
    <form key={JSON.stringify(config)} className="form-grid" onSubmit={event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      void perform(async () => {
        await api("ai/config", {
          provider, apiKey, enabled: form.has("enabled"), clearKey: form.has("clearKey"),
          model: value(form, "model"),
          inputRate: Number(value(form, "inputRate")), outputRate: Number(value(form, "outputRate")),
          monthlyLimit: Number(value(form, "monthlyLimit")),
        });
        setApiKey(""); setConnection("");
      }, "AI 配置已保存；密钥不会回显，可先测试连接");
    }}>
      <label>供应商<select name="provider" value={provider} onChange={event => {
        setProvider(event.target.value === "openai" ? "openai" : "deepseek"); setApiKey(""); setConnection("");
      }}><option value="deepseek">DeepSeek（官方 API）</option><option value="openai">OpenAI（官方 API）</option></select></label>
      <label>模型 ID<input name="model" defaultValue={config.model} required maxLength={120} placeholder="按供应商模型文档填写" /></label>
      <label className="wide">API Key（{config.keyConfigured ? "已保存；留空保留，更换供应商需新密钥" : "尚未配置"}）
        <input name="apiKey" type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} maxLength={512} placeholder={config.keyConfigured ? "填写新密钥以替换；不会显示旧值" : "粘贴你的 API Key"} /></label>
      <label>输入单价（美元 / 百万 tokens）<input name="inputRate" type="number" min="0" max="10000" step="any" defaultValue={config.inputRate} required /></label>
      <label>输出单价（美元 / 百万 tokens）<input name="outputRate" type="number" min="0" max="10000" step="any" defaultValue={config.outputRate} required /></label>
      <p className="muted wide">按官方当前价格填写美元单价；若输入有缓存价，使用较高的未命中价作保守估算。不自动猜价格，也不进行人民币换算。</p>
      <label>每月预算上限（美元）<input name="monthlyLimit" type="number" min="0.01" max="1000" step="any" defaultValue={config.monthlyLimit} required /></label>
      <label className="check"><input name="enabled" type="checkbox" defaultChecked={config.enabled} />启用文字文案生成（每次生成仍需单独同意）</label>
      <label className="check wide"><input name="clearKey" type="checkbox" />删除已保存的密钥（请同时关闭 AI）</label>
      <button disabled={busy}>保存 AI 配置</button>
    </form>
    <button className="quiet" disabled={busy || !config.keyConfigured} onClick={() => void perform(async () => {
      const result = await api<{ message: string }>("ai/test", { confirm: true }); setConnection(result.message);
    }, "AI 连接检查完成")}>测试已保存配置（不生成文案）</button>
    {connection && <p role="status">{connection}</p>}
    <p className="muted">生成草稿只发送你主动同意的事件说明，不上传照片或 GPS；生成结果仍由你审核。预算按 token 单价估算，并非供应商账单的硬性封顶。</p>
  </section>;
}
