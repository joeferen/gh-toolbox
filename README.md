# gh-toolbox

GitHub Actions 驱动的工具箱：仓库下每个工具 = 一个自包含的 Python 脚本控制一个 CLI 工具，由独立 workflow 调度（手动输入 / 定时 / 文件变更触发），产物以 Actions Artifact 分发。yt-dlp 是第一个入驻的批处理工具，青龙面板是第一个入驻的服务型工具（长驻进程 + 隧道暴露），后续可继续添加。

## 工具列表

| 工具 | 说明 | Workflow | 入口脚本 |
|---|---|---|---|
| `ytdlp` | yt-dlp 批量下载视频/播放列表 | `.github/workflows/ytdlp.yml` | `tools/ytdlp/download.py` |
| `qinglong` | 托管青龙面板，控制端口经 CF Tunnel 映射访问 | `.github/workflows/qinglong.yml` | `tools/qinglong/run_panel.py` |

## 通用约定

**目录结构**

```
.
├── .github/workflows/   # 每个工具一个 workflow：<工具名>.yml
├── tools/               # 每个工具一个自包含目录
│   ├── ytdlp/
│   │   ├── download.py            # 主脚本（入口）
│   │   ├── requirements.txt       # 该工具专属依赖
│   │   ├── urls.txt               # 输入清单
│   │   ├── .ytdlp-archive.txt     # 跨运行状态，由 workflow 提交回仓库
│   │   └── downloads/             # 输出目录（gitignore，走 Artifact）
│   └── qinglong/
│       ├── run_panel.py           # 主脚本（入口）：起面板 + CF Tunnel + 保活
│       ├── requirements.txt       # 无第三方依赖（仅标准库）
│       ├── data/                  # 青龙数据卷（gitignore，走 Artifact）
│       ├── bin/                   # cloudflared 二进制（gitignore，按需下载）
│       └── cloudflared.log        # cloudflared 日志（gitignore，含隧道地址）
└── README.md
```

**规则**

- 工具脚本自包含：输入清单、档案、输出目录均相对**脚本所在目录**解析，可从任意 cwd 运行。
- 每个工具一个 workflow，步骤骨架固定：
  `checkout → setup-python → pip install -r tools/<工具>/requirements.txt → 运行脚本 → upload-artifact`
- 触发方式按工具自行选择（`workflow_dispatch` / `schedule` / `push`）；**ytdlp 当前为纯手动触发**，参数在 Run workflow 时填写。
- 例外：服务型工具（`qinglong`）**不加 `push` 触发**——代码变更就自动拉起一个最长 6 小时的长驻任务没有意义，只手动 / 定时启动。
- 跨运行需要保留的状态（如下载档案）放工具目录内，workflow 结束时 `git commit` 回写（消息带 `[skip ci]`，且 push 路径过滤，不会递归触发）。

## 新增一个工具

1. `cp -r tools/ytdlp tools/<新工具名>`
2. 修改 `tools/<新工具名>/` 下的脚本逻辑、输入清单、依赖
3. `cp .github/workflows/ytdlp.yml .github/workflows/<新工具名>.yml`，把其中的 `tools/ytdlp` 路径替换为新工具名，按需调整 inputs / cron / artifact
4. 在本 README「工具列表」加一行
5. 提交推送，Actions 页面即可看到新 workflow

## ytdlp 工具说明

控制 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 批量下载视频/播放列表。

### 快速开始（仅手动触发）

1. 编辑 `tools/ytdlp/urls.txt`，填入视频/播放列表/直链/M3U8 URL（每行一个，`#` 注释）。
2. 打开仓库 **Actions → yt-dlp 下载器 → Run workflow**，按需填写参数（见下表），点 **Run workflow**。
3. 运行结束后在 **Artifacts** 区下载 `ytdlp-downloads`。
4. 勾选 `aria2` 时 workflow 会自动安装 aria2；`transcode` 选 `remux`/`recode` 时用 ffmpeg 转码（runner 自带 ffmpeg）。

#### 手动触发参数

| 输入 | 类型 | 说明 | 默认 |
|---|---|---|---|
| `urls` | string | 下载目标，每行一个（视频/播放列表/直链/M3U8）；留空用 `urls.txt` | 空 |
| `format` | string | 格式表达式 | 空（脚本默认 `bv*+ba/b`） |
| `playlist_end` | string | 每个播放列表下载上限，0 不限 | `0` |
| `transcode` | choice | 转码为 MP4：`none` 不处理 / `remux` 仅换封装(流拷贝,快) / `recode` 重编码 H.264/AAC(慢,兼容最好) | `none` |
| `aria2` | boolean | 使用 aria2c 多连接加速（自动安装） | `false` |

常用组合：

| 需求 | 参数 |
|---|---|
| 下载 M3U8，输出 MP4（yt-dlp 默认即是，无需转码参数） | 留空 |
| 来源是 mkv/webm/ts 等，想无损换成 mp4 封装 | `transcode=remux` |
| 来源编码古怪（如 mpeg2/wmv），要标准 H.264 MP4 | `transcode=recode` |
| 大文件多连接加速 | `aria2` 勾选 |
| 只要 1080p | `format=best[height<=1080]` |

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `YTDLP_URLS` | 下载目标（换行/逗号分隔），优先于 `urls.txt` | 空 |
| `YTDLP_OUTPUT_DIR` | 输出目录，相对路径基于工具目录解析 | `downloads` |
| `YTDLP_TEMPLATE` | 输出文件名模板 | `%(title)s [%(id)s].%(ext)s` |
| `YTDLP_FORMAT` | 格式表达式 | `bv*+ba/b` |
| `YTDLP_MERGE_FORMAT` | 合并封装格式 | `mp4` |
| `YTDLP_ARCHIVE` | 下载档案路径 | `tools/ytdlp/.ytdlp-archive.txt` |
| `YTDLP_PLAYLIST_END` | 播放列表下载上限 | `0` |
| `YTDLP_CONCURRENT_FRAG` | 分片并发数 | `4` |
| `YTDLP_RETRIES` | 网络重试次数 | `10` |
| `YTDLP_COOKIES` | Netscape cookies 文件路径 | 空 |
| `YTDLP_VERBOSE` | 置 1 输出 yt-dlp debug 日志 | 空 |
| `YTDLP_TRANSCODE` | 转码为 MP4：`none` 不处理 / `remux` 流拷贝换封装(快) / `recode` 重编码 H.264/AAC(慢) | `none` |
| `YTDLP_ARIA2` | 启用 aria2c 加速（`1`/`true`/`yes`/`on`） | 关 |
| `YTDLP_ARIA2_ARGS` | aria2c 附加参数（空格分隔） | `-x 16 -s 16 -k 1M` |

### 本地运行

```bash
pip install -r tools/ytdlp/requirements.txt

# 用 urls.txt（脚本自定位，任意目录运行均可）
python tools/ytdlp/download.py

# 命令行直接传 URL（会追加到下载列表）
python tools/ytdlp/download.py "https://www.youtube.com/watch?v=BaW_jenozKc"

# 覆盖参数
YTDLP_FORMAT="best[height<=1080]" python tools/ytdlp/download.py

# 强制统一为 mp4 封装（流拷贝；HLS 来源默认即输出 mp4）
YTDLP_TRANSCODE=remux python tools/ytdlp/download.py "https://example.com/video/index.m3u8"

# aria2 多连接加速（需本机 PATH 中已有 aria2c）
YTDLP_ARIA2=1 python tools/ytdlp/download.py "https://example.com/big.mp4"
```

### cookies（可选）

需要登录/年龄验证的站点：

```bash
base64 -w0 cookies.txt   # 生成单行 base64
```

把输出添加到仓库 Secrets：`Settings → Secrets and variables → Actions → New repository secret`，名 `YTDLP_COOKIES`。workflow 会自动解码为 `cookies.txt` 并传给脚本（`cookies.txt` 已在 `.gitignore` 中，不会提交）。

### 下载档案

`download.py` 每下载完成一个视频就把 `extractor 视频ID` 写入 `.ytdlp-archive.txt`，workflow 结束后把该文件提交回仓库，因此定时任务不会重复下载已完成的内容。删除某行即可强制重新下载。

### 注意事项

- **Artifact 体积**：GitHub 免费额度有存储上限（仓库级 500 MB），大下载建议缩短 `retention-days` 或改用其他存储（如 rclone 上传 WebDAV/网盘）。
- **yt-dlp 时效性**：workflow 每次 `pip install -U` 装最新版；仍可能遇到站点改版导致个别 URL 失败——脚本会跳过失败项继续下载其他 URL，最终以退出码 1 标记失败。
- **大播放列表/频道**：首次会解析两遍（先查档案再下载），`YTDLP_PLAYLIST_END` 可限制规模。
- **时区**：cron 使用 UTC，默认 `0 18 * * *` = 北京时间 02:00。
- **超时**：job `timeout-minutes: 360` 为 GitHub 托管 runner 上限，特大任务需拆分。
- 修改 `YTDLP_OUTPUT_DIR` 时，同步修改 workflow 中 `upload-artifact` 的 `path`。
- **转码模式**（`YTDLP_TRANSCODE`）：`remux` = 换 mp4 封装且流直接拷贝（秒级、无损，源编码不兼容 mp4 时 ffmpeg 报错）；`recode` = 换 mp4 封装并按 ffmpeg 的 mp4 默认编码器重编码（视频 H.264、音频 AAC，慢但任何来源都能得到标准 MP4）。注意：① HLS/m3u8 来源 yt-dlp 默认就输出 mp4，转码参数主要服务于 mkv/webm/ts 等其他封装；② 已是 mp4 的文件会跳过不重复处理；③ recode 重编码耗时较长，大视频留意 6 小时 job 上限。
- **aria2**：勾选后 workflow 自动安装；本地运行需 PATH 中已有 `aria2c`，否则脚本告警并回退内置下载器。aria2 主要加速直链/分片下载，HLS(m3u8) 仍走 yt-dlp 内置或 ffmpeg 下载器。

## qinglong 工具说明

在 GitHub Actions runner 上用 Docker 起一个[青龙面板](https://github.com/whyour/qinglong)，把控制端口（默认 5700）通过 Cloudflare Tunnel 映射成公网地址。runner 是临时的，**job 结束（保活到期 / 手动取消 / 360 分钟上限）后面板即销毁**，数据以 Artifact 形式留存。

### 快速开始

1. 打开仓库 **Actions → 青龙面板 + CF Tunnel → Run workflow**：
   - `cf_mode`：`quick`（默认，免密临时隧道）或 `token`（命名隧道，需先配 Secret）
   - `run_minutes`：保活时长，默认 360（= runner 上限，约 6 小时）
   - `ql_image`：镜像，默认 `whyour/qinglong:latest`；依赖兼容问题换 `whyour/qinglong:debian`
   - `persist_data`：是否把 `data/` 提交回仓库，默认否
2. 运行后访问地址有两个来源：**Step Summary**（`青龙面板已启动` 摘要）和运行日志里打印的 `青龙面板访问地址：https://xxx.trycloudflare.com`。
3. 首次打开会引导初始化管理员账号——**立刻设置强密码**，临时隧道域名是公开可猜的随机地址。
4. 结束后的 `data/` 目录（配置、脚本、sqlite、日志）在 **Artifacts** 区下载 `qinglong-data`。

### 两种隧道模式

| 模式 | 地址 | 适用 |
|---|---|---|
| `quick`（默认） | 随机 `https://<随机子域>.trycloudflare.com`，每次运行都变 | 临时用、免配置；无 SLA，CF 可能随时回收 |
| `token` | Cloudflare 控制台配置的固定域名 | 长期用；需先在 Zero Trust 控制台建隧道 |

**命名隧道配置方法**（`cf_mode=token`）：

1. Cloudflare Zero Trust 控制台 → **Access → Tunnels → Create a tunnel**（选 Cloudflared），复制安装命令里的 Token。
2. 同一页面 **Public Hostname** 添加一条：`子域.你的域名` → 服务类型 HTTP → **URL 填 `http://127.0.0.1:5700`**（cloudflared 与面板同在 runner 上，走宿主回环）。
3. Token 存为仓库 Secret：`Settings → Secrets and variables → Actions → New repository secret`，名 `CF_TUNNEL_TOKEN`。
4. Run workflow 时 `cf_mode` 选 `token`。此模式下脚本无法预知公网域名，访问控制台配置的域名即可。

### 环境变量 / 输入对照

| 输入 | 环境变量 | 说明 | 默认 |
|---|---|---|---|
| `run_minutes` | `RUN_MINUTES` | 保活分钟数，0 = 跑到被取消/超时 | `360` |
| `cf_mode` | `CF_MODE` | `quick` / `token` / `none`（none = 只起面板） | `quick` |
| `ql_image` | `QL_IMAGE` | 青龙镜像 | `whyour/qinglong:latest` |
| `persist_data` | — | 结束把 `data/` 提交回仓库 | `false` |
| — | `CF_TUNNEL_TOKEN` | 命名隧道 Token（Secret，勿写进仓库） | 空 |
| — | `QL_PORT` / `QL_CONTAINER` | 面板端口 / 容器名 | `5700` / `ql-toolbox` |
| — | `QL_DATA_DIR` | 数据目录（挂载 `/ql/data`） | `tools/qinglong/data` |
| — | `QL_TZ` | 容器时区 | `Asia/Shanghai` |
| — | `QL_STARTUP_TIMEOUT` | 等待面板就绪秒数 | `300` |
| — | `CLOUDFLARED_VERSION` | cloudflared 版本 | `latest` |

### 本地运行

```bash
# quick 隧道 + 5 分钟保活（本机需有 docker；cloudflared 会自动下载到 tools/qinglong/bin）
CF_MODE=quick RUN_MINUTES=5 python tools/qinglong/run_panel.py

# 只起面板，方便本地调试
CF_MODE=none RUN_MINUTES=0 python tools/qinglong/run_panel.py
```

### 数据持久化

- **默认（推荐）**：`data/` 在 `.gitignore` 中，结束后上传 Artifact `qinglong-data`（保留 7 天）。下次要用旧数据：下载解压到 `tools/qinglong/data/` 再跑（该目录不进 git，本地/Artifact 两路留存）。
- **可选**：`persist_data=true` 时 workflow 把整个 `data/` `git add -f` 提交回仓库。包含 sqlite 二进制和日志，**仓库体积会持续增长**，只适合配置很小、接受仓库变大的场景。

### 注意事项

- **单实例**：workflow 带 `concurrency: cancel-in-progress: true`，重复触发会取消旧运行（避免 5700 端口和数据目录冲突）。
- **无 push 触发**：见「通用约定」例外；定时触发示例在 workflow 里注释着，默认关闭。
- **临时隧道不稳定**：`trycloudflare.com` 无 SLA，可能被回收或限速；重要用途用 `token` 命名隧道。
- **安全**：面板公网可达，初始化后立刻改强密码；不要把 `CF_TUNNEL_TOKEN` 等 Secret 写进任何提交。
- **镜像拉取**：首次 `docker pull` 可能耗时数分钟，`QL_STARTUP_TIMEOUT`（默认 300s）覆盖的是面板就绪等待，不含拉取时间。
- **青龙初始化**：首次启动要建库、装内置依赖，耐心等日志出现 `面板就绪`；失败时看 `docker logs`（runner 上）或 workflow 日志中的 `$ docker ...` 记录。
