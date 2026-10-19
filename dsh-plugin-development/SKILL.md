---
name: dsh-plugin-development
description: 开发、调试、发布 DeepSeek Harness(DSH)插件(bundle 双半部:Host index.js + Web client.js)。当用户要写新 DSH 插件、修改/排查已有插件、本地安装测试、或发布到 GitHub/npm 时使用。
---

# DSH 插件开发 / 调试 / 发布

完整的规范、模板与踩坑清单见本目录 [reference.md](reference.md)(基于 glm-quota-dock v1.0.0→v1.3.1 实战并经官方文档校准)。以下为工作流主干,细节以 reference.md 为准。

## 开发前

1. 读官方文档:源码仓库 `docs/cordis-primer.md`、`docs/user/develop/`(basic/framework/practice);本机索引 `~/.dsh/dsh-source-index.md`。
2. 理解三层概念:**插件**(导出 `apply` 的模块)/ **组合包 bundle**(npm 包,`dsh.bundle.patch` 声明配置层)/ **profile**(`$DSH_HOME/profiles/<name>`,有序 bundles 列表)。

## 开发

- 双半部:`index.js`(Host 进程,`inject` 声明依赖,`connection.fetch.register` 注册 `/api` 路由,凭据不出 Host)+ `client.js`(浏览器,`window.__ModuleLoader__.load` + slots 挂载)。
- **hooks 必须全部放在 early return 之前**(槽位条件渲染会崩)。
- 可配置参数导出 Standard Schema/Schemastery `Config`(加载期校验),勿硬编码;颜色用 `--dsw-alias-*` 别名变量。
- `node --check` 两个文件都要过;无构建、无类型,这是唯一静态检查。

## 本地调试

- **改插件前主动进入开发模式**(link 直通),**发布完成后主动退出**(恢复线上正式版),详见 reference.md「开发模式」节;当前处于哪种模式要向用户说明。
- link 安装:profile `package.json` 依赖写 `"link:<绝对路径>"`,bundle 加入 `dsh.profile.bundles`,`pnpm install --dir <profile>`。
- **生效边界:client.js 改动无需重启——刷新页面必生效;切换/新建会话时 Web 端按会话重新拉取插件脚本,实测不手动刷新也能生效(2026-10-19)。index.js 必须重启 DSH。**
- UI 状态可临时伪造模块级缓存来预览,预览完撤掉;接口字段拿真实 JSON 对账,勿凭想象适配。
- 验证层:`dsh --profile <name> --dump-config`。

## 发布(需用户明确指令,一次授权只覆盖当轮)

0. **恢复本机副本到当前已发布正式版**(「发布」= 本轮调试结束;每次发布前自动做,做法见 reference.md 第 9 步)→ 1. `node --check` → 2. **两处版本号同步**(package.json + client 内版本常量)→ 3. 更新 README/版本历史 → 4. commit + push → 5. tag → 6. `gh release create` → 7. `npm publish`(token:用户级环境变量 `NPM_PUBLISH_TOKEN`;账号 2FA 策略要求浏览器认证——**Agent 拉起可见 PowerShell 窗口执行,用户在网页点认证**,命令见 reference.md「发布流程」)→ 8. 轮询 registry 同步(最长 12 分钟)→ 9. 发布后**不升级**本机 profile——留待插件内「可更新」由用户决定(用户明确要求时才 `pnpm update <pkg> --latest --dir <profile>`)。tag / GitHub Release / npm publish 三者相互独立:npm 只认 package.json 的 version,不打 Release 不影响 npm,但 README 的 Release 徽标会停在旧版。

## 高频坑(详见 reference.md 末节)

- **双副本陷阱**:profile 实际加载的是 `dsh.profile.bundles` 里包名对应的 `node_modules` **真实拷贝**;工作区源码目录、`@local/<name>` junction 未必被加载。改源码后"部分改动生效/完全不生效"先查加载的是哪份(对比各候选 client.js 的 SHA256),不要怀疑浏览器缓存。
- 严禁 BOM(PowerShell 5.1 utf8 默认带 BOM,会让 host 崩溃);用 node fs.writeFileSync。
- pnpm 供应链 `minimumReleaseAge` 冷静期会静默降到旧版:profile `pnpm-workspace.yaml` 加**包级** `minimumReleaseAgeExclude`。
- registry 副本同步延迟最长 12 分钟,期间重装会锁旧版本(lockfile 固定后要 `--latest` 跨版)。
