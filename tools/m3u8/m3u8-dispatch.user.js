// ==UserScript==
// @name         gh-toolbox m3u8 一键触发器
// @namespace    https://gh-toolbox/m3u8
// @version      1.1.0
// @description  在 gh-toolbox 仓库页面或 jable.tv / pornhub / missav 视频页显示悬浮按钮，弹框内分「GitHub Action 触发」与「通过 aria2 下载」两个 tab：一键触发「N_m3u8DL-RE 下载器」workflow_dispatch，或把视频直链直接添加到本地/局域网 aria2；自动提取视频直链与标题，并轮询展示运行/下载状态。
// @match        https://github.com/*/gh-toolbox*
// @match        https://*.missav.ws/*
// @match        https://jable.tv/videos/*
// @match        https://*.pornhub.com/view_video.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

/*
 * gh-toolbox / m3u8 油猴触发器（N_m3u8DL-RE 下载器）
 * ------------------------------------------------
 * 与 tools/ytdlp/ytdlp-dispatch.user.js 同源的姊妹脚本，触发目标换成
 * .github/workflows/m3u8.yml（N_m3u8DL-RE 下载器），差异只在 CONFIG /
 * INPUTS / 快照目录 / 文案；弹框表单与 m3u8.yml 的 inputs 一一对应。
 *
 * 功能：
 *   1. 在 gh-toolbox 仓库页面、jable.tv / pornhub / missav 视频页右下角显示
 *      悬浮按钮（可拖动）；
 *   2. 点击按钮打开弹框，弹框分两个 tab：
 *        - 「GitHub Action 触发」：填写 workflow_dispatch 参数（与
 *          .github/workflows/m3u8.yml 的 inputs 一一对应，见下方 INPUTS 定义）；
 *        - 「通过 aria2 下载」：不经过 GitHub，直接把 urls 里的地址逐条加到
 *          aria2 的 JSON-RPC（地址/密钥在面板内填写并按 host 保存），支持
 *          UA/Referer 请求头、all-proxy 代理、多连接与任务进度轮询。
 *          参数区只保留 aria2 生效的字段（urls / save_name / headers /
 *          overwrite / 多连接 / 代理 / 下载路径）；select_video、mux_format、
 *          thread_count、extra_args 与 HF 上传等 workflow 专用项不在右侧显示。
 *   3. 打开弹框时自动提取当前视频的直链与标题，写入参数（提取值不持久化，每次
 *      打开都重新提取）：
 *        - 视频站页面（jable.tv / pornhub / missav）：从实时页面提取；
 *        - GitHub 仓库页：从仓库快照目录 CONFIG.pageDirs（默认 tools/m3u8/html/）
 *          下的 *.html 快照提取。默认自动选中最近提交的快照，可下拉切换；
 *        - urls      ← 只写视频直链本身（纯 URL，一行一个，无注释行）；
 *        - save_name ← 视频标题（文件名安全化，即产物文件名）。
 *      urls / save_name 不保存，每次打开弹框都会重新提取；headers 栏为空时默认
 *      带上 UA + Referer（站点 origin）；其余表单项全部按 host 持久化；
 *   4. 触发目标三者全部用户手填、不写死（owner / repo / workflow，均可粘贴
 *      完整 URL/路径自动拆解；留空才兜底 CONFIG 默认值）；
 *   5. 触发后自动轮询新运行状态（queued -> in_progress -> completed），
 *      并展示最近 5 次运行记录，可直接跳转 Actions 页面/日志。
 *
 * Token 权限：
 *   - 经典 PAT：repo scope；
 *   - 细粒度 PAT：Actions: read+write、Contents: read、Metadata: read。
 *   Token 仅存于本浏览器 Tampermonkey 存储，不会外发。
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 配置：目标仓库与默认 workflow（改这里即可复用到其他工具）
  // ---------------------------------------------------------------------------
  const CONFIG = {
    owner: '',
    repo: 'gh-toolbox',
    workflowFile: 'm3u8.yml',         // 默认 workflow 文件名（.github/workflows/ 下）
    workflowName: 'N_m3u8DL-RE 下载器',
    defaultBranch: 'main',
    fabLabel: '⬇ m3u8',
    storagePrefix: 'm3u8_trigger_',
    // 仓库内页面快照目录（GitHub 仓库页打开弹框时自动拉取解析）
    pageDirs: ['tools/m3u8/html'],
    pageFiles: [
      'tools/m3u8/html/jable.tv.html',
      'tools/m3u8/html/pornhub.com.html',
    ],
    // 提取到视频标题时自动写入 save_name（输出文件名）
    autoFillSaveName: true,
    // aria2 下载（弹框右侧 tab）：JSON-RPC 地址与密钥也可在面板内修改并保存；
    // 这里只是首次使用的默认值。局域网 aria2 示例：http://10.0.0.223:6800/jsonrpc
    aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
    aria2Secret: '',
    aria2PollMs: 600000,              // aria2 任务进度轮询最长时长（10 分钟）
    aria2PollInterval: 3000,
    // 支持的视频站页面（@match 已限定路径，这里兜底再判一次主机名/路径）
    videoSites: [
      { host: /(^|\.)jable\.tv$/, path: /^\/videos\// },
      { host: /(^|\.)pornhub\.com$/, path: /^\/view_video\.php/ },
      // missav：/jur-881、/cn/jur-881、/dm39/jur-881 等番号详情页。
      // 判据：路径最后一段是番号（字母+数字+连字符，必含数字），列表页如
      // /actress/xxx、/genres/xxx、/ 均不匹配
      { host: /(^|\.)missav\.ws$/, path: /^\/(?:[\w-]+\/)?[\w-]*\d[\w-]*\/?$/i },
    ],
  };

  // workflow_dispatch 输入定义（与 m3u8.yml 的 inputs 一一对应，顺序即表单顺序）
  const INPUTS = [
    {
      key: 'urls', label: 'urls · 下载目标', type: 'textarea', default: '',
      hint: '每行一个：M3U8 / MPD 直链 URL；留空则使用仓库 tools/m3u8/urls.txt',
      placeholder: 'https://example.com/video/index.m3u8\nhttps://example.com/manifest.mpd',
    },
    {
      key: 'select_video', label: 'select_video · 视频流选择', type: 'text', default: '',
      hint: '如 best、res="1920*":codecs=hvc1:for=best、bwMin=800:for=best；留空走 auto_select',
      placeholder: 'best',
    },
    {
      key: 'auto_select', label: 'auto_select · 自动选流', type: 'checkbox', default: true,
      hint: '自动选择所有类型的最佳轨道；不勾选且未填流选择表达式时，交互选流在 CI 上会直接失败',
    },
    {
      key: 'save_name', label: 'save_name · 输出文件名', type: 'text', default: '',
      hint: '不含扩展名（如 myvideo）；视频页打开时自动填入页面标题（可改）；留空按 URL 自动派生（同名已存在则跳过）',
      placeholder: 'myvideo',
    },
    {
      key: 'overwrite', label: 'overwrite · 覆盖已存在文件', type: 'checkbox', default: false,
      hint: '勾选 = 强制重新下载并删除已存在的同名文件；不勾选 = 目标文件已存在则跳过',
    },
    {
      key: 'mux_format', label: 'mux_format · 混流封装格式', type: 'select', default: 'mp4',
      options: ['mp4', 'mkv', 'ts', 'none'],
      hint: '下载完成后混流封装（依赖 ffmpeg）：none = 不混流（输出轨道原文件）',
    },
    {
      key: 'thread_count', label: 'thread_count · 下载线程数', type: 'number', default: '16',
      hint: '分片并发下载线程数',
      placeholder: '16',
    },
    {
      key: 'headers', label: 'headers · 自定义请求头', type: 'textarea', default: '',
      hint: '默认已带 UA + Referer（按站点自动生成，可自行修改）；单行 JSON；需 Cookie 时也可配 Secret M3U8_COOKIES',
      placeholder: '{"User-Agent":"Mozilla/5.0 ...","Referer":"https://example.com/"}',
    },
    {
      key: 'hf_upload', label: 'hf_upload · 上传 HF datasets', type: 'checkbox', default: false,
      hint: '下载完成后上传到 Hugging Face datasets（需仓库 Secret M3U8_HF_TOKEN）',
    },
    {
      key: 'hf_repo', label: 'hf_repo · HF 仓库 ID', type: 'text', default: '',
      hint: '格式 用户名/数据集名；留空则用 Secret M3U8_HF_REPO',
      placeholder: 'myuser/my-videos',
    },
    {
      key: 'hf_path', label: 'hf_path · 上传子目录', type: 'text', default: '',
      hint: '上传到数据集仓库内的子目录，留空 = 根路径',
      placeholder: 'videos/2024',
    },
    {
      key: 'extra_args', label: 'extra_args · 附加参数', type: 'text', default: '',
      hint: 'N_m3u8DL-RE 附加命令行参数（空格分隔，如 --key KID:KEY、--live-record-limit 00:30:00）',
      placeholder: '--live-record-limit 00:30:00',
    },
  ];

  // aria2 tab 的表单：只保留 aria2 真正生效的字段（urls / save_name / headers /
  // overwrite / 多连接）＋代理与 RPC 配置；select_video / mux_format / thread_count /
  // extra_args / HF 上传都是 workflow 专用，不在右侧显示。
  const ARIA2_INPUT_ORDER = ['urls', 'save_name', 'headers', 'overwrite', 'aria2', 'proxy', 'dir'];
  const ARIA2_INPUTS = [
    {
      key: 'rpc', label: 'aria2 RPC 地址', type: 'text', default: CONFIG.aria2Rpc, aria: true,
      hint: 'JSON-RPC 地址，如 http://127.0.0.1:6800/jsonrpc；局域网可填 http://10.0.0.223:6800/jsonrpc',
      placeholder: 'http://10.0.0.223:6800/jsonrpc',
    },
    {
      key: 'secret', label: 'aria2 RPC 密钥', type: 'password', default: CONFIG.aria2Secret, aria: true,
      hint: '对应 aria2 启动参数 --rpc-secret；没有设置就留空',
      placeholder: '留空 = 无密钥',
    },
  ].concat(ARIA2_INPUT_ORDER.map((key) => {
    if (key === 'proxy') {
      return {
        key: 'proxy', label: 'proxy · 代理', type: 'text', default: '', aria: true,
        hint: 'aria2 all-proxy：http://127.0.0.1:7890 或 http://用户名:密码@主机:端口；留空 = 直连',
        placeholder: 'http://127.0.0.1:7890',
      };
    }
    if (key === 'dir') {
      return {
        key: 'dir', label: 'dir · 下载路径', type: 'text', default: '', aria: true,
        hint: 'aria2 所在机器上的保存目录（绝对路径），如 /downloads 或 D:\\Downloads；留空 = aria2 配置里的默认目录',
        placeholder: '/downloads',
      };
    }
    if (key === 'aria2') {
      return {
        key: 'aria2', label: 'aria2 · 多连接加速', type: 'checkbox', default: false, aria: true,
        hint: '勾选 = aria2 多连接（-x 16 -s 16）；不勾选 = 默认连接数',
      };
    }
    const src = INPUTS.find((s) => s.key === key);
    const spec = Object.assign({}, src, { aria: true });
    if (key === 'save_name') spec.hint = '单链接时作为输出文件名 out（建议带扩展名）；多链接时忽略；留空由 aria2 按 URL 命名';
    if (key === 'overwrite') spec.hint = '勾选 = 允许覆盖（allow-overwrite）；不勾选 = 目标文件已存在时报错';
    if (key === 'headers') spec.hint = '默认已带 UA + Referer（按站点自动生成）；作为 aria2 header 发送；单行 JSON 或每行 Name: Value';
    return spec;
  }));

  const REPO_PREFIX = CONFIG.owner ? `https://github.com/${CONFIG.owner}/${CONFIG.repo}` : '';
  const API_BASE = 'https://api.github.com';
  const POLL_FIND_RUN_MS = 60000;
  const POLL_RUN_MS = 600000;
  const POLL_FIND_INTERVAL = 3000;
  const POLL_RUN_INTERVAL = 5000;
  const SNAP_CACHE_MS = 120000;

  // ---------------------------------------------------------------------------
  // 存储封装：优先 Tampermonkey GM_*，降级 localStorage；key 按 host 隔离
  // ---------------------------------------------------------------------------
  const hasGM = typeof GM_setValue === 'function' && typeof GM_getValue === 'function';
  const HOST = location.hostname.toLowerCase();
  const store = {
    get(key, dflt) {
      const k = CONFIG.storagePrefix + HOST + '_' + key;
      try {
        if (hasGM) {
          const v = GM_getValue(k, dflt);
          return v === undefined ? dflt : v;
        }
        const raw = localStorage.getItem(k);
        return raw === null ? dflt : JSON.parse(raw);
      } catch (e) { return dflt; }
    },
    set(key, val) {
      const k = CONFIG.storagePrefix + HOST + '_' + key;
      try {
        if (hasGM) GM_setValue(k, val);
        else localStorage.setItem(k, JSON.stringify(val));
      } catch (e) { /* ignore */ }
    },
    del(key) {
      const k = CONFIG.storagePrefix + HOST + '_' + key;
      try {
        if (hasGM) GM_deleteValue(k);
        else localStorage.removeItem(k);
      } catch (e) { /* ignore */ }
    },
  };

  const KEY = {
    token: 'token', ref: 'ref', form: (k) => 'form_' + k, fabPos: 'fab_pos',
    snapCache: 'snap_cache',
    owner: 'owner', repo: 'repo', workflow: 'workflow',
    tab: 'tab',                      // 上次打开的 tab（github / aria2）
  };

  // urls（下载链接）与 save_name（视频标题自动带入）不持久化：每次打开弹框重新提取
  const NO_SAVE = { urls: true, save_name: true };

  // 悬浮按钮距视口边缘的最小留白（px）：保证任何窗口尺寸下按钮都可见、可抓住拖回
  const FAB_MARGIN = 4;

  // ---------------------------------------------------------------------------
  // GitHub API 封装（GM_xmlhttpRequest 跨源；降级 fetch）
  // ---------------------------------------------------------------------------
  function api(method, path, body, tokenOverride) {
    return new Promise((resolve, reject) => {
      const token = (tokenOverride !== undefined ? tokenOverride : (store.get(KEY.token, '') || '')).trim();
      if (!token) { reject(new Error('尚未配置 GitHub Token')); return; }
      const headers = {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      if (typeof GM_xmlhttpRequest === 'function') {
        const opts = { method, url: API_BASE + path, headers, onload: resolve, onerror: () => reject(new Error('网络错误：无法访问 api.github.com')) };
        if (body !== undefined) opts.data = JSON.stringify(body);
        GM_xmlhttpRequest(opts);
      } else {
        fetch(API_BASE + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }).then(async (r) => {
          resolve({ status: r.status, responseText: await r.text() });
        }).catch(() => reject(new Error('网络错误：无法访问 api.github.com')));
      }
    });
  }

  function extractError(res) {
    try {
      const data = JSON.parse(res.responseText || '{}');
      return data.message || res.responseText || ('HTTP ' + res.status);
    } catch (e) {
      return (res.responseText || '').slice(0, 300) || ('HTTP ' + res.status);
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function relTime(iso) {
    const t = new Date(iso).getTime();
    if (!t) return '';
    const diff = Date.now() - t;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return Math.floor(diff / 86400000) + ' 天前';
  }

  // ---------------------------------------------------------------------------
  // 页面视频提取：从 HTML（实时页面或仓库快照）解析视频直链 + 标题
  // ---------------------------------------------------------------------------
  function httpRequest(method, url, headers) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method, url, headers: headers || {},
          onload: resolve,
          onerror: () => reject(new Error('网络错误：' + url)),
        });
      } else {
        fetch(url, { method, headers }).then(async (r) => {
          resolve({ status: r.status, responseText: await r.text() });
        }).catch(() => reject(new Error('网络错误：' + url)));
      }
    });
  }

  function apiMaybeAuth(method, path) {
    const token = (store.get(KEY.token, '') || '').trim();
    if (token) return api(method, path);
    return httpRequest(method, API_BASE + path, {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function hostBrand(url) {
    try {
      const parts = new URL(url).hostname.toLowerCase().split('.');
      return parts.length >= 2 ? parts.slice(-2).join('.') : (parts[0] || '');
    } catch (e) { return ''; }
  }

  function unescapeJsString(s) {
    return String(s || '')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
  }

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'");
  }

  // 解密页面里的 p,a,c,k,e,d packed eval 块（missav 等站点用这招藏 m3u8 直链）。
  // 只做「字典替换」这一无害还原，不 eval；返回解密后的源码片段数组。
  function unpackPackedBlocks(html) {
    const out = [];
    const re = /}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\s*\.split\('\|'\)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        const payload = unescapeJsString(m[1]);
        const a = parseInt(m[2], 10) || 0;
        const c = parseInt(m[3], 10) || 0;
        const dict = unescapeJsString(m[4]).split('|');
        if (!c || !dict.length) continue;
        // 还原时按 token 长度从长到短替换，避免短 token 抢先替换破坏长 token
        const keys = [];
        for (let i = 0; i < c; i++) {
          const k = i.toString(36);
          if (dict[i] && dict[i] !== k) keys.push([k, dict[i]]);
        }
        keys.sort((x, y) => y[0].length - x[0].length);
        let src = payload;
        keys.forEach(([k, v]) => {
          src = src.replace(new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), v);
        });
        if (src !== payload) out.push(src);
      } catch (e) { /* 解不开就跳过 */ }
    }
    return out;
  }

  function pickBestVideo(urls) {
    let best = '', bestScore = -1;
    (urls || []).forEach((u) => {
      const m = u.match(/(\d{3,4})[Pp](?:_|\b)/);
      const score = m ? parseInt(m[1], 10) : 0;
      if (score > bestScore) { bestScore = score; best = u; }
    });
    return best;
  }

  async function listSnapshotCandidates() {
    const cache = store.get(KEY.snapCache, null);
    if (cache && cache.ts && Date.now() - cache.ts < SNAP_CACHE_MS && Array.isArray(cache.list) && cache.list.length) {
      return cache.list;
    }
    const ref = (refInput && refInput.value.trim()) || CONFIG.defaultBranch;
    const paths = [];
    const push = (p) => { if (p && paths.indexOf(p) === -1) paths.push(p); };
    CONFIG.pageFiles.forEach(push);
    for (const dir of CONFIG.pageDirs) {
      try {
        const r = await apiMaybeAuth('GET', '/repos/' + repoPath() +
          '/contents/' + dir.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(ref));
        if (r.status === 200) {
          const items = JSON.parse(r.responseText);
          (Array.isArray(items) ? items : []).forEach((f) => {
            if (f && f.type === 'file' && /\.html?$/i.test(f.name || '')) push(f.path);
          });
        }
      } catch (e) { /* 单个目录失败不影响其他 */ }
    }
    if (!paths.length) return [];
    const list = await Promise.all(paths.map(async (p) => {
      try {
        const r = await apiMaybeAuth('GET', '/repos/' + repoPath() +
          '/commits?path=' + encodeURIComponent(p) + '&per_page=1');
        if (r.status === 200) {
          const arr = JSON.parse(r.responseText);
          const c = Array.isArray(arr) && arr[0];
          return { path: p, date: (c && c.commit && c.commit.committer && c.commit.committer.date) || '' };
        }
      } catch (e) { /* ignore */ }
      return { path: p, date: '' };
    }));
    list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    store.set(KEY.snapCache, { ts: Date.now(), list });
    return list;
  }

  async function fetchRepoFile(path) {
    const p = String(path || '').replace(/^\/+/, '');
    const ref = (refInput && refInput.value.trim()) || CONFIG.defaultBranch;
    const segs = p.split('/').map(encodeURIComponent).join('/');
    const rawUrl = 'https://raw.githubusercontent.com/' + repoPath() +
      '/' + encodeURIComponent(ref) + '/' + segs;
    let rawStatus = -1;
    try {
      const r = await httpRequest('GET', rawUrl);
      if (r.status === 200) return { ok: true, text: r.responseText };
      rawStatus = r.status;
    } catch (e) { /* 走回退 */ }
    if (!(store.get(KEY.token, '') || '').trim()) {
      return { ok: false, status: rawStatus, message: 'raw 拉取失败（HTTP ' + rawStatus + '），且未配置 Token 无法回退 contents API' };
    }
    try {
      const r = await api('GET', '/repos/' + repoPath() + '/contents/' + segs + '?ref=' + encodeURIComponent(ref));
      if (r.status === 200) {
        const data = JSON.parse(r.responseText);
        const bin = atob(String(data.content || '').replace(/\n/g, ''));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return { ok: true, text: new TextDecoder('utf-8').decode(bytes) };
      }
      return { ok: false, status: r.status, message: extractError(r) };
    } catch (e) {
      return { ok: false, status: rawStatus, message: e.message };
    }
  }

  function extractPageVideos(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let title = '';
    const og = doc.querySelector('meta[property="og:title"]');
    if (og) title = (og.getAttribute('content') || '').trim();
    if (!title) {
      const h4 = doc.querySelector('.video-info h4');
      if (h4) title = (h4.textContent || '').trim();
    }
    let pageUrl = '';
    const canonical = doc.querySelector('link[rel="canonical"]');
    if (canonical) pageUrl = (canonical.getAttribute('href') || '').trim();
    if (!pageUrl) {
      const ogu = doc.querySelector('meta[property="og:url"]');
      if (ogu) pageUrl = (ogu.getAttribute('content') || '').trim();
    }
    if (!title) {
      const t = doc.querySelector('title');
      if (t) {
        title = (t.textContent || '').trim();
        const brand = hostBrand(pageUrl);
        if (brand) {
          title = title.replace(new RegExp('\\s*[-–—|]\\s*' + escapeRegExp(brand) + '\\b[\\s\\S]*$', 'i'), '').trim();
        }
      }
    }
    const raws = [];
    let m;
    const re1 = /hlsUrl\s*=\s*['"]([^'"]+)['"]/g;
    while ((m = re1.exec(html)) !== null) raws.push(m[1]);
    if (!raws.length) {
      const re2 = /"videoUrl"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      while ((m = re2.exec(html)) !== null) raws.push(m[2] || m[1]);
    }
    if (!raws.length) {
      const re3 = /(https?:\\?\/\\?\/[^\s'"<>()]+?\.(?:m3u8|mp4|mpd)(?:\?[^\s'"<>()]*)?)/gi;
      while ((m = re3.exec(html)) !== null) raws.push(m[1]);
    }
    // missav 等站点把直链藏进 p,a,c,k,e,d packed eval 里，先解密再提取
    const packedUrls = [];
    unpackPackedBlocks(html).forEach((src) => {
      let mm;
      const re4 = /(https?:\/\/[^\s'"<>()]+?\.(?:m3u8|mp4|mpd)(?:\?[^\s'"<>()]*)?)/gi;
      while ((mm = re4.exec(src)) !== null) packedUrls.push(mm[1]);
    });
    if (!raws.length) packedUrls.forEach((u) => raws.push(u));
    const norm = [];
    raws.forEach((r) => {
      const u = decodeEntities(unescapeJsString(r)).trim();
      if (!u || norm.indexOf(u) !== -1) return;
      if (!/^https?:\/\//i.test(u)) return;
      norm.push(u);
    });
    // 前面几条正则可能只匹配到页面里的示例/占位值（如 missav 内联文档代码中的
    // example.com），此时 packed 解密拿到的真实直链优先采用
    const isPlaceholder = (u) => /^https?:\/\/(www\.)?example\.(com|org|net)\b/i.test(u);
    if (norm.length && norm.every(isPlaceholder) && packedUrls.length) {
      norm.length = 0;
      packedUrls.forEach((u) => {
        const v = decodeEntities(unescapeJsString(u)).trim();
        if (v && norm.indexOf(v) === -1) norm.push(v);
      });
    }
    const isDownloadEp = (u) => /\/get_media\b|\/download\b/i.test(u);
    const isPreview = (u) => /preview|screenshot|thumbvtt/i.test(u);
    const candidates = norm.filter((u) => !isDownloadEp(u) && !isPreview(u));
    const primary = pickBestVideo(candidates.length ? candidates : norm);
    const videos = primary ? [{ title, url: primary }] : [];
    return { title, pageUrl, videos };
  }

  function sanitizeFileName(name) {
    return String(name || '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  function defaultHeaders(pageUrl) {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const h = { 'User-Agent': ua };
    let referer = '';
    try {
      if (pageUrl) referer = new URL(pageUrl).origin + '/';
      else if (onVideoPage()) referer = location.origin + '/';
    } catch (e) { referer = ''; }
    if (referer) h['Referer'] = referer;
    return JSON.stringify(h);
  }

  function isGeneratedHeaders(v) {
    try {
      const o = JSON.parse(v);
      if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
      const keys = Object.keys(o);
      if (!keys.length || keys.length > 2) return false;
      return keys.every((k) => k === 'User-Agent' || k === 'Referer');
    } catch (e) { return false; }
  }

  async function autoFillFromPage() {
    const roots = [formEl, ariaFormEl].filter(Boolean);
    const urlNodes = roots.map((r) => r.querySelector('[data-key="urls"]')).filter(Boolean);
    if (!urlNodes.length) return;

    const src = videoSource();
    setAnyStatus(src === 'live'
      ? '正在从当前页面提取视频信息…'
      : '正在发现仓库页面快照…', 'info');
    try {
      let parsed;
      let srcLabel = '当前页面';
      if (src === 'live') {
        parsed = extractPageVideos(document.documentElement.outerHTML);
      } else {
        const cands = await listSnapshotCandidates();
        if (!cands.length) {
          setAnyStatus('未发现页面快照：请把保存的网页 HTML 放到仓库 ' + CONFIG.pageDirs[0] +
            ' 目录并推送（目录列举需要网络可达 api.github.com）', 'err');
          return;
        }
        const keep = pageSrcSelect.value && cands.some((c) => c.path === pageSrcSelect.value) ? pageSrcSelect.value : '';
        fillPageSrcOptions(cands, keep);
        const chosen = pageSrcSelect.value || cands[0].path;
        const order = [chosen].concat(cands.map((c) => c.path).filter((p) => p !== chosen));
        const tried = [];
        for (const p of order) {
          const res = await fetchRepoFile(p);
          if (!res.ok) { tried.push(basename(p) + ' HTTP ' + res.status); continue; }
          const v = extractPageVideos(res.text);
          if (v.videos.length) { parsed = v; srcLabel = '仓库快照 ' + p; pageSrcSelect.value = p; break; }
          tried.push(basename(p) + ' 无视频直链');
        }
        if (!parsed) {
          setAnyStatus('所有快照均无法提取视频：' + tried.join('；') +
            '。请确认保存的是视频详情页（含播放器 script），且已提交推送', 'err');
          return;
        }
      }
      if (!parsed.videos.length) {
        setAnyStatus(src === 'live'
          ? '当前页面未找到视频直链。请确认在视频详情页打开（jable.tv /videos/xxx、pornhub /view_video.php、missav /cn/xxx-123）'
          : '页面中未找到视频直链，请确认保存的是视频详情页（含播放器 script）', 'err');
        return;
      }
      const lines = parsed.videos.map((v) => v.url);
      urlNodes.forEach((n) => { n.value = lines.join('\n'); }); // 两个 tab 都填，不持久化
      // 标题自动写入输出文件名（产物名 = 标题.mp4/mkv/ts）；只写提取值，用户已手改的值不覆盖
      if (CONFIG.autoFillSaveName && parsed.title) {
        roots.forEach((r) => {
          const n = r.querySelector('[data-key="save_name"]');
          if (n) n.value = sanitizeFileName(parsed.title);
        });
      }
      // headers 栏为空、或仍是脚本生成的默认头时，按提取到的站点补/换 UA + Referer；
      // 用户自定义值（带 Cookie / 自定义键）不动
      roots.forEach((r) => {
        const headersNode = r.querySelector('[data-key="headers"]');
        if (headersNode && (!headersNode.value.trim() || isGeneratedHeaders(headersNode.value))) {
          const dh = defaultHeaders(parsed.pageUrl);
          headersNode.value = dh;
          store.set(KEY.form((r === ariaFormEl ? 'aria2_' : '') + 'headers'), dh);
        }
      });
      setAnyStatus('已载入 ' + parsed.videos.length + ' 个视频' + (parsed.title ? '：' + parsed.title : '') +
        '（来源：' + srcLabel + '）', 'ok');
    } catch (e) {
      setAnyStatus('读取页面视频异常：' + e.message, 'err');
    }
  }

  function basename(p) {
    return String(p || '').split('/').pop() || String(p || '');
  }

  function fillPageSrcOptions(cands, preferred) {
    if (!pageSrcSelect) return;
    pageSrcSelect.innerHTML = '';
    cands.forEach((c) => {
      const o = el('option', null, basename(c.path) + (c.date ? '（' + relTime(c.date) + '）' : ''));
      o.value = c.path;
      pageSrcSelect.appendChild(o);
    });
    pageSrcSelect.value = (preferred && cands.some((c) => c.path === preferred)) ? preferred : (cands[0] ? cands[0].path : '');
  }

  // ---------------------------------------------------------------------------
  // 样式（与 ytdlp 脚本同款，仅前缀不同）
  // ---------------------------------------------------------------------------
  const CSS = `
#m3u8-t-fab{position:fixed;right:24px;bottom:150px;z-index:2147483000;display:flex;align-items:center;gap:6px;
  padding:10px 16px;border-radius:999px;background:#8250df;color:#fff;font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;
  cursor:pointer;user-select:none;box-shadow:0 4px 14px rgba(31,35,40,.25);border:1px solid rgba(27,31,36,.15);touch-action:none;
  max-width:calc(100vw - 48px);max-height:calc(100vh - 190px);overflow:hidden;white-space:nowrap;box-sizing:border-box}
#m3u8-t-fab:hover{background:#7440dc}
#m3u8-t-mask{position:fixed;inset:0;z-index:2147483001;background:rgba(31,35,40,.5);display:flex;align-items:center;justify-content:center;padding:20px}
#m3u8-t-panel{width:min(720px,94vw);max-height:88vh;overflow:auto;background:#fff;color:#1f2328;border:1px solid #d1d9e0;border-radius:12px;
  box-shadow:0 8px 40px rgba(31,35,40,.28);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
#m3u8-t-root[data-theme="dark"] #m3u8-t-fab{background:#8957e5;border-color:#a371f7}
#m3u8-t-root[data-theme="dark"] #m3u8-t-fab:hover{background:#9e6ffa}
#m3u8-t-root[data-theme="dark"] #m3u8-t-mask{background:rgba(1,4,9,.7)}
#m3u8-t-root[data-theme="dark"] #m3u8-t-panel{background:#0d1117;color:#e6edf3;border-color:#30363d}
.m3u8-t-tabs{display:flex;gap:4px;margin:-4px 0 16px;border-bottom:1px solid #d1d9e0}
.m3u8-t-tab{appearance:none;border:none;border-bottom:2px solid transparent;background:transparent;color:#57606a;font:600 13px/1.2 inherit;padding:8px 12px;margin-bottom:-1px;cursor:pointer}
.m3u8-t-tab:hover{color:#1f2328}
.m3u8-t-tab.active{color:#1f2328;border-bottom-color:#8250df}
#m3u8-t-root[data-theme="dark"] .m3u8-t-tabs{border-color:#30363d}
#m3u8-t-root[data-theme="dark"] .m3u8-t-tab{color:#8b949e}
#m3u8-t-root[data-theme="dark"] .m3u8-t-tab:hover{color:#e6edf3}
#m3u8-t-root[data-theme="dark"] .m3u8-t-tab.active{color:#e6edf3;border-bottom-color:#a371f7}
.m3u8-t-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid #d1d9e0;position:sticky;top:0;background:inherit;z-index:1}
#m3u8-t-root[data-theme="dark"] .m3u8-t-head{border-color:#30363d}
.m3u8-t-title{font-size:16px;font-weight:600;margin:0}
.m3u8-t-title small{font-weight:400;color:#57606a;margin-left:8px;font-size:12px}
#m3u8-t-root[data-theme="dark"] .m3u8-t-title small{color:#8b949e}
.m3u8-t-close{border:none;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#57606a;padding:4px 8px;border-radius:6px}
.m3u8-t-close:hover{background:#f3f4f6;color:#1f2328}
#m3u8-t-root[data-theme="dark"] .m3u8-t-close{color:#8b949e}
#m3u8-t-root[data-theme="dark"] .m3u8-t-close:hover{background:#21262d;color:#e6edf3}
.m3u8-t-body{padding:16px 18px}
.m3u8-t-section{margin:0 0 18px}
.m3u8-t-section>h3{margin:0 0 10px;font-size:13px;font-weight:600;color:#57606a;text-transform:uppercase;letter-spacing:.04em}
#m3u8-t-root[data-theme="dark"] .m3u8-t-section>h3{color:#8b949e}
.m3u8-t-row{margin-bottom:14px}
.m3u8-t-row-check{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.m3u8-t-label{display:block;font-weight:600;margin-bottom:4px;font-size:13px}
.m3u8-t-check-label{font-size:13px;font-weight:600;cursor:pointer}
.m3u8-t-hint{font-size:12px;color:#57606a;margin-top:4px}
#m3u8-t-root[data-theme="dark"] .m3u8-t-hint{color:#8b949e}
.m3u8-t-input,.m3u8-t-select,.m3u8-t-textarea{width:100%;box-sizing:border-box;padding:6px 10px;font:13px/1.4 inherit;color:inherit;background:#fff;
  border:1px solid #d1d9e0;border-radius:6px;outline:none}
.m3u8-t-textarea{min-height:64px;resize:vertical;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,monospace;font-size:12px}
.m3u8-t-input:focus,.m3u8-t-select:focus,.m3u8-t-textarea:focus{border-color:#8250df;box-shadow:0 0 0 3px rgba(130,80,223,.15)}
#m3u8-t-root[data-theme="dark"] .m3u8-t-input,#m3u8-t-root[data-theme="dark"] .m3u8-t-select,#m3u8-t-root[data-theme="dark"] .m3u8-t-textarea{background:#0d1117;border-color:#30363d}
#m3u8-t-root[data-theme="dark"] .m3u8-t-input:focus,#m3u8-t-root[data-theme="dark"] .m3u8-t-select:focus,#m3u8-t-root[data-theme="dark"] .m3u8-t-textarea:focus{border-color:#a371f7;box-shadow:0 0 0 3px rgba(163,113,247,.25)}
.m3u8-t-check{width:16px;height:16px;accent-color:#8250df;cursor:pointer}
.m3u8-t-tokenrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.m3u8-t-tokenrow .m3u8-t-input{flex:1;min-width:220px}
.m3u8-t-btn{border:1px solid #d1d9e0;background:#f6f8fa;color:#1f2328;font:600 13px/1.2 inherit;padding:7px 14px;border-radius:6px;cursor:pointer;white-space:nowrap}
.m3u8-t-btn:hover{background:#f3f4f6;border-color:#afb8c1}
.m3u8-t-btn:disabled{opacity:.6;cursor:not-allowed}
.m3u8-t-btn-primary{background:#8250df;border-color:rgba(27,31,36,.15);color:#fff}
.m3u8-t-btn-primary:hover{background:#7440dc;border-color:rgba(27,31,36,.15)}
#m3u8-t-root[data-theme="dark"] .m3u8-t-btn{background:#21262d;border-color:#30363d;color:#e6edf3}
#m3u8-t-root[data-theme="dark"] .m3u8-t-btn:hover{background:#30363d}
#m3u8-t-root[data-theme="dark"] .m3u8-t-btn-primary{background:#8957e5;color:#fff}
#m3u8-t-root[data-theme="dark"] .m3u8-t-btn-primary:hover{background:#9e6ffa}
.m3u8-t-btn-danger{color:#cf222e}
#m3u8-t-root[data-theme="dark"] .m3u8-t-btn-danger{color:#f85149}
.m3u8-t-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:4px}
.m3u8-t-status{margin-top:12px;padding:10px 12px;border-radius:6px;font-size:13px;white-space:pre-wrap;word-break:break-all;display:none}
.m3u8-t-status.ok{display:block;background:#dafbe1;color:#116329;border:1px solid #4ac26b}
.m3u8-t-status.err{display:block;background:#ffebe9;color:#82071e;border:1px solid #ff8182}
.m3u8-t-status.info{display:block;background:#ddf4ff;color:#0a3069;border:1px solid #54aeff}
#m3u8-t-root[data-theme="dark"] .m3u8-t-status.ok{background:rgba(46,160,67,.15);color:#3fb950;border-color:rgba(46,160,67,.4)}
#m3u8-t-root[data-theme="dark"] .m3u8-t-status.err{background:rgba(248,81,73,.15);color:#f85149;border-color:rgba(248,81,73,.4)}
#m3u8-t-root[data-theme="dark"] .m3u8-t-status.info{background:rgba(56,139,253,.15);color:#79c0ff;border-color:rgba(56,139,253,.4)}
.m3u8-t-runs{list-style:none;margin:0;padding:0}
.m3u8-t-runs li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #eaeef2;font-size:13px}
#m3u8-t-root[data-theme="dark"] .m3u8-t-runs li{border-color:#21262d}
.m3u8-t-runs li:last-child{border-bottom:none}
.m3u8-t-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:18px;white-space:nowrap}
.m3u8-t-badge.queued{background:#fff8c5;color:#7d4e00}
.m3u8-t-badge.in_progress{background:#ddf4ff;color:#0a3069}
.m3u8-t-badge.completed-success{background:#dafbe1;color:#116329}
.m3u8-t-badge.completed-failure{background:#ffebe9;color:#82071e}
.m3u8-t-badge.completed-cancelled,.m3u8-t-badge.completed-skipped{background:#f6f8fa;color:#57606a}
#m3u8-t-root[data-theme="dark"] .m3u8-t-badge.queued{background:rgba(187,128,9,.2);color:#d29922}
#m3u8-t-root[data-theme="dark"] .m3u8-t-badge.in_progress{background:rgba(56,139,253,.2);color:#79c0ff}
#m3u8-t-root[data-theme="dark"] .m3u8-t-badge.completed-success{background:rgba(46,160,67,.2);color:#3fb950}
#m3u8-t-root[data-theme="dark"] .m3u8-t-badge.completed-failure{background:rgba(248,81,73,.2);color:#f85149}
#m3u8-t-root[data-theme="dark"] .m3u8-t-badge.completed-cancelled,#m3u8-t-root[data-theme="dark"] .m3u8-t-badge.completed-skipped{background:#21262d;color:#8b949e}
.m3u8-t-runmeta{color:#57606a;font-size:12px}
#m3u8-t-root[data-theme="dark"] .m3u8-t-runmeta{color:#8b949e}
.m3u8-t-runs a{color:#8250df;text-decoration:none;font-weight:600}
.m3u8-t-runs a:hover{text-decoration:underline}
#m3u8-t-root[data-theme="dark"] .m3u8-t-runs a{color:#a371f7}
.m3u8-t-empty{color:#57606a;font-size:13px;padding:6px 0}
#m3u8-t-root[data-theme="dark"] .m3u8-t-empty{color:#8b949e}
`;

  // ---------------------------------------------------------------------------
  // 页面位置判断（GitHub 是 Turbo SPA，需监听 URL 变化）
  // ---------------------------------------------------------------------------
  function inRepoPage() {
    const path = location.origin + location.pathname;
    if (CONFIG.owner) {
      return path === REPO_PREFIX || path.startsWith(REPO_PREFIX + '/');
    }
    return new RegExp('^https://github\\.com/[^/]+/' + CONFIG.repo + '(/|$)').test(path);
  }

  function onVideoPage() {
    return CONFIG.videoSites.some((s) => s.host.test(location.hostname) && s.path.test(location.pathname));
  }

  function pageAllowed() {
    return inRepoPage() || onVideoPage();
  }

  function videoSource() {
    return onVideoPage() ? 'live' : 'repo';
  }

  function currentWorkflow() {
    const raw = (workflowInput && workflowInput.value.trim()) || store.get(KEY.workflow, '') || CONFIG.workflowFile;
    const wf = String(raw).trim().replace(/^\.?github\/workflows\//, '').replace(/^\/+/, '');
    return wf || CONFIG.workflowFile;
  }

  function currentOwner() {
    let raw = (ownerInput && ownerInput.value.trim()) || store.get(KEY.owner, '') || CONFIG.owner;
    raw = String(raw).trim().replace(/^https?:\/\/[^/]+\//, '').replace(/^@/, '').replace(/^\/+/, '');
    const v = raw.split('/').filter(Boolean)[0];
    return v || CONFIG.owner;
  }

  function currentRepo() {
    let raw = (repoInput && repoInput.value.trim()) || store.get(KEY.repo, '') || CONFIG.repo;
    raw = String(raw).trim().replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '');
    const segs = raw.split('/').filter(Boolean);
    const v = segs.length >= 2 ? segs[1] : segs[0];
    return v || CONFIG.repo;
  }

  function repoPath() {
    return currentOwner() + '/' + currentRepo();
  }

  function splitTarget(v) {
    const s = String(v || '').trim()
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/^@/, '')
      .replace(/\.git$/, '')
      .replace(/^\/+|\/+$/g, '');
    return s.split('/').filter(Boolean);
  }

  function fillCounterpart(inputEl, key, segs, idx) {
    if (!inputEl || segs.length < 2) return;
    inputEl.value = segs[idx];
    store.set(key, segs[idx]);
  }

  function updateWorkflowLabels() {
    const wf = currentWorkflow();
    if (titleTextEl) titleTextEl.textContent = (wf === CONFIG.workflowFile ? CONFIG.workflowName : wf) + ' · 手动触发';
    if (titleSmallEl) titleSmallEl.textContent = repoPath() + ' · ' + wf;
    if (wfLink) wfLink.href = 'https://github.com/' + repoPath() +
      '/actions/workflows/' + encodeURIComponent(wf);
  }

  function currentTheme() {
    const attr = document.documentElement.getAttribute('data-color-mode');
    if (attr === 'dark' || attr === 'light') return attr;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // ---------------------------------------------------------------------------
  // DOM 构建
  // ---------------------------------------------------------------------------
  let rootEl, fabEl, maskEl, panelEl, formEl, refInput, statusEl, runStatusEl, runsEl, triggerBtn, tokenInput, pageSrcSelect, pageSrcRow,
    workflowInput, ownerInput, repoInput, titleTextEl, titleSmallEl, wfLink,
    githubPaneEl, ariaPaneEl, tabGithubEl, tabAriaEl, ariaFormEl, ariaStatusEl, ariaTasksEl, ariaTriggerBtn, ariaTestBtn;
  let ariaPollToken = 0;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function buildFab() {
    fabEl = el('div', null, CONFIG.fabLabel);
    fabEl.id = 'm3u8-t-fab';
    fabEl.title = onVideoPage()
      ? '点击触发 N_m3u8DL-RE 下载器 GitHub Action（自动带上当前页面视频，可拖动）'
      : '点击触发 N_m3u8DL-RE 下载器 GitHub Action（可拖动）';
    restoreFabPos();
    fabEl.addEventListener('pointerdown', onFabDown);
    fabEl.addEventListener('click', onFabClick);
    document.body.appendChild(fabEl);
    clampFabPos();
    // 初始化时 offsetWidth 可能还是 0（CSS/字体未加载完），布局稳定后再夹一次兜底
    requestAnimationFrame(clampFabPos);
    window.addEventListener('load', clampFabPos);
    // 窗口缩放 / 分屏拖动 / 转屏 / 移动端 pinch-zoom 都可能把按钮甩出屏幕，逐一监听夹回
    window.addEventListener('resize', clampFabPos);
    window.addEventListener('orientationchange', clampFabPos);
    if (window.visualViewport && window.visualViewport.addEventListener) {
      // 移动端 pinch-zoom、软键盘弹起时 window 尺寸不变、只有 visualViewport 变
      window.visualViewport.addEventListener('resize', clampFabPos);
      window.visualViewport.addEventListener('scroll', clampFabPos);
    }
  }

  // 视口尺寸：优先 visualViewport（移动端 pinch-zoom / 软键盘时 window 尺寸不准），回退 window
  function viewportSize() {
    if (window.visualViewport) {
      return { w: window.visualViewport.width, h: window.visualViewport.height };
    }
    return { w: window.innerWidth, h: window.innerHeight };
  }

  // 以「距右/下边缘的偏移」定位按钮。
  // 这样窗口缩放、浏览器缩放、分屏拖动时按钮跟着边缘走，天然不会跑出屏幕；
  // 只有窗口缩到放不下按钮时，才把偏移夹到最小留白。
  function applyFabEdge(right, bottom) {
    fabEl.style.left = 'auto';
    fabEl.style.top = 'auto';
    fabEl.style.right = right + 'px';
    fabEl.style.bottom = bottom + 'px';
  }

  // 把按钮夹回视口内（初始化 / resize / orientationchange / 打开弹框时调用）
  function clampFabPos() {
    if (!fabEl || fabEl.style.display === 'none') return;
    if (!fabEl.style.right || fabEl.style.right === 'auto') return; // 未拖动过：CSS 右下角定位，自适应无需处理
    const w = fabEl.offsetWidth, h = fabEl.offsetHeight;
    const vp = viewportSize();
    const maxRight = Math.max(FAB_MARGIN, vp.w - w - FAB_MARGIN);
    const maxBottom = Math.max(FAB_MARGIN, vp.h - h - FAB_MARGIN);
    const right = Math.min(Math.max(parseFloat(fabEl.style.right) || 0, FAB_MARGIN), maxRight);
    const bottom = Math.min(Math.max(parseFloat(fabEl.style.bottom) || 0, FAB_MARGIN), maxBottom);
    applyFabEdge(right, bottom);
    // 位置被修正时回存，下次打开即用修正后的偏移
    const cur = store.get(KEY.fabPos, null);
    if (!cur || cur.right !== Math.round(right) || cur.bottom !== Math.round(bottom)) {
      store.set(KEY.fabPos, { right: Math.round(right), bottom: Math.round(bottom) });
    }
  }

  function restoreFabPos() {
    const pos = store.get(KEY.fabPos, null);
    if (!pos || typeof pos !== 'object') return;
    if (typeof pos.right === 'number' && typeof pos.bottom === 'number') {
      applyFabEdge(pos.right, pos.bottom);
      return;
    }
    // 兼容旧格式 {x, y}（left/top 绝对坐标）：换算成右/下边缘偏移。
    // 初始化时 offsetWidth 可能还是 0（未布局），用一个保守估值，避免算出越界偏移；
    // 真正的精确夹取由随后的 clampFabPos() 在布局稳定后完成。
    if (typeof pos.x === 'number' && typeof pos.y === 'number') {
      const w = fabEl.offsetWidth || 100, h = fabEl.offsetHeight || 40;
      const vp = viewportSize();
      applyFabEdge(Math.max(FAB_MARGIN, vp.w - pos.x - w), Math.max(FAB_MARGIN, vp.h - pos.y - h));
    }
  }

  function onFabDown(e) {
    if (e.button !== 0) return;
    const rect = fabEl.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    let moved = false;
    fabEl._dragMoved = false;

    const onMove = (ev) => {
      const dx = ev.clientX - offX - rect.left;
      const dy = ev.clientY - offY - rect.top;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      fabEl._dragMoved = true;
      const w = fabEl.offsetWidth, h = fabEl.offsetHeight;
      const vp = viewportSize();
      // 目标 left/top 直接换算成右/下边缘偏移并夹取，任何窗口尺寸下都不会出界
      const maxRight = Math.max(FAB_MARGIN, vp.w - w - FAB_MARGIN);
      const maxBottom = Math.max(FAB_MARGIN, vp.h - h - FAB_MARGIN);
      const right = Math.min(Math.max(vp.w - (ev.clientX - offX) - w, FAB_MARGIN), maxRight);
      const bottom = Math.min(Math.max(vp.h - (ev.clientY - offY) - h, FAB_MARGIN), maxBottom);
      applyFabEdge(right, bottom);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) {
        // 存右/下边缘偏移：之后窗口怎么缩放，按钮都相对边缘定位，不会跑出屏幕
        store.set(KEY.fabPos, {
          right: Math.round(parseFloat(fabEl.style.right) || 0),
          bottom: Math.round(parseFloat(fabEl.style.bottom) || 0),
        });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function onFabClick() {
    if (fabEl._dragMoved) { fabEl._dragMoved = false; return; }
    openModal();
  }

  function buildModal() {
    rootEl = el('div');
    rootEl.id = 'm3u8-t-root';
    rootEl.setAttribute('data-theme', currentTheme());
    rootEl.style.display = 'none';
    document.body.appendChild(rootEl);

    maskEl = el('div');
    maskEl.id = 'm3u8-t-mask';
    panelEl = el('div');
    panelEl.id = 'm3u8-t-panel';

    const head = el('div', 'm3u8-t-head');
    const title = el('h2', 'm3u8-t-title');
    titleTextEl = el('span', null, CONFIG.workflowName + ' · 手动触发');
    titleSmallEl = el('small', null, repoPath() + ' · ' + currentWorkflow());
    title.append(titleTextEl, titleSmallEl);
    wfLink = el('a', null, 'Actions 页面 ↗');
    wfLink.target = '_blank';
    wfLink.rel = 'noopener';
    wfLink.style.cssText = 'font-size:12px;color:#8250df;text-decoration:none;font-weight:600';
    updateWorkflowLabels();
    const closeBtn = el('button', 'm3u8-t-close', '✕');
    closeBtn.type = 'button';
    closeBtn.title = '关闭（Esc）';
    closeBtn.addEventListener('click', closeModal);
    const headRight = el('div');
    headRight.style.cssText = 'display:flex;align-items:center;gap:14px';
    headRight.append(wfLink, closeBtn);
    head.append(title, headRight);

    const body = el('div', 'm3u8-t-body');

    // --- Tab 切换：GitHub Action / aria2 本地下载 ---
    const tabBar = el('div', 'm3u8-t-tabs');
    tabGithubEl = el('button', 'm3u8-t-tab active', 'GitHub Action 触发');
    tabGithubEl.type = 'button';
    tabGithubEl.addEventListener('click', () => setActiveTab('github'));
    tabAriaEl = el('button', 'm3u8-t-tab', '通过 aria2 下载');
    tabAriaEl.type = 'button';
    tabAriaEl.addEventListener('click', () => setActiveTab('aria2'));
    tabBar.append(tabGithubEl, tabAriaEl);
    body.appendChild(tabBar);

    githubPaneEl = el('div', 'm3u8-t-pane');
    githubPaneEl.dataset.pane = 'github';
    ariaPaneEl = el('div', 'm3u8-t-pane');
    ariaPaneEl.dataset.pane = 'aria2';
    ariaPaneEl.style.display = 'none';

    // --- Token 区 ---
    const tokenSec = el('div', 'm3u8-t-section');
    tokenSec.appendChild(el('h3', null, 'GitHub Token'));
    const tokenRow = el('div', 'm3u8-t-tokenrow');
    tokenInput = el('input', 'm3u8-t-input');
    tokenInput.id = 'm3u8-t-token';
    tokenInput.type = 'password';
    tokenInput.placeholder = 'ghp_… / github_pat_…';
    tokenInput.value = store.get(KEY.token, '');
    const tokenSave = el('button', 'm3u8-t-btn', '保存并验证');
    tokenSave.type = 'button';
    tokenSave.addEventListener('click', saveToken);
    const tokenClear = el('button', 'm3u8-t-btn m3u8-t-btn-danger', '清除');
    tokenClear.type = 'button';
    tokenClear.addEventListener('click', clearToken);
    tokenRow.append(tokenInput, tokenSave, tokenClear);
    tokenSec.appendChild(tokenRow);
    tokenSec.appendChild(el('div', 'm3u8-t-hint',
      '仅保存在本浏览器 Tampermonkey 存储。经典 PAT 需勾选 repo scope；细粒度 PAT 需 Actions: read+write、Contents: read。触发 workflow 必须有该仓库写权限。'));
    githubPaneEl.appendChild(tokenSec);

    // --- 参数区 ---
    const formSec = el('div', 'm3u8-t-section');
    formSec.appendChild(el('h3', null, '触发参数（workflow_dispatch inputs）'));

    pageSrcRow = el('div', 'm3u8-t-row');
    const pageSrcLabel = el('label', 'm3u8-t-label', '页面快照 · 从哪个文件提取');
    pageSrcLabel.htmlFor = 'm3u8-t-pagesrc';
    pageSrcSelect = el('select', 'm3u8-t-select');
    pageSrcSelect.id = 'm3u8-t-pagesrc';
    pageSrcSelect.addEventListener('change', () => autoFillFromPage());
    pageSrcRow.append(pageSrcLabel, pageSrcSelect);
    pageSrcRow.appendChild(el('div', 'm3u8-t-hint',
      '默认自动选中最近提交的快照（保存网页 HTML 到 ' + CONFIG.pageDirs[0] + ' 并推送即可）；切换后立即重新提取'));
    if (videoSource() !== 'repo') pageSrcRow.style.display = 'none';
    formSec.appendChild(pageSrcRow);

    formEl = el('div');
    formEl.id = 'm3u8-t-form';
    INPUTS.forEach((spec) => formEl.appendChild(buildRow(spec)));
    const urlsRow = formEl.querySelector('[data-key="urls"]');
    if (urlsRow) {
      const urlsBox = urlsRow.closest('.m3u8-t-row');
      if (urlsBox) {
        urlsBox.appendChild(el('div', 'm3u8-t-hint', videoSource() === 'live'
          ? '打开弹框时自动提取当前页面的下载地址与标题（URL 写本栏，标题写入上方 save_name；两者都不保存，每次打开都会重新提取）'
          : '打开弹框时自动从上方选中的快照提取下载地址与标题（URL 写本栏，标题写入上方 save_name；两者都不保存，每次打开都会重新提取，可点「载入页面视频」手动刷新）'));
      }
    }
    formSec.appendChild(formEl);

    // 触发目标：用户名 / 仓库名 / workflow
    const ownerRow = el('div', 'm3u8-t-row');
    const ownerLabel = el('label', 'm3u8-t-label', 'owner · 用户名');
    ownerLabel.htmlFor = 'm3u8-t-owner';
    ownerInput = el('input', 'm3u8-t-input');
    ownerInput.id = 'm3u8-t-owner';
    ownerInput.value = store.get(KEY.owner, '') || CONFIG.owner;
    ownerInput.placeholder = CONFIG.owner;
    ownerInput.spellcheck = false;
    ownerInput.addEventListener('input', () => {
      const segs = splitTarget(ownerInput.value);
      if (segs.length) ownerInput.value = segs[0];
      fillCounterpart(repoInput, KEY.repo, segs, 1);
      store.set(KEY.owner, ownerInput.value.trim());
      updateWorkflowLabels();
    });
    ownerRow.append(ownerLabel, ownerInput);
    ownerRow.appendChild(el('div', 'm3u8-t-hint',
      '仓库属主（用户 / 组织名，如 octocat）；直接粘贴 https://github.com/<用户名>/<仓库名> 也会自动拆解'));
    formSec.appendChild(ownerRow);

    const repoRow = el('div', 'm3u8-t-row');
    const repoLabel = el('label', 'm3u8-t-label', 'repo · 仓库名');
    repoLabel.htmlFor = 'm3u8-t-repo';
    repoInput = el('input', 'm3u8-t-input');
    repoInput.id = 'm3u8-t-repo';
    repoInput.value = store.get(KEY.repo, '') || CONFIG.repo;
    repoInput.placeholder = CONFIG.repo;
    repoInput.spellcheck = false;
    repoInput.addEventListener('input', () => {
      const segs = splitTarget(repoInput.value);
      if (segs.length) repoInput.value = segs[segs.length - 1];
      fillCounterpart(ownerInput, KEY.owner, segs, 0);
      store.set(KEY.repo, repoInput.value.trim());
      updateWorkflowLabels();
    });
    repoRow.append(repoLabel, repoInput);
    repoRow.appendChild(el('div', 'm3u8-t-hint',
      '仓库名（如 gh-toolbox，不带 .git 后缀）；与上方 owner 共同决定触发哪个仓库的 Action'));
    formSec.appendChild(repoRow);

    const wfRow = el('div', 'm3u8-t-row');
    const wfLabel = el('label', 'm3u8-t-label', 'workflow · 触发哪个 Action');
    wfLabel.htmlFor = 'm3u8-t-workflow';
    workflowInput = el('input', 'm3u8-t-input');
    workflowInput.id = 'm3u8-t-workflow';
    workflowInput.value = store.get(KEY.workflow, '') || CONFIG.workflowFile;
    workflowInput.placeholder = CONFIG.workflowFile;
    workflowInput.spellcheck = false;
    workflowInput.addEventListener('input', () => {
      store.set(KEY.workflow, workflowInput.value.trim());
      updateWorkflowLabels();
    });
    wfRow.append(wfLabel, workflowInput);
    wfRow.appendChild(el('div', 'm3u8-t-hint',
      'workflow 文件名（.github/workflows/ 下的，如 m3u8.yml / ytdlp.yml；粘贴完整路径也可）；留空用默认 ' + CONFIG.workflowFile));
    formSec.appendChild(wfRow);

    // 分支
    const refRow = el('div', 'm3u8-t-row');
    const refLabel = el('label', 'm3u8-t-label', 'ref · 触发分支');
    refInput = el('input', 'm3u8-t-input');
    refInput.id = 'm3u8-t-ref';
    refInput.value = store.get(KEY.ref, '') || detectBranch() || CONFIG.defaultBranch;
    refInput.placeholder = CONFIG.defaultBranch;
    refInput.addEventListener('input', () => store.set(KEY.ref, refInput.value.trim()));
    refRow.append(refLabel, refInput, el('div', 'm3u8-t-hint', 'workflow 所在分支（workflow_dispatch 目标 ref）'));
    formSec.appendChild(refRow);

    githubPaneEl.appendChild(formSec);

    // --- 操作区 ---
    const actionSec = el('div', 'm3u8-t-section');
    const actions = el('div', 'm3u8-t-actions');
    triggerBtn = el('button', 'm3u8-t-btn m3u8-t-btn-primary', '触发 Action');
    triggerBtn.type = 'button';
    triggerBtn.addEventListener('click', onTrigger);
    const resetBtn = el('button', 'm3u8-t-btn', '重置参数');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', resetForm);
    const loadPageBtn = el('button', 'm3u8-t-btn', '载入页面视频');
    loadPageBtn.type = 'button';
    loadPageBtn.title = videoSource() === 'live'
      ? '重新从当前页面提取视频直链与标题（强制覆盖 urls/save_name）'
      : '重新从选中的快照读取并解析（强制覆盖 urls/save_name）';
    loadPageBtn.addEventListener('click', () => autoFillFromPage());
    actions.append(triggerBtn, resetBtn, loadPageBtn);
    actionSec.appendChild(actions);
    statusEl = el('div', 'm3u8-t-status');
    actionSec.appendChild(statusEl);
    runStatusEl = el('div');
    runStatusEl.style.marginTop = '8px';
    actionSec.appendChild(runStatusEl);
    githubPaneEl.appendChild(actionSec);

    // --- 最近运行 ---
    const runsSec = el('div', 'm3u8-t-section');
    const runsHead = el('div');
    runsHead.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px';
    runsHead.appendChild(el('h3', null, '最近运行'));
    const refreshRuns = el('button', 'm3u8-t-btn', '刷新');
    refreshRuns.type = 'button';
    refreshRuns.addEventListener('click', refreshRecentRuns);
    runsHead.appendChild(refreshRuns);
    runsSec.appendChild(runsHead);
    runsEl = el('ul', 'm3u8-t-runs');
    runsSec.appendChild(runsEl);
    githubPaneEl.appendChild(runsSec);

    // --- aria2 tab ---
    buildAriaPane(ariaPaneEl);

    body.append(githubPaneEl, ariaPaneEl);
    panelEl.append(head, body);
    maskEl.appendChild(panelEl);
    maskEl.addEventListener('click', (e) => { if (e.target === maskEl) closeModal(); });
    rootEl.appendChild(maskEl);
  }

  function buildRow(spec) {
    const row = el('div', 'm3u8-t-row');
    const cid = 'm3u8-t-' + (spec.aria ? 'aria2-' : '') + spec.key;
    const storeKey = (spec.aria ? 'aria2_' : '') + spec.key;
    let input;
    if (spec.type === 'checkbox') {
      row.classList.add('m3u8-t-row-check');
      input = el('input', 'm3u8-t-check');
      input.type = 'checkbox';
      input.id = cid;
      input.dataset.key = spec.key;
      const label = el('label', 'm3u8-t-check-label', spec.label);
      label.htmlFor = cid;
      row.append(input, label);
    } else {
      const label = el('label', 'm3u8-t-label', spec.label);
      label.htmlFor = cid;
      if (spec.type === 'textarea') {
        input = el('textarea', 'm3u8-t-textarea');
      } else if (spec.type === 'select') {
        input = el('select', 'm3u8-t-select');
        spec.options.forEach((opt) => {
          const o = el('option', null, opt);
          o.value = opt;
          input.appendChild(o);
        });
      } else {
        input = el('input', 'm3u8-t-input');
        input.type = spec.type === 'number' ? 'number' : (spec.type === 'password' ? 'password' : 'text');
        if (spec.type === 'number') { input.min = '0'; input.step = '1'; }
      }
      input.id = cid;
      input.dataset.key = spec.key;
      if (spec.placeholder) input.placeholder = spec.placeholder;
      row.append(label, input);
    }
    if (spec.hint) row.appendChild(el('div', 'm3u8-t-hint', spec.hint));
    // 持久化：任何输入即保存（urls / save_name 除外——它们每次打开都重新提取，不落盘）
    if (!NO_SAVE[spec.key]) {
      input.addEventListener('input', () => {
        const v = spec.type === 'checkbox' ? input.checked : input.value;
        store.set(KEY.form(storeKey), v);
      });
      input.addEventListener('change', () => {
        const v = spec.type === 'checkbox' ? input.checked : input.value;
        store.set(KEY.form(storeKey), v);
      });
    }
    // 恢复已存值（urls / save_name 不恢复，交给 autoFillFromPage 每次重新提取）
    if (NO_SAVE[spec.key]) {
      if (spec.type === 'checkbox') input.checked = !!spec.default;
      else input.value = String(spec.default === undefined ? '' : spec.default);
    } else {
      const saved = store.get(KEY.form(storeKey), undefined);
      if (saved !== undefined && saved !== null) {
        if (spec.type === 'checkbox') input.checked = !!saved;
        else input.value = saved;
      } else if (spec.key === 'headers') {
        // 视频站页面：构建时即默认带上 UA + Referer（当前站点 origin）；
        // 仓库页站点未知先留空，快照提取成功后由 autoFillFromPage 补
        input.value = onVideoPage() ? defaultHeaders(location.origin + '/') : '';
      } else if (spec.default !== undefined) {
        if (spec.type === 'checkbox') input.checked = !!spec.default;
        else input.value = String(spec.default);
      }
    }
    return row;
  }

  // ---------------------------------------------------------------------------
  // aria2 tab：本地/局域网 aria2 JSON-RPC 下载
  // ---------------------------------------------------------------------------
  function buildAriaPane(pane) {
    ariaFormEl = pane; // 作为查询根（rpc/secret/urls... 的 data-key 在各 section 中）

    // 连接
    const connSec = el('div', 'm3u8-t-section');
    connSec.appendChild(el('h3', null, 'aria2 连接'));
    ARIA2_INPUTS.filter((s) => s.key === 'rpc' || s.key === 'secret')
      .forEach((s) => connSec.appendChild(buildRow(s)));
    const connActions = el('div', 'm3u8-t-actions');
    ariaTestBtn = el('button', 'm3u8-t-btn', '测试连接');
    ariaTestBtn.type = 'button';
    ariaTestBtn.addEventListener('click', onAriaTest);
    connActions.appendChild(ariaTestBtn);
    connSec.appendChild(connActions);
    pane.appendChild(connSec);

    // 下载参数（只显示 aria2 能生效的字段）
    const paramSec = el('div', 'm3u8-t-section');
    paramSec.appendChild(el('h3', null, '下载参数'));
    paramSec.appendChild(el('div', 'm3u8-t-hint',
      '打开弹框会自动提取视频直链（urls / save_name 不保存）。这里只显示 aria2 能生效的字段；select_video / mux_format / thread_count / extra_args 与 HF 上传属于 GitHub Action，请在左侧使用。m3u8 需要支持 HLS 的 aria2 版本（如 aria2-next），否则只会下载到播放列表文件本身。'));
    ARIA2_INPUTS.filter((s) => s.key !== 'rpc' && s.key !== 'secret')
      .forEach((s) => paramSec.appendChild(buildRow(s)));
    pane.appendChild(paramSec);

    // 操作
    const actionSec = el('div', 'm3u8-t-section');
    const actions = el('div', 'm3u8-t-actions');
    ariaTriggerBtn = el('button', 'm3u8-t-btn m3u8-t-btn-primary', '添加到 aria2');
    ariaTriggerBtn.type = 'button';
    ariaTriggerBtn.addEventListener('click', onAriaDownload);
    const ariaResetBtn = el('button', 'm3u8-t-btn', '重置参数');
    ariaResetBtn.type = 'button';
    ariaResetBtn.addEventListener('click', resetAriaForm);
    const ariaLoadBtn = el('button', 'm3u8-t-btn', '载入页面视频');
    ariaLoadBtn.type = 'button';
    ariaLoadBtn.title = '重新从当前页面/快照提取视频直链与标题（同时更新两个 tab）';
    ariaLoadBtn.addEventListener('click', () => autoFillFromPage());
    actions.append(ariaTriggerBtn, ariaResetBtn, ariaLoadBtn);
    actionSec.appendChild(actions);
    ariaStatusEl = el('div', 'm3u8-t-status');
    actionSec.appendChild(ariaStatusEl);
    pane.appendChild(actionSec);

    // 任务列表
    const taskSec = el('div', 'm3u8-t-section');
    taskSec.appendChild(el('h3', null, 'aria2 任务'));
    ariaTasksEl = el('ul', 'm3u8-t-runs');
    taskSec.appendChild(ariaTasksEl);
    pane.appendChild(taskSec);
  }

  function setActiveTab(name, persist) {
    const aria = name === 'aria2';
    if (!githubPaneEl || !ariaPaneEl) return;
    githubPaneEl.style.display = aria ? 'none' : '';
    ariaPaneEl.style.display = aria ? '' : 'none';
    if (tabGithubEl) tabGithubEl.classList.toggle('active', !aria);
    if (tabAriaEl) tabAriaEl.classList.toggle('active', aria);
    if (wfLink) wfLink.style.display = aria ? 'none' : '';
    updateWorkflowLabels();
    if (persist !== false) store.set(KEY.tab, aria ? 'aria2' : 'github');
  }

  function setAriaStatus(text, kind) {
    if (!ariaStatusEl) return;
    ariaStatusEl.textContent = text;
    ariaStatusEl.className = 'm3u8-t-status ' + (kind || 'info');
  }

  // 提取/载入的提示同时显示在两个 tab 的状态栏
  function setAnyStatus(text, kind) {
    setStatus(text, kind);
    if (ariaStatusEl) setAriaStatus(text, kind);
  }

  function ariaSettings() {
    const val = (key, dflt) => {
      const n = ariaFormEl && ariaFormEl.querySelector('[data-key="' + key + '"]');
      return (n && n.value.trim()) || dflt;
    };
    return { rpc: val('rpc', CONFIG.aria2Rpc), secret: val('secret', CONFIG.aria2Secret) };
  }

  // aria2 JSON-RPC：GM_xmlhttpRequest 跨源（不受页面 CORS 限制），失败回退 fetch
  function ariaRpc(method, params) {
    return new Promise((resolve, reject) => {
      const { rpc, secret } = ariaSettings();
      if (!/^https?:\/\//i.test(rpc)) {
        reject(new Error('RPC 地址需以 http:// 或 https:// 开头：' + rpc));
        return;
      }
      const payload = {
        jsonrpc: '2.0',
        id: 'm3u8-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        method,
        params: secret ? ['token:' + secret].concat(params || []) : (params || []),
      };
      const body = JSON.stringify(payload);
      const handle = (status, text) => {
        let data;
        try { data = JSON.parse(text || '{}'); }
        catch (e) { reject(new Error('RPC 返回非 JSON（HTTP ' + status + '）：' + String(text || '').slice(0, 120))); return; }
        if (data.error) {
          reject(new Error((data.error.message || 'aria2 返回错误') + '（code ' + data.error.code + '）'));
          return;
        }
        resolve(data.result);
      };
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST', url: rpc,
          headers: { 'Content-Type': 'application/json' },
          data: body, timeout: 15000,
          onload: (r) => handle(r.status, r.responseText),
          onerror: () => reject(new Error('无法连接 aria2 RPC：' + rpc)),
          ontimeout: () => reject(new Error('aria2 RPC 超时：' + rpc)),
        });
      } else {
        fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
          .then((r) => r.text().then((t) => handle(r.status, t)))
          .catch((e) => reject(new Error('无法连接 aria2 RPC：' + rpc + '（' + e.message + '）')));
      }
    });
  }

  // headers 输入 → aria2 header 数组；支持 JSON 对象和每行 Name: Value
  function ariaHeaderList(raw) {
    const s = String(raw || '').trim();
    if (!s) return [];
    if (s.charAt(0) === '{') {
      const o = JSON.parse(s);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('顶层必须是对象');
      return Object.keys(o).map((k) => k + ': ' + o[k]);
    }
    return s.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && line.charAt(0) !== '#')
      .map((line) => {
        if (line.indexOf(':') < 0) throw new Error('缺少冒号：' + line + '（格式 Name: Value）');
        return line;
      });
  }

  async function onAriaTest() {
    ariaTestBtn.disabled = true;
    const { rpc } = ariaSettings();
    setAriaStatus('正在连接 ' + rpc + ' …', 'info');
    try {
      const v = await ariaRpc('aria2.getVersion', []);
      const feats = Array.isArray(v.enabledFeatures) ? v.enabledFeatures : [];
      const hls = feats.some((f) => /HLS/i.test(f));
      setAriaStatus('连接成功：' + (v.product || 'aria2') + ' ' + v.version + '（RPC ' + (v.rpcVersion || '?') + '）' +
        (hls ? ' · 支持 HLS' : ' · 不支持 HLS（m3u8 只会下载列表文件）'), hls ? 'ok' : 'info');
    } catch (e) {
      setAriaStatus('连接失败：' + e.message + '。请确认 aria2 已用 --enable-rpc 启动，且地址/密钥正确', 'err');
    } finally {
      ariaTestBtn.disabled = false;
    }
  }

  async function onAriaDownload() {
    const inputs = collectInputs(ariaFormEl, ARIA2_INPUTS);
    const err = validateInputs(inputs);
    if (err) { setAriaStatus('参数校验失败：' + err, 'err'); return; }

    const urls = String(inputs.urls || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!urls.length) { setAriaStatus('请先填写下载地址（urls）', 'err'); return; }

    let headerList;
    try { headerList = ariaHeaderList(inputs.headers); }
    catch (e) { setAriaStatus('headers 解析失败：' + e.message, 'err'); return; }

    // aria2 选项（值必须是字符串）
    const opts = {
      'allow-overwrite': inputs.overwrite ? 'true' : 'false',
      'auto-file-renaming': 'false',
    };
    if (inputs.proxy) opts['all-proxy'] = inputs.proxy;
    if (inputs.dir) opts.dir = inputs.dir;
    if (headerList.length) opts.header = headerList;
    if (inputs.aria2) {
      opts.split = '16';
      opts['max-connection-per-server'] = '16';
      opts['min-split-size'] = '1M';
    }
    // save_name 只在单链接时作为 out（多链接同名会互相覆盖）
    if (urls.length === 1 && inputs.save_name) opts.out = sanitizeFileName(inputs.save_name);

    ariaTriggerBtn.disabled = true;
    ariaTriggerBtn.textContent = '添加中…';
    setAriaStatus('正在添加 ' + urls.length + ' 个任务到 ' + ariaSettings().rpc + ' …', 'info');
    ariaTasksEl.innerHTML = '';
    const gids = [];
    const failed = [];
    try {
      for (const url of urls) {
        try { gids.push(await ariaRpc('aria2.addUri', [[url], opts])); }
        catch (e) {
          failed.push(url + ' → ' + e.message);
          if (!gids.length) break; // RPC 不可达时不必逐条重试
        }
      }
      if (!gids.length) {
        setAriaStatus('添加到 aria2 失败：' + failed.join('；'), 'err');
        return;
      }
      setAriaStatus('已添加 ' + gids.length + ' 个任务' +
        (failed.length ? '，失败 ' + failed.length + ' 个：' + failed.join('；') : '') +
        (urls.length > 1 && inputs.save_name ? '（多链接时 save_name 不生效，由 aria2 按 URL 命名）' : ''),
        failed.length ? 'err' : 'ok');
      renderAriaTasks(gids.map((gid) => ({ gid, status: 'waiting' })));
      pollAriaTasks(++ariaPollToken, gids);
    } finally {
      ariaTriggerBtn.disabled = false;
      ariaTriggerBtn.textContent = '添加到 aria2';
    }
  }

  function ariaBadgeClass(status) {
    if (status === 'complete') return 'completed-success';
    if (status === 'error' || status === 'removed') return 'completed-failure';
    if (status === 'active') return 'in_progress';
    return 'queued';
  }

  function ariaBadgeText(status) {
    const map = { waiting: '等待中', active: '下载中', paused: '已暂停', complete: '完成',
      error: '失败', removed: '已移除' };
    return map[status] || status || '未知';
  }

  function fmtSize(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
    return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function renderAriaTasks(items) {
    ariaTasksEl.innerHTML = '';
    (items || []).forEach((st) => {
      const li = el('li');
      const badge = el('span', 'm3u8-t-badge ' + ariaBadgeClass(st.status), ariaBadgeText(st.status));
      const file = st.files && st.files[0] && st.files[0].path ? basename(st.files[0].path) : '';
      const name = el('span', null, file || st.gid || '');
      let metaText = ' · ' + (st.gid || '');
      const total = Number(st.totalLength) || 0;
      const done = Number(st.completedLength) || 0;
      if (total > 0) metaText += ' · ' + Math.floor((done / total) * 100) + '%（' + fmtSize(done) + ' / ' + fmtSize(total) + '）';
      if (Number(st.downloadSpeed) > 0) metaText += ' · ' + fmtSize(st.downloadSpeed) + '/s';
      li.append(badge, document.createTextNode(' '), name, el('span', 'm3u8-t-runmeta', metaText));
      if (st.errorMessage) li.appendChild(el('div', 'm3u8-t-hint', st.errorMessage));
      ariaTasksEl.appendChild(li);
    });
  }

  async function pollAriaTasks(my, gids) {
    const t0 = Date.now();
    while (my === ariaPollToken && Date.now() - t0 < CONFIG.aria2PollMs) {
      const items = [];
      for (const gid of gids) {
        try {
          items.push(await ariaRpc('aria2.tellStatus',
            [gid, ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'errorMessage', 'files']]));
        } catch (e) {
          items.push({ gid, status: 'error', errorMessage: e.message });
        }
      }
      renderAriaTasks(items);
      const done = items.every((s) => s.status === 'complete' || s.status === 'error' || s.status === 'removed');
      if (done) return;
      await sleep(CONFIG.aria2PollInterval);
    }
  }

  function resetAriaForm() {
    ARIA2_INPUTS.forEach((spec) => {
      if (!NO_SAVE[spec.key]) store.del(KEY.form((spec.aria ? 'aria2_' : '') + spec.key));
    });
    ARIA2_INPUTS.forEach((spec) => {
      const node = ariaFormEl.querySelector('[data-key="' + spec.key + '"]');
      if (!node) return;
      if (spec.type === 'checkbox') node.checked = !!spec.default;
      else node.value = String(spec.default === undefined ? '' : spec.default);
    });
    setAriaStatus('aria2 参数已重置为默认值', 'info');
  }

  function detectBranch() {
    if (location.hostname !== 'github.com') return '';
    const m = location.pathname.match(/^\/[^/]+\/[^/]+\/(?:tree|blob)\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // ---------------------------------------------------------------------------
  // 表单收集与校验
  // ---------------------------------------------------------------------------
  function collectInputs(root, specs) {
    const scope = root || formEl;
    const defs = specs || INPUTS;
    const inputs = {};
    defs.forEach((spec) => {
      const node = scope.querySelector('[data-key="' + spec.key + '"]');
      if (!node) return;
      inputs[spec.key] = spec.type === 'checkbox' ? !!node.checked : node.value.trim();
    });
    return inputs;
  }

  function validateInputs(inputs) {
    if (inputs.thread_count !== undefined && inputs.thread_count !== '' && !/^\d+$/.test(inputs.thread_count)) {
      return 'thread_count 必须是正整数';
    }
    if (inputs.headers && inputs.headers.startsWith('{')) {
      try { JSON.parse(inputs.headers); }
      catch (e) { return 'headers 不是合法的 JSON：' + e.message; }
    }
    return null;
  }

  function resetForm() {
    INPUTS.forEach((spec) => {
      if (NO_SAVE[spec.key]) return;
      store.del(KEY.form(spec.key));
    });
    INPUTS.forEach((spec) => {
      const node = formEl.querySelector('[data-key="' + spec.key + '"]');
      if (!node) return;
      if (spec.type === 'checkbox') node.checked = !!spec.default;
      else node.value = String(spec.default === undefined ? '' : spec.default);
    });
    setStatus('参数已重置为默认值', 'info');
  }

  // ---------------------------------------------------------------------------
  // Token 保存 / 清除
  // ---------------------------------------------------------------------------
  async function saveToken() {
    const token = tokenInput.value.trim();
    if (!token) { setStatus('请先粘贴 GitHub Token', 'err'); return; }
    setStatus('正在验证 Token…', 'info');
    try {
      const r = await api('GET', '/repos/' + repoPath(), undefined, token);
      if (r.status === 200) {
        store.set(KEY.token, token);
        setStatus('Token 验证通过，已保存（可访问 ' + repoPath() + '）', 'ok');
        refreshRecentRuns();
      } else if (r.status === 401) {
        setStatus('Token 无效或已过期（HTTP 401），请检查后重试', 'err');
      } else if (r.status === 404) {
        setStatus('Token 无权访问该仓库（HTTP 404）：请确认 PAT 覆盖 ' + repoPath() + ' 且 scope 正确', 'err');
      } else {
        setStatus('验证失败（HTTP ' + r.status + '）：' + extractError(r), 'err');
      }
    } catch (e) {
      setStatus('验证请求异常：' + e.message, 'err');
    }
  }

  function clearToken() {
    store.del(KEY.token);
    tokenInput.value = '';
    runsEl.innerHTML = '';
    runsEl.appendChild(el('li', 'm3u8-t-empty', '未配置 Token'));
    setStatus('已清除本地保存的 Token', 'info');
  }

  // ---------------------------------------------------------------------------
  // 触发 + 状态轮询
  // ---------------------------------------------------------------------------
  let pollToken = 0;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'm3u8-t-status ' + (kind || 'info');
  }

  async function onTrigger() {
    const token = (store.get(KEY.token, '') || '').trim();
    if (!token) { setStatus('请先在上方填写并保存 GitHub Token', 'err'); return; }
    const inputs = collectInputs();
    const err = validateInputs(inputs);
    if (err) { setStatus('参数校验失败：' + err, 'err'); return; }
    const ref = refInput.value.trim() || CONFIG.defaultBranch;
    const wf = currentWorkflow();
    const my = ++pollToken;

    triggerBtn.disabled = true;
    triggerBtn.textContent = '触发中…';
    setStatus('正在触发 ' + repoPath() + ' 的 ' + wf + '（ref=' + ref + '）…', 'info');
    runStatusEl.innerHTML = '';
    const triggeredAt = Date.now();
    try {
      const r = await api('POST', '/repos/' + repoPath() +
        '/actions/workflows/' + encodeURIComponent(wf) + '/dispatches', { ref, inputs });
      if (r.status === 204) {
        setStatus('已触发成功，正在获取运行状态…', 'ok');
        await pollRun(my, triggeredAt, wf);
        refreshRecentRuns();
      } else if (r.status === 401) {
        setStatus('触发失败：Token 无效或权限不足（HTTP 401）。触发 workflow 需要 repo（或 Actions: write）权限', 'err');
      } else if (r.status === 422 && /unexpected inputs/i.test(extractError(r))) {
        setStatus('触发失败（HTTP 422）：目标 workflow 没有声明本次提交的 inputs。' +
          '常见原因：①本地改过 .github/workflows/' + wf + ' 还没 commit + push；' +
          '②ref 指向的分支上是旧版 workflow；③手填的仓库/workflow 与参数不匹配。' +
          '原始报错：' + extractError(r), 'err');
      } else {
        setStatus('触发失败（HTTP ' + r.status + '）：' + extractError(r), 'err');
      }
    } catch (e) {
      setStatus('触发请求异常：' + e.message, 'err');
    } finally {
      if (my === pollToken) {
        triggerBtn.disabled = false;
        triggerBtn.textContent = '触发 Action';
      }
    }
  }

  async function pollRun(my, triggeredAt, wf) {
    let run = null;
    const t0 = Date.now();
    while (Date.now() - t0 < POLL_FIND_RUN_MS) {
      if (my !== pollToken) return;
      try {
        const r = await api('GET', '/repos/' + repoPath() +
          '/actions/workflows/' + encodeURIComponent(wf) + '/runs?per_page=5&event=workflow_dispatch');
        if (r.status !== 200) {
          renderRunStatus(null, '查询运行列表失败（HTTP ' + r.status + '）：' + extractError(r));
          return;
        }
        const data = JSON.parse(r.responseText);
        const runs = (data && data.workflow_runs) || [];
        run = runs.find((x) => new Date(x.created_at).getTime() >= triggeredAt - 30000) || null;
        if (run) break;
      } catch (e) {
        renderRunStatus(null, '查询运行列表异常：' + e.message);
        return;
      }
      await sleep(POLL_FIND_INTERVAL);
    }
    if (!run) {
      renderRunStatus(null, '已触发，但未在 ' + Math.round(POLL_FIND_RUN_MS / 1000) +
        ' 秒内匹配到新运行（可能仍在排队），可前往 Actions 页面查看');
      return;
    }

    while (Date.now() - t0 < POLL_RUN_MS) {
      if (my !== pollToken) return;
      renderRunStatus(run, null);
      if (run.status === 'completed') return;
      await sleep(POLL_RUN_INTERVAL);
      try {
        const r = await api('GET', '/repos/' + repoPath() + '/actions/runs/' + run.id);
        if (r.status !== 200) {
          renderRunStatus(run, '刷新运行状态失败（HTTP ' + r.status + '）：' + extractError(r));
          return;
        }
        run = JSON.parse(r.responseText);
      } catch (e) {
        renderRunStatus(run, '刷新运行状态异常：' + e.message);
        return;
      }
    }
    renderRunStatus(run, '轮询超时，运行可能仍在进行，可前往 Actions 页面查看');
  }

  function runBadgeClass(run) {
    return run.status === 'completed' ? 'completed-' + (run.conclusion || 'unknown') : (run.status || 'unknown');
  }

  function runBadgeText(run) {
    if (run.status === 'completed') {
      const map = { success: '成功', failure: '失败', cancelled: '已取消', skipped: '已跳过',
        startup_failure: '启动失败', timed_out: '超时', action_required: '待处理',
        neutral: '中性', stale: '过期' };
      return map[run.conclusion] || (run.conclusion || 'completed');
    }
    if (run.status === 'queued') return '排队中';
    if (run.status === 'in_progress') return '进行中';
    if (run.status === 'waiting') return '等待中';
    return run.status || '';
  }

  function renderRunStatus(run, errText) {
    runStatusEl.innerHTML = '';
    if (errText) {
      const p = el('div', 'm3u8-t-status err', errText);
      runStatusEl.appendChild(p);
    }
    if (!run) return;
    const box = el('div', 'm3u8-t-status info');
    const badge = el('span', 'm3u8-t-badge ' + runBadgeClass(run), runBadgeText(run));
    const link = el('a', null, '查看运行/日志 ↗');
    link.href = run.html_url;
    link.target = '_blank';
    link.rel = 'noopener';
    const meta = el('span', 'm3u8-t-runmeta',
      '  · ' + currentWorkflow() + ' #' + (run.run_number || '') + ' · ' + (run.head_branch || '') + ' · ' + relTime(run.created_at));
    box.append(badge, document.createTextNode(' '), link, meta);
    runStatusEl.appendChild(box);
  }

  async function refreshRecentRuns() {
    const token = (store.get(KEY.token, '') || '').trim();
    runsEl.innerHTML = '';
    if (!token) {
      runsEl.appendChild(el('li', 'm3u8-t-empty', '配置 Token 后显示最近运行'));
      return;
    }
    runsEl.appendChild(el('li', 'm3u8-t-empty', '加载中…'));
    try {
      const r = await api('GET', '/repos/' + repoPath() +
        '/actions/workflows/' + encodeURIComponent(currentWorkflow()) + '/runs?per_page=5');
      if (r.status !== 200) {
        runsEl.innerHTML = '';
        runsEl.appendChild(el('li', 'm3u8-t-empty', '加载失败（HTTP ' + r.status + '）：' + extractError(r)));
        return;
      }
      const runs = (JSON.parse(r.responseText).workflow_runs) || [];
      runsEl.innerHTML = '';
      if (!runs.length) {
        runsEl.appendChild(el('li', 'm3u8-t-empty', '暂无运行记录'));
        return;
      }
      runs.forEach((run) => {
        const li = el('li');
        const badge = el('span', 'm3u8-t-badge ' + runBadgeClass(run), runBadgeText(run));
        const link = el('a', null, '#' + (run.run_number || ''));
        link.href = run.html_url;
        link.target = '_blank';
        link.rel = 'noopener';
        li.append(badge, link, el('span', 'm3u8-t-runmeta',
          run.head_branch + ' · ' + (run.event || '') + ' · ' + relTime(run.created_at)));
        runsEl.appendChild(li);
      });
    } catch (e) {
      runsEl.innerHTML = '';
      runsEl.appendChild(el('li', 'm3u8-t-empty', '加载异常：' + e.message));
    }
  }

  // ---------------------------------------------------------------------------
  // 弹框开关
  // ---------------------------------------------------------------------------
  function openModal() {
    tokenInput.value = store.get(KEY.token, '') || tokenInput.value;
    rootEl.style.display = '';
    applyTheme();
    updateWorkflowLabels();
    setActiveTab(store.get(KEY.tab, 'github') === 'aria2' ? 'aria2' : 'github', false);
    clampFabPos(); // 弹框打开前确保按钮在屏内（弹框会挡住它，但不能让它跑到屏幕外）
    refreshRecentRuns();
    autoFillFromPage(); // 打开弹框即重新提取视频链接与标题（urls/save_name 不持久化）
  }

  function closeModal() {
    rootEl.style.display = 'none';
    pollToken++; // 作废进行中的轮询
    ariaPollToken++; // 作废 aria2 任务轮询
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && rootEl.style.display !== 'none') closeModal();
  }

  // ---------------------------------------------------------------------------
  // 主题 & URL 监听
  // ---------------------------------------------------------------------------
  function applyTheme() {
    rootEl.setAttribute('data-theme', currentTheme());
  }

  function onLocationMaybeChanged() {
    if (!pageAllowed()) {
      fabEl.style.display = 'none';
      closeModal();
    } else {
      fabEl.style.display = '';
    }
  }

  function watchLocation() {
    const wrap = (fn) => function () {
      const ret = fn.apply(this, arguments);
      setTimeout(onLocationMaybeChanged, 0);
      return ret;
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', onLocationMaybeChanged);
    window.addEventListener('turbo:load', () => { onLocationMaybeChanged(); applyTheme(); });
    window.addEventListener('turbo:render', onLocationMaybeChanged);
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => applyTheme();
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------
  function init() {
    if (!pageAllowed()) return;
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(CSS);
    } else {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    buildFab();
    buildModal();
    watchLocation();
    window.addEventListener('keydown', onKeydown);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
