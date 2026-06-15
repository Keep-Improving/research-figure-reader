# 科研图片理解工具 Web 端

这个目录包含网页工作台和本地 API 后端。网页端可以上传 PDF/图片、保存解析记录；浏览器插件也会连接同一个后端。

## 本地运行

```powershell
npm install
npm run server
```

在另一个终端启动网页：

```powershell
npm run dev
```

默认地址：

- 网页：`http://127.0.0.1:5173/`
- 后端：`http://127.0.0.1:8787/`
- 健康检查：`http://127.0.0.1:8787/api/health`

首次打开网页后，进入“设置”，填写自己的 API key、Base URL 和 Model，然后点击“保存并测试”。这些设置会保存在本机 `data/local-settings.json`，该目录已被 git 忽略，不要发给别人。

## 配置来源

推荐使用网页“设置”页。环境变量仍可作为高级方式使用：

- `OPENAI_API_KEY`：后端调用模型用的 API key。不要放到前端或插件里。
- `OPENAI_BASE_URL`：OpenAI 兼容接口地址，默认 `https://api.openai.com`。
- `OPENAI_MODEL`：模型名，默认可在 `.env` 里配置。
- `PORT`：后端端口，默认 `8787`。
- `ANALYSIS_STORE_PATH`：解析记录保存位置。
- `VITE_API_BASE_URL`：前端构建时使用的后端地址。为空时使用同源 `/api`，本地开发通过 Vite proxy 转发。

后端实际调用模型时优先使用网页“设置”页保存的本地配置；未填写时才读取环境变量。

## 分开部署

如果前端和后端不在同一个域名：

```powershell
$env:VITE_API_BASE_URL="https://your-api.example.com"
npm run build
```

后端部署时需要设置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`、`ANALYSIS_STORE_PATH` 等环境变量。公开多用户版本还需要接入登录、用户隔离和数据库存储，不建议直接把本地 JSON 存储作为公共服务使用。
