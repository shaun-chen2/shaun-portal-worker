// 常用网页总览 —— Cloudflare Workers 版（多账号 + 邀请码 + 每用户数据 + CRUD）
// 数据持久化在 KV：
//   acct:<username>  -> { username, hash, role, createdAt, createdBy }
//   invite:<code>    -> { code, createdBy, createdAt, usedBy, usedAt }
//   data:<username>  -> { folders: [{ id, name, sites: [{ id, title, url }] }] }
// 主账号(env.AUTH_USERNAME)首次登录时惰性初始化，并用 Firefox 种子数据播种。
import { LOGIN_HTML, REG_HTML, DASH_HTML } from "./ui.js";
import { SEED_DATA } from "./data.js";

const SESSION_MAX_AGE = 7 * 24 * 3600; // 7 天

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sign(value, secret) {
  return value + "." + (await hmac(secret, value));
}
async function unsign(signed, secret) {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = await hmac(secret, value);
  const sig = signed.slice(i + 1);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let k = 0; k < sig.length; k++) diff |= sig.charCodeAt(k) ^ expected.charCodeAt(k);
  return diff === 0 ? value : null;
}
function uuid() {
  return crypto.randomUUID();
}
function getCookie(request, name) {
  const c = request.headers.get("Cookie");
  if (!c) return null;
  for (const part of c.split(";")) {
    const t = part.trim();
    const eq = t.indexOf("=");
    if (eq > 0 && t.slice(0, eq) === name) return decodeURIComponent(t.slice(eq + 1));
  }
  return null;
}
function sessionCookie(value, maxAge) {
  return `sid=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(str)));
}
// 返回 { username, role } 或 null
async function authUser(request, env) {
  const sid = getCookie(request, "sid");
  const wrapped = sid ? await unsign(sid, env.SESSION_SECRET) : null;
  if (!wrapped) return null;
  let o;
  try { o = JSON.parse(b64urlDecode(wrapped)); } catch (e) { return null; }
  if (!o.username || o.exp * 1000 <= Date.now()) return null;
  return o;
}

// ---------- KV 数据读写 ----------
async function getAccount(env, username) {
  return env.KV.get("acct:" + username, "json");
}
async function putAccount(env, acct) {
  await env.KV.put("acct:" + acct.username, JSON.stringify(acct));
}
async function getData(env, username) {
  return (await env.KV.get("data:" + username, "json")) || { folders: [] };
}
async function putData(env, username, data) {
  await env.KV.put("data:" + username, JSON.stringify(data));
}

// 主账号首次登录时播种 Firefox 数据
function seedForAdmin() {
  const folders = (SEED_DATA.folders || []).map((f) => ({
    id: uuid(),
    name: f.name,
    sites: (f.sites || []).map((s) => ({ id: uuid(), title: s.title, url: s.url })),
  }));
  const freq = (SEED_DATA.frequent || []).slice(0, 40);
  if (freq.length) {
    folders.push({
      id: uuid(),
      name: "常用站点",
      sites: freq.map((s) => ({ id: uuid(), title: s.title, url: s.url })),
    });
  }
  return { folders };
}

async function handleLogin(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const user = (body.username || "").trim();
  const pass = body.password || "";
  if (!user || !pass) return json({ error: "missing" }, 400);

  // 主账号（惰性初始化）
  if (user === env.AUTH_USERNAME) {
    const h = await sha256Hex(pass);
    if (h !== env.AUTH_HASH) return json({ error: "unauthorized" }, 401);
    let acct = await getAccount(env, user);
    if (!acct) {
      acct = { username: user, hash: h, role: "admin", createdAt: Date.now() };
      await putAccount(env, acct);
      await putData(env, user, seedForAdmin());
    }
    return issueSession(env, acct);
  }

  // 普通账号
  const acct = await getAccount(env, user);
  if (!acct) return json({ error: "unauthorized" }, 401);
  const h = await sha256Hex(pass);
  if (h !== acct.hash) return json({ error: "unauthorized" }, 401);
  return issueSession(env, acct);
}
function issueSession(env, acct) {
  const payload = JSON.stringify({
    username: acct.username,
    role: acct.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  });
  const wrapped = b64urlEncode(payload);
  return sign(wrapped, env.SESSION_SECRET).then((signed) =>
    new Response("", {
      status: 200,
      headers: { "Set-Cookie": sessionCookie(signed, SESSION_MAX_AGE) },
    })
  );
}

async function handleRegister(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const user = (body.username || "").trim();
  const pass = body.password || "";
  const invite = (body.invite || "").trim();
  if (!user || !pass || !invite) return json({ error: "missing" }, 400);
  if (user.length < 2 || user.length > 32) return json({ error: "username_length" }, 400);
  if (user === env.AUTH_USERNAME) return json({ error: "reserved" }, 400);
  if (pass.length < 4) return json({ error: "password_short" }, 400);

  // 邀请码校验
  const inv = await env.KV.get("invite:" + invite, "json");
  if (!inv || inv.usedBy) return json({ error: "invite_invalid" }, 400);

  // 用户名去重
  if (await getAccount(env, user)) return json({ error: "username_taken" }, 400);

  const hash = await sha256Hex(pass);
  const acct = {
    username: user,
    hash,
    role: "user",
    createdAt: Date.now(),
    createdBy: inv.createdBy,
  };
  await putAccount(env, acct);
  await putData(env, user, { folders: [{ id: uuid(), name: "默认收藏", sites: [] }] });

  // 标记邀请码已用
  inv.usedBy = user;
  inv.usedAt = Date.now();
  await env.KV.put("invite:" + invite, JSON.stringify(inv));

  return issueSession(env, acct);
}

// 在已鉴权上下文中读取并修改当前用户的数据
async function withData(request, env, fn) {
  const u = await authUser(request, env);
  if (!u) return json({ error: "unauthorized" }, 401);
  const data = await getData(env, u.username);
  const result = await fn(data, u);
  await putData(env, u.username, data);
  return json(result === undefined ? data : result);
}

function findSite(data, siteId) {
  for (const f of data.folders) {
    const idx = f.sites.findIndex((s) => s.id === siteId);
    if (idx >= 0) return { folder: f, site: f.sites[idx], idx };
  }
  return null;
}

async function handleInvite(request, env, user) {
  if (user.role !== "admin") return json({ error: "forbidden" }, 403);
  if (request.method === "POST") {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    for (let i = 0; i < 8; i++) code += alphabet[arr[i] % alphabet.length];
    const rec = { code, createdBy: user.username, createdAt: Date.now(), usedBy: null, usedAt: null };
    await env.KV.put("invite:" + code, JSON.stringify(rec));
    return json({ code });
  }
  // GET：列出所有邀请码
  const list = await env.KV.list({ prefix: "invite:" });
  const out = [];
  for (const k of list.keys) {
    const rec = await env.KV.get(k.name, "json");
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return json({ invites: out });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    if (p === "/login" && method === "POST") return handleLogin(request, env);
    if (p === "/register" && method === "POST") return handleRegister(request, env);
    if (p === "/logout") {
      return new Response("", { status: 200, headers: { "Set-Cookie": sessionCookie("", 0) } });
    }
    if (p === "/favicon.ico") return new Response("", { status: 204 });

    // 受保护的接口
    if (p === "/me") {
      const u = await authUser(request, env);
      if (!u) return json({ error: "unauthorized" }, 401);
      return json({ username: u.username, role: u.role });
    }
    if (p === "/data") {
      const u = await authUser(request, env);
      if (!u) return json({ error: "unauthorized" }, 401);
      return json(await getData(env, u.username));
    }
    if (p === "/invite") {
      const u = await authUser(request, env);
      if (!u) return json({ error: "unauthorized" }, 401);
      return handleInvite(request, env, u);
    }

    // 文件夹 CRUD
    const fMatch = p.match(/^\/folders\/([^/]+)$/);
    if (fMatch) {
      const id = fMatch[1];
      if (method === "PUT") {
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const name = (body.name || "").trim();
        if (!name) return json({ error: "missing" }, 400);
        return withData(request, env, (data) => {
          const f = data.folders.find((x) => x.id === id);
          if (!f) return json({ error: "not_found" }, 404);
          f.name = name;
        });
      }
      if (method === "DELETE") {
        return withData(request, env, (data) => {
          const i = data.folders.findIndex((x) => x.id === id);
          if (i < 0) return json({ error: "not_found" }, 404);
          data.folders.splice(i, 1);
        });
      }
    }
    if (p === "/folders" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const name = (body.name || "").trim() || "未命名文件夹";
      return withData(request, env, (data) => {
        const f = { id: uuid(), name, sites: [] };
        data.folders.push(f);
        return { id: f.id, name: f.name };
      });
    }

    // 站点 CRUD
    const siteMatch = p.match(/^\/sites\/([^/]+)$/);
    if (siteMatch) {
      const id = siteMatch[1];
      if (method === "PUT") {
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const title = (body.title || "").trim();
        const siteUrl = (body.url || "").trim();
        const folderId = body.folderId || null;
        if (!title || !siteUrl) return json({ error: "missing" }, 400);
        return withData(request, env, (data) => {
          const found = findSite(data, id);
          if (!found) return json({ error: "not_found" }, 404);
          // 跨文件夹移动
          if (folderId && folderId !== found.folder.id) {
            const target = data.folders.find((x) => x.id === folderId);
            if (!target) return json({ error: "folder_not_found" }, 404);
            found.folder.sites.splice(found.idx, 1);
            target.sites.push({ id: found.site.id, title, url: siteUrl });
          } else {
            found.site.title = title;
            found.site.url = siteUrl;
          }
        });
      }
      if (method === "DELETE") {
        return withData(request, env, (data) => {
          const found = findSite(data, id);
          if (!found) return json({ error: "not_found" }, 404);
          found.folder.sites.splice(found.idx, 1);
        });
      }
    }
    const sfMatch = p.match(/^\/folders\/([^/]+)\/sites$/);
    if (sfMatch && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const title = (body.title || "").trim();
      const siteUrl = (body.url || "").trim();
      if (!title || !siteUrl) return json({ error: "missing" }, 400);
      const folderId = sfMatch[1];
      return withData(request, env, (data) => {
        const f = data.folders.find((x) => x.id === folderId);
        if (!f) return json({ error: "folder_not_found" }, 404);
        const s = { id: uuid(), title, url: siteUrl };
        f.sites.push(s);
        return { id: s.id, title, url: siteUrl };
      });
    }

    // 页面路由
    if (p === "/" || p === "/register") {
      const u = await authUser(request, env);
      if (u && p !== "/register") return new Response(DASH_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (u && p === "/register") return Response.redirect(url.origin + "/", 302);
      const html = p === "/register" ? REG_HTML : LOGIN_HTML;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },
};
