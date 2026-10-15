---
name: tinify
description: 用 Tinify(TinyPNG)API 压缩、缩放、转换 AVIF/JPEG XL/WebP/JPEG/PNG 图片
whenToUse: 用户要求压缩图片、生成缩略图、把图片转成 WebP/AVIF 等格式时使用
---

# Tinify 图片压缩 API

REST 服务,主机 `https://api.tinify.com`,Basic Auth:用户名固定为 `api`,密码是 API key。

## 前置:API key

- key 存在环境变量 `TINIFY_API_KEY`;未设置时向用户索要,不要猜测。
- 验证 key 的可靠方式:发一次真实 shrink,看响应头 `Compression-Count`(本月已用次数);`GET /keys/current` 虽见于文档,实测可能返回 404,不要依赖它。

```bash
curl -s -D headers.txt https://api.tinify.com/shrink \
  --user "api:$TINIFY_API_KEY" --data-binary @img.png
# headers.txt 里找 Compression-Count: <本月已用次数>
```

## 核心流程:压缩(shrink)

一次调用完成上传+压缩;结果不在 body 里,在响应 header `Location` 指向的 output URL:

```bash
# 1. 上传并压缩(本地文件)
curl -s -D headers.txt https://api.tinify.com/shrink \
  --user "api:$TINIFY_API_KEY" \
  --data-binary @unoptimized.jpg
# 2. 从 headers.txt 取 Location: https://api.tinify.com/output/<id>
# 3. 下载压缩结果
curl -s https://api.tinify.com/output/<id> \
  --user "api:$TINIFY_API_KEY" --output optimized.jpg
```

也可以直接传图片 URL 而不上传文件:

```bash
curl -s https://api.tinify.com/shrink \
  --user "api:$TINIFY_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"source": {"url": "https://example.com/img.png"}}'
```

## 缩放(resize)

对 output URL 再 POST 一次。method 四选一:

- `scale`:等比缩放到指定宽或高(只给 width 或 height 之一)
- `fit`:等比缩放到不超出给定宽高(两者都给)
- `cover`:等比缩放+智能裁剪到精确宽高
- `thumb`:cover 增强,识别纯背景抠图并留白/裁剪

```bash
curl -s https://api.tinify.com/output/<id> \
  --user "api:$TINIFY_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"resize": {"method": "fit", "width": 150, "height": 100}}' \
  --output thumbnail.jpg
```

不会放大图片:目标尺寸大于原图时保持原尺寸。

## 格式转换(convert)

支持 WebP / JPEG / PNG / AVIF / JPEG XL 互转;`type` 给数组时返回最小的一种:

```bash
--data '{"convert": {"type": ["image/webp", "image/avif"]}}'
```

透明图转 JPEG 等不支持透明的格式时必须给背景色,否则失败:

```bash
--data '{"convert": {"type": "image/jpeg"}, "transform": {"background": "#ffffff"}}'
```

多类型转换时从响应元数据读实际得到的扩展名。

## Windows / PowerShell 注意

- **JSON body 一律写成文件再用 `--data "@body.json"` 传入**,不要内联:PowerShell 会剥掉单引号里的双引号,导致 400 "Expected property name"。
- 写 JSON 文件用 node 或 utf8NoBOM,不要 PS 5.1 的 `Set-Content -Encoding utf8`(带 BOM)。

## 计费规则(重要,操作前提醒用户)

- 上传一张图 = 1 次压缩
- 对同一张图每个 resize 或 convert 操作 = 额外 1 次
- preserve 元数据不额外计费,但与直接 `--data-binary @file` 上传不能同时用,curl 直传场景一般跳过(默认丢元数据,体积更小)
- 免费每月 500 次;批量操作前先用 `/keys/current` 查余量,量大时先告知用户预计消耗

## 错误处理

| 情况 | 处理 |
|---|---|
| HTTP 401 / AccountError(key 无效或超额) | 停止重试,让用户检查 key 或等下月/升级 |
| HTTP 400 / ClientError(请求或图片有问题) | 停止重试,检查参数与图片格式 |
| HTTP 5xx / ServerError(临时故障) | 等几分钟后可重试 |
| 连接失败 | 检查网络后可重试 |

## 禁止事项

- 不要把 API key 写进任何输出文件、日志或代码里
- 不要在未告知用户的情况下批量消耗其压缩额度
