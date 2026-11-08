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
const dataJson = m[1];

mkdirSync(BASE + "/src", { recursive: true });
writeFileSync(
  BASE + "/src/ui.js",
  "export const LOGIN_HTML = " + JSON.stringify(loginHtml) + ";\n" +
  "export const DASH_HTML = " + JSON.stringify(dashHtml) + ";\n"
);
writeFileSync(BASE + "/src/data.js", "export const DATA = " + dataJson + ";\n");

console.log("built src/ui.js + src/data.js  OK");
