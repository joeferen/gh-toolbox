// ==UserScript==
// @name         ONE 详情页 · 模块 token 取数器
// @namespace    qoder.one.detail.fetcher
// @version      2.13.0
// @description  不依赖 URL：拦截页面自己发出的 /v2.5/article/detail（真实传输是 XHR），解密请求体还原文章 id 与 dn，再用 one 模块 token 重取一次详情；按「正片/预告 × MP4/M3U8」四格铺链接（可点、可选中复制），缺哪格就写清为什么缺，并对比两种身份。设置里可开「自动替换页面的 token」（默认关，开关会被记住）：开着时 App 自己发出的请求出门前就换成所选 token，页面直接看到替换身份的结果
// @match        https://j7tu.com/*
// @match        http://j7tu.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * 为什么 v1 拿不到 id：详情页路由是 #/videoDetail，id 走 go_router 的 extra（内存参数），
 * 既不落在 URL 上，也不落在 localStorage 上。网页里唯一可靠的 id 来源是 App 自己发出的
 * 那次请求体：POST /v2.5/article/detail，body = base64( AES-128-CBC( "id=<文章id>&dn=<ts域名>" ) )。
 * 所以本脚本在 document-start 装上 XHR/fetch 钩子，解密请求体得到 id，
 * 顺带记下 App 用的真实请求头（token / user-key / uuid）和它自己的响应。
 *
 * 协议（与 one 模块 libapp.so 内常量逐字节相同）
 *   body   = base64( AES-128-CBC/PKCS7( "id=<articleId>&dn=<url 编码后的 ts 域名>" ) )
 *   resp   = base64( 同一把 KEY/IV 解密 )  —— 请求与响应用同一套密钥
 *   sign   = md5( md5("0.0.0.0.<platform>.<ts>.<user-key>.<uuid>") + SALT )
 *   user-key 必须「存在」但值不参与内容判定；detail 的门控只看 token
 *
 * 两种流、两套域名（v2.11 补全两条链接，v2.12 改成 正片/预告 × MP4/M3U8 四格）：
 *   MP4   detail 给根相对路径 /one/compress/decry/vd/.../x.mp4，拼「媒体域名池」
 *         （bootstrap 的 domain.video；one 模块 prefs 的 flutter.one_video
 *         = https://z4bey8.bx7qxb.com 是同池镜像）才 206 video/mp4；拼到 dn 上 404。
 *   M3U8  detail 给 /api/video/getM3u8.m3u8?params=...，拼「api 域」（main.dart.js tP():164735
 *         的 $.cV().r）；清单里 *.ts 分片的域名 = 请求体里的 dn，服务端原样回显，
 *         dn 取自 bootstrap 的 domain.flutter_ts_domain 首项（lc():41116）。
 *   ⇒ 想拿到 video_hls，请求体必须带 dn：只发 id= 时服务端只给 MP4（实测矩阵）。
 *   ⇒ 清单只有一个槽位：data 里的媒体字段只有 video_file / preview_video / video_hls /
 *      video_hls_h265 / audio_hls，没有 preview_hls 之类的东西。video_hls 跟着 video_file 走，
 *      解锁态是正片清单、锁定态就是预告清单（id=63737：网页态 48 秒 5 片，模块态 168.8 分钟 1013 片）。
 *
 * 自动替换页面的 token（v2.13，设置里的复选框，默认关，开关本身存 store 会被记住）：
 *   开着时，App 自己发出的 WATCH 请求在 send 之前被换成「one 模块」那一档的身份：
 *   token / uuid / user-key / sign / ip 五个头一起重算（sign 用页面自己那次的时间戳，所以不需要额外时钟），
 *   于是页面拿到的 detail 就是替换身份的结果，不需要点按钮。
 *   坑：XHR 第二次 setRequestHeader 同名头是「追加逗号」而不是覆盖，所以做法是
 *   在 setRequestHeader 阶段把这五个头扣下不传给原生，等 send() 前一次性写我们算好的。
 *   隔离世界（带 @grant 的旧式安装）里沙箱读不到 DOM 之外，主世界钩子也读不到 GM_*，
 *   所以开关与身份写在 <html data-oneqz-repl="…"> 上做过桥；关掉就摘掉属性。
 *   /purchase /buy /pay /coin /recharge /order /vip /sign_in 永远不替换。
 *   两个必须记住的实现约束（都各踩过一次，离线用例盯着）：
 *     1) 下发给主世界的 md5 只能是「自包含工厂 + 立即调用」那一串（oneqzMd5Factory），
 *        搬 MD5.toString() 会丢掉它闭包里的 rl/add/S/K，主世界里一调就 ReferenceError。
 *     2) 换头失败时必须把扣下的页面原头还回去，并且回一条 replerr 到面板；
 *        静默吞掉的话面板写着「已开」、页面却拿到缺 token 的请求，两头都骗人。
 *   CAP 里存的永远是「页面自己那次」的头，替换出去的身份不反过来污染判读。
 */
(function () {
  "use strict";

  var KEY = "l*bv%Ziq000Biaog";
  var IV = "8597506002939249";
  var SALT = "m4n2hjPeYWkD6tFpqKF^3HO^h24P@idT";
  var PLATFORM = "3";
  var APP_VERSION = "2.6.4";
  var API_SEEDS = ["https://api.em1oifd0.com", "https://api.61c76a0.com",
                   "https://api.3459381.com", "https://api.j7y675.com"];
  /* 播放域名兜底种子：bootstrap 的 domain.video 池成员 + 模块 prefs 的 flutter.one_video。
     同一路径在每个成员上都是同一个文件，谁活着用谁；池会换，所以在面板里可改。 */
  var PLAY_SEEDS = ["https://z4bey8.bx7qxb.com", "https://46e9nz.mfpt8g.com",
                    "https://f86xxm.upmf83.com", "https://eruj5e.fwn9vj.com"];
  var DETAIL = "/v2.5/article/detail";
  /* 详情页会陆续发出的接口：请求体里都带文章 id（comment/list 用 article_id，其余用 id）。
     App 只在「从列表点卡片」那一刻发 /v2.5/article/detail；刷新/直开时它一个都不发。
     多盯几个，只要任意一个经过钩子就能还原出 id，拿到 id 后我们自己再发 detail 就行。 */
  var WATCH = [DETAIL, "/v2.5/comment/list", "/v2.5/article/like", "/v2.5/article/download", "/v2.5/panda/url"];
  var SCRIPT_VERSION = "2.13.0";   // 面板里会打出来，免得再拿旧版截图对新代码

  /* one 模块身份：/box/api/splash 下发的共享凭证，iss=4406487，昵称 176*****801。
     它随模块启动由宿主注入，浏览器侧取不到（splash 走 http://ip:6868 且校验 time+uuid 绑定对），
     所以这里内置；exp 到期后在面板里换掉即可。 */
  var MODULE_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOjQ0MDY0ODcsImlzX3Zpc2l0b3IiOjAsInV1aWQiOiJmMTkxMzY2NC05NTA0LTMwYmItYjg2MC1jMGIyZjlhMDEzYjMiLCJuaWNrbmFtZSI6IjE3NioqKioqODAxIiwiaXAiOiIzOC40Ni4xMC4yIiwiaWF0IjoxNzkyNTY4OTk4LCJleHAiOjE3OTMxNzczOTgsIm5iZiI6MTc5MjU2ODk5OCwic3ViIjoiMDMyNWFwaS5zYW50aXl1LmNvbSIsImp0aSI6ImZjYTQzZjcwYzUxYTA1NmY2YjYwYzc3ZTU0MTJjMGZlIn0.Ru8OUWzgUNK_VTc1slyohxryI3TrHWlUCFJXx9YcP14";
  var MODULE_UUID = "ef0c6210-88cf-11f1-99ae-b94f32dc13b9";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var store = {
    get: function (k, d) { try { return typeof GM_getValue === "function" ? GM_getValue(k, d) : (localStorage.getItem("uf_" + k) || d); } catch (e) { return d; } },
    set: function (k, v) { try { if (typeof GM_setValue === "function") { GM_setValue(k, v); return; } } catch (e) {} try { localStorage.setItem("uf_" + k, v); } catch (e) {} }
  };
  function safeJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }

  /* ---------- md5 ---------- */
  /* md5 要能被整段序列化进页面主世界（自动替换时要在那边重算 sign），所以写成自包含工厂：
     只搬 return 出来的那个函数不行 —— 它闭包引用了 rl/add/S/K，跨世界就没有这些名字了。 */
  function oneqzMd5Factory() {
    function rl(x, c) { return (x << c) | (x >>> (32 - c)); }
    function add(a, b) { return (a + b) | 0; }
    var S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5, 9,14,20,5, 9,14,20,5, 9,14,20,5, 9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    var K = [];
    for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    return function (str) {
      var bytes = new TextEncoder().encode(str);
      var n = bytes.length;
      var withPad = new Uint8Array((((n + 8) >> 6) + 1) << 6);
      withPad.set(bytes); withPad[n] = 0x80;
      var bitLen = n * 8;
      var dv = new DataView(withPad.buffer);
      dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
      dv.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);
      var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
      for (var off = 0; off < withPad.length; off += 64) {
        var M = new Array(16);
        for (var j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
        var A = a0, B = b0, C = c0, D = d0;
        for (var i2 = 0; i2 < 64; i2++) {
          var F, g;
          if (i2 < 16) { F = (B & C) | (~B & D); g = i2; }
          else if (i2 < 32) { F = (D & B) | (~D & C); g = (5 * i2 + 1) % 16; }
          else if (i2 < 48) { F = B ^ C ^ D; g = (3 * i2 + 5) % 16; }
          else { F = C ^ (B | ~D); g = (7 * i2) % 16; }
          F = add(add(add(add(A, F), K[i2]), M[g]), 0);
          A = D; D = C; C = B;
          B = add(B, rl(F, S[i2]));
        }
        a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
      }
      var out = "", words = [a0, b0, c0, d0];
      for (var w = 0; w < 4; w++) {
        for (var k = 0; k < 4; k++) {
          var octet = (words[w] >> (8 * k)) & 0xff;
          out += (octet < 16 ? "0" : "") + octet.toString(16);
        }
      }
      return out;
    };
  }
  var MD5 = oneqzMd5Factory();

  /* ---------- AES-128-CBC ---------- */
  var aesKey = null, aesIV = null;
  function ensureAes() {
    if (aesKey) return Promise.resolve();
    var enc = new TextEncoder();
    aesIV = enc.encode(IV); // IV 必须是裸字节，不能用 importKey 导成 CryptoKey
    return crypto.subtle.importKey("raw", enc.encode(KEY), { name: "AES-CBC" }, false, ["encrypt", "decrypt"])
      .then(function (k) { aesKey = k; });
  }
  var b64 = {
    enc: function (buf) { var s = "", u = new Uint8Array(buf); for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); },
    dec: function (str) { var s = atob(str.replace(/\s+/g, "")), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  };
  function encryptParams(text) {
    return ensureAes().then(function () {
      return crypto.subtle.encrypt({ name: "AES-CBC", iv: aesIV }, aesKey, new TextEncoder().encode(text));
    }).then(function (buf) { return b64.enc(buf); });
  }
  function tryDecrypt(b64text) {
    var t = String(b64text == null ? "" : b64text).trim();
    if (!t) return Promise.reject(new Error("空响应"));
    return ensureAes().then(function () {
      return crypto.subtle.decrypt({ name: "AES-CBC", iv: aesIV }, aesKey, b64.dec(t));
    }).then(function (buf) { return new TextDecoder("utf-8").decode(buf); });
  }

  /* ---------- 拦截 App 自己的 detail 请求 ----------
   * 关键：带 @grant 的脚本跑在 Tampermonkey 的隔离世界（isolated world），
   * 在这里 patch window.fetch / XMLHttpRequest.prototype 只影响沙箱自己那一份，
   * App（主世界）发的请求一次也拦不到 —— v2.0.0 最初就栽在这。
   * 所以钩子代码要注入成 <script> 在页面主世界执行，抓到密文头/体后用 postMessage
   * 丢回沙箱，由沙箱这边（有 GM_*、有面板）解密并展示。站点没有 CSP，注入可用。 */
  var CAP = { id: null, headers: null, body: null, response: null, route: null, at: 0,
              dn: null, apiHost: "", playHost: "", playFrom: "" };
  /* 钩子活着与否不能靠「面板没反应」猜：把经过钩子的每一次 App 请求都记一笔，
     面板/诊断里能直接看到「拦到了几个、哪些接口、哪个解出了 id」。 */
  var STAT = { seen: 0, plain: 0, ids: 0, repl: 0, last: [] };
  var RAW_FETCH = null;   // 沙箱内直接装钩子时的兜底：本脚本自己的请求走原生 fetch
  var HOOK = { mode: null, world: "unknown", relay: false, error: "" };   // direct=同世界直接拦到 / local=隔离世界靠注入回传 / relay=注入已 ack
  var NONCE = "oneqz" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  var capListeners = [];
  function onCapture(fn) { capListeners.push(fn); }
  function emit(kind) { for (var i = 0; i < capListeners.length; i++) { try { capListeners[i](kind); } catch (e) {} } }

  function isDetailUrl(u) { return typeof u === "string" && u.indexOf(DETAIL) >= 0; }
  function isWatched(u) { return typeof u === "string" && WATCH.some(function (p) { return u.indexOf(p) >= 0; }); }
  function idFromBody(plain) {
    var m = /(?:^|[&;])(?:article_)?id=(\d+)/.exec(String(plain || ""));
    return m ? m[1] : null;
  }
  function epOf(u) { return String(u || "").replace(/^https?:\/\/[^/]*/, "").split("?")[0] || "?"; }
  /* 详情一次同时给两种流的根相对路径，域名要自己拼：
     · video_file  /one/compress/decry/vd/...h265/mp4/...mp4  → 拼「媒体池」域（页面在播的域 > 手填 > 种子）
     · video_hls   /api/video/getM3u8.m3u8?params=...         → 拼「api 域」，清单里的 *.ts 分片域名
       就是请求体里那个 dn（服务端把 dn 原样写进清单；main.dart.js lc():41116 取 bootstrap 的
       domain.flutter_ts_domain 的第一个）。所以 dn 不是 mp4 的域，但确实是 HLS 分片的域。
     video_hls 只有请求体带了 dn 才会返回 —— 不带 dn 服务端只给 mp4。 */
  function dnFromPlain(plain) {
    var m = /(?:^|[&;])dn=([^&;]+)/.exec(String(plain || ""));
    if (!m) return null;
    var v = m[1];
    try { v = decodeURIComponent(v); } catch (e) {}
    return /^https?:\/\/[^/]+/.test(v) ? v.replace(/\/+$/, "") : null;
  }
  function trimSlash(h) { return String(h == null ? "" : h).replace(/\/+$/, ""); }
  /* performance 的资源计时里包含媒体元素自己发起的请求，比任何推测都准：这就是本页此刻在放的域。 */
  function playHostFromPage() {
    var list;
    try { list = performance.getEntriesByType("resource") || []; } catch (e) { return ""; }
    var here = trimSlash(typeof location === "undefined" ? "" : location.origin);
    for (var i = list.length - 1; i >= 0; i--) {
      var m = /^(https?:\/\/[^/]+)\/one\/[^\s]*\.(?:mp4|m3u8|ts)(?:\?|$)/i.exec(String(list[i] && list[i].name || ""));
      if (m && trimSlash(m[1]) !== here) return trimSlash(m[1]);
    }
    return "";
  }
  function refreshPlayHost() {
    var live = playHostFromPage();
    if (live) { CAP.playHost = live; CAP.playFrom = "页面正在播的那次请求"; }
    return CAP.playHost;
  }
  function playHost() {
    var saved = trimSlash(store.get("one_play_host", ""));
    if (/^https?:\/\//.test(saved)) return saved;
    return refreshPlayHost() || PLAY_SEEDS[0];
  }
  function videoUrl(path, host) {
    var p = String(path || "");
    if (!p) return "";
    if (/^https?:\/\//.test(p)) return p;
    var base = trimSlash(host || playHost());
    return base + (p.charAt(0) === "/" ? p : "/" + p);
  }
  /* 同一个文件在媒体池每个成员上都在（逐 host 发 Range: bytes=0-0，Content-Range 总长一致），
     所以给完主链接再并列几个镜像，哪个通用哪个。 */
  function mirrorUrls(path) {
    var out = [], h = trimSlash(playHost());
    for (var i = 0; i < PLAY_SEEDS.length; i++) {
      if (trimSlash(PLAY_SEEDS[i]) !== h) out.push(videoUrl(path, PLAY_SEEDS[i]));
    }
    return out;
  }
  /* video_hls 挂在 api 域上（main.dart.js tP():164735 就是 $.cV().r + video_hls，
     $.cV().r 是本次 detail 用的那个 api 域），不是媒体域。已经是绝对地址就原样用。 */
  function hlsUrl(d) {
    var p = String((d && d.video_hls) || "");
    if (!p) return "";
    if (/^https?:\/\//.test(p)) return p;
    var base = trimSlash(CAP.apiHost || hostFromAppUrl() || apiHosts()[0] || "");
    return base ? base + (p.charAt(0) === "/" ? p : "/" + p) : p;
  }
  function noteStat(plainOk, id) {
    STAT.last.push({ ep: epOf(CAP.urlFull), ok: plainOk, id: id || "", at: CAP.at });
    if (STAT.last.length > 8) STAT.last.shift();
  }
  function noteCapture(headers, body, url, hash) {
    if (dup(headers, body, url)) return;
    STAT.seen++;
    var fromDetail = url && url.indexOf(DETAIL) >= 0;
    CAP.headers = headers || null;
    CAP.body = body || null;
    CAP.urlFull = url || "";
    CAP.route = hash || location.hash || "";
    CAP.at = Date.now();
    if (!body) { noteStat(false, ""); if (fromDetail) CAP.response = null; emit("body-empty"); return; }
    tryDecrypt(body).then(function (plain) {
      STAT.plain++;
      var id = idFromBody(plain);
      noteStat(true, id);
      if (!id) { if (fromDetail) CAP.response = null; emit("body-noid"); return; }
      STAT.ids++;
      var changed = CAP.id !== id;
      CAP.id = id;
      CAP.plain = plain;
      var dn = dnFromPlain(plain);
      if (dn) CAP.dn = dn;   // 只是 ts 探活域，记录它是为了说明「拼链接为什么不用它」
      CAP.idFrom = fromDetail ? "detail" : (url || "").replace(/^.*\/v2\.5\//, "").split("?")[0];
      if (changed || !fromDetail) CAP.response = null;
      emit(changed ? "id" : "id-same");
    }, function () { noteStat(false, ""); if (fromDetail) CAP.response = null; emit("body-bad"); });
  }
  function noteResponse(text, url) {
    if (url && url.indexOf(DETAIL) < 0) return;      // 只收 detail 的响应，comment/list 之类不参与门控判读
    var t = String(text == null ? "" : text).trim();
    if (!t) { emit("resp-bad"); return; }
    if (/^[\{\[]/.test(t)) {                 // 明文错误 / 空壳，直接 parse，不用套密钥
      var j0 = safeJson(t);
      if (j0) { CAP.response = j0; emit("resp"); return; }
    }
    tryDecrypt(t).then(function (plain) {
      var json = safeJson(plain);
      if (!json) { CAP.respBad = "解密后不是 JSON：" + plain.slice(0, 60); emit("resp-bad"); return; }
      CAP.response = json;
      emit("resp");
    }, function (e) {
      CAP.respBad = "解密失败(" + String(t).slice(0, 48) + "…)";
      emit("resp-bad");
    });
  }

  /* App（Flutter web 的 http 包）把请求体当二进制发：xhr.send(Uint8Array)，不是字符串。
   * 早先按 String(body) 处理，得到的是 "[object Uint8Array]"，所以「拦到了但解不开」。
   * 这个解码器必须两个世界共用同一份实现，注入时把它的源码一起带过去。 */
  function bodyToText(b) {
    if (b == null) return "";
    if (typeof b === "string") return b;
    try {
      if (typeof URLSearchParams === "function" && b instanceof URLSearchParams) return String(b);
      if (typeof FormData === "function" && b instanceof FormData) {
        var p = []; b.forEach(function (v, k) { p.push(k + "=" + (typeof v === "string" ? v : "[file]")); });
        return p.join("&");
      }
      if (typeof ArrayBuffer === "function") {
        var u8 = null;
        if (b instanceof Uint8Array) u8 = b;
        else if (b instanceof ArrayBuffer) u8 = new Uint8Array(b);
        else if (b.buffer instanceof ArrayBuffer && typeof b.byteLength === "number")
          u8 = new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
        if (u8) return new TextDecoder("utf-8").decode(u8);
      }
    } catch (e) {}
    try { return String(b); } catch (e) { return ""; }
  }

  /* App 用 dart:html 的 HttpRequest 收响应，responseType 未必是 ""：
   * 直接读 responseText 会抛 InvalidStateError，所以按 responseText → response(二进制) 依次兜底。 */
  function readXhrBody(x) {
    var t = "";
    try { if (x.responseType === "" || x.responseType === "text") t = x.responseText || ""; } catch (e) {}
    if (t) return t;
    try { var r = x.response; if (typeof r === "string" && r) return r; if (r) return bodyToText(r); } catch (e) {}
    return "";
  }

  /* 这一段会被 toString() 后注入到页面主世界执行：只收集，不加解密（AES 密钥留在沙箱）。
     R 是「自动替换」那一档需要的东西：md5 源码 + SALT + DOM 桥属性名。md5/SALT 只用于算 sign，
     不涉及 AES；页面里本来就有能算同一签名的 Dart 代码，藏不藏没有差别，但 AES 密钥绝不下发。 */
  function oneqzMainHook(WATCH, nonce, decoderSrc, R) {
    var bodyToText = eval("(" + decoderSrc + ")");
    var MD5 = null;
    /* 自包含工厂的调用式，跨世界也能跑；拿到不是函数就当没有，宁可退回「只收集」 */
    try { if (R && R.md5Src) { var mf = eval(R.md5Src); if (typeof mf === "function") MD5 = mf; } } catch (e) { MD5 = null; }
    function post(o) { o.oneqz = nonce; try { window.postMessage(o, "*"); } catch (e) {} }
    /* 算 sign 的东西没到位，自动替换这一整条路就是哑的：装好钩子立刻说一声，别等面板写着「已开」 */
    if (R && R.md5Src && !MD5) post({ kind: "replerr", url: "hook", err: "md5 在主世界求值失败，自动替换不可用（页面身份原样发）" });
    var PAUSE_KEY = "__oneqz_pause";       // 沙箱发自己的请求时置位，避免把自己的请求当成 App 的
    function isd(u) { return typeof u === "string" && WATCH.some(function (p) { return u.indexOf(p) >= 0; }); }
    function paused() {
      try { var p = window[PAUSE_KEY]; return p && Date.now() - p < 8000; } catch (e) { return false; }
    }
    /* 沙箱把开关与身份写在 <html> 的属性上（两个世界都看得见 DOM），关掉时属性被摘掉就是没开。 */
    function specNow(u) {
      if (!R || !MD5) return null;
      try {
        var el = document.documentElement;
        if (!el || !el.getAttribute) return null;
        var raw = el.getAttribute(R.attr);
        if (!raw) return null;
        for (var i = 0; R.no && i < R.no.length; i++) { if (String(u).indexOf(R.no[i]) >= 0) return null; }
        var o = JSON.parse(raw);
        return o && o.t ? { token: o.t, uuid: o.u || "", userKey: o.k || "" } : null;
      } catch (e) { return null; }
    }
    function replHeads(h, spec) {
      var ts = h.timestamp || String(Math.floor(Date.now() / 1000));
      var pf = h.platform || R.platform;
      var uk = spec.userKey || "";
      return { token: spec.token, uuid: spec.uuid, "user-key": uk, ip: "0.0.0.0",
               sign: MD5(MD5("0.0.0.0." + pf + "." + ts + "." + uk + "." + spec.uuid) + R.salt) };
    }
    function bumpLayers() { try { window.__oneqz_layers = (window.__oneqz_layers || 0) + 1; } catch (e) {} }
    var XO = XMLHttpRequest.prototype.open;
    var XS = XMLHttpRequest.prototype.send;
    var XH = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__qz = isd(u) && !paused() ? { url: String(u), h: {}, spec: specNow(String(u)) } : null;
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      var t = this.__qz;
      if (t) {
        var kk = String(k).toLowerCase();
        t.h[kk] = String(v);
        if (t.spec && R.keys[kk]) return;        // 扣下页面的身份头，send 前换成模块的（XHR 同名是追加，不能盖）
      }
      return XH.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var t = this.__qz;
      if (t) {
        if (t.spec) {
          var rh = null, why = "";
          try { rh = replHeads(t.h, t.spec); } catch (e2) { why = String((e2 && e2.message) || e2); }
          if (rh) {
            try {
              Object.keys(rh).forEach(function (k2) { XH.call(this, k2, rh[k2]); }, this);
              post({ kind: "repl", url: t.url });
            } catch (e3) { post({ kind: "replerr", url: t.url, err: "写头失败：" + String((e3 && e3.message) || e3) }); }
          } else {
            /* sign 没算出来：把扣下的那几个页面原头还回去。替换没做成却让请求缺 token，等于把页面搞坏。 */
            post({ kind: "replerr", url: t.url, err: "sign 重算失败：" + why + "（这次用页面自己的身份）" });
            try { Object.keys(t.h).forEach(function (k2) { if (R.keys[k2]) XH.call(this, k2, t.h[k2]); }, this); } catch (e4) {}
          }
        }
        var b; try { b = bodyToText(body); } catch (e) { b = ""; }
        post({ kind: "req", url: t.url, hash: location.hash, heads: t.h, body: b });
        var self = this;
        this.addEventListener("load", function () {
          try {
            var tx = "";
            try { if (self.responseType === "" || self.responseType === "text") tx = self.responseText || ""; } catch (e) {}
            if (!tx) { try { var rr = self.response; tx = typeof rr === "string" ? (rr || "") : (rr ? bodyToText(rr) : ""); } catch (e) {} }
            if (tx) post({ kind: "resp", url: t.url, text: String(tx).slice(0, 400000) });
          } catch (e) {}
        });
      }
      return XS.apply(this, arguments);
    };
    if (typeof window.fetch === "function") {
      var OF = window.fetch;
      window.fetch = function (input, init) {
        var url = "";
        try { url = typeof input === "string" ? input : ((input && input.url) || ""); } catch (e) {}
        var r = OF.apply(this, arguments);
        if (!isd(url) || paused()) return r;
        var heads = {};
        try {
          var src = (init && init.headers) || (input && input.headers) || null;
          if (src && typeof src.forEach === "function") src.forEach(function (v, k) { heads[String(k).toLowerCase()] = String(v); });
          else if (src) Object.keys(src).forEach(function (k) { heads[k.toLowerCase()] = String(src[k]); });
        } catch (e) {}
        var body = "";
        try { body = bodyToText(init && init.body); } catch (e) {}
        post({ kind: "req", url: url, hash: location.hash, heads: heads, body: body });
        return r.then(function (res) {
          try {
            res.clone().text().then(function (tx) {
              post({ kind: "resp", url: url, text: String(tx || "").slice(0, 400000) });
            }, function () {});
          } catch (e) {}
          return res;
        });
      };
    }
    window.__oneqz_hooked = true;
    bumpLayers();
    post({ kind: "ack", via: "main" });
  }

  /* 沙箱与主世界同一个世界时（@grant none 的正常情形）直接就地装钩子 */
  function isPaused() {
    try { var p = window.__oneqz_pause; return p && Date.now() - p < 8000; } catch (e) { return false; }
  }
  function installHooksLocal() {
    if (typeof window.fetch === "function") RAW_FETCH = window.fetch;
    var XO = XMLHttpRequest.prototype.open;
    var XS = XMLHttpRequest.prototype.send;
    var XH = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) {
      var w = isWatched(u) && !isPaused();
      this.__oneqz = w ? { method: m, url: String(u), heads: {},
                           spec: replaceableUrl(u) ? replaceSpec() : null } : null;
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      var t = this.__oneqz;
      if (t) {
        var kk = String(k).toLowerCase();
        t.heads[kk] = String(v);
        if (t.spec && REPL_HEADS[kk]) return;      // 扣下页面的身份头，send 前换成模块的
      }
      return XH.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var tag = this.__oneqz;
      if (tag) {
        if (tag.spec) {
          var rh = null, why = "";
          try { rh = replHeads(tag.heads, tag.spec); } catch (e2) { why = String((e2 && e2.message) || e2); }
          if (rh) {
            try {
              Object.keys(rh).forEach(function (k2) { XH.call(this, k2, rh[k2]); }, this);
              noteReplaced(tag.url, tag.spec);
            } catch (e3) { noteReplaceFailed("写头失败：" + String((e3 && e3.message) || e3)); }
          } else {
            noteReplaceFailed("sign 重算失败：" + why + "（这次用页面自己的身份）");
            try { Object.keys(tag.heads).forEach(function (k2) { if (REPL_HEADS[k2]) XH.call(this, k2, tag.heads[k2]); }, this); } catch (e4) {}
          }
        }
        noteCapture(tag.heads, bodyToText(body), tag.url);
        var self = this;
        this.addEventListener("load", function () {
          var tx = readXhrBody(self);
          if (tx) noteResponse(tx, tag.url);
        });
      }
      return XS.apply(this, arguments);
    };
    if (RAW_FETCH) {
      var OF = RAW_FETCH;
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        if (!isWatched(url) || isPaused()) return OF.apply(this, arguments);
        var args = Array.prototype.slice.call(arguments);
        try {
          var heads = {};
          var src = (init && init.headers) || (input && input.headers) || null;
          if (src) {
            if (typeof src.forEach === "function") src.forEach(function (v, k) { heads[String(k).toLowerCase()] = String(v); });
            else Object.keys(src).forEach(function (k) { heads[k.toLowerCase()] = String(src[k]); });
          }
          /* 只在 (字符串 url, init) 形态上换：传 Request 对象时改 init 会把它的 body 丢掉。App 走的是 XHR，这条是兜底。 */
          var spec = typeof input === "string" && replaceableUrl(url) ? replaceSpec() : null;
          if (spec) {
            /* heads 保持「页面原本那次」的身份，换出去的写进新的 merged —— CAP 会被 identity("page") 用 */
            var rh = replHeads(heads, spec), merged = {};
            Object.keys(heads).forEach(function (k) { if (!REPL_HEADS[k]) merged[k] = heads[k]; });
            Object.keys(rh).forEach(function (k) { merged[k] = rh[k]; });
            var ni = {};
            if (init) Object.keys(init).forEach(function (k) { if (k !== "headers") ni[k] = init[k]; });
            ni.headers = merged;
            args = [input, ni];
            noteReplaced(url, spec);
          }
        } catch (e) {}
        var r = OF.apply(this, args);
        var body = "";
        try { body = bodyToText(init && init.body); } catch (e) {}
        noteCapture(heads, body, url);
        return r.then(function (res) {
          try { res.clone().text().then(function (t) { noteResponse(t, url); }, function () {}); } catch (e) {}
          return res;
        });
      };
    }
    HOOK.mode = WORLD === "main" ? "direct" : "local";
    HOOK.world = WORLD;
    try { window.__oneqz_layers = (window.__oneqz_layers || 0) + 1; } catch (e) {}
    emit("hook");
  }

  function onMessage(ev) {
    var d = ev && ev.data;
    if (!d || d.oneqz !== NONCE) return;          // 只认自己那次注入，页面上别的东西仿不了
    if (d.kind === "ack") { HOOK.relay = true; emit("hook"); return; }
    if (d.kind === "req") noteCapture(d.heads, d.body, d.url, d.hash);
    else if (d.kind === "resp") noteResponse(d.text, d.url);
    else if (d.kind === "repl") noteReplaced(d.url, { label: "one 模块（页面侧钩子换的）" });
    else if (d.kind === "replerr") noteReplaceFailed(d.err + " @ " + epOf(d.url));
  }

  /* 刚记下哪一次请求，用来去重：同世界时本地钩子和注入钩子会各命中一次 */
  var lastSeen = { key: "", at: 0 };
  function dup(headers, body, url) {
    var key = String(url) + "|" + String(body);
    var now = Date.now();
    if (key === lastSeen.key && now - lastSeen.at < 1500) return true;
    lastSeen.key = key; lastSeen.at = now;
    return false;
  }

  function injectMain() {
    var src;
    try {
      src = "(" + oneqzMainHook.toString() + ")(" + JSON.stringify(WATCH) + "," + JSON.stringify(NONCE) +
            "," + JSON.stringify(bodyToText.toString()) + "," + JSON.stringify(replArg()) + ");";
    } catch (e) { HOOK.error = String(e && e.message || e); return false; }
    if (!src || src.length < 400) { HOOK.error = "钩子源码序列化异常"; return false; }
    function go() {
      try {
        var s = document.createElement("script");
        s.setAttribute("nonce", NONCE);            // 站点没有 CSP；留 nonce 只是习惯性写法，不影响注入
        s.textContent = src;
        (document.documentElement || document).appendChild(s);
        if (s.parentNode) s.parentNode.removeChild(s);
        return true;
      } catch (e) { HOOK.error = String(e && e.message || e); return false; }
    }
    if (document.documentElement) return go();
    /* document-start 时可能还没有 <html>：轮询到它出现（最多 ~3s） */
    var n = 0;
    var iv = setInterval(function () {
      if (document.documentElement) { clearInterval(iv); go(); }
      else if (++n > 300) clearInterval(iv);
    }, 10);
    return true;
  }

  /* 判定脚本自己跑在哪个世界。
   * 原理：window.eval 永远在「页面主世界」执行。把主世界造出来的函数拿回来比原型链，
   * 同世界时原型相等，隔离世界时跨世界对象的 prototype 是另一套 Object.prototype，不相等。
   * 这个判定不依赖站点 CSP、不依赖管理器实现，也不需要任何 GM_* 权限。 */
  function detectWorld() {
    try {
      if (typeof window.eval !== "function") return "isolated";
      var f = window.eval("(function(){return function(){};})");
      if (typeof f !== "function") return "isolated";
      return Object.getPrototypeOf(f) === Object.getPrototypeOf(function () {}) ? "main" : "isolated";
    } catch (e) {
      return "main";        // 判不了就按主世界走（注入/本地都一样装）
    }
  }

  var WORLD = "unknown";

  function installHooks() {
    window.addEventListener("message", onMessage, false);
    WORLD = detectWorld();
    /* 主世界（@grant none 的正常情形）：直接 patch 页面的 fetch/XHR 就能拦到 App，
       不需要注入、不需要回传，也不受 CSP 影响。隔离世界才需要注入+postMessage 那条路。 */
    installHooksLocal();
    if (WORLD === "isolated") { HOOK.error = ""; injectMain(); }
    else { HOOK.relay = false; }
    setTimeout(function () { emit("hook"); }, 1200);
  }

  /* 自己发请求时让主世界钩子静默：同世界时 __oneqz_pause 可见，隔离世界时它无效但也不会自拦 */
  function rawCall(url, opts) {
    try { window.__oneqz_pause = Date.now(); } catch (e) {}
    var call = RAW_FETCH || window.fetch;
    function unPause() { try { window.__oneqz_pause = 0; } catch (e) {} }
    return call(url, opts).then(function (r) {
      return r.text().then(function (t) { unPause(); return t; }, function (e) { unPause(); throw e; });
    }, function (e) { unPause(); throw e; });
  }

  function clearCapture(reason) {
    CAP.id = null; CAP.headers = null; CAP.body = null; CAP.plain = null; CAP.response = null; CAP.at = 0;
    emit(reason || "route");
  }

  /* ---------- 身份 ---------- */
  function pageUser() {
    try {
      var raw = localStorage.getItem("user_profile");
      if (!raw) return null;
      var env = JSON.parse(raw);
      return (env && env.user) || null;
    } catch (e) { return null; }
  }
  function uuidFromPage() {
    try {
      var v = JSON.parse(localStorage.getItem("flutter.device_uuid") || "null");
      if (v && /^[0-9a-f-]{36}$/i.test(v)) return v.toLowerCase();
    } catch (e) {}
    var m = (localStorage.getItem("user_profile") || "").match(/"uuid":"([0-9a-f]{8}-[0-9a-f-]{27})"/i);
    return m ? m[1] : MODULE_UUID;
  }
  /* App 自己刚发过的那次请求 = 网页当前登录态的最真实快照（token 可能比 localStorage 新） */
  function appHeaders() {
    var h = CAP.headers || {};
    return { token: h.token || "", userKey: h["user-key"] || "", uuid: h.uuid || "", ts: h.timestamp || "" };
  }
  function identity(mode) {
    if (mode === "page") {
      var u = pageUser();
      var app = appHeaders();
      var mobile = (u && u.mobile) || "";
      var uk = app.userKey || (mobile && String(u && u.is_visitor) !== "1" ? MD5(mobile) : "");
      return { label: "网页登录态 uid=" + ((u && u.id) || "?"),
               token: app.token || (u && u.token) || MODULE_TOKEN, userKey: uk, uuid: app.uuid || uuidFromPage() };
    }
    if (mode === "app") {
      var a = appHeaders();
      if (!a.token) return null;
      return { label: "网页 App 那次原样（拦截到的头）", token: a.token, userKey: a.userKey, uuid: a.uuid };
    }
    return { label: "one 模块 uid=4406487", token: store.get("one_token", MODULE_TOKEN), userKey: "", uuid: MODULE_UUID };
  }

  /* ---------- 自动替换页面的 token（默认关，设置里可开，开关本身会被记住） ----------
     开启后，App 自己发出的 WATCH 请求在离开钩子之前就被换成「one 模块」那一档的身份
     （设置里 token 输入框换过就用换过的那个），于是页面本身拿到的就是替换身份的详情，
     不用点按钮。付费/扣币类接口一律不碰。
     实现要点：XHR 对同名头再次 setRequestHeader 是「追加逗号」而不是覆盖
     （规范里 author request headers 是拼接的），所以不能等 send() 时直接盖——会拼成
     "页面token, 模块token"。做法是在 setRequestHeader 阶段把这几个身份头扣下不传给原生，
     等 send() 调原生 send 之前一次性写我们算好的值。 */
  var REPL_ATTR = "data-oneqz-repl";
  var REPL_HEADS = { token: 1, uuid: 1, "user-key": 1, sign: 1, ip: 1 };
  var NO_REPLACE = ["/purchase", "/buy", "/pay", "/coin", "/recharge", "/order", "/vip", "/sign_in"];
  function autoOn() { return String(store.get("one_auto", "0")) === "1"; }
  function replaceableUrl(u) {
    var s = String(u || "");
    return isWatched(s) && !NO_REPLACE.some(function (p) { return s.indexOf(p) >= 0; });
  }
  function replaceSpec() {
    if (!autoOn()) return null;
    var id = identity("module");
    return id && id.token ? { token: id.token, uuid: id.uuid, userKey: id.userKey, label: id.label } : null;
  }
  /* sign 里那串是 ip.platform.ts.user-key.uuid；ip 头我们固定写 0.0.0.0，所以式子里也是它。
     只返回 REPL_HEADS 里那五个：其余头是页面自己设的，我们再 setRequestHeader 一次就变成追加。 */
  function replHeads(heads, spec) {
    var h = heads || {};
    var ts = h.timestamp || String(Math.floor(Date.now() / 1000));
    var pf = h.platform || PLATFORM;
    var uk = spec.userKey || "";
    return { token: spec.token, uuid: spec.uuid, "user-key": uk, ip: "0.0.0.0",
             sign: MD5(MD5("0.0.0.0." + pf + "." + ts + "." + uk + "." + spec.uuid) + SALT) };
  }
  /* 隔离世界里注入进主世界的钩子读不到 GM_*，开关与身份用 DOM 属性过桥；关掉就摘掉。 */
  function armReplace() {
    var spec = replaceSpec();
    try {
      var el = document.documentElement;
      if (!el) return spec;
      if (!spec) el.removeAttribute(REPL_ATTR);
      else el.setAttribute(REPL_ATTR, JSON.stringify({ t: spec.token, u: spec.uuid, k: spec.userKey || "" }));
    } catch (e) {}
    return spec;
  }
  function noteReplaced(url, spec) {
    STAT.repl++;
    if (isDetailUrl(url)) log("自动替换   " + epOf(url) + " 的身份 → " + spec.label + "（token/uuid/user-key/sign/ip 五个头重算）", "dim");
    emit("repl");
  }
  /* 替换失败必须说出口：静默吞掉的话，页面拿到的还是它自己那档身份，面板却写着「已开」——
     这一版就是因为把 md5 闭包搬不过去而整条路径哑掉，靠这条才看得见。 */
  function noteReplaceFailed(err) {
    STAT.replErr = (STAT.replErr || 0) + 1;
    log("自动替换失败：" + String(err).slice(0, 120) + " —— 这次原样用页面自己的身份发出去了", "bad");
    emit("repl");
  }
  /* 注入给主世界钩子的那份参数：md5 工厂的调用式 + SALT + DOM 桥。开关没开时属性不存在，钩子就不会换。
     md5Src 必须是「整段自包含」的表达式（工厂源码 + 立即调用），只搬 MD5.toString() 会丢掉它闭包的 rl/add/S/K。 */
  function replArg() {
    return { md5Src: "(" + oneqzMd5Factory.toString() + ")()", salt: SALT, attr: REPL_ATTR,
             keys: REPL_HEADS, no: NO_REPLACE, platform: PLATFORM };
  }

  /* ---------- 请求 ---------- */
  function apiHosts() {
    var cur = "";
    try { cur = localStorage.getItem("current_domain") || ""; } catch (e) {}
    var saved = store.get("one_host", "");
    var list = [];
    [saved, cur].concat(API_SEEDS).forEach(function (h) {
      h = (h || "").replace(/\/+$/, "");
      if (/^https?:\/\//.test(h) && list.indexOf(h) < 0) list.push(h);
    });
    return list;
  }
  function hostFromAppUrl() {
    var u = CAP.urlFull || "";
    var m = /^(https?:\/\/[^/]+)/.exec(u);
    return m ? m[1] : "";
  }
  function fetchDetail(articleId, ident, host) {
    var ts = Math.floor(Date.now() / 1000);
    // 签名原文 = "<ip>.<platform>.<ts>.<user-key>.<uuid>"，ip 固定 "0.0.0.0"
    var base = "0.0.0.0." + PLATFORM + "." + ts + "." + ident.userKey + "." + ident.uuid;
    var sign = MD5(MD5(base) + SALT);
    return encryptParams("id=" + articleId + (CAP.dn ? "&dn=" + encodeURIComponent(CAP.dn) : "")).then(function (body) {
      // rawCall 会置位 __oneqz_pause：即使钩子装在同一个世界，也不会把「模块 token 那次」
      // 反过来写进 CAP 污染 App 身份
      return rawCall(host + DETAIL, {
        method: "POST",
        body: body,
        headers: {
          "platform": PLATFORM,
          "uuid": ident.uuid,
          "timestamp": String(ts),
          "token": ident.token,
          "app-version": APP_VERSION,
          "sign": sign,
          "user-key": ident.userKey,
          "ip": "0.0.0.0",
          "content-type": "application/x-www-form-urlencoded"
        }
      });
    }).then(function (text) {
      var t = (text || "").trim();
      if (/^\{/.test(t)) return safeJson(t) || (function () { throw new Error("响应不是 JSON"); })();
      return tryDecrypt(t).then(JSON.parse);                     // 正常：加密响应
    });
  }
  function getDetail(articleId, ident, log) {
    var prefer = hostFromAppUrl();
    var hosts = (prefer ? [prefer] : []).concat(apiHosts()).filter(function (h, i, arr) { return h && arr.indexOf(h) === i; });
    var i = 0;
    function next() {
      if (i >= hosts.length) return Promise.reject(new Error("所有 api 域都失败"));
      var h = hosts[i++];
      log("  尝试 " + h + " …");
      return fetchDetail(articleId, ident, h).then(function (json) {
        CAP.apiHost = h;          // video_hls 要拼回同一个 api 域
        return json;
      }).catch(function (e) {
        log("  × " + String(e && e.message || e).slice(0, 90));
        return next();
      });
    }
    return next();
  }

  /* ---------- 判读 ---------- */
  function mb(v) {
    if (v == null || v === "") return "-";
    var n = Number(v);
    if (!isFinite(n) || n === 0) return String(v);      // 服务端已格式化成 "887MB" 这类字符串
    if (n > 1024 * 1024) return (n / 1048576).toFixed(1) + " MB";
    if (n > 1024) return (n / 1024).toFixed(1) + " KB";
    return n + " B";
  }
  /* 一次详情固定铺四格：正片/预告 × MP4/M3U8，有链接就是一条能点能复制的完整地址，
     没有就写清是哪一端没给。之所以经常缺「预告 M3U8」：接口只有一个清单槽位
     video_hls（video_hls_h265 是同一条正片的另一种编码，audio_hls 是音频的），
     它跟着 video_file 走 —— 解锁态给的是正片清单，锁定态给的就是预告清单。
     实测 id=63737：网页态（锁定）清单 48 秒/5 片，模块态（已购）168.8 分钟/1013 片。 */
  function summarize(d, log) {
    var pf = d.preview_video, vf = d.video_file;
    var locked = pf && vf === pf;
    var host = playHost();
    var hl = hlsUrl(d);
    var noHls = CAP.dn ? "已带 dn=" + CAP.dn + " 仍回空 —— 这个身份/条目只有 MP4"
                       : "请求体里没有 dn —— 不带 dn 服务端只给 MP4，给了 dn 才给 video_hls";
    function row(who, fmt, url, why) {
      if (url) log("   " + who + " · " + fmt + "   " + url);
      else log("   " + who + " · " + fmt + "   —— " + why, "dim");
    }
    log("标题      " + d.title + "   (model_id=" + d.model_id + ")");
    log("门控      buy=" + d.buy + "   coin=" + d.coin + "   原价=" + d.original_coin + "   限免=" + d.is_limit_free);
    log(locked ? "→ 锁定：video_file 与 preview_video 是同一个路径，服务端把正片换成了预告"
               : (pf ? "→ 解锁：video_file 与 preview_video 是两个不同文件"
                     : "→ 这个条目只有正片：preview_video 是空的，正片/预告两格里预告自然没链接"),
        locked ? "bad" : (pf ? "ok" : "dim"));
    if (locked) {
      row("正片", "MP4", "", "未解锁，服务端这次没返回正片文件");
      row("正片", "M3U8", "", "同上");
      row("预告", "MP4", videoUrl(pf, host), "锁定态服务端给的就是 preview_video");
      row("预告", "M3U8", hl, noHls);
    } else {
      row("正片", "MP4", videoUrl(vf, host), "服务端没给 video_file");
      row("正片", "M3U8", hl, noHls);
      row("预告", "MP4", videoUrl(pf, host), "服务端没给 preview_video —— 这个条目没有单独的预告文件");
      row("预告", "M3U8", "", "接口没有「预告清单」这个字段：video_hls 只有一个槽位，此刻装的是正片");
    }
    if (d.video_hls_h265) row(locked ? "预告" : "正片", "M3U8·h265", hlsUrl({ video_hls: d.video_hls_h265 }), "");
    log("   域名分工：MP4 拼媒体池域，M3U8 拼 api 域；清单里的 *.ts 分片域名 = 请求体里的 dn " +
        (locked ? "（锁定态这条清单就是上面那段预告）" : "（正片的清单）"), "dim");
    log("   播放域名 " + host + (CAP.playFrom ? "  （" + CAP.playFrom + "）" : "  （种子：媒体池成员，可在配置里改）"), "dim");
    log("   ts 域名(dn) " + (CAP.dn || "未拦到") + "   ← 只影响 M3U8 分片落在哪个域，mp4 不用它", "dim", true);
    if (!locked && vf) {
      var ms = mirrorUrls(vf);
      if (ms.length) log("   同一文件的其他镜像 " + ms.slice(0, 2).join("   "), "dim");
    }
    // size 是服务端声明的元数据，锁定态下同样显示正片标称大小，不能拿来当「拿到正片」的证据
    log("标称 size " + mb(d.size) + "（服务端元数据，与锁定状态无关，判据只看上面两个路径）", "dim");
    if (Array.isArray(d.episode) && d.episode.length) {
      var un = d.episode.filter(function (e) { return Number(e.unlocked) === 1; }).length;
      log("分集      " + d.episode.length + " 集，unlocked=" + un +
          "   free_episode_count=" + d.free_episode_count + "  unlock_remain=" + d.unlock_remain_episodes);
    }
    if (d.token) log("detail.token  " + d.token + "（客户端解析后丢弃，不参与取流）", "dim");
    if (d.notice_msg) log("服务端提示    " + d.notice_msg);
  }
  function summarizeInto(d, log, tag) {
    if (!d || !d.data) { log(tag + "：没有 data", "bad"); return; }
    log("── " + tag + " ──", "dim");
    summarize(d.data, log);
  }

  /* ---------- UI ---------- */
  /* 夹位置是「无论窗口怎么缩放，图标都必须在窗口里」的全部难度所在。
     写成不吃 DOM 的纯函数，_core_test.js 就能拿极端视口（320x240、比球还窄的视口）直接算，
     不用在浏览器里一寸一寸试。下面 clampPos/placeBody 是它们唯一的调用点。 */
  function clampInside(left, top, boxW, boxH, winW, winH, pad) {
    pad = pad || 8;
    var maxL = Math.max(pad, winW - boxW - pad);
    var maxT = Math.max(pad, winH - boxH - pad);
    return {
      left: Math.round(Math.min(Math.max(pad, left), maxL)),
      top:  Math.round(Math.min(Math.max(pad, top), maxT))
    };
  }
  /* 展开体贴哪一侧：下方放得下就下方；翻上方；上下都放不下就整块贴进可视区
     （这时宁可压住球——球能拖走，展开体里正在看的内容压掉才真的没法用）。 */
  function bodyPlace(fL, fT, fW, fH, bW, bH, winW, winH, pad) {
    pad = pad || 8;
    var gap = 8;
    var down = fT + fH + gap;
    var up = fT - gap - bH;
    var top;
    if (down + bH <= winH - pad) top = down;
    else if (up >= pad) top = up;
    else top = Math.max(pad, winH - bH - pad);
    var left = Math.min(Math.max(pad, fL), Math.max(pad, winW - bW - pad));
    var side = top >= fT + fH ? "down" : (top + bH <= fT ? "up" : "inside");
    return { left: Math.round(left), top: Math.round(top), side: side };
  }
  /* 行内文本一律走 textNode/anchor 节点，不碰 innerHTML：服务端字段（标题、提示语）里带尖括号
     也只能是文字。带 http(s) 的片段拆出来做成 <a target=_blank>，其余原样保留，选中照样能复制。 */
  var URL_SPLIT = /((?:https?:\/\/)[^\s，。；：、（）()【】「」『』“”‘’"'`]+)/;
  function appendLineText(line, text) {
    var parts = String(text).split(URL_SPLIT);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      if (/^https?:\/\//.test(p)) {
        var a = document.createElement("a");
        a.href = p;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        /* <a href> 默认是可拖的：从链接上按下再拖动会被浏览器当成「拖这个链接」，
           于是选不中文字。关掉拖拽，拖选才落在选字上，单击照旧开新标签页。 */
        a.draggable = false;
        a.textContent = p;
        line.appendChild(a);
      } else {
        line.appendChild(document.createTextNode(p));
      }
    }
  }

  var CSS = [
    /* 悬浮球是页面上唯一常驻的元素：可拖，位置由 JS 夹在视口内（left/top 而不是 right/bottom，
       否则拖动时两套锚点会打架）。touch-action:none 是给 pointermove 用的，少了它触屏一拖就变成滚动。 */
    "#oneqz-fab{position:fixed;z-index:2147483647;width:44px;height:44px;box-sizing:border-box;" +
      "border-radius:50%;border:1px solid #4a5060;background:#2b2f3a;color:#cfd6e6;" +
      "font:13px/1 ui-monospace,Consolas,monospace;display:flex;align-items:center;justify-content:center;" +
      "cursor:grab;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.45)}",
    "#oneqz-fab:active{cursor:grabbing}",
    "#oneqz-fab.st-ok{background:#1c3a26;border-color:#7ddc8f;color:#c7f5d2}",
    "#oneqz-fab.st-warn{background:#3a3320;border-color:#f0c674;color:#ffe6ac}",
    "#oneqz-fab.st-bad{background:#3a1c1c;border-color:#ff8f8f;color:#ffc9c9}",
    "#oneqz-fab .dot{position:absolute;right:-3px;top:-3px;min-width:16px;height:16px;padding:0 3px;" +
      "box-sizing:border-box;border-radius:8px;background:#f0c674;color:#1b1200;font-size:10px;" +
      "line-height:16px;text-align:center;display:none;pointer-events:none}",
    "#oneqz-fab .dot.on{display:block}",
    /* 展开体：点图标才出现。宽高都按视口收，位置由 placeBody 依图标周围的空间决定。
       页面本身是 Flutter 画布，它把 user-select 关掉了，展开体必须显式打开才能选中文字复制；
       -webkit-touch-callout:default 是给手机浏览器的长按复制留的。 */
    "#oneqz{position:fixed;z-index:2147483647;display:none;box-sizing:border-box;" +
      "width:min(760px,calc(100vw - 16px));max-height:min(70vh,calc(100vh - 60px));overflow:auto;" +
      "overscroll-behavior:contain;" +
      "user-select:text;-webkit-user-select:text;-webkit-touch-callout:default;cursor:text;" +
      "background:#16181f;border:1px solid #4a5060;border-radius:10px;padding:10px;" +
      "font:13px/1.5 ui-monospace,Consolas,monospace;color:#e8e8ee;box-shadow:0 6px 24px rgba(0,0,0,.5)}",
    "#oneqz.on{display:block}",
    "#oneqz ::selection,#oneqz::selection{background:#3a6ea5;color:#fff}",
    "#oneqz .status{margin:0 0 8px;color:#9aa3b8;font-size:11px/1.5;white-space:normal;word-break:break-all}",
    "#oneqz .btns{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px}",
    "#oneqz button{background:#2b2f3a;color:#e8e8ee;border:1px solid #4a5060;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit}",
    "#oneqz button:hover{background:#3a4050}",
    "#oneqz .panel{white-space:pre-wrap;word-break:break-all}",
    /* 链接：点一下新标签页打开，同时保留选中/长按复制。选中优先于跳转，所以拖选不会误开页面。 */
    "#oneqz .panel a{color:#7fd0ff;text-decoration:underline;text-underline-offset:2px;" +
      "cursor:pointer;user-select:text;-webkit-user-select:text;-webkit-user-drag:none;word-break:break-all}",
    "#oneqz .panel a:hover{background:#22303f;color:#cbeaff}",
    "#oneqz .cfg{margin:0 0 8px;padding:8px;border:1px solid #333a48;border-radius:6px;background:#11141b;display:none}",
    "#oneqz .cfg.on{display:block}",
    "#oneqz .cfg label{display:block;margin:4px 0;color:#9aa3b8}",
    "#oneqz .cfg input,#oneqz .cfg select{width:100%;box-sizing:border-box;background:#0d0f14;color:#e8e8ee;border:1px solid #3a4050;border-radius:4px;padding:4px;font:inherit}",
    /* 复选框不能跟着 input 的 width:100% 走，否则整行被撑成一个巨大的方块 */
    "#oneqz .cfg label.auto{background:#0f1320;border:1px solid #3a4050;border-radius:6px;padding:6px}",
    "#oneqz .cfg label.auto input[type=checkbox]{width:auto;margin:0 6px 0 0;vertical-align:-2px}",
    "#oneqz .ok{color:#7ddc8f}#oneqz .bad{color:#ff8f8f}#oneqz .dim{color:#8a93a8}",
    "#oneqz .json{color:#c3ffd8;max-height:40vh;overflow:auto;border-top:1px dashed #333a48;margin-top:6px;padding-top:6px}"
  ].join("\n");

  var panel, cfgBox, statusEl, hostDiv, fab, fabNum, fabDot, lastResult = null;
  var POS = { left: 12, top: 12 };   // 悬浮球左上角（不是中心）；夹取时按球的外框算
  var unread = 0;                    // 收起状态下又拦到了新东西，用球上的红点提醒
  var viewShown = false;             // 面板里当前是不是「某个视图」，而不是攒下来的流水日志

  function log(text, cls, plain) {
    if (!panel) return;
    var line = document.createElement("div");
    if (cls) line.className = cls;
    if (plain) line.textContent = String(text);   // 明确不该点的行（比如那个 404 的 ts 域）就走纯文本
    else appendLineText(line, text);              // 纯文本落地，只有 http(s) 片段升级为可点链接
    panel.appendChild(line);
    /* 现在滚动的是展开体，不是 .panel（panel 不再自己带 overflow），滚错对象面板就不会跟到底 */
    if (hostDiv) hostDiv.scrollTop = hostDiv.scrollHeight;
  }
  function reset() { if (panel) { panel.textContent = ""; lastResult = null; } }

  function isDetailPage() { return /detail|videoPlay|minified/i.test(location.hash || ""); }
  function hookTag() {
    var dirty = "";
    try { if ((window.__oneqz_layers || 1) > 1) dirty = " ⚠页面里有 " + window.__oneqz_layers + " 层钩子，刷新一次再测"; } catch (e) {}
    var auto = autoOn() ? " · 自动替换 token=开" + (STAT.repl ? "(" + STAT.repl + " 次)" : "") +
                          (STAT.replErr ? " ⚠有 " + STAT.replErr + " 次替换失败" : "") : "";
    if (HOOK.mode === "direct") return "钩子=直接拦 App ✓" + dirty + auto;
    if (HOOK.mode === "local" && HOOK.relay) return "钩子=注入回传 ✓" + dirty + auto;
    if (HOOK.mode === "local") return "钩子=沙箱 ✗(注入未生效，拦不到 App)" + dirty + auto;
    return "钩子=安装中…";
  }
  function hookOk() { return HOOK.mode === "direct" || HOOK.relay; }

  /* ---------- 悬浮球：定位 / 夹取 / 展开体跟随 ---------- */
  function vw() { return window.innerWidth || document.documentElement.clientWidth || 1024; }
  function vh() { return window.innerHeight || document.documentElement.clientHeight || 768; }
  function clampPos() {
    var s = fab ? { w: fab.offsetWidth || 44, h: fab.offsetHeight || 44 } : { w: 44, h: 44 };
    var p = clampInside(POS.left, POS.top, s.w, s.h, vw(), vh());
    POS.left = p.left; POS.top = p.top;
  }
  function placeFab() {
    if (!fab) return;
    clampPos();
    fab.style.left = POS.left + "px";
    fab.style.top  = POS.top + "px";
  }
  function savePos() { store.set("one_fab_pos", POS.left + "," + POS.top); }
  function loadPos() {
    var m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(String(store.get("one_fab_pos", "") || ""));
    if (m) { POS.left = +m[1]; POS.top = +m[2]; }
    else { POS.left = vw() - 56; POS.top = Math.round(vh() * 0.42); }   // 首装：右侧中部，竖屏也不压底部导航
    clampPos();
  }
  /* 展开体是独立的 fixed 层：位置由 bodyPlace 依球周围的空间决定。 */
  function placeBody() {
    if (!fab || !hostDiv || !isOpen()) return;
    var r = fab.getBoundingClientRect();
    var w = hostDiv.offsetWidth || Math.min(760, vw() - 16);
    var h = hostDiv.offsetHeight || 240;
    var p = bodyPlace(r.left, r.top, r.width || 44, r.height || 44, w, h, vw(), vh());
    hostDiv.style.top = p.top + "px";
    hostDiv.style.left = p.left + "px";
  }
  function onVpChange() { placeFab(); placeBody(); }
  function isOpen() { return !!hostDiv && hostDiv.classList.contains("on"); }
  function openBody() {
    if (!hostDiv) return;
    hostDiv.classList.add("on");
    if (unread) { unread = 0; }
    placeBody();
    updateFab();
    viewShown = true;      // 走到这里的一定是在渲染某个视图（诊断/看拦截/重取/切身份）
  }
  function closeBody() { if (hostDiv) hostDiv.classList.remove("on"); }
  function toggleBody() {
    if (isOpen()) { closeBody(); return; }
    var hadView = viewShown;
    openBody();
    /* 收起期间 log() 一直在往面板里堆流水，直接展开会看到一堆日志而不是当前拦截结果。
       所以只要还没有渲染过视图（或收起期间又来了新拦截），展开时先渲染一次拦截详情。 */
    if (!hadView) showAppCapture();
  }

  function updateFab() {
    if (!fab) return;
    var head = hookTag(), text, state;
    if (CAP.id) {
      text = head + " · 拦截到 id=" + CAP.id + (CAP.response ? " ✓（响应也解密了）" : " …（还没拿到响应）") +
             "  [" + (CAP.route || "?") + "]";
      state = "st-ok";
    } else if (hookOk()) {
      text = head + (STAT.seen
        ? " · 已拦到 App 的 " + STAT.seen + " 个请求（" + STAT.plain + " 个解密成功），里面没有文章 id —— 点进视频那一下才会带 id"
        : " · 从列表点进视频才会触发详情请求（刷新/直开不会）") + "  [" + (location.hash || "?") + "]";
      state = "st-warn";
    } else {
      text = head + " · [" + (location.hash || "?") + "]";
      state = "st-bad";
    }
    if (!isDetailPage()) text += "   当前路由不是详情页，拦到的东西不代表本页";
    fab.setAttribute("class", state);
    fab.title = text;
    if (fabNum) fabNum.textContent = CAP.id ? (CAP.response ? "✓" : "i") : (STAT.seen ? String(STAT.seen) : "·");
    if (fabDot) {
      fabDot.textContent = unread ? (unread > 99 ? "99+" : String(unread)) : "";
      fabDot.setAttribute("class", "dot" + (unread ? " on" : ""));
    }
    if (statusEl) statusEl.textContent = text;
  }
  /* 旧名字留着，调用点太多，含义变成「刷新悬浮球与状态行」 */
  function updateChip(why) { placeFab(); updateFab(); if (isOpen()) placeBody(); }

  function diagnose() {
    reset();
    openBody();
    log("诊断 " + new Date().toLocaleTimeString() + "   " + location.href);
    log("脚本版本   " + SCRIPT_VERSION + "   世界判定=" + WORLD +
        "   钩子模式=" + (HOOK.mode || "?"), hookOk() ? "ok" : "bad");
    log("拦截能力   " + (hookOk()
        ? "直接拦 App 的 fetch/XHR（与页面同世界）"
        : "只在沙箱，拦不到 App —— 需把 @grant 设为 none 让脚本进主世界"), hookOk() ? "ok" : "bad");
    var aspec = replaceSpec();
    log("自动替换   " + (autoOn()
        ? "开 —— 用 " + (aspec ? aspec.label : "?") + "，本次页面已换过 " + STAT.repl + " 次（付费类接口不碰）" +
          (STAT.replErr ? "；⚠ 有 " + STAT.replErr + " 次没换成，看上面报错行" : "")
        : "关（默认）—— 页面的请求原样发，只有点「用模块 token 重取」时才换身份"),
        autoOn() ? (STAT.replErr ? "bad" : "ok") : "dim");
    if (HOOK.error) log("注入报错   " + HOOK.error, "bad");
    try {
      log("传输指纹   XMLHttpRequest.open 被改写=" + (XMLHttpRequest.prototype.open.toString().indexOf("__oneqz") >= 0 ? "是" : "否") +
          "   fetch 被改写=" + (window.fetch.toString().indexOf("isDetailUrl") >= 0 || window.fetch.toString().indexOf("OF.apply") >= 0 ? "是" : "否"));
    } catch (e) { log("指纹读取失败 " + String(e && e.message || e), "dim"); }
    log("当前路由   " + (location.hash || "(空)") + "   详情页=" + (isDetailPage() ? "是" : "否"));
    log("钩子计数   经过 " + STAT.seen + " 次 · 请求体解密成功 " + STAT.plain + " 次 · 还原出 id " + STAT.ids + " 次",
        STAT.seen ? "ok" : "bad");
    STAT.last.slice(-6).reverse().forEach(function (x) {
      log("  " + x.ep + "   " + (x.ok ? (x.id ? "id=" + x.id : "体内无 id") : "无请求体/非本密钥") + "   " +
          new Date(x.at).toLocaleTimeString(), x.id ? "ok" : "dim");
    });
    if (CAP.id) {
      log("拦截结果   id=" + CAP.id + "   响应=" + (CAP.response ? "code " + CAP.response.code : "未解密"), "ok");
      return;
    }
    if (!STAT.seen) log("拦截结果   还没有任何 App 请求经过钩子", "bad");
    else log("拦截结果   钩子在收，但当前页面还没发过带文章 id 的请求", "dim");
    log("", "dim");
    log("这个 SPA 的详情请求只在你「从列表点卡片进详情」时才发；刷新或直开 #/videoDetail 它不发，就没有可拦的。", "dim");
    log("先确认这里显示「直接拦 App」；若显示「只在沙箱」，说明 Tampermonkey 把脚本放进了隔离世界——", "dim");
    log("  把脚本头部 @grant 改成 none（当前已是 none），或在 TM 设置里对该脚本关闭沙箱/允许访问页面主世界。", "dim");
  }

  function showAppCapture() {
    reset();
    openBody();
    if (!CAP.id) {
      log("还没有拦截到带文章 id 的请求。" + (STAT.seen ? "（钩子已收到 " + STAT.seen + " 个 App 请求，见下）" : "（钩子一次都没收到）"),
          STAT.seen ? "dim" : "bad");
      STAT.last.slice(-6).reverse().forEach(function (x) {
        log("  拦到 " + x.ep + "   " + (x.ok ? (x.id ? "id=" + x.id : "体内无 id") : "无请求体/非本密钥"), x.id ? "ok" : "dim");
      });
      log("脚本 " + SCRIPT_VERSION + " · " + hookTag() + "   路由 " + (location.hash || "?"), hookOk() ? "dim" : "bad");
      if (hookOk()) {
        log("钩子是好的，能拦到 App 的 XHR/fetch。拦不到，几乎一定是因为 App 在这一刻根本没发详情请求：", "dim");
        log("  · 这个 SPA 的详情页只认「从列表点卡片进来」时内存里传的 id；", "dim");
        log("  · 直接刷新或打开 #/videoDetail（哪怕 URL 里带 ?id=）App 会忽略、不发 /v2.5/article/detail，就没有可拦的请求。", "dim");
        log("正确触发：回发现页/收藏列表，点一张视频卡片进来 —— App 自己发的那次 detail 请求会被自动拦下并显示。", "ok");
      } else {
        log("× 拦不到 App 是因为脚本被放进了隔离世界，patch 的 fetch/XHR 只对沙箱生效 —— 点「诊断」看修法。", "bad");
      }
      return;
    }
    log("拦截来源   " + (CAP.route || "?") + "   POST /v2.5/" + (CAP.idFrom || "article/detail"));
    log("请求体明文 " + String(CAP.plain || ("id=" + CAP.id)).slice(0, 160) +
        "   ← id=" + CAP.id + "（URL 里没有它，只有请求体能给）", "ok");
    log("ts 域名(dn) " + (CAP.dn || "请求体里没有 dn") +
        "   ← 它就是 M3U8 清单里 *.ts 分片的域名（服务端把 dn 原样写进清单）；mp4 不用它，所以这里不做成链接", "dim", true);
    refreshPlayHost();
    log("播放域名   " + playHost() + (CAP.playHost ? "  （" + CAP.playFrom + "）" : "  （种子池成员；面板里可手填）") +
        "   ← 下面的完整链接用它 + 路径", "ok");
    var h = CAP.headers || {};
    log("网页 App 身份（本页登录态） uuid=" + (h.uuid || "-") + "   user-key=\"" + (h["user-key"] || "") + "\"  token@" + issOf(h.token));
    log("网页 App 时刻 " + new Date(CAP.at).toLocaleTimeString() + "   ts=" + (h.timestamp || "-"));
    if (CAP.response) {
      if (CAP.response.code !== 200) {
        log("网页 App 那次响应 code=" + CAP.response.code + " " + (CAP.response.message || ""), "bad");
      } else {
        summarizeInto(CAP.response, log, "网页 App 自己拿到的（本页登录态 = 页面默认值）");
        lastResult = CAP.response;
      }
    } else {
      log("App 响应尚未解密到：" + (CAP.respBad || "load 回调里没读到响应体（responseType 不是文本/二进制？）"), "dim");
    }
    log("", "dim");
    log("下一步：点「用模块 token 重取」——同一个 id 换 one 模块身份再请求，直接对比两个 token 的门控结果。", "dim");
  }

  function issOf(t) {
    if (!t) return "-";
    var m = /"iss"\s*:\s*"?(\d+)/.exec(t);
    if (m) return m[1];
    try {
      var parts = String(t).split(".");
      if (parts.length === 3) {
        var p = JSON.parse(b64.dec(parts[1]).reduce(function (s, b) { return s + String.fromCharCode(b); }, ""));
        return String(p.iss != null ? p.iss : "?");
      }
    } catch (e) {}
    return "?";
  }

  function run() {
    if (!CAP.id) { showAppCapture(); return; }
    reset();
    openBody();
    var mode = cfgBox ? cfgBox.querySelector("select[name=mode]").value : "module";
    var ident = identity(mode);
    if (!ident) { log("模式「网页 App 那次原样」还没拦截到请求，先用默认身份。", "bad"); ident = identity("module"); }
    log("文章 id    " + CAP.id + "（来自拦截到的 " + (CAP.idFrom || "?") + " 请求体，不是 URL）", "ok");
    log("身份       " + ident.label + "   user-key=\"" + ident.userKey + "\"  uuid=" + ident.uuid);
    log("接口       POST " + DETAIL + "   body=AES(id=" + CAP.id + (CAP.dn ? "&dn=" + CAP.dn : "") + ")" +
        (CAP.dn ? "" : "   ← 没带 dn，服务端不会给 video_hls，只有 MP4"), "dim");
    log("---- 请求中 ----", "dim");
    var t0 = Date.now();
    return getDetail(CAP.id, ident, log).then(function (json) {
      if (json.code !== 200) {
        log("× 服务端 code=" + json.code + "  " + (json.message || ""), "bad");
        if (json.code === 450) log("  450 = 该接口需要 user-key 解析成真实账号（detail 一般不该出现，说明 token 已失效）", "dim");
        if (json.code === 401) log("  401 = 签名/头校验失败；确认 uuid 是 8-4-4-4-12 小写、身份模式选对", "dim");
        return;
      }
      var d = json.data || {};
      log("✓ 解密成功  " + (Date.now() - t0) + "ms  字段数=" + Object.keys(d).length, "ok");
      summarize(d, log);
      if (CAP.response && CAP.response.code === 200 && CAP.response.data) {
        var a = CAP.response.data, b = d;
        var same = a.video_file === b.video_file && a.preview_video === b.preview_video;
        // params 是按「条目+账号+dn」生成的，两次即便指向同一份清单字符串也不会相同，所以只比给没给
        var sameHls = !!a.video_hls === !!b.video_hls;
        log("---- 与页面自己那次对比 ----", "dim");
        log("「网页 App」= 这个页面自己发出的请求，用的就是你浏览器的登录态，也就是本页的默认值；" +
            "「模块」= 脚本换成 one 模块 token 重发的同一次 detail。", "dim");
        log("网页 App 拿到  MP4  " + videoUrl(a.video_file), same ? "dim" : "ok");
        log("模块 token 拿到 MP4  " + videoUrl(b.video_file), same ? "dim" : "ok");
        log("网页 App 拿到  M3U8 " + (hlsUrl(a) || "（服务端没给）"), sameHls ? "dim" : "ok");
        log("模块 token 拿到 M3U8 " + (hlsUrl(b) || "（服务端没给）"), sameHls ? "dim" : "ok");
        log(same ? "→ 两次给的是同一个文件：这个 token 对本页的门控结果一致"
                  : "→ 两次给的不是同一个文件：门控由 token 所属账号决定，列表/详情都是服务端给的", same ? "dim" : "ok");
      }
      lastResult = json;
      console.log("[oneQZ] " + DETAIL + " 解密结果 id=" + CAP.id + " 身份=" + ident.label, json);
      var pre = document.createElement("div");
      pre.className = "json";
      pre.textContent = "完整 JSON（同一份已 console.log）\n" + JSON.stringify(json, null, 1);
      panel.appendChild(pre);
    }).catch(function (e) {
      log("× " + String(e && e.message || e), "bad");
    });
  }

  function copyJson() {
    if (!lastResult) { log("还没有结果可复制", "bad"); return; }
    var text = JSON.stringify(lastResult, null, 1);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { log("✓ 已复制 " + text.length + " 字节 JSON", "ok"); },
        function () { log("× 剪贴板被拒绝，请从面板文本手动复制", "bad"); });
    }
  }

  function build() {
    var st = document.createElement("style");
    st.textContent = CSS;
    (document.documentElement || document).appendChild(st);

    /* 同一个页面里被注入两次（改了脚本没刷新、或旧版还挂在文档级注入里）时，让最新这份接管 UI：
       先拆掉前一份的 DOM。否则 querySelector 拿到的是旧球，点出来的是旧代码的行为，排查会绕远路。 */
    Array.prototype.forEach.call(document.querySelectorAll("#oneqz, #oneqz-fab"), function (old) {
      if (old.parentNode) old.parentNode.removeChild(old);
    });

    hostDiv = document.createElement("div");
    hostDiv.id = "oneqz";
    hostDiv.innerHTML =
      '<div class="btns">' +
        '<button data-act="run" title="用选定身份重取同一 id 的详情">用模块 token 重取</button>' +
        '<button data-act="cap" title="显示拦截到的 App 请求与响应">看拦截</button>' +
        '<button data-act="diag" title="检查钩子装在哪个世界、为何拦不到">诊断</button>' +
        '<button data-act="copy" title="复制上一次解密出的 JSON">复制 JSON</button>' +
        '<button data-act="cfg" title="切换配置">⚙</button>' +
        '<button data-act="close" title="收起（也可以再点一次悬浮球）">收起 ✕</button>' +
      '</div>' +
      '<div class="status"></div>' +
      '<div class="cfg">' +
        '<label class="auto"><input type="checkbox" name="auto"> 自动替换页面的 token（默认关）' +
          '<span class="dim">开：App 自己发出的那些请求（详情/评论/点赞…）在离开浏览器前就换成 one 模块这一档的身份，' +
          'token/uuid/user-key/sign/ip 五个头一起重算，页面本身看到的就是替换后的结果，不用再点按钮。' +
          '关：页面的请求原样发，只有你点「用模块 token 重取」时才换。这个开关会被记住，下次进页面自动读回。' +
          '付费/扣币类接口永远不替换。</span></label>' +
        '<label>身份模式' +
          '<select name="mode"><option value="module">one 模块（uid 4406487，user-key 留空）</option>' +
          '<option value="page">网页当前登录态</option>' +
          '<option value="app">网页 App 刚发出的那次原样（拦截到的头）</option></select></label>' +
        '<label>模块 token（会覆盖内置值，换 exp 后粘新的）<input name="token" placeholder="eyJ0eXAiOiJKV1Qi…"></label>' +
        '<label>指定 api 域（留空=自动，优先用拦截到的域，再退 localStorage.current_domain 与种子池）<input name="host" placeholder="https://api.61c76a0.com"></label>' +
        '<label>播放域名（留空=自动：先取页面自己正在播的那次请求的域，再退媒体池种子。它和请求体里的 ts 域名 dn 不是一回事）<input name="play" placeholder="https://z4bey8.bx7qxb.com"></label>' +
        '<div class="dim" style="margin-top:6px">detail 只是读：本脚本不调用 purchase/buy，不扣币，不取流。</div>' +
      '</div>' +
      '<div class="panel"></div>';
    (document.body || document.documentElement).appendChild(hostDiv);
    panel = $(".panel", hostDiv);
    bindLinkSelectGuard(panel);
    cfgBox = $(".cfg", hostDiv);
    statusEl = $(".status", hostDiv);

    /* 悬浮球：默认页面上只有它。点=开关，按住拖=移位，位置存 GM/localStorage。 */
    fab = document.createElement("div");
    fab.id = "oneqz-fab";
    fab.setAttribute("class", "st-warn");
    fab.innerHTML = '<span class="num">·</span><span class="dot"></span>';
    (document.body || document.documentElement).appendChild(fab);
    fabNum = $(".num", fab);
    fabDot = $(".dot", fab);
    loadPos();
    placeFab();
    bindFabDrag();

    /* 窗口/可视区一变就把球夹回来，展开体跟着重定位 */
    window.addEventListener("resize", onVpChange);
    window.addEventListener("orientationchange", onVpChange);
    /* 手机浏览器收放地址栏、弹软键盘时常常只发 visualViewport 的 resize，
       少了这条，球会留在已经被顶出屏幕的位置上。 */
    try {
      if (window.visualViewport) window.visualViewport.addEventListener("resize", onVpChange);
    } catch (e) {}
    window.addEventListener("scroll", function () { if (isOpen()) placeBody(); }, true);
    try {
      if (window.ResizeObserver) {
        new ResizeObserver(onVpChange).observe(document.documentElement);
        /* 展开体自己是 max-height 内部滚动，但内容变化（比如复制出大 JSON）也会改高度，
           高度一变就可能顶出下边界，所以观察它自己的尺寸再重贴。 */
        new ResizeObserver(function () { placeBody(); }).observe(hostDiv);
      }
    } catch (e) {}

    cfgBox.querySelector("select[name=mode]").value = store.get("one_mode", "module");
    cfgBox.querySelector("input[name=token]").value = store.get("one_token", "");
    cfgBox.querySelector("input[name=host]").value = store.get("one_host", "");
    cfgBox.querySelector("input[name=play]").value = store.get("one_play_host", "");
    cfgBox.querySelector("input[name=auto]").checked = autoOn();
    armReplace();                      // 读回上次的开关：开就把 DOM 桥挂上，关就摘掉
    Array.prototype.forEach.call(cfgBox.querySelectorAll("select,input"), function (el) {
      el.addEventListener("change", function () {
        var k = el.name;
        if (k === "mode") store.set("one_mode", el.value);
        if (k === "host") store.set("one_host", el.value.trim());
        if (k === "play") { store.set("one_play_host", trimSlash(el.value.trim()));
                            log("播放域名已存为 " + (trimSlash(el.value.trim()) || "（留空=自动）") + "，下次取数/查看用它拼链接", "dim"); }
        if (k === "token") store.set("one_token", el.value.trim() || MODULE_TOKEN);
        if (k === "auto") {
          store.set("one_auto", el.checked ? "1" : "0");
          var s = armReplace();
          log(s ? "自动替换已开：" + s.label + " —— 页面自己发出的详情等请求会被换成这个身份（设置已记住，下次进页面读回）"
                : "自动替换已关：页面的请求原样发出去，只有点「用模块 token 重取」时才换身份", s ? "ok" : "dim");
          updateChip("auto");
        }
        if (k === "mode" || k === "token") armReplace();     // 身份来源变了，DOM 桥要跟着刷新
        if (k !== "mode") return;
        reset();
        openBody();
        var u = identity(el.value) || identity("module");
        log("已切到 " + u.label + "   user-key=\"" + u.userKey + "\"  uuid=" + u.uuid, "dim");
      });
    });

    hostDiv.addEventListener("click", function (ev) {
      var act = ev.target && ev.target.getAttribute("data-act");
      if (!act) return;
      if (act === "run") run();
      else if (act === "cap") showAppCapture();
      else if (act === "diag") diagnose();
      else if (act === "copy") copyJson();
      else if (act === "close") closeBody();
      else { cfgBox.classList.toggle("on"); placeBody(); }
      if (isOpen()) placeBody();
    });
    /* 展开体上的滚动/触摸不要漏给下层页面，否则在 Flutter 画布上滑动会变成页面自己在动 */
    ["pointerdown", "wheel", "touchstart"].forEach(function (t) {
      hostDiv.addEventListener(t, function (ev) { ev.stopPropagation(); }, { passive: true });
    });

    updateChip("init");
  }

  /* 从链接上按住拖动是为了选字复制，浏览器却会在抬手时补一个 click 把新标签页打开。
     记住「这次按下有没有真的拖动」，拖过就把紧随其后的那次链接点击吃掉——单纯单击照常跳转。 */
  function bindLinkSelectGuard(root) {
    var down = null, dragged = false;
    root.addEventListener("pointerdown", function (ev) { down = { x: ev.clientX, y: ev.clientY }; dragged = false; });
    root.addEventListener("pointermove", function (ev) {
      if (!down) return;
      if (Math.abs(ev.clientX - down.x) + Math.abs(ev.clientY - down.y) > 4) dragged = true;
    });
    root.addEventListener("pointerup", function () { down = null; });
    root.addEventListener("pointercancel", function () { down = null; dragged = false; });
    root.addEventListener("click", function (ev) {
      if (!dragged) return;
      dragged = false;
      var a = ev.target && ev.target.closest ? ev.target.closest("a") : null;
      if (!a) return;
      ev.preventDefault();
      ev.stopPropagation();
    }, true);
  }

  /* 拖动用 Pointer Events：鼠标/触屏/画笔一套代码。
     setPointerCapture 是关键——球只有 44px，不抓住指针的话拖到一半就收不到后续 move。
     位移超过阈值才算拖，抬手时不再触发开关，免得拖完顺手把面板弹开。 */
  function bindFabDrag() {
    var drag = null;
    fab.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
    fab.addEventListener("pointerdown", function (ev) {
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, ox: POS.left, oy: POS.top, moved: false };
      try { fab.setPointerCapture(ev.pointerId); } catch (e) {}
      fab.setAttribute("data-drag", "1");
      ev.stopPropagation();
      ev.preventDefault();
    });
    fab.addEventListener("pointermove", function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) <= 5) return;
      drag.moved = true;
      POS.left = drag.ox + dx;
      POS.top = drag.oy + dy;
      placeFab();                 // 边拖边夹，拖出窗口边缘也会立刻回到可见区
      if (isOpen()) placeBody();
    });
    fab.addEventListener("pointerup", function (ev) {
      if (!drag) return;
      var moved = drag.moved;
      try { fab.releasePointerCapture(ev.pointerId); } catch (e) {}
      fab.removeAttribute("data-drag");
      drag = null;
      if (moved) { savePos(); ev.stopPropagation(); return; }
      toggleBody();               // 轻点：展开 / 收起
      ev.stopPropagation();
    });
    fab.addEventListener("pointercancel", function () {
      if (drag && drag.moved) savePos();
      drag = null;
      if (fab) fab.removeAttribute("data-drag");
    });
  }

  /* Flutter web 是用 history.pushState 改「hash」的，hashchange 根本不触发：
     只监听 hashchange 的话，App 里换页既不会清掉上一页的拦截结果，也不会自动收起，
     状态行还会一直挂着按旧路由算出来的那句提示。 */
  var lastRoute = "";
  function watchRoute() {
    lastRoute = location.hash || "";
    window.addEventListener("hashchange", onRoute);
    ["pushState", "replaceState"].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== "function") return;
      history[m] = function () {
        var r = orig.apply(history, arguments);
        try { window.dispatchEvent(new Event("oneqz-nav")); } catch (e) {}
        return r;
      };
    });
    window.addEventListener("oneqz-nav", onRoute);
  }
  function onRoute() {
    var now = location.hash || "";
    if (now === lastRoute) return;         // pushState 经常带着同一个 hash 反复调，别每次都当换页
    lastRoute = now;
    updateChip("route");                   // 状态行先跟上真实路由
    if (CAP.route === now) return;         // 还停在拦到那次请求的页面上，结果仍然是本页的，不清
    clearCapture("route");
    if (panel) reset();
    viewShown = false;
    closeBody();                           // 换页就收回图标，别把上一页的结论留在新页面上
  }

  function start() {
    build();
    watchRoute();
    onCapture(function (kind) {
      if (!isOpen() && (kind === "id" || kind === "resp")) { unread++; viewShown = false; }
      updateChip(kind);
      if (kind === "hook") log("钩子就绪：" + hookTag() + "  世界=" + WORLD + (HOOK.error ? "（" + HOOK.error + "）" : ""),
                                hookOk() ? "ok" : "bad");
      else if (kind === "id") log("拦到 id=" + CAP.id + "（来自 App 自己发的 " + (CAP.idFrom || "?") + "，路由 " + (CAP.route || "?") + "）", "ok");
      /* 拦到响应不再自动展开：默认收起是用户要的形态，改成球上点亮角标，点开才看 */
      else if (kind === "resp") { log("拦截到该请求的响应，已用同一把密钥解密", "ok"); if (isOpen()) showAppCapture(); }
      else if (kind === "body-noid") log("拦到 " + epOf(CAP.urlFull) + "，请求体能解密但体内没有 id", "dim");
      else if (kind === "body-bad") log("拦到 " + epOf(CAP.urlFull) + "，请求体解密失败（不是这套 AES 的密文）", "dim");
    });
    updateChip("start");
    console.log("[oneQZ] 钩子安装中：等待 App 发出 POST " + DETAIL);
  }

  if (!crypto || !crypto.subtle) {
    // 非安全上下文（http://）时 WebCrypto 不存在，给出可见提示而不是静默失败
    var warn = document.createElement("div");
    warn.style.cssText = "position:fixed;left:8px;top:8px;z-index:2147483647;background:#400;color:#fff;padding:6px;border-radius:6px;font:13px monospace";
    warn.textContent = "oneQZ: 当前上下文没有 WebCrypto（需要 https），脚本无法加解密";
    document.documentElement.appendChild(warn);
    return;
  }
  installHooks();
  armReplace();      // 面板还没建也先把 DOM 桥挂上：App 的第一次详情可能早于 DOMContentLoaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();


