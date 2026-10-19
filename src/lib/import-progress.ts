export type UploadItem = {
  localId: number;
  name: string;
  progress: number;
  jobId?: string;
  stage: "waiting" | "uploading" | "queued" | "processing" | "done" | "failed" | "unknown";
  added: number;
  duplicates: number;
  errors: string[];
};
export function importSummary(items: UploadItem[]) {
  const added = items.reduce((sum, item) => sum + item.added, 0);
  const duplicates = items.reduce((sum, item) => sum + item.duplicates, 0);
  const errors = items.reduce((sum, item) => sum + item.errors.length, 0);
  const uploading = items.some(item => item.stage === "waiting" || item.stage === "uploading");
  const processing = items.some(item => item.stage === "queued" || item.stage === "processing");
  const unknown = items.some(item => item.stage === "unknown");
  const failed = items.some(item => item.stage === "failed") || errors > 0;
  if (uploading) return { active: true, failed: false, message: "正在上传，请勿关闭页面…" };
  if (processing) return { active: true, failed, message: `文件已上传，后台正在整理照片…${added ? ` 已加入 ${added} 张。` : ""}` };
  if (unknown) return { active: false, failed: true, message: "部分文件的上传结果尚未确认，请先检查照片库和最近记录，避免重复上传。" };
  if (failed) return { active: false, failed: true, message: `导入结束，有项目未成功：已加入 ${added} 张，跳过已有照片 ${duplicates} 张。请查看下方原因。` };
  return { active: false, failed: false, message: duplicates && !added
    ? `照片库中已存在这 ${duplicates} 张照片，无需重复添加。`
    : `导入完成：已加入照片库 ${added} 张${duplicates ? `，另有 ${duplicates} 张已存在，已跳过` : ""}。` };
}
