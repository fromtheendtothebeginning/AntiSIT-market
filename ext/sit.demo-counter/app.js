/* 「记一笔」的逻辑：读 App 配色、用自己的存储记数、改卡片简介、弹提示。
   注意：网页直接用 antiSIT 之前先等它出现——垫片是 App 在页面加载完成后注入的，
   同步脚本里它可能还没到（在普通浏览器里打开则永远没有，这里退化成内存计数）。 */
(function () {
  'use strict';

  var KEY = 'count';

  // 等垫片（最多等 2 秒；没有就当成在普通浏览器里看这个页面）
  function waitForBridge(ms) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + ms;
      (function poll() {
        if (window.antiSIT) return resolve(window.antiSIT);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(poll, 50);
      })();
    });
  }

  var api = null;
  var memory = 0; // 没有垫片时的降级存储

  async function read() {
    if (!api) return memory;
    var v = await api.call('storage.get', { key: KEY });
    return typeof v === 'number' ? v : 0;
  }

  async function write(n) {
    if (!api) { memory = n; return; }
    await api.call('storage.set', { key: KEY, value: n });
  }

  function render(n) {
    document.getElementById('count').textContent = n;
    document.getElementById('meta').textContent =
      n === 0 ? '还没记过' : '已经记了 ' + n + ' 笔';
  }

  async function set(value) {
    var n = Math.max(0, Math.round(value));
    await write(n);
    render(n);
    if (api) {
      // 卡片简介跟着数据走，回到列表就能看见
      await api.call('card.setDesc', { text: n === 0 ? '还没记过' : '已记 ' + n + ' 笔' });
    }
    return n;
  }

  async function bump() {
    var n = await set((await read()) + 1);
    if (api) api.post('toast', { text: '已记 ' + n });
  }

  (async function init() {
    api = await waitForBridge(2000);

    // 跟着 App 的配色走，不用自己猜深浅色
    if (api) {
      try {
        var t = await api.call('theme');
        document.documentElement.style.setProperty('--bg', t.bg);
        document.documentElement.style.setProperty('--card', t.card);
        document.documentElement.style.setProperty('--text', t.textPrimary);
        document.documentElement.style.setProperty('--muted', t.textMuted);
        document.documentElement.style.setProperty('--accent', t.accent);
      } catch (e) { /* 拿不到配色就用默认的 */ }
    }

    render(await read());
    document.getElementById('add').addEventListener('click', bump);
    document.getElementById('reset').addEventListener('click', function () { set(0); });
  })();
})();
