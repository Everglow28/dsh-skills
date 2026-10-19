# DSH 插件开发 / 调试 / 发布流程

> 由 dsh-glm-quota-dock 插件完整开发过程(GLM 额度 pill,v1.0.0 → v1.3.0)整理,并结合官方文档校准:
> `D:\code\deepseek-harness\docs\user\develop\`(basic / framework / practice)、`docs/cordis-primer.md`、
> 内置技能 `cordis-plugin-development` / `editing-cordis-compositions` / `cordis-composition-reference`。
> 官方文档入口:源码仓库 `docs/`;子系统速查 `docs/subsystems/README.zh.md`;写插件见 `docs/cordis-primer.md` 与 `docs/user/develop/`。

## 一、核心概念(官方术语)

| 概念 | 官方定义 | manifest |
|---|---|---|
| **插件**(plugin) | 导出 `apply` 函数的模块(也支持对象/类形式),加载时框架传入 `ctx`,通过 `ctx` 注册能力 | — |
| **组合包**(bundle) | 附带一个配置层的 npm 包,回答"这个包贡献什么?"——一个 patch 文件 | `package.json` 的 `dsh.bundle` |
| **profile** | `$DSH_HOME/profiles/<name>` 下描述一份可启动组合的目录,回答"这套配置由哪些组合包按什么顺序组成?" | `package.json` 的 `dsh.profile`(有序 `bundles` 列表) |

插件的三种形态:函数式(最常用)、对象式(`export default { name, inject, apply }`)、类式(需要向其他插件提供服务时,继承 `Service`)。

### 加载顺序(层叠)

生效配置按以下顺序逐层组合(后应用按**行**覆盖,`config` 是整值替换、不做深度合并):

1. profile `dsh.profile.bundles` 列出的各组合包 patch(按列表顺序,dsh-base 最先)
2. profile 自己的 `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`(各 profile 共享的机器级偏好)
4. 每个 `--patch <path>` overlay(按 argv 顺序)

推论:patch 可以按 `id` 覆盖前面层的行,但**必须重述该行需要的每一个键**;组合包作者应给出用户大概率保留的合理默认值,其余交给 schema。

## 二、插件结构(组合包双半部)

一个组合包 = 一个 npm 包,零依赖、无构建:

```
my-plugin/
├── package.json        # dsh.bundle 声明
├── cordis.patch.yml    # 该包被 profile 列出时应用的层
├── index.js            # Host 半部:跑在 DSH Host(Electron 主)进程
├── client.js           # Client 半部:注入 Web 前端(浏览器)
├── locale/*.json       # 可选 i18n
└── icon.svg
```

### package.json

```json
{
  "name": "dsh-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "files": ["index.js", "client.js", "cordis.patch.yml"],  // 决定 npm 发布内容,新文件要加
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]  // 依赖的前端包
    }
  }
}
```

### cordis.patch.yml

```yaml
- insert:
    - id: my-plugin            # Loader 行 id(小写字母数字连字符)
      name: 'dsh-my-plugin'    # 按包名引用(Node 从已安装位置解析)
      config:                  # 插件默认配置(可调参数都应做成配置,勿硬编码)
        endpoint: https://example.com
        minIntervalSec: 60
```

### 配置校验(官方规范)

可配置参数应导出 Schemastery schema(`export const Config`),加载时校验并填默认值;非法配置会让插件加载失败并给出明确错误。不要导出普通对象冒充 Config(不满足 Standard Schema 接口)。原则:**不同部署可能取不同值的参数,一律定义为配置字段**。

## 三、Host 半部(index.js)

- `export const inject = ["connection", "credentials"]` 声明依赖服务,框架保证依赖就绪后才运行 `apply(ctx, config)`。
- HTTP 路由:`ctx.get("connection").fetch.register({ path, methods, fetch })`,**自动位于 `/api` 信任栅栏与浏览器鉴权之后**。
- **自动清理**:通过 ctx 注册的监听、工具、定时器在插件卸载时自动清理;需要手动清理的资源用 `ctx.effect(() => { …; return () => cleanup() })`。
- 敏感信息(API Key)只留在 Host 进程:`ctx.get("credentials").resolve(ref)` 解析,浏览器只拿聚合结果。
- 长耗时操作:缓存 + inflight 去重;辅请求失败不阻塞主请求;失败降级返回 stale 缓存。
- 需要 shell/文件操作时(如自更新):`child_process.execFile` + 超时 + 候选命令回退(pnpm 路径顺序:环境变量 → DSH 运行时内置 `~/.dsh/dsh-runtimes/<runtime>/dependencies/pnpm/bin/pnpm.mjs` → PATH)。

## 四、Client 半部(client.js)

```js
window.__ModuleLoader__.load({
  id: 'dsh-my-plugin',                 // 与 patch 的 id 一致
  factory(require) {
    const React = require('react');    // 宿主提供的 React
    // …组件定义…
    return {
      inject: ['slots'],
      apply(ctx) {
        // 注入 <style>;ctx.effect(() => () => style.remove(), 'id') 注册清理
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-slot', order: 1,
        }, (props) => h(MyWidget, props)));
      },
    };
  },
});
```

实战经验(踩过的坑):

- **hooks 纪律**:槽位组件可能条件性渲染,所有 `useState/useEffect` 必须放在 early return **之前**,否则 hook 计数不一致直接崩掉槽位。
- CSS 走注入的 `<style>` 字符串;颜色用 DSH 别名变量(`--dsw-alias-label-primary`、`--dsw-alias-state-*-primary`、`--dsw-alias-brand-primary`)自动适配明暗主题;精确色值用 `color-mix()` 或固定 hex。
- 弱对比文字可读性差:辅助信息用 `label-secondary` 而非 `tertiary`;层级靠"位置 + 字重"区分,不要一味降透明度。
- 常驻轮询:可见性判断 + 空闲降频 + `visibilitychange` 停止。
- 版本号展示:`v` 前缀 + 灰色小字放页脚,与业务徽标(档位、套餐)在位置/形态/颜色三维度区分;`const PLUGIN_VERSION` 手工与 package.json 同步(浏览器运行时拿不到 package.json)。
- 破坏性操作(如一键自更新)先弹确认气泡再执行;确认后的进行中/完成/失败状态都要有反馈,失败允许重试。

## 五、本地安装与调试

### 安装方式(官方机制)

`dsh plugin --profile <name> <args>` 在 profile 目录内转发给 pnpm,所有 pnpm 子命令可用:

```sh
dsh plugin --profile desktop add ./my-plugin          # 本地目录 → link: 依赖
dsh plugin --profile desktop add github:you/my-plugin # git 托管(源码,见下)
dsh plugin --profile desktop add your-package         # npm
dsh plugin --profile desktop remove dsh-my-plugin     # 同时移除依赖与层
```

- 本地 link 安装(开发期推荐):源码改动**同步即生效**,无需重装;bundle 名可落在 `@local/<name>`(插件管理器惯例)。
- git 安装拉的是**源码不是构建产物**:作者必须提供自包含的 `prepare` 脚本;用户侧 pnpm ≥10 还需在 profile `pnpm-workspace.yaml` 授权(`allowBuilds: { dsh-my-plugin: true }`——这等同允许该包代码在安装时于本机执行,只对可信源码包授权,并锁定 commit `github:you/pkg#<sha>`)。不想让用户授权就发 npm 预构建产物或 tarball(`pnpm pack` → `add ./x.tgz`)。
- 会话内安装:让 Agent 用 `plugin_manager` 的 `install_bundle`(target 传 bundle 目录绝对路径),它会自己跑安装与 bundle 选择;验证用 `list_bundles` / `list_plugins`。

### 验证

```sh
dsh --profile desktop --dump-config   # 应看到 "# == dsh-my-plugin" 层;先验层再启动
```

### 生效边界(关键)

- **client.js 改动** → 无需重启:刷新页面必生效(link 安装下源码直通);Web 端在切换/新建会话时会按会话重新拉取插件脚本,实测不手动刷新也能生效(2026-10-19,profile 副本同步后新会话直接见到新 UI)。反向排查"改动没生效"时,先确认客户端确实重新拉取过(新会话或刷新),再查双副本。
- **index.js(Host)改动** → **必须重启 DSH**(Host 进程在启动时加载插件)

### 开发模式(改前主动进入,发布后主动退出)

本机同时存在"源码仓库"与"已安装副本"时(如 glm-quota-dock:源码在 default-workspace,profile 装的是 npm 拷贝),直接改源码**不会生效**。约定流程(执行时向用户说明当前模式):

**进入开发模式(开始任何修改之前)**:

1. profile `package.json` 依赖改为 `"link:<源码仓库绝对路径>"`(如 `"dsh-glm-quota-dock": "link:C:\\...\\glm-quota-dock"`),bundle 名保持在 `dsh.profile.bundles`;
2. `pnpm install --dir <profile>`;
3. **重启 DSH 一次**(层与 Host 半部在启动时加载)。

此后 client.js 刷新页面即生效、index.js 重启生效,不再有副本同步问题。

**退出开发模式(发布流程全部完成后)**:

1. profile 依赖改回 `"^<修改前已发布的版本>"`(**旧版**,不是刚发布的新版);
2. `pnpm install --dir <profile>`(需要跨 lockfile 范围时用 `pnpm update <pkg> --latest --dir`);
3. **重启 DSH**。

退出后本机插件 = 普通用户手里的旧正式版,插件内的版本检测/一键自更新会真实发现刚发布的新版并从 npm 拉取——这是发布后端到端验证升级链路的唯一方式;link 模式下该链路没有意义。

### 调试技巧

- `node --check client.js` / `index.js` 先过语法(无构建、无类型,这是唯一静态检查)。
- UI 状态可模拟:把组件的模块级缓存/初始 state 临时伪造(如"有更新"的 latest 版本号),刷新页面直看效果,**预览完撤掉再发版**。
- 真实接口字段不确定时:先只透传上游 `data`,在浏览器 Network 拿真实 JSON 对账,再决定哪些字段有 UI 价值——不要凭想象写适配。
- 插件列表出现"幽灵旧版本":多为 profile node_modules 里残留的旧安装副本;对齐 `bundles` 列表与 lockfile、删掉残留目录即可。
- **双副本陷阱(2026-10-19 实战)**:改了工作区源码、刷新甚至重启后"只有部分改动生效"——生效的只是曾手动拷贝过的那份。根因:profile 实际加载 `dsh.profile.bundles` 里包名对应的 `node_modules` **真实拷贝目录**;源码仓库、`@local/<name>` junction(插件管理器 link 惯例的残留)都不一定被加载。诊断:读 profile `package.json` 的 `dsh.profile.bundles` → 对每个候选目录的 `client.js` 求 SHA256 对比源码。修复:同步到实际加载目录应急,或按上节进入 link: 开发模式根治。
- **会话模式与插件开发无关**:标准/创造模式只决定 Agent 会话有哪些工具与技能(创造模式多 `plugin_manager` + `cordis_inspect_*` + 开发技能),不改变插件加载方式。标准模式下没有 `cordis_inspect_query` 报 `packageDir` 时,用上面的哈希对比替代;没有 `plugin_manager` 时,用终端手工改 profile `package.json` + `pnpm install --dir` 等价完成进入/退出开发模式。
- 桌面版技能/工具行为异常:用安装版 CLI(`app.asar` 内)配 `ELECTRON_RUN_AS_NODE=1` + scratch `DSH_HOME` 做 headless 复现。
- 配置查询:会话内 Agent 用 `cordis_inspect_list` / `cordis_inspect_query`(Config.listConfigs)查看激活状态与 packageDir,不执行 Remote 方法。

## 六、发布流程(RELEASE.md 清单)

> 前提(一次性):git init 关联 GitHub;`gh` CLI 登录;npm granular token 存用户级环境变量 `NPM_PUBLISH_TOKEN`(.npmrc 里的旧 token 已失效;2026-10 起 granular token 也因账号 2FA 策略**无法单独直发**,见第 7 步)。

每次发版:

0. **恢复本机副本**(每次发布前自动做,无需用户提示):「发布」指令即代表本轮修改与调试结束——先把本机已安装副本恢复为**当前已发布的正式版**(做法见第 9 步),再走后续发布。这样发版后本机停在旧版,插件的静默更新检查会发现新版并出现「可更新」,何时升级由用户决定,顺带端到端验证自更新链路。
1. **改代码** → `node --check` 全过。
2. **升版本**:语义化——新功能 minor、修复 patch;client.js 内 `PLUGIN_VERSION` 常量同步改。
3. **更新文档**:README 特性列表;RELEASE.md 版本历史表加一行。
4. **提交推送**:`git add -A && git commit && git push origin main`。
5. **打标签**:`git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`。
6. **GitHub Release**:`gh release create vX.Y.Z --title "…" --notes "…"`(README 徽标读它)。
7. **npm 发布**(在包目录内;**2026-10-19 定稿流程:Agent 执行命令,用户只做浏览器认证**)。账号 2FA 策略使纯 token 直发 **403/EOTP**;新建 granular token 也已拿不到 bypass-2fa(2027-01 直发能力全面移除,届时迁移 stage-only / trusted publishing)。Agent 的非交互 shell 里 `npm publish` 会打印 `www.npmjs.com/auth/cli/***` 后**立即退出**——正确做法是 **Agent 拉起一个可见 PowerShell 窗口执行**(窗口内是 TTY,npm 自动打开浏览器),用户在网页完成认证后窗口内命令自动续发:
   ```powershell
   $repo = '<包目录绝对路径>'
   $inner = @'
   $tok=[Environment]::GetEnvironmentVariable('NPM_PUBLISH_TOKEN','User')
   Set-Location "$repo"
   npm publish "--//registry.npmjs.org/:_authToken=$tok"
   Read-Host "见上方 + 包名@版本 即成功,回车关闭"
   '@
   Start-Process powershell -ArgumentList '-NoProfile','-NoExit','-Command',$inner
   ```
   窗口拉起后 Agent 轮询 `npm view <pkg> version --prefer-online`(每 25 秒,最长 12 分钟)确认新版本上线;若账号绑了验证器 App,也可让用户报 6 位码,`npm publish --otp=<码> "--//registry.npmjs.org/:_authToken=$tok"` 在会话内直发(30 秒时效,拿到立即跑)。token 有效性用 `npm whoami "--//registry.npmjs.org/:_authToken=$tok"` 验证(UI 已无 Classic 选项,granular 同为 40 字符,勿以长度区分)。注意:对**已发布版本**重跑 publish 会在 2FA 检查之前就被 "cannot publish over the previously published versions" 短路,不能用它测试认证链路。
8. **确认同步**:registry 副本经代理同步有**几分钟到 12 分钟**延迟,轮询 `npm view <pkg> version --prefer-online`;未同步期间**不要**让用户重装,会锁到旧版本。
9. **发布后本地处理:默认不升级**——本机副本已停在上一个正式版(第 0 步),新版交给插件内自更新呈现「可更新」,何时升级由用户决定(这同时端到端验证了升级链路);**仅当用户明确要求**本地立即升级时才 `pnpm update <pkg> --latest --dir <profile>`(普通 `update` 可能因 lockfile 范围不跨版)。恢复旧正式版的做法:`npm pack <pkg>@<旧版>` 解包,用 `package/` 内文件覆盖 profile `node_modules/<pkg>/`(字节级还原,不触发 pnpm)。

## 七、发布纪律与已知坑

- **发布必须由用户明确指令授权**(2026-10-14 起):一次"继续/发布"只授权当轮;之后的改动只报告"已改完、待发布"。版本号的 minor/patch 判断也属项目层偏好,写在各插件自己的 RELEASE.md(如 glm-quota-dock 要求发版前先询问用户),skill 不携带。
- **严禁 BOM**:PowerShell 5.1 `Set-Content -Encoding utf8` 默认带 BOM,会让 DSH host `JSON.parse` 直接崩溃;一律用 `node fs.writeFileSync` 或 pwsh 7 `utf8NoBOM`,改完校验头 3 字节非 `EF BB BF`。
- **npm 直发 403/EOTP**:granular token 已不能绕 2FA 直发(2026-10-19 实测),Agent 非交互 shell 里 publish 只打印认证 URL 后退出——让用户在交互终端跑,或拿 `--otp`;详见§六第 7 步。
- **pnpm 发布冷静期**:DSH 供应链策略有 `minimumReleaseAge`,刚发布的版本装不回来(静默降到旧版)。解法:profile `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 加**包级**条目(按版本豁免可能不生效);或临时 `--config.minimum-release-age=0`。
- **lockfile 固定旧版**:在 registry 同步延迟窗口内安装会把 `^旧版本` 写进 lockfile,之后 `pnpm update` 只在范围内挑;要 `--latest` 强制跨版。
- **双副本陷阱**:见§五调试技巧——profile 加载 `bundles` 包名对应的 `node_modules` 拷贝,改源码仓库/junction 不等于改插件;开发期应进入 link: 开发模式,发布后退出恢复正式版。
- **patch 覆盖是整行替换**:用户在 profile patch 里 override 某行时必须重述全部 config 键——组合包作者给的默认值因此很重要。
- linked checkout 需要与宿主共享 dsh 包时,按官方规则同时在 `peerDependencies` 与 `devDependencies` 声明;独立第三方依赖放 `dependencies`。
