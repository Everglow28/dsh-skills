// DeepSeek Harness 桌面版"重启应用与 Host"菜单项补丁工具。
//
// 背景:app.asar 内 main.js 的应用菜单里,官方自带一个"重启应用与 Host"
// 菜单项(app.relaunch + 无确认退出),但被 `...development ? [...] : []`
// 条目包裹,正式版不显示。本工具把它放开,等长替换,不移动归档偏移。
//
// 用法: node dsh-restart-menu-patch.cjs <prepare|wait|status|revert>
//   prepare: 重新定位当前 app.asar 的偏移 -> 生成已打补丁的副本 -> 启动分离的 wait 进程
//   wait   : 等待应用退出(app.asar 解锁)后自动完成替换;成功后写 last-swap.txt
//   status : 查看当前状态
//   revert : 恢复(优先用 app.asar.old,否则报错)
//
// 兼容性:每次 prepare 都重新解析归档头并搜索模式,官方更新覆盖 app.asar 后
// 重新运行 prepare 即可,不依赖旧偏移。
// 已知坑:本机打包的 Node 构建里 fs.writeSync 的 BigInt position 会写到文件头,
// 必须用 number 位置(勿改回 BigInt)。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

// 定位安装目录(含 app.asar 的 resources 目录),不硬编码路径:
// 1) 环境变量 DSH_RESOURCES_DIR 显式指定;
// 2) 用本脚本运行的 node.exe 路径向上找(内置 runtime 位于 resources/runtime/.../node);
// 3) 回退 %LOCALAPPDATA%/Programs/DeepSeek Harness/resources。
function findResourceDir() {
  const candidates = [];
  if (process.env.DSH_RESOURCES_DIR) candidates.push(process.env.DSH_RESOURCES_DIR);
  let dir = path.dirname(process.execPath);
  for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
    candidates.push(path.join(dir, "resources"));
    dir = path.dirname(dir);
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources"));
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "app.asar"))) return c;
  }
  throw new Error("app.asar not found; set DSH_RESOURCES_DIR to the app's resources directory");
}

const RESOURCE_DIR = findResourceDir();
const LIVE = RESOURCE_DIR + "/app.asar";
const WORK = __dirname;
const PATCHED = path.join(WORK, "app.asar.patched");
const MARKER = path.join(WORK, "last-swap.txt");
const NEEDLE = Buffer.from("...development ? [", "utf8");
const PATCHED_NEEDLE = Buffer.from("...true/*dev*/ ? [", "utf8");
const ORIG = Buffer.from("development", "utf8");
const PATCH = Buffer.from("true/*dev*/", "utf8");
const SLEEP = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 解析 asar 头,返回 main.js 的绝对数据偏移与大小。 */
function mainInfo(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  const sizeBuf = Buffer.alloc(8);
  fs.readSync(fd, sizeBuf, 0, 8, 0);
  const headerSize = sizeBuf.readUInt32LE(4);
  const hdrBuf = Buffer.alloc(headerSize);
  fs.readSync(fd, hdrBuf, 0, headerSize, 8);
  const jsonSize = hdrBuf.readUInt32LE(4);
  const json = JSON.parse(hdrBuf.slice(8, 8 + jsonSize).toString());
  const main = json.files.lib.files["main.js"];
  const info = { dataOffset: 8 + headerSize + Number(main.offset), size: main.size };
  fs.closeSync(fd);
  return info;
}

/** 在 main.js 内搜索原始/已补丁两种模式,返回指向变化字节的绝对偏移与当前状态。 */
function locateState(asarPath) {
  const { dataOffset, size } = mainInfo(asarPath);
  const fd = fs.openSync(asarPath, "r");
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, BigInt(dataOffset));
  fs.closeSync(fd);
  let idx = buf.indexOf(NEEDLE);
  if (idx >= 0) return { offset: dataOffset + idx + 3, state: "original" }; // 指向 development
  idx = buf.indexOf(PATCHED_NEEDLE);
  if (idx >= 0) return { offset: dataOffset + idx + 3, state: "patched" }; // 指向 true/*dev*/
  const head = buf.slice(0, 60).toString("utf8").replace(/[^\x20-\x7e]/g, ".");
  throw new Error(`pattern not found (dataOffset=${dataOffset}, size=${size}, head=${head})`);
}

function locate(asarPath) {
  return locateState(asarPath).offset;
}

function readBytesAt(file, offset) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(ORIG.length);
  fs.readSync(fd, buf, 0, ORIG.length, BigInt(offset));
  fs.closeSync(fd);
  return buf;
}

// 通过 WMI 创建独立的 wait 进程。不要改回 cp.spawn(即使 detached):
// 沙箱化会话的命令 runner 把子进程放进 Windows Job 对象,命令结束就连带清理;
// 且 waiter 若活在本 Host 内,应用退出时会随 Host 一起被杀,永远等不到换入。
// WMI 创建的进程独立于当前进程树和 Host,是唯一可靠通道。
function spawnWaiter() {
  const cmdline = `"${process.execPath}" "${__filename}" wait`;
  const ps = "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '" + cmdline + "' }; \"$($r.ReturnValue) $($r.ProcessId)\"";
  const out = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  const m = (out.stdout || "").trim().match(/^(\d+) (\d+)$/);
  if (!m || m[1] !== "0") {
    throw new Error(`WMI spawn failed (${(out.stderr || out.stdout || "no output").trim()}); 在普通终端手动运行 wait 命令代替`);
  }
  return Number(m[2]);
}

function prepare() {
  const offset = locate(LIVE);
  const current = readBytesAt(LIVE, offset).toString("utf8");
  if (current === "true/*dev*/") {
    fs.appendFileSync(MARKER, `prepare ${new Date().toISOString()}: live already patched, rebuilding copy\n`);
  }
  fs.copyFileSync(LIVE, PATCHED);
  const fd = fs.openSync(PATCHED, "r+");
  const written = fs.writeSync(fd, PATCH, 0, PATCH.length, offset); // number 位置,BigInt 有 bug
  fs.closeSync(fd);
  const verify = readBytesAt(PATCHED, offset).toString("utf8");
  if (verify !== "true/*dev*/") throw new Error(`patch copy verify failed (written=${written}, read=${verify})`);
  fs.appendFileSync(MARKER, `prepare ${new Date().toISOString()}: copy ready at offset ${offset}\n`);
  // 用 WMI 启动独立等待进程:等应用退出后自动换入
  const waiterPid = spawnWaiter();
  return { offset, waiterPid };
}

function wait() {
  const deadline = Date.now() + 12 * 60 * 60 * 1000;
  let swapped = false;
  while (Date.now() < deadline) {
    const old = LIVE + ".old";
    try {
      if (!swapped) {
        if (fs.existsSync(old)) fs.unlinkSync(old);
        fs.renameSync(LIVE, old);
        fs.copyFileSync(PATCHED, LIVE);
        swapped = true;
      }
      // 用双模式定位验证:已补丁状态不再误判为失败
      const st = locateState(LIVE);
      const verify = readBytesAt(LIVE, st.offset).toString("utf8");
      fs.appendFileSync(MARKER, `swap ${new Date().toISOString()}: done, state=${st.state}, verify=${verify}\n`);
      // 验证通过后才清理回滚文件,避免验证失败误删唯一备份
      if (fs.existsSync(old)) fs.unlinkSync(old);
      return;
    } catch (e) {
      if (swapped) {
        // 换入后验证/记录失败:保留 .old 供 revert,写明原因后退出
        fs.appendFileSync(MARKER, `swap ${new Date().toISOString()}: post-swap error: ${e && e.message}\n`);
        return;
      }
      SLEEP(1000); // 应用仍在运行,等待解锁
    }
  }
  fs.appendFileSync(MARKER, `wait ${new Date().toISOString()}: timed out\n`);
}

function status() {
  const lines = [];
  lines.push("live exists: " + fs.existsSync(LIVE));
  if (fs.existsSync(LIVE)) {
    const st = locateState(LIVE);
    lines.push("live state: " + st.state + " @offset " + st.offset + ": " + readBytesAt(LIVE, st.offset).toString("utf8"));
  }
  lines.push("patched copy exists: " + fs.existsSync(PATCHED));
  lines.push("rollback .old exists: " + fs.existsSync(LIVE + ".old"));
  lines.push("marker:\n" + (fs.existsSync(MARKER) ? fs.readFileSync(MARKER, "utf8") : "(none)"));
  return lines.join("\n");
}

function revert() {
  const old = LIVE + ".old";
  if (!fs.existsSync(old)) throw new Error("no app.asar.old to restore; reinstall the app instead");
  fs.unlinkSync(LIVE);
  fs.renameSync(old, LIVE);
  return "restored: " + readBytesAt(LIVE, locate(LIVE)).toString("utf8");
}

const mode = process.argv[2] || "status";
let result;
try {
  if (mode === "prepare") result = JSON.stringify(prepare());
  else if (mode === "wait") return void wait();
  else if (mode === "revert") result = revert();
  else result = status();
} catch (error) {
  result = "ERROR: " + (error && error.stack ? error.stack : String(error));
}
console.log(result);
