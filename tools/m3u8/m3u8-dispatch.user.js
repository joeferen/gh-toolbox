// ==UserScript==
// @name         gh-toolbox m3u8 一键触发器
// @namespace    https://gh-toolbox/m3u8
// @version      1.0.0
// @description  在 gh-toolbox 仓库页面或 jable.tv / pornhub 视频页显示悬浮按钮，点击弹框填写参数，一键手动触发「N_m3u8DL-RE 下载器」GitHub Action（workflow_dispatch）；自动从仓库页面快照或当前视频页提取视频直链与标题填入 urls/rename 参数，并轮询展示运行状态与最近运行记录。
// @match        https://github.com/*/gh-toolbox*
// @match        https://jable.tv/videos/*
// @match        https://*.pornhub.com/view_video.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @connect      raw.githubusercontent.com
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
 *   1. 在 gh-toolbox 仓库页面、jable.tv / pornhub 视频页右下角显示悬浮按钮（可拖动）；
 *   2. 点击按钮打开弹框，填写 workflow_dispatch 参数（与 .github/workflows/m3u8.yml
 *      的 inputs 一一对应，见下方 INPUTS 定义）；
 *   3. 打开弹框时自动提取当前视频的直链与标题，写入参数（提取值不持久化，每次
 *      打开都重新提取）：
 *        - 视频站页面（jable.tv / pornhub）：从实时页面提取；
 *        - GitHub 仓库页：从仓库快照目录 CONFIG.pageDirs（默认 tools/m3u8/html/）
 *          下的 *.html 快照提取。默认自动选中最近提交的快照，可下拉切换；
 *        - urls   ← 只写视频直链本身（纯 URL，一行一个，无注释行）；
 *        - rename ← 视频标题（文件名安全化）。
 *      urls / rename 不保存，每次打开弹框都会重新提取；headers 栏为空时默认
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
    autoFillRename: true,
    // 支持的视频站页面（@match 已限定路径，这里兜底再判一次主机名/路径）
    videoSites: [
      { host: /(^|\.)jable\.tv$/, path: /^\/videos\// },
      { host: /(^|\.)pornhub\.com$/, path: /^\/view_video\.php/ },
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
      hint: '不含扩展名（如 myvideo）；留空按 URL 自动派生（同名已存在则跳过）',
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
    {
      key: 'rename', label: 'rename · 输出文件名备注', type: 'text', default: '',
      hint: '自动填入页面视频标题（仅供备注参考；实际文件名由 save_name/URL 派生决定）',
      placeholder: 'myvideo',
    },
  ];

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
  };

  // urls（下载链接）与 rename（标题备注）不持久化：每次打开弹框重新提取
  const NO_SAVE = { urls: true, rename: true };

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
      while ((m = re2.exec(html)) !== null) raws.push(m[1]);
    }
    if (!raws.length) {
      const re3 = /(https?:\\?\/\\?\/[^\s'"<>()]+?\.(?:m3u8|mp4|mpd)(?:\?[^\s'"<>()]*)?)/gi;
      while ((m = re3.exec(html)) !== null) raws.push(m[1]);
    }
    const norm = [];
    raws.forEach((r) => {
      const u = decodeEntities(unescapeJsString(r)).trim();
      if (!u || norm.indexOf(u) !== -1) return;
      if (!/^https?:\/\//i.test(u)) return;
      norm.push(u);
    });
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
    const urlsNode = formEl.querySelector('[data-key="urls"]');
    const renameNode = formEl.querySelector('[data-key="rename"]');
    if (!urlsNode) return;

    const src = videoSource();
    setStatus(src === 'live'
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
          setStatus('未发现页面快照：请把保存的网页 HTML 放到仓库 ' + CONFIG.pageDirs[0] +
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
          setStatus('所有快照均无法提取视频：' + tried.join('；') +
            '。请确认保存的是视频详情页（含播放器 script），且已提交推送', 'err');
          return;
        }
      }
      if (!parsed.videos.length) {
        setStatus(src === 'live'
          ? '当前页面未找到视频直链。请确认在视频详情页打开（jable.tv /videos/xxx、pornhub /view_video.php）'
          : '页面中未找到视频直链，请确认保存的是视频详情页（含播放器 script）', 'err');
        return;
      }
      const lines = parsed.videos.map((v) => v.url);
      urlsNode.value = lines.join('\n');
      if (CONFIG.autoFillRename && renameNode && parsed.title) {
        renameNode.value = sanitizeFileName(parsed.title);
      }
      const headersNode = formEl.querySelector('[data-key="headers"]');
      if (headersNode && (!headersNode.value.trim() || isGeneratedHeaders(headersNode.value))) {
        const dh = defaultHeaders(parsed.pageUrl);
        headersNode.value = dh;
        store.set(KEY.form('headers'), dh);
      }
      setStatus('已载入 ' + parsed.videos.length + ' 个视频' + (parsed.title ? '：' + parsed.title : '') +
        '（来源：' + srcLabel + '）', 'ok');
    } catch (e) {
      setStatus('读取页面视频异常：' + e.message, 'err');
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
#m3u8-t-fab{position:fixed;right:24px;bottom:96px;z-index:2147483000;display:flex;align-items:center;gap:6px;
  padding:10px 16px;border-radius:999px;background:#8250df;color:#fff;font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;
  cursor:pointer;user-select:none;box-shadow:0 4px 14px rgba(31,35,40,.25);border:1px solid rgba(27,31,36,.15);touch-action:none}
#m3u8-t-fab:hover{background:#7440dc}
#m3u8-t-mask{position:fixed;inset:0;z-index:2147483001;background:rgba(31,35,40,.5);display:flex;align-items:center;justify-content:center;padding:20px}
#m3u8-t-panel{width:min(720px,94vw);max-height:88vh;overflow:auto;background:#fff;color:#1f2328;border:1px solid #d1d9e0;border-radius:12px;
  box-shadow:0 8px 40px rgba(31,35,40,.28);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
#m3u8-t-root[data-theme="dark"] #m3u8-t-fab{background:#8957e5;border-color:#a371f7}
#m3u8-t-root[data-theme="dark"] #m3u8-t-fab:hover{background:#9e6ffa}
#m3u8-t-root[data-theme="dark"] #m3u8-t-mask{background:rgba(1,4,9,.7)}
#m3u8-t-root[data-theme="dark"] #m3u8-t-panel{background:#0d1117;color:#e6edf3;border-color:#30363d}
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
    workflowInput, ownerInput, repoInput, titleTextEl, titleSmallEl, wfLink;

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
  }

  function restoreFabPos() {
    const pos = store.get(KEY.fabPos, null);
    if (pos && typeof pos === 'object' && typeof pos.x === 'number' && typeof pos.y === 'number') {
      fabEl.style.left = pos.x + 'px';
      fabEl.style.top = pos.y + 'px';
      fabEl.style.right = 'auto';
      fabEl.style.bottom = 'auto';
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
      const x = Math.min(Math.max(ev.clientX - offX, 4), window.innerWidth - w - 4);
      const y = Math.min(Math.max(ev.clientY - offY, 4), window.innerHeight - h - 4);
      fabEl.style.left = x + 'px';
      fabEl.style.top = y + 'px';
      fabEl.style.right = 'auto';
      fabEl.style.bottom = 'auto';
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) {
        const rect2 = fabEl.getBoundingClientRect();
        store.set(KEY.fabPos, { x: Math.round(rect2.left), y: Math.round(rect2.top) });
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
    body.appendChild(tokenSec);

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
          ? '打开弹框时自动提取当前页面的下载地址（只放 URL 本身，标题写入 rename 备注；本栏不保存，每次打开都会重新提取）'
          : '打开弹框时自动从上方选中的快照提取下载地址（只放 URL 本身；本栏不保存，每次打开都会重新提取，可点「载入页面视频」手动刷新）'));
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

    body.appendChild(formSec);

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
      ? '重新从当前页面提取视频直链与标题（强制覆盖 urls/rename）'
      : '重新从选中的快照读取并解析（强制覆盖 urls/rename）';
    loadPageBtn.addEventListener('click', () => autoFillFromPage());
    actions.append(triggerBtn, resetBtn, loadPageBtn);
    actionSec.appendChild(actions);
    statusEl = el('div', 'm3u8-t-status');
    actionSec.appendChild(statusEl);
    runStatusEl = el('div');
    runStatusEl.style.marginTop = '8px';
    actionSec.appendChild(runStatusEl);
    body.appendChild(actionSec);

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
    body.appendChild(runsSec);

    panelEl.append(head, body);
    maskEl.appendChild(panelEl);
    maskEl.addEventListener('click', (e) => { if (e.target === maskEl) closeModal(); });
    rootEl.appendChild(maskEl);
  }

  function buildRow(spec) {
    const row = el('div', 'm3u8-t-row');
    const cid = 'm3u8-t-' + spec.key;
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
        input.type = spec.type === 'number' ? 'number' : 'text';
        if (spec.type === 'number') { input.min = '0'; input.step = '1'; }
      }
      input.id = cid;
      input.dataset.key = spec.key;
      if (spec.placeholder) input.placeholder = spec.placeholder;
      row.append(label, input);
    }
    if (spec.hint) row.appendChild(el('div', 'm3u8-t-hint', spec.hint));
    if (!NO_SAVE[spec.key]) {
      input.addEventListener('input', () => {
        const v = spec.type === 'checkbox' ? input.checked : input.value;
        store.set(KEY.form(spec.key), v);
      });
      input.addEventListener('change', () => {
        const v = spec.type === 'checkbox' ? input.checked : input.value;
        store.set(KEY.form(spec.key), v);
      });
    }
    if (NO_SAVE[spec.key]) {
      if (spec.type === 'checkbox') input.checked = !!spec.default;
      else input.value = String(spec.default === undefined ? '' : spec.default);
    } else {
      const saved = store.get(KEY.form(spec.key), undefined);
      if (saved !== undefined && saved !== null) {
        if (spec.type === 'checkbox') input.checked = !!saved;
        else input.value = saved;
      } else if (spec.key === 'headers') {
        input.value = onVideoPage() ? defaultHeaders(location.origin + '/') : '';
      } else if (spec.default !== undefined) {
        if (spec.type === 'checkbox') input.checked = !!spec.default;
        else input.value = String(spec.default);
      }
    }
    return row;
  }

  function detectBranch() {
    if (location.hostname !== 'github.com') return '';
    const m = location.pathname.match(/^\/[^/]+\/[^/]+\/(?:tree|blob)\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // ---------------------------------------------------------------------------
  // 表单收集与校验
  // ---------------------------------------------------------------------------
  function collectInputs() {
    const inputs = {};
    INPUTS.forEach((spec) => {
      const node = formEl.querySelector('[data-key="' + spec.key + '"]');
      if (!node) return;
      if (spec.key === 'rename') return; // 备注字段，不是 workflow input，不随 dispatch 提交
      inputs[spec.key] = spec.type === 'checkbox' ? !!node.checked : node.value.trim();
    });
    return inputs;
  }

  function validateInputs(inputs) {
    if (inputs.thread_count !== '' && !/^\d+$/.test(inputs.thread_count)) {
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
    refreshRecentRuns();
    autoFillFromPage();
  }

  function closeModal() {
    rootEl.style.display = 'none';
    pollToken++;
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
