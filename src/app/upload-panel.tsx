"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { importSummary, type UploadItem } from "../lib/import-progress";

type ImportJob = { id: string; status: string; added: number; duplicates: number; errors: string[] };
type Props = {
  jobs: ImportJob[];
  busy: boolean;
  perform: (work: () => Promise<void>, message?: string) => Promise<void>;
  refresh: () => Promise<void>;
};
class UploadFailure extends Error {
  constructor(message: string, public ambiguous = false) { super(message); }
}
function sendFile(file: File, update: (progress: number) => void, controller: AbortController): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => controller.signal.removeEventListener("abort", abort);
    controller.signal.addEventListener("abort", abort, { once: true });
    xhr.open("POST", "/our-days/api/upload");
    xhr.timeout = 180000;
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) update(Math.min(99, Math.round(event.loaded / event.total * 100)));
    };
    xhr.onload = () => {
      cleanup();
      let body: { id?: unknown; error?: unknown };
      try { body = JSON.parse(xhr.responseText); }
      catch { reject(new UploadFailure(`服务器返回异常（HTTP ${xhr.status}），请先检查导入记录`, xhr.status < 400)); return; }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new UploadFailure(typeof body.error === "string" ? body.error : `上传失败（HTTP ${xhr.status}）`)); return;
      }
      if (typeof body.id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.id)) {
        reject(new UploadFailure("服务器已响应，但无法确认导入任务，请先检查导入记录", true)); return;
      }
      resolve(body.id);
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => {
      cleanup();
      reject(new UploadFailure("连接中断或超时，无法确认服务器是否已接收。请先检查照片库和最近导入记录。", true));
    };
    const form = new FormData();
    form.set("file", file);
    xhr.send(form);
  });
}

export function UploadPanel({ jobs, busy, perform, refresh }: Props) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [pollError, setPollError] = useState("");
  const [selection, setSelection] = useState("");
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => controller.current?.abort(), []);
  const patch = useCallback((localId: number, value: Partial<UploadItem>) => {
    setItems(previous => previous.map(item => item.localId === localId ? { ...item, ...value } : item));
  }, []);
  const pendingIds = items.filter(item => item.jobId && ["queued", "processing"].includes(item.stage)).map(item => item.jobId).join(",");
  useEffect(() => {
    if (!pendingIds) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`/our-days/api/imports?ids=${encodeURIComponent(pendingIds)}`, {
          cache: "no-store", signal: abort.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "无法更新处理进度");
        const rows: ImportJob[] = result;
        const changed = rows.some(row => ["done", "failed"].includes(row.status) &&
          itemsRef.current.some(item => item.jobId === row.id && !["done", "failed"].includes(item.stage)));
        setItems(previous => previous.map(item => {
          const job = rows.find(row => row.id === item.jobId);
          if (!job || !["queued", "processing", "done", "failed"].includes(job.status)) return item;
          const stage = job.status as "queued" | "processing" | "done" | "failed";
          return { ...item, stage, added: job.added, duplicates: job.duplicates, errors: job.errors };
        }));
        setPollError(rows.length ? "" : "暂时查不到导入任务，请刷新照片库和最近记录，不要重复上传。");
        if (changed) await refresh();
      } catch (error) {
        if (abort.signal.aborted) return;
        setPollError(error instanceof Error ? error.message : "进度更新失败，请检查网络");
      }
      if (!abort.signal.aborted) timer = setTimeout(() => { void poll(); }, 3000);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [pendingIds, refresh]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const files = Array.from(input.current?.files ?? []);
    if (!files.length) return;
    if (files.length > 100) { setSelection("一次最多选择 100 个文件，请分批上传。"); return; }
    if (files.some(file => file.size === 0 || file.size > 25 * 1024 * 1024)) {
      setSelection("包含空文件或超过 25MB 的文件，请重新选择。"); return;
    }
    setSelection(""); setPollError("");
    setItems(files.map((file, index) => ({
      localId: index, name: file.name, progress: 0, stage: "waiting", added: 0, duplicates: 0, errors: [],
    })));
    const abort = new AbortController(); controller.current = abort;
    void perform(async () => {
      let failures = 0;
      for (let index = 0; index < files.length; index++) {
        patch(index, { stage: "uploading" });
        try {
          const jobId = await sendFile(files[index], progress => patch(index, { progress }), abort);
          patch(index, { jobId, stage: "queued", progress: 100 });
        } catch (error) {
          failures++;
          patch(index, {
            stage: error instanceof UploadFailure && error.ambiguous ? "unknown" : "failed",
            errors: [error instanceof Error ? error.message : "上传失败"],
          });
          if (abort.signal.aborted) break;
        }
      }
      if (input.current) input.current.value = "";
      if (failures) throw new Error(`${failures} 个文件未确认上传成功，请查看上传区域的具体提示。`);
    }, "文件已上传，导入进度和完成结果会显示在上传按钮下方");
  }
  const summary = items.length ? importSummary(items) : null;
  const pending = jobs.filter(job => ["queued", "processing"].includes(job.status)).length;
  const recent = jobs.filter(job => ["done", "failed"].includes(job.status)).slice(0, 5);
  return <section className="card">
    <h2>先收集，再慢慢写。</h2>
    <p className="muted">支持单张、多张 JPEG / PNG / WebP 或 ZIP。单文件 25MB；ZIP 最多 100 条目、解压总量 100MB。HEIC 暂不支持。</p>
    <form onSubmit={submit}>
      <label>选择照片或压缩包<input ref={input} name="photos" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.zip" required
        disabled={busy || !!summary?.active} onChange={event => setSelection(event.target.files?.length ? `已选择 ${event.target.files.length} 个文件，点击下方按钮开始上传。` : "")} /></label>
      {selection && <p className="muted" role="status">{selection}</p>}
      <button disabled={busy || !!summary?.active} aria-busy={!!summary?.active}>
        {items.some(item => ["waiting", "uploading"].includes(item.stage)) ? "正在上传…" : summary?.active ? "正在整理照片…" : "上传到私密照片库"}
      </button>
    </form>
    {summary && <div className={`alert${summary.failed ? " error" : ""}`} aria-live="polite" aria-atomic="true">
      <strong>{summary.message}</strong>
      <ul className="upload-items">{items.map(item => <li key={item.localId}>
        <span className="upload-filename">{item.name}</span>
        <span>{item.stage === "waiting" ? "等待上传" : item.stage === "uploading" ? `正在上传 ${item.progress}%` :
          item.stage === "queued" ? "上传成功，等待后台整理" : item.stage === "processing" ? "正在读取照片信息…" :
          item.stage === "unknown" ? "上传结果待确认" : item.stage === "failed" ? "未完成" :
          item.added ? `已加入 ${item.added} 张${item.duplicates ? `，已有 ${item.duplicates} 张已跳过` : ""}` :
          item.duplicates ? `照片已存在，跳过 ${item.duplicates} 张` : "处理结束"}</span>
        {item.stage === "uploading" && <progress max={100} value={item.progress} aria-label={`${item.name} 上传进度`} />}
        {item.errors.map((error, index) => <span className="error-text" key={index}>{error}</span>)}
      </li>)}</ul>
      {!summary.active && <button className="quiet" type="button" onClick={() => setItems([])}>收起本次结果</button>}
    </div>}
    {pollError && <p className="alert error" role="alert">{pollError}</p>}
    {!items.length && pending > 0 && <p className="alert" role="status">后台正在整理 {pending} 个已上传的文件，完成后照片库会自动刷新。</p>}
    {recent.length > 0 && <details className="jobs"><summary>最近导入记录（最多显示 5 次）</summary>
      <p className="muted">这些是历史结果，不是待处理队列。“已存在”表示同一张照片已在库中，不会再新增副本。</p>
      {recent.map(job => <p key={job.id}>
        {job.status === "failed" ? "导入未完成" : job.added ? `已加入照片库 ${job.added} 张` : "没有新增照片"}
        {job.duplicates > 0 ? `；${job.duplicates} 张已存在，已跳过` : ""}
        {job.errors.map((message, i) => <span className="error-text" key={i}>{message}</span>)}
      </p>)}
    </details>}
  </section>;
}
