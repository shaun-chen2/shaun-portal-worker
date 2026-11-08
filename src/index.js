// 常用网页总览 —— Cloudflare Workers 版（服务端鉴权）
// 与纯静态方案的区别：数据只在登录成功后由 Worker 返回，未登录拿不到 /data，
// 且密码仅以 SHA-256 哈希比对，明文不落盘、不进仓库、不出现在本文件。
import { LOGIN_HTML, DASH_HTML } from "./ui.js";
import { DATA } from "./data.js";

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

function isAuthed(payload) {
  if (!payload) return false;
  try {
    const o = JSON.parse(payload);
    return o.exp * 1000 > Date.now();
  } catch (e) {
    return false;
  }
}

async function handleLogin(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  const user = (body.username || "").trim();
  const pass = body.password || "";
  let ok = false;
  if (user === env.AUTH_USERNAME) {
    const h = await sha256Hex(pass);
    if (h === env.AUTH_HASH) ok = true;
  }
  if (ok) {
    const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE });
    const signed = await sign(payload, env.SESSION_SECRET);
    return new Response("", {
      status: 200,
      headers: { "Set-Cookie": sessionCookie(signed, SESSION_MAX_AGE) },
    });
  }
  return new Response("", { status: 401 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/login" && request.method === "POST") return handleLogin(request, env);
    if (p === "/logout") {
      return new Response("", { status: 200, headers: { "Set-Cookie": sessionCookie("", 0) } });
    }
    if (p === "/favicon.ico") return new Response("", { status: 204 });

    // 受保护的数据接口：仅对登录会话返回
    if (p === "/data") {
      const sid = getCookie(request, "sid");
      const payload = sid ? await unsign(sid, env.SESSION_SECRET) : null;
      if (!isAuthed(payload)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify(DATA), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // 页面：未登录 -> 登录页；已登录 -> 总览
    const sid = getCookie(request, "sid");
    const payload = sid ? await unsign(sid, env.SESSION_SECRET) : null;
    const authed = isAuthed(payload);
    const html = authed ? DASH_HTML : LOGIN_HTML;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
