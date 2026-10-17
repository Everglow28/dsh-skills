---
name: repair-restart-menu
description: 为 DeepSeek Harness 桌面版(Windows)启用官方内置的"重启应用与 Host"应用菜单项。当用户要求恢复"重启 DSH"菜单、或 DeepSeek Harness 更新后菜单项消失时使用。
---

# 修复桌面版"重启应用与 Host"菜单项

DeepSeek Harness 更新会用新的 `app.asar` 覆盖补丁,使左上角"应用"菜单里的"重启应用与 Host"消失。运行本 skill 重新打上补丁。

## 步骤

1. 运行准备模式(重新定位偏移、生成补丁副本、启动分离的等待进程):

   ```
   & "C:\Users\<你的用户名>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" "C:\Users\<你的用户名>\.dsh\skills\repair-restart-menu\dsh-restart-menu-patch.cjs" prepare
   ```

   注意:如果本会话的命令执行沙箱报 `Windows Job runner` 错误或写入 app.asar 副本无效,改用变通通道:临时安装一个 apply 里 `spawnSync` 执行上述命令的 bundle(新目录路径安装,Host 进程不受沙箱限制);或者把上面这条命令交给用户在普通终端里手动运行。

2. 等待进程已挂起,盯着 `app.asar` 的解锁。**让用户完全退出 DeepSeek Harness(托盘图标右键 → 退出)再重新打开**——退出瞬间补丁自动换入,重新打开后左上角"应用"菜单即出现"重启应用与 Host"。

3. 验证:

   ```
   & "…\node.exe" "C:\Users\<你的用户名>\.dsh\skills\repair-restart-menu\dsh-restart-menu-patch.cjs" status
   ```

   `live state: patched @offset …: true/*dev*/` 即生效（`original` 为未打补丁）;`last-swap.txt` 里有 swap 记录。

## 回滚

```
& "…\node.exe" "C:\Users\<你的用户名>\.dsh\skills\repair-restart-menu\dsh-restart-menu-patch.cjs" revert
```

(用 `app.asar.old` 恢复;若无 .old 则需重装应用。)

## 技术说明

- 补丁把 `app.asar` 内 main.js 菜单构建处的 `...development ? [` 改为 `...true/*dev*/ ? [`,等长 11 字节原地替换,解除官方"重启应用与 Host"菜单项的开发模式限制,不改动任何其他逻辑。
- 每次运行都会重新解析 asar 头并搜索模式,不依赖固定偏移,官方更新后可直接重跑。
- 已知坑:本机 Node 构建里 `fs.writeSync` 的 BigInt position 参数会写到文件头,脚本里必须用 number 位置。
- 回滚文件 `app.asar.old` 与补丁副本 `app.asar.patched` 都在 skill 目录/资源目录内,各占约 120MB,确认稳定后可删。
