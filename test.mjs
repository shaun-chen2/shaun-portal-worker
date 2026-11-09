// 多账号 + 邀请码 + CRUD 逻辑测试（内存 KV 模拟，无需 Cloudflare）
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
};

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name); } }

function cookieFrom(res) {
  const sc = res.headers.get("Set-Cookie");
  if (!sc) return null;
  const m = sc.match(/sid=([^;]+)/);
  return m ? m[1] : null;
}
function mk(url, opts = {}, cookie = null) {
  const headers = Object.assign({}, opts.headers);
  if (cookie) headers["Cookie"] = "sid=" + cookie;
  return new Request(url, Object.assign({}, opts, { headers }));
}
async function call(method, path, body, cookie) {
  const opts = { method };
  if (body !== undefined) { opts.headers = { "content-type": "application/json" }; opts.body = JSON.stringify(body); }
  const request = mk("https://x/" + path.replace(/^\//, ""), opts, cookie);
  const r = await worker.fetch(request, env);
  let data = null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) data = await r.json().catch(() => null);
  return { status: r.status, data, cookie: cookieFrom(r) };
}

console.log("== 1. 主账号登录 + 惰性播种 ==");
const a = await call("POST", "/login", { username: "陈帅帅", password: ADMIN_PASS });
ok("admin login 200", a.status === 200);
ok("admin got session cookie", !!a.cookie);
const me = await call("GET", "/me", undefined, a.cookie);
ok("me -> 陈帅帅/admin", me.data && me.data.username === "陈帅帅" && me.data.role === "admin");
const d0 = await call("GET", "/data", undefined, a.cookie);
ok("seeded folders from Firefox data", d0.data && d0.data.folders.length > 0);
const seedFolderCount = d0.data.folders.length;

console.log("== 2. 文件夹 CRUD ==");
const f = await call("POST", "/folders", { name: "工作" }, a.cookie);
ok("create folder 200", f.status === 200 && f.data.id);
const folderId = f.data.id;
const f2 = await call("PUT", "/folders/" + folderId, { name: "工作区" }, a.cookie);
ok("rename folder 200", f2.status === 200);

console.log("== 3. 站点 CRUD ==");
const s = await call("POST", "/folders/" + folderId + "/sites", { title: "GitHub", url: "https://github.com" }, a.cookie);
ok("add site 200", s.status === 200 && s.data.id);
const siteId = s.data.id;
const s2 = await call("PUT", "/sites/" + siteId, { title: "GH", url: "https://github.com/x", folderId }, a.cookie);
ok("edit site 200", s2.status === 200);
const dAfter = await call("GET", "/data", undefined, a.cookie);
const movedFolder = dAfter.data.folders.find((x) => x.id === folderId);
ok("site exists in folder", movedFolder && movedFolder.sites.some((x) => x.id === siteId && x.title === "GH"));

console.log("== 4. 主账号生成邀请码 ==");
const inv = await call("POST", "/invite", undefined, a.cookie);
ok("generate invite 200", inv.status === 200 && inv.data.code);
const inviteCode = inv.data.code;
const invList = await call("GET", "/invite", undefined, a.cookie);
ok("invite listed", invList.data.invites.some((x) => x.code === inviteCode && !x.usedBy));

console.log("== 5. 用邀请码注册新账号 ==");
const reg = await call("POST", "/register", { username: "alice", password: "pw1234", invite: inviteCode });
ok("register 200", reg.status === 200 && !!reg.cookie);
const u = await call("GET", "/me", undefined, reg.cookie);
ok("new user role=user", u.data.role === "user");
const udata = await call("GET", "/data", undefined, reg.cookie);
ok("new user has default empty folder", udata.data.folders.length === 1 && udata.data.folders[0].sites.length === 0);

console.log("== 6. 数据隔离 ==");
const adminNow = await call("GET", "/data", undefined, a.cookie);
ok("admin folder count unchanged", adminNow.data.folders.length === seedFolderCount + 1);
ok("admin cannot see alice folder", !adminNow.data.folders.some((x) => x.name === "默认收藏"));

console.log("== 7. 邀请码单次使用 ==");
const reg2 = await call("POST", "/register", { username: "bob", password: "pw1234", invite: inviteCode });
ok("reused invite rejected", reg2.status === 400);

console.log("== 8. 未授权访问被拒 ==");
const noauth = await call("GET", "/data", undefined, null);
ok("GET /data no cookie -> 401", noauth.status === 401);
const noauthInv = await call("POST", "/invite", undefined, null);
ok("POST /invite no cookie -> 401", noauthInv.status === 401);
const userInv = await call("POST", "/invite", undefined, reg.cookie);
ok("POST /invite as user -> 403", userInv.status === 403);

console.log("== 9. 删除站点/文件夹 ==");
const delSite = await call("DELETE", "/sites/" + siteId, undefined, a.cookie);
ok("delete site 200", delSite.status === 200);
const delFolder = await call("DELETE", "/folders/" + folderId, undefined, a.cookie);
ok("delete folder 200", delFolder.status === 200);
const afterDel = await call("GET", "/data", undefined, a.cookie);
ok("folder removed", afterDel.data.folders.length === seedFolderCount);

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);
