#!/usr/bin/env python3
"""N_m3u8DL-RE 批量下载脚本（gh-toolbox 的 m3u8 工具，由 GitHub Actions 调用，也可本地运行）。

控制 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE) 下载 HLS(m3u8)/DASH(mpd)
流，功能对齐 ytdlp 工具：URL 清单 → 下载 → 混流封装 → 可选上传 HF datasets。

本脚本自包含：urls.txt、downloads/ 输出目录均相对脚本所在目录解析，可从任意
工作目录运行。N_m3u8DL-RE 本体不走 pip：PATH 中没有时按 latest release 自动
下载对应平台的二进制到工具目录 bin/（gitignore），已存在则直接复用。

工作方式：
  1. 读取下载目标：环境变量 M3U8_URLS 优先，其次本工具目录下的 urls.txt，
     也支持命令行直接传 URL（python tools/m3u8/download.py <url> ...）
  2. 逐个 URL 调用 N_m3u8DL-RE（非交互：--auto-select / 流选择表达式），
     产物落在 downloads/；分片下载实时进度按 5 秒节流输出
  3. 跳过判据只看目标文件是否存在（--save-name 派生名 + 最终封装后缀），
     与 ytdlp 的 overwrite 语义一致
  4. 下载完成后按需混流封装（-M format=mp4/mkv/ts，依赖 ffmpeg）并探测
     真实封装修正后缀
  5. 可选：全部下载完成后上传到 Hugging Face datasets（默认关闭）

环境变量：
  M3U8_URLS             下载目标，换行或逗号分隔（优先于 urls.txt）
  M3U8_BIN              N_m3u8DL-RE 可执行文件路径（默认自动定位/下载到 bin/）
  M3U8_OUTPUT_DIR       输出目录（默认 downloads）
  M3U8_TMP_DIR          临时文件目录（默认 downloads/.tmp）
  M3U8_SELECT_VIDEO     视频流选择表达式（如 best、res="1920*":for=best）
  M3U8_AUTO_SELECT      自动选择所有类型的最佳轨道（默认开；与流选择表达式
                        二选一，都是非交互模式——CI 上交互选流会直接失败）
  M3U8_SAVE_NAME        输出文件名（不含扩展名）；多个 URL 时会自动加序号
                        （video.mp4 / video-2.mp4），避免互相覆盖
  M3U8_OVERWRITE        覆盖目标文件（默认关）：置 1/true/yes/on 强制重新下载
                        并删除已存在的同名文件；不置时目标文件已存在则跳过
  M3U8_MUX_FORMAT       下载完成后混流封装（依赖 ffmpeg，缺失报错退出码 2）：
                        mp4(默认) / mkv / ts / none(不混流，保留轨道原文件)
  M3U8_THREAD_COUNT     下载线程数（默认 16）
  M3U8_RETRIES          每分片重试次数（默认 7，与 N_m3u8DL-RE 默认一致）
  M3U8_COOKIES          Netscape 格式 cookies 文件路径（可选）
  M3U8_HEADERS          自定义请求头：JSON 对象 {"Referer":"https://..."}
                        （推荐，Actions 单行输入框可用）或每行 Name: Value；
                        格式错误退出码 2
  M3U8_EXTRA_ARGS       N_m3u8DL-RE 附加命令行参数（空格分隔，原样透传，
                        如 --key KID:KEY --live-record-limit 00:30:00）
  M3U8_RE_VERSION       要使用的 N_m3u8DL-RE 版本 tag（默认 latest）
  M3U8_VERBOSE          置 1 输出 N_m3u8DL-RE DEBUG 日志
  M3U8_HF_UPLOAD        置 1/true/yes/on 启用上传到 Hugging Face datasets（默认关）
  M3U8_HF_REPO          HF dataset 仓库 ID（用户名/数据集名）
  M3U8_HF_PRIVATE       创建仓库时是否私有，1=私有(默认)/0=公开
  M3U8_HF_PATH          上传到数据集仓库内的子目录，留空=根路径
  M3U8_HF_TOKEN         Hugging Face 访问令牌（带工具前缀，避免多工具 token 混用）

退出码：0 = 全部成功/无需下载；1 = 存在失败项；2 = 缺少依赖/参数错误。
"""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import stat as statmod
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

try:
    from huggingface_hub import HfApi
except ImportError:
    HfApi = None

# 本工具目录：urls.txt / bin / 输出目录都相对它解析
TOOL_DIR = Path(__file__).resolve().parent

# N_m3u8DL-RE release 资产命名（分隔符：版本后是 _，平台与架构间是 -）：
#   N_m3u8DL-RE_v0.6.0-beta_linux-x64_20260629.tar.gz（版本可带 -beta 等后缀）
#   N_m3u8DL-RE_v0.6.0-beta_linux-arm64_20260629.tar.gz / N_m3u8DL-RE_..._osx-arm64_*.tar.gz
#   N_m3u8DL-RE_v0.6.0-beta_win-x64_20260629.zip / N_m3u8DL-RE_v0.6.0-beta_win-NT6.0-x86_*.zip
#   N_m3u8DL-RE_v0.6.0-beta_android-bionic-arm64_20260629.tar.gz
RELEASE_API = "https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases"
ASSET_RE = re.compile(
    r"^N_m3u8DL-RE_v(?P<ver>.+?)_(?P<plat>linux|osx|android|win)"
    r"[_-](?:bionic-)?(?P<arch>arm64|x64|x86|NT[\w.]*?-x86)_(?P<date>\d{8})\.(?P<ext>zip|tar\.gz)$",
    re.IGNORECASE,
)
# 进度行节流间隔（秒）。RE 的实时进度条带 ANSI 控制符无法行式解析，
# 这里控制「从日志文件轮询进度摘要」与「产物扫描」的节奏
PROGRESS_INTERVAL = 5.0


def log(msg: str) -> None:
    print(f"[m3u8] {msg}", flush=True)


def env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip()


def env_bool(name: str, default: bool = False) -> bool:
    """布尔型环境变量：1/true/yes/on 为真；0/false/no/off/空为假（空取默认值）。"""
    raw = env(name).lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def env_int(name: str, default: int) -> int:
    raw = env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        log(f"环境变量 {name}={raw!r} 不是整数，使用默认值 {default}")
        return default


# ---------------------------------------------------------------------------
# 平台与二进制获取
# ---------------------------------------------------------------------------

def detect_platform() -> tuple:
    """返回 (资产平台名, 资产架构名)，如 ('linux', 'x64')。"""
    sysname = platform.system().lower()
    machine = platform.machine().lower()
    if sysname in ("linux",) or "android" in sysname:
        plat = "linux"
    elif sysname in ("darwin", "macos"):
        plat = "osx"
    elif sysname in ("windows",):
        plat = "win"
    else:
        raise RuntimeError(f"不支持的操作系统: {sysname}")
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    return plat, arch


def _github_api(url: str) -> object:
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "gh-toolbox-m3u8",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _download(url: str, dst: Path) -> None:
    log(f"下载: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "gh-toolbox-m3u8"})
    with urllib.request.urlopen(req, timeout=300) as resp, open(dst, "wb") as fh:
        shutil.copyfileobj(resp, fh, length=1024 * 1024)


def resolve_binary() -> Path:
    """定位/下载 N_m3u8DL-RE 可执行文件，返回可执行路径。

    顺序：M3U8_BIN 环境变量 > PATH 中的 N_m3u8DL-RE > 工具目录 bin/ 下的缓存
    > 按 latest release 自动下载（linux/osx 用 tar.gz，win 用 zip）。
    """
    # 1. 显式指定
    explicit = env("M3U8_BIN")
    if explicit:
        p = Path(explicit).expanduser()
        if p.is_file():
            return p
        log(f"错误: M3U8_BIN 指向的文件不存在: {p}")
        raise SystemExit(2)
    # 2. PATH
    found = shutil.which("N_m3u8DL-RE") or shutil.which("N_m3u8DL-RE.exe")
    if found:
        log(f"使用 PATH 中的 N_m3u8DL-RE: {found}")
        return Path(found)
    # 3. 工具目录缓存（bin/ 已 gitignore）
    bin_dir = TOOL_DIR / "bin"
    plat, arch = detect_platform()
    exe_suffix = ".exe" if plat == "win" else ""
    if bin_dir.is_dir():
        for cand in sorted(bin_dir.glob(f"*{plat}*{arch}*")):
            if cand.name.endswith(exe_suffix) and cand.is_file():
                log(f"使用已缓存的 N_m3u8DL-RE: {cand}")
                return cand

    # 4. 自动下载
    version = env("M3U8_RE_VERSION", "latest")
    api_url = f"{RELEASE_API}/{ 'tags/' + version if version != 'latest' else 'latest' }"
    log(f"未找到 N_m3u8DL-RE，开始自动获取（{version}，{plat}-{arch}）…")
    try:
        release = _github_api(api_url)
    except Exception as exc:
        log(f"错误: 获取 N_m3u8DL-RE release 信息失败: {exc}")
        log("      请手动下载对应平台二进制放到 tools/m3u8/bin/ 或 PATH，"
            "或用 M3U8_BIN 指定路径（网络受限时可配 HTTPS_PROXY）")
        raise SystemExit(2)
    assets = [a for a in release.get("assets", []) if ASSET_RE.match(a.get("name", ""))]
    want = [a for a in assets
            if (m := ASSET_RE.match(a["name"]))
            and m.group("plat").lower() == plat and m.group("arch").lower() == arch]
    if not want:
        log("错误: release 资产里没有匹配当前平台的文件。可用资产：")
        for a in assets:
            log(f"      {a['name']}")
        raise SystemExit(2)
    # 取日期（文件名里内嵌的构建日期）最新的一个
    asset = max(want, key=lambda a: ASSET_RE.match(a["name"]).group("date"))
    bin_dir.mkdir(parents=True, exist_ok=True)
    archive = bin_dir / asset["name"]
    _download(asset["browser_download_url"], archive)
    log(f"已下载: {archive.name}（{archive.stat().st_size / 1048576:.1f} MB），解压中…")
    if archive.name.endswith(".zip"):
        shutil.unpack_archive(archive, bin_dir, format="zip")
    else:
        shutil.unpack_archive(archive, bin_dir, format="gztar")
    archive.unlink(missing_ok=True)
    # 解压后的可执行文件：找平台/架构匹配 + 可执行后缀
    exe = None
    for cand in sorted(bin_dir.rglob("*")):
        if not cand.is_file():
            continue
        m = ASSET_RE.match(cand.name)
        name_ok = cand.name == "N_m3u8DL-RE" + exe_suffix or (
            m and m.group("plat").lower() == plat and m.group("arch").lower() == arch)
        if name_ok and cand.name.endswith(exe_suffix):
            exe = cand
            break
    if exe is None:
        # 兜底：bin 目录里唯一的可执行文件
        cands = [c for c in bin_dir.rglob("*") if c.is_file() and c.name.endswith(exe_suffix)]
        if len(cands) == 1:
            exe = cands[0]
    if exe is None:
        log(f"错误: 解压后未在 {bin_dir} 找到可执行文件，请手动整理")
        raise SystemExit(2)
    if plat != "win":
        exe.chmod(exe.stat().st_mode | statmod.S_IXUSR | statmod.S_IXGRP | statmod.S_IXOTH)
    log(f"N_m3u8DL-RE 就绪: {exe}")
    return exe


# ---------------------------------------------------------------------------
# URL / 请求头解析
# ---------------------------------------------------------------------------

def parse_urls(raw: str) -> list:
    """解析 URL 清单：每行一个，非注释行支持逗号分隔；'#' 开头为注释行。

    注意：'#' 行整行跳过、不做逗号切分——注释里可能带逗号（如油猴脚本写入的
    视频标题），先按逗号切分会把注释切碎成假 URL。
    """
    urls = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        for part in line.split(","):
            part = part.strip()
            if part:
                urls.append(part)
    return urls


def load_urls() -> list:
    """URL 来源优先级：环境变量 M3U8_URLS > 工具目录 urls.txt。"""
    from_env = os.environ.get("M3U8_URLS", "")
    if from_env.strip():
        log("下载目标来源: 环境变量 M3U8_URLS")
        return parse_urls(from_env)

    urls_file = TOOL_DIR / "urls.txt"
    if urls_file.is_file():
        log(f"下载目标来源: {urls_file}")
        return parse_urls(urls_file.read_text(encoding="utf-8"))

    return []


# RFC 7230 合法的头部字段名（token）
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")


def parse_headers(raw: str) -> dict:
    """解析自定义请求头，返回 {名称: 值}。

    支持两种格式（自动识别）：
      1. JSON 对象：{"Referer": "https://example.com/", "User-Agent": "..."}
         （Actions 输入框是单行的，推荐用这个）
      2. 每行一个 'Name: Value'（curl -H 风格，# 开头为注释，空行忽略）
    格式错误抛 ValueError（头部名含非法字符也视为错误）。
    """
    raw = (raw or "").strip()
    if not raw:
        return {}
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise ValueError(f"JSON 解析失败: {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError('JSON 顶层必须是对象，如 {"Referer": "https://example.com/"}')
        headers = {str(k): str(v) for k, v in data.items()}
    else:
        headers = {}
        for lineno, line in enumerate(raw.splitlines(), 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" not in line:
                raise ValueError(f"第 {lineno} 行缺少冒号: {line!r}（格式为 Name: Value）")
            name, _, value = line.partition(":")
            headers[name.strip()] = value.strip()
    for name in headers:
        if not _HEADER_NAME_RE.match(name):
            raise ValueError(f"非法的头部名: {name!r}（只能含字母数字和 !#$%&'*+-.^_`|~）")
    return headers


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------

def human_size(num_bytes) -> str:
    """字节数格式化为人类可读大小。"""
    size = float(num_bytes or 0)
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


def sanitize_name(name: str) -> str:
    """URL 派生文件名：取路径有意义段 + 查询串指纹，去掉文件系统非法字符。"""
    base = re.sub(r"\.(m3u8|mpd|m3u)(\?.*)?$", "", name.split("?")[0], flags=re.IGNORECASE)
    segs = [s for s in base.split("/") if s and s not in ("http:", "https:")]
    stem = segs[-1] if segs else "video"
    stem = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", stem).strip("._") or "video"
    # 加查询串指纹：同一文件名不同清晰度/签名的 URL 可区分
    if "?" in name:
        import hashlib
        digest = hashlib.md5(name.split("?")[1].encode()).hexdigest()[:6]
        stem = f"{stem}-{digest}"
    return stem[:100]


def probe_container(path: Path) -> str | None:
    """用 ffprobe 探测文件的真实封装格式（format_name），失败/不可用返回 None。"""
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


def _sniff_ts(path: Path) -> bool:
    """无 ffprobe 时的内容兜底嗅探：MPEG-TS 每包 188 字节、包头固定 0x47。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(377)
    except OSError:
        return False
    return len(head) >= 377 and head[0] == 0x47 and head[188] == 0x47 and head[376] == 0x47


def _unique_path(p: Path) -> Path:
    """目标名已被占用时追加 -1/-2 后缀，避免覆盖已有文件。"""
    if not p.exists():
        return p
    for i in range(1, 1000):
        cand = p.with_name(f"{p.stem}-{i}{p.suffix}")
        if not cand.exists():
            return cand
    return p.with_name(f"{p.stem}-{os.getpid()}{p.suffix}")


# 最终产物常见后缀（目标存在性检查用，覆盖混流/未混流/真实封装修正后的各种情况）
_EXISTENCE_EXTS = ("mp4", "mkv", "ts", "webm", "mov", "m4a", "aac", "srt", "vtt")


def find_existing_target(out_dir: Path, stem: str) -> Path | None:
    """检查 out_dir 下 stem 同名的产物是否已存在（常见媒体后缀都查一遍）。"""
    for ext in _EXISTENCE_EXTS:
        cand = out_dir / f"{stem}.{ext}"
        if cand.is_file():
            return cand
    return None


# ---------------------------------------------------------------------------
# N_m3u8DL-RE 封装
# ---------------------------------------------------------------------------

class REDownloader:
    """N_m3u8DL-RE 命令行封装：拼参数、跑进程、按行转发日志并解析进度。"""

    # 进度行形如「 50.0% ████ 1.2MB/2.4MB 3.5MB/s 00:05 (ETA ...)」或含 V| 的多轨道行
    _PROGRESS_RE = re.compile(
        r"(?P<pct>\d{1,3}(?:\.\d+)?)%.*?(?P<done>\d+(?:\.\d+)?\s*[KMG]?B)?"
        r".*?(?P<total>/\s*\d+(?:\.\d+)?\s*[KMG]?B)?")

    def __init__(self, exe: Path, out_dir: Path, tmp_dir: Path):
        self.exe = exe
        self.out_dir = out_dir
        self.tmp_dir = tmp_dir
        self._last_report = 0.0
        self._current_url = ""

    def version(self) -> str:
        r = subprocess.run([str(self.exe), "--version"], capture_output=True, text=True, timeout=60)
        return (r.stdout or r.stderr).strip().splitlines()[0] if (r.stdout or r.stderr).strip() else "?"

    def _build_cmd(self, url: str, save_name: str, headers: dict, cookies: str,
                   log_file: Path) -> list:
        cmd = [
            str(self.exe), url,
            "--save-dir", str(self.out_dir),
            "--tmp-dir", str(self.tmp_dir),
            "--save-name", save_name,
            "--thread-count", str(env_int("M3U8_THREAD_COUNT", 16)),
            "--download-retry-count", str(env_int("M3U8_RETRIES", 7)),
            # 日志走日志文件（CI 重定向 stdout 时 RE 会用 ANSI 光标控制符刷进度条，
            # 行式解析不可行）；读取后转发到 stdout，任务结束删除
            "--log-file-path", str(log_file),
            "--no-ansi-color",
            "--ui-language", "zh-CN",
            "--sub-format", "SRT",
            "--del-after-done", "true",
            "--write-meta-json", "false",
        ]
        # 非交互选流：表达式优先，其次 auto-select
        select_video = env("M3U8_SELECT_VIDEO")
        if select_video:
            cmd += ["--select-video", select_video]
        elif env_bool("M3U8_AUTO_SELECT", True):
            cmd += ["--auto-select"]
        mux = env("M3U8_MUX_FORMAT", "mp4").lower()
        if mux in ("mp4", "mkv", "ts"):
            cmd += ["-M", f"format={mux}"]
        for name, value in headers.items():
            cmd += ["-H", f"{name}: {value}"]
        if cookies:
            cmd += ["--cookies", cookies]
        extra = env("M3U8_EXTRA_ARGS")
        if extra:
            cmd += extra.split()
        if env_bool("M3U8_VERBOSE"):
            cmd += ["--log-level", "DEBUG"]
        return cmd

    def run(self, url: str, save_name: str, headers: dict, cookies: str,
            overwrite: bool) -> tuple:
        """下载单个 URL。返回 (ok, produced_files)。

        produced_files 为产出/更新的 (路径, 大小) 列表（下载完成后扫描）。
        """
        self._current_url = url
        self._last_report = 0.0
        self._last_summary = None
        log_file = self.tmp_dir / f"{sanitize_name(url) or 'task'}.log"
        log_file.unlink(missing_ok=True)
        cmd = self._build_cmd(url, save_name, headers, cookies, log_file)
        log(f"执行: N_m3u8DL-RE <{url}>")
        log(f"参数: {' '.join(cmd[2:])}")
        # 覆盖模式：先清掉同名旧产物（含各扩展名），避免混流时 rename 冲突
        if overwrite:
            for ext in _EXISTENCE_EXTS:
                (self.out_dir / f"{save_name}.{ext}").unlink(missing_ok=True)
        t0 = time.time()
        # 实时进度从日志文件增量读取（RE 重定向 stdout 时进度条带 ANSI 控制符，
        # 无法按行解析；日志文件始终是干净行式文本）。轮询间隔即节流间隔。
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        poll = 0.0
        try:
            while proc.poll() is None:
                time.sleep(1.0)
                poll += 1.0
                if poll >= PROGRESS_INTERVAL and log_file.is_file():
                    poll = 0.0
                    self._report_progress_from_log(log_file)
        finally:
            proc.wait()
        # 收尾：把日志剩余内容（INFO 行）全部转发
        self._drain_log(log_file)
        log_file.unlink(missing_ok=True)
        elapsed = time.time() - t0
        if proc.returncode != 0:
            log(f"下载失败: {url} -> N_m3u8DL-RE 退出码 {proc.returncode}（耗时 {fmt_duration(elapsed)}）")
            return False, []
        files = self._collect_products(t0)
        total = sum(s for _, s in files)
        log(f"下载完成: {len(files)} 个文件，合计 {human_size(total)}，耗时 {fmt_duration(elapsed)}")
        for p, s in files:
            log(f"  {p}（{human_size(s)}）")
        return True, files

    # 日志行特征：HH:MM:SS.mmm LEVEL : message（进度行 LEVEL 为空且带百分比/进度条）
    _LOG_RE = re.compile(r"^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(INFO|WARN|ERROR|EXTRA|DEBUG)\s*:\s?(.*)$")
    # 进度行片段：xx% / 分片 n/m / 大小/速度（出现在无级别前缀的行里）
    _PROG_RE = re.compile(r"\d{1,3}(?:\.\d+)?%")

    def _report_progress_from_log(self, log_file: Path) -> None:
        """从日志文件取末尾若干行，把其中的下载状态输出一条（去重）。"""
        try:
            lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return
        summary = None
        for line in reversed(lines[-60:]):
            m = self._LOG_RE.match(line)
            if not m or m.group(2) != "INFO":
                continue
            msg = m.group(3)
            # 「开始下载...Vid 1920x1080 | 6221 Kbps | ...」是唯一带轨道上下文的下载中状态行
            if msg.startswith("开始下载"):
                summary = msg.replace("开始下载...", "下载中: ").replace("开始下载", "下载中: ")
                break
        if summary and summary != self._last_summary:
            self._last_summary = summary
            log(f"[进度] {summary}")

    def _drain_log(self, log_file: Path) -> None:
        """任务结束后把日志文件的全部 INFO/WARN/ERROR 行转发到 stdout。"""
        if not log_file.is_file():
            return
        try:
            lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return
        for line in lines:
            m = self._LOG_RE.match(line)
            if not m:
                if line.strip() and not line.startswith(("LOG ", "Save Path:", "Task ")):
                    print(f"[N_m3u8DL-RE] {line}", flush=True)
                continue
            level, msg = m.group(2), m.group(3)
            if level == "DEBUG" and not env_bool("M3U8_VERBOSE"):
                continue
            if self._PROG_RE.search(msg) and "Segments" not in msg and "Kbps" not in msg:
                continue  # 丢弃进度条行（实时阶段已按节流汇报）
            print(f"[N_m3u8DL-RE][{level}] {msg}", flush=True)

    def _collect_products(self, t0: float) -> list:
        """扫描本次任务产出/更新的文件（按 mtime 归属），返回 (路径, 大小) 列表。

        同时用 ffprobe 按真实封装修正后缀：N_m3u8DL-RE 混流产物按 -M 指定的
        容器命名，一般名实相符；但未混流（none）时轨道文件后缀也可能与内容
        不符（如 TS 内容叫 .mp4），与 ytdlp 工具同样兜底修正。
        """
        found = []
        for p in sorted(self.out_dir.rglob("*")):
            if not p.is_file():
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            if st.st_mtime < t0:
                continue
            found.append([p, st.st_size])
        fixed = []
        for p, size in found:
            fmt = probe_container(p)
            if not fmt and _sniff_ts(p):
                fmt = "mpegts"
            ext = p.suffix.lower()
            is_ts = fmt and "mpegts" in fmt
            is_mp4 = fmt and ("mov" in fmt or "mp4" in fmt)
            if is_ts and ext == ".mp4":
                dst = _unique_path(p.with_suffix(".ts"))
                p.rename(dst)
                log(f"探测到 TS 流但扩展名为 .mp4，已如实改名为: {dst.name}")
                fixed.append((dst, dst.stat().st_size))
            elif is_mp4 and ext == ".ts":
                dst = _unique_path(p.with_suffix(".mp4"))
                p.rename(dst)
                log(f"探测到 MP4 封装但扩展名为 .ts，已如实改名为: {dst.name}")
                fixed.append((dst, dst.stat().st_size))
            else:
                fixed.append((p, size))
        return fixed


# ---------------------------------------------------------------------------
# HF 上传
# ---------------------------------------------------------------------------

def upload_to_hf(folder: Path, repo_id: str, private: bool, path_in_repo: str = "") -> str:
    """把 folder 上传到 Hugging Face dataset 仓库，返回仓库页面 URL。

    path_in_repo 为仓库内的目标子目录，空 = 根路径。
    令牌取 M3U8_HF_TOKEN 环境变量（带工具前缀，避免多工具 token 混用），
    未设置时回退到本地 `hf auth login` 缓存。
    """
    if HfApi is None:
        raise RuntimeError("缺少依赖 huggingface_hub，请先执行: pip install -r tools/m3u8/requirements.txt")
    api = HfApi(token=env("M3U8_HF_TOKEN") or None)
    # 仓库已存在时 exist_ok 不报错，也不会改动已有仓库的可见性
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=private, exist_ok=True)
    path_in_repo = (path_in_repo or "").strip().strip("/")
    api.upload_folder(
        repo_id=repo_id,
        repo_type="dataset",
        folder_path=str(folder),
        path_in_repo=path_in_repo or None,
        commit_message="Upload from gh-toolbox m3u8",
    )
    return f"https://huggingface.co/datasets/{repo_id}"


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

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
        log("没有需要下载的 URL（在 urls.txt 填写，或通过 M3U8_URLS / Actions 输入提供）")
        return 0

    # 依赖前置检查
    mux = env("M3U8_MUX_FORMAT", "mp4").lower()
    if mux not in ("mp4", "mkv", "ts", "none"):
        log(f"错误: M3U8_MUX_FORMAT={mux!r} 无法识别（可选 mp4/mkv/ts/none）")
        return 2
    if mux != "none" and not shutil.which("ffmpeg"):
        log("错误: 选择了混流封装(-M)但未在 PATH 中检测到 ffmpeg")
        log("      N_m3u8DL-RE 的分片合并与混流都依赖 ffmpeg；GitHub Actions 由 workflow 自动保证，")
        log("      本地运行请先安装 ffmpeg 并加入 PATH（不想混流可设 M3U8_MUX_FORMAT=none）")
        return 2
    if not shutil.which("ffprobe") and not hasattr(main, "_probe_warned"):
        main._probe_warned = True
        log("提示: 未检测到 ffprobe，无法按真实封装修正后缀（不影响下载本身）")

    try:
        custom_headers = parse_headers(env("M3U8_HEADERS"))
    except ValueError as exc:
        log(f"错误: M3U8_HEADERS 格式不正确: {exc}")
        return 2
    if custom_headers:
        # 只打印头部名，值可能含 Cookie/Token 等敏感信息
        log(f"自定义请求头 {len(custom_headers)} 个: {', '.join(custom_headers)}")

    cookies = env("M3U8_COOKIES")
    if cookies and not Path(cookies).is_file():
        log(f"错误: M3U8_COOKIES 指向的文件不存在: {cookies}")
        return 2

    overwrite = env_bool("M3U8_OVERWRITE")
    if overwrite:
        log("模式: 覆盖目标文件（强制重新下载，覆盖已存在的文件）")
    else:
        log("模式: 不覆盖（目标文件已存在则跳过下载；需要重下请勾选 overwrite）")

    # 输出/临时目录：相对路径基于工具目录解析
    out_dir = Path(env("M3U8_OUTPUT_DIR", "downloads"))
    if not out_dir.is_absolute():
        out_dir = TOOL_DIR / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(env("M3U8_TMP_DIR", str(out_dir / ".tmp")))
    if not tmp_dir.is_absolute():
        tmp_dir = TOOL_DIR / tmp_dir
    tmp_dir.mkdir(parents=True, exist_ok=True)

    binary = resolve_binary()
    ver = REDownloader(binary, out_dir, tmp_dir).version()
    log(f"N_m3u8DL-RE 版本: {ver}")

    dl = REDownloader(binary, out_dir, tmp_dir)
    save_name_base = env("M3U8_SAVE_NAME")
    ok, skipped, failed = [], [], []
    all_files = []

    for idx, url in enumerate(urls, 1):
        # 命名：手动指定时多 URL 自动加序号；否则从 URL 派生（同名已存在则跳过）
        if save_name_base:
            save_name = save_name_base if len(urls) == 1 else f"{save_name_base}-{idx}"
        else:
            save_name = sanitize_name(url)

        # 跳过判据（与 ytdlp 语义一致）：目标文件已存在则不下载
        if not overwrite:
            existing = find_existing_target(out_dir, save_name)
            if existing:
                log(f"目标文件已存在，跳过: {existing.name}（{human_size(existing.stat().st_size)}）")
                skipped.append(url)
                continue

        log(f"[{idx}/{len(urls)}] 解析: {url}（保存名: {save_name}）")
        good, files = dl.run(url, save_name, custom_headers, cookies, overwrite)
        if good:
            ok.append(url)
            all_files.extend(files)
        else:
            failed.append(url)

    # ---- 全部下载完毕：可选上传到 Hugging Face datasets（默认关闭） ----
    upload_failed = False
    if env_bool("M3U8_HF_UPLOAD"):
        repo_id = env("M3U8_HF_REPO")
        hf_path = env("M3U8_HF_PATH")
        has_files = any(p.is_file() for p in out_dir.rglob("*") if not p.name.startswith("."))
        if not repo_id:
            log("启用了 HF 上传但未设置 M3U8_HF_REPO（格式：用户名/数据集名），跳过上传")
            upload_failed = True
        elif not has_files:
            log(f"输出目录 {out_dir} 没有文件，跳过 HF 上传")
        else:
            private = env_bool("M3U8_HF_PRIVATE", True)
            target = (hf_path.strip("/") + "/") if hf_path else "根路径"
            log(f"上传到 Hugging Face datasets: {repo_id}"
                f"（{'私有' if private else '公开'}仓库，目标路径 {target}）")
            try:
                repo_url = upload_to_hf(out_dir, repo_id, private, hf_path)
                log(f"上传完成: {repo_url}")
            except Exception as exc:
                log(f"上传到 Hugging Face 失败: {exc}")
                upload_failed = True

    log("=" * 48)
    log(f"任务结束: 成功 {len(ok)}，跳过 {len(skipped)}，失败 {len(failed)}")
    if all_files:
        log(f"共下载 {len(all_files)} 个文件，合计 {human_size(sum(s for _, s in all_files))}")
    for url in failed:
        log(f"  失败: {url}")
    return 1 if (failed or upload_failed) else 0


if __name__ == "__main__":
    sys.exit(main())
