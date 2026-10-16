#!/usr/bin/env python3
"""yt-dlp 批量下载脚本（gh-toolbox 的 ytdlp 工具，由 GitHub Actions 调用，也可本地运行）。

本脚本自包含：urls.txt、下载档案、downloads/ 输出目录均相对脚本所在目录解析，
可从任意工作目录运行。

工作方式：
  1. 读取下载目标：环境变量 YTDLP_URLS 优先，其次本工具目录下的 urls.txt，
     也支持命令行直接传 URL（python tools/ytdlp/download.py <url> ...）
  2. 调用 yt-dlp Python API 执行下载（格式/封装/并发等通过环境变量控制）
  3. 维护下载档案（默认 .ytdlp-archive.txt），避免重复下载
  4. 每个文件下载完成后输出完整路径、大小与耗时
  5. 可选：全部下载完成后上传到 Hugging Face datasets（默认关闭）

环境变量：
  YTDLP_URLS             下载目标，换行或逗号分隔（优先于 urls.txt）
  YTDLP_OUTPUT_DIR       输出目录（默认 downloads）
  YTDLP_TEMPLATE         输出文件名模板（默认 %(title)s [%(id)s].%(ext)s）
  YTDLP_RENAME            输出文件名（不含扩展名）或含 % 的模板；优先于 YTDLP_TEMPLATE
  YTDLP_FORMAT           格式表达式（默认 bv*+ba/b）
  YTDLP_MERGE_FORMAT     合并封装格式（默认 mp4）
  YTDLP_ARCHIVE          下载档案路径（默认 .ytdlp-archive.txt）
  YTDLP_PLAYLIST_END     每个播放列表最多下载几个视频，0=不限（默认 0）
  YTDLP_CONCURRENT_FRAG  分片并发数（默认 4）
  YTDLP_RETRIES          网络重试次数（默认 10）
  YTDLP_COOKIES           Netscape 格式 cookies 文件路径（可选）
  YTDLP_VERBOSE          置 1 输出 yt-dlp debug 日志
  YTDLP_TRANSCODE        转码为 MP4：none(默认)/remux(仅换封装,流拷贝)/recode(重编码H.264+AAC,慢)。
                         依赖 ffmpeg（yt-dlp 的 remux/recode 即调用 ffmpeg）；未安装时脚本直接
                         报错退出(退出码 2)，不会默默产出 TS。下载完成后脚本还会用 ffprobe 探测
                         真实封装并修正：TS 流在 none 下如实改名为 .ts，在 remux/recode 下真正
                         转成 MP4（而非仅改后缀）
  YTDLP_ARIA2            置 1/true/yes/on 启用 aria2c 多连接加速（未安装则回退内置下载器）
  YTDLP_ARIA2_ARGS       aria2c 附加参数，空格分隔（默认 -x 16 -s 16 -k 1M）
  YTDLP_HF_UPLOAD        置 1/true/yes/on 启用上传到 Hugging Face datasets（默认关）
  YTDLP_HF_REPO          HF dataset 仓库 ID（用户名/数据集名，如 smanx/my-videos）
  YTDLP_HF_PRIVATE       创建仓库时是否私有，1=私有(默认)/0=公开
  YTDLP_HF_PATH          上传到数据集仓库内的子目录（如 videos/2024），留空=根路径
  YTDLP_HF_TOKEN         Hugging Face 访问令牌（带工具前缀，避免多工具 token 混用）

退出码：0 = 全部成功/无需下载；1 = 存在失败项；2 = 缺少依赖。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

try:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError
except ImportError:  # 本地忘装依赖时给出明确提示
    sys.stderr.write("缺少依赖 yt-dlp，请先执行: pip install -r tools/ytdlp/requirements.txt\n")
    sys.exit(2)

# 本工具目录：urls.txt / 档案 / 输出目录都相对它解析
TOOL_DIR = Path(__file__).resolve().parent


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

    urls_file = TOOL_DIR / "urls.txt"
    if urls_file.is_file():
        log(f"下载目标来源: {urls_file}")
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


# 常见媒体扩展名（YTDLP_RENAME 剥扩展名用）
MEDIA_EXTS = ("mp4", "mkv", "webm", "mov", "m4v", "flv", "avi", "wmv", "ts", "m2ts",
              "mpg", "mpeg", "3gp", "m4a", "mp3", "aac", "opus", "ogg", "wav", "flac")
# 模板含任一标记即认为多文件场景下文件名可能唯一
UNIQUE_MARKERS = ("title", "id", "index", "autonumber", "n_entry", "epoch", "date", "timestamp")


def effective_template() -> str:
    """输出文件名模板：YTDLP_RENAME 优先，其次 YTDLP_TEMPLATE。

    YTDLP_RENAME 取值规则：
      - 含 %（如 %(title)s）→ 视为模板，缺 %(ext)s 时自动补上
      - 否则 → 视为字面文件名，剥掉自带的媒体扩展名后补 .%(ext)s
    """
    rename = env("YTDLP_RENAME")
    if not rename:
        return env("YTDLP_TEMPLATE", "%(title)s [%(id)s].%(ext)s")
    if "%" in rename:
        return rename if "%(ext)s" in rename else rename + ".%(ext)s"
    if rename.lower().endswith(tuple(f".{e}" for e in MEDIA_EXTS)):
        rename = rename[: rename.rfind(".")]
    return f"{rename}.%(ext)s"


def build_opts() -> dict:
    # 相对路径基于工具目录解析，绝对路径原样使用
    output_dir = Path(env("YTDLP_OUTPUT_DIR", "downloads"))
    if not output_dir.is_absolute():
        output_dir = TOOL_DIR / output_dir
    template = effective_template()
    if env("YTDLP_RENAME"):
        log(f"自定义命名模板: {template}")
    opts = {
        "outtmpl": output_dir.as_posix().rstrip("/") + "/" + template,
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

    # 转码为 MP4。注意：remuxvideo/recodevideo 只有 yt-dlp CLI 认，
    # Python API 必须显式挂 FFmpegVideoRemuxer/Convertor 后处理器才生效
    transcode = env("YTDLP_TRANSCODE", "none").lower()
    if transcode == "remux":
        # 仅换 mp4 封装、流直接拷贝（快；编码不兼容 mp4 时 ffmpeg 会报错）
        opts["postprocessors"] = [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}]
        opts["postprocessor_args"] = {"videoremuxer": ["-movflags", "+faststart"]}
    elif transcode == "recode":
        # 换 mp4 封装，并按 ffmpeg 的 mp4 默认编码器重编码（H.264/AAC，慢但兼容性最好）
        opts["postprocessors"] = [{"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}]
    elif transcode not in ("none", "no", "off", ""):
        log(f"YTDLP_TRANSCODE={transcode} 无法识别，已忽略（可选 none/remux/recode）")

    # aria2c 多连接加速（本机未安装时回退内置下载器）
    if env("YTDLP_ARIA2").lower() in ("1", "true", "yes", "on"):
        if shutil.which("aria2c"):
            opts["external_downloader"] = "aria2c"
            opts["external_downloader_args"] = {
                "aria2c": env("YTDLP_ARIA2_ARGS", "-x 16 -s 16 -k 1M").split()
            }
            log("已启用 aria2c 外部下载器加速")
        else:
            log("未检测到 aria2c，回退内置下载器（GitHub Actions 勾选后会自动安装；本地请先安装 aria2）")
    return opts


def human_size(num_bytes: int) -> str:
    """字节数格式化为人类可读大小。"""
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{int(size)} B" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def fmt_duration(seconds: float) -> str:
    """秒数格式化为人类可读耗时。"""
    if seconds < 60:
        return f"{seconds:.1f} 秒"
    total = int(seconds + 0.5)
    minutes, sec = divmod(total, 60)
    if minutes < 60:
        return f"{minutes} 分 {sec} 秒"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} 小时 {minutes} 分 {sec} 秒"


_TS_EXTS = {".ts", ".mts", ".m2ts"}


def probe_container(path: Path) -> str | None:
    """用 ffprobe 探测文件的真实封装格式（format_name），失败/不可用返回 None。

    yt-dlp 对 HLS(m3u8) 常把 TS 分片拼接后直接命名为 .mp4，扩展名不可信，
    必须探测内容。ffprobe 只读文件头，秒级完成，大文件无压力。
    """
    exe = shutil.which("ffprobe")
    if not exe:
        return None
    try:
        r = subprocess.run(
            [exe, "-v", "error", "-print_format", "json", "-show_format", str(path)],
            capture_output=True, timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout.decode("utf-8", "replace"))["format"]["format_name"]
    except (ValueError, KeyError, TypeError):
        return None


def _unique_path(p: Path) -> Path:
    """目标名已被占用时追加 -1/-2 后缀，避免覆盖已有文件。"""
    if not p.exists():
        return p
    for i in range(1, 1000):
        cand = p.with_name(f"{p.stem}-{i}{p.suffix}")
        if not cand.exists():
            return cand
    return p.with_name(f"{p.stem}-{os.getpid()}{p.suffix}")


def _ffmpeg_to_mp4(src: Path, dst: Path, recode: bool) -> bool:
    """ffmpeg 转成 MP4：recode=False 流拷贝封装转换，True 重编码 H.264/AAC。"""
    exe = shutil.which("ffmpeg")
    if not exe:
        return False
    cmd = [exe, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src)]
    if recode:
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "23",
                "-c:a", "aac", "-b:a", "160k"]
    else:
        cmd += ["-map", "0", "-c", "copy"]
    cmd += ["-movflags", "+faststart", "-f", "mp4", str(dst)]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=21600)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0 and dst.exists() and dst.stat().st_size > 0


def _sniff_ts(path: Path) -> bool:
    """无 ffprobe 时的内容兜底嗅探：MPEG-TS 每包 188 字节、包头固定 0x47。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(377)
    except OSError:
        return False
    return len(head) >= 377 and head[0] == 0x47 and head[188] == 0x47 and head[376] == 0x47


def fix_mislabeled_files(files: list, transcode: str) -> list:
    """按真实封装格式修正本次产物的后缀/封装，返回修正后的 (路径, 大小) 列表。

    背景：HLS(m3u8) 下载常产出「内容是 TS 流、扩展名是 .mp4」的文件（环境
    缺 ffmpeg 时 yt-dlp 不做 fixup，直接保留拼接的 TS），而 yt-dlp 的
    FFmpegVideoRemuxer 只按扩展名判断（源已是 .mp4 就跳过），导致选了
    remux 实际什么都没转。规则：
      - 内容是 TS：remux/recode -> 真正转 MP4（流拷贝；recode 失败再试流拷贝）；
        none -> 如实改名为 .ts；转换失败一律回退为保留 .ts（数据不丢）
      - 内容是 MP4 但扩展名是 .ts 类：改名为 .mp4（如实标注，非转码）
      - 其余（名实相符）不动
    探测优先 ffprobe；ffprobe 缺失时退化为 TS 包头嗅探（无需外部工具，
    但此时无法识别「MP4 内容被命名成 .ts」的情况）。
    """
    if not files:
        return files
    if shutil.which("ffprobe") is None and not fix_mislabeled_files._warned:
        fix_mislabeled_files._warned = True
        log("未检测到 ffprobe，改用 TS 包头嗅探判断格式（仅能识别 TS 流，转换功能需安装 ffmpeg）")
    out = []
    for path, size in files:
        fmt = probe_container(path)
        if not fmt and _sniff_ts(path):
            fmt = "mpegts"
        if not fmt:
            out.append((path, size))
            continue
        ext = path.suffix.lower()
        is_ts = "mpegts" in fmt
        is_mp4 = "mov" in fmt or "mp4" in fmt

        if is_ts and transcode in ("remux", "recode") and shutil.which("ffmpeg"):
            action = "重编码" if transcode == "recode" else "封装转换(流拷贝)"
            log(f"探测到 TS 流（当前扩展名 {ext or '无'}）: {path.name} -> {action}为 MP4")

            def convert_once(recode: bool) -> Path | None:
                # 先转到临时名再归位：源文件自己常占着目标名（如 video.mp4 是 TS）
                desired = path.with_suffix(".mp4")
                tmp = _unique_path(path.with_name(path.stem + ".converting.mp4"))
                if not _ffmpeg_to_mp4(path, tmp, recode=recode):
                    tmp.unlink(missing_ok=True)
                    return None
                if desired == path:
                    path.unlink()  # 目标名就是源文件自己：删源后才能归位
                if desired.exists():
                    return tmp  # 目标名被其他文件占用，保留临时唯一名
                tmp.rename(desired)
                return desired

            dst = convert_once(recode=(transcode == "recode"))
            if not dst and transcode == "recode":
                log("重编码失败，尝试流拷贝封装转换（无损）")
                dst = convert_once(recode=False)
            if dst:
                if dst != path:
                    path.unlink(missing_ok=True)  # 归位占用源名时 convert_once 已删过源
                log(f"转换完成: {dst.name}（{human_size(dst.stat().st_size)}）")
                out.append((dst, dst.stat().st_size))
                continue
            log("转换为 MP4 失败，保留 TS 原始数据")
            transcode = "none"  # 后续文件同批失败大概率同样失败，直接走改名兜底

        if is_ts and ext not in _TS_EXTS:
            dst = _unique_path(path.with_suffix(".ts"))
            path.rename(dst)
            log(f"探测到 TS 流但扩展名为 {ext or '无'}，已如实改名为: {dst.name}")
            out.append((dst, size))
        elif is_mp4 and ext in _TS_EXTS:
            dst = _unique_path(path.with_suffix(".mp4"))
            path.rename(dst)
            log(f"探测到 MP4 封装但扩展名为 {ext}，已如实改名为: {dst.name}")
            out.append((dst, size))
        else:
            out.append((path, size))
    return out


fix_mislabeled_files._warned = False


def report_downloads(out_root: Path, archive_path: Path, t0: float,
                     elapsed: float, reported: set, transcode: str = "none") -> list:
    """报告本次下载窗口内产出/更新的文件：完整路径、大小、耗时。

    以 st_mtime >= t0 判定文件归属（下载/合并/转码都会刷新 mtime，
    因此直链、HLS、合并、recode 的最终文件都能被覆盖到）；
    已报告过的文件不重复报告；下载档案本身不算产物。
    报告前先按真实封装格式修正 TS/MP4 后缀（见 fix_mislabeled_files）。
    """
    if not out_root.is_dir():
        return []
    found = []
    for p in sorted(out_root.rglob("*")):
        if not p.is_file() or p in reported:
            continue
        try:
            if p.resolve() == archive_path.resolve():
                continue
            stat = p.stat()
        except OSError:
            continue
        if stat.st_mtime < t0:
            continue
        reported.add(p)
        found.append((p, stat.st_size))
    found = fix_mislabeled_files(found, transcode)
    if len(found) == 1:
        p, size = found[0]
        log(f"下载完成: {p}（{human_size(size)}，耗时 {fmt_duration(elapsed)}）")
    elif found:
        for p, size in found:
            log(f"下载完成: {p}（{human_size(size)}）")
        log(f"  耗时: {fmt_duration(elapsed)}（以上 {len(found)} 个文件合计）")
    return found


def upload_to_hf(folder: Path, repo_id: str, private: bool, path_in_repo: str = "") -> str:
    """把 folder 上传到 Hugging Face dataset 仓库，返回仓库页面 URL。

    path_in_repo 为仓库内的目标子目录，空 = 根路径。
    延迟导入 huggingface_hub：纯下载场景不依赖该库。
    令牌取 YTDLP_HF_TOKEN 环境变量（带工具前缀，避免多工具 token 混用），
    未设置时回退到本地 `hf auth login` 缓存。
    """
    try:
        from huggingface_hub import HfApi
    except ImportError:
        raise RuntimeError(
            "缺少依赖 huggingface_hub，请先执行: pip install -r tools/ytdlp/requirements.txt"
        )

    api = HfApi(token=env("YTDLP_HF_TOKEN") or None)
    # 仓库已存在时 exist_ok 不报错，也不会改动已有仓库的可见性
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=private, exist_ok=True)
    # path_in_repo 归一化：去首尾空白与斜杠，空 = 根路径
    path_in_repo = (path_in_repo or "").strip().strip("/")
    api.upload_folder(
        repo_id=repo_id,
        repo_type="dataset",
        folder_path=str(folder),
        path_in_repo=path_in_repo or None,
        commit_message="Upload from gh-toolbox ytdlp",
    )
    return f"https://huggingface.co/datasets/{repo_id}"


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
    # 归一化的转码模式（build_opts 里未识别值只告警），用于下载后的后缀修正
    transcode = env("YTDLP_TRANSCODE", "none").lower()
    if transcode not in ("remux", "recode"):
        transcode = "none"
    if transcode != "none" and not shutil.which("ffmpeg"):
        # yt-dlp 的 FFmpegVideoRemuxer/Convertor 和脚本兜底转换都走 ffmpeg，
        # 没有它不可能得到 MP4——提前失败，避免下半天拿到 TS
        log("错误: 选择了转码(remux/recode)但未在 PATH 中检测到 ffmpeg")
        log("      yt-dlp 的 remux/recode 本身就是调用 ffmpeg 完成转换，缺失时无法得到 MP4")
        log("      GitHub Actions 运行由 workflow 自动保证；本地运行请先安装 ffmpeg 并加入 PATH")
        return 2
    archive_path = Path(env("YTDLP_ARCHIVE") or TOOL_DIR / ".ytdlp-archive.txt")
    archive = load_archive(archive_path)
    log(f"下载档案 {archive_path} 已有 {len(archive)} 条记录")
    out_root = Path(opts["outtmpl"]).parent  # 产物扫描根目录
    reported: set = set()  # 已报告的产物文件（跨 URL 去重）
    total_files = 0
    total_time = 0.0

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
                t0 = time.time()
                try:
                    ydl.download([url])
                except DownloadError as exc:
                    log(f"下载失败: {url} -> {exc}")
                    failed.append(url)
                    continue
                elapsed = time.time() - t0
                total_time += elapsed
                if key:
                    archive.add(key)
                    save_archive(archive_path, archive)
                total_files += len(report_downloads(out_root, archive_path, t0, elapsed, reported, transcode))
                ok.append(url)
                continue

            # ---- 播放列表 / 频道等多视频条目 ----
            items = [e for e in entries if e]
            if not items:
                log(f"没有可下载条目，跳过: {url}")
                skipped.append(url)
                continue
            if not any(m in effective_template() for m in UNIQUE_MARKERS):
                log(f"注意: 播放列表含 {len(items)} 个条目，但命名模板缺少唯一占位符"
                    f"（如 %(playlist_index)s、%(title)s），文件可能互相覆盖")
            keys = [k for k in (info_key(e) for e in items) if k]
            if keys and all(k in archive for k in keys):
                log(f"全部条目已下载过，跳过: {info.get('title') or url}")
                skipped.append(url)
                continue
            t0 = time.time()
            try:
                ydl.download([url])
            except DownloadError as exc:
                log(f"下载失败（已完成部分已记档）: {url} -> {exc}")
                failed.append(url)
                continue
            elapsed = time.time() - t0
            total_time += elapsed
            for key in keys:
                archive.add(key)
            save_archive(archive_path, archive)
            total_files += len(report_downloads(out_root, archive_path, t0, elapsed, reported, transcode))
            ok.append(url)

    # ---- 全部下载完毕：可选上传到 Hugging Face datasets（默认关闭） ----
    upload_failed = False
    if env("YTDLP_HF_UPLOAD").lower() in ("1", "true", "yes", "on"):
        repo_id = env("YTDLP_HF_REPO")
        hf_path = env("YTDLP_HF_PATH")
        has_files = out_root.is_dir() and any(p.is_file() for p in out_root.rglob("*"))
        if not repo_id:
            log("启用了 HF 上传但未设置 YTDLP_HF_REPO（格式：用户名/数据集名），跳过上传")
            upload_failed = True
        elif not has_files:
            log(f"输出目录 {out_root} 没有文件，跳过 HF 上传")
        else:
            private = env("YTDLP_HF_PRIVATE", "1").lower() in ("1", "true", "yes", "on")
            target = (hf_path.strip("/") + "/") if hf_path else "根路径"
            log(f"上传到 Hugging Face datasets: {repo_id}"
                f"（{'私有' if private else '公开'}仓库，目标路径 {target}）")
            try:
                repo_url = upload_to_hf(out_root, repo_id, private, hf_path)
                log(f"上传完成: {repo_url}")
            except Exception as exc:
                log(f"上传到 Hugging Face 失败: {exc}")
                upload_failed = True

    log("=" * 48)
    log(f"任务结束: 成功 {len(ok)}，跳过 {len(skipped)}，失败 {len(failed)}")
    if total_files:
        log(f"共下载 {total_files} 个文件，下载总耗时 {fmt_duration(total_time)}")
    for url in failed:
        log(f"  失败: {url}")
    return 1 if (failed or upload_failed) else 0


if __name__ == "__main__":
    sys.exit(main())
