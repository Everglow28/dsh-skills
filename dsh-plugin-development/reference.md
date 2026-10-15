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

- **client.js 改动** → 刷新页面即生效(link 安装下源码直通)
- **index.js(Host)改动** → **必须重启 DSH**(Host 进程在启动时加载插件)

### 调试技巧

- `node --check client.js` / `index.js` 先过语法(无构建、无类型,这是唯一静态检查)。
- UI 状态可模拟:把组件的模块级缓存/初始 state 临时伪造(如"有更新"的 latest 版本号),刷新页面直看效果,**预览完撤掉再发版**。
- 真实接口字段不确定时:先只透传上游 `data`,在浏览器 Network 拿真实 JSON 对账,再决定哪些字段有 UI 价值——不要凭想象写适配。
- 插件列表出现"幽灵旧版本":多为 profile node_modules 里残留的旧安装副本;对齐 `bundles` 列表与 lockfile、删掉残留目录即可。
- 桌面版技能/工具行为异常:用安装版 CLI(`app.asar` 内)配 `ELECTRON_RUN_AS_NODE=1` + scratch `DSH_HOME` 做 headless 复现。
- 配置查询:会话内 Agent 用 `cordis_inspect_list` / `cordis_inspect_query`(Config.listConfigs)查看激活状态与 packageDir,不执行 Remote 方法。

## 六、发布流程(RELEASE.md 清单)

> 前提(一次性):git init 关联 GitHub;`gh` CLI 登录;npm granular token 存用户级环境变量 `NPM_PUBLISH_TOKEN`(账号开 2FA 时普通 .npmrc token 会被 403)。

每次发版:

1. **改代码** → `node --check` 全过。
2. **升版本**:语义化——新功能 minor、修复 patch;client.js 内 `PLUGIN_VERSION` 常量同步改。
3. **更新文档**:README 特性列表;RELEASE.md 版本历史表加一行。
4. **提交推送**:`git add -A && git commit && git push origin main`。
5. **打标签**:`git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`。
6. **GitHub Release**:`gh release create vX.Y.Z --title "…" --notes "…"`(README 徽标读它)。
7. **npm 发布**(在包目录内;npm 预构建产物,用户安装无需构建授权):
   ```powershell
   $tok = [Environment]::GetEnvironmentVariable('NPM_PUBLISH_TOKEN', 'User')
   npm publish "--//registry.npmjs.org/:_authToken=$tok"
   ```
8. **确认同步**:registry 副本经代理同步有**几分钟到 12 分钟**延迟,轮询 `npm view <pkg> version --prefer-online`;未同步期间**不要**让用户重装,会锁到旧版本。
9. **升级已安装的 profile**:`pnpm update <pkg> --latest --dir <profile>`(普通 `update` 可能因 lockfile 范围不跨版)。

## 七、发布纪律与已知坑

- **发布必须由用户明确指令授权**(2026-10-14 起):一次"继续/发布"只授权当轮;之后的改动只报告"已改完、待发布"。
- **严禁 BOM**:PowerShell 5.1 `Set-Content -Encoding utf8` 默认带 BOM,会让 DSH host `JSON.parse` 直接崩溃;一律用 `node fs.writeFileSync` 或 pwsh 7 `utf8NoBOM`,改完校验头 3 字节非 `EF BB BF`。
- **pnpm 发布冷静期**:DSH 供应链策略有 `minimumReleaseAge`,刚发布的版本装不回来(静默降到旧版)。解法:profile `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 加**包级**条目(按版本豁免可能不生效);或临时 `--config.minimum-release-age=0`。
- **lockfile 固定旧版**:在 registry 同步延迟窗口内安装会把 `^旧版本` 写进 lockfile,之后 `pnpm update` 只在范围内挑;要 `--latest` 强制跨版。
- **patch 覆盖是整行替换**:用户在 profile patch 里 override 某行时必须重述全部 config 键——组合包作者给的默认值因此很重要。
- linked checkout 需要与宿主共享 dsh 包时,按官方规则同时在 `peerDependencies` 与 `devDependencies` 声明;独立第三方依赖放 `dependencies`。
