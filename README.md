# ytdlp-action

通过 GitHub Actions 定时/手动执行 `scripts/download.py`，由该脚本驱动 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 批量下载视频/播放列表。下载产物作为 Actions Artifact 提供下载，并用「下载档案」避免重复下载。

## 工作流程

```
                ┌────────────────────────────────────────────┐
                │ GitHub Actions (.github/workflows/)        │
                │   workflow_dispatch(手动输入)              │
                │   schedule(每天 02:00 北京时间)            │
                │   push(urls.txt / 脚本变更)               │
                └───────────────┬────────────────────────────┘
                                │ inputs → 环境变量
                                ▼
                ┌────────────────────────────────────────────┐
                │ scripts/download.py                        │
                │   读 URL(YTDLP_URLS > urls.txt)           │
                │   控制 yt-dlp 下载                        │
                │   维护 .ytdlp-archive.txt                 │
                └───────────────┬────────────────────────────┘
                                │
                  ┌─────────────┴─────────────┐
                  ▼                           ▼
        downloads/ (Artifact)      .ytdlp-archive.txt (回写仓库)
```

## 快速开始

1. 把本目录推送到 GitHub 仓库。
2. 编辑 `urls.txt`，填入要下载的视频/播放列表 URL（每行一个，`#` 注释）。
3. 打开仓库 **Actions → yt-dlp 下载器 → Run workflow**：
   - `urls`：临时指定下载目标（每行一个），留空则使用 `urls.txt`
   - `format`：格式表达式，如 `bv*+ba/b`、`best[height<=1080]`
   - `playlist_end`：每个播放列表最多下载几个视频，`0` 为不限制
4. 运行结束后在 **Artifacts** 区下载 `ytdlp-downloads`。
5. 定时任务默认每天北京时间 02:00 自动执行（改 `.github/workflows/yt-dlp.yml` 里的 cron，注释掉即关闭）。

## workflow 输入参数

| 输入 | 说明 | 默认 |
|---|---|---|
| `urls` | 下载目标，换行分隔；留空用 `urls.txt` | 空 |
| `format` | yt-dlp 格式表达式 | 空（用脚本默认 `bv*+ba/b`） |
| `playlist_end` | 每个播放列表下载上限，0 不限 | 0 |

## 脚本环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `YTDLP_URLS` | 下载目标（换行/逗号分隔），优先于 `urls.txt` | 空 |
| `YTDLP_OUTPUT_DIR` | 输出目录 | `downloads` |
| `YTDLP_TEMPLATE` | 输出文件名模板 | `%(title)s [%(id)s].%(ext)s` |
| `YTDLP_FORMAT` | 格式表达式 | `bv*+ba/b` |
| `YTDLP_MERGE_FORMAT` | 合并封装格式 | `mp4` |
| `YTDLP_ARCHIVE` | 下载档案路径 | `.ytdlp-archive.txt` |
| `YTDLP_PLAYLIST_END` | 播放列表下载上限 | `0` |
| `YTDLP_CONCURRENT_FRAG` | 分片并发数 | `4` |
| `YTDLP_RETRIES` | 网络重试次数 | `10` |
| `YTDLP_COOKIES` | Netscape cookies 文件路径 | 空 |
| `YTDLP_VERBOSE` | 置 1 输出 yt-dlp debug 日志 | 空 |

## 本地运行

```bash
pip install -r requirements.txt

# 用 urls.txt
python scripts/download.py

# 命令行直接传 URL（会追加到下载列表）
python scripts/download.py "https://www.youtube.com/watch?v=BaW_jenozKc"

# 覆盖参数
YTDLP_FORMAT="best[height<=1080]" YTDLP_OUTPUT_DIR=out python scripts/download.py
```

## cookies（可选）

需要登录/年龄验证的站点：

```bash
base64 -w0 cookies.txt   # 生成单行 base64
```

把输出添加到仓库 Secrets：`Settings → Secrets and variables → Actions → New repository secret`，名 `YTDLP_COOKIES`。workflow 会自动解码为 `cookies.txt` 并传给脚本（`cookies.txt` 已在 `.gitignore` 中，不会提交）。

## 下载档案

`scripts/download.py` 每下载完成一个视频就把 `extractor 视频ID` 写入 `.ytdlp-archive.txt`；workflow 结束后把该文件提交回仓库，因此定时任务不会重复下载已完成的内容。删除某行即可强制重新下载。

## 注意事项

- **Artifact 体积**：GitHub 免费额度有存储上限（仓库级 500 MB），大下载建议缩短 `retention-days` 或改用其他存储（如 rclone 上传 WebDAV/网盘）。
- **yt-dlp 时效性**：workflow 每次 `pip install -U` 装最新版；仍可能遇到站点改版导致个别 URL 失败——脚本会跳过失败项继续下载其他 URL，最终以退出码 1 标记失败。
- **大播放列表/频道**：首次会解析两遍（先查档案再下载），`YTDLP_PLAYLIST_END` 可限制规模。
- **时区**：cron 使用 UTC，默认 `0 18 * * *` = 北京时间 02:00。
- **超时**：job `timeout-minutes: 360` 为 GitHub 托管 runner 上限，特大任务需拆分。
- 修改 `YTDLP_OUTPUT_DIR` 时，同步修改 workflow 中 `upload-artifact` 的 `path`。

## 目录结构

```
.
├── .github/workflows/yt-dlp.yml   # GitHub Actions 工作流
├── scripts/download.py            # 控制 yt-dlp 的下载脚本
├── requirements.txt               # Python 依赖（yt-dlp）
├── urls.txt                       # 下载目标清单
├── .gitignore
└── README.md
```
