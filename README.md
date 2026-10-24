# dsh-skills

自用的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) skill 集合,每个子目录即一个 skill(含 `SKILL.md`),直接复制/链接到 `~/.dsh/skills/` 即可使用。

| Skill | 用途 |
|---|---|
| [`dsh-plugin-development`](dsh-plugin-development/) | DSH 插件开发 / 本地调试 / 发布全流程规范与踩坑清单(双半部结构、hooks 位置、版本发布九步、BOM/pnpm 冷静期等坑) |
| [`dsh-plugin-screenshots`](dsh-plugin-screenshots/) | 为插件 client UI 生成真实渲染截图:本地 React harness + Edge headless 渲染 `client.js`,状态变体模拟、容差裁剪;图片过大时衔接 tinify 压缩 |
| [`repair-restart-menu`](repair-restart-menu/) | 修复桌面版"重启应用与 Host"菜单项(app.asar 等长字节原地补丁,官方更新后可重跑;附补丁脚本与回滚) |
| [`tinify`](tinify/) | 用 TinyPNG API 压缩/缩放/转换图片(shrink / resize / convert,含 PowerShell 下的坑与计费规则) |

## 安装

```bash
# 单个 skill(示例)
git clone https://github.com/Everglow28/dsh-skills.git
Copy-Item dsh-skills/tinify ~/.dsh/skills/ -Recurse
```

重启 DSH 后生效。

## 说明

- `repair-restart-menu` 运行时产生的 `app.asar.patched` / `app.asar.old`(各约 180MB)不入库。
- 各 skill 之间有少量协作关系(如 screenshots 在图片过大时调用 tinify 压缩)。

## License

MIT
