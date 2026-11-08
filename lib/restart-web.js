import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { envForDetachedSpawn } from "./core.js";

/*
 * 重启助手：等旧宿主让出端口 → 起新宿主 → 抓到新地址后打开浏览器。
 *
 * 两条硬约束（都是踩过的坑）：
 * 1) 新宿主的 stdout/stderr 必须落文件，不能走管道。这个助手是 detached 的，
 *    起来之后就会退出；管道读端一消失，新宿主下一次 console.log 就是 EPIPE，
 *    进程直接死掉 —— 表现是「旧进程关了，新进程没起来」。
 *    dsh-market 的 lib/restart.js 同样用 fs.openSync 拿 fd 传 stdio。
 * 2) 不能一抓到 URL 就走。URL 打出来时宿主可能还在跑激活审计，审计失败时
 *    端口已经绑过、进程随后退出。要等端口「持续可连」才算成功。
 *
 * 这里每一步都写进 err 日志：助手是独立进程，出问题时没有别的地方能留下记录。
 */

const encoded = process.env.DSH_PURGE_RESTART;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const logOut = path.join(os.tmpdir(), `dsh-purge-restart-${stamp}.out.log`);
const logErr = path.join(os.tmpdir(), `dsh-purge-restart-${stamp}.err.log`);

const note = (line) => {
  try {
    fs.appendFileSync(logErr, `[dsh-purge-restart] ${new Date().toISOString()} ${line}\n`);
  } catch { /* 日志写不进去也不能影响重启 */ }
};

if (!encoded) {
  note("no DSH_PURGE_RESTART payload; exiting");
  process.exit(1);
}

let info;
try {
  info = JSON.parse(encoded);
} catch (error) {
  note(`payload is not JSON: ${error && error.message ? error.message : error}`);
  process.exit(1);
}

const port = Number(info.port) || 3080;
const host = typeof info.host === "string" && info.host ? info.host : "127.0.0.1";

note(`helper up (pid ${process.pid}) port=${port} host=${host} oldPid=${info.pid} execPath=${info.execPath}`);
note(`argv=${JSON.stringify(info.argv)}`);
note(`cwd=${info.cwd}`);
note(`logs: out=${logOut} err=${logErr}`);

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
  try {
    process.kill(pid, "SIGTERM");
    note(`sent SIGTERM to ${pid}`);
  } catch (error) {
    note(`SIGTERM to ${pid} failed (probably already gone): ${error && error.message ? error.message : error}`);
  }
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
  note(`opened browser: ${url.replace(/token=[^&]+/, "token=***")}`);
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

const freeAt = Date.now();
if (!(await waitFree())) {
  note(`port ${port} never became free (waited ${Date.now() - freeAt}ms); giving up`);
  process.exit(1);
}
note(`port ${port} is free after ${Date.now() - freeAt}ms; starting the replacement`);

// 旧页面里的 token 在新进程里无效，所以要从新宿主的输出里读那一行地址。
let outFd;
let errFd;
try {
  outFd = fs.openSync(logOut, "a");
  errFd = fs.openSync(logErr, "a");
} catch (error) {
  note(`cannot open the log files (${error && error.message ? error.message : error}); falling back to stdio "ignore"`);
  outFd = "ignore";
  errFd = "ignore";
}

let child;
try {
  child = spawn(info.execPath, info.argv, {
    detached: true,
    stdio: ["ignore", outFd, errFd],
    cwd: info.cwd || process.cwd(),
    env: envForDetachedSpawn(),
    windowsHide: true,
    shell: false,
  });
} catch (error) {
  note(`spawn threw synchronously: ${error && error.message ? error.message : error}`);
  process.exit(1);
}

child.on("error", (error) => {
  note(`spawn reported an error: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
child.unref();
note(`replacement spawned (pid ${child.pid})`);
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

if (url) {
  note(`captured the new address after ${Date.now() - startedAt}ms`);
  if (wantBrowser) openBrowser(url);
} else {
  note(`no "dsh web: http://…" line within 20s; see ${logOut}`);
}

// 端口持续可连才算真的起来了：绑定过一次不算（审计失败会先绑后退）。
const SETTLE_MS = 3000;
const hardBy = Date.now() + 120000;
let steadySince = null;
let verdict = "timed out";
while (Date.now() < hardBy) {
  if (await listening()) {
    if (steadySince === null) steadySince = Date.now();
    else if (Date.now() - steadySince >= SETTLE_MS) {
      verdict = `up (steady for ${SETTLE_MS}ms after ${Date.now() - startedAt}ms)`;
      break;
    }
  } else {
    steadySince = null;
  }
  await sleep(250);
}
note(`replacement ${verdict}`);
process.exit(0);
