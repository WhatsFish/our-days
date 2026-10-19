"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Edition, Photo, Settings, Snapshot } from "../lib/domain";
import type { PublicAI } from "../lib/ai-config";
import { UploadPanel } from "./upload-panel";
import { PhotoLibrary } from "./photo-library";
import { aiPricing, GLM_FLASH_MODEL, supportsPhotoCaption } from "../lib/ai-policy";
import type { OperatorCounts, Resources } from "../lib/operator-status";

type Role = "admin" | "reader" | null;
type ImportJob = { id: string; status: string; added: number; duplicates: number; errors: string[] };
type Delivery = { id: string; edition_id: string; day: string; status: string; error_code: string | null; attempts: number };
type Dashboard = {
  editions: Edition[]; imports: ImportJob[]; deliveries: Delivery[];
  settings: Settings; worker: { last_tick: string | null; error_code: string | null } | null;
  bytes: number; quotaMb: number; pushEnabled: boolean; pushReady: boolean; pushChannel: string; aiEnabled: boolean; aiCost: string;
  ai: PublicAI;
  aiUnknownCost: number;
  nextPhotoId: string | null;
  stats: OperatorCounts;
  resources: Resources;
  queue: Pick<Photo, "id" | "date_label" | "place_label" | "caption">[];
  health: { healthy: boolean; reason: string };
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
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
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
      setTab(session.role === "admin" ? "status" : "letters");
      await refresh(session.role);
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [refresh]);
  const pending = dashboard?.imports.some(job => ["queued", "processing"].includes(job.status));
  useEffect(() => {
    if ((!pending && tab !== "status") || role !== "admin" || busy) return;
    const timer = setInterval(() => { void refresh(role).catch(e => setError(e.message)); }, pending ? 5000 : 30000);
    return () => clearInterval(timer);
  }, [pending, role, busy, refresh, tab]);
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
      setRole(session.role); setTab(session.role === "admin" ? "status" : "letters"); await refresh(session.role);
    }, "已安全配对");
  }
  if (loading) return <main className="shell"><h1>加载中…</h1></main>;
  return <main className="shell">
    <header className="masthead"><h1>{role === "reader" ? "照片记录" : "照片推送管理"}</h1>
      {role && <button className="quiet" disabled={busy} onClick={() => void perform(async () => {
        await api("logout", {}); setRole(null); setDashboard(null); setEditions([]);
      }, "已退出", false)}>退出</button>}
    </header>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert" role="status">{notice}</div>}
    {!role ? <section className="login card">
      <h2>登录</h2>
      <form onSubmit={signIn}>
        <label>身份<select name="role"><option value="reader">收信人</option><option value="admin">管理照片与来信</option></select></label>
        <label>配对码<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
        <button disabled={busy}>登录</button>
      </form>
    </section> : <>
      <nav className="tabs" aria-label="工作区">
        {(role === "admin" ? [["status", "运行状态"], ["library", "队列与素材"], ["history", "发送记录"], ["settings", "API 与系统配置"]] : [["letters", "照片记录"]]).map(([key, name]) =>
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
        {tab === "status" && <OperatorStatus dashboard={dashboard} />}
        {tab === "library" && <>
          <details className="card">
            <summary>待发送 {dashboard.stats.ready} 张 · 下一张：{dashboard.queue[0]?.date_label || (dashboard.queue.length ? "未填写日期" : "无")} · 待确认 {dashboard.stats.unreviewed} 张 · 展开队列</summary>
            <p className="muted">按入库时间排序，每天取一张已确认、未使用素材。最多显示前 100 张，不会自动重复发送。</p>
            {!dashboard.queue.length && <p>队列为空。</p>}
            <div className="table-scroll"><table className="admin-table"><thead><tr><th>顺序</th><th>照片</th><th>拍摄时间 / 地点</th><th>推送文案</th><th>操作</th></tr></thead>
              <tbody>{dashboard.queue.map((photo, index) => <tr key={photo.id}>
                <td>{index + 1}{index === 0 ? "（下一张）" : ""}</td>
                <td><img className="mini" src={`${base}/api/media/${photo.id}/thumb`} alt="" /></td>
                <td>{photo.date_label || "未填写"}<br />{photo.place_label || "未填写"}</td>
                <td>{photo.caption.slice(0, 80)}{photo.caption.length > 80 ? "…" : ""}</td>
                <td><button className="quiet" onClick={() => setSelectedPhoto(photo.id)}>编辑</button></td>
              </tr>)}</tbody></table></div>
          </details>
          <details className="card upload-disclosure"><summary>上传照片 / ZIP</summary>
            <UploadPanel jobs={dashboard.imports} busy={busy} perform={perform} refresh={refreshUploads} />
          </details>
          <PhotoLibrary aiEnabled={dashboard.aiEnabled} aiWithPhoto={supportsPhotoCaption(dashboard.ai.provider, dashboard.ai.model)}
            revision={dashboard} refresh={refreshUploads} selectedId={selectedPhoto} select={setSelectedPhoto} />
        </>}
        {tab === "history" && <SendHistory dashboard={dashboard} busy={busy} perform={perform} />}
        {tab === "settings" && <SettingsPanel dashboard={dashboard} busy={busy} perform={perform} />}
      </>}
    </>}
    {role === "reader" && <footer>每日小笺仅作娱乐参考，不构成决策建议。</footer>}
  </main>;
}

type Perform = (work: () => Promise<void>, message?: string) => Promise<void>;

const memory = (bytes: number | null) => bytes === null ? "未提供" : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
function ResourcePanel({ dashboard: d }: { dashboard: Dashboard }) {
  const r = d.resources;
  return <section>
    <h2>资源与容量</h2>
    <table className="admin-table"><tbody>
      <tr><th>Web 进程 RSS</th><td>{memory(r.processRss)}</td></tr>
      <tr><th>Web 容器内存 / 上限</th><td>{memory(r.containerUsage)} / {memory(r.containerLimit)}</td></tr>
      <tr><th>主机物理内存 / 空闲</th><td>{memory(r.hostMemoryTotal)} / {memory(r.hostMemoryFree)}（空闲值不含可回收缓存）</td></tr>
      <tr><th>照片文件 / 配额</th><td>{memory(d.bytes)} / {d.quotaMb} MiB</td></tr>
      <tr><th>照片所在磁盘可用 / 总量</th><td>{(r.diskFree / 1024 ** 3).toFixed(2)} / {(r.diskTotal / 1024 ** 3).toFixed(2)} GiB（共享文件系统，不是独占空间）</td></tr>
      <tr><th>AI 本月费用估算 / 预留</th><td>¥{Number(d.aiCost).toFixed(4)} / ¥100{d.aiUnknownCost > 0 ? `；另有 ${d.aiUnknownCost} 次费用未知，生成已暂停` : ""}</td></tr>
    </tbody></table>
    <p className="muted">内存上限与照片配额是部署参数，不在网页里调整。磁盘容量与照片配额是两个独立限制。</p>
  </section>;
}

function OperatorStatus({ dashboard: d }: { dashboard: Dashboard }) {
  const diskLow = d.resources.diskFree < 512 * 1024 * 1024;
  const stats = d.stats;
  return <section className="card">
    <h2>运行状态：{d.health.healthy && !diskLow ? "健康" : "异常"}</h2>
    <p className={d.health.healthy && !diskLow ? "muted" : "error-text"}>{d.health.reason}{diskLow ? "；磁盘可用空间不足 512 MiB" : ""}</p>
    <table className="admin-table"><tbody>
      <tr><th>自动发送</th><td>{d.settings.paused ? "暂停" : "启用"} · {d.settings.send_time} · {d.settings.timezone}</td></tr>
      <tr><th>发送通道</th><td>{d.pushChannel} · {d.pushReady && d.pushEnabled ? "已配置" : "未就绪"}</td></tr>
      <tr><th>Worker 最近成功</th><td>{d.worker?.last_tick ? new Date(d.worker.last_tick).toLocaleString() : "无"}</td></tr>
      <tr><th>Worker 错误码</th><td>{d.worker?.error_code || "无"}</td></tr>
      <tr><th>AI</th><td>{d.ai.provider} / {d.ai.model} · {d.aiEnabled ? "启用" : "停用"} · API Key {d.ai.keyConfigured ? "已配置" : "未配置"}</td></tr>
    </tbody></table>
    <div className="metrics">{[
      ["照片总数", stats.photos], ["待确认", stats.unreviewed], ["待发送", stats.ready],
      ["已提交平台", stats.submitted], ["平台确认送达", stats.provider_delivered], ["失败", stats.failed],
      ["状态未知", stats.unknown], ["正在发送 / 等待发送", stats.pending_delivery], ["导入处理中", stats.pending_import],
    ].map(([label, count]) => <div className="metric" key={label}><span>{label}</span><strong>{count}</strong></div>)}</div>
    <p className="muted">统计为数据库全量累计值，不依赖当前列表页数。已提交不等于实际收件；企业微信暂未提供本系统可用的已读确认。独立脚本的历史测试不计入这些计数。</p>
    {!d.settings.paused && !stats.ready && <p className="alert error">待发送素材为 0，任务到点后无法发送。请补充并确认素材。</p>}
    <ResourcePanel dashboard={d} />
    <p className="muted">状态页每 30 秒刷新。</p>
  </section>;
}

function Letter({ snapshot, title }: { snapshot: Snapshot; title: string }) {
  return <article className="letter">
    <p className="eyebrow">A MOMENT TO KEEP</p><h2>{title}</h2>
    <img className="letter-photo" src={`${base}/api/media/${snapshot.photo_id}/display`} alt="这一封来信里的照片" />
    <p className="dateline">{[snapshot.date_label, snapshot.place_label].filter(Boolean).join(" · ") || "有些瞬间，不必记得确切的日期。"}</p>
    <p className="caption">{snapshot.caption || "文案还在准备中。"}</p>
    {(snapshot.weather || snapshot.star_note) && <aside><h3>生活信息</h3>
      {snapshot.weather && <p>{snapshot.weather}</p>}
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
  const [weatherCity, setWeatherCity] = useState(s.weather_city);
  const [weatherLat, setWeatherLat] = useState(s.weather_lat === null ? "" : String(s.weather_lat));
  const [weatherLon, setWeatherLon] = useState(s.weather_lon === null ? "" : String(s.weather_lon));
  useEffect(() => {
    setWeatherCity(s.weather_city);
    setWeatherLat(s.weather_lat === null ? "" : String(s.weather_lat));
    setWeatherLon(s.weather_lon === null ? "" : String(s.weather_lon));
  }, [s.weather_city, s.weather_lat, s.weather_lon]);
  const weatherReady = weatherLat.trim() !== "" && weatherLon.trim() !== "";
  return <section className="card">
    <h2>定时任务配置</h2>
    <p className="muted">每天一张，FIFO。开启或修改时间后，从下一个发送时间执行；不补发过去日期。</p>
    <form className="form-grid" onSubmit={event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      if (s.paused && form.has("enabled") && !window.confirm("确认开启每日自动发图？将从下一个发送时间开始，每天向服务器已配置的接收者发送一张已确认素材。")) return;
      const coordinate = (key: string) => value(form, key).trim() === "" ? null : Number(value(form, key));
      setFeedback("");
      void perform(async () => {
        try { await api("settings", {
        timezone: value(form, "timezone"), send_time: value(form, "send_time"), paused: !form.has("enabled"),
        weather_lat: coordinate("weather_lat"), weather_lon: coordinate("weather_lon"), weather_city: value(form, "weather_city"),
        almanac: false, star_note: value(form, "star_note"),
        }); setFeedback(weatherReady ? "设置已保存，天气将按填写的经纬度查询。" : "设置已保存；天气未启用，城市名不能代替经纬度。"); }
        catch (error) { setFeedback(error instanceof Error ? error.message : "保存失败"); throw error; }
      });
    }}>
      <label>每日发送时间<input name="send_time" type="time" defaultValue={s.send_time} required /></label>
      <label className="check"><input name="enabled" type="checkbox" defaultChecked={!s.paused} disabled={!d.pushEnabled || !d.pushReady || d.pushChannel !== "wecom"} />开启每日自动发送</label>
      <p className="muted wide">当前按 {s.timezone === "Asia/Shanghai" ? "北京时间" : s.timezone} 发送。时区是“几点”的计算规则，不是第二份排期。</p>
      <section className="wide" aria-labelledby="weather-settings-title">
        <h3 id="weather-settings-title">天气（可选）</h3>
        <p className="muted">天气配置暂时保留，但不会显示在微信拍立得图片卡片上。</p>
        <p className="muted" id="weather-help">经纬度决定查询哪里的天气，城市名只用于显示，不会自动定位。要获取天气，请同时填写纬度和经度；更换城市时也要修改坐标。</p>
        <label>天气城市名（显示用）<input name="weather_city" value={weatherCity} onChange={event => setWeatherCity(event.target.value)}
          maxLength={80} placeholder="例如：湖州（浙江，中国）" aria-describedby="weather-help" /></label>
        <div className="form-grid"><label>纬度（南北，-90～90）<input name="weather_lat" type="number" step="any" min="-90" max="90"
          value={weatherLat} onChange={event => setWeatherLat(event.target.value)} placeholder="湖州示例：30.8703" aria-describedby="weather-example" /></label>
          <label>经度（东西，-180～180）<input name="weather_lon" type="number" step="any" min="-180" max="180"
            value={weatherLon} onChange={event => setWeatherLon(event.target.value)} placeholder="湖州示例：120.0933" aria-describedby="weather-example" /></label></div>
        <p className="muted" id="weather-example">浙江湖州市区示例：城市名填「湖州」，纬度填 30.8703，经度填 120.0933。不用精确到住址，也不影响照片的拍摄地点。两项坐标都清空即可关闭天气。</p>
        <p className={weatherReady ? "muted" : weatherCity.trim() || weatherLat || weatherLon ? "alert error" : "muted"} role="status">
          {weatherReady ? "经纬度已填写，保存后将通过 Open-Meteo 查询该位置的天气。" :
            weatherCity.trim() || weatherLat || weatherLon ? "经纬度尚未填完整：只保存城市名不会启用天气，请将纬度和经度两项一起填写。" : "天气已关闭：如需启用，请填写城市名和两项坐标。"}
        </p>
      </section>
      <details className="wide"><summary>可选：每日小笺与时区</summary>
      <label>时区（默认北京时间，一般不用修改）<input name="timezone" defaultValue={s.timezone} required /></label>
      <label className="wide">每日小笺（可留空；首版由你编辑，不伪造运势）<textarea name="star_note" maxLength={300} defaultValue={s.star_note} /></label>
      </details>
      <button disabled={busy}>保存设置</button>
      {feedback && <p className="wide alert" role="status">{feedback}</p>}
    </form>
    <hr /><AISettingsPanel config={d.ai} busy={busy} perform={perform} />
    <hr /><ResourcePanel dashboard={d} />
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
  const [model, setModel] = useState(config.model);
  const [apiKey, setApiKey] = useState("");
  const [connection, setConnection] = useState("");
  const [connectionError, setConnectionError] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ error: boolean; message: string } | null>(null);
  useEffect(() => { setProvider(config.provider); setModel(config.model); }, [config.provider, config.model]);
  const preset = provider === "zhipu" && model.toLowerCase() === GLM_FLASH_MODEL;
  const pricing = aiPricing(provider, model, config.inputRate, config.outputRate);
  return <section>
    <h2>AI 服务配置</h2>
    <p className="muted">每月上限固定 ¥100（北京时间自然月），达到预算后停止调用。GLM-5.3-Flash 已预设价格，只需填写 API Key。</p>
    <p className="muted">API Key：
      <a href="https://bigmodel.cn/usercenter/proj-mgmt/apikeys" target="_blank" rel="noreferrer">智谱开放平台</a> ·
      <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">DeepSeek</a>
    </p>
    {provider === "zhipu" && <p className="muted">使用智谱「模型标准 API」Key，不是 GLM Coding Plan 套餐 Key。固定端点：open.bigmodel.cn/api/paas/v4/chat/completions。
      <a href="https://docs.bigmodel.cn/cn/api/introduction" target="_blank" rel="noreferrer">官方接口说明</a></p>}
    <form key={JSON.stringify(config)} onSubmit={event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      setSaveStatus(null);
      void perform(async () => {
        try { await api("ai/config", {
          provider, apiKey, enabled: form.has("enabled"), clearKey: form.has("clearKey"),
          model: value(form, "model"),
          inputRate: value(form, "inputRate").trim() ? Number(value(form, "inputRate")) : null,
          outputRate: value(form, "outputRate").trim() ? Number(value(form, "outputRate")) : null,
          monthlyLimit: 100,
        }); setApiKey(""); setConnection(""); setConnectionError(false);
        setSaveStatus({ error: false, message: "AI 配置已保存，密钥已保存在服务器，可点击下方验证。" });
        } catch (error) {
          setSaveStatus({ error: true, message: error instanceof Error ? error.message : "保存失败" });
          throw error;
        }
      }, "AI 配置已保存；密钥不会回显，可先测试连接");
    }}>
      <fieldset className="form-grid" disabled={busy}>
      <label>供应商<select name="provider" value={provider} onChange={event => {
        const next = event.target.value;
        if (next !== "zhipu" && next !== "openai" && next !== "deepseek") return;
        setProvider(next); setModel(next === "zhipu" ? GLM_FLASH_MODEL : next === "openai" ? "gpt-4o-mini" : "deepseek-flash");
        setApiKey(""); setConnection(""); setConnectionError(false);
      }}><option value="zhipu">智谱 GLM（标准 API）</option><option value="deepseek">DeepSeek（官方 API）</option><option value="openai">OpenAI（官方 API）</option></select></label>
      <label>模型 ID<input name="model" value={model} onChange={event => setModel(event.target.value)} required maxLength={120} placeholder="glm-5.3-flash" />
        {provider === "zhipu" && !preset && <button type="button" className="quiet" onClick={() => setModel(GLM_FLASH_MODEL)}>使用 GLM-5.3-Flash 预设</button>}</label>
      <label className="wide">API Key（{config.keyConfigured ? "已保存；留空保留，更换供应商需新密钥" : "尚未配置"}）
        <input name="apiKey" type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} maxLength={512} placeholder={config.keyConfigured ? "填写新密钥以替换；不会显示旧值" : "粘贴你的 API Key"} /></label>
      {preset ? <div className="wide preset-panel"><strong>GLM-5.3-Flash · 已内置</strong><p>输入 ¥{pricing.inputRate} / 百万 tokens · 输出 ¥{pricing.outputRate} / 百万 tokens · 每月上限 ¥100</p>
        <p className="muted">缓存命中报价 ¥0.23 / 百万 tokens；限额按普通输入价保守计费。文案生成会结合照片压缩副本、事件说明及填写的时间地点；不发送原图 EXIF/GPS。</p></div> :
        <div className="wide form-grid" key={provider + model}><label>输入单价（美元 / 百万 tokens）<input name="inputRate" type="number" min="0" max="10000" step="any" defaultValue={config.currency === "USD" && provider === config.provider ? config.inputRate ?? "" : ""} required /></label>
          <label>输出单价（美元 / 百万 tokens）<input name="outputRate" type="number" min="0" max="10000" step="any" defaultValue={config.currency === "USD" && provider === config.provider ? config.outputRate ?? "" : ""} required /></label></div>}
      <label className="check wide"><input name="enabled" type="checkbox" defaultChecked={config.enabled} />启用 AI 文案生成（GLM-5.3-Flash 支持看图）</label>
      <details className="wide"><summary>密钥管理</summary><label className="check"><input name="clearKey" type="checkbox" />删除已保存的密钥（请同时关闭 AI）</label></details>
      <div className="actions wide"><button disabled={busy}>{busy && !testing ? "保存中…" : "保存 AI 配置"}</button>
        <button type="button" className="quiet" disabled={busy || !config.keyConfigured || provider !== config.provider || model !== config.model || !!apiKey} aria-busy={testing} onClick={() => {
          setTesting(true); setConnectionError(false); setConnection("正在验证已保存的配置，请稍候…");
          void perform(async () => {
            try {
              const result = await api<{ message: string }>("ai/test", { confirm: true }); setConnection(result.message);
            } catch (error) {
              setConnectionError(true); setConnection(error instanceof Error ? error.message : "验证失败"); throw error;
            } finally { setTesting(false); }
          }, "AI 连接检查完成");
        }}>{testing ? "验证中…" : "验证已保存配置"}</button></div>
      {saveStatus && <p className={`wide alert${saveStatus.error ? " error" : ""}`} role={saveStatus.error ? "alert" : "status"}>{saveStatus.message}</p>}
      </fieldset>
    </form>
    {config.provider === "zhipu" && <p className="muted">验证会请求一次固定测试文本，计入月度预算；不发送照片或事件说明。修改后请先保存再验证。</p>}
    {connection && <p className={`alert${connectionError ? " error" : ""}`} role={connectionError ? "alert" : "status"} aria-live="polite">{connection}</p>}
    <p className="muted">生成结果自动填入草稿，由你保存确认后才能进入队列。看图调用先按模型完整上下文上限保守预留，成功后按实际 tokens 结算；超时保留预留，不自动重试。旧美元记录及美元定价模型按固定 1 USD = ¥8 记账，中央美元日志为折算估算值。每月 ¥100 限额只约束本系统，不是供应商账号总账单封顶。</p>
  </section>;
}
