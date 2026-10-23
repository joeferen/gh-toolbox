#!/usr/bin/env python3
"""aria2 批量下载脚本（gh-toolbox 的 aria2 工具，由 GitHub Actions 调用，也可本地运行）。

控制 [aria2](https://github.com/aria2/aria2)（aria2c）多连接加速下载直链文件，
功能对齐 m3u8 工具：URL 清单 → 下载 → 可选上传 HF datasets。与 m3u8 的分工：
yt-dlp 胜在站点解析广、N_m3u8DL-RE 胜在流处理专业（多轨道/解密/直播录制），
aria2 胜在纯直链的多连接吞吐（服务器单连接限速时尤其有效）。

注意：aria2 不解析网页、不会合并 HLS/DASH 分片——下载目标应为**直链文件**
（mp4/mkv/ts/zip 等完整 URL）。给 .m3u8/.mpd 只会下到播放列表文本本身；
需要 HLS/DASH 流处理请用 m3u8 / ytdlp 工具（或支持 HLS 的 aria2-next 分支）。

本脚本自包含：urls.txt、downloads/ 输出目录均相对脚本所在目录解析，可从任意
工作目录运行。aria2 本体不走 pip：PATH 中没有时按 latest release 自动下载
静态编译版二进制到工具目录 bin/（gitignore），已存在则直接复用。

工作方式：
  1. 读取下载目标：环境变量 ARIA2_URLS 优先，其次本工具目录下的 urls.txt，
     也支持命令行直接传 URL（python tools/aria2/download.py <url> ...）
  2. 逐个 URL 调用 aria2c（多连接分片并发），产物落在 downloads/；
     实时进度按 5 秒节流输出（aria2 summary-interval 轮询）
  3. 跳过判据只看目标文件是否存在（save-name 派生名 + 常见后缀），
     与 ytdlp / m3u8 工具的 overwrite 语义一致
  4. 可选：全部下载完成后上传到 Hugging Face datasets（默认关闭）

环境变量：
  ARIA2_URLS            下载目标，换行或逗号分隔（优先于 urls.txt）
  ARIA2_BIN             aria2c 可执行文件路径（默认自动定位/下载到 bin/）
  ARIA2_VERSION         要使用的静态编译 release 版本 tag（默认 latest）
  ARIA2_OUTPUT_DIR      输出目录（默认 downloads）
  ARIA2_SAVE_NAME       输出文件名（不含扩展名）；多个 URL 时会自动加序号
                        （video.mp4 / video-2.mp4），避免互相覆盖
  ARIA2_OVERWRITE       覆盖目标文件（默认关）：置 1/true/yes/on 强制重新下载
                        并删除已存在的同名文件；不置时目标文件已存在则跳过
  ARIA2_CONNECTIONS     单服务器最大连接数 -x（默认 16，aria2 上限 16）
  ARIA2_SPLIT           单文件分片数 -s（默认 16）
  ARIA2_MIN_SPLIT_SIZE  分片最小尺寸 -k（默认 1M；调大可减少小文件碎片请求）
  ARIA2_MAX_TRIES       每连接重试次数（默认 5）
  ARIA2_RETRY_WAIT      重试间隔秒数（默认 5）
  ARIA2_COOKIES         Netscape 格式 cookies 文件路径（--load-cookies，可选）
  ARIA2_HEADERS         自定义请求头：JSON 对象 {"Referer":"https://..."}
                        （推荐，Actions 单行输入框可用）或每行 Name: Value；
                        格式错误退出码 2。注意 aria2 不允许 --header 设置
                        Cookie，需要登录态请用 ARIA2_COOKIES
  ARIA2_EXTRA_ARGS      aria2c 附加命令行参数（空格分隔，原样透传，
                        如 --all-proxy http://... --checksum sha-256=...）
  ARIA2_VERBOSE         置 1 输出 aria2c DEBUG 日志
  ARIA2_HF_UPLOAD       置 1/true/yes/on 启用上传到 Hugging Face datasets（默认关）
  ARIA2_HF_REPO         HF dataset 仓库 ID（用户名/数据集名）
  ARIA2_HF_PRIVATE      创建仓库时是否私有，1=私有(默认)/0=公开
  ARIA2_HF_PATH         上传到数据集仓库内的子目录，留空=根路径
  ARIA2_HF_TOKEN        Hugging Face 访问令牌（带工具前缀，避免多工具 token 混用）

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

# aria2 静态编译版 release 资产命名（abcfy2/aria2-static-build）：
#   aria2-x86_64-linux-musl_static.zip / aria2-aarch64-linux-musl_static.zip
#   aria2-i686-w64-mingw32_static.zip / aria2-x86_64-w64-mingw32_static.zip
RELEASE_API = "https://api.github.com/repos/abcfy2/aria2-static-build/releases"
ASSET_RE = re.compile(
    r"^aria2-(?P<arch>x86_64|aarch64|i686|armv7|armhf|arm|loongarch64|riscv64|s390x|powerpc64le)"
    r"-(?P<plat>linux)-musl[a-z]*_static\.zip$|"
    r"^aria2-(?P<winarch>x86_64|i686)-w64-mingw32_static\.zip$",
    re.IGNORECASE,
)
# 实时进度行节流间隔（秒）。aria2 的 summary 每隔 summary-interval 刷一行，
# 这里控制「转发进度行」的节奏
PROGRESS_INTERVAL = 5.0


def log(msg: str) -> None:
    print(f"[aria2] {msg}", flush=True)


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


def env_int(name: str, default: int, maximum: int | None = None) -> int:
    raw = env(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        log(f"环境变量 {name}={raw!r} 不是整数，使用默认值 {default}")
        return default
    if maximum is not None:
        value = max(1, min(value, maximum))
    return value


# ---------------------------------------------------------------------------
# 平台与二进制获取
# ---------------------------------------------------------------------------

def detect_asset() -> tuple:
    """返回静态编译包的 (平台片段, 架构片段)，如 ('linux', 'x86_64')。"""
    sysname = platform.system().lower()
    machine = platform.machine().lower()
    if sysname in ("linux",) or "android" in sysname:
        plat = "linux"
        arch = {"x86_64": "x86_64", "amd64": "x86_64",
                "arm64": "aarch64", "aarch64": "aarch64"}.get(machine)
    elif sysname in ("windows",):
        plat = "win"
        arch = "x86_64"
    else:
        raise RuntimeError(f"不支持的操作系统: {sysname}（静态编译版只发 linux/win，"
                           f"macOS 请 brew install aria2 后加入 PATH，或用 ARIA2_BIN 指定）")
    if not arch:
        raise RuntimeError(f"不支持的架构: {machine}")
    return plat, arch


def _github_api(url: str) -> object:
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "gh-toolbox-aria2",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _download(url: str, dst: Path) -> None:
    log(f"下载: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "gh-toolbox-aria2"})
    with urllib.request.urlopen(req, timeout=300) as resp, open(dst, "wb") as fh:
        shutil.copyfileobj(resp, fh, length=1024 * 1024)


def resolve_binary() -> Path:
    """定位/下载 aria2c 可执行文件，返回可执行路径。

    顺序：ARIA2_BIN 环境变量 > PATH 中的 aria2c > 工具目录 bin/ 下的缓存
    > 按 latest release 自动下载静态编译版（linux/win）。
    """
    # 1. 显式指定
    explicit = env("ARIA2_BIN")
    if explicit:
        p = Path(explicit).expanduser()
        if p.is_file():
            return p
        log(f"错误: ARIA2_BIN 指向的文件不存在: {p}")
        raise SystemExit(2)
    # 2. PATH
    found = shutil.which("aria2c") or shutil.which("aria2c.exe")
    if found:
        log(f"使用 PATH 中的 aria2c: {found}")
        return Path(found)
    # 3. 工具目录缓存（bin/ 已 gitignore）
    bin_dir = TOOL_DIR / "bin"
    if bin_dir.is_dir():
        for cand in sorted(bin_dir.rglob("aria2c*")):
            if cand.is_file() and os.access(cand, os.X_OK):
                log(f"使用已缓存的 aria2c: {cand}")
                return cand

    # 4. 自动下载静态编译版
    version = env("ARIA2_VERSION", "latest")
    api_url = f"{RELEASE_API}/{ 'tags/' + version if version != 'latest' else 'latest' }"
    plat, arch = detect_asset()
    log(f"未找到 aria2c，开始自动获取（{version}，{plat}-{arch} 静态编译版）…")
    try:
        release = _github_api(api_url)
    except Exception as exc:
        log(f"错误: 获取 aria2 静态编译 release 信息失败: {exc}")
        log("      请手动安装 aria2 加入 PATH，或用 ARIA2_BIN 指定已有二进制"
            "（网络受限时可配 HTTPS_PROXY）")
        raise SystemExit(2)
    want = []
    for a in release.get("assets", []):
        m = ASSET_RE.match(a.get("name", ""))
        if not m:
            continue
        if plat == "linux":
            if m.group("plat") == "linux" and m.group("arch") == arch:
                want.append(a)
        elif m.group("winarch") == arch:
            want.append(a)
    if not want:
        log("错误: release 资产里没有匹配当前平台的文件。可用资产：")
        for a in release.get("assets", []):
            log(f"      {a['name']}")
        raise SystemExit(2)
    asset = want[0]
    bin_dir.mkdir(parents=True, exist_ok=True)
    archive = bin_dir / asset["name"]
    _download(asset["browser_download_url"], archive)
    log(f"已下载: {archive.name}（{archive.stat().st_size / 1048576:.1f} MB），解压中…")
    shutil.unpack_archive(archive, bin_dir, format="zip")
    archive.unlink(missing_ok=True)
    # 解压后的可执行文件：找 aria2c（linux 包内可能带 .3 手册等，只认可执行位文件）
    exe = None
    for cand in sorted(bin_dir.rglob("aria2c*")):
        if cand.is_file() and os.access(cand, os.X_OK):
            exe = cand
            break
    if exe is None:
        # 兜底：解压包里唯一的无后缀文件
        cands = [c for c in bin_dir.rglob("*")
                 if c.is_file() and c.suffix == "" and os.access(c, os.X_OK)]
        if len(cands) == 1:
            exe = cands[0]
    if exe is None:
        log(f"错误: 解压后未在 {bin_dir} 找到 aria2c 可执行文件，请手动整理")
        raise SystemExit(2)
    exe.chmod(exe.stat().st_mode | statmod.S_IXUSR | statmod.S_IXGRP | statmod.S_IXOTH)
    log(f"aria2c 就绪: {exe}")
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
    """URL 来源优先级：环境变量 ARIA2_URLS > 工具目录 urls.txt。"""
    from_env = os.environ.get("ARIA2_URLS", "")
    if from_env.strip():
        log("下载目标来源: 环境变量 ARIA2_URLS")
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
    # aria2 拒绝用 --header 设置 Cookie（--header cookie 选项不存在会直接报错退出），
    # 提前拦截并指路 ARIA2_COOKIES，避免跑到一半才失败
    for name in headers:
        if name.lower() == "cookie":
            raise ValueError(
                'aria2 不允许通过 --header 设置 "Cookie" 头，'
                "请改用 Netscape 格式 cookies 文件（本地: ARIA2_COOKIES 环境变量；"
                "Actions: 配 Secret ARIA2_COOKIES）")
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
    stem = segs[-1] if segs else "download"
    stem = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", stem).strip("._") or "download"
    # 加查询串指纹：同一文件名不同签名/时效的 URL 可区分
    if "?" in name:
        import hashlib
        digest = hashlib.md5(name.split("?")[1].encode()).hexdigest()[:6]
        stem = f"{stem}-{digest}"
    return stem[:100]


# 最终产物常见后缀（目标存在性检查用）
_EXISTENCE_EXTS = ("mp4", "mkv", "ts", "webm", "mov", "m4a", "aac", "flac",
                   "mp3", "zip", "7z", "apk", "exe", "iso", "pdf", "srt", "vtt")


def find_existing_target(out_dir: Path, stem: str) -> Path | None:
    """检查 out_dir 下 stem 同名的产物是否已存在。

    save_name 可能本身含扩展名（URL 派生名保留原后缀），也可能不含
    （手动指定），两种情况都查：先查完整名，再查 stem + 常见后缀。
    """
    exact = out_dir / stem
    if exact.is_file():
        return exact
    for ext in _EXISTENCE_EXTS:
        cand = out_dir / f"{stem}.{ext}"
        if cand.is_file():
            return cand
    return None


# ---------------------------------------------------------------------------
# aria2c 封装
# ---------------------------------------------------------------------------

class Aria2Downloader:
    """aria2c 命令行封装：拼参数、跑进程、按行转发日志并按节流汇报进度。"""

    # 进度/摘要行形如「[#8f2a01 12MiB/100MiB(12%) CN:16 DL:5.0MiB ETA:18s]」
    _PROGRESS_RE = re.compile(r"\[#\w+ .*\d+(?:\.\d+)?%")

    def __init__(self, exe: Path, out_dir: Path):
        self.exe = exe
        self.out_dir = out_dir

    def version(self) -> str:
        r = subprocess.run([str(self.exe), "--version"], capture_output=True, text=True, timeout=60)
        return (r.stdout or r.stderr).strip().splitlines()[0] if (r.stdout or r.stderr).strip() else "?"

    def _build_cmd(self, url: str, save_name: str, headers: dict, cookies: str) -> list:
        connections = env_int("ARIA2_CONNECTIONS", 16, maximum=16)  # aria2 协议上限 16
        split = env_int("ARIA2_SPLIT", 16)
        cmd = [
            str(self.exe), url,
            "--dir", str(self.out_dir),
            "-o", save_name,
            "--max-connection-per-server", str(connections),
            "--split", str(split),
            "--min-split-size", env("ARIA2_MIN_SPLIT_SIZE", "1M"),
            "--max-tries", str(env_int("ARIA2_MAX_TRIES", 5)),
            "--retry-wait", str(env_int("ARIA2_RETRY_WAIT", 5)),
            "--timeout", "60",
            "--connect-timeout", "30",
            "--max-file-not-found", "5",
            "--file-allocation", "none",
            # 非 tty 下靠 summary-interval 定期输出进度摘要行（默认 60s 太久）
            "--summary-interval", "5",
            "--console-log-level", "notice",
            # 命名冲突不自动改名：跳过/覆盖语义由脚本控制。注意 aria2 的
            # 布尔选项不支持空格传值（`--auto-file-renaming false` 会把
            # false 当成第二个 URI 报错），必须用 = 形式；--continue 单独给即 true
            "--auto-file-renaming=false",
            "--continue",
        ]
        for name, value in headers.items():
            cmd += ["--header", f"{name}: {value}"]
        if cookies:
            cmd += ["--load-cookies", cookies]
        extra = env("ARIA2_EXTRA_ARGS")
        if extra:
            cmd += extra.split()
        if env_bool("ARIA2_VERBOSE"):
            cmd += ["--log-level", "debug"]
        return cmd

    def run(self, url: str, save_name: str, headers: dict, cookies: str,
            overwrite: bool) -> tuple:
        """下载单个 URL。返回 (ok, produced_files)。

        produced_files 为产出/更新的 (路径, 大小) 列表（下载完成后扫描）。
        """
        cmd = self._build_cmd(url, save_name, headers, cookies)
        log(f"执行: aria2c <{url}>")
        log(f"参数: {' '.join(cmd[2:])}")
        # 覆盖模式：先清掉同名旧产物（完整名 + 各扩展名）与 .aria2 控制文件，
        # 避免 --continue 接着旧断点或 rename 冲突
        if overwrite:
            (self.out_dir / save_name).unlink(missing_ok=True)
            for ext in _EXISTENCE_EXTS:
                (self.out_dir / f"{save_name}.{ext}").unlink(missing_ok=True)
            (self.out_dir / f"{save_name}.aria2").unlink(missing_ok=True)
        t0 = time.time()
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
        # 实时转发日志：进度摘要行按 5 秒节流，其余行原样透传
        last_report = 0.0
        for raw in proc.stdout:
            line = raw.rstrip("\r\n")
            if not line.strip():
                continue
            now = time.time()
            if self._PROGRESS_RE.search(line):
                if now - last_report >= PROGRESS_INTERVAL:
                    last_report = now
                    log(f"[进度] {line.strip()}")
            else:
                print(f"[aria2c] {line}", flush=True)
        proc.wait()
        elapsed = time.time() - t0
        if proc.returncode != 0:
            log(f"下载失败: {url} -> aria2c 退出码 {proc.returncode}（耗时 {fmt_duration(elapsed)}）")
            return False, []
        files = self._collect_products(t0)
        total = sum(s for _, s in files)
        log(f"下载完成: {len(files)} 个文件，合计 {human_size(total)}，耗时 {fmt_duration(elapsed)}")
        for p, s in files:
            log(f"  {p}（{human_size(s)}）")
        return True, files

    def _collect_products(self, t0: float) -> list:
        """扫描本次任务产出/更新的文件（按 mtime 归属），返回 (路径, 大小) 列表。"""
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
            found.append((p, st.st_size))
        return found


# ---------------------------------------------------------------------------
# HF 上传
# ---------------------------------------------------------------------------

def upload_to_hf(folder: Path, repo_id: str, private: bool, path_in_repo: str = "") -> str:
    """把 folder 上传到 Hugging Face dataset 仓库，返回仓库页面 URL。

    path_in_repo 为仓库内的目标子目录，空 = 根路径。
    令牌取 ARIA2_HF_TOKEN 环境变量（带工具前缀，避免多工具 token 混用），
    未设置时回退到本地 `hf auth login` 缓存。
    """
    if HfApi is None:
        raise RuntimeError("缺少依赖 huggingface_hub，请先执行: pip install -r tools/aria2/requirements.txt")
    api = HfApi(token=env("ARIA2_HF_TOKEN") or None)
    # 仓库已存在时 exist_ok 不报错，也不会改动已有仓库的可见性
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=private, exist_ok=True)
    path_in_repo = (path_in_repo or "").strip().strip("/")
    api.upload_folder(
        repo_id=repo_id,
        repo_type="dataset",
        folder_path=str(folder),
        path_in_repo=path_in_repo or None,
        commit_message="Upload from gh-toolbox aria2",
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
        log("没有需要下载的 URL（在 urls.txt 填写，或通过 ARIA2_URLS / Actions 输入提供）")
        return 0

    try:
        custom_headers = parse_headers(env("ARIA2_HEADERS"))
    except ValueError as exc:
        log(f"错误: ARIA2_HEADERS 格式不正确: {exc}")
        return 2
    if custom_headers:
        # 只打印头部名，值可能含 Cookie/Token 等敏感信息
        log(f"自定义请求头 {len(custom_headers)} 个: {', '.join(custom_headers)}")

    cookies = env("ARIA2_COOKIES")
    if cookies and not Path(cookies).is_file():
        log(f"错误: ARIA2_COOKIES 指向的文件不存在: {cookies}")
        return 2

    overwrite = env_bool("ARIA2_OVERWRITE")
    if overwrite:
        log("模式: 覆盖目标文件（强制重新下载，覆盖已存在的文件）")
    else:
        log("模式: 不覆盖（目标文件已存在则跳过下载；需要重下请勾选 overwrite）")

    # 输出目录：相对路径基于工具目录解析
    out_dir = Path(env("ARIA2_OUTPUT_DIR", "downloads"))
    if not out_dir.is_absolute():
        out_dir = TOOL_DIR / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    binary = resolve_binary()
    ver = Aria2Downloader(binary, out_dir).version()
    log(f"aria2 版本: {ver}")

    dl = Aria2Downloader(binary, out_dir)
    save_name_base = env("ARIA2_SAVE_NAME")
    ok, skipped, failed = [], [], []
    all_files = []

    for idx, url in enumerate(urls, 1):
        # 命名：手动指定时多 URL 自动加序号；否则从 URL 派生（同名已存在则跳过）
        if save_name_base:
            save_name = save_name_base if len(urls) == 1 else f"{save_name_base}-{idx}"
        else:
            save_name = sanitize_name(url)

        # 跳过判据（与 ytdlp / m3u8 语义一致）：目标文件已存在则不下载；
        # 例外：存在 .aria2 断点控制文件 = 上次未下载完，重跑续传
        if not overwrite:
            existing = find_existing_target(out_dir, save_name)
            control = out_dir / f"{save_name}.aria2"
            if control.is_file() and existing:
                log(f"检测到未完成的下载（{control.name}），续传: {existing.name}")
            elif existing:
                log(f"目标文件已存在，跳过: {existing.name}（{human_size(existing.stat().st_size)}）")
                skipped.append(url)
                continue

        log(f"[{idx}/{len(urls)}] 下载: {url}（保存名: {save_name}）")
        good, files = dl.run(url, save_name, custom_headers, cookies, overwrite)
        if good:
            ok.append(url)
            all_files.extend(files)
        else:
            failed.append(url)

    # ---- 全部下载完毕：可选上传到 Hugging Face datasets（默认关闭） ----
    upload_failed = False
    if env_bool("ARIA2_HF_UPLOAD"):
        repo_id = env("ARIA2_HF_REPO")
        hf_path = env("ARIA2_HF_PATH")
        has_files = any(p.is_file() for p in out_dir.rglob("*") if not p.name.startswith("."))
        if not repo_id:
            log("启用了 HF 上传但未设置 ARIA2_HF_REPO（格式：用户名/数据集名），跳过上传")
            upload_failed = True
        elif not has_files:
            log(f"输出目录 {out_dir} 没有文件，跳过 HF 上传")
        else:
            private = env_bool("ARIA2_HF_PRIVATE", True)
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
