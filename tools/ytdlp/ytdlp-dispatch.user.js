// ==UserScript==
// @name         gh-toolbox ytdlp 一键触发器
// @namespace    https://gh-toolbox/ytdlp
// @version      1.6.1
// @description  在 gh-toolbox 仓库页面或 jable.tv / pornhub 视频页显示悬浮按钮，点击弹框填写参数，一键手动触发「yt-dlp 下载器」GitHub Action（workflow_dispatch）；自动从仓库页面快照或当前视频页提取视频直链与标题填入 urls/rename 参数，并轮询展示运行状态与最近运行记录。
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
 * gh-toolbox / ytdlp 油猴触发器
 * --------------------------------
 * 功能：
 *   1. 在 gh-toolbox 仓库页面（github.com/<owner>/gh-toolbox）、jable.tv 视频页
 *      （https://jable.tv/videos/*）、pornhub 视频页
 *      （https://*.pornhub.com/view_video.php*）右下角显示悬浮按钮（可拖动）；
 *   2. 点击按钮打开弹框，填写 workflow_dispatch 参数（与 .github/workflows/ytdlp.yml
 *      的 inputs 一一对应，见下方 INPUTS 定义）；
 *   3. 打开弹框时自动提取当前视频的直链与标题，写入参数（提取值不持久化，每次
 *      打开都重新提取）：
 *        - 视频站页面（jable.tv / pornhub）：从实时页面提取；
 *        - GitHub 仓库页：从仓库快照目录 CONFIG.pageDirs（默认 tools/ytdlp/html/，
 *          兼容旧路径 tools/ytdlp/http/）下的 *.html 快照提取。默认自动选中
 *          **最近提交**的快照（commits API 取提交时间），也可用弹框内的「页面快照」
 *          下拉切换；拉取走 raw.githubusercontent.com，失败回退 contents API；
 *        - urls   ← 只写视频直链本身（纯 URL，一行一个，无注释行）；
 *        - rename ← 视频标题（文件名安全化）。
 *      urls / rename 不保存，每次打开弹框都会重新提取（避免把上一个视频的链接
 *      带进下一次）；headers 栏为空时默认带上 UA + Referer（站点 origin）；
 *      其余表单项全部按 host 持久化；
 *   4. 触发目标**三者全部用户手填、不写死**：弹框内「owner · 用户名」「repo · 仓库名」
 *      「workflow · 触发哪个 Action」（均可粘贴完整 URL/路径自动拆解；留空才兜底
 *      CONFIG 默认值），配置 GitHub Token（PAT）后点击「触发 Action」调用
 *      POST /repos/<owner>/<repo>/actions/workflows/<workflow>/dispatches，
 *      弹框标题 / Actions 链接 / Token 验证 / 页面快照拉取 / 运行状态 / 最近运行
 *      全部跟随这三个填写值；
 *   5. 触发后自动轮询新运行状态（queued -> in_progress -> completed），
 *      并展示最近 5 次运行记录，可直接跳转 Actions 页面/日志。
 *
 * 页面视频提取规则（extractPageVideos）：
 *   - jable.tv：内联脚本 `hlsUrl = '...m3u8'`；
 *   - pornhub：flashvars mediaDefinitions 里的 `"videoUrl": "..."`（JSON 转义
 *     `\/` 先反转义），多清晰度（240P/480P/720P_4000K_xxx.mp4/master.m3u8）
 *     取最高；`/video/get_media?s=...` 下载端点不进 urls；
 *   - 标题：og:title > .video-info h4 > <title>（按 canonical 主机名剥掉站点后缀，
 *     如 " - Pornhub.com" / " - Jable.TV | ..."）。
 *
 * Token 权限：
 *   - 经典 PAT：repo scope；
 *   - 细粒度 PAT：Actions: read+write、Contents: read、Metadata: read。
 *   Token 仅存于本浏览器 Tampermonkey 存储，不会外发。
 *   持久化的 key 按「当前 host」隔离（如 ytdlp_trigger_github.com_token），不同
 *   站点各自记忆各自的填写值。
 *   （页面快照走 raw.githubusercontent.com 公开拉取，无需 Token；
 *    目录列举与提交时间走 api.github.com，公开仓库无 Token 也可用（限流 60/h）；
 *    刚推送的文件 raw CDN 约 5 分钟生效，届时自动回退 contents API。）
 *
 * 复用：其他工具（如 qinglong）复制本脚本后改 CONFIG 与 INPUTS 两处即可。
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 配置：目标仓库与默认 workflow（改这里即可复用到其他工具）
  // 注意：实际触发哪个 Action 由用户在弹框里手填（见「workflow · 触发哪个 Action」），
  // CONFIG.workflowFile 仅作留空时的兜底默认值。
  // ---------------------------------------------------------------------------
  const CONFIG = {
    owner: '',                        // 留空 = 仓库页对任意属主的 <repo> 生效；也可填用户名限定
    repo: 'gh-toolbox',
    workflowFile: 'ytdlp.yml',        // 默认 workflow 文件名（.github/workflows/ 下）
    workflowName: 'yt-dlp 下载器',
    defaultBranch: 'main',
    fabLabel: '▶ yt-dlp',
    storagePrefix: 'ytdlp_trigger_',
    // 仓库内页面快照：GitHub 仓库页打开弹框时自动拉取解析（视频站页面则直接解析实时页面）。
    // pageDirs 下的 *.html 会被自动发现（需列举目录，公开仓库无 Token 也可用）；
    // pageFiles 是已知快照的兜底列表（目录列举不可用时仍能工作）。
    pageDirs: ['tools/ytdlp/html', 'tools/ytdlp/http'],
    pageFiles: [
      'tools/ytdlp/html/jable.tv.html',
      'tools/ytdlp/html/pornhub.com.html',
    ],
    // 自动把提取到的视频标题写入 rename 参数（仅当为空或仍是上次自动填入值）
    autoFillRename: true,
    // 支持的视频站页面（@match 已限定路径，这里兜底再判一次主机名/路径）
    videoSites: [
      { host: /(^|\.)jable\.tv$/, path: /^\/videos\// },
      { host: /(^|\.)pornhub\.com$/, path: /^\/view_video\.php/ },
    ],
  };

  // workflow_dispatch 输入定义（与 ytdlp.yml 的 inputs 一一对应，顺序即表单顺序）
  const INPUTS = [
    {
      key: 'urls', label: 'urls · 下载目标', type: 'textarea', default: '',
      hint: '每行一个：视频 / 播放列表 / 直链 / M3U8 URL；留空则使用仓库 tools/ytdlp/urls.txt',
      placeholder: 'https://www.youtube.com/watch?v=...\nhttps://example.com/video.m3u8',
    },
    {
      key: 'format', label: 'format · 格式表达式', type: 'text', default: '',
      hint: '如 bv*+ba/b、best[height<=1080]、best；留空用脚本默认 bv*+ba/b',
      placeholder: 'bv*+ba/b',
    },
    {
      key: 'playlist_end', label: 'playlist_end · 播放列表上限', type: 'number', default: '0',
      hint: '每个播放列表最多下载几个视频，0 = 不限制',
      placeholder: '0',
    },
    {
      key: 'overwrite', label: 'overwrite · 覆盖已存在文件', type: 'checkbox', default: false,
      hint: '勾选 = 强制重新下载并覆盖已存在的文件；不勾选 = 先检查目标文件，已存在则跳过',
    },
    {
      key: 'transcode', label: 'transcode · 转码为 MP4', type: 'select', default: 'none',
      options: ['none', 'remux', 'recode'],
      hint: 'none = 不转（TS 流如实命名 .ts）；remux = 换封装流拷贝（快/无损）；recode = 重编码 H.264+AAC（慢/有损）',
    },
    {
      key: 'aria2', label: 'aria2 · 多连接加速', type: 'checkbox', default: false,
      hint: '勾选后 workflow 自动安装 aria2c 多连接下载',
    },
    {
      key: 'hf_upload', label: 'hf_upload · 上传 HF datasets', type: 'checkbox', default: false,
      hint: '下载完成后上传到 Hugging Face datasets（需仓库 Secret YTDLP_HF_TOKEN）',
    },
    {
      key: 'hf_repo', label: 'hf_repo · HF 仓库 ID', type: 'text', default: '',
      hint: '格式 用户名/数据集名；留空则用 Secret YTDLP_HF_REPO',
      placeholder: 'myuser/my-videos',
    },
    {
      key: 'hf_path', label: 'hf_path · 上传子目录', type: 'text', default: '',
      hint: '上传到数据集仓库内的子目录，留空 = 根路径',
      placeholder: 'videos/2024',
    },
    {
      key: 'rename', label: 'rename · 输出文件名', type: 'text', default: '',
      hint: '不含扩展名（如 myvideo）；也可传含 % 的模板（如 %(title)s）；留空用默认命名',
      placeholder: 'myvideo',
    },
    {
      key: 'headers', label: 'headers · 自定义请求头', type: 'textarea', default: '',
      hint: '默认已带 UA + Referer（按站点自动生成，可自行修改）；单行 JSON；带 Cookie 会自动加载为 cookies',
      placeholder: '{"User-Agent":"Mozilla/5.0 ...","Referer":"https://example.com/"}',
    },
    {
      key: 'impersonate', label: 'impersonate · TLS 指纹伪装', type: 'text', default: '',
      hint: '过 Cloudflare 反爬挑战：留空/0 = 关闭；1 或 chrome = 伪装 Chrome；也可填 safari、chrome-131',
      placeholder: '1',
    },
  ];

  const REPO_PREFIX = CONFIG.owner ? `https://github.com/${CONFIG.owner}/${CONFIG.repo}` : '';
  const API_BASE = 'https://api.github.com';
  const POLL_FIND_RUN_MS = 60000;   // 触发后寻找新运行的最长等待
  const POLL_RUN_MS = 600000;       // 运行状态轮询的最长总时长（10 分钟）
  const POLL_FIND_INTERVAL = 3000;
  const POLL_RUN_INTERVAL = 5000;
  const SNAP_CACHE_MS = 120000;      // 快照候选列表缓存时长（秒级缓存，减少 API 调用）

  // ---------------------------------------------------------------------------
  // 存储封装：优先 Tampermonkey GM_*，降级 localStorage。
  // key 按「当前 host」隔离（github.com / jable.tv / cn.pornhub.com 各存各的），
  // 同一油猴脚本在不同站点打开弹框，各自记忆各自的填写值。
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
      } catch (e) { /* 忽略存储失败（如隐私模式） */ }
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
    snapCache: 'snap_cache',         // 快照候选列表 + 提交时间缓存（减少 API 调用）
    owner: 'owner',                  // 用户手填的触发目标用户名
    repo: 'repo',                    // 用户手填的触发目标仓库名
    workflow: 'workflow',            // 用户手填的触发目标 workflow 文件名
  };

  // 不持久化的表单项：下载链接（urls）与标题（rename，经 autoFillRename 自动带入）
  // 每次打开弹框都会从页面/快照重新提取，避免把上一个视频的链接带进下一次。
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

  // 无鉴权 HTTP 请求（GM_xmlhttpRequest 跨源；降级 fetch）
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

  // api.github.com 请求：有 Token 走鉴权（5000/h），无 Token 直连（公开仓库可用，60/h）
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

  // 主机名去子域名：cn.pornhub.com -> pornhub.com（用于剥 <title> 的站点后缀）
  function hostBrand(url) {
    try {
      const parts = new URL(url).hostname.toLowerCase().split('.');
      return parts.length >= 2 ? parts.slice(-2).join('.') : (parts[0] || '');
    } catch (e) { return ''; }
  }

  // 反转义 JS/JSON 字符串里的转义序列（pornhub 的 videoUrl 是 "https:\/\/..." 形式）
  function unescapeJsString(s) {
    return String(s || '')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
  }

  // 解码 HTML 实体：实时页面走 document.documentElement.outerHTML，序列化会把
  // script 里的 & 转成 &amp;（URL 查询串里的 & 全中招）；另存为的页面也可能带实体。
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

  // 多个清晰度里取最高（720P_4000K_xxx.mp4/master.m3u8 → 720）；无清晰度标记的排最后
  function pickBestVideo(urls) {
    let best = '', bestScore = -1;
    (urls || []).forEach((u) => {
      const m = u.match(/(\d{3,4})[Pp](?:_|\b)/);
      const score = m ? parseInt(m[1], 10) : 0;
      if (score > bestScore) { bestScore = score; best = u; }
    });
    return best;
  }

  // 发现仓库内的页面快照候选：CONFIG.pageFiles 兜底 + pageDirs 目录列举，
  // 再用 commits API 取每个文件的最近提交时间，按最新提交排序（默认选最新保存的）。
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
      } catch (e) { /* 忽略单个文件失败 */ }
      return { path: p, date: '' };
    }));
    // ISO 时间字典序即时间序；无时间的排在后面
    list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    store.set(KEY.snapCache, { ts: Date.now(), list });
    return list;
  }

  // 从仓库拉取指定快照文件文本：先 raw（公开免鉴权），失败回退 contents API（免 CDN 缓存）
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
    // 回退 contents API 需要 Token；没有 Token 时给出可操作的错误信息
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

  // 解析页面 HTML，提取视频直链与标题。
  // 返回 { title, pageUrl, videos: [{title, url}] }；videos 为空表示没找到直链。
  //   - 直链（按优先级，前者无结果才走后一种）：
  //     1) jable.tv：内联脚本 hlsUrl 赋值；
  //     2) pornhub：mediaDefinitions 里的 "videoUrl": "..."（JSON 转义，先反转义）；
  //     3) 兜底：页面里的 .m3u8 / .mp4 直链（兼容 https:\/\/ 转义形式）。
  //     多清晰度取最高（如 720P_4000K_xxx.mp4/master.m3u8）；get_media/download
  //     下载端点与预览片（preview/screenshot/thumbvtt）不作为候选。
  //   - 标题：og:title > .video-info h4 > <title>（按 canonical 主机名剥掉站点后缀，
  //     如 " - Pornhub.com" / " - Jable.TV | ..."）。
  //   - 页面地址：canonical > og:url（用于 defaultHeaders 的 Referer origin）。
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
      const re3 = /(https?:\\?\/\\?\/[^\s'"<>()]+?\.(?:m3u8|mp4)(?:\?[^\s'"<>()]*)?)/gi;
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

  // 文件名安全化：去掉文件系统非法字符（rename 参数用）
  function sanitizeFileName(name) {
    return String(name || '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  // 默认请求头：UA + Referer（headers 栏为空时的默认值）。
  // Referer 取站点 origin（如 https://jable.tv/）——CDN 防盗链一般只校验站点，
  // origin 级 Referer 对同站所有视频都有效，也避免按页缓存的 Referer 过期问题。
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

  // 判断 headers 当前值是否为脚本自动生成的默认头（键 ⊆ {User-Agent, Referer}）
  // ——是则允许在提取后按新站点覆盖刷新；用户自定义值（Cookie / 自定义键）不动
  function isGeneratedHeaders(v) {
    try {
      const o = JSON.parse(v);
      if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
      const keys = Object.keys(o);
      if (!keys.length || keys.length > 2) return false;
      return keys.every((k) => k === 'User-Agent' || k === 'Referer');
    } catch (e) { return false; }
  }

  // 自动提取并写入视频链接与标题（urls / rename 两项不持久化）：
  //   - 打开弹框时总是重新提取（每个视频提取最新一次，不把上一个的链接带进下一次）；
  //   - 点「载入页面视频」或切换快照下拉时同样立即重新提取；
  //   - 提取失败不清空已有填写值，只报错。
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
        // 填充/刷新快照下拉（保留当前有效选择）
        const keep = pageSrcSelect.value && cands.some((c) => c.path === pageSrcSelect.value) ? pageSrcSelect.value : '';
        fillPageSrcOptions(cands, keep);
        const chosen = pageSrcSelect.value || cands[0].path;
        // 探测顺序：下拉选中的优先，其余按提交时间先后补试
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
      const lines = parsed.videos.map((v) => v.url); // urls 只放下载地址本身，不放注释行（标题已在 rename）
      urlsNode.value = lines.join('\n'); // urls / rename 不持久化，仅写入弹框
      if (CONFIG.autoFillRename && renameNode && parsed.title) {
        renameNode.value = sanitizeFileName(parsed.title);
      }
      // headers 栏为空、或仍是脚本生成的默认头时，按提取到的站点补/换 UA + Referer；
      // 用户自定义值（带 Cookie / 自定义键）不动
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

  // 填充「页面快照」下拉选项；preferred 为希望保留的选中项（不在列表里则选第一项=最新）
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
  // 样式
  // ---------------------------------------------------------------------------
  const CSS = `
#ytdlp-t-fab{position:fixed;right:24px;bottom:96px;z-index:2147483000;display:flex;align-items:center;gap:6px;
  padding:10px 16px;border-radius:999px;background:#1f883d;color:#fff;font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;
  cursor:pointer;user-select:none;box-shadow:0 4px 14px rgba(31,35,40,.25);border:1px solid rgba(27,31,36,.15);touch-action:none}
#ytdlp-t-fab:hover{background:#1a7f37}
#ytdlp-t-mask{position:fixed;inset:0;z-index:2147483001;background:rgba(31,35,40,.5);display:flex;align-items:center;justify-content:center;padding:20px}
#ytdlp-t-panel{width:min(720px,94vw);max-height:88vh;overflow:auto;background:#fff;color:#1f2328;border:1px solid #d1d9e0;border-radius:12px;
  box-shadow:0 8px 40px rgba(31,35,40,.28);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
#ytdlp-t-root[data-theme="dark"] #ytdlp-t-fab{background:#238636;border-color:#3fb950}
#ytdlp-t-root[data-theme="dark"] #ytdlp-t-fab:hover{background:#2ea043}
#ytdlp-t-root[data-theme="dark"] #ytdlp-t-mask{background:rgba(1,4,9,.7)}
#ytdlp-t-root[data-theme="dark"] #ytdlp-t-panel{background:#0d1117;color:#e6edf3;border-color:#30363d}
.ytdlp-t-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid #d1d9e0;position:sticky;top:0;background:inherit;z-index:1}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-head{border-color:#30363d}
.ytdlp-t-title{font-size:16px;font-weight:600;margin:0}
.ytdlp-t-title small{font-weight:400;color:#57606a;margin-left:8px;font-size:12px}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-title small{color:#8b949e}
.ytdlp-t-close{border:none;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#57606a;padding:4px 8px;border-radius:6px}
.ytdlp-t-close:hover{background:#f3f4f6;color:#1f2328}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-close{color:#8b949e}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-close:hover{background:#21262d;color:#e6edf3}
.ytdlp-t-body{padding:16px 18px}
.ytdlp-t-section{margin:0 0 18px}
.ytdlp-t-section>h3{margin:0 0 10px;font-size:13px;font-weight:600;color:#57606a;text-transform:uppercase;letter-spacing:.04em}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-section>h3{color:#8b949e}
.ytdlp-t-row{margin-bottom:14px}
.ytdlp-t-row-check{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ytdlp-t-label{display:block;font-weight:600;margin-bottom:4px;font-size:13px}
.ytdlp-t-check-label{font-size:13px;font-weight:600;cursor:pointer}
.ytdlp-t-hint{font-size:12px;color:#57606a;margin-top:4px}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-hint{color:#8b949e}
.ytdlp-t-input,.ytdlp-t-select,.ytdlp-t-textarea{width:100%;box-sizing:border-box;padding:6px 10px;font:13px/1.4 inherit;color:inherit;background:#fff;
  border:1px solid #d1d9e0;border-radius:6px;outline:none}
.ytdlp-t-textarea{min-height:64px;resize:vertical;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,monospace;font-size:12px}
.ytdlp-t-input:focus,.ytdlp-t-select:focus,.ytdlp-t-textarea:focus{border-color:#0969da;box-shadow:0 0 0 3px rgba(9,105,218,.15)}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-input,#ytdlp-t-root[data-theme="dark"] .ytdlp-t-select,#ytdlp-t-root[data-theme="dark"] .ytdlp-t-textarea{background:#0d1117;border-color:#30363d}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-input:focus,#ytdlp-t-root[data-theme="dark"] .ytdlp-t-select:focus,#ytdlp-t-root[data-theme="dark"] .ytdlp-t-textarea:focus{border-color:#58a6ff;box-shadow:0 0 0 3px rgba(56,139,253,.25)}
.ytdlp-t-check{width:16px;height:16px;accent-color:#1f883d;cursor:pointer}
.ytdlp-t-tokenrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ytdlp-t-tokenrow .ytdlp-t-input{flex:1;min-width:220px}
.ytdlp-t-btn{border:1px solid #d1d9e0;background:#f6f8fa;color:#1f2328;font:600 13px/1.2 inherit;padding:7px 14px;border-radius:6px;cursor:pointer;white-space:nowrap}
.ytdlp-t-btn:hover{background:#f3f4f6;border-color:#afb8c1}
.ytdlp-t-btn:disabled{opacity:.6;cursor:not-allowed}
.ytdlp-t-btn-primary{background:#1f883d;border-color:rgba(27,31,36,.15);color:#fff}
.ytdlp-t-btn-primary:hover{background:#1a7f37;border-color:rgba(27,31,36,.15)}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-btn{background:#21262d;border-color:#30363d;color:#e6edf3}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-btn:hover{background:#30363d}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-btn-primary{background:#238636;color:#fff}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-btn-primary:hover{background:#2ea043}
.ytdlp-t-btn-danger{color:#cf222e}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-btn-danger{color:#f85149}
.ytdlp-t-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:4px}
.ytdlp-t-status{margin-top:12px;padding:10px 12px;border-radius:6px;font-size:13px;white-space:pre-wrap;word-break:break-all;display:none}
.ytdlp-t-status.ok{display:block;background:#dafbe1;color:#116329;border:1px solid #4ac26b}
.ytdlp-t-status.err{display:block;background:#ffebe9;color:#82071e;border:1px solid #ff8182}
.ytdlp-t-status.info{display:block;background:#ddf4ff;color:#0a3069;border:1px solid #54aeff}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-status.ok{background:rgba(46,160,67,.15);color:#3fb950;border-color:rgba(46,160,67,.4)}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-status.err{background:rgba(248,81,73,.15);color:#f85149;border-color:rgba(248,81,73,.4)}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-status.info{background:rgba(56,139,253,.15);color:#79c0ff;border-color:rgba(56,139,253,.4)}
.ytdlp-t-runs{list-style:none;margin:0;padding:0}
.ytdlp-t-runs li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #eaeef2;font-size:13px}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-runs li{border-color:#21262d}
.ytdlp-t-runs li:last-child{border-bottom:none}
.ytdlp-t-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:18px;white-space:nowrap}
.ytdlp-t-badge.queued{background:#fff8c5;color:#7d4e00}
.ytdlp-t-badge.in_progress{background:#ddf4ff;color:#0a3069}
.ytdlp-t-badge.completed-success{background:#dafbe1;color:#116329}
.ytdlp-t-badge.completed-failure{background:#ffebe9;color:#82071e}
.ytdlp-t-badge.completed-cancelled,.ytdlp-t-badge.completed-skipped{background:#f6f8fa;color:#57606a}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-badge.queued{background:rgba(187,128,9,.2);color:#d29922}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-badge.in_progress{background:rgba(56,139,253,.2);color:#79c0ff}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-badge.completed-success{background:rgba(46,160,67,.2);color:#3fb950}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-badge.completed-failure{background:rgba(248,81,73,.2);color:#f85149}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-badge.completed-cancelled,#ytdlp-t-root[data-theme="dark"] .ytdlp-t-badge.completed-skipped{background:#21262d;color:#8b949e}
.ytdlp-t-runmeta{color:#57606a;font-size:12px}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-runmeta{color:#8b949e}
.ytdlp-t-runs a{color:#0969da;text-decoration:none;font-weight:600}
.ytdlp-t-runs a:hover{text-decoration:underline}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-runs a{color:#58a6ff}
.ytdlp-t-empty{color:#57606a;font-size:13px;padding:6px 0}
#ytdlp-t-root[data-theme="dark"] .ytdlp-t-empty{color:#8b949e}
`;

  // ---------------------------------------------------------------------------
  // 页面位置判断（GitHub 是 Turbo SPA，需监听 URL 变化）
  // ---------------------------------------------------------------------------
  function inRepoPage() {
    const path = location.origin + location.pathname;
    if (CONFIG.owner) {
      // 限定属主：排除同前缀的其他仓库（如 myuser/gh-toolbox-old）
      return path === REPO_PREFIX || path.startsWith(REPO_PREFIX + '/');
    }
    // owner 未配置：任意属主的 <repo> 仓库页均生效（/gh-toolbox-old 等同前缀仓库不算）
    return new RegExp('^https://github\\.com/[^/]+/' + CONFIG.repo + '(/|$)').test(path);
  }

  // 视频站详情页（@match 已限定路径，这里按 CONFIG.videoSites 兜底再判一次）
  function onVideoPage() {
    return CONFIG.videoSites.some((s) => s.host.test(location.hostname) && s.path.test(location.pathname));
  }

  function pageAllowed() {
    return inRepoPage() || onVideoPage();
  }

  // 视频来源：'live' = 当前视频站实时页面；'repo' = 仓库快照文件
  function videoSource() {
    return onVideoPage() ? 'live' : 'repo';
  }

  // 当前触发目标 workflow：用户手填优先，留空兜底 CONFIG.workflowFile；
  // 兼容粘贴完整路径（.github/workflows/xxx.yml -> xxx.yml）
  function currentWorkflow() {
    const raw = (workflowInput && workflowInput.value.trim()) || store.get(KEY.workflow, '') || CONFIG.workflowFile;
    const wf = String(raw).trim().replace(/^\.?github\/workflows\//, '').replace(/^\/+/, '');
    return wf || CONFIG.workflowFile;
  }

  // 当前触发的用户名 / 仓库名：用户手填优先，留空兜底 CONFIG 默认值。
  // 两个栏都兼容粘贴 https://github.com/<用户名>/<仓库名>（自动拆段）。
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
    const v = segs.length >= 2 ? segs[1] : segs[0]; // 粘贴了 用户名/仓库名 形式时取第二段
    return v || CONFIG.repo;
  }

  function repoPath() {
    return currentOwner() + '/' + currentRepo();
  }

  // 拆解粘贴的 用户名/仓库名（兼容完整 URL / @前缀 / .git 后缀）
  function splitTarget(v) {
    const s = String(v || '').trim()
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/^@/, '')
      .replace(/\.git$/, '')
      .replace(/^\/+|\/+$/g, '');
    return s.split('/').filter(Boolean);
  }

  // 粘贴含「用户名/仓库名」两段时自动填对方一栏（粘贴是明确意图，总是覆盖；
  // 只打单段名时不动对方栏）
  function fillCounterpart(inputEl, key, segs, idx) {
    if (!inputEl || segs.length < 2) return;
    inputEl.value = segs[idx];
    store.set(key, segs[idx]);
  }

  // 弹框头部标题/副标题/Actions 链接跟随当前 workflow
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
    fabEl.id = 'ytdlp-t-fab';
    fabEl.title = onVideoPage()
      ? '点击触发 GitHub Action（自动带上当前页面视频，可拖动）'
      : '点击触发 GitHub Action（可拖动）';
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
    // 根容器（承载主题）
    rootEl = el('div');
    rootEl.id = 'ytdlp-t-root';
    rootEl.setAttribute('data-theme', currentTheme());
    rootEl.style.display = 'none';
    document.body.appendChild(rootEl);

    // 遮罩 + 面板
    maskEl = el('div');
    maskEl.id = 'ytdlp-t-mask';
    panelEl = el('div');
    panelEl.id = 'ytdlp-t-panel';

    // 头部（标题/副标题/链接随用户填写的 workflow 动态更新）
    const head = el('div', 'ytdlp-t-head');
    const title = el('h2', 'ytdlp-t-title');
    titleTextEl = el('span', null, CONFIG.workflowName + ' · 手动触发');
    titleSmallEl = el('small', null, repoPath() + ' · ' + currentWorkflow());
    title.append(titleTextEl, titleSmallEl);
    wfLink = el('a', null, 'Actions 页面 ↗');
    wfLink.target = '_blank';
    wfLink.rel = 'noopener';
    wfLink.style.cssText = 'font-size:12px;color:#0969da;text-decoration:none;font-weight:600';
    updateWorkflowLabels();
    const closeBtn = el('button', 'ytdlp-t-close', '✕');
    closeBtn.type = 'button';
    closeBtn.title = '关闭（Esc）';
    closeBtn.addEventListener('click', closeModal);
    const headRight = el('div');
    headRight.style.cssText = 'display:flex;align-items:center;gap:14px';
    headRight.append(wfLink, closeBtn);
    head.append(title, headRight);

    // 主体
    const body = el('div', 'ytdlp-t-body');

    // --- Token 区 ---
    const tokenSec = el('div', 'ytdlp-t-section');
    tokenSec.appendChild(el('h3', null, 'GitHub Token'));
    const tokenRow = el('div', 'ytdlp-t-tokenrow');
    tokenInput = el('input', 'ytdlp-t-input');
    tokenInput.id = 'ytdlp-t-token';
    tokenInput.type = 'password';
    tokenInput.placeholder = 'ghp_… / github_pat_…';
    tokenInput.value = store.get(KEY.token, '');
    const tokenSave = el('button', 'ytdlp-t-btn', '保存并验证');
    tokenSave.type = 'button';
    tokenSave.addEventListener('click', saveToken);
    const tokenClear = el('button', 'ytdlp-t-btn ytdlp-t-btn-danger', '清除');
    tokenClear.type = 'button';
    tokenClear.addEventListener('click', clearToken);
    tokenRow.append(tokenInput, tokenSave, tokenClear);
    tokenSec.appendChild(tokenRow);
    tokenSec.appendChild(el('div', 'ytdlp-t-hint',
      '仅保存在本浏览器 Tampermonkey 存储。经典 PAT 需勾选 repo scope；细粒度 PAT 需 Actions: read+write、Contents: read。触发 workflow 必须有该仓库写权限。'));
    body.appendChild(tokenSec);

    // --- 参数区 ---
    const formSec = el('div', 'ytdlp-t-section');
    formSec.appendChild(el('h3', null, '触发参数（workflow_dispatch inputs）'));

    // 页面快照选择（仅仓库页有意义；视频站页面用实时页面，隐藏）
    pageSrcRow = el('div', 'ytdlp-t-row');
    const pageSrcLabel = el('label', 'ytdlp-t-label', '页面快照 · 从哪个文件提取');
    pageSrcLabel.htmlFor = 'ytdlp-t-pagesrc';
    pageSrcSelect = el('select', 'ytdlp-t-select');
    pageSrcSelect.id = 'ytdlp-t-pagesrc';
    pageSrcSelect.addEventListener('change', () => autoFillFromPage());
    pageSrcRow.append(pageSrcLabel, pageSrcSelect);
    pageSrcRow.appendChild(el('div', 'ytdlp-t-hint',
      '默认自动选中最近提交的快照（保存网页 HTML 到 ' + CONFIG.pageDirs[0] + ' 并推送即可）；切换后立即重新提取'));
    if (videoSource() !== 'repo') pageSrcRow.style.display = 'none';
    formSec.appendChild(pageSrcRow);

    formEl = el('div');
    formEl.id = 'ytdlp-t-form';
    INPUTS.forEach((spec) => formEl.appendChild(buildRow(spec)));
    // urls 行下补充自动载入说明（按当前页面类型给出不同文案）
    const urlsRow = formEl.querySelector('[data-key="urls"]');
    if (urlsRow) {
      const urlsBox = urlsRow.closest('.ytdlp-t-row');
      if (urlsBox) {
        urlsBox.appendChild(el('div', 'ytdlp-t-hint', videoSource() === 'live'
          ? '打开弹框时自动提取当前页面的下载地址（只放 URL 本身，标题在 rename；本栏不保存，每次打开都会重新提取）'
          : '打开弹框时自动从上方选中的快照提取下载地址（只放 URL 本身；本栏不保存，每次打开都会重新提取，可点「载入页面视频」手动刷新'));
      }
    }
    formSec.appendChild(formEl);

    // 触发目标：用户名 / 仓库名 / workflow（全部用户手填，不写死；留空兜底 CONFIG 默认值）
    const ownerRow = el('div', 'ytdlp-t-row');
    const ownerLabel = el('label', 'ytdlp-t-label', 'owner · 用户名');
    ownerLabel.htmlFor = 'ytdlp-t-owner';
    ownerInput = el('input', 'ytdlp-t-input');
    ownerInput.id = 'ytdlp-t-owner';
    ownerInput.value = store.get(KEY.owner, '') || CONFIG.owner;
    ownerInput.placeholder = CONFIG.owner;
    ownerInput.spellcheck = false;
    ownerInput.addEventListener('input', () => {
      const segs = splitTarget(ownerInput.value);
      if (segs.length) ownerInput.value = segs[0]; // 归一化显示（剥 URL/@/.git）
      fillCounterpart(repoInput, KEY.repo, segs, 1);
      store.set(KEY.owner, ownerInput.value.trim());
      updateWorkflowLabels();
    });
    ownerRow.append(ownerLabel, ownerInput);
    ownerRow.appendChild(el('div', 'ytdlp-t-hint',
      '仓库属主（用户 / 组织名，如 octocat）；直接粘贴 https://github.com/<用户名>/<仓库名> 也会自动拆解'));
    formSec.appendChild(ownerRow);

    const repoRow = el('div', 'ytdlp-t-row');
    const repoLabel = el('label', 'ytdlp-t-label', 'repo · 仓库名');
    repoLabel.htmlFor = 'ytdlp-t-repo';
    repoInput = el('input', 'ytdlp-t-input');
    repoInput.id = 'ytdlp-t-repo';
    repoInput.value = store.get(KEY.repo, '') || CONFIG.repo;
    repoInput.placeholder = CONFIG.repo;
    repoInput.spellcheck = false;
    repoInput.addEventListener('input', () => {
      const segs = splitTarget(repoInput.value);
      if (segs.length) repoInput.value = segs[segs.length - 1]; // 取最后一段做仓库名
      fillCounterpart(ownerInput, KEY.owner, segs, 0);
      store.set(KEY.repo, repoInput.value.trim());
      updateWorkflowLabels();
    });
    repoRow.append(repoLabel, repoInput);
    repoRow.appendChild(el('div', 'ytdlp-t-hint',
      '仓库名（如 gh-toolbox，不带 .git 后缀）；与上方 owner 共同决定触发哪个仓库的 Action'));
    formSec.appendChild(repoRow);

    // 触发目标 workflow（用户手填，不写死；留空兜底 CONFIG.workflowFile）
    const wfRow = el('div', 'ytdlp-t-row');
    const wfLabel = el('label', 'ytdlp-t-label', 'workflow · 触发哪个 Action');
    wfLabel.htmlFor = 'ytdlp-t-workflow';
    workflowInput = el('input', 'ytdlp-t-input');
    workflowInput.id = 'ytdlp-t-workflow';
    workflowInput.value = store.get(KEY.workflow, '') || CONFIG.workflowFile;
    workflowInput.placeholder = CONFIG.workflowFile;
    workflowInput.spellcheck = false;
    workflowInput.addEventListener('input', () => {
      store.set(KEY.workflow, workflowInput.value.trim());
      updateWorkflowLabels();
    });
    wfRow.append(wfLabel, workflowInput);
    wfRow.appendChild(el('div', 'ytdlp-t-hint',
      'workflow 文件名（.github/workflows/ 下的，如 ytdlp.yml / qinglong.yml；粘贴完整路径也可）；与上方 owner/repo 共同决定触发目标，留空用默认 ' + CONFIG.workflowFile));
    formSec.appendChild(wfRow);

    // 分支
    const refRow = el('div', 'ytdlp-t-row');
    const refLabel = el('label', 'ytdlp-t-label', 'ref · 触发分支');
    refInput = el('input', 'ytdlp-t-input');
    refInput.id = 'ytdlp-t-ref';
    refInput.value = store.get(KEY.ref, '') || detectBranch() || CONFIG.defaultBranch;
    refInput.placeholder = CONFIG.defaultBranch;
    refInput.addEventListener('input', () => store.set(KEY.ref, refInput.value.trim()));
    refRow.append(refLabel, refInput, el('div', 'ytdlp-t-hint', 'workflow 所在分支（workflow_dispatch 目标 ref）'));
    formSec.appendChild(refRow);

    body.appendChild(formSec);

    // --- 操作区 ---
    const actionSec = el('div', 'ytdlp-t-section');
    const actions = el('div', 'ytdlp-t-actions');
    triggerBtn = el('button', 'ytdlp-t-btn ytdlp-t-btn-primary', '触发 Action');
    triggerBtn.type = 'button';
    triggerBtn.addEventListener('click', onTrigger);
    const resetBtn = el('button', 'ytdlp-t-btn', '重置参数');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', resetForm);
    const loadPageBtn = el('button', 'ytdlp-t-btn', '载入页面视频');
    loadPageBtn.type = 'button';
    loadPageBtn.title = videoSource() === 'live'
      ? '重新从当前页面提取视频直链与标题（强制覆盖 urls/rename）'
      : '重新从选中的快照读取并解析（强制覆盖 urls/rename）';
    loadPageBtn.addEventListener('click', () => autoFillFromPage());
    actions.append(triggerBtn, resetBtn, loadPageBtn);
    actionSec.appendChild(actions);
    statusEl = el('div', 'ytdlp-t-status');
    actionSec.appendChild(statusEl);
    runStatusEl = el('div');
    runStatusEl.style.marginTop = '8px';
    actionSec.appendChild(runStatusEl);
    body.appendChild(actionSec);

    // --- 最近运行 ---
    const runsSec = el('div', 'ytdlp-t-section');
    const runsHead = el('div');
    runsHead.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px';
    runsHead.appendChild(el('h3', null, '最近运行'));
    const refreshRuns = el('button', 'ytdlp-t-btn', '刷新');
    refreshRuns.type = 'button';
    refreshRuns.addEventListener('click', refreshRecentRuns);
    runsHead.appendChild(refreshRuns);
    runsSec.appendChild(runsHead);
    runsEl = el('ul', 'ytdlp-t-runs');
    runsSec.appendChild(runsEl);
    body.appendChild(runsSec);

    panelEl.append(head, body);
    maskEl.appendChild(panelEl);
    maskEl.addEventListener('click', (e) => { if (e.target === maskEl) closeModal(); });
    rootEl.appendChild(maskEl);
  }

  function buildRow(spec) {
    const row = el('div', 'ytdlp-t-row');
    const cid = 'ytdlp-t-' + spec.key;
    let input;
    if (spec.type === 'checkbox') {
      row.classList.add('ytdlp-t-row-check');
      input = el('input', 'ytdlp-t-check');
      input.type = 'checkbox';
      input.id = cid;
      input.dataset.key = spec.key;
      const label = el('label', 'ytdlp-t-check-label', spec.label);
      label.htmlFor = cid;
      row.append(input, label);
    } else {
      const label = el('label', 'ytdlp-t-label', spec.label);
      label.htmlFor = cid;
      if (spec.type === 'textarea') {
        input = el('textarea', 'ytdlp-t-textarea');
      } else if (spec.type === 'select') {
        input = el('select', 'ytdlp-t-select');
        spec.options.forEach((opt) => {
          const o = el('option', null, opt);
          o.value = opt;
          input.appendChild(o);
        });
      } else {
        input = el('input', 'ytdlp-t-input');
        input.type = spec.type === 'number' ? 'number' : 'text';
        if (spec.type === 'number') { input.min = '0'; input.step = '1'; }
      }
      input.id = cid;
      input.dataset.key = spec.key;
      if (spec.placeholder) input.placeholder = spec.placeholder;
      row.append(label, input);
    }
    if (spec.hint) row.appendChild(el('div', 'ytdlp-t-hint', spec.hint));
    // 持久化：任何输入即保存（urls / rename 除外——它们每次打开都重新提取，不落盘）
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
    // 恢复已存值（urls / rename 不恢复，交给 autoFillFromPage 每次重新提取）
    if (NO_SAVE[spec.key]) {
      if (spec.type === 'checkbox') input.checked = !!spec.default;
      else input.value = String(spec.default === undefined ? '' : spec.default);
    } else {
      const saved = store.get(KEY.form(spec.key), undefined);
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
      inputs[spec.key] = spec.type === 'checkbox' ? !!node.checked : node.value.trim();
    });
    return inputs;
  }

  function validateInputs(inputs) {
    if (inputs.playlist_end !== '' && !/^\d+$/.test(inputs.playlist_end)) {
      return 'playlist_end 必须是非负整数（0 = 不限制）';
    }
    if (inputs.headers && inputs.headers.startsWith('{')) {
      try { JSON.parse(inputs.headers); }
      catch (e) { return 'headers 不是合法的 JSON：' + e.message; }
    }
    return null;
  }

  function resetForm() {
    INPUTS.forEach((spec) => {
      if (NO_SAVE[spec.key]) return; // urls / rename 本就不落盘
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
    runsEl.appendChild(el('li', 'ytdlp-t-empty', '未配置 Token'));
    setStatus('已清除本地保存的 Token', 'info');
  }

  // ---------------------------------------------------------------------------
  // 触发 + 状态轮询
  // ---------------------------------------------------------------------------
  let pollToken = 0; // 递增令牌：新触发/关闭弹框时作废旧轮询

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'ytdlp-t-status ' + (kind || 'info');
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
        // 目标 workflow 没声明这些 inputs：通常是本地改的 ytdlp.yml 还没 commit+push，
        // 或 ref 指向的分支 / 手填的仓库里是旧版 workflow
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
    // 阶段 1：等待新运行出现（dispatch 到 run 可见有数秒延迟）
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
        // 容忍客户端与 GitHub 的时钟偏差（30s）
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

    // 阶段 2：轮询该运行直至完成
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
      const p = el('div', 'ytdlp-t-status err', errText);
      runStatusEl.appendChild(p);
    }
    if (!run) return;
    const box = el('div', 'ytdlp-t-status info');
    const badge = el('span', 'ytdlp-t-badge ' + runBadgeClass(run), runBadgeText(run));
    const link = el('a', null, '查看运行/日志 ↗');
    link.href = run.html_url;
    link.target = '_blank';
    link.rel = 'noopener';
    const meta = el('span', 'ytdlp-t-runmeta',
      '  · ' + currentWorkflow() + ' #' + (run.run_number || '') + ' · ' + (run.head_branch || '') + ' · ' + relTime(run.created_at));
    box.append(badge, document.createTextNode(' '), link, meta);
    runStatusEl.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // 最近运行列表
  // ---------------------------------------------------------------------------
  async function refreshRecentRuns() {
    const token = (store.get(KEY.token, '') || '').trim();
    runsEl.innerHTML = '';
    if (!token) {
      runsEl.appendChild(el('li', 'ytdlp-t-empty', '配置 Token 后显示最近运行'));
      return;
    }
    runsEl.appendChild(el('li', 'ytdlp-t-empty', '加载中…'));
    try {
      const r = await api('GET', '/repos/' + repoPath() +
        '/actions/workflows/' + encodeURIComponent(currentWorkflow()) + '/runs?per_page=5');
      if (r.status !== 200) {
        runsEl.innerHTML = '';
        runsEl.appendChild(el('li', 'ytdlp-t-empty', '加载失败（HTTP ' + r.status + '）：' + extractError(r)));
        return;
      }
      const runs = (JSON.parse(r.responseText).workflow_runs) || [];
      runsEl.innerHTML = '';
      if (!runs.length) {
        runsEl.appendChild(el('li', 'ytdlp-t-empty', '暂无运行记录'));
        return;
      }
      runs.forEach((run) => {
        const li = el('li');
        const badge = el('span', 'ytdlp-t-badge ' + runBadgeClass(run), runBadgeText(run));
        const link = el('a', null, '#' + (run.run_number || ''));
        link.href = run.html_url;
        link.target = '_blank';
        link.rel = 'noopener';
        li.append(badge, link, el('span', 'ytdlp-t-runmeta',
          run.head_branch + ' · ' + (run.event || '') + ' · ' + relTime(run.created_at)));
        runsEl.appendChild(li);
      });
    } catch (e) {
      runsEl.innerHTML = '';
      runsEl.appendChild(el('li', 'ytdlp-t-empty', '加载异常：' + e.message));
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
    autoFillFromPage(); // 打开弹框即重新提取视频链接与标题（urls/rename 不持久化）
  }

  function closeModal() {
    rootEl.style.display = 'none';
    pollToken++; // 作废进行中的轮询
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
    // GitHub Turbo 导航
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
    if (!pageAllowed()) return; // 不在目标仓库页 / jable.tv 视频页则不注入任何 UI
    // 样式注入：GM_addStyle 不受页面 CSP 限制（jable.tv 等站点可能拦内联 <style>）
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
