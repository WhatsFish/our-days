import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";

// This is a manual presentation probe, not the daily publication channel.
process.env.XDG_CACHE_HOME ??= "/tmp/our-days-fontcache";
await mkdir(process.env.XDG_CACHE_HOME, { recursive: true, mode: 0o700 });
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1460" viewBox="0 0 1080 1460">
<defs>
  <linearGradient id="sky" x2="0" y2="1"><stop stop-color="#dbe8de"/><stop offset="1" stop-color="#f5e8cf"/></linearGradient>
</defs>
<rect width="1080" height="1460" fill="#f7f3eb"/>
<g font-family="Noto Sans CJK SC, sans-serif" fill="#354236">
  <text x="74" y="88" font-size="22" letter-spacing="5">OUR DAYS · 拾光</text>
  <text x="74" y="162" font-size="43">把平凡的日子，慢慢收藏。</text>
  <text x="74" y="208" font-size="23" fill="#747b6e">微信图片消息 · 版式演示</text>
  <rect x="64" y="252" width="952" height="552" rx="20" fill="url(#sky)"/>
  <circle cx="792" cy="381" r="62" fill="#f4d28f"/>
  <path d="M64 649 Q250 428 425 644 Q618 429 1016 670 V804 H64Z" fill="#9aaa8c"/>
  <path d="M64 730 Q300 615 577 744 Q815 585 1016 713 V804 H64Z" fill="#758b75"/>
  <path d="M474 804 Q545 713 645 682 Q595 752 608 804Z" fill="#e5dbbb"/>
  <rect x="88" y="716" width="345" height="55" rx="12" fill="#fffdf5" opacity=".92"/>
  <text x="108" y="753" font-size="25">示意画面，非你们的真实照片</text>
  <text x="74" y="872" font-size="25" fill="#737b6d">拍摄时间与地点｜此处展示你确认的信息</text>
  <text x="74" y="955" font-size="36">“想收藏的，不只是这一刻的风景，</text>
  <text x="74" y="1011" font-size="36">还有和你一起走过的每一天。”</text>
  <text x="74" y="1064" font-size="22" fill="#737b6d">示例文案，不代表你们的真实经历</text>
  <path d="M74 1110 H1006" stroke="#d6dbcd" stroke-width="2"/>
  <text x="74" y="1167" font-size="28">出门前，记得照顾自己</text>
  <text x="74" y="1220" font-size="27">天气示例：晴 · 22—27°C · 记得带水</text>
  <text x="74" y="1271" font-size="27">今日小笺：忙碌的时候，也给自己一个拥抱。</text>
  <text x="74" y="1360" font-size="22" fill="#737b6d">仅演示排版：真实照片、拍摄信息和天气将在确认后替换。</text>
  <text x="74" y="1401" font-size="22" fill="#737b6d">这是一张直接显示在微信会话里的图片，不是网页链接。</text>
</g></svg>`;

const image = await sharp(Buffer.from(svg)).png().toBuffer();
const metadata = await sharp(image).metadata();
if (metadata.width !== 1080 || metadata.height !== 1460 || image.length > 2 * 1024 * 1024) {
  throw new Error("Demo image failed size validation");
}
console.log(`Demo rendered: ${metadata.width}x${metadata.height}, ${image.length} bytes; all content is illustrative.`);
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
  const output = process.argv[outputIndex + 1];
  if (!output) throw new Error("--output requires a destination");
  await writeFile(output, image, { mode: 0o600, flag: "wx" });
}

if (process.argv.includes("--send-once")) {
  if (process.env.PUSH_ENABLED !== "false") throw new Error("Keep global automatic push disabled during this manual probe");
  for (const key of ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_OPEN_ID"]) {
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  }
  async function responseJSON(response) {
    if (!response.ok) throw new Error(`WeChat HTTP ${response.status}; do not automatically retry a submission`);
    try { return await response.json(); }
    catch { throw new Error("Invalid WeChat response; do not automatically retry a submission"); }
  }
  const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
  url.search = new URLSearchParams({
    grant_type: "client_credential",
    appid: process.env.WECHAT_APP_ID,
    secret: process.env.WECHAT_APP_SECRET,
  }).toString();
  const auth = await responseJSON(await fetch(url, { signal: AbortSignal.timeout(10000) }));
  if (!auth.access_token) throw new Error(`Token failed: ${auth.errcode}`);
  const upload = new FormData();
  upload.set("media", new Blob([image], { type: "image/png" }), "our-days-demo.png");
  const asset = await responseJSON(await fetch(
    `https://api.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(auth.access_token)}&type=image`,
    { method: "POST", body: upload, signal: AbortSignal.timeout(15000) },
  ));
  if (!asset.media_id) throw new Error(`Image upload failed: ${asset.errcode}`);
  console.log("Temporary image uploaded to WeChat; submitting exactly one customer-service image message.");
  let response;
  try {
    response = await fetch(
      `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(auth.access_token)}`,
      {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ touser: process.env.WECHAT_OPEN_ID, msgtype: "image", image: { media_id: asset.media_id } }),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw new Error("Image submission UNKNOWN; check the phone before considering any retry");
  }
  const result = await responseJSON(response);
  console.log(`Customer-service image API errcode=${result.errcode}; at=${new Date().toISOString()}`);
  if (result.errcode !== 0) {
    if (result.errcode === 45015) console.error("Interaction/reply window exceeded. This channel does not currently permit this proactive send.");
    if (result.errcode === 48001) console.error("This account does not have permission for this API.");
    process.exitCode = 1;
  } else {
    console.log("WeChat accepted the image. Phone confirmation is still required; this does not prove daily proactive eligibility.");
  }
}
