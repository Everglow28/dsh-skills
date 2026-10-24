// DeepSeek Harness 桌面版「重启应用与 Host」菜单项补丁工具。
//
// 背景:app.asar 内 main.js 的应用菜单自带「重启应用与 Host」(app.relaunch +
// 无确认退出),但被 `...development ? [...] : []` 包裹,正式版不显示。本工具把
// 它放开:等长 11 字节原地替换,不移动归档偏移。
//
// 用法: node dsh-restart-menu-patch.cjs <prepare|wait|status|revert>
//   prepare: 定位偏移 -> 生成补丁副本 -> 通过 WMI 派发分离的 wait 进程
//   wait   : 等应用退出(app.asar 解锁)后自动换入,成功后写 last-swap.txt
//   status : 查看当前状态
//   revert : 用 app.asar.old 回滚(仅换入校验失败、脚本保留备份时可用)
//
// prepare 为什么用 WMI 派发 wait:DSH 退出时会杀掉其作业对象里的子进程,普通
// spawn(detached) 的 wait 进程活不过那次退出,补丁永远换不进去。WMI
// (Win32_Process.Create) 创建的进程父进程是 WmiPrvSE.exe,不在 DSH 作业对象内,
// 能活到退出之后。这是本工具唯一有效的派发方式,勿改回 spawn。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const WORK = __dirname;
const PATCHED = path.join(WORK, "app.asar.patched");
const MARKER = path.join(WORK, "last-swap.txt");

const NEEDLE = Buffer.from("...development ? [", "utf8");
const PATCHED_NEEDLE = Buffer.from("...true/*dev*/ ? [", "utf8");
const ORIG = Buffer.from("development", "utf8");
const PATCH = Buffer.from("true/*dev*/", "utf8");

const SLEEP = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 从当前 node.exe 位置向上找 resources 目录(其下有 app.asar),不写死用户名。 */
function resourceDir() {
  let dir = path.dirname(process.execPath);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "app.asar"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到 app.asar:请用 DeepSeek Harness 自带的 node.exe 运行(SKILL.md 里有完整路径)");
}

const LIVE = path.join(resourceDir(), "app.asar");
const LIVE_OLD = LIVE + ".old";

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
  throw new Error(`pattern not found (dataOffset=${dataOffset}, size=${size})`);
}

function readBytesAt(file, offset) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(ORIG.length);
  fs.readSync(fd, buf, 0, ORIG.length, BigInt(offset));
  fs.closeSync(fd);
  return buf;
}

/** 用 WMI 创建分离的 wait 进程(不在 DSH 作业对象内),返回 pid。 */
function spawnWaiter() {
  const q = (s) => String(s).replace(/'/g, "''");
  const commandLine = `"${process.execPath}" "${__filename}" wait`;
  const ps = [
    `$arg = @{ CommandLine = '${q(commandLine)}'; CurrentDirectory = '${q(WORK)}' }`,
    `$p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arg`,
    `if ($p.ReturnValue -ne 0) { Write-Output ('ERR ' + $p.ReturnValue); exit 1 }`,
    `Write-Output $p.ProcessId`
  ].join("; ");
  const r = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  const out = String(r.stdout || "").trim();
  const pid = Number(out.split(/\r?\n/).filter(Boolean).pop());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`WMI 派发 wait 进程失败: ${out || r.stderr || r.error || "无输出"}`);
  return pid;
}

function prepare() {
  const st = locateState(LIVE);
  if (st.state === "patched") {
    // 补丁已在:清掉上次的补丁副本,不再重复派发 wait
    if (fs.existsSync(PATCHED)) fs.unlinkSync(PATCHED);
    fs.appendFileSync(MARKER, `prepare ${new Date().toISOString()}: live already patched, nothing to do\n`);
    return { state: st.state, offset: st.offset, waiterPid: null };
  }
  fs.copyFileSync(LIVE, PATCHED);
  const fd = fs.openSync(PATCHED, "r+");
  fs.writeSync(fd, PATCH, 0, PATCH.length, st.offset); // number 位置;BigInt 会写到文件头
  fs.closeSync(fd);
  if (readBytesAt(PATCHED, st.offset).toString("utf8") !== "true/*dev*/") throw new Error("补丁副本校验失败");
  fs.appendFileSync(MARKER, `prepare ${new Date().toISOString()}: copy ready at offset ${st.offset}\n`);
  const waiterPid = spawnWaiter();
  SLEEP(1500);
  try {
    process.kill(waiterPid, 0);
  } catch {
    throw new Error(`wait 进程 ${waiterPid} 未能存活,补丁不会自动换入`);
  }
  fs.appendFileSync(MARKER, `prepare ${new Date().toISOString()}: waiter ${waiterPid} running\n`);
  return { state: st.state, offset: st.offset, waiterPid };
}

function wait() {
  const deadline = Date.now() + 12 * 60 * 60 * 1000;
  let swapped = false;
  while (Date.now() < deadline) {
    try {
      if (!swapped) {
        // 重复/过期的 wait 进程:补丁已换入就自行退出
        if (locateState(LIVE).state === "patched") {
          fs.appendFileSync(MARKER, `wait ${new Date().toISOString()}: live already patched, exit\n`);
          return;
        }
        if (fs.existsSync(LIVE_OLD)) fs.unlinkSync(LIVE_OLD);
        fs.renameSync(LIVE, LIVE_OLD);
        fs.copyFileSync(PATCHED, LIVE);
        swapped = true;
      }
      const st = locateState(LIVE);
      fs.appendFileSync(MARKER, `swap ${new Date().toISOString()}: done, state=${st.state}, verify=${readBytesAt(LIVE, st.offset).toString("utf8")}\n`);
      // 验证通过后才删回滚文件,避免验证失败误删唯一备份
      if (fs.existsSync(LIVE_OLD)) fs.unlinkSync(LIVE_OLD);
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
  lines.push("app.asar: " + LIVE);
  if (!fs.existsSync(LIVE)) {
    lines.push("live state: (app.asar 不存在)");
  } else {
    const st = locateState(LIVE);
    lines.push("live state: " + st.state + " @offset " + st.offset + ": " + readBytesAt(LIVE, st.offset).toString("utf8"));
  }
  lines.push("patched copy exists: " + fs.existsSync(PATCHED));
  lines.push("rollback .old exists: " + fs.existsSync(LIVE_OLD));
  lines.push("marker:\n" + (fs.existsSync(MARKER) ? fs.readFileSync(MARKER, "utf8") : "(none)"));
  return lines.join("\n");
}

function revert() {
  if (!fs.existsSync(LIVE_OLD)) throw new Error("没有 app.asar.old:正常换入成功后备份已删,回滚需重装应用");
  if (fs.existsSync(LIVE)) fs.unlinkSync(LIVE);
  fs.renameSync(LIVE_OLD, LIVE);
  const st = locateState(LIVE);
  return "restored: " + readBytesAt(LIVE, st.offset).toString("utf8");
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
