# gh-toolbox

GitHub Actions 驱动的工具箱：仓库下每个工具 = 一个自包含的 Python 脚本控制一个 CLI 工具，由独立 workflow 调度（手动输入 / 定时 / 文件变更触发），产物以 Actions Artifact 分发。yt-dlp 是第一个入驻的工具，后续可继续添加。

## 工具列表

| 工具 | 说明 | Workflow | 入口脚本 |
|---|---|---|---|
| `ytdlp` | yt-dlp 批量下载视频/播放列表 | `.github/workflows/ytdlp.yml` | `tools/ytdlp/download.py` |

## 通用约定

**目录结构**

```
.
├── .github/workflows/   # 每个工具一个 workflow：<工具名>.yml
├── tools/               # 每个工具一个自包含目录
│   └── ytdlp/
│       ├── download.py            # 主脚本（入口）
│       ├── requirements.txt       # 该工具专属依赖
│       ├── urls.txt               # 输入清单
│       ├── .ytdlp-archive.txt     # 跨运行状态，由 workflow 提交回仓库
│       └── downloads/             # 输出目录（gitignore，走 Artifact）
└── README.md
```

**规则**

- 工具脚本自包含：输入清单、档案、输出目录均相对**脚本所在目录**解析，可从任意 cwd 运行。
- 每个工具一个 workflow，步骤骨架固定：
  `checkout → setup-python → pip install -r tools/<工具>/requirements.txt → 运行脚本 → upload-artifact`
- 触发方式：`workflow_dispatch`（手动输入参数）、`schedule`（定时）、`push`（该工具目录 / 对应 workflow 变更）。
- 跨运行需要保留的状态（如下载档案）放工具目录内，workflow 结束时 `git commit` 回写（消息带 `[skip ci]`，且 push 路径过滤，不会递归触发）。

## 新增一个工具

1. `cp -r tools/ytdlp tools/<新工具名>`
2. 修改 `tools/<新工具名>/` 下的脚本逻辑、输入清单、依赖
3. `cp .github/workflows/ytdlp.yml .github/workflows/<新工具名>.yml`，把其中的 `tools/ytdlp` 路径替换为新工具名，按需调整 inputs / cron / artifact
4. 在本 README「工具列表」加一行
5. 提交推送，Actions 页面即可看到新 workflow

## ytdlp 工具说明

控制 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 批量下载视频/播放列表。

### 快速开始

1. 编辑 `tools/ytdlp/urls.txt`，填入视频/播放列表 URL（每行一个，`#` 注释）。
2. 打开仓库 **Actions → yt-dlp 下载器 → Run workflow**：
   - `urls`：临时指定下载目标（每行一个），留空则使用 `urls.txt`
   - `format`：格式表达式，如 `bv*+ba/b`、`best[height<=1080]`
   - `playlist_end`：每个播放列表最多下载几个视频，`0` 为不限制
3. 运行结束后在 **Artifacts** 区下载 `ytdlp-downloads`。
4. 定时任务默认每天北京时间 02:00 执行（改 `.github/workflows/ytdlp.yml` 里的 cron，注释掉即关闭）。

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

### 本地运行

```bash
pip install -r tools/ytdlp/requirements.txt

# 用 urls.txt（脚本自定位，任意目录运行均可）
python tools/ytdlp/download.py

# 命令行直接传 URL（会追加到下载列表）
python tools/ytdlp/download.py "https://www.youtube.com/watch?v=BaW_jenozKc"

# 覆盖参数
YTDLP_FORMAT="best[height<=1080]" python tools/ytdlp/download.py
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
