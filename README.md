# gh-toolbox

GitHub Actions 驱动的工具箱：仓库下每个工具 = 一个自包含的 Python 脚本控制一个 CLI 工具，由独立 workflow 调度（手动输入 / 定时 / 文件变更触发），产物按工具需要留存（ytdlp 走 HF datasets 上传，青龙面板走 Artifact）。yt-dlp 是第一个入驻的批处理工具，青龙面板是第一个入驻的服务型工具（长驻进程 + 隧道暴露），后续可继续添加。

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
│   │   ├── .ytdlp-archive.txt     # 下载档案（仅单次运行内有效，不写回仓库）
│   │   └── downloads/             # 输出目录（gitignore；留存靠 HF 上传或本地运行）
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
  `checkout → setup-python → pip install -r tools/<工具>/requirements.txt → 运行脚本`
- 触发方式按工具自行选择（`workflow_dispatch` / `schedule` / `push`）；**ytdlp 当前为纯手动触发**，参数在 Run workflow 时填写。
- 例外：服务型工具（`qinglong`）**不加 `push` 触发**——代码变更就自动拉起一个最长 6 小时的长驻任务没有意义，只手动 / 定时启动。
- **workflow 不向仓库写任何文件**：产物按工具自行分发（HF datasets / Artifact / 其他存储），仓库保持只读（`permissions: contents: read`）；需要跨运行保留的状态放工具目录内或随产物分发，不提交回仓库。

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
3. 运行结束后：runner 是临时的，下载的文件**默认不保留**——需要文件就勾选 `hf_upload` 上传到 HF datasets（见下文「上传到 Hugging Face datasets」），或本地运行。日志会打印每个文件的完整路径、大小与耗时。
4. 勾选 `aria2` 时 workflow 会自动安装 aria2；`transcode` 选 `remux`/`recode` 时依赖 ffmpeg（workflow 会确保可用，缺失自动安装）；勾选 `hf_upload` 时下载完成后上传到 Hugging Face datasets（见下文）。

#### 手动触发参数

| 输入 | 类型 | 说明 | 默认 |
|---|---|---|---|
| `urls` | string | 下载目标，每行一个（视频/播放列表/直链/M3U8）；留空用 `urls.txt` | 空 |
| `format` | string | 格式表达式 | 空（脚本默认 `bv*+ba/b`） |
| `playlist_end` | string | 每个播放列表下载上限，0 不限 | `0` |
| `transcode` | choice | 转码为 MP4（**依赖 ffmpeg**，workflow 自动保证；本地需自备）：`none` 不转(探测到 TS 流则如实命名 .ts) / `remux` 仅换封装、流拷贝(快/无损/体积不变) / `recode` 重编码 H.264+AAC(慢/有损/体积会变，救不兼容编码的源)。都会按真实封装修正后缀 | `none` |
| `aria2` | boolean | 使用 aria2c 多连接加速（自动安装） | `false` |
| `hf_upload` | boolean | 下载完成后上传到 Hugging Face datasets（需 Secret `YTDLP_HF_TOKEN`） | `false` |
| `hf_repo` | string | HF dataset 仓库 ID（如 `smanx/my-videos`）；留空则用 Secret `YTDLP_HF_REPO` | 空 |
| `hf_path` | string | 上传到数据集仓库内的子目录（如 `videos/2024`），留空 = 根路径 | 空 |
| `rename` | string | 输出文件名（不含扩展名，如 `myvideo`；也可传含 `%` 的模板）；留空用默认命名 | 空 |

常用组合：

| 需求 | 参数 |
|---|---|
| 下载 M3U8，输出标准 MP4 | `transcode=remux`（快且无损；源编码古怪再考虑 `recode`；`none` 时 TS 流会如实命名为 `.ts`） |
| 来源是 mkv/webm/ts 等，想无损换成 mp4 封装 | `transcode=remux` |
| 来源编码古怪（如 mpeg2/wmv），要标准 H.264 MP4 | `transcode=recode` |
| 大文件多连接加速 | `aria2` 勾选 |
| 上传到 Hugging Face 数据集 | `hf_upload` 勾选 + `hf_repo` 填写 |
| 只要 1080p | `format=best[height<=1080]` |

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `YTDLP_URLS` | 下载目标（换行/逗号分隔），优先于 `urls.txt` | 空 |
| `YTDLP_OUTPUT_DIR` | 输出目录，相对路径基于工具目录解析 | `downloads` |
| `YTDLP_TEMPLATE` | 输出文件名模板 | `%(title)s [%(id)s].%(ext)s` |
| `YTDLP_RENAME` | 输出文件名（不含扩展名）或含 `%` 的模板，优先于 `YTDLP_TEMPLATE` | 空 |
| `YTDLP_FORMAT` | 格式表达式 | `bv*+ba/b` |
| `YTDLP_MERGE_FORMAT` | 合并封装格式 | `mp4` |
| `YTDLP_ARCHIVE` | 下载档案路径 | `tools/ytdlp/.ytdlp-archive.txt` |
| `YTDLP_PLAYLIST_END` | 播放列表下载上限 | `0` |
| `YTDLP_CONCURRENT_FRAG` | 分片并发数 | `4` |
| `YTDLP_RETRIES` | 网络重试次数 | `10` |
| `YTDLP_COOKIES` | Netscape cookies 文件路径 | 空 |
| `YTDLP_VERBOSE` | 置 1 输出 yt-dlp debug 日志 | 空 |
| `YTDLP_TRANSCODE` | 转码为 MP4（**依赖 ffmpeg**，未安装则脚本报错退出码 2）：`none` 不转(探测到 TS 流则如实命名 .ts) / `remux` 流拷贝换封装(快/无损) / `recode` 重编码 H.264+AAC(慢/有损)；都会按真实封装修正后缀 | `none` |
| `YTDLP_ARIA2` | 启用 aria2c 加速（`1`/`true`/`yes`/`on`） | 关 |
| `YTDLP_ARIA2_ARGS` | aria2c 附加参数（空格分隔） | `-x 16 -s 16 -k 1M` |
| `YTDLP_HF_UPLOAD` | 启用上传到 Hugging Face datasets（`1`/`true`/`yes`/`on`） | 关 |
| `YTDLP_HF_REPO` | HF dataset 仓库 ID（`用户名/数据集名`） | 空 |
| `YTDLP_HF_PRIVATE` | 创建仓库时是否私有 | `1`（私有） |
| `YTDLP_HF_PATH` | 上传到数据集仓库内的子目录，留空 = 根路径 | 空 |
| `YTDLP_HF_TOKEN` | Hugging Face 令牌（带工具前缀，避免多工具 token 混用） | 空 |

### 本地运行

```bash
pip install -r tools/ytdlp/requirements.txt

# 用 urls.txt（脚本自定位，任意目录运行均可）
python tools/ytdlp/download.py

# 命令行直接传 URL（会追加到下载列表）
python tools/ytdlp/download.py "https://www.youtube.com/watch?v=BaW_jenozKc"

# 覆盖参数
YTDLP_FORMAT="best[height<=1080]" python tools/ytdlp/download.py

# HLS(m3u8) 转成 MP4（需 PATH 中有 ffmpeg）
# remux=流拷贝换封装（快、无损）；recode=重编码 H.264/AAC（慢、有损，救不兼容的源）
YTDLP_TRANSCODE=remux python tools/ytdlp/download.py "https://example.com/video/index.m3u8"

# aria2 多连接加速（需本机 PATH 中已有 aria2c）
YTDLP_ARIA2=1 python tools/ytdlp/download.py "https://example.com/big.mp4"

# 自定义输出文件名（不含扩展名）
YTDLP_RENAME=myvideo python tools/ytdlp/download.py "https://example.com/video"

# 下载并上传到 Hugging Face datasets 的指定子目录（需 YTDLP_HF_TOKEN 或本机 hf auth login）
YTDLP_HF_UPLOAD=1 YTDLP_HF_REPO=smanx/my-videos YTDLP_HF_PATH=videos/2024 python tools/ytdlp/download.py
```

### cookies（可选）

需要登录/年龄验证的站点：

```bash
base64 -w0 cookies.txt   # 生成单行 base64
```

把输出添加到仓库 Secrets：`Settings → Secrets and variables → Actions → New repository secret`，名 `YTDLP_COOKIES`。workflow 会自动解码为 `cookies.txt` 并传给脚本（`cookies.txt` 已在 `.gitignore` 中，不会提交）。

### 下载档案

`download.py` 每下载完成一个视频就把 `extractor 视频ID` 写入 `.ytdlp-archive.txt`，**单次运行内**重复的 URL、重叠的播放列表条目不会重复下载。注意 workflow 不把该文件写回仓库（仓库只读），runner 也是临时的——每次手动运行都从空档案开始；想要跨运行防重复，就本地运行并保留该文件，或自行把它提交进仓库（脚本读取到即生效）。删除某行即可强制重新下载。

### 重命名输出文件（可选）

默认命名为 `%(title)s [%(id)s].%(ext)s`。想自定义时：

- **简单用法**：传一个不含扩展名的文件名，脚本自动补上实际扩展名。
  `rename=myvideo` → `myvideo.mp4`（自带扩展名如 `myvideo.mp4` 也会被正确剥掉再补，不会出现 `.mp4.mp4`）。
- **模板用法**：传含 `%` 的 yt-dlp 模板（缺 `%(ext)s` 会自动补）。
  `rename=%(playlist_index)s-%(title)s`、`rename=%(uploader)s/%(title)s`（`/` 可建子目录）。
- **播放列表注意**：多文件场景下模板必须含唯一占位符（`%(playlist_index)s`、`%(title)s`、`%(id)s` 等），否则脚本会告警且文件可能互相覆盖。

### 上传到 Hugging Face datasets（可选）

全部下载完成后，可把 `downloads/` 整个上传到 HF dataset 仓库（默认关闭）。

**配置**：

1. 到 [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) 创建 Token（权限选 `write`）。
2. 存为仓库 Secret：`YTDLP_HF_TOKEN`（必填，带工具前缀避免与其他工具的 token 混用）；`YTDLP_HF_REPO`（可选，作为默认仓库 ID）。
3. Run workflow 时勾选 `hf_upload`，填写 `hf_repo`（留空则用 Secret `YTDLP_HF_REPO`）和 `hf_path`（留空上传到仓库根路径）。

**行为**：

- 上传 `tools/ytdlp/downloads/` 全目录到 dataset 仓库；仓库不存在则自动创建（**默认私有**，`YTDLP_HF_PRIVATE=0` 可改公开；已存在的仓库不会改动其可见性）。
- `hf_path` 指定仓库内的目标子目录（如 `videos/2024` → 文件落在该目录下），留空 = 根路径。
- 内容未变化的文件不会重复传输（hub 按 hash 去重）。
- 上传失败会记录错误并以退出码 1 结束（runner 上的文件不受影响）。

### 注意事项

- **完成日志**：每个文件下载完成即输出完整路径、大小与耗时——单文件一行含三项；播放列表等批量下载在整批结束后逐文件输出路径+大小，并给出本批合计耗时；任务结束汇总文件数与下载总耗时。
- **yt-dlp 时效性**：workflow 每次 `pip install -U` 装最新版；仍可能遇到站点改版导致个别 URL 失败——脚本会跳过失败项继续下载其他 URL，最终以退出码 1 标记失败。
- **大播放列表/频道**：首次会解析两遍（先查档案再下载），`YTDLP_PLAYLIST_END` 可限制规模。
- **时区**：cron 使用 UTC，默认 `0 18 * * *` = 北京时间 02:00。
- **超时**：job `timeout-minutes: 360` 为 GitHub 托管 runner 上限，特大任务需拆分。
- **转码模式**（`YTDLP_TRANSCODE`）：三者语义不同——`remux` = 换 mp4 封装且**流直接拷贝**（秒级、无损、码率与体积基本不变；源编码不兼容 mp4 时 ffmpeg 报错）；`recode` = **重编码**为 H.264/AAC（慢、有损、体积与耗时都会明显变化，用于源编码不兼容 MP4 的场景）；`none` = 不转码。**转换依赖 ffmpeg**：yt-dlp 的 remux/recode 本身就是调用 ffmpeg（等价 CLI 的 `--remux-video` / `--recode-video`），workflow 会在运行前确保 ffmpeg 可用；**本地运行必须自备 ffmpeg**，缺失时脚本直接报错并以退出码 2 结束（不会下半天最后给你一个 TS）。**注意一个 yt-dlp 的坑**：HLS/m3u8 的格式 ext 通常是 `mp4`，原生 remux/recode 后处理器会按扩展名判断「已是 mp4」而跳过，实际转换落在 FixupM3u8 上——它只做流拷贝，导致 recode 名不副实（两种模式输出一模一样）。因此 recode 模式下脚本会关掉 yt-dlp 的 fixup，让 TS 内容保留到下载后的探测层**真正重编码**。**三种模式下脚本都会用 ffprobe 探测每个产物文件的真实封装格式**（ffprobe 缺失时退化为 TS 包头嗅探）：内容是 TS 流但扩展名是 `.mp4` 的——`none` 如实改名为 `.ts`，`remux` 流拷贝转换，`recode` 重编码转换（转换失败回退保留 `.ts`）；内容是 MP4 却叫 `.ts` 的改回 `.mp4`；名实相符的文件一律不动。注意：recode 重编码耗时较长，大视频留意 6 小时 job 上限。
- **aria2**：勾选后 workflow 自动安装；本地运行需 PATH 中已有 `aria2c`，否则脚本告警并回退内置下载器。aria2 主要加速直链/分片下载，HLS(m3u8) 仍走 yt-dlp 内置或 ffmpeg 下载器。
- **产物留存**：ytdlp **不上传 GitHub Artifact**（制品存储按套餐限额：Free 500 MB / Pro 1 GB / Team 2 GB / Enterprise 50 GB，与 Packages 共享且不支持提升）——runner 是临时的，需要文件就启用 `hf_upload` 传到 HF datasets，或本地运行；青龙面板仍用 Artifact 留存数据。

## qinglong 工具说明

在 GitHub Actions runner 上用 Docker 起一个[青龙面板](https://github.com/whyour/qinglong)，把控制端口（默认 5700）通过 Cloudflare Tunnel 映射成公网地址。runner 是临时的，**job 结束（保活到期 / 手动取消 / 360 分钟上限）后面板即销毁**，数据以 Artifact 形式留存。

### 快速开始

1. 打开仓库 **Actions → 青龙面板 + CF Tunnel → Run workflow**：
   - `cf_mode`：`quick`（默认，免密临时隧道）或 `token`（命名隧道，需先配 Secret）
   - `run_minutes`：保活时长，默认 360（= runner 上限，约 6 小时）
   - `ql_image`：镜像，默认 `whyour/qinglong:latest`；依赖兼容问题换 `whyour/qinglong:debian`
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

- **默认（唯一方式）**：`data/` 在 `.gitignore` 中，结束后上传 Artifact `qinglong-data`（保留 7 天）。下次要用旧数据：下载解压到 `tools/qinglong/data/` 再跑（该目录不进 git，本地/Artifact 两路留存）。workflow 不往仓库提交任何文件。

### 注意事项

- **单实例**：workflow 带 `concurrency: cancel-in-progress: true`，重复触发会取消旧运行（避免 5700 端口和数据目录冲突）。
- **无 push 触发**：见「通用约定」例外；定时触发示例在 workflow 里注释着，默认关闭。
- **临时隧道不稳定**：`trycloudflare.com` 无 SLA，可能被回收或限速；重要用途用 `token` 命名隧道。
- **安全**：面板公网可达，初始化后立刻改强密码；不要把 `CF_TUNNEL_TOKEN` 等 Secret 写进任何提交。
- **镜像拉取**：首次 `docker pull` 可能耗时数分钟，`QL_STARTUP_TIMEOUT`（默认 300s）覆盖的是面板就绪等待，不含拉取时间。
- **青龙初始化**：首次启动要建库、装内置依赖，耐心等日志出现 `面板就绪`；失败时看 `docker logs`（runner 上）或 workflow 日志中的 `$ docker ...` 记录。
