# Shopify × Meta 公开官方知识发布器

此仓库只用于自动抓取 Meta、Facebook、Instagram、Shopify 的**公开官方页面**，并发布可校验的本地知识更新包。

它不包含任何账号、Cookie、Token、客户资料、广告成效、课程进度、原始视频、PDF、截图或本机 Hermes 配置。

GitHub Actions 每天执行一次：恢复上次合格资料 → 用 ETag 只读检查官方页面 → 保留临时失败前的合格正文 → 生成 `published/manifest.json` 与压缩包。

本机 Hermes Studio 启动后只下载这两个文件，先核对 SHA-256，再替换本地官方来源、重建 SQLite 索引，并用本机离线模型补齐中文译文。
