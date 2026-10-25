// ==UserScript==
// @name         j7tu 跳过开屏广告
// @namespace    https://j7tu.com/
// @version      1.0.0
// @description  跳过 j7tu.com 启动页开屏广告，直接进入首页（自动点击右上角的倒计时跳过按钮）
// @match        https://j7tu.com/*
// @match        https://www.j7tu.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 原理：
 *   本站是 Flutter Web 应用，启动页（#/splash）上是一张全屏广告图，
 *   右上角有一个「5S / 4S …」倒计时按钮，点它就会立刻跳到首页（#/app）。
 *   这个按钮画在 canvas 上，没有 DOM 节点，所以脚本按固定坐标
 *   （视口右上角）向 Flutter 的 flt-glass-pane 派发指针事件，等价于用鼠标点它。
 *
 *   脚本只在「启动页路由」上工作：一旦地址变成 #/app 或其它路由就自动停止，
 *   不会影响你在站内的正常浏览。
 */

(function () {
  'use strict';

  // ---- 可调参数 ----------------------------------------------------------
  // 跳过按钮中心点相对「视口右上角」的偏移（CSS px）。
  // 按钮本身在右上角，实测 31px 正好落在按钮上；点偏一点也没关系，
  // 它的可点区域比看上去大。
  var SKIP_X_FROM_RIGHT = 31;
  var SKIP_Y = 16;

  var FIRST_TRY_DELAY = 800;    // Flutter 引擎启动前点了也没用，先等一会儿
  var RETRY_INTERVAL = 400;     // 重试间隔
  var TAP_COOLDOWN = 500;       // 点一次后等页面跳转，避免连点
  var GIVE_UP_AFTER = 20000;    // 20 秒还没跳过就放弃（例如站点改版 / 加载太慢）
  // -----------------------------------------------------------------------

  var startedAt = Date.now();
  var lastTapAt = 0;
  var timer = null;

  // 启动页的路由形态：空 hash、#/、#/splash
  function isSplashRoute() {
    var h = location.hash;
    return h === '' || h === '#' || h === '#/' || h === '#/splash';
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function firePointer(pane, x, y) {
    var base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      width: 1,
      height: 1
    };

    function dispatch(type, extra) {
      var Ctor;
      if (type.indexOf('pointer') === 0) {
        Ctor = window.PointerEvent || window.MouseEvent;
      } else {
        Ctor = window.MouseEvent;
      }
      var init = {};
      for (var k in base) {
        if (Object.prototype.hasOwnProperty.call(base, k)) init[k] = base[k];
      }
      for (var j in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, j)) init[j] = extra[j];
      }
      pane.dispatchEvent(new Ctor(type, init));
    }

    // Flutter 需要完整的 down → up → click 序列才会判定为一次点击
    dispatch('pointerdown', { button: 0, buttons: 1 });
    dispatch('mousedown', { button: 0, buttons: 1 });
    dispatch('pointerup', { button: 0, buttons: 0 });
    dispatch('mouseup', { button: 0, buttons: 0 });
    dispatch('click', { button: 0, buttons: 0 });
  }

  function tapSkipButton() {
    var pane = document.querySelector('flt-glass-pane');
    if (!pane) return false;

    var x = window.innerWidth - SKIP_X_FROM_RIGHT;
    var y = SKIP_Y;
    firePointer(pane, x, y);
    return true;
  }

  function tick() {
    var now = Date.now();

    // 已经离开启动页（进入首页或其它路由）→ 任务完成，停止
    if (!isSplashRoute()) {
      stop();
      return;
    }
    if (now - startedAt > GIVE_UP_AFTER) {
      stop();
      return;
    }
    if (now - startedAt < FIRST_TRY_DELAY) return;
    if (now - lastTapAt < TAP_COOLDOWN) return;

    if (tapSkipButton()) lastTapAt = now;
  }

  timer = setInterval(tick, RETRY_INTERVAL);
  tick();
})();
