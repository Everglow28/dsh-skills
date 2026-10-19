---
name: repair-restart-menu
description: 为 DeepSeek Harness 桌面版(Windows)启用官方内置的"重启应用与 Host"应用菜单项。当用户要求恢复"重启 DSH"菜单、或 DeepSeek Harness 更新后菜单项消失时使用。
---

# 修复桌面版"重启应用与 Host"菜单项

DeepSeek Harness 更新会用新的 `app.asar` 覆盖补丁,使左上角"应用"菜单里的"重启应用与 Host"消失。运行本 skill 重新打上补丁。

## 步骤

运行命令需要两样东西,脚本会自动探测,无需硬编码:

- **脚本路径**:本 skill 的资源目录下的 `dsh-restart-menu-patch.cjs`(以本 skill 注入时给出的 base directory 为准)。
- **Node 解释器**:优先用系统 PATH 里的 `node`;没有时用应用自带 runtime 的 node,典型位置 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。

1. 运行准备模式(重新定位偏移、生成补丁副本、通过 WMI 启动独立等待进程):

   ```
   & "<node.exe 路径>" "<skill 资源目录>\dsh-restart-menu-patch.cjs" prepare
   ```

   app.asar 位置由脚本自动探测(从 node.exe 路径向上找 `resources\app.asar`,回退 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources`);特殊安装位置可用环境变量 `DSH_RESOURCES_DIR` 指向 resources 目录。

   prepare 会自动用 WMI(`Invoke-CimMethod Win32_Process Create`)创建独立的 wait 进程。**不要改用直接 spawn / 会话后台任务**:沙箱会话的子进程会被 Job 对象连带清理,而且 waiter 若活在本 Host 内,应用退出时会随 Host 一起被杀,永远等不到换入;只有 WMI 创建的进程独立于 Host 才能存活。

   若 prepare 报 `WMI spawn failed`,让用户在普通终端手动运行同一条命令的 `wait` 模式代替。

2. 等待进程已挂起,盯着 `app.asar` 的解锁。**让用户完全退出 DeepSeek Harness(托盘图标右键 → 退出)再重新打开**——退出瞬间补丁自动换入,重新打开后左上角"应用"菜单即出现"重启应用与 Host"。

3. 验证:

   ```
   & "<node.exe 路径>" "<skill 资源目录>\dsh-restart-menu-patch.cjs" status
   ```

   `live state: patched @offset …: true/*dev*/` 即生效（`original` 为未打补丁）;`last-swap.txt` 里有 swap 记录。

## 回滚

```
& "<node.exe 路径>" "<skill 资源目录>\dsh-restart-menu-patch.cjs" revert
```

(用 `app.asar.old` 恢复;若无 .old 则需重装应用。)

## 技术说明

- 补丁把 `app.asar` 内 main.js 菜单构建处的 `...development ? [` 改为 `...true/*dev*/ ? [`,等长 11 字节原地替换,解除官方"重启应用与 Host"菜单项的开发模式限制,不改动任何其他逻辑。
- 每次运行都会重新解析 asar 头并搜索模式,不依赖固定偏移,官方更新后可直接重跑。
- 已知坑:本机 Node 构建里 `fs.writeSync` 的 BigInt position 参数会写到文件头,脚本里必须用 number 位置。
- 回滚文件 `app.asar.old` 与补丁副本 `app.asar.patched` 都在 skill 目录/资源目录内,各占约 120MB,确认稳定后可删。
