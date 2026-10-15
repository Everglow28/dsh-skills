---
name: dsh-plugin-screenshots
description: 为 DSH 插件的 client 半部 UI 生成真实渲染截图(Edge headless + 本地 React harness),用于 README/市场展示
whenToUse: 需要给 dsh 插件的 pill/面板/弹窗等 client UI 截图(如 README「截图」章节),尤其是状态变体(正常/告警/临界)需要构造模拟数据时
---

# DSH 插件 UI 截图生成流程

核心思路:**真实加载插件的 `client.js`**,stub 掉网络与宿主服务,在 Edge headless 里渲染出真实 UI 再截图。不是画假图,布局/着色/交互逻辑与真实运行一致。

## 总体流程

1. 克隆插件仓库到工作区临时目录(不要污染仓库)。
2. 写 `shot-harness.html`(模板见下),随 `?pct=45` 等查询参数切换数据状态。
3. 用 `[IO.File]::ReadAllText/WriteAllText`(UTF-8 no BOM)把 `client.js` **内联**进 harness 生成 `shot-inline.html`(内联是为了暴露真实报错,file:// 子脚本的错误会被掩码成 "Script error. @:0")。
4. Edge headless 对每个状态截图,失败静默很常见,**循环重试直到 PNG 存在**。
5. 用 Pillow 按容差阈值自动裁剪,覆盖 `docs/images/*.png`。若单张体积过大(如 > 500KB)或整批图片较重,改用 **tinify skill** 压缩(TinyPNG API,每月 500 次免费额度,用户已确认额度够用,**无需事先确认,直接用**);tinify 顺带可 `convert` 成 WebP 或 `resize` 到展示宽度(README 展示 800px 级别足够,2x 截图可缩到实际显示宽度)。
6. 更新 README 截图说明(如实标注「模拟数据、本地渲染」),清理所有调试产物后再 commit/push。

## Harness 模板(关键部分)

```html
<!DOCTYPE html><html><head><meta charset="utf-8">
<!-- 1) 本地 React UMD:先用 Invoke-WebRequest 从 unpkg 下载 react/react-dom umd 到仓库目录,
     不要在 headless 里引 CDN —— 实测会静默加载失败出全白图 -->
<script src="react.min.js"></script><script src="react-dom.min.js"></script>
<style>
  /* DSH 主题别名 token 手工补齐(浅色近似):*/
  :root{ --dsw-alias-bg-overlay:#fff; --dsw-alias-border-l1:rgba(0,0,0,.12);
    --dsw-alias-label-primary:#1f2329; --dsw-alias-label-secondary:#4b535c;
    --dsw-alias-label-tertiary:#7a828c; --dsw-alias-interactive-bg-hover:rgba(31,35,41,.06);
    --dsw-alias-brand-primary:#0b7fff; --dsw-alias-state-success-primary:#23a55a;
    --dsw-alias-state-warn-primary:#d97706; --dsw-alias-state-error-primary:#dc2626;
    --dsh-content-font-size-secondary:13px; --dsh-content-font-delta-secondary:0px; }
  html,body{margin:0;background:#fff}
  /* 面板是 position:absolute; bottom:100%(开在 pill 上方):
     宿主元素必须固定到视口下部,否则面板被视口顶部裁掉 */
  #stage{position:fixed;bottom:24px;left:100px;width:400px;
    font-family:"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
</style></head><body>
<div id="stage"></div><pre id="errlog"></pre>
<script>
  window.onerror = function (m,s,l){ document.getElementById('errlog').textContent += 'ERR:'+m+'@'+s+':'+l; };
  // 2) 在插件脚本之前 stub window.fetch:拦截 /api/<插件路由> 返回构造数据,
  //    拦截 registry.npmjs.org 返回与插件同版本(避免出现「可更新」药丸)
  // 3) 伪造模块加载器与 slots 宿主 API —— 注意 API 形状:
  window.__ModuleLoader__ = { load(def) {
    const require = (name) => name === 'react' ? React : null;
    const mod = def.factory(require);
    const ctx = { get:()=>null, effect:()=>{},
      slots: { inject(_slot, cb){ cb(); },          // inject 的回调要立即调用
               register(_meta, render){              // register 才是拿到渲染函数的地方
                 ReactDOM.render(React.createElement(render, {
                   useProjection: () => ({ next:{ provider:'zai-coding-cn', model:'glm-4.6' } }),
                 }), document.getElementById('stage'));
                 setTimeout(()=>{ const p=document.querySelector('.glmq-pill'); if(p) p.click(); },120);
               } } };
    mod.apply(ctx); } };
  // 诊断兜底:300ms 后没有目标 DOM 就把 typeof React/__ModuleLoader__/stage 长度写进 errlog
</script>
<!-- 4) 这里内联 client.js -->
</body></html>
```

模拟数据按插件 Host 半部的响应结构构造(以 glm-quota-dock 为例:`{ok,configured,quota:{level,limits:[{type,unit,number,percentage,nextResetTime,usageDetails...}]},modelUsage:{tokensUsage,x_time,modelCallCount,totalUsage...},fetchedAt,client:{...}}`)。状态变体改查询参数对应字段即可。

## Edge headless 截图

```powershell
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
foreach ($p in 45,88,99) {
  & $edge --headless=new --disable-gpu --hide-scrollbars `
    --user-data-dir="$env:TEMP\edge-$p" `   # 每次独立 profile,避免锁冲突
    --force-device-scale-factor=2 `          # 2x 高清
    --window-size=620,620 --virtual-time-budget=10000 `
    --screenshot="$dir\raw-$p.png" "file:///.../shot-inline.html?pct=$p"
  # 重试:截图可能静默失败(不产出文件),循环到文件存在为止
}
```

- `--dump-dom` 调试不可靠(实测对 about:blank 也可能返回空),**以截图内容为准调试**,错误都写在页面 `errlog` 里,肉眼可见。

## Pillow 容差裁剪

页底色不是纯白(有轻微渐变/阴影),普通 `ImageChops.difference().getbbox()` 会失灵,用阈值:

```python
import numpy as np
a = np.asarray(im); mask = (a < 245).any(axis=2)
ys, xs = np.where(mask)   # 四边各留 pad=28 再裁
```

## 踩过的坑(务必遵守)

- **PS 5.1 `Get-Content -Raw`/`Set-Content` 按 GBK 误读 UTF-8**:含中文注释的 JS 内联后直接语法错误。读写一律用 `[System.IO.File]::ReadAllText/WriteAllText` + `UTF8Encoding($false)`。
- **file:// 下子脚本报错被掩码**("Script error. @:0"),必须内联 client.js 才能定位。
- **slots API 形状**:`ctx.slots.inject(slotName, cb)` 后要调 `cb()`;渲染函数从 `ctx.slots.register(meta, render)` 拿,不是从 inject 参数里拿。
- **CDN React 在 headless 里会静默失败**,先 `Invoke-WebRequest` 下载 UMD 到本地。
- 截图全部完成后,**删除 harness、本地 react*.js、raw-*.png、临时克隆**,只提交 `docs/images/*.png` 和 README。
- **图片过大时切到 tinify skill 压缩**(resize/convert 一并处理);用户已确认 500 次/月额度够用,直接用,不必先确认消耗数。
- 截图说明要如实标注「模拟数据、本地渲染」,不要暗示是真实会话截图。
- push 前遵守发布纪律:确认用户本轮明确授权了推送。
