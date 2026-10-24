---
name: repair-restart-menu
description: 为 DeepSeek Harness 桌面版(Windows)启用官方内置的"重启应用与 Host"应用菜单项。当用户要求恢复"重启 DSH"菜单、或 DeepSeek Harness 更新后菜单项消失时使用。
---

# 修复桌面版「重启应用与 Host」菜单项

DeepSeek Harness 更新会用新的 `app.asar` 覆盖补丁,「应用」菜单里的「重启应用与 Host」随之消失。重跑本 skill 即可恢复。

## 步骤

1. 运行 prepare(定位偏移 → 生成补丁副本 → 通过 WMI 派发分离的等待进程):

   ```powershell
   & "$env:USERPROFILE\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" "$env:USERPROFILE\.dsh\skills\repair-restart-menu\dsh-restart-menu-patch.cjs" prepare
   ```

   脚本按自身 node.exe 位置自动定位 `app.asar`,不用改路径。输出含 `"waiterPid": <数字>` 即已就绪;若输出 `"state":"patched"` 且 `waiterPid` 为 `null`,说明补丁已在,无需退出重开。

2. **让用户完全退出 DeepSeek Harness(托盘图标右键 → 退出),等约 5 秒再重新打开。** 退出后 `app.asar` 解锁,等待进程在 1 秒内自动换入补丁。只关窗口不算退出——Host 还在跑,文件一直被占用。

3. 验证:

   ```powershell
   & "$env:USERPROFILE\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" "$env:USERPROFILE\.dsh\skills\repair-restart-menu\dsh-restart-menu-patch.cjs" status
   ```

   `live state: patched @offset …: true/*dev*/` 即生效;`last-swap.txt` 里有 `swap … done` 记录。

## 回滚

`app.asar.old` 只在换入后校验失败时保留;正常成功后备份已删,回滚需重装应用。若备份还在:

```powershell
& "$env:USERPROFILE\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" "$env:USERPROFILE\.dsh\skills\repair-restart-menu\dsh-restart-menu-patch.cjs" revert
```

## 技术说明

- 补丁把 main.js 菜单构建处的 `...development ? [` 等长替换为 `...true/*dev*/ ? [`(11 字节原地改,不移动归档偏移),放开官方「重启应用与 Host」(`app.relaunch` + 无确认退出)的开发模式限制,不改动其他逻辑。
- `prepare` 每次重新解析 asar 头并搜索模式,不依赖固定偏移,官方更新后可直接重跑。
- **等待进程必须走 WMI 派发**:DSH 退出会连带杀掉其作业对象内的子进程,普通 `spawn(detached)` 的 wait 进程活不过退出,表现为「退出重开仍没有菜单」。WMI(`Win32_Process.Create`)创建的进程挂在 `WmiPrvSE.exe` 下,不在作业对象内。
- 本机 Node 构建里 `fs.writeSync` 的 BigInt position 会写到文件头,必须传 number 位置。
- 运行产物 `app.asar.patched`(约 180MB)、`app.asar.old`、`last-swap.txt` 都在 skill 目录,不入库。
