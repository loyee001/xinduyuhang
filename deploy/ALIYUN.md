# 阿里云静态部署记录

站点：<http://39.97.244.43/rover/>。服务器为 Alibaba Cloud Linux 3，使用已有 Caddy 和 HTTP 80 端口。入口 `/var/www/qdstorm/rover` 是指向同目录 `.rover-release.*` 发布目录的符号链接。网页全部在浏览器运行，不需要 Node.js、数据库或 ChatGPT 登录。

## 当前发布：2026-10-01

自动驾驶与随机限速版本已发布，对应 GitHub 提交 [`d6632e2d940e33f7d18fd5149cdd38c33932e6da`](https://github.com/loyee001/xinduyuhang/commit/d6632e2d940e33f7d18fd5149cdd38c33932e6da)。此次发布同时包含之前在本地完成的车流、倒车、推荐变道、出口匝道与普通道路功能。

当前公开文件共 11 个：`index.html`、`style.css`、`app.js`、`physics.js`、`road.js`、`traffic.js`、`lane-control.js`、`simulator.js`、`commands.js`、`autopilot.js`、`health.json`。只发布这 11 个静态文件；源仓库、测试、发布脚本、校验清单、服务器配置和凭证不放入公开目录。

- 184 项自动测试通过。
- 服务器发布脚本对 11 个文件分别输出 `VERIFIED` 和 `HTTP_VERIFIED`，成功输出 `ROVER_LIVE`；归档文件和 Caddy 提供的内容均通过发布清单 SHA-256 校验。
- 公网再次下载全部 11 个文件，内容摘要全部与 `deploy/SHA256SUMS` 一致。
- 线上浏览器完成自动驶离测试：从 0 m 自动起步并靠右，按 40 km/h 匝道限速驶离高速，再进入普通道路继续行驶 126 m，车速 50 km/h，自动驾驶保持运行。实测画面 30 FPS。
- 320 px、390 px 手机视口下 `scrollWidth` 均等于 `innerWidth`，无横向溢出；浏览器控制台没有 warn/error。
- 当前发布目录：`/var/www/qdstorm/.rover-release.heqWtP9o`，由 `/var/www/qdstorm/rover` 链接指向。
- 发布记录目录：`/var/tmp/rover-update.WYBJOUy5`，其中 `new-release.txt` 保存本次 release 路径，`previous-release.txt` 保存回退目标。
- 旧目录 `/var/www/qdstorm/.rover-release.u8vkBtN0` 已保留。本次只原子切换 Rover 的符号链接，没有修改或重载共享 Caddy。

以上为本次已完成的测试和发布验证；下方首次发布的数据单独保留为历史记录。

## 后续更新流程

### 1. 本地验证并固定提交

运行数值与界面检查，完成浏览器验证。代码最终确定后，在仓库根目录重新生成当前清单，并将清单、脚本和代码一起提交推送：

```sh
node --test tests/*.test.cjs
(
  cd dist
  shasum -a 256 index.html style.css app.js physics.js road.js traffic.js lane-control.js simulator.js commands.js autopilot.js health.json
) > deploy/SHA256SUMS
git rev-parse HEAD
```

记录推送后的完整 40 位提交 SHA。`deploy/SHA256SUMS` 必须与同一提交的 `dist` 一致，不能沿用旧版本清单。

### 2. 在既有服务器下载并审查更新脚本

以下命令在已授权的该服务器 root 终端中执行，将 `ROVER_COMMIT` 替换为已推送的完整 SHA。只接受固定仓库 `loyee001/xinduyuhang`：

```sh
ROVER_COMMIT='填写已推送的40位提交SHA'
[[ $ROVER_COMMIT =~ ^[0-9a-f]{40}$ ]] || exit 1
ROVER_RUN=$(mktemp -d /var/tmp/rover-run.XXXXXXXX)
chmod 700 "$ROVER_RUN"
curl --proto '=https' --tlsv1.2 -fL --retry 2 --connect-timeout 15 --max-time 120 \
  "https://raw.githubusercontent.com/loyee001/xinduyuhang/$ROVER_COMMIT/deploy/aliyun-static-update.sh" \
  -o "$ROVER_RUN/update.sh"
bash -n "$ROVER_RUN/update.sh"
cat "$ROVER_RUN/update.sh"
```

本机没有该 IP 的已登记 SSH 主机密钥；可以沿用已登录的 XTerminal 会话，不需要为此改动服务器 SSH 配置或部署凭证。

### 3. 先检查，再发布

```sh
bash "$ROVER_RUN/update.sh" --check "$ROVER_COMMIT"
bash "$ROVER_RUN/update.sh" "$ROVER_COMMIT"
```

`--check` 下载该提交的 GitHub 归档，验证站点入口及 Caddy 状态，严格检查提交内的 11 项清单、归档文件类型、文件名和逐文件 SHA-256。它只在私有 `/var/tmp/rover-update.*` 目录准备检查文件，不切换站点。

正式发布使用 `/run/lock/rover-static-update.lock` 目录防止并行更新。现有入口必须是有效符号链接，解析后的目标必须是 `/var/www/qdstorm` 下的 `.rover-release.*` 目录；脚本不会覆盖普通文件、普通目录或其他站点的链接。新文件写入独立 release，全部验证后设置目录 `755`、文件 `644`，再通过同目录临时链接及 `mv -T` 原子替换入口。

切换后，脚本通过本机 Caddy 的 `Host: 39.97.244.43` 逐项获取 11 个文件并核对摘要；健康请求失败、任何内容不一致或 Caddy 停止都会自动恢复旧链接。旧 release 始终保留。脚本不会修改 Caddy 配置、其他站点、端口或安全组，也不重载服务。

成功输出 `ROVER_LIVE`、`RELEASE`、`PREVIOUS_RELEASE` 和 `RECORDS`。`RECORDS` 指向私有记录目录，其中保存提交 SHA、归档摘要、校验清单及新旧目录路径；保留此目录用于检查与回退。如果进程被无法捕获的信号中断，先检查现有链接及锁目录再处理，不要直接重复覆盖。

### 4. 公网验证及回退

```sh
readlink -f /var/www/qdstorm/rover
systemctl is-active caddy
curl -fsS http://39.97.244.43/rover/health.json
```

从公网核验全部 11 个资源的 HTTP 状态与摘要，验证 `/rover` 到 `/rover/` 的跳转，再检查自动驾驶启动、跟车、提前降限、受限变道、出口接入、停止与手动接管，以及手机布局和控制台错误。

若公网功能验证失败，用发布输出记录的旧 release 恢复。先确认当前入口仍指向本次 `RELEASE`、旧目录确实位于同一站点根目录，再创建新的临时符号链接并原子替换；保留两个 release 以便调查。仅静态文件更新不需要重启 Caddy。

## 首次部署历史：2026-09-27

首次发布使用提交 `c1cf90fdfe44c13d52e752c57f52ef0d8bf6d4d0`，公开 6 个文件。部署时将四处资源路径及健康请求改成相对路径，使 `/rover/` 可用；现在源文件已经使用相对路径，无需发布时改写。

当时验证通过：6 文件均 HTTP 200，`/rover` 返回 308 跳转；390 px 手机布局无横向溢出，约 30 FPS；30 m/s 制动试验停稳，实测 52.38 m；浏览器无 warn/error。此处只描述首次版本，当前发布的验证结果见本文开头。

`aliyun-static-install.sh` 保留首次安装过程及其固定校验值，只适用于 `/rover` 不存在时，不能用于后续更新。`SHA256SUMS` 对应当前发布的 11 个静态文件，后续发布时应随最终代码重新生成并提交。

此入口目前使用 HTTP，模拟器没有登录、密钥或真实车辆连接。旧 Sites 配置的本机备份仍在忽略目录 `.openai/hosting.sites-backup.json`；本项目后续继续使用阿里云，不使用 Sites 发布。
