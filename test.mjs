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
  if (u.startsWith("https://api.github.com/")) return new Response("{}", { status: 404 });
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
async function call(method, path, body, cookie) {
  const headers = {};
  if (cookie) headers["Cookie"] = "sid=" + cookie;
  const opts = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await worker.fetch(new Request("https://x" + path, opts), env);
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json().catch(() => null) : null;
  return { status: r.status, headers: r.headers, data, cookie: cookieFrom(r) };
}
// 取原始响应（校验字节与响应头用）
async function raw(method, path, cookie) {
  const headers = {};
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

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);
