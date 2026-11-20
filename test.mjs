// 资源可见性 + 账号隔离测试（内存 KV + 打桩 GitHub，无需联网）
// 运行：node test.mjs
import { webcrypto } from "node:crypto";
const { default: worker } = await import("./src/index.js");

class MemKV {
  constructor() { this.m = new Map(); }
  async get(key, type) {
    const v = this.m.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key, val) { this.m.set(key, typeof val === "string" ? val : JSON.stringify(val)); }
  async delete(key) { this.m.delete(key); }
  async list({ prefix }) {
    const keys = [];
    for (const k of this.m.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
    return { keys };
  }
}

const ADMIN_PASS = "adminpass";
const AUTH_HASH = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(ADMIN_PASS))
  .then((b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join(""));

const env = {
  KV: new MemKV(),
  SESSION_SECRET: "test-secret-123",
  AUTH_USERNAME: "陈帅帅",
  AUTH_HASH,
  GH_OWNER: "owner",
  GH_REPO: "repo",
  GH_TOKEN: "fake-token",
};

// ---- 打桩 GitHub raw：返回固定 4 字节内容，模拟图片二进制 ----
const ASSET_BYTES = new Uint8Array([71, 73, 70, 56]); // "GIF8"
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://raw.githubusercontent.com/")) {
    return new Response(ASSET_BYTES, { status: 200, headers: { "content-type": "image/gif" } });
  }
  if (u.startsWith("https://api.github.com/")) {
    // contents API 写入：上传流程需要 2xx，否则会被判为 502
    if (opts && String(opts.method || "").toUpperCase() === "PUT") {
      return new Response(JSON.stringify({ content: { sha: "stub" } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }
  return realFetch(url, opts);
};

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra === undefined ? "" : extra); }
}
function cookieFrom(res) {
  const sc = res.headers.get("Set-Cookie");
  if (!sc) return null;
  const m = sc.match(/sid=([^;]+)/);
  return m ? m[1] : null;
}
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
async function call(method, path, body, cookie, extra) {
  const headers = { "user-agent": BROWSER_UA };
  if (extra) Object.assign(headers, extra);
  if (cookie) headers["Cookie"] = "sid=" + cookie;
  const opts = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await worker.fetch(new Request("https://x" + path, opts), env);
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json().catch(() => null) : null;
  return { status: r.status, headers: r.headers, data, cookie: cookieFrom(r) };
}
// 取原始响应（校验字节与响应头用）
async function raw(method, path, cookie, extra) {
  const headers = { "user-agent": BROWSER_UA };
  if (extra) Object.assign(headers, extra);
  if (cookie) headers["Cookie"] = "sid=" + cookie;
  const r = await worker.fetch(new Request("https://x" + path, { method, headers }), env);
  const buf = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, buf };
}

console.log("== 1. 账号：登录 / 开放注册 ==");
const a = await call("POST", "/login", { username: "陈帅帅", password: ADMIN_PASS });
ok("admin 登录 200", a.status === 200);
const bad = await call("POST", "/login", { username: "陈帅帅", password: "wrong" });
ok("错误密码 401", bad.status === 401);
const reg = await call("POST", "/register", { username: "alice", password: "pw1234" });
ok("开放注册 200（无邀请码）", reg.status === 200 && !!reg.cookie);
const regBob = await call("POST", "/register", { username: "bob", password: "pw1234" });
ok("第二名用户注册 200", regBob.status === 200);

console.log("== 2. 准备图库数据 ==");
const PUB = "11111111-1111-4111-8111-111111111111";
const PRIV = "22222222-2222-4222-8222-222222222222";
await env.KV.put("gallery", JSON.stringify([
  { id: PUB, owner: "alice", name: "公开图/带 空格", type: "image/gif", ext: "gif", visibility: "public", path: "assets/public/alice/" + PUB + ".gif", createdAt: 2 },
  { id: PRIV, owner: "alice", name: "私人图", type: "image/png", ext: "png", visibility: "private", path: "assets/private/alice/" + PRIV + ".png", createdAt: 1 },
]));

console.log("== 3. 公开资源：匿名凭链接即可访问 ==");
const anonPub = await raw("GET", "/assets/" + PUB, null);
ok("匿名 GET 公开资源 = 200", anonPub.status === 200, anonPub.status);
ok("返回正确字节", anonPub.buf.length === 4 && anonPub.buf[0] === 71);
ok("content-type 为图片", (anonPub.headers.get("content-type") || "").includes("image/gif"));
ok("允许跨域引用（CORS *）", anonPub.headers.get("access-control-allow-origin") === "*");
ok("CORP: cross-origin（可被外站嵌入）", anonPub.headers.get("cross-origin-resource-policy") === "cross-origin");
ok("可公共缓存", (anonPub.headers.get("cache-control") || "").includes("public"));
const anonPubExt = await raw("GET", "/assets/" + PUB + ".gif", null);
ok("带扩展名的地址同样 200", anonPubExt.status === 200, anonPubExt.status);
const headPub = await raw("HEAD", "/assets/" + PUB, null);
ok("匿名 HEAD = 200 且无正文", headPub.status === 200 && headPub.buf.length === 0);
ok("HEAD 带 content-length", headPub.headers.get("content-length") === "4");

console.log("== 4. 私人资源：仍需登录 + 归属校验 ==");
const anonPriv = await raw("GET", "/assets/" + PRIV, null);
ok("匿名 GET 私人资源 = 401", anonPriv.status === 401, anonPriv.status);
ok("401 不泄漏内容", anonPriv.buf.length > 0 && anonPriv.buf[0] !== 71);
const bobPriv = await raw("GET", "/assets/" + PRIV, regBob.cookie);
ok("他人 GET 私人资源 = 403", bobPriv.status === 403, bobPriv.status);
ok("私人响应不回 CORS *", bobPriv.headers.get("access-control-allow-origin") === null);
const ownerPriv = await raw("GET", "/assets/" + PRIV, reg.cookie);
ok("本人 GET 私人资源 = 200", ownerPriv.status === 200, ownerPriv.status);
ok("私人响应禁止缓存", (ownerPriv.headers.get("cache-control") || "").includes("no-store"));
const adminPriv = await raw("GET", "/assets/" + PRIV, a.cookie);
ok("管理员 GET 私人资源 = 200", adminPriv.status === 200, adminPriv.status);

console.log("== 5. 图库列表仍需登录，且按可见性过滤 ==");
const gAnon = await call("GET", "/gallery", undefined, null);
ok("匿名 GET /gallery = 401", gAnon.status === 401);
const gBob = await call("GET", "/gallery", undefined, regBob.cookie);
ok("他人只看到公开项", gBob.data.items.length === 1 && gBob.data.items[0].id === PUB, JSON.stringify(gBob.data.items));
const gAlice = await call("GET", "/gallery", undefined, reg.cookie);
ok("本人看到自己的全部资源", gAlice.data.items.length === 2, JSON.stringify(gAlice.data.items));

console.log("== 6. 边界：不存在 / 畸形 ID / 方法 ==");
const missing = await raw("GET", "/assets/33333333-3333-4333-8333-333333333333", null);
ok("不存在的 ID = 404", missing.status === 404);
const weird = await raw("GET", "/assets/..%2F..%2Fsecret", null);
ok("畸形 ID = 404", weird.status === 404, weird.status);
const shortId = await raw("GET", "/assets/abc", null);
ok("过短 ID = 404", shortId.status === 404);
const anonDel = await call("DELETE", "/assets/" + PUB, undefined, null);
ok("匿名 DELETE = 401", anonDel.status === 401, anonDel.status);
const ownDel = await call("DELETE", "/assets/" + PUB, undefined, reg.cookie);
ok("本人 DELETE = 200", ownDel.status === 200, ownDel.status);
const gonePub = await raw("GET", "/assets/" + PUB, null);
ok("删除后匿名访问 = 404", gonePub.status === 404);

console.log("== 7. 下载头（仅 ?dl=1 时）==");
const dl = await raw("GET", "/assets/" + PRIV + "?dl=1", reg.cookie);
const cd = dl.headers.get("content-disposition") || "";
ok("?dl=1 带 attachment", cd.startsWith("attachment;"));
ok("中文文件名走 RFC 5987", cd.includes("filename*=UTF-8''") && cd.includes("%E7%A7%81"));
const inline = await raw("GET", "/assets/" + PRIV, reg.cookie);
ok("不带参数无 Content-Disposition（图片可内联）", inline.headers.get("content-disposition") === null);

console.log("== 8. 人机验证（Turnstile）==");
// 打开校验开关，并把 siteverify 打桩：token 为 "good" 才算通过
env.TURNSTILE_SECRET = "test-turnstile-secret";
const beforeTs = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("/turnstile/v0/siteverify")) {
    const form = new URLSearchParams(String((opts && opts.body) || ""));
    const okTok = form.get("response") === "good" && form.get("secret") === "test-turnstile-secret";
    return new Response(JSON.stringify({ success: okTok }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return beforeTs(url, opts);
};
const noTok = await call("POST", "/login", { username: "陈帅帅", password: ADMIN_PASS });
ok("登录缺 token -> 403 captcha", noTok.status === 403 && noTok.data && noTok.data.error === "captcha", JSON.stringify(noTok.data));
const badTok = await call("POST", "/login", { username: "陈帅帅", password: ADMIN_PASS, cfToken: "bad" });
ok("登录错误 token -> 403 captcha", badTok.status === 403 && badTok.data.error === "captcha");
const goodTok = await call("POST", "/login", { username: "陈帅帅", password: ADMIN_PASS, cfToken: "good" });
ok("登录有效 token -> 200 + 会话", goodTok.status === 200 && !!goodTok.cookie);
const regNoTok = await call("POST", "/register", { username: "carol", password: "pw1234" });
ok("注册缺 token -> 403 captcha", regNoTok.status === 403 && regNoTok.data.error === "captcha");
const regOkTok = await call("POST", "/register", { username: "carol", password: "pw1234", cfToken: "good" });
ok("注册有效 token -> 200", regOkTok.status === 200);
globalThis.fetch = beforeTs;

console.log("== 9. 边缘防护：扫描器路径 / 可疑 UA / 限流 ==");
// 扫描器爱探的路径：一律 404，且不进入业务逻辑
for (const path of ["/api/user/ismustmobile", "/h5/", "/shouye.html", "/.env",
                    "/.aws/credentials.bak", "/wp-login.php", "/static/js/common.js"]) {
  const r = await call("GET", path);
  ok("扫描路径 404 " + path, r.status === 404, r.status);
}
// 真实路由不受影响
ok("首页 200", (await call("GET", "/")).status === 200);
ok("favicon 204", (await call("GET", "/favicon.ico")).status === 204);
ok("gifenc 200", (await call("GET", "/vendor/gifenc.js")).status === 200);
// 图片资源不受 UA 检查影响：空 UA 也进到业务层（此处 ID 不存在，应得到 404 而非 403）
const noUaAsset = await raw("GET", "/assets/99999999-9999-4999-8999-999999999999", null, { "user-agent": "" });
ok("空 UA 取资源 -> 放行到业务层（404）", noUaAsset.status === 404, noUaAsset.status);

// UA 识别：脚本/扫描器 UA 挡在 403；图片资源例外
const scanUa = await call("GET", "/", undefined, null, { "user-agent": "python-requests/2.31.0" });
ok("python-requests 访问页面 -> 403", scanUa.status === 403, scanUa.status);
const noUa = await call("GET", "/", undefined, null, { "user-agent": "" });
ok("空 UA 访问页面 -> 403", noUa.status === 403, noUa.status);

// 限流：同一 IP 连打 /login 超过 10 次/分 -> 429
const IP = "203.0.113.77";
let firstLimited = 0, limitedResp = null;
for (let i = 1; i <= 12; i++) {
  const r = await call("POST", "/login", { username: "陈帅帅", password: "wrongpw" }, null, { "cf-connecting-ip": IP });
  if (r.status === 429 && !firstLimited) { firstLimited = i; limitedResp = r; }
}
ok("第 11 次起触发限流 429", firstLimited > 10 && firstLimited <= 12, "firstLimited=" + firstLimited);
ok("429 带 Retry-After 头", !!limitedResp && Number(limitedResp.headers.get("retry-after")) > 0);
ok("限流后写入跨实例封禁标记", !!(await env.KV.get("blk:" + IP)));
const afterBlk = await call("GET", "/", undefined, null, { "cf-connecting-ip": IP });
ok("被封 IP 访问页面也 429", afterBlk.status === 429, afterBlk.status);
const otherIp = await call("GET", "/", undefined, null, { "cf-connecting-ip": "203.0.113.88" });
ok("其他 IP 不受影响", otherIp.status === 200, otherIp.status);

console.log("== 10. 文件 / 文件夹上传 ==");
const HTML_BODY = "<script>alert(1)</script>";
const htmlUp = await call("POST", "/upload", {
  name: "说明.html", visibility: "public", folder: "../../etc/配置",
  type: "text/html", ext: "../../../evil",
  data: Buffer.from(HTML_BODY).toString("base64"),
}, reg.cookie);
ok("上传 html 200", htmlUp.status === 200, JSON.stringify(htmlUp.data));
ok("扩展名被清洗为纯字母数字", htmlUp.data.ext === "evil", htmlUp.data.ext);
ok("目录去掉 .. 且保留层级", htmlUp.data.folder === "etc/配置", htmlUp.data.folder);
ok("返回原始大小", htmlUp.data.size === Buffer.byteLength(HTML_BODY), htmlUp.data.size);
const htmlAsset = await raw("GET", "/assets/" + htmlUp.data.id, null);
ok("html 不内联：octet-stream", htmlAsset.headers.get("content-type") === "application/octet-stream");
ok("html 强制附件下载", (htmlAsset.headers.get("content-disposition") || "").startsWith("attachment;"));
ok("html 带 CSP sandbox", (htmlAsset.headers.get("content-security-policy") || "").includes("sandbox"));
ok("公开文件匿名可取", htmlAsset.status === 200);

const pngUp = await call("POST", "/upload", {
  name: "图.png", visibility: "public", type: "image/png", ext: "png",
  data: "R0lGODlhAQABAAAAACw=",
}, reg.cookie);
const pngAsset = await raw("GET", "/assets/" + pngUp.data.id, null);
ok("图片仍内联 image/png", (pngAsset.headers.get("content-type") || "").includes("image/png"));
ok("图片无 Content-Disposition", pngAsset.headers.get("content-disposition") === null);

const svgUp = await call("POST", "/upload", {
  name: "图标.svg", visibility: "public", type: "image/svg+xml", ext: "svg",
  data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64"),
}, reg.cookie);
const svgAsset = await raw("GET", "/assets/" + svgUp.data.id, null);
ok("svg 不内联（防同源脚本）", svgAsset.headers.get("content-type") === "application/octet-stream");
ok("svg 带 CSP sandbox", (svgAsset.headers.get("content-security-policy") || "").includes("sandbox"));

const noExt = await call("POST", "/upload", {
  name: "报告.pdf", visibility: "private", data: "JVBERi0xLjQK",
}, reg.cookie);
ok("缺省 ext 时从文件名推断", noExt.data.ext === "pdf", noExt.data.ext);
ok("缺省 type 归为 octet-stream", noExt.data.type === "application/octet-stream", noExt.data.type);

const g3 = await call("GET", "/gallery", undefined, reg.cookie);
const it3 = g3.data.items.find((x) => x.id === htmlUp.data.id);
ok("列表返回 folder", it3 && it3.folder === "etc/配置", JSON.stringify(it3));
ok("列表返回 size", it3 && it3.size > 0);
ok("列表不含存储路径", it3 && it3.path === undefined);

ok("缺 data -> 400", (await call("POST", "/upload", { name: "x", visibility: "public" }, reg.cookie)).status === 400);
ok("未登录上传 -> 401", (await call("POST", "/upload", { name: "x", visibility: "public", data: "AAAA" }, null)).status === 401);
ok("错误可见性 -> 400", (await call("POST", "/upload", { name: "x", visibility: "secret", data: "AAAA" }, reg.cookie)).status === 400);

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);
