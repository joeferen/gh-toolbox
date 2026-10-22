# gh-toolbox

GitHub Actions 驱动的工具箱：仓库下每个工具 = 一个自包含的 Python 脚本控制一个 CLI 工具，由独立 workflow 调度（手动输入 / 定时 / 文件变更触发），产物按工具需要留存（ytdlp / m3u8 走 HF datasets 上传，青龙面板走 Artifact）。yt-dlp 是第一个入驻的批处理工具，青龙面板是第一个入驻的服务型工具（长驻进程 + 隧道暴露），N_m3u8DL-RE 是第二个批处理工具（专攻 HLS/DASH 流下载），后续可继续添加。

## 工具列表

| 工具 | 说明 | Workflow | 入口脚本 |
|---|---|---|---|
| `ytdlp` | yt-dlp 批量下载视频/播放列表 | `.github/workflows/ytdlp.yml` | `tools/ytdlp/download.py` |
| `m3u8` | N_m3u8DL-RE 下载 HLS(m3u8)/DASH(mpd) 流 | `.github/workflows/m3u8.yml` | `tools/m3u8/download.py` |
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
│   │   ├── html/                  # 页面快照（另存的网页 HTML，油猴脚本打开弹框时自动解析提取视频直链+标题）
│   │   ├── ytdlp-dispatch.user.js # 油猴脚本（可选）：仓库/jable.tv/pornhub 页面悬浮按钮一键触发 workflow
│   │   ├── .ytdlp-archive.txt     # 下载档案（仅记录存档，不作跳过判据，不写回仓库）
│   │   └── downloads/             # 输出目录（gitignore；留存靠 HF 上传或本地运行）
│   ├── m3u8/
│   │   ├── download.py            # 主脚本（入口）：定位/自动下载 N_m3u8DL-RE 并调度下载
│   │   ├── requirements.txt       # 该工具专属依赖（N_m3u8DL-RE 本体不走 pip，脚本按 release 自动下载）
│   │   ├── urls.txt               # 输入清单（M3U8/MPD 直链）
│   │   ├── m3u8-dispatch.user.js  # 油猴脚本（可选）：仓库/jable.tv/pornhub 页面悬浮按钮一键触发 workflow
│   │   ├── html/                  # 页面快照（另存的网页 HTML，油猴脚本打开弹框时自动解析提取视频直链+标题）
│   │   ├── bin/                   # N_m3u8DL-RE 二进制缓存（gitignore，按需自动下载）
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
- 触发方式按工具自行选择（`workflow_dispatch` / `schedule` / `push`）；**ytdlp / m3u8 当前为纯手动触发**，参数在 Run workflow 时填写。
- 例外：服务型工具（`qinglong`）**不加 `push` 触发**——代码变更就自动拉起一个最长 6 小时的长驻任务没有意义，只手动 / 定时启动。
- **workflow 不向仓库写任何文件**：产物按工具自行分发（HF datasets / Artifact / 其他存储），仓库保持只读（`permissions: contents: read`）；需要跨运行保留的状态放工具目录内或随产物分发，不提交回仓库。

## 新增一个工具

1. `cp -r tools/ytdlp tools/<新工具名>`
2. 修改 `tools/<新工具名>/` 下的脚本逻辑、输入清单、依赖
3. `cp .github/workflows/ytdlp.yml .github/workflows/<新工具名>.yml`，把其中的 `tools/ytdlp` 路径替换为新工具名，按需调整 inputs / cron / artifact
4. 在本 README「工具列表」加一行
5. 提交推送，Actions 页面即可看到新 workflow

## m3u8 工具说明

控制 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)（跨平台 DASH/HLS/MSS 下载器）批量下载 HLS(m3u8) / DASH(mpd) 流。功能对齐 ytdlp 工具：URL 清单 → 下载 → 混流封装 → 可选上传 HF datasets，且同样提供油猴脚本一键触发。与 ytdlp 的分工：yt-dlp 胜在站点解析广（ YouTube/B 站等千余站点），N_m3u8DL-RE 胜在流处理专业（多轨道选择、AES-128/SAMPLE-AES 解密、直播录制、DASH Period 处理）。

### 快速开始（仅手动触发）

1. 编辑 `tools/m3u8/urls.txt`，填入 M3U8/MPD 直链（每行一个，`#` 注释）。
2. 打开仓库 **Actions → N_m3u8DL-RE 下载器 → Run workflow**，按需填写参数（见下表），点 **Run workflow**。
3. 运行结束后：runner 是临时的，下载的文件**默认不保留**——需要文件就勾选 `hf_upload` 上传到 HF datasets，或本地运行。日志里能看到完整下载过程（解析/选流/实时进度/合并/混流/跳过），每个任务完成后输出文件路径、大小与耗时。
4. workflow 会自动确保 ffmpeg 可用（分片合并与混流的硬依赖）；N_m3u8DL-RE 本体由脚本按 latest release 自动下载（`bin/` 已 gitignore，本地同样自动下载，也可用 `M3U8_BIN` 指定已有二进制）。

#### 手动触发参数

| 输入 | 类型 | 说明 | 默认 |
|---|---|---|---|
| `urls` | string | 下载目标，每行一个（M3U8/MPD 直链）；留空用 `urls.txt` | 空 |
| `select_video` | string | 视频流选择表达式（如 `best`、`res="1920*":codecs=hvc1:for=best`、`bwMin=800:bwMax=3000:for=best`）；填写后走 `--select-video` | 空 |
| `auto_select` | boolean | 自动选择所有类型的最佳轨道（`--auto-select`）。**注意**：两者都不给时 N_m3u8DL-RE 会进入交互选流，CI 上无 TTY 直接失败——所以默认勾选 | `true` |
| `save_name` | string | 输出文件名（不含扩展名，如 `myvideo`）；留空按 URL 自动派生（取路径尾段 + 查询串指纹）；多个 URL 时自动加序号（`myvideo-2.mp4`）避免覆盖 | 空 |
| `overwrite` | boolean | 是否覆盖目标文件：勾选=**强制重新下载**并删除已存在的同名文件；不勾选=目标文件已存在则**跳过、不下载** | `false` |
| `mux_format` | choice | 下载完成后混流封装（**依赖 ffmpeg**，workflow 自动保证）：`mp4`（默认）/ `mkv` / `ts` / `none` 不混流（输出轨道原文件） | `mp4` |
| `thread_count` | string | 下载线程数（分片并发） | `16` |
| `headers` | string | 自定义请求头，单行 JSON（如 `{"Referer":"https://example.com/"}`）；本地运行也支持每行 `Name: Value`。值不会打进日志 | 空 |
| `hf_upload` | boolean | 下载完成后上传到 Hugging Face datasets（需 Secret `M3U8_HF_TOKEN`） | `false` |
| `hf_repo` | string | HF dataset 仓库 ID（如 `myuser/my-videos`）；留空则用 Secret `M3U8_HF_REPO` | 空 |
| `hf_path` | string | 上传到数据集仓库内的子目录（如 `videos/2024`），留空 = 根路径 | 空 |
| `extra_args` | string | N_m3u8DL-RE 附加命令行参数，空格分隔原样透传（如 `--key KID:KEY` 解密、`--live-record-limit 00:30:00` 直播限时录制、`--custom-range 05:00-20:00` 只下部分分片、`-ss all` 连字幕一起下） | 空 |

常用组合：

| 需求 | 参数 |
|---|---|
| 只要 1080p | `select_video=res="1920*":for=best` |
| 上传到 Hugging Face 数据集 | `hf_upload` 勾选 + `hf_repo` 填写 |
| 站点要 Referer/UA 才放行 | `headers={"Referer":"https://example.com/"}` |
| 强制重新下载 | `overwrite` 勾选 |
| 已下载过，只下新的 | 不勾选 `overwrite`（默认，自动跳过） |
| 输出 MKV（多音轨/字幕兼容性好） | `mux_format=mkv` |
| AES-128 加密流 | 无需配置（自动识别密钥）；自带 KEY 时 `extra_args=--key KID:KEY` |
| 直播流限时录制 30 分钟 | `extra_args=--live-record-limit 00:30:00` |
| 只下第 5~20 分钟 | `extra_args=--custom-range 05:00-20:00` |
| 字幕也要 | `extra_args=-ss all` |

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `M3U8_URLS` | 下载目标（换行/逗号分隔），优先于 `urls.txt` | 空 |
| `M3U8_BIN` | N_m3u8DL-RE 可执行文件路径；不设则 PATH > bin/ 缓存 > 自动下载 | 空 |
| `M3U8_RE_VERSION` | 要使用的 release 版本 tag（如 `v0.7.0`） | `latest` |
| `M3U8_OUTPUT_DIR` | 输出目录，相对路径基于工具目录解析 | `downloads` |
| `M3U8_TMP_DIR` | 临时分片目录 | `downloads/.tmp` |
| `M3U8_SELECT_VIDEO` | 视频流选择表达式 | 空 |
| `M3U8_AUTO_SELECT` | 自动选所有最佳轨道（`1`/`true`/`yes`/`on`） | `1` |
| `M3U8_SAVE_NAME` | 输出文件名（不含扩展名）；多 URL 自动加序号 | 空 |
| `M3U8_OVERWRITE` | 覆盖目标文件（`1`/`true`/`yes`/`on`）：强制重新下载；不置=目标文件已存在则跳过 | 关 |
| `M3U8_MUX_FORMAT` | 混流封装格式（**依赖 ffmpeg**，缺失脚本报错退出码 2）：`mp4`/`mkv`/`ts`/`none` | `mp4` |
| `M3U8_THREAD_COUNT` | 下载线程数 | `16` |
| `M3U8_RETRIES` | 每分片重试次数 | `7` |
| `M3U8_COOKIES` | Netscape cookies 文件路径 | 空 |
| `M3U8_HEADERS` | 自定义请求头：JSON 对象（推荐）或每行 `Name: Value`；格式错误退出码 2 | 空 |
| `M3U8_EXTRA_ARGS` | N_m3u8DL-RE 附加命令行参数（空格分隔，原样透传） | 空 |
| `M3U8_VERBOSE` | 置 1 输出 N_m3u8DL-RE DEBUG 日志 | 空 |
| `M3U8_HF_UPLOAD` | 启用上传到 Hugging Face datasets（`1`/`true`/`yes`/`on`） | 关 |
| `M3U8_HF_REPO` | HF dataset 仓库 ID（`用户名/数据集名`） | 空 |
| `M3U8_HF_PRIVATE` | 创建仓库时是否私有 | `1`（私有） |
| `M3U8_HF_PATH` | 上传到数据集仓库内的子目录，留空 = 根路径 | 空 |
| `M3U8_HF_TOKEN` | Hugging Face 令牌（带工具前缀 `M3U8_`，避免多工具 token 混用） | 空 |

### 本地运行

```bash
pip install -r tools/m3u8/requirements.txt   # 仅 huggingface_hub；二进制自动下载

# 用 urls.txt（脚本自定位，任意目录运行均可；N_m3u8DL-RE 首次运行自动下载到 tools/m3u8/bin/）
python tools/m3u8/download.py

# 命令行直接传 URL
python tools/m3u8/download.py "https://example.com/video/index.m3u8"

# 指定输出文件名
M3U8_SAVE_NAME=myvideo python tools/m3u8/download.py "https://example.com/video/index.m3u8"

# 只要 1080p，输出 MKV
M3U8_SELECT_VIDEO='res="1920*":for=best' M3U8_MUX_FORMAT=mkv python tools/m3u8/download.py

# 不混流（保留轨道原文件，无需 ffmpeg）
M3U8_MUX_FORMAT=none python tools/m3u8/download.py

# 自定义请求头（JSON；也支持每行 Name: Value，值不会打进日志）
M3U8_HEADERS='{"Referer":"https://example.com/","User-Agent":"Mozilla/5.0"}' \
  python tools/m3u8/download.py "https://example.com/video/index.m3u8"

# 附加参数透传：直播限时录制 30 分钟
M3U8_EXTRA_ARGS="--live-record-limit 00:30:00" python tools/m3u8/download.py "https://example.com/live.m3u8"

# 下载并上传到 Hugging Face datasets 的指定子目录（需 M3U8_HF_TOKEN 或本机 hf auth login）
M3U8_HF_UPLOAD=1 M3U8_HF_REPO=myuser/my-videos M3U8_HF_PATH=videos/2024 python tools/m3u8/download.py
```

### cookies（可选）

需要登录态的站点：把 Netscape 格式 cookies.txt base64 后存为仓库 Secret `M3U8_COOKIES`，workflow 会自动解码并传给 N_m3u8DL-RE（`--cookies`）。生成方式同 ytdlp 工具：

```bash
base64 -w0 cookies.txt
```

### 覆盖与跳过（overwrite）

| 勾选状态 | 行为 |
|---|---|
| 不勾选（默认） | 下载前检查目标文件（`save_name`/URL 派生名 + mp4/mkv/ts 等常见后缀）：已存在 → 跳过不下载；不存在 → 下载 |
| 勾选 | 强制重新下载：先删除已存在的同名产物（各扩展名都清），下载完成直接覆盖 |

### 油猴脚本一键触发（可选）

`tools/m3u8/m3u8-dispatch.user.js` 是 ytdlp 油猴脚本的姊妹版，功能完全一致：在仓库页面或 jable.tv / pornhub 视频页右下角显示悬浮按钮（紫色 **⬇ m3u8**，与 ytdlp 的绿色按钮并存且位置各自记忆），点击弹框填参数一键触发本 workflow，并轮询展示运行状态。差异仅在：

- 默认触发目标为 `m3u8.yml`（N_m3u8DL-RE 下载器）；触发目标 owner/repo/workflow 同样全部手填、不写死。
- 弹框表单与 m3u8.yml 的 inputs 一一对应（urls / select_video / auto_select / save_name / overwrite / mux_format / thread_count / headers / hf_upload / hf_repo / hf_path / extra_args）。
- 页面快照目录为 `tools/m3u8/html/`（把视频页另存为 HTML 推送到该目录，仓库页打开弹框即可一键触发）。
- 视频标题自动填入 `rename` 栏（仅作备注展示，实际文件名由 `save_name`/URL 派生决定）。
- 存储前缀 `m3u8_trigger_`，与 ytdlp 脚本的配置互不干扰；两脚本可同时安装。

安装方式与 Token 权限要求见「ytdlp 工具说明 → 油猴脚本一键触发」，两者一致。

### 注意事项

- **ffmpeg 硬依赖**：N_m3u8DL-RE 的分片合并（默认 LOCAL_HTTP 方式）与 `-M` 混流都依赖 ffmpeg；`M3U8_MUX_FORMAT=none` 时混流步骤跳过，但 TS/fMP4 分片的合并仍需要。workflow 自动保证；本地运行必须自备。
- **非交互选流**：CI 无 TTY，交互选流菜单会直接失败。脚本始终以 `--auto-select` 或 `--select-video` 运行（表达式优先）；确实需要精细选流时用 `select_video` 表达式（语法见 N_m3u8DL-RE 的 `--morehelp select-video`）。
- **DRM**：N_m3u8DL-RE 只处理标准加密（AES-128 / SAMPLE-AES / CENC，KEY 已知时可用 `--key`）；Widevine 级 DRM 不支持。
- **命名与指纹**：`save_name` 留空时从 URL 派生（路径尾段 + 查询串 md5 指纹前 6 位），同一页面不同清晰度/签名的 URL 不会互相覆盖；手动 `save_name` 多 URL 时自动加 `-2/-3` 序号。
- **后缀探测**：与 ytdlp 工具一样，下载完成后脚本会用 ffprobe 探测真实封装，TS 冒充 .mp4（或反之）时如实改名（仅改名不转码；要 MP4 封装请用 `mux_format=mp4`）。
- **产物留存**：与 ytdlp 相同，不上传 GitHub Artifact（限额原因）；需要文件就启用 `hf_upload` 传到 HF datasets，或本地运行。
- **超时**：job `timeout-minutes: 360` 为 GitHub 托管 runner 上限，特大任务需拆分。
- **时效性**：N_m3u8DL-RE 默认取 latest release；指定版本用 `M3U8_RE_VERSION`。m3u8 直链有时效性（签名过期），过期后重新提取一次即可。

## ytdlp 工具说明

控制 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 批量下载视频/播放列表。

### 快速开始（仅手动触发）

1. 编辑 `tools/ytdlp/urls.txt`，填入视频/播放列表/直链/M3U8 URL（每行一个，`#` 注释）。
2. 打开仓库 **Actions → yt-dlp 下载器 → Run workflow**，按需填写参数（见下表），点 **Run workflow**。
3. 运行结束后：runner 是临时的，下载的文件**默认不保留**——需要文件就勾选 `hf_upload` 上传到 HF datasets（见下文「上传到 Hugging Face datasets」），或本地运行。日志里能看到完整下载过程（解析/目标文件/实时进度/合并/跳过），每个文件完成后输出完整路径、大小与耗时。
4. 勾选 `aria2` 时 workflow 会自动安装 aria2；`transcode` 选 `remux`/`recode` 时依赖 ffmpeg（workflow 会确保可用，缺失自动安装）；勾选 `hf_upload` 时下载完成后上传到 Hugging Face datasets（见下文）。

#### 手动触发参数

| 输入 | 类型 | 说明 | 默认 |
|---|---|---|---|
| `urls` | string | 下载目标，每行一个（视频/播放列表/直链/M3U8）；留空用 `urls.txt` | 空 |
| `format` | string | 格式表达式 | 空（脚本默认 `bv*+ba/b`） |
| `playlist_end` | string | 每个播放列表下载上限，0 不限 | `0` |
| `overwrite` | boolean | 是否覆盖目标文件：勾选=**强制重新下载**并覆盖已存在的文件；不勾选=先检查目标文件，**已存在则跳过、不下载** | `false` |
| `transcode` | choice | 转码为 MP4（**依赖 ffmpeg**，workflow 自动保证；本地需自备）：`none` 不转(探测到 TS 流则如实命名 .ts) / `remux` 仅换封装、流拷贝(快/无损/体积不变) / `recode` 重编码 H.264+AAC(慢/有损/体积会变，救不兼容编码的源)。都会按真实封装修正后缀 | `none` |
| `aria2` | boolean | 使用 aria2c 多连接加速（自动安装） | `false` |
| `hf_upload` | boolean | 下载完成后上传到 Hugging Face datasets（需 Secret `YTDLP_HF_TOKEN`） | `false` |
| `hf_repo` | string | HF dataset 仓库 ID（如 `myuser/my-videos`）；留空则用 Secret `YTDLP_HF_REPO` | 空 |
| `hf_path` | string | 上传到数据集仓库内的子目录（如 `videos/2024`），留空 = 根路径 | 空 |
| `rename` | string | 输出文件名（不含扩展名，如 `myvideo`；也可传含 `%` 的模板）；留空用默认命名 | 空 |
| `headers` | string | 自定义请求头，单行 JSON（如 `{"Referer":"https://example.com/"}`）；本地运行也支持每行 `Name: Value`。带 `Cookie` 会自动加载为 cookies；值不会打进日志 | 空 |
| `impersonate` | string | TLS 指纹伪装，过 Cloudflare 反爬挑战（依赖 curl_cffi，随依赖自动安装）：留空/`0`=关闭；`1` 或 `chrome`=伪装 Chrome；也可填 `safari`、`chrome-131` 等 | 空 |

常用组合：

| 需求 | 参数 |
|---|---|
| 下载 M3U8，输出标准 MP4 | `transcode=remux`（快且无损；源编码古怪再考虑 `recode`；`none` 时 TS 流会如实命名为 `.ts`） |
| 来源是 mkv/webm/ts 等，想无损换成 mp4 封装 | `transcode=remux` |
| 来源编码古怪（如 mpeg2/wmv），要标准 H.264 MP4 | `transcode=recode` |
| 大文件多连接加速 | `aria2` 勾选 |
| 上传到 Hugging Face 数据集 | `hf_upload` 勾选 + `hf_repo` 填写 |
| 只要 1080p | `format=best[height<=1080]` |
| 站点要 Referer/UA 才放行 | `headers={"Referer":"https://example.com/"}` |
| 被 Cloudflare 拦（403 anti-bot challenge） | `impersonate=1`（TLS 指纹伪装 Chrome） |
| 文件已在目标处，不想重下 | 不勾选 `overwrite`（默认，自动跳过） |
| 强制重新下载、覆盖旧文件 | `overwrite` 勾选 |
| 补下播放列表里缺的几集 | 不勾选 `overwrite`，已存在的条目自动跳过，只下缺失的 |

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
| `YTDLP_OVERWRITE` | 覆盖目标文件（`1`/`true`/`yes`/`on`）：强制重新下载并覆盖已存在文件；不置=目标文件已存在则跳过 | 关 |
| `YTDLP_CONCURRENT_FRAG` | 分片并发数 | `4` |
| `YTDLP_RETRIES` | 网络重试次数 | `10` |
| `YTDLP_COOKIES` | Netscape cookies 文件路径 | 空 |
| `YTDLP_HEADERS` | 自定义请求头（合并覆盖 yt-dlp 默认头）：JSON 对象 `{"Referer":"https://..."}` 或每行 `Name: Value`；带 `Cookie` 会自动加载为 cookies；格式错误退出码 2 | 空 |
| `YTDLP_IMPERSONATE` | 浏览器 TLS 指纹伪装（过 Cloudflare 反爬，依赖 curl_cffi，未安装报错退出码 2）：`1`/`true`=伪装 Chrome；也可显式指定 `safari`、`chrome-131`、`chrome:windows-10`；空/`0`=关闭 | 空 |
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

# 强制重新下载并覆盖已存在的目标文件（等价 Actions 勾选 overwrite）
YTDLP_OVERWRITE=1 python tools/ytdlp/download.py "https://example.com/video"

# 只补下缺失的文件：目标文件已存在则跳过（默认行为）
YTDLP_OVERWRITE=0 python tools/ytdlp/download.py "https://example.com/playlist"

# HLS(m3u8) 转成 MP4（需 PATH 中有 ffmpeg）
# remux=流拷贝换封装（快、无损）；recode=重编码 H.264/AAC（慢、有损，救不兼容的源）
YTDLP_TRANSCODE=remux python tools/ytdlp/download.py "https://example.com/video/index.m3u8"

# aria2 多连接加速（需本机 PATH 中已有 aria2c）
YTDLP_ARIA2=1 python tools/ytdlp/download.py "https://example.com/big.mp4"

# 自定义输出文件名（不含扩展名）
YTDLP_RENAME=myvideo python tools/ytdlp/download.py "https://example.com/video"

# 自定义请求头（JSON；也支持每行 Name: Value，值不会打进日志）
YTDLP_HEADERS='{"Referer":"https://example.com/","User-Agent":"Mozilla/5.0"}' \
  python tools/ytdlp/download.py "https://example.com/video"

# 过 Cloudflare 反爬：TLS 指纹伪装成 Chrome（依赖 curl_cffi，见 requirements.txt）
YTDLP_IMPERSONATE=1 python tools/ytdlp/download.py "https://surrit.com/xxx/playlist.m3u8"

# 下载并上传到 Hugging Face datasets 的指定子目录（需 YTDLP_HF_TOKEN 或本机 hf auth login）
YTDLP_HF_UPLOAD=1 YTDLP_HF_REPO=myuser/my-videos YTDLP_HF_PATH=videos/2024 python tools/ytdlp/download.py
```

### cookies（可选）

需要登录/年龄验证的站点：

```bash
base64 -w0 cookies.txt   # 生成单行 base64
```

把输出添加到仓库 Secrets：`Settings → Secrets and variables → Actions → New repository secret`，名 `YTDLP_COOKIES`。workflow 会自动解码为 `cookies.txt` 并传给脚本（`cookies.txt` 已在 `.gitignore` 中，不会提交）。

### 下载档案

`download.py` 每下载完成一个视频就把 `extractor 视频ID` 写入 `.ytdlp-archive.txt`，**仅作记录存档，不再作为跳过判据**——是否跳过只看目标文件是否存在（见下方「覆盖与跳过」）。workflow 不把该文件写回仓库（仓库只读），runner 也是临时的——每次手动运行都从空档案开始。删除已下载的文件，下次不勾选 `overwrite` 运行就会重新下载它。

### 覆盖与跳过（overwrite）

| 勾选状态 | 行为 |
|---|---|
| 不勾选（默认） | 下载前逐个检查目标文件：已存在 → 跳过不下载（HLS 的 `.ts`/`.mp4` 后缀偏差也能识别）；不存在 → 下载 |
| 勾选 | 百分百触发下载：绕过一切检查，yt-dlp 先删除已存在的目标文件再重新下载，**直接覆盖** |

播放列表按条目粒度判断：全部条目的目标文件都已存在 → 整个跳过；部分缺失 → 只下载缺失条目（已存在的条目由 yt-dlp 自动跳过，不会重复下载）。

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

### 油猴脚本一键触发（可选）

嫌每次去 Actions 页面点 Run workflow 麻烦，可安装油猴脚本 `tools/ytdlp/ytdlp-dispatch.user.js`：在仓库页面或 jable.tv / pornhub 视频页右下角显示悬浮按钮，点击弹框填参数，一键触发本 workflow，并轮询展示运行状态。

**触发目标三者全部手填、不写死**：弹框内「**owner · 用户名」「repo · 仓库名」「workflow · 触发哪个 Action**」都由用户手动输入（均可直接粘贴 `https://github.com/<用户名>/<仓库名>` 或 `.github/workflows/xxx.yml` 完整路径，会自动拆解归一化；留空才兜底用脚本里的 CONFIG 默认值）。dispatch 触发、Token 验证、页面快照拉取、运行状态轮询、最近运行列表、弹框标题和「Actions 页面」链接全部跟随这三个填写值；手填值本地记忆，下次自动带出。也就是说这个脚本可以触发**任意仓库**的 workflow，不只是本仓库。

**自动带上视频链接与标题**（打开弹框即自动填入，无需手动复制粘贴）：

- **jable.tv 视频页**（`@match https://jable.tv/videos/*`）：从当前实时页面提取视频直链（播放器内联脚本里的 `hlsUrl`，即 m3u8）与标题（`og:title`）。
- **pornhub 视频页**（`@match https://*.pornhub.com/view_video.php*`）：从当前实时页面提取 flashvars `mediaDefinitions` 里的 `"videoUrl"`（JSON 转义会自动反转义、HTML 实体自动解码）——**多清晰度取最高**（如 `720P_4000K_xxx.mp4/master.m3u8`）；`/video/get_media?s=...` 下载端点以 `# 下载端点:` 注释行带回（参考用，不进下载列表）。
- **GitHub 仓库页**：从仓库快照目录 `tools/ytdlp/html/`（兼容旧路径 `tools/ytdlp/http/`）下的 `*.html` 快照提取——把视频页「另存为」HTML 放进该目录并提交推送，之后在仓库页面打开弹框即可一键触发。目录列举 + 每个文件的最近提交时间走 `api.github.com`（公开仓库无 Token 也可用，限流 60/h），拉取文件走 raw.githubusercontent.com（公开免鉴权），失败回退 contents API；刚推送的文件 raw CDN 约 5 分钟生效。
- **多个快照时默认自动选中最近提交的那个**（= 最新保存的页面），弹框内的「页面快照」下拉可手动切换，切换后立即重新提取。
- 提取结果写入两个参数：`urls` ← **只写视频直链本身**（纯 URL，一行一个，不放任何注释行）；`rename` ← 视频标题（做了文件名安全化）。两者**不持久化**，每次打开弹框都会重新提取，可点「**载入页面视频**」手动刷新。

**功能**：

- 悬浮按钮可拖动、位置记忆；仅在 `gh-toolbox` 仓库页面与 jable.tv / pornhub 视频页显示（GitHub Turbo 导航自动感知，离开这几类页面自动隐藏）——按钮出现位置由 `@match` 决定，触发目标则由手填的三栏决定，两者独立。
- 弹框表单与 workflow 的 12 个 inputs 一一对应（每项带中文说明），填写值**按当前 host 隔离保存**（github.com / jable.tv / cn.pornhub.com 各记各的），下次自动带出；「重置参数」一键还原默认值（同时清除自动带入的视频信息）。**例外：urls（下载链接）与 rename（标题）不保存**——每次打开弹框都会重新提取，不会把上一个视频的链接带进下一次；其余（format/overwrite/transcode/hf_repo/headers/Token/owner/repo/workflow/ref 等）全部保存。
- **headers 默认带上 UA + Referer**：headers 栏为空时自动填入 `{"User-Agent":"<Chrome UA>","Referer":"<站点 origin>"}`（视频站打开时用当前站点，仓库页在快照提取成功后补目标站点）；仅当栏为空或仍是自动生成的默认头时才刷新，手填的自定义请求头（如带 Cookie）不会被覆盖。
- 触发分支 `ref` 可改（默认 `main`；在 `/tree/<分支>` 或 `/blob/<分支>` 页面打开会自动带出该分支）；触发目标 workflow 手填（见上）。
- 本地即时校验：`headers` 非法 JSON、`playlist_end` 非整数直接拦在弹框里，不会带到服务端才失败。
- 触发后自动轮询新运行：排队中 → 进行中 → 成功/失败，附链接直跳 Actions 日志；弹框内还可查看 / 刷新最近 5 次运行。
- 适配亮 / 暗色主题；Token 仅存本浏览器 Tampermonkey 存储。

**安装**：

1. 安装 Tampermonkey 扩展 → 新建脚本 → 粘贴 `tools/ytdlp/ytdlp-dispatch.user.js` 全文保存（或把该 `.user.js` 文件直接拖进任意标签页，Tampermonkey 会弹出安装确认页）。
2. 准备 GitHub Token：
   - 经典 PAT：勾选 `repo` scope；
   - 细粒度 PAT：`Actions: read+write` + `Contents: read` + `Metadata: read`。
3. 打开 gh-toolbox 仓库任意页面（`https://github.com/<owner>/gh-toolbox`）或任意 jable.tv / pornhub 视频页，点右下角 **▶ yt-dlp** 悬浮按钮，弹框内粘贴 Token →「保存并验证」→（视频信息已自动带好）按需改参数 →「触发 Action」。

**注意**：

- 脚本走 `api.github.com` 的 `workflow_dispatch` 接口，Token 需对该仓库有写权限；Token 只保存在本地浏览器，**不要**写进仓库或分享截图。
- 运行状态轮询最长 10 分钟，超时会给出 Actions 页面链接；超大任务建议直接去 Actions 页面查看。
- m3u8 直链有时效性，过期后重新保存一次视频页 HTML（推送更新 `html/` 下的快照）即可。
- 复用到其他工具（如 qinglong）：触发目标已全手填，一般无需改代码；只有要改**留空时的兜底默认值**才动 `CONFIG`（owner / repo / workflowFile / pageDirs / pageFiles / videoSites）与 `INPUTS`（inputs 定义），`@match` 同步调整即可。

### 注意事项

- **完成日志**：每个文件下载完成即输出完整路径、大小与耗时——单文件一行含三项；播放列表等批量下载在整批结束后逐文件输出路径+大小，并给出本批合计耗时；任务结束汇总文件数与下载总耗时。
- **下载过程日志**：解析（Extracting URL / Downloading webpage）、目标文件（Destination / Deleting existing file）、实时进度、合并（Merging）、跳过（has already been downloaded）、后处理等 yt-dlp 内部消息都会输出到 Actions 日志——不只是最终结果。进度按文件每 5 秒一行：`[进度] 文件名: 分片 x/y 45.3% 12.3MB/27.1MB 1.2MB/s 剩余 00:12`（分片字段仅 HLS/DASH 等分片下载有）。
- **覆盖与跳过**（输入 `overwrite` / 环境变量 `YTDLP_OVERWRITE`）：不勾选（默认）时，下载前逐个检查目标文件，已存在即跳过不下载（HLS 下载历史 `.ts` 文件、计划名是 `.mp4` 的情况也能正确识别，不会重复下载）；勾选时强制重新下载——yt-dlp 会先删除已存在的目标文件再下载（等价 CLI `--force-overwrites`），下载失败旧文件已被删除，需自行承担风险。播放列表按条目粒度：全部已存在 → 整个跳过；部分缺失 → 只下缺失条目。
- **yt-dlp 时效性**：workflow 每次 `pip install -U` 装最新版；仍可能遇到站点改版导致个别 URL 失败——脚本会跳过失败项继续下载其他 URL，最终以退出码 1 标记失败。
- **大播放列表/频道**：首次会解析两遍（先查目标文件再下载），`YTDLP_PLAYLIST_END` 可限制规模。
- **时区**：cron 使用 UTC，默认 `0 18 * * *` = 北京时间 02:00。
- **超时**：job `timeout-minutes: 360` 为 GitHub 托管 runner 上限，特大任务需拆分。
- **转码模式**（`YTDLP_TRANSCODE`）：三者语义不同——`remux` = 换 mp4 封装且**流直接拷贝**（秒级、无损、码率与体积基本不变；源编码不兼容 mp4 时 ffmpeg 报错）；`recode` = **重编码**为 H.264/AAC（慢、有损、体积与耗时都会明显变化，用于源编码不兼容 MP4 的场景）；`none` = 不转码。**转换依赖 ffmpeg**：yt-dlp 的 remux/recode 本身就是调用 ffmpeg（等价 CLI 的 `--remux-video` / `--recode-video`），workflow 会在运行前确保 ffmpeg 可用；**本地运行必须自备 ffmpeg**，缺失时脚本直接报错并以退出码 2 结束（不会下半天最后给你一个 TS）。**注意一个 yt-dlp 的坑**：HLS/m3u8 的格式 ext 通常是 `mp4`，原生 remux/recode 后处理器会按扩展名判断「已是 mp4」而跳过，实际转换落在 FixupM3u8 上——它只做流拷贝，导致 recode 名不副实（两种模式输出一模一样）。因此 recode 模式下脚本会关掉 yt-dlp 的 fixup，让 TS 内容保留到下载后的探测层**真正重编码**。**三种模式下脚本都会用 ffprobe 探测每个产物文件的真实封装格式**（ffprobe 缺失时退化为 TS 包头嗅探）：内容是 TS 流但扩展名是 `.mp4` 的——`none` 如实改名为 `.ts`，`remux` 流拷贝转换，`recode` 重编码转换（转换失败回退保留 `.ts`）；内容是 MP4 却叫 `.ts` 的改回 `.mp4`；名实相符的文件一律不动。注意：recode 重编码耗时较长，大视频留意 6 小时 job 上限。
- **aria2**：勾选后 workflow 自动安装；本地运行需 PATH 中已有 `aria2c`，否则脚本告警并回退内置下载器。aria2 主要加速直链/分片下载，HLS(m3u8) 仍走 yt-dlp 内置或 ffmpeg 下载器。
- **自定义请求头**（`YTDLP_HEADERS` / 输入 `headers`）：合并覆盖到所有请求（用户值优先于 yt-dlp 默认头）。格式二选一——单行 JSON 对象（Actions 输入框是单行的，推荐这个），或每行一个 `Name: Value`（本地运行，`#` 为注释）。头部里带 `Cookie` 会被 yt-dlp 自动加载为 cookies，可与 `YTDLP_COOKIES` 任选其一。日志只打印头部**名称**不回显值（值可能含 Token）；格式错误（JSON 坏、缺冒号、非法头部名）直接以退出码 2 失败，不会默默丢头让你在下载时才吃 403。
- **Cloudflare 反爬 403**（日志出现 `HTTP Error 403 caused by Cloudflare anti-bot challenge`）：站点用 TLS 指纹识别机器人，普通 HTTP 库必然被拦。解法是**浏览器指纹伪装**——输入 `impersonate` 填 `1`（或 `chrome`），脚本会让所有请求（网页/m3u8/分片）伪装成 Chrome 的 TLS 握手特征。依赖 `curl_cffi`（已在 requirements.txt，workflow 自动安装；本地 `pip install -r tools/ytdlp/requirements.txt`），未装时脚本启动即报错退出码 2。也可指定具体目标如 `safari`、`chrome-131`、`chrome:windows-10`。**两种 403 要分清**：① 报错含 `Cloudflare anti-bot challenge` / `cf-mitigated: challenge` → 指纹问题，伪装能解；② 开了伪装后仍 403、页面是 "Sorry, you have been blocked"（WAF 规则封锁，Error 1020）→ 与指纹无关，是站点按 IP/会话拦截——GitHub runner 和大多数 VPS 是机房 IP，会被这类站点直接拉黑，**换家庭宽带本地跑**才是最有效的；同时带上真实浏览器会话（`headers` 里设置视频页 `Referer` + `Cookie`，或配 `YTDLP_COOKIES`）。Cloudflare 策略升级时可能失效，届时更新 yt-dlp/curl_cffi 即可。
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
