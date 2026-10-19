import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { renderPhotoCard } from "../src/lib/photo-card";
import type { Snapshot } from "../src/lib/domain";

const snapshot: Snapshot = {
  photo_id: "11111111-1111-4111-8111-111111111111", date_label: "2020年1月2日",
  place_label: "Sample City", caption: "这是一段测试文案。", weather: "", almanac: "", star_note: "",
};
test("portrait photos occupy the card width and retain their lower corners without a landscape box", async () => {
  const corner = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#00c040" } }).png().toBuffer();
  const portrait = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: "#d83020" } })
    .composite([{ input: corner, left: 1120, top: 1520 }]).jpeg().toBuffer();
  const card = await renderPhotoCard(snapshot, "2026-10-19", portrait);
  const { data, info } = await sharp(card).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  function pixel(x: number, y: number) {
    const index = (y * info.width + x) * info.channels;
    return [data[index], data[index + 1], data[index + 2]];
  }
  assert.equal(info.width, 1080);
  assert.ok(info.height > 1500);
  const left = pixel(80, 1000);
  assert.ok(left[0] > 170 && left[1] < 100, "Portrait image must extend almost full-width well below the old fixed-height box");
  const lowerCorner = pixel(56 + 968 - 20, 56 + 1291 - 20);
  assert.ok(lowerCorner[1] > 120 && lowerCorner[0] < 100, "Original lower-right marker must remain visible, not cropped");
  assert.ok(card.length < 2 * 1024 * 1024);
  assert.equal((await sharp(card).metadata()).exif, undefined);
  const upperBorder = pixel(540, 28);
  assert.ok(upperBorder.every(channel => channel > 245), "Top white border must have no branding/date text");
});
test("card height follows aspect ratio and weather/almanac never affect the instant-photo layout", async () => {
  const portrait = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: "#809070" } }).jpeg().toBuffer();
  const landscape = await sharp({ create: { width: 1600, height: 1067, channels: 3, background: "#809070" } }).jpeg().toBuffer();
  const tall = await renderPhotoCard(snapshot, "2026-10-19", portrait);
  const wide = await renderPhotoCard(snapshot, "2026-10-19", landscape);
  const tallMeta = await sharp(tall).metadata(), wideMeta = await sharp(wide).metadata();
  assert.ok(tallMeta.height! - wideMeta.height! > 500, "Portrait and landscape must not share one fixed canvas height");
  const legacy = await renderPhotoCard({ ...snapshot, weather: "湖州 20—27°C，降水概率 63% · Open-Meteo", almanac: "不应显示的黄历宜忌" }, "2026-10-19", landscape);
  assert.deepEqual(legacy, wide, "Weather and almanac in saved snapshots must not affect content, spacing or canvas size");
  const weatherFailure = await renderPhotoCard({ ...snapshot, weather: "天气暂未更新" }, "2026-10-19", portrait);
  assert.deepEqual(weatherFailure, tall, "Weather errors must not appear on portrait cards either");
  const note = { ...snapshot, star_note: "另行编辑的小笺" };
  const withNote = await renderPhotoCard(note, "2026-10-19", landscape);
  assert.notDeepEqual(withNote, wide, "Removing weather must preserve separately configured editorial notes");
  assert.deepEqual(await renderPhotoCard({ ...note, weather: "湖州天气" }, "2026-10-19", landscape), withNote);
  const otherSendDate = await renderPhotoCard(snapshot, "这个发送标题不应出现在相纸上", landscape);
  assert.deepEqual(otherSendDate, wide, "No generated title or delivery date is added above the photograph");
});
