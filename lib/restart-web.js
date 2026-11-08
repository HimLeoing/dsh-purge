import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { envForDetachedSpawn } from "./core.js";

/*
 * 重启助手：等旧宿主让出端口 → 起新宿主 → 抓到新地址后打开浏览器。
 *
 * 新宿主的 stdout/stderr 必须落文件，不能走管道。这个助手是 detached 的，
 * 起来之后就会退出；管道读端一消失，新宿主下一次 console.log 就是 EPIPE，
 * 进程直接死掉 —— 表现是「应用点了，旧进程关了，新进程没起来」。
 * dsh-market 的 lib/restart.js 同样用 fs.openSync 拿 fd 传 stdio。
 *
 * 另外不能一抓到 URL 就走：URL 打出来时宿主可能还在跑激活审计，
 * 审计失败时端口已经绑过、进程随后退出。所以要等端口「持续可连」才算成功。
 */

const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) process.exit(1);

let info;
try {
  info = JSON.parse(encoded);
} catch {
  process.exit(1);
}

const port = Number(info.port) || 3080;
const host = typeof info.host === "string" && info.host ? info.host : "127.0.0.1";

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const logOut = path.join(os.tmpdir(), `dsh-purge-restart-${stamp}.out.log`);
const logErr = path.join(os.tmpdir(), `dsh-purge-restart-${stamp}.err.log`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口上有东西在监听吗？（connect 探测，绑定探测会自己占住端口） */
function listening() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    setTimeout(() => done(false), 500);
  });
}

function killOldServer() {
  const pid = Number(info.pid);
  if (!pid || pid === process.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

function openBrowser(url) {
  if (!url) return;
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

async function waitFree() {
  for (let i = 0; i < 40; i++) {
    if (!(await listening())) return true;
    if (i === 8) killOldServer();
    await sleep(120);
  }
  killOldServer();
  for (let i = 0; i < 40; i++) {
    if (!(await listening())) return true;
    await sleep(120);
  }
  return false;
}

if (!(await waitFree())) process.exit(1);

// 旧页面里的 token 在新进程里无效，所以要从新宿主的输出里读那一行地址。
let outFd;
let errFd;
try {
  outFd = fs.openSync(logOut, "a");
  errFd = fs.openSync(logErr, "a");
} catch {
  // 日志开不出来也要能起：退回丢弃输出，绝不再用管道。
  outFd = "ignore";
  errFd = "ignore";
}

const child = spawn(info.execPath, info.argv, {
  detached: true,
  stdio: ["ignore", outFd, errFd],
  cwd: info.cwd || process.cwd(),
  env: envForDetachedSpawn(),
  windowsHide: true,
  shell: false,
});
child.on("error", () => process.exit(1));
child.unref();
// 子进程已经拿到 fd 的副本，父进程这侧关掉自己的那份。
for (const fd of [outFd, errFd]) {
  if (typeof fd === "number") {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

const wantBrowser = info.openBrowser !== false;

let url = null;
const startedAt = Date.now();
while (Date.now() - startedAt < 20000) {
  try {
    const text = fs.readFileSync(logOut, "utf8");
    const match = text.match(/dsh web:\s+(https?:\/\/\S+)/);
    if (match) {
      url = match[1].replace(/[),.;]+$/, "");
      break;
    }
  } catch { /* 文件还没出现 */ }
  await sleep(200);
}

if (url && wantBrowser) openBrowser(url);

// 端口持续可连才算真的起来了：绑定过一次不算（审计失败会先绑后退）。
const SETTLE_MS = 3000;
const hardBy = Date.now() + 120000;
let steadySince = null;
while (Date.now() < hardBy) {
  if (await listening()) {
    if (steadySince === null) steadySince = Date.now();
    else if (Date.now() - steadySince >= SETTLE_MS) break;
  } else {
    steadySince = null;
  }
  await sleep(250);
}

process.exit(0);
