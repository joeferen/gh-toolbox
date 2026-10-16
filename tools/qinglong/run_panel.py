#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在 GitHub Actions runner 上托管青龙面板，并通过 Cloudflare Tunnel 暴露控制端口。

流程：docker 拉取并启动青龙（默认 5700）-> 等待面板就绪 -> 启动 cloudflared
（quick 免密临时隧道 / token 命名隧道）-> 解析并展示公网访问地址 -> 保活到
RUN_MINUTES 或任务被取消 -> 清理容器与 cloudflared 进程。

本地运行（任意有 docker 的 Linux/macOS，Windows 需本机已装 cloudflared）：

    python tools/qinglong/run_panel.py                    # quick 隧道，保活 360 分钟
    CF_MODE=token CF_TUNNEL_TOKEN=eyJ... python tools/qinglong/run_panel.py
    CF_MODE=none RUN_MINUTES=5 python tools/qinglong/run_panel.py   # 只起面板不起隧道

环境变量：
    QL_IMAGE              青龙镜像，默认 whyyour/qinglong:latest
    QL_CONTAINER          容器名，默认 ql-toolbox
    QL_PORT               面板端口（宿主与容器一致），默认 5700
    QL_DATA_DIR           数据目录（挂载到容器 /ql/data），默认 <脚本目录>/data
    QL_TZ                 容器时区，默认 Asia/Shanghai
    QL_STARTUP_TIMEOUT    等待面板就绪的秒数，默认 300
    RUN_MINUTES           保活分钟数，0 = 直到任务被取消/超时，默认 360
    CF_MODE               quick | token | none，默认 quick
    CF_TUNNEL_TOKEN       CF_MODE=token 时必填（Cloudflare 隧道 Token）
    CLOUDFLARED_VERSION  cloudflared 版本，默认 latest（可固定如 2026.10.1）
    CLOUDFLARED_DIR       cloudflared 安装目录，默认 <脚本目录>/bin
"""

from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

# ---------------------------------------------------------------- 配置（环境变量）


def _env_str(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        log(f"[warn] {name}={raw!r} 不是整数，使用默认值 {default}")
        return default


QL_IMAGE = _env_str("QL_IMAGE", "whyour/qinglong:latest")
QL_CONTAINER = _env_str("QL_CONTAINER", "ql-toolbox")
QL_PORT = _env_int("QL_PORT", 5700)
QL_DATA_DIR = Path(_env_str("QL_DATA_DIR", str(SCRIPT_DIR / "data"))).resolve()
QL_TZ = _env_str("QL_TZ", "Asia/Shanghai")
QL_STARTUP_TIMEOUT = _env_int("QL_STARTUP_TIMEOUT", 300)
RUN_MINUTES = _env_int("RUN_MINUTES", 360)

CF_MODE = _env_str("CF_MODE", "quick").lower()  # quick | token | none
CF_TUNNEL_TOKEN = (os.environ.get("CF_TUNNEL_TOKEN") or "").strip()
CLOUDFLARED_VERSION = _env_str("CLOUDFLARED_VERSION", "latest")
CLOUDFLARED_DIR = Path(_env_str("CLOUDFLARED_DIR", str(SCRIPT_DIR / "bin"))).resolve()

LOCAL_URL = f"http://127.0.0.1:{QL_PORT}"
STOP = threading.Event()

# cloudflared 会把 quick tunnel 的域名写进 INF 日志横幅，例如：
#   ... INF |  https://foo-bar-1234.trycloudflare.com  |
TRYCLOUDFLARE_RE = re.compile(r"https://[A-Za-z0-9-]+\.trycloudflare\.com")


# ---------------------------------------------------------------- 基础工具


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def docker(*args: str, check: bool = True, timeout: int | None = None) -> subprocess.CompletedProcess:
    log(f"$ docker {' '.join(args)}")
    return subprocess.run(
        ["docker", *args],
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )


def _http_probe(url: str, timeout: int) -> tuple[bool, str]:
    """请求一次 URL；返回 (是否可达, 描述)。有 HTTP 响应（含 3xx/4xx/5xx）即算可达。"""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return True, f"HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        return True, f"HTTP {e.code}"
    except Exception as e:  # 连接拒绝 / 超时 / DNS 等
        return False, str(e)


# ---------------------------------------------------------------- 青龙面板


class Panel:
    """docker 托管的青龙面板（数据落在 QL_DATA_DIR，容器可随时重建）。"""

    def __init__(self) -> None:
        self.container_id = ""

    def start(self) -> None:
        if shutil.which("docker") is None:
            raise RuntimeError("未找到 docker，请在安装并启动 Docker 的环境中运行")
        QL_DATA_DIR.mkdir(parents=True, exist_ok=True)
        log(f"拉取镜像 {QL_IMAGE}（首次可能需要几分钟）")
        docker("pull", QL_IMAGE, timeout=1800)
        docker("rm", "-f", QL_CONTAINER, check=False, timeout=60)
        log(f"启动容器 {QL_CONTAINER}：{QL_PORT} -> 容器 5700，数据目录 {QL_DATA_DIR}")
        proc = docker(
            "run", "-d",
            "--name", QL_CONTAINER,
            "-p", f"{QL_PORT}:5700",
            "-v", f"{QL_DATA_DIR}:/ql/data",
            "-e", f"TZ={QL_TZ}",
            QL_IMAGE,
        )
        self.container_id = (proc.stdout or "").strip().splitlines()[-1] if (proc.stdout or "").strip() else ""
        self._wait_ready()

    def _wait_ready(self) -> None:
        deadline = time.monotonic() + QL_STARTUP_TIMEOUT
        log(f"等待面板就绪（最多 {QL_STARTUP_TIMEOUT}s，首次初始化较慢）...")
        last_err = ""
        while time.monotonic() < deadline and not STOP.is_set():
            if not self.running():
                raise RuntimeError(
                    f"容器 {QL_CONTAINER} 已退出，请查看 docker logs {QL_CONTAINER}"
                )
            ok, desc = _http_probe(LOCAL_URL + "/", timeout=5)
            if ok:
                log(f"面板就绪：{LOCAL_URL}（{desc}）")
                return
            last_err = desc
            time.sleep(3)
        if STOP.is_set():
            return
        raise RuntimeError(f"等待面板就绪超时（{QL_STARTUP_TIMEOUT}s）：{last_err}")

    def running(self) -> bool:
        proc = docker("inspect", "-f", "{{.State.Running}}", QL_CONTAINER, check=False, timeout=30)
        return proc.returncode == 0 and (proc.stdout or "").strip() == "true"

    def stop(self) -> None:
        log(f"停止并删除容器 {QL_CONTAINER}")
        docker("rm", "-f", QL_CONTAINER, check=False, timeout=120)


# ---------------------------------------------------------------- cloudflared


def cloudflared_bin() -> Path:
    """返回 cloudflared 可执行文件：优先 PATH，否则下载到 CLOUDFLARED_DIR。"""
    found = shutil.which("cloudflared")
    if found:
        return Path(found)
    if os.name == "nt":
        asset = "cloudflared-windows-amd64.exe"
    elif sys.platform == "darwin":
        asset = "cloudflared-darwin-amd64"
    else:
        asset = "cloudflared-linux-amd64"
    exe = CLOUDFLARED_DIR / ("cloudflared.exe" if os.name == "nt" else "cloudflared")
    if not exe.exists():
        CLOUDFLARED_DIR.mkdir(parents=True, exist_ok=True)
        base = "https://github.com/cloudflare/cloudflared/releases/"
        url = base + (f"latest/download/{asset}" if CLOUDFLARED_VERSION == "latest"
                      else f"download/{CLOUDFLARED_VERSION}/{asset}")
        log(f"下载 cloudflared：{url}")
        tmp = exe.with_suffix(exe.suffix + ".tmp")
        with urllib.request.urlopen(url, timeout=180) as resp, open(tmp, "wb") as f:
            shutil.copyfileobj(resp, f)
        tmp.replace(exe)
        if os.name != "nt":
            exe.chmod(0o755)
    return exe


class Tunnel:
    """cloudflared 隧道进程：quick（免密临时域名）或 token（命名隧道）。"""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.url: str | None = None
        self.log_path = SCRIPT_DIR / "cloudflared.log"
        self._logfile = None

    def start(self) -> str | None:
        exe = cloudflared_bin()
        self._logfile = open(self.log_path, "w", encoding="utf-8", errors="replace")
        # --no-autoupdate 是全局参数，放在子命令前；token 不透传进命令行日志
        if CF_MODE == "token":
            if not CF_TUNNEL_TOKEN:
                raise RuntimeError("CF_MODE=token 需要设置 CF_TUNNEL_TOKEN（Cloudflare 隧道 Token）")
            args = [str(exe), "--no-autoupdate", "tunnel", "run", "--token", CF_TUNNEL_TOKEN]
        else:
            args = [str(exe), "--no-autoupdate", "tunnel", "--url", LOCAL_URL]
        shown = " ".join("***" if a == CF_TUNNEL_TOKEN else a for a in args)
        log(f"启动 cloudflared：{shown}")
        self.proc = subprocess.Popen(args, stdout=self._logfile, stderr=subprocess.STDOUT,
                                     start_new_session=True)
        if CF_MODE == "token":
            log("命名隧道已启动，公网域名由 Cloudflare 控制台配置决定"
                f"（该隧道的 ingress 服务地址需为 http://127.0.0.1:{QL_PORT}）")
            return None
        self.url = self._wait_url(timeout=120)
        log(f"隧道就绪：{self.url} -> {LOCAL_URL}")
        self._verify(self.url)
        return self.url

    def _wait_url(self, timeout: int) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not STOP.is_set():
            if self.proc and self.proc.poll() is not None:
                raise RuntimeError(
                    f"cloudflared 提前退出（code={self.proc.returncode}），详见 {self.log_path}")
            try:
                text = self.log_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                text = ""
            m = TRYCLOUDFLARE_RE.search(text)
            if m:
                return m.group(0)
            time.sleep(1)
        raise RuntimeError(
            f"{timeout}s 内未从 cloudflared 日志解析到 trycloudflare.com 地址，详见 {self.log_path}")

    def _verify(self, url: str, attempts: int = 6) -> None:
        """公网侧冒烟验证（best-effort，失败只告警不中断服务）。"""
        for i in range(1, attempts + 1):
            if STOP.is_set():
                return
            ok, desc = _http_probe(url + "/", timeout=15)
            if ok:
                log(f"公网访问验证通过：{url}/ -> {desc}")
                return
            log(f"公网访问验证第 {i}/{attempts} 次失败：{desc}")
            time.sleep(5)
        log("[warn] 公网访问验证未通过，隧道可能仍在生效，请手动打开上面的地址确认")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            log("停止 cloudflared")
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self._logfile:
            self._logfile.close()


# ---------------------------------------------------------------- 主流程


def _handle_signal(signum, frame) -> None:
    log(f"收到信号 {signum}，准备清理退出")
    STOP.set()


def _fmt_until(minutes: int) -> str:
    if minutes <= 0:
        return "不限时（直到任务被取消或达到 runner 上限）"
    until = datetime.now() + timedelta(minutes=minutes)
    return until.strftime("%Y-%m-%d %H:%M:%S") + f"（约 {minutes} 分钟）"


def _write_summary(url: str | None) -> None:
    """把访问地址写进 GitHub Step Summary（本地运行为空操作）。"""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    lines = [
        "## 青龙面板已启动",
        "",
        f"- 本地地址：{LOCAL_URL}",
    ]
    if url:
        lines.append(f"- 公网地址（CF Tunnel）：{url}")
    elif CF_MODE == "token":
        lines.append("- 公网地址：使用 Cloudflare 控制台为该隧道配置的域名"
                     f"（ingress 服务地址需指向 http://127.0.0.1:{QL_PORT}）")
    else:
        lines.append("- 未启动隧道（CF_MODE=none）")
    lines += [
        f"- 镜像：{QL_IMAGE}",
        f"- 数据目录：{QL_DATA_DIR}",
        f"- 保活至：{_fmt_until(RUN_MINUTES)}",
        "",
        "> 首次访问会引导初始化管理员账号，请设置强密码；quick 隧道为临时域名"
        "（无 SLA、可能被回收），长期使用建议 CF_MODE=token 命名隧道。",
        "",
    ]
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines))


def main() -> int:
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _handle_signal)
        except ValueError:
            pass
    if CF_MODE not in ("quick", "token", "none"):
        log(f"[error] CF_MODE 仅支持 quick / token / none，当前为 {CF_MODE!r}")
        return 2

    log(f"配置：image={QL_IMAGE} port={QL_PORT} data={QL_DATA_DIR} "
        f"cf_mode={CF_MODE} run_minutes={RUN_MINUTES} tz={QL_TZ}")

    panel = Panel()
    tunnel: Tunnel | None = None
    exit_code = 0
    try:
        panel.start()
        url: str | None = None
        if CF_MODE == "none":
            log("CF_MODE=none，仅启动面板，不建立隧道")
        else:
            tunnel = Tunnel()
            url = tunnel.start()
        _write_summary(url)

        print("\n" + "=" * 60)
        print(f"青龙面板访问地址：{url or LOCAL_URL}")
        if url:
            print(f"（本地地址：{LOCAL_URL}）")
        print(f"保活至：{_fmt_until(RUN_MINUTES)}")
        print("=" * 60 + "\n", flush=True)

        deadline = time.monotonic() + RUN_MINUTES * 60 if RUN_MINUTES > 0 else None
        while not STOP.is_set():
            if deadline is not None and time.monotonic() >= deadline:
                log("保活时间到，准备清理退出")
                break
            if not panel.running():
                log("[error] 青龙容器已停止运行")
                exit_code = 1
                break
            if tunnel and tunnel.proc and tunnel.proc.poll() is not None:
                log("[error] cloudflared 已停止运行")
                exit_code = 1
                break
            time.sleep(10)
    except Exception as e:
        log(f"[error] {e}")
        exit_code = 1
    finally:
        if tunnel:
            tunnel.stop()
        panel.stop()
        log(f"结束，退出码 {exit_code}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
