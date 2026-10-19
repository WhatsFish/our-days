import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { AppError } from "./domain";

function config() {
  const file = "/run/secrets/our-days-wecom.env";
  let text: string;
  try {
    if ((statSync(file).mode & 0o077) !== 0) throw new Error("Private file permissions required");
    text = readFileSync(file, "utf8");
  } catch {
    throw new AppError(503, "wecom_config", "企业微信回调密钥尚未配置或文件权限不正确");
  }
  function value(name: string) {
    const line = text.split("\n").find(line => line.startsWith(`${name}=`));
    const raw = line?.slice(name.length + 1).trim() ?? "";
    return raw.replace(/^(['"])(.*)\1$/, "$2");
  }
  const token = value("WECOM_CALLBACK_TOKEN"), aes = value("WECOM_CALLBACK_AES_KEY"), corp = value("WECOM_CORP_ID");
  if (!/^[a-zA-Z0-9]{1,32}$/.test(token) || !/^[a-zA-Z0-9+/]{43}$/.test(aes) || !/^ww[a-zA-Z0-9]+$/.test(corp)) {
    throw new AppError(503, "wecom_config", "请先填写企业ID和回调Token、EncodingAESKey");
  }
  return { token, aes, corp };
}

export function decryptWecomCallback(url: URL, encrypted: string, settings = config(), now = Date.now()): Buffer {
  const timestamp = url.searchParams.get("timestamp") ?? "", nonce = url.searchParams.get("nonce") ?? "";
  const signature = url.searchParams.get("msg_signature") ?? "";
  const reject = () => new AppError(403, "wecom_verify", "企业微信回调校验失败");
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 ||
      !nonce || nonce.length > 128 || !/^[a-f0-9]{40}$/.test(signature) ||
      !encrypted || encrypted.length > 65536 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encrypted)) throw reject();
  const expected = createHash("sha1").update([settings.token, timestamp, nonce, encrypted].sort().join("")).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw reject();
  const key = Buffer.from(settings.aes + "=", "base64"), ciphertext = Buffer.from(encrypted, "base64");
  if (key.length !== 32 || ciphertext.length % 16 !== 0) throw reject();
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { throw reject(); }
  const padding = plain[plain.length - 1];
  if (!padding || padding > 32 || plain.length < padding + 20 ||
      !plain.subarray(-padding).every(byte => byte === padding)) throw reject();
  const body = plain.subarray(0, -padding), length = body.readUInt32BE(16);
  if (length > body.length - 20 || body.subarray(20 + length).toString("utf8") !== settings.corp) throw reject();
  return body.subarray(20, 20 + length);
}

export function wecomEncryptedBody(xml: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new AppError(400, "wecom_xml", "无效企业微信回调");
  }
  const parsed = new XMLParser({ parseTagValue: false, processEntities: false }).parse(xml);
  const encrypted: unknown = parsed?.xml?.Encrypt;
  if (typeof encrypted !== "string") throw new AppError(400, "wecom_xml", "缺少加密消息");
  return encrypted;
}
