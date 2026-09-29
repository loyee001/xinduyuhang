# 阿里云静态部署记录

2026-09-27 已发布：<http://39.97.244.43/rover/>。

- 服务器：39.97.244.43，Alibaba Cloud Linux 3。
- 服务：现有 Caddy，使用已开放的 HTTP 80 端口。
- 网页入口：`/var/www/qdstorm/rover`，符号链接指向同目录下独立的 `.rover-release.*` 发布目录。
- 公开内容：`index.html`、`style.css`、`app.js`、`physics.js`、`simulator.js`、`health.json`。没有上传源码仓库、服务端环境文件、账号或数据库。
- 运行方式：浏览器直接执行静态页面。无需 Node.js、构建、数据库、ChatGPT 登录或新增服务器。
- 本次没有修改 Caddy 配置、其他站点、端口或安全组，也无需重载服务。

## 版本与验证

使用 GitHub 提交 `c1cf90fdfe44c13d52e752c57f52ef0d8bf6d4d0` 的静态文件，将 4 处资源路径和 1 处健康检查路径改为相对路径，使根目录及 `/rover/` 子目录均可运行。安装过程先核验源归档 SHA-256，再核验调整后的全部 6 个文件，成功后才创建公开入口。

`aliyun-static-install.sh` 记录首次部署步骤，只适用于目标 `/rover` 尚不存在的情况。已有部署时脚本会直接停止，不会覆盖。后续更新应先准备并验证新的独立发布目录，再切换此站点的符号链接。

公网验证通过：

- 6 个文件全部返回 HTTP 200，内容逐字节等于本地 `dist`，摘要见 `SHA256SUMS`。
- `/rover` 自动以 HTTP 308 跳转到 `/rover/`。
- 390 px 手机视口下内容宽度为 390 px，无水平溢出，实时画面约 30 FPS。
- 线上完成 30 m/s 加速和全力制动试验，停车速度归零，实际刹车距离 52.38 m。
- 浏览器没有 warn/error 日志。

## 维护

```sh
readlink -f /var/www/qdstorm/rover
systemctl is-active caddy
curl -fsS http://39.97.244.43/rover/health.json
```

这个入口目前使用 HTTP。此模拟器没有登录、密钥或真实车辆连接。

原 Sites 的本地部署配置已从版本库移除，备份保留在本机忽略目录 `.openai/hosting.sites-backup.json`，后续不要再使用 Sites 发布本项目。本次未删除此前创建的私有 Sites 站点。
