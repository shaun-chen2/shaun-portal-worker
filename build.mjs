// 构建脚本：把静态资源 + Firefox 数据打包进 Worker 可 import 的模块
// 运行：node build.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

// 共享样式
const styles = readFileSync(BASE + "/assets/styles.css", "utf8");
const loginHtml = readFileSync(BASE + "/assets/login.html", "utf8").replace("/*STYLES*/", styles);
const dashHtml = readFileSync(BASE + "/assets/dashboard.html", "utf8").replace("/*STYLES*/", styles);

// 从已有的 Firefox 数据文件提取 JSON 对象
const oldDataPath = "/Users/chenhehe/WorkBuddy/2026-11-08-10-10-56/shaun-portal/data.js";
const oldData = readFileSync(oldDataPath, "utf8");
const m = oldData.match(/window\.PORTAL_DATA\s*=\s*([\s\S]*);\s*$/);
if (!m) {
  console.error("无法从 data.js 解析 PORTAL_DATA");
  process.exit(1);
}
const dataObj = JSON.parse(m[1]);

// 合并 Firefox cookie 主机名（仅域名，绝不读取 cookie 值）
const cookiesPath = BASE + "/cookies.json";
let cookieSites = [];
try {
  const cj = JSON.parse(readFileSync(cookiesPath, "utf8"));
  cookieSites = (cj.sites || []).map((s) => ({ host: s.host, count: s.count || 0 }));
} catch (e) {
  console.warn("cookies.json 读取失败，跳过 cookie 分区:", e.message);
}
dataObj.cookies = cookieSites;
const dataJson = JSON.stringify(dataObj);

mkdirSync(BASE + "/src", { recursive: true });
writeFileSync(
  BASE + "/src/ui.js",
  "export const LOGIN_HTML = " + JSON.stringify(loginHtml) + ";\n" +
  "export const DASH_HTML = " + JSON.stringify(dashHtml) + ";\n"
);
writeFileSync(BASE + "/src/data.js", "export const DATA = " + dataJson + ";\n");

console.log("built src/ui.js + src/data.js OK | cookies sites:", cookieSites.length);
