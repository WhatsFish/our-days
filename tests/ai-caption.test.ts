import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { prepareCaptionImage } from "../src/lib/ai-caption";
import { supportsPhotoCaption } from "../src/lib/ai-policy";

test("AI image copies retain aspect ratio and strip original metadata without enlarging", async () => {
  const original = await sharp({ create: { width: 1800, height: 2400, channels: 3, background: "#7799aa" } })
    .jpeg().withMetadata({ exif: { IFD0: { Artist: "Synthetic private metadata" } } }).toBuffer();
  const before = await sharp(original).metadata();
  assert.ok(before.exif);
  const dataUrl = await prepareCaptionImage(original);
  assert.ok(dataUrl.startsWith("data:image/jpeg;base64,"));
  const copy = Buffer.from(dataUrl.split(",")[1], "base64");
  const metadata = await sharp(copy).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 960);
  assert.equal(metadata.height, 1280);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.equal(metadata.icc, undefined);
  assert.ok(copy.length <= 1024 * 1024);
  const small = await sharp({ create: { width: 80, height: 120, channels: 4, background: "#ffffff00" } }).png().toBuffer();
  const smallCopy = await sharp(Buffer.from((await prepareCaptionImage(small)).split(",")[1], "base64")).metadata();
  assert.equal(smallCopy.width, 80);
  assert.equal(smallCopy.height, 120);
});

test("corrupt images fail explicitly and only verified model IDs enable image submission", async () => {
  await assert.rejects(prepareCaptionImage(Buffer.from("not an image")), /未调用模型/);
  assert.equal(supportsPhotoCaption("zhipu", "GLM-5.3-Flash"), true);
  assert.equal(supportsPhotoCaption("zhipu", "glm-5.3-flashx"), true);
  assert.equal(supportsPhotoCaption("zhipu", "glm-5.3"), false);
  assert.equal(supportsPhotoCaption("deepseek", "glm-5.3-flash"), false);
});
