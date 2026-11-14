// 构建脚本：把静态资源 + Firefox 种子数据打包进 Worker 可 import 的模块
// 运行：node build.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

// 共享样式
const styles = readFileSync(BASE + "/assets/styles.css", "utf8");
const loginHtml = readFileSync(BASE + "/assets/login.html", "utf8").replace("/*STYLES*/", styles);
const regHtml = readFileSync(BASE + "/assets/register.html", "utf8").replace("/*STYLES*/", styles);
const dashHtml = readFileSync(BASE + "/assets/dashboard.html", "utf8").replace("/*STYLES*/", styles);

// gifenc（视频转 GIF 编码库）官方 ESM 构建，同源托管为 /vendor/gifenc.js
// 注意：必须用 dist/gifenc.esm.js，dist/gifenc.js 是 CJS（含 exports.xxx），
// 在浏览器里用 import() 加载会抛 "exports is not defined"。
const gifencJs = readFileSync(BASE + "/assets/vendor/gifenc.esm.js", "utf8");

// 从已有的 Firefox 数据文件提取 JSON 对象（仅作为主账号的初始化种子）
const oldDataPath = "/Users/chenhehe/WorkBuddy/2026-11-08-10-10-56/shaun-portal/data.js";
const oldData = readFileSync(oldDataPath, "utf8");
const m = oldData.match(/window\.PORTAL_DATA\s*=\s*([\s\S]*);\s*$/);
if (!m) {
  console.error("无法从 data.js 解析 PORTAL_DATA");
  process.exit(1);
}
const seedJson = m[1];

mkdirSync(BASE + "/src", { recursive: true });
writeFileSync(
  BASE + "/src/ui.js",
  "export const LOGIN_HTML = " + JSON.stringify(loginHtml) + ";\n" +
  "export const REG_HTML = " + JSON.stringify(regHtml) + ";\n" +
  "export const DASH_HTML = " + JSON.stringify(dashHtml) + ";\n" +
  "export const GIFENC_JS = " + JSON.stringify(gifencJs) + ";\n"
);
writeFileSync(BASE + "/src/data.js", "export const SEED_DATA = " + seedJson + ";\n");

console.log("built src/ui.js + src/data.js  OK");
