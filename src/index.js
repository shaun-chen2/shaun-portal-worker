// 常用网页总览 —— Cloudflare Workers 版
// 功能：登录 / 开放注册、常用网站书签(按账号隔离)、图片 / GIF 上传(GitHub 私人仓库托管)、
//       视频转 GIF(浏览器端)、管理员账号管理。
// 上传资源存于 GitHub 私人仓库（env.GH_OWNER / env.GH_REPO），由本 Worker 代理读写并强制可见性。
import { LOGIN_HTML, REG_HTML, DASH_HTML, GIFENC_JS } from "./ui.js";
import { SEED_DATA } from "./data.js";

const SESSION_MAX_AGE = 7 * 24 * 3600; // 7 天
const MAX_UPLOAD_B64 = 28 * 1000 * 1000; // 上传体积上限（base64 前约 21MB）

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
// 返回 { username, role, exp } 或 null
async function authUser(request, env) {
  const sid = getCookie(request, "sid");
  const wrapped = sid ? await unsign(sid, env.SESSION_SECRET) : null;
  if (!wrapped) return null;
  let o;
  try { o = JSON.parse(b64urlDecode(wrapped)); } catch (e) { return null; }
  if (!o.username || o.exp * 1000 <= Date.now()) return null;
  return o;
}

// ---------- KV 数据读写（依赖 wrangler.toml 中的 KV 绑定，运行时即 env.KV）----------
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
// 图库元数据（全局）：数组 [{ id, owner, name, type, ext, visibility, path, createdAt }]
async function getGallery(env) {
  return (await env.KV.get("gallery", "json")) || [];
}
async function putGallery(env, arr) {
  await env.KV.put("gallery", JSON.stringify(arr));
}

// ---------- GitHub 私人仓库代理读写 ----------
function ghApiBase(env) {
  return `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}`;
}
function ghRawBase(env) {
  return `https://raw.githubusercontent.com/${env.GH_OWNER}/${env.GH_REPO}/main`;
}
const GH_HEADERS = (env) => ({
  Authorization: `Bearer ${env.GH_TOKEN}`,
  "user-agent": "shaun-portal-worker",
  "content-type": "application/json",
});
async function ghUpload(env, path, base64, message) {
  const r = await fetch(`${ghApiBase(env)}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: GH_HEADERS(env),
    body: JSON.stringify({ message, content: base64, branch: "main" }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("GitHub 上传失败 " + r.status + " " + t.slice(0, 200));
  }
  return r.json();
}
async function ghGetMeta(env, path) {
  const r = await fetch(`${ghApiBase(env)}/contents/${encodeURI(path)}`, { headers: GH_HEADERS(env) });
  if (!r.ok) return null;
  return r.json();
}
async function ghDelete(env, path, sha) {
  const r = await fetch(`${ghApiBase(env)}/contents/${encodeURI(path)}`, {
    method: "DELETE",
    headers: GH_HEADERS(env),
    body: JSON.stringify({ message: "delete asset", sha, branch: "main" }),
  });
  return r.ok;
}
// 取文件二进制：优先 raw（带 token 支持私有库），失败兜底走 API 下载地址
async function ghRaw(env, path) {
  const r = await fetch(`${ghRawBase(env)}/${encodeURI(path)}`, { headers: GH_HEADERS(env) });
  if (r.ok) return r;
  const meta = await ghGetMeta(env, path);
  if (!meta || !meta.download_url) return new Response("Not Found", { status: 404 });
  return fetch(meta.download_url, { headers: GH_HEADERS(env) });
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
      acct = { username: user, hash: h, role: "admin", createdAt: Date.now(), createdBy: null };
      await putAccount(env, acct);
      await putData(env, user, seedForAdmin());
    }
    return issueSession(env, acct);
  }

  // 普通账号（开放注册，无需邀请码）
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

// 开放注册（无需邀请码）
async function handleRegister(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const user = (body.username || "").trim();
  const pass = body.password || "";
  if (!user || !pass) return json({ error: "missing" }, 400);
  if (user.length < 2 || user.length > 32) return json({ error: "username_length" }, 400);
  if (user === env.AUTH_USERNAME) return json({ error: "reserved" }, 400);
  if (pass.length < 4) return json({ error: "password_short" }, 400);

  if (await getAccount(env, user)) return json({ error: "username_taken" }, 400);

  const hash = await sha256Hex(pass);
  const acct = {
    username: user,
    hash,
    role: "user",
    createdAt: Date.now(),
    createdBy: null,
  };
  await putAccount(env, acct);
  await putData(env, user, { folders: [{ id: uuid(), name: "默认收藏", sites: [] }] });
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

// ---------- 上传资源（GitHub 私人仓库）----------
async function handleUpload(request, env, user) {
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: "bad_body" }, 400); }
  const { name, visibility, data, type, ext } = body;
  if (!data || !type || !ext) return json({ error: "missing" }, 400);
  if (visibility !== "public" && visibility !== "private") return json({ error: "visibility" }, 400);
  if (data.length > MAX_UPLOAD_B64) return json({ error: "too_large" }, 413);
  const id = uuid();
  const safeName = (name || "未命名").slice(0, 60);
  const path = `assets/${visibility}/${user.username}/${id}.${ext}`;
  try {
    await ghUpload(env, path, data, `upload ${visibility} ${id}`);
  } catch (e) {
    return json({ error: "upload_failed", msg: String(e.message) }, 502);
  }
  const gallery = await getGallery(env);
  gallery.push({
    id,
    owner: user.username,
    name: safeName,
    type,
    ext,
    visibility,
    path,
    createdAt: Date.now(),
  });
  await putGallery(env, gallery);
  return json({ id });
}
// 取单条资源（强制可见性）
// 由资源元数据推导下载文件名（去掉文件系统非法字符，补上扩展名）
function assetFileName(item) {
  const base =
    String(item.name || "资源")
      .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
      .trim()
      .slice(0, 60) || "资源";
  const ext = String(item.ext || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (ext && !base.toLowerCase().endsWith("." + ext)) return base + "." + ext;
  return base;
}
// 资源地址解析：同时接受 /assets/<uuid> 与 /assets/<uuid>.gif（带扩展名更利于 Markdown 引用）
function parseAssetId(raw) {
  const m = String(raw || "").match(/^([0-9a-zA-Z-]{8,64})(?:\.[0-9a-zA-Z]{1,8})?$/);
  return m ? m[1] : null;
}
// 资源访问失败时返回一个可读的说明页（图片引用方只看状态码，浏览器直接打开时能看到原因）
function assetError(status, title, msg) {
  const html =
    '<!doctype html><meta charset="utf-8"><title>' + title + "</title>" +
    '<body style="margin:0;background:#0f1113;color:#e6e8eb;font:16px/1.7 -apple-system,BlinkMacSystemFont,\'Segoe UI\',system-ui,sans-serif">' +
    '<div style="max-width:520px;margin:18vh auto;padding:0 24px">' +
    '<h1 style="font-size:18px;margin:0 0 10px">' + title + "</h1>" +
    '<p style="margin:0;color:#9aa0a6">' + msg + "</p>" +
    "</div></body>";
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
// 取单条资源（强制可见性）
// user 可为 null：公开资源允许匿名访问（凭链接即可打开，便于 README / Markdown 直接 ![](url)）
async function handleAsset(request, env, user, id) {
  const gallery = await getGallery(env);
  const item = gallery.find((x) => x.id === id);
  if (!item) return assetError(404, "资源不存在", "链接可能有误，或该资源已被删除。");
  const isPublic = item.visibility === "public";
  const isOwner = !!user && item.owner === user.username;
  const isAdmin = !!user && user.role === "admin";
  if (!isPublic && !isOwner && !isAdmin) {
    if (!user) return assetError(401, "需要登录", "这是私人资源，只有上传者本人登录后才能查看。");
    return assetError(403, "无权访问", "这是他人的私人资源，你无权查看。");
  }
  const r = await ghRaw(env, item.path);
  if (!r || r.status === 404) return assetError(404, "资源不存在", "文件已从存储中移除。");
  const buf = await r.arrayBuffer();
  const headers = new Headers();
  headers.set("content-type", item.type || "application/octet-stream");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-length", String(buf.byteLength));
  if (isPublic) {
    // 公开资源允许任意站点 / Markdown 渲染器跨域引用
    headers.set("Cache-Control", "public, max-age=3600");
    headers.set("access-control-allow-origin", "*");
    headers.set("cross-origin-resource-policy", "cross-origin");
  } else {
    // 私人资源禁止缓存，避免跨用户／跨设备泄漏
    headers.set("Cache-Control", "private, no-store");
  }
  // ?dl=1 强制作为附件下载，并给出中文安全的文件名（RFC 5987）
  const dl = new URL(request.url).searchParams.get("dl");
  if (dl === "1") {
    const ext = String(item.ext || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const fallback = "asset" + (ext ? "." + ext : "");
    headers.set(
      "Content-Disposition",
      `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(assetFileName(item))}`
    );
  }
  // HEAD 只回头，不回正文（部分 Markdown 渲染器 / 预览服务会先探测）
  return new Response(request.method === "HEAD" ? null : buf, { status: 200, headers });
}
// 删除资源（本人或管理员）
async function handleDeleteAsset(request, env, user, id) {
  const gallery = await getGallery(env);
  const idx = gallery.findIndex((x) => x.id === id);
  if (idx < 0) return json({ error: "not_found" }, 404);
  const item = gallery[idx];
  if (item.owner !== user.username && user.role !== "admin") return json({ error: "forbidden" }, 403);
  const meta = await ghGetMeta(env, item.path);
  if (meta && meta.sha) await ghDelete(env, item.path, meta.sha);
  gallery.splice(idx, 1);
  await putGallery(env, gallery);
  return json({ ok: true });
}
// 图库列表（仅返回当前用户可见项：本人的 + 全部公开）
async function handleGalleryList(request, env, user) {
  const gallery = await getGallery(env);
  const items = gallery
    .filter((x) => x.visibility === "public" || x.owner === user.username)
    .map(({ id, owner, name, type, ext, visibility, createdAt }) => ({
      id, owner, name, type, ext, visibility, createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  return json({ items });
}

// ---------- 管理员：账号管理 ----------
async function handleAdminAccounts(request, env, user) {
  if (user.role !== "admin") return json({ error: "forbidden" }, 403);
  const list = await env.KV.list({ prefix: "acct:" });
  const out = [];
  for (const k of list.keys) {
    const a = await env.KV.get(k.name, "json");
    if (a) out.push({ username: a.username, role: a.role, createdAt: a.createdAt, createdBy: a.createdBy || null });
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ accounts: out });
}
async function handleAdminDeleteAccount(request, env, user, target) {
  if (user.role !== "admin") return json({ error: "forbidden" }, 403);
  if (target === env.AUTH_USERNAME) return json({ error: "protected" }, 403); // 保护主账号
  const acct = await getAccount(env, target);
  if (!acct) return json({ error: "not_found" }, 404);
  // 清理该用户的所有资源
  const gallery = await getGallery(env);
  const mine = gallery.filter((x) => x.owner === target);
  for (const it of mine) {
    const meta = await ghGetMeta(env, it.path);
    if (meta && meta.sha) await ghDelete(env, it.path, meta.sha);
  }
  await putGallery(env, gallery.filter((x) => x.owner !== target));
  await env.KV.delete("acct:" + target);
  await env.KV.delete("data:" + target);
  return json({ ok: true });
}
async function handleAdminReset(request, env, user, target) {
  if (user.role !== "admin") return json({ error: "forbidden" }, 403);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const pass = (body.password || "").trim();
  if (pass.length < 4) return json({ error: "password_short" }, 400);
  const acct = await getAccount(env, target);
  if (!acct) return json({ error: "not_found" }, 404);
  acct.hash = await sha256Hex(pass);
  await putAccount(env, acct);
  return json({ ok: true });
}
async function handleAdminRole(request, env, user, target) {
  if (user.role !== "admin") return json({ error: "forbidden" }, 403);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const role = body.role === "admin" ? "admin" : "user";
  if (role !== "admin" && target === env.AUTH_USERNAME) return json({ error: "protected" }, 403);
  const acct = await getAccount(env, target);
  if (!acct) return json({ error: "not_found" }, 404);
  acct.role = role;
  await putAccount(env, acct);
  return json({ ok: true, role });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    if (p === "/login" && method === "POST") return await handleLogin(request, env);
    if (p === "/register" && method === "POST") return await handleRegister(request, env);
    if (p === "/logout") {
      return new Response("", { status: 200, headers: { "Set-Cookie": sessionCookie("", 0) } });
    }
    if (p === "/favicon.ico") return new Response("", { status: 204 });

    // 静态资源：gifenc 编码库（同源托管，避免第三方 CDN 不可用 / 模块格式不一致）
    if (p === "/vendor/gifenc.js" && (method === "GET" || method === "HEAD")) {
      return new Response(GIFENC_JS, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    // 资源二进制：GET / HEAD 不强制登录，可见性在 handleAsset 内判定
    // （公开资源凭链接即可访问，方便 README / Markdown 直接 ![](url)；私人资源仍需本人登录）
    const assetMatch = p.match(/^\/assets\/([^/]+)$/);
    if (assetMatch) {
      const assetId = parseAssetId(assetMatch[1]);
      if (method === "GET" || method === "HEAD") {
        if (!assetId) return assetError(404, "资源不存在", "链接格式不正确。");
        return await handleAsset(request, env, await authUser(request, env), assetId);
      }
      if (method === "DELETE") {
        const u = await authUser(request, env);
        if (!u) return json({ error: "unauthorized" }, 401);
        if (!assetId) return json({ error: "not_found" }, 404);
        return await handleDeleteAsset(request, env, u, assetId);
      }
      return json({ error: "method_not_allowed" }, 405);
    }

    // 鉴权接口
    if (["/me", "/data", "/gallery", "/upload"].some((x) => p === x || p.startsWith(x + "/"))) {
      const u = await authUser(request, env);
      if (!u) return json({ error: "unauthorized" }, 401);

      if (p === "/me") return json({ username: u.username, role: u.role });
      if (p === "/data") return json(await getData(env, u.username));
      if (p === "/gallery") return await handleGalleryList(request, env, u);
      if (p === "/upload" && method === "POST") return await handleUpload(request, env, u);
      return json({ error: "not_found" }, 404);
    }

    // 管理员接口
    if (p.startsWith("/admin/")) {
      const u = await authUser(request, env);
      if (!u) return json({ error: "unauthorized" }, 401);
      if (p === "/admin/accounts" && method === "GET") return await handleAdminAccounts(request, env, u);
      const accMatch = p.match(/^\/admin\/accounts\/([^/]+)$/);
      if (accMatch) {
        const target = decodeURIComponent(accMatch[1]);
        if (method === "DELETE") return await handleAdminDeleteAccount(request, env, u, target);
      }
      const resetMatch = p.match(/^\/admin\/accounts\/([^/]+)\/reset$/);
      if (resetMatch && method === "POST") return await handleAdminReset(request, env, u, decodeURIComponent(resetMatch[1]));
      const roleMatch = p.match(/^\/admin\/accounts\/([^/]+)\/role$/);
      if (roleMatch && method === "POST") return await handleAdminRole(request, env, u, decodeURIComponent(roleMatch[1]));
      return json({ error: "not_found" }, 404);
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
        return await withData(request, env, (data) => {
          const f = data.folders.find((x) => x.id === id);
          if (!f) return json({ error: "not_found" }, 404);
          f.name = name;
        });
      }
      if (method === "DELETE") {
        return await withData(request, env, (data) => {
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
      return await withData(request, env, (data) => {
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
        return await withData(request, env, (data) => {
          const found = findSite(data, id);
          if (!found) return json({ error: "not_found" }, 404);
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
        return await withData(request, env, (data) => {
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
      return await withData(request, env, (data) => {
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
