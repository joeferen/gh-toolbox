#!/usr/bin/env python3
"""yt-dlp 批量下载脚本（由 GitHub Actions 调用，也可本地运行）。

工作方式：
  1. 读取下载目标：环境变量 YTDLP_URLS 优先，其次仓库根目录 urls.txt，
     也支持命令行直接传 URL（python scripts/download.py <url> ...）
  2. 调用 yt-dlp Python API 执行下载（格式/封装/并发等通过环境变量控制）
  3. 维护下载档案（默认 .ytdlp-archive.txt），避免定时任务重复下载

环境变量：
  YTDLP_URLS             下载目标，换行或逗号分隔（优先于 urls.txt）
  YTDLP_OUTPUT_DIR       输出目录（默认 downloads）
  YTDLP_TEMPLATE         输出文件名模板（默认 %(title)s [%(id)s].%(ext)s）
  YTDLP_FORMAT           格式表达式（默认 bv*+ba/b）
  YTDLP_MERGE_FORMAT     合并封装格式（默认 mp4）
  YTDLP_ARCHIVE          下载档案路径（默认 .ytdlp-archive.txt）
  YTDLP_PLAYLIST_END     每个播放列表最多下载几个视频，0=不限（默认 0）
  YTDLP_CONCURRENT_FRAG  分片并发数（默认 4）
  YTDLP_RETRIES          网络重试次数（默认 10）
  YTDLP_COOKIES           Netscape 格式 cookies 文件路径（可选）
  YTDLP_VERBOSE          置 1 输出 yt-dlp debug 日志

退出码：0 = 全部成功/无需下载；1 = 存在失败项；2 = 缺少依赖。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError
except ImportError:  # 本地忘装依赖时给出明确提示
    sys.stderr.write("缺少依赖 yt-dlp，请先执行: pip install -r requirements.txt\n")
    sys.exit(2)


def log(msg: str) -> None:
    print(f"[ytdlp] {msg}", flush=True)


class Logger:
    """把 yt-dlp 的内部日志转发到标准输出（Actions 日志可见）。"""

    def debug(self, msg):
        if os.environ.get("YTDLP_VERBOSE"):
            print(f"[yt-dlp][debug] {msg}", flush=True)

    def info(self, msg):
        print(f"[yt-dlp] {msg}", flush=True)

    def warning(self, msg):
        print(f"[yt-dlp][警告] {msg}", flush=True)

    def error(self, msg):
        print(f"[yt-dlp][错误] {msg}", flush=True)


def env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip()


def env_int(name: str, default: int) -> int:
    raw = env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        log(f"环境变量 {name}={raw!r} 不是整数，使用默认值 {default}")
        return default


def parse_urls(raw: str) -> list:
    """解析 URL 清单：支持换行/逗号分隔，'#' 为注释。"""
    urls = []
    for line in raw.replace(",", "\n").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            urls.append(line)
    return urls


def load_urls() -> list:
    """URL 来源优先级：环境变量 YTDLP_URLS > 仓库根目录 urls.txt。"""
    from_env = os.environ.get("YTDLP_URLS", "")
    if from_env.strip():
        log("下载目标来源: 环境变量 YTDLP_URLS")
        return parse_urls(from_env)

    urls_file = Path("urls.txt")
    if urls_file.is_file():
        log("下载目标来源: urls.txt")
        return parse_urls(urls_file.read_text(encoding="utf-8"))

    return []


def load_archive(path: Path) -> set:
    if not path.is_file():
        return set()
    return {
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    }


def save_archive(path: Path, archive: set) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(sorted(archive)) + "\n", encoding="utf-8")


def info_key(info: dict):
    """档案 key，格式与 yt-dlp --download-archive 一致：'<extractor> <id>'。"""
    video_id = info.get("id")
    if not video_id:
        return None
    extractor = (
        info.get("ie_key")
        or info.get("extractor_key")
        or info.get("extractor")
        or "unknown"
    )
    return f"{extractor} {video_id}"


def build_opts() -> dict:
    output_dir = env("YTDLP_OUTPUT_DIR", "downloads")
    template = env("YTDLP_TEMPLATE", "%(title)s [%(id)s].%(ext)s")
    opts = {
        "outtmpl": output_dir.rstrip("/\\") + "/" + template,
        "format": env("YTDLP_FORMAT", "bv*+ba/b"),
        "merge_output_format": env("YTDLP_MERGE_FORMAT", "mp4"),
        "concurrent_fragments": env_int("YTDLP_CONCURRENT_FRAG", 4),
        "retries": env_int("YTDLP_RETRIES", 10),
        "quiet": True,       # 输出统一走 Logger，避免重复刷屏
        "noprogress": True,  # 进度用 progress_hooks 自己汇报
        "no_warnings": False,
        "logger": Logger(),
    }
    if env("YTDLP_VERBOSE"):
        opts["verbose"] = True
    cookies = env("YTDLP_COOKIES")
    if cookies:
        opts["cookiefile"] = cookies
    playlist_end = env_int("YTDLP_PLAYLIST_END", 0)
    if playlist_end > 0:
        opts["playlistend"] = playlist_end
    return opts


def main() -> int:
    if any(arg in ("-h", "--help") for arg in sys.argv[1:]):
        print(__doc__)
        return 0

    urls = load_urls()
    cli_urls = [a for a in sys.argv[1:] if a.startswith(("http://", "https://"))]
    if cli_urls:
        urls.extend(cli_urls)
        log(f"命令行追加 {len(cli_urls)} 个下载目标")

    if not urls:
        log("没有需要下载的 URL（在 urls.txt 填写，或通过 YTDLP_URLS / Actions 输入提供）")
        return 0

    opts = build_opts()
    archive_path = Path(env("YTDLP_ARCHIVE", ".ytdlp-archive.txt"))
    archive = load_archive(archive_path)
    log(f"下载档案 {archive_path} 已有 {len(archive)} 条记录")

    def on_progress(d: dict) -> None:
        # 每个视频下载完成立即记档：中断/失败也不会重复下载已完成部分
        if d.get("status") != "finished":
            return
        info = d.get("info_dict") or {}
        key = info_key(info)
        if key and key not in archive:
            archive.add(key)
            save_archive(archive_path, archive)
            log(f"记入档案: {info.get('title') or key}")

    opts["progress_hooks"] = [on_progress]

    ok, skipped, failed = [], [], []

    with YoutubeDL(opts) as ydl:
        for url in urls:
            log(f"解析: {url}")
            try:
                info = ydl.extract_info(url, download=False)
            except DownloadError as exc:
                log(f"解析失败: {url} -> {exc}")
                failed.append(url)
                continue
            except Exception as exc:
                log(f"解析异常: {url} -> {exc!r}")
                failed.append(url)
                continue

            if not info:
                skipped.append(url)
                continue

            entries = info.get("entries")
            if entries is None:
                # ---- 单个视频 ----
                key = info_key(info)
                if key and key in archive:
                    log(f"已下载过，跳过: {info.get('title') or url}")
                    skipped.append(url)
                    continue
                try:
                    ydl.download([url])
                except DownloadError as exc:
                    log(f"下载失败: {url} -> {exc}")
                    failed.append(url)
                    continue
                if key:
                    archive.add(key)
                    save_archive(archive_path, archive)
                ok.append(url)
                continue

            # ---- 播放列表 / 频道等多视频条目 ----
            items = [e for e in entries if e]
            if not items:
                log(f"没有可下载条目，跳过: {url}")
                skipped.append(url)
                continue
            keys = [k for k in (info_key(e) for e in items) if k]
            if keys and all(k in archive for k in keys):
                log(f"全部条目已下载过，跳过: {info.get('title') or url}")
                skipped.append(url)
                continue
            try:
                ydl.download([url])
            except DownloadError as exc:
                log(f"下载失败（已完成部分已记档）: {url} -> {exc}")
                failed.append(url)
                continue
            for key in keys:
                archive.add(key)
            save_archive(archive_path, archive)
            ok.append(url)

    log("=" * 48)
    log(f"任务结束: 成功 {len(ok)}，跳过 {len(skipped)}，失败 {len(failed)}")
    for url in failed:
        log(f"  失败: {url}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
