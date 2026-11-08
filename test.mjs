// Worker 鉴权逻辑单元验证（无需真实密码，用已知明文+哈希验证比对/签名/门控）
import { createHash } from "node:crypto";
const sha = (s) => createHash("sha256").update(s).digest("hex");

const testPass = "testpass";
const env = {
  AUTH_USERNAME: "陈帅帅",
  AUTH_HASH: sha(testPass),
  SESSION_SECRET: "unit-test-secret-1234567890",
};

const mod = await import("./src/index.js");
const worker = mod.default;

const req = (url, opts = {}) => new Request("http://localhost" + url, opts);
let pass = 0,
  fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name); }
};

// 1. 未登录访问 / -> 登录页
let r = await worker.fetch(req("/"), env);
check("GET / 未登录 = 200", r.status === 200);
let t = await r.text();
check("GET / 返回登录表单", t.includes('id="loginForm"'));

// 2. 未登录访问 /data -> 401
r = await worker.fetch(req("/data"), env);
check("GET /data 未登录 = 401", r.status === 401);

// 3. 错误凭据 -> 401
r = await worker.fetch(
  req("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "x", password: "y" }) }),
  env
);
check("POST /login 错误凭据 = 401", r.status === 401);

// 4. 正确凭据 -> 200 + Set-Cookie sid
r = await worker.fetch(
  req("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "陈帅帅", password: testPass }) }),
  env
);
check("POST /login 正确凭据 = 200", r.status === 200);
const sc = r.headers.get("Set-Cookie") || "";
check("POST /login 下发 HttpOnly sid", sc.includes("sid=") && sc.includes("HttpOnly"));
const m = sc.match(/sid=([^;]+)/);
const sid = m && m[1];

// 5. 带 cookie 访问 / -> 总览
r = await worker.fetch(req("/", { headers: { Cookie: "sid=" + sid } }), env);
check("GET / 已登录 = 200", r.status === 200);
t = await r.text();
check("GET / 已登录返回总览容器", t.includes('id="content"'));

// 6. 带 cookie 访问 /data -> 200 JSON（数据门控核心）
r = await worker.fetch(req("/data", { headers: { Cookie: "sid=" + sid } }), env);
check("GET /data 已登录 = 200", r.status === 200);
const d = await r.json();
check("GET /data 返回书签数据", Array.isArray(d.folders) && d.folders.length > 0);

// 7. 篡改 cookie -> 拒绝
r = await worker.fetch(req("/data", { headers: { Cookie: "sid=" + sid + "x" } }), env);
check("篡改 cookie = 401", r.status === 401);

// 8. 登出清除 cookie
r = await worker.fetch(req("/logout", { method: "POST", headers: { Cookie: "sid=" + sid } }), env);
check("POST /logout = 200", r.status === 200);
const lc = r.headers.get("Set-Cookie") || "";
check("登出清除 sid (Max-Age=0)", lc.includes("sid=") && lc.includes("Max-Age=0"));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
