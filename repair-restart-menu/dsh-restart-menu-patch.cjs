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

const RESOURCE_DIR = "C:/Users/duanye/AppData/Local/Programs/DeepSeek Harness/resources";
const LIVE = RESOURCE_DIR + "/app.asar";
const WORK = __dirname;
const PATCHED = path.join(WORK, "app.asar.patched");
const MARKER = path.join(WORK, "last-swap.txt");
const NEEDLE = Buffer.from("...development ? [", "utf8");
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

/** 在 main.js 内搜索模式,返回 "development" 的绝对字节偏移。 */
function locate(asarPath) {
  const { dataOffset, size } = mainInfo(asarPath);
  const fd = fs.openSync(asarPath, "r");
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, BigInt(dataOffset));
  fs.closeSync(fd);
  const idx = buf.indexOf(NEEDLE);
  if (idx < 0) {
    const head = buf.slice(0, 60).toString("utf8").replace(/[^\x20-\x7e]/g, ".");
    throw new Error(`pattern not found (dataOffset=${dataOffset}, size=${size}, head=${head})`);
  }
  return dataOffset + idx + 3; // 跳过 "..." 前缀,指向 development
}

function readBytesAt(file, offset) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(ORIG.length);
  fs.readSync(fd, buf, 0, ORIG.length, BigInt(offset));
  fs.closeSync(fd);
  return buf;
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
  // 启动分离的等待进程:等应用退出后自动换入
  const child = cp.spawn(process.execPath, [__filename, "wait"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return { offset, waiterPid: child.pid };
}

function wait() {
  const deadline = Date.now() + 12 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const old = LIVE + ".old";
      if (fs.existsSync(old)) fs.unlinkSync(old);
      fs.renameSync(LIVE, old);
      fs.copyFileSync(PATCHED, LIVE);
      const verify = readBytesAt(LIVE, locate(LIVE)).toString("utf8");
      fs.appendFileSync(MARKER, `swap ${new Date().toISOString()}: done, verify=${verify}, rollback at app.asar.old\n`);
      return;
    } catch {
      SLEEP(1000); // 应用仍在运行,等待解锁
    }
  }
  fs.appendFileSync(MARKER, `wait ${new Date().toISOString()}: timed out\n`);
}

function status() {
  const lines = [];
  lines.push("live exists: " + fs.existsSync(LIVE));
  if (fs.existsSync(LIVE)) {
    const offset = locate(LIVE);
    lines.push("live @offset " + offset + ": " + readBytesAt(LIVE, offset).toString("utf8"));
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
