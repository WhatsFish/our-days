"use client";

import { useCallback, useEffect, useState } from "react";
import type { HolidayDashboard, HolidayCard } from "../lib/holidays";
import type { HolidayRules } from "../lib/holiday-calendar";

const base = "/our-days";
const statusLabels: Record<string, string> = {
  waiting: "等待发送", queued: "等待生成", generating: "正在生成", ready: "已生成，将自动发送",
  failed: "失败", unknown: "状态未知，不自动重试", sending: "正在提交", accepted: "平台已接受（不代表已读）",
  skipped: "已有照片排期，节日贺卡不重复发送",
};
async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/${route}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "节日配置请求失败");
  return data;
}

export function HolidayPanel({ mode }: { mode: "settings" | "queue" | "status" | "history" }) {
  const [data, setData] = useState<HolidayDashboard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => { setData(await api<HolidayDashboard>("holidays")); }, []);
  useEffect(() => {
    void refresh().catch(error => setError(error.message));
    const timer = setInterval(() => { void refresh().catch(error => setError(error.message)); }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function toggle(key: keyof HolidayRules, enabled: boolean) {
    if (!data) return;
    const previous = data;
    const rules = { ...data.rules, [key]: enabled };
    setData({ ...data, rules });
    setBusy(true); setError(""); setNotice("");
    try {
      await api("holidays/settings", rules);
      await refresh();
      setNotice("已保存；开关立即影响尚未发送的节日，不改变每日发送总开关。");
    } catch (error) { setData(previous); setError(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  }
  return <section className="card" aria-label="节日 AI 贺卡">
    <div className="section-heading"><h2>{mode === "settings" ? "节日自动推送" : mode === "history" ? "节日发送记录" : "节日 AI 贺卡"}</h2>
      <button className="quiet" type="button" disabled={busy} onClick={() => {
        setError(""); void refresh().catch(error => setError(error.message));
      }}>刷新节日计划</button></div>
    {error && <p className="alert error" role="alert">{error}</p>}
    {notice && <p className="alert" role="status">{notice}</p>}
    {!data && !error && <p role="status">正在读取节日计划…</p>}
    {data && <>
      {mode === "settings" && <>
        <p className="muted">三个分类默认开启。提前 {data.horizon} 天生成，无需确认；在当天每日发送时间替代照片，不消耗照片队列，也不额外多发。每日发送总开关仍然有效。</p>
        {([["solar_terms", "节气推送"], ["chinese", "中国节日推送"], ["western", "西方节日推送"]] as const).map(([key, title]) =>
          <label className="check" key={key}><input type="checkbox" role="switch" checked={data.rules[key]} disabled={busy}
            onChange={event => void toggle(key, event.target.checked)} />{title}</label>)}
        <p className="muted">节气按北京时间日期计算；中国节日包括春节、元宵、清明、端午、七夕、中秋、重阳、腊八、小年、除夕、元旦、劳动节、国庆；西方节日包括情人节、万圣节、美式感恩节、平安夜、圣诞节。只在节日当天发送，同日节日合并为一张。</p>
        <p className="muted">使用 Seedream 5.5 和生日参考图，新图按当前官方价格估算约 ¥0.28；重生成同时参考当前成品，约 ¥0.33，计入现有每月 ¥100 AI 预算。参考图压缩副本会提交到火山方舟。可提前在「队列与素材」填写意见重生成。</p>
        <p className="muted">生成失败或状态未知会告警，不会偷偷用旧版本或日常照片顶替，不自动重复付费调用；可在到发送时间之前手动重试。到点后最多等待 15 分钟，不补发过期贺卡。已有手动照片排期优先，不重复发送。</p>
      </>}
      {!data.referenceReady && <p className="alert error" role="alert">缺少生日参考图，无法生成节日贺卡，请检查配置。</p>}
      {data.attention > 0 && <p className="alert error" role="alert">有 {data.attention} 个节日需要处理：生成或发送失败／状态未知，请在队列中查看错误。</p>}
      {mode === "status" && <p className="muted">未来 {data.horizon} 天 {data.upcoming.length} 个节日推送日。
        {data.upcoming[0] ? ` 下一次：${data.upcoming[0].day} · ${data.upcoming[0].names.join(" / ")} · ${statusLabels[data.upcoming[0].generation?.status ?? "queued"]}` : " 暂无已开启的节日。"}
        {" "}<a href={`${base}?view=library`}>查看图片与重生成</a></p>}
      {mode === "queue" && <>
        <p className="muted">未来 {data.horizon} 天的实际节日计划。图片生成后会直接用于当天推送，不需确认。每分钟处理一个生成任务；点击图片可放大。重生成期间及失败时不会发送旧图，成功后自动替换为最新版本。</p>
        {!data.upcoming.length && <p className="empty">未来 {data.horizon} 天没有已开启的节日，按照片队列发送。</p>}
        <div className="holiday-grid">{data.upcoming.map(card => <HolidayPreview key={card.day} card={card} refresh={refresh} />)}</div>
      </>}
      {mode === "history" && <>
        {!data.history.length && <p className="empty">暂无节日发送记录。</p>}
        {data.history.map(card => <article key={card.day}>
          <strong>{card.day} · {card.names.join(" / ")}</strong>
          <p>{statusLabels[card.status] ?? card.status}{card.error_code ? ` · ${card.error_code}` : ""}</p>
          {card.sent_material_id && <a href={`${base}/api/special/${card.sent_material_id}/preview`} target="_blank" rel="noreferrer">查看实际发送图片</a>}
        </article>)}
      </>}
    </>}
  </section>;
}

function HolidayPreview({ card, refresh }: { card: HolidayCard; refresh: () => Promise<void> }) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = card.generation;
  const pending = !generation || ["queued", "generating"].includes(generation.status);
  return <article className="holiday-item">
    <strong>{card.day} · {card.names.join(" / ")}</strong>
    <p className="muted">{statusLabels[card.status !== "waiting" ? card.status : generation?.status ?? "queued"]}
      {generation ? ` · 第 ${generation.revision} 版` : ""}</p>
    {generation?.material_id && <a href={`${base}/api/special/${generation.material_id}/preview`} target="_blank" rel="noreferrer">
      <img className="holiday-preview" src={`${base}/api/special/${generation.material_id}/preview`} alt={`${card.names.join("、")}待发送贺卡`} /></a>}
    {(generation?.error_code || card.error_code) && <p className="alert error" role="alert">{generation?.error_code || card.error_code}</p>}
    {card.status === "waiting" && <form onSubmit={event => {
      event.preventDefault(); setBusy(true); setError(""); setNotice("");
      void api("holidays/regenerate", { day: card.day, feedback }).then(async () => {
        setFeedback(""); setNotice("已安排重生成；完成后自动使用新版本。"); await refresh();
      }).catch(error => setError(error.message)).finally(() => setBusy(false));
    }}>
      <label>修改意见<textarea value={feedback} onChange={event => setFeedback(event.target.value)} maxLength={1000}
        placeholder="例如：换成夜晚，两个人物大一点，文字少一些" disabled={busy || pending} /></label>
      <button type="submit" disabled={busy || pending}>{busy ? "提交中…" : pending ? "等待生成完成" : "按意见重新生成"}</button>
      <p className="muted">每次重新生成会产生费用；发送时间之前可修改，最多 10 个版本。</p>
    </form>}
    {notice && <p className="alert" role="status">{notice}</p>}
    {error && <p className="alert error" role="alert">{error}</p>}
  </article>;
}
