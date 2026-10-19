import assert from "node:assert/strict";
import { test } from "node:test";
import { importSummary, type UploadItem } from "../src/lib/import-progress";

const item = (patch: Partial<UploadItem>): UploadItem => ({
  localId: 0, name: "synthetic.jpg", progress: 0, stage: "waiting", added: 0, duplicates: 0, errors: [], ...patch,
});
test("upload acceptance is not reported as completed photo import", () => {
  const uploading = importSummary([item({ stage: "uploading", progress: 100 })]);
  assert.equal(uploading.active, true);
  assert.match(uploading.message, /正在上传/);
  const queued = importSummary([item({ stage: "queued", progress: 100, jobId: "test" })]);
  assert.equal(queued.active, true);
  assert.match(queued.message, /后台正在整理/);
});
test("duplicate-only imports explain that the photo is already in the library", () => {
  const result = importSummary([item({ stage: "done", duplicates: 1 })]);
  assert.equal(result.active, false);
  assert.equal(result.failed, false);
  assert.match(result.message, /已存在这 1 张照片，无需重复添加/);
  assert.doesNotMatch(result.message, /正在|新增 0/);
});
test("multi-file imports remain pending until all jobs finish and aggregate new photos", () => {
  assert.equal(importSummary([item({ stage: "done", added: 2 }), item({ localId: 1, stage: "processing" })]).active, true);
  const done = importSummary([item({ stage: "done", added: 2 }), item({ localId: 1, stage: "done", added: 1, duplicates: 2 })]);
  assert.equal(done.active, false);
  assert.match(done.message, /已加入照片库 3 张/);
  assert.match(done.message, /2 张已存在/);
});
test("partial import and uncertain network results never look like complete success", () => {
  const partial = importSummary([item({ stage: "done", added: 1, errors: ["Unsupported file"] })]);
  assert.equal(partial.failed, true);
  assert.match(partial.message, /有项目未成功/);
  const unknown = importSummary([item({ stage: "unknown", errors: ["timeout"] }), item({ localId: 1, stage: "done", added: 1 })]);
  assert.equal(unknown.failed, true);
  assert.match(unknown.message, /尚未确认/);
});
