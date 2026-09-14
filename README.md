# IELTS Reading 精读词汇复习

支持双语词义、词典搭配、例句、词库及间隔复习。

## 本地运行

安装 Node.js 20 或更新版本后，在项目目录运行：

```sh
node local-dev.mjs
```

浏览器打开 http://127.0.0.1:8787 。本项目无需安装第三方依赖。

## 构建

```sh
node build.mjs
```

输出 dist/server/index.js，导出 Cloudflare Workers 兼容的 fetch 处理器。

## 数据与托管

词库和复习进度保存在浏览器 localStorage 中，不包含在源码中。可在网站“我的词库”中导出 JSON 备份。

查词需要联网访问第三方词典与语料服务。该项目包含服务端接口，不能直接作为纯静态站点部署至 GitHub Pages。上传此仓库不会自动更新当前在线网站。

本源码包不包含原 Sites 托管绑定、Git 历史或访问凭据。

