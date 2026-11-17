/*! 截止提醒 for AntiSIT — Cordis extension.
 *  Copyright (C) 2026 AntiSIT contributors
 *  SPDX-License-Identifier: GPL-3.0-only
 *
 *  原创实现：数据只存在本机（ctx.storage），不联网、不读取任何账号信息。
 *  职责只有两件事：按截止时间陈列未完成的作业/考试，并在到点前推送提醒。
 */

const STORE_KEY = 'items.v1';
const DEFAULT_OFFSETS = [1440, 180];
const OFFSET_CHOICES = [
  { m: 10080, label: '提前 1 周' },
  { m: 1440, label: '提前 1 天' },
  { m: 180, label: '提前 3 小时' },
  { m: 30, label: '提前 30 分钟' },
];
const KIND_LABEL = { homework: '作业', exam: '考试', other: '其他' };

let ctx = null;
let rootEl = null;
let listEl = null;
let summaryEl = null;
let warnEl = null;
let schoolEl = null;
let items = [];
let lastOverdue = '';
let popupShown = false;
let ticker = null;
let scheduledKeys = [];
let chaoxing = {
  hasCookie: false,
  syncing: false,
  error: '',
  lastSync: 0,
  step: '',
  armedClear: false,
  background: false,
  timer: null,
};

export default {
  name: 'deadline-reminder',
  inject: ['ui', 'storage', 'notify', 'secrets', 'net', 'clipboard', 'login', 'background'],
  async apply(host) {
    ctx = host;
    rootEl = ctx.ui.root;
    rootEl.innerHTML = `
      <div class="dl">
        <header class="dl-head">
          <div class="dl-heading">
            <h1>截止提醒</h1>
            <p id="dl-summary">正在读取…</p>
          </div>
          <button id="dl-add" class="dl-primary" type="button">＋ 添加</button>
        </header>
        <p id="dl-warn" class="dl-warn hidden"></p>
        <div class="dl-tools">
          <button id="dl-import" type="button">粘贴导入</button>
          <button id="dl-done" type="button">已完成</button>
        </div>
        <div id="dl-school" class="dl-school"></div>
        <div id="dl-list" class="dl-list"></div>
      </div>`;

    summaryEl = rootEl.querySelector('#dl-summary');
    warnEl = rootEl.querySelector('#dl-warn');
    listEl = rootEl.querySelector('#dl-list');
    schoolEl = rootEl.querySelector('#dl-school');
    ctx.effect(() => {
      const onAdd = () => openEditor(null);
      const onImport = () => openImport();
      const onDone = () => openCompleted();
      rootEl.querySelector('#dl-add').addEventListener('click', onAdd);
      rootEl.querySelector('#dl-import').addEventListener('click', onImport);
      rootEl.querySelector('#dl-done').addEventListener('click', onDone);
      listEl.addEventListener('click', onListClick);
      schoolEl.addEventListener('click', onSchoolClick);
      return () => {
        rootEl.querySelector('#dl-add').removeEventListener('click', onAdd);
        rootEl.querySelector('#dl-import').removeEventListener('click', onImport);
        rootEl.querySelector('#dl-done').removeEventListener('click', onDone);
        listEl.removeEventListener('click', onListClick);
        schoolEl.removeEventListener('click', onSchoolClick);
      };
    });

    ctx.effect(() => {
      ticker = setInterval(tick, 30000);
      return () => {
        clearInterval(ticker);
        ticker = null;
      };
    });

    // 关掉拓展页时停止定时器与前台保活
    ctx.effect(() => () => {
      stopBackgroundTimer();
      if (chaoxing.background) {
        ctx.background.keepAlive({ enabled: false }).catch(() => {});
      }
    });

    items = await loadInventory();
    const storedKeys = await ctx.storage.get('notifiedKeys');
    if (Array.isArray(storedKeys)) scheduledKeys = storedKeys.map(String);
    await loadSchoolState();
    if (chaoxing.background) {
      try {
        await ctx.background.keepAlive({
          enabled: true,
          title: '截止提醒',
          text: '正在后台刷新学习通',
        });
      } catch (_) {}
      startBackgroundTimer();
    }
    renderList();
    renderSchool();
    await syncNotifications();
    maybePopup();
    if (chaoxing.hasCookie && Date.now() - (chaoxing.lastSync || 0) > 10 * 60 * 1000) {
      syncChaoxing();
    }
  },
};

// ==================== 列表 ====================

function onListClick(event) {
  const toggle = event.target.closest('[data-act="toggle"]');
  if (toggle) {
    const row = toggle.closest('[data-id]');
    if (row) toggleDone(row.getAttribute('data-id'));
    return;
  }
  const row = event.target.closest('[data-id]');
  if (!row) return;
  const item = items.find((it) => it.id === row.getAttribute('data-id'));
  if (!item) return;
  if (item.readonly) {
    openSyncedDetail(item);
    return;
  }
  openEditor(item);
}

// ==================== 学习通（拓展自己对接，App 不参与）====================

const CX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CX_COOKIE_KEY = 'chaoxing.cookie';
const CX_HOST = 'https://mooc1.chaoxing.com';
const CX_COURSE_URL = 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata'
  + '?view=json&getTchClazzType=1&mcode=';
const CX_EXAM_URL = 'https://mooc1-api.chaoxing.com/exam-ans/exam/test/examcode/examlist';

function onSchoolClick(event) {
  const action = event.target.closest('[data-school]')?.getAttribute('data-school');
  if (!action) return;
  if (action === 'login') loginChaoxing();
  else if (action === 'paste') pasteCookie();
  else if (action === 'manual') openCookieEditor();
  else if (action === 'sync') syncChaoxing();
  else if (action === 'background') toggleBackground();
  else if (action === 'clear') clearCookie();
}

async function loadSchoolState() {
  try {
    const value = await ctx.secrets.get(CX_COOKIE_KEY);
    chaoxing.hasCookie = !!(value && value.trim());
    chaoxing.lastSync = Number(await ctx.storage.get('chaoxing.lastSync')) || 0;
    chaoxing.background = !!(await ctx.storage.get('chaoxing.background'));
  } catch (_) {
    chaoxing.hasCookie = false;
  }
}

function renderSchool() {
  if (!schoolEl) return;
  let body;
  if (!chaoxing.hasCookie) {
    body = `
      <div class="dl-school-row">
        <span class="dl-school-title">学习通</span>
        <span class="dl-hint">登录后自动同步作业与考试；也可以从剪贴板导入 Cookie。</span>
      </div>
      <div class="dl-school-actions">
        <button class="dl-school-btn" type="button" data-school="login">登录学习通</button>
        <button class="dl-link dl-quiet-link" type="button" data-school="paste">从剪贴板导入</button>
        <button class="dl-link dl-quiet-link" type="button" data-school="manual">手动粘贴</button>
      </div>`;
  } else {
    const when = chaoxing.lastSync ? agoText(chaoxing.lastSync) : '尚未同步';
    body = `
      <div class="dl-school-row">
        <span class="dl-school-dot${chaoxing.syncing ? ' is-busy' : ''}"></span>
        <span class="dl-school-title">学习通</span>
        <span class="dl-school-text">${chaoxing.syncing ? esc(chaoxing.step || '同步中…') : when}</span>
      </div>
      <div class="dl-school-actions">
        <button class="dl-school-btn" type="button" data-school="sync"${chaoxing.syncing ? ' disabled' : ''}>同步</button>
        <button class="dl-link" type="button" data-school="login">重新登录</button>
        <button class="dl-link" type="button" data-school="paste">从剪贴板更新</button>
        <button class="dl-link dl-quiet-link" type="button" data-school="clear">${chaoxing.armedClear ? '再点一次清除' : '清除'}</button>
      </div>
      <div class="dl-school-bg">
        <button class="dl-link" type="button" data-school="background">${chaoxing.background ? '关闭后台刷新' : '开启后台刷新'}</button>
        <span class="dl-hint">保持本页打开并退到后台，每 30 分钟同步；会显示常驻通知。</span>
      </div>`;
  }
  schoolEl.innerHTML = body
    + (chaoxing.error ? `<p class="dl-warn-text">${esc(chaoxing.error)}</p>` : '');
}

function agoText(ms) {
  const diff = Date.now() - ms;
  if (diff < 60000) return '刚刚同步';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前同步';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前同步';
  return Math.floor(diff / 86400000) + ' 天前同步';
}

function normalizeCookie(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^cookie\s*:\s*/i, '');
  text = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('; ');
  return text.includes('=') ? text : '';
}

async function saveCookie(raw) {
  const cookie = normalizeCookie(raw);
  if (!cookie) {
    ctx.ui.toast('没有识别到 Cookie，请复制形如 a=1; b=2 的文本');
    return false;
  }
  await ctx.secrets.set(CX_COOKIE_KEY, cookie);
  chaoxing.hasCookie = true;
  chaoxing.error = '';
  renderSchool();
  return true;
}

async function loginChaoxing() {
  try {
    const result = await ctx.login.open({
      url: 'https://passport2.chaoxing.com/login?fid=&refer=http://i.chaoxing.com',
      cookieUrls: [
        'https://chaoxing.com',
        'https://passport2.chaoxing.com',
        'https://i.chaoxing.com',
        'https://mooc1.chaoxing.com',
        'https://mooc1-api.chaoxing.com',
        'https://mooc2-ans.chaoxing.com',
      ],
      title: '连接学习通',
      successCookie: '_uid',
      successUrlPrefix: 'https://i.chaoxing.com',
    });
    const header = (result && result.cookieHeader) || '';
    if (!header) {
      ctx.ui.toast('没有拿到学习通 Cookie');
      return;
    }
    await ctx.secrets.set(CX_COOKIE_KEY, header);
    chaoxing.hasCookie = true;
    chaoxing.error = '';
    renderSchool();
    ctx.ui.toast('已登录学习通');
    await syncChaoxing();
  } catch (e) {
    const message = errText(e);
    if (message) ctx.ui.toast(message);
  }
}

async function pasteCookie() {
  try {
    const text = await ctx.clipboard.read();
    if (!(await saveCookie(text))) return;
    ctx.ui.toast('已从剪贴板保存 Cookie');
    await syncChaoxing();
  } catch (e) {
    const message = errText(e);
    if (message) ctx.ui.toast(message);
  }
}

function openCookieEditor() {
  const page = ctx.ui.push({ onPop: () => renderSchool() });
  page.root.innerHTML = `
    <div class="dl-page">
      <header class="dl-page-head">
        <button class="dl-back" type="button" data-close aria-label="返回">‹</button>
        <h1>粘贴学习通 Cookie</h1>
      </header>
      <div class="dl-form">
        <p class="dl-hint">在浏览器登录学习通后，从开发者工具 Network 里复制请求头
          <code>Cookie</code> 的值，或用 Cookie 导出扩展复制。整段粘贴即可。</p>
        <textarea id="f-cookie" rows="8" placeholder="_uid=...; _d=...; uf=...; fid=..."></textarea>
        <div class="dl-actions">
          <button id="f-save" class="dl-primary" type="button">保存并同步</button>
        </div>
      </div>
    </div>`;
  page.root.querySelector('[data-close]').addEventListener('click', () => page.close());
  page.root.querySelector('#f-save').addEventListener('click', async () => {
    const text = page.root.querySelector('#f-cookie').value;
    if (!(await saveCookie(text))) return;
    page.close();
    await syncChaoxing();
  });
}

async function clearCookie() {
  if (!chaoxing.armedClear) {
    chaoxing.armedClear = true;
    renderSchool();
    setTimeout(() => {
      if (!chaoxing.armedClear) return;
      chaoxing.armedClear = false;
      renderSchool();
    }, 3000);
    return;
  }
  chaoxing.armedClear = false;
  try {
    await ctx.secrets.remove(CX_COOKIE_KEY);
  } catch (_) {}
  items = items.filter((it) => it.source !== 'chaoxing');
  chaoxing.hasCookie = false;
  chaoxing.lastSync = 0;
  chaoxing.error = '';
  await ctx.storage.remove('chaoxing.lastSync');
  await persist();
  renderList();
  await syncNotifications();
  renderSchool();
  ctx.ui.toast('已清除学习通 Cookie');
}

async function toggleBackground() {
  if (chaoxing.background) {
    chaoxing.background = false;
    await ctx.storage.set('chaoxing.background', false);
    stopBackgroundTimer();
    try {
      await ctx.background.keepAlive({ enabled: false });
    } catch (_) {}
    renderSchool();
    ctx.ui.toast('已关闭后台刷新');
    return;
  }
  try {
    await ctx.background.keepAlive({
      enabled: true,
      title: '截止提醒',
      text: '正在后台刷新学习通',
    });
    chaoxing.background = true;
    await ctx.storage.set('chaoxing.background', true);
    startBackgroundTimer();
    renderSchool();
    ctx.ui.toast('已开启后台刷新');
  } catch (e) {
    const message = errText(e);
    if (message) ctx.ui.toast(message);
  }
}

function startBackgroundTimer() {
  stopBackgroundTimer();
  chaoxing.timer = setInterval(() => {
    if (!chaoxing.syncing) syncChaoxing();
  }, 30 * 60 * 1000);
}

function stopBackgroundTimer() {
  if (chaoxing.timer) {
    clearInterval(chaoxing.timer);
    chaoxing.timer = null;
  }
}

async function syncChaoxing() {
  if (chaoxing.syncing) return;
  let cookie = '';
  try {
    cookie = (await ctx.secrets.get(CX_COOKIE_KEY)) || '';
  } catch (_) {}
  if (!cookie.trim()) {
    ctx.ui.toast('先导入学习通 Cookie');
    return;
  }
  chaoxing.syncing = true;
  chaoxing.error = '';
  chaoxing.step = '读取课程…';
  renderSchool();
  try {
    const result = await fetchChaoxingDeadlines(cookie.trim(), (step) => {
      chaoxing.step = step;
      renderSchool();
    });
    mergeSynced(result.items);
    chaoxing.lastSync = Date.now();
    await ctx.storage.set('chaoxing.lastSync', chaoxing.lastSync);
    if (result.errors.length) {
      chaoxing.error = '部分课程没同步成功：'
        + result.errors.slice(0, 2)
          .map((e) => (e.course ? e.course + '：' : '') + e.message).join('；');
    }
    await persist();
    renderList();
    await syncNotifications();
    if (!result.errors.length) ctx.ui.toast('已同步 ' + result.items.length + ' 条');
  } catch (e) {
    chaoxing.error = errText(e);
    ctx.ui.toast('同步失败：' + chaoxing.error);
  } finally {
    chaoxing.syncing = false;
    chaoxing.step = '';
    renderSchool();
  }
}

async function fetchChaoxingDeadlines(cookie, onStep) {
  async function get(url) {
    const res = await ctx.net.request({
      method: 'GET',
      url,
      headers: {
        Cookie: cookie,
        'User-Agent': CX_UA,
        Referer: CX_HOST + '/',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    const text = res && typeof res.text === 'string' ? res.text : '';
    if (res.status === 401 || res.status === 403
        || text.includes('passport2.chaoxing.com/login')) {
      throw new Error('学习通登录已失效，请重新导入 Cookie');
    }
    if (res.status >= 400) throw new Error('学习通返回 HTTP ' + res.status);
    return text;
  }

  const found = [];
  const errors = [];
  onStep('读取课程…');
  const courses = parseCourseList(await get(CX_COURSE_URL));

  for (const course of courses) {
    onStep('作业：' + course.name);
    try {
      found.push(...(await fetchCourseHomework(course, get)));
    } catch (e) {
      if (/登录已失效/.test(errText(e))) throw e;
      errors.push({ course: course.name, message: errText(e) });
    }
    await sleep(150);
  }

  onStep('考试…');
  try {
    found.push(...(await fetchExams(get)));
  } catch (e) {
    if (/登录已失效/.test(errText(e))) throw e;
    errors.push({ course: '考试', message: errText(e) });
  }

  const byId = new Map();
  for (const item of found) byId.set(item.id, item);
  const sorted = [...byId.values()].sort((a, b) => a.due - b.due);
  return { items: sorted, errors };
}

async function fetchCourseHomework(course, get) {
  const middle = await get(CX_HOST + '/visit/stucoursemiddle?courseid='
    + encodeURIComponent(course.id)
    + '&clazzid=' + encodeURIComponent(course.classId)
    + '&cpi=' + encodeURIComponent(course.cpi)
    + '&ismooc2=1&v=2');
  const hidden = hiddenInputs(middle);
  const workEnc = (hidden.workEnc || '').trim();
  if (!workEnc) return [];

  const params = new URLSearchParams({
    courseId: course.id,
    classId: course.classId,
    cpi: course.cpi,
    ut: 's',
    openc: hidden.openc || '',
    enc: workEnc,
    t: String(Date.now()),
    stuenc: hidden.enc || '',
    isdisplaytable: '2',
  });
  const html = await get(CX_HOST + '/mooc2/work/list?' + params.toString());
  if (html.includes('没有此页面访问权限')) {
    throw new Error('作业列表签名被拒');
  }

  const out = [];
  for (const row of parseWorkList(html)) {
    if (!isWorkPending(row.status)) continue;
    try {
      const due = parseWorkDeadline(await get(row.url));
      if (!due) continue;
      const workId = paramOf(row.url, 'workId') || hash(row.url);
      out.push({
        id: 'cx-w-' + course.id + '-' + workId,
        title: row.title || '未命名作业',
        course: course.name,
        kind: 'homework',
        due,
        source: 'chaoxing',
        url: row.url,
      });
    } catch (e) {
      if (/登录已失效/.test(errText(e))) throw e;
    }
    await sleep(120);
  }
  return out;
}

async function fetchExams(get) {
  const html = await get(CX_EXAM_URL);
  const out = [];
  for (const row of parseExamRows(html)) {
    if (row.done) continue;
    out.push({
      id: 'cx-e-' + hash(row.name + '|' + row.start),
      title: row.name || '未命名考试',
      course: '',
      kind: 'exam',
      due: row.end,
      source: 'chaoxing',
      url: '',
    });
  }
  return out;
}

// ---------- 学习通页面解析 ----------

function parseDoc(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

function hiddenInputs(html) {
  const out = {};
  for (const el of parseDoc(html).querySelectorAll('input')) {
    const id = el.getAttribute('id');
    const value = el.getAttribute('value');
    if (id && value != null) out[id] = value;
  }
  return out;
}

function parseCourseList(text) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (_) {
    throw new Error('课程列表不是 JSON（可能 Cookie 失效）');
  }
  const body = root && root.channelList ? root : ((root && root.data) || {});
  const channels = Array.isArray(body.channelList) ? body.channelList : [];
  const out = [];
  const seen = new Set();
  for (const channel of channels) {
    const content = channel && channel.content;
    if (!content || !content.course) continue;
    const data = content.course.data;
    if (!Array.isArray(data) || !data.length) continue;
    const first = data[0] || {};
    if (content.state !== undefined && content.state !== 0) continue;
    const id = String(first.id || '');
    const classId = String(content.id || '');
    if (!id || !classId) continue;
    const key = id + ':' + classId + ':' + String(content.cpi || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      classId,
      cpi: String(content.cpi || ''),
      name: String(first.name || content.name || '未知课程'),
    });
  }
  return out;
}

function parseWorkList(html) {
  const doc = parseDoc(html);
  const out = [];
  for (const li of doc.querySelectorAll('li')) {
    const onclick = li.getAttribute('onclick') || '';
    if (!onclick.includes('goTask') && !li.querySelector('[onclick*="goTask"]')) continue;
    const data = li.getAttribute('data');
    if (!data) continue;
    let url = data.trim();
    if (url.startsWith('/')) url = CX_HOST + url;
    if (!url.includes('work/task')) continue;
    out.push({
      url,
      title: (li.querySelector('.overHidden2')?.textContent || '').trim(),
      status: (li.querySelector('.status')?.textContent || '').trim(),
    });
  }
  return out;
}

const WORK_DONE = ['已完成', '已提交', '待批阅', '已批阅', '已批改'];
const EXAM_DONE = /已完成|已提交|待批阅|已批阅|已批改|已交卷/;

function isWorkPending(status) {
  return !WORK_DONE.some((mark) => String(status || '').includes(mark));
}

function htmlText(html) {
  const doc = parseDoc(html);
  doc.querySelectorAll('script,style').forEach((el) => el.remove());
  return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
}

function parseWorkDeadline(html) {
  const text = htmlText(html);
  let match = text.match(
    /作答时间\s*[:：]\s*(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})\s*至\s*(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/);
  if (match) return nearestYear(match[2]);
  match = text.match(
    /(?:截止时间|作业截止|截止日期)\s*[:：]?\s*(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/);
  if (match) return fullDate(match[1]);
  match = text.match(
    /(?:截止时间|作业截止|截止日期)\s*[:：]?\s*(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/);
  if (match) return nearestYear(match[1]);
  return 0;
}

function parseExamRows(html) {
  const doc = parseDoc(html);
  const out = [];
  for (const tr of doc.querySelectorAll('tr.dataTr')) {
    const cells = [...tr.querySelectorAll('td')]
      .map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim());
    if (cells.length < 8) continue;
    const times = examTime(cells[2], cells[3]);
    if (!times) continue;
    out.push({
      name: cells[1],
      start: times[0],
      end: times[1],
      done: EXAM_DONE.test(cells[5]),
    });
  }
  return out;
}

function examTime(timeCell, durationCell) {
  const startMatch = String(timeCell || '')
    .match(/(\d{4}-\d{1,2}-\d{1,2})\s+(\d{1,2}:\d{2})/);
  if (!startMatch) return null;
  const start = fullDate(startMatch[1] + ' ' + startMatch[2]);
  if (!start) return null;
  const endMatch = String(timeCell || '')
    .match(/至\s*(\d{4}-\d{1,2}-\d{1,2})\s+(\d{1,2}:\d{2})/);
  let end = endMatch ? fullDate(endMatch[1] + ' ' + endMatch[2]) : 0;
  if (!end) end = start + (durationMinutes(durationCell) || 0) * 60000;
  return [start, end];
}

function durationMinutes(value) {
  const text = String(value || '');
  const hours = text.match(/(\d+)\s*小时/);
  const minutes = text.match(/(\d+)\s*分钟/);
  if (hours || minutes) {
    return (parseInt(hours ? hours[1] : '0', 10) || 0) * 60
      + (parseInt(minutes ? minutes[1] : '0', 10) || 0);
  }
  const n = parseInt(text.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function fullDate(raw) {
  const match = String(raw || '')
    .match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  const year = +match[1];
  const month = +match[2];
  const day = +match[3];
  const hour = +match[4];
  const minute = +match[5];
  const value = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1
      || value.getDate() !== day || value.getHours() !== hour
      || value.getMinutes() !== minute) return 0;
  return value.getTime();
}

function nearestYear(raw) {
  const match = String(raw || '')
    .match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  const now = Date.now();
  const current = new Date().getFullYear();
  let best = 0;
  let bestDiff = Infinity;
  for (const year of [current - 1, current, current + 1]) {
    const value = new Date(year, +match[1] - 1, +match[2], +match[3], +match[4], 0, 0);
    if (value.getMonth() !== +match[1] - 1 || value.getDate() !== +match[2]) continue;
    const diff = Math.abs(value.getTime() - now);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = value.getTime();
    }
  }
  return best;
}

function paramOf(url, key) {
  try {
    return new URL(url, CX_HOST).searchParams.get(key) || '';
  } catch (_) {
    return '';
  }
}

function hash(value) {
  let out = 0x811c9dc5;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    out ^= text.charCodeAt(i);
    out = Math.imul(out, 0x01000193) >>> 0;
  }
  return out.toString(16).padStart(8, '0');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeSynced(list) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const seen = new Set();
  for (const raw of list) {
    const id = String((raw && raw.id) || '');
    const due = Number(raw && raw.due);
    if (!id || !Number.isFinite(due) || due <= 0) continue;
    seen.add(id);
    const old = byId.get(id);
    if (old) {
      old.title = String(raw.title || old.title);
      old.course = String(raw.course || '');
      old.kind = raw.kind === 'exam' ? 'exam' : 'homework';
      old.due = due;
      old.source = 'chaoxing';
      old.readonly = true;
      old.url = String(raw.url || '');
      continue;
    }
    const item = {
      id,
      title: String(raw.title || '未命名'),
      course: String(raw.course || ''),
      kind: raw.kind === 'exam' ? 'exam' : 'homework',
      due,
      done: false,
      offsets: [...DEFAULT_OFFSETS],
      source: 'chaoxing',
      readonly: true,
      url: String(raw.url || ''),
    };
    items.push(item);
    byId.set(id, item);
  }
  items = items.filter((it) => it.source !== 'chaoxing' || seen.has(it.id) || it.done);
}

function errText(error) {
  if (!error) return '';
  return String(error.message || error)
    .replace(/^Error:\s*/, '')
    .replace(/^Invalid argument\(s\):\s*/, '')
    .replace(/^Bad state:\s*/, '');
}

async function toggleDone(id) {
  const item = items.find((it) => it.id === id);
  if (!item) return;
  item.done = !item.done;
  await persist();
  renderList();
  await syncNotifications();
  ctx.ui.toast(item.done ? '已完成：' + clip(item.title, 24) : '已恢复：' + clip(item.title, 24));
}

function renderList() {
  if (!listEl) return;
  const now = Date.now();
  const open = items.filter((it) => !it.done).sort((a, b) => a.due - b.due);
  const overdue = open.filter((it) => it.due < now);
  const upcoming = open.filter((it) => it.due >= now);

  listEl.innerHTML = '';
  if (!open.length) {
    listEl.appendChild(emptyEl());
  } else {
    if (overdue.length) listEl.appendChild(sectionEl('已逾期', overdue, now));
    if (upcoming.length) listEl.appendChild(sectionEl('待完成', upcoming, now));
  }
  summaryEl.textContent = summaryText(open, overdue);
  lastOverdue = open.map((it) => (it.due < now ? '1' : '0')).join('');
}

function sectionEl(title, list, now) {
  const box = document.createElement('section');
  box.className = 'dl-section';
  const head = document.createElement('h2');
  head.textContent = title + ' · ' + list.length;
  box.appendChild(head);
  for (const item of list) box.appendChild(rowEl(item, now));
  return box;
}

function rowEl(item, now) {
  const el = document.createElement('div');
  el.className = 'dl-item'
    + (item.due < now ? ' is-overdue' : '')
    + (item.kind === 'exam' ? ' is-exam' : '');
  el.setAttribute('data-id', item.id);
  el.innerHTML = `
    <button class="dl-check" type="button" data-act="toggle" aria-label="标记完成"></button>
    <div class="dl-body">
      <div class="dl-line">
        <span class="dl-badge ${esc(item.kind)}">${esc(KIND_LABEL[item.kind] || '其他')}</span>
        <span class="dl-title">${esc(item.title)}</span>
        ${item.source === 'chaoxing' ? '<span class="dl-sync-tag">学习通</span>' : ''}
      </div>
      <div class="dl-meta">${item.course ? esc(item.course) + ' · ' : ''}截止 ${fmtDue(item.due)}</div>
    </div>
    <div class="dl-remain" data-remain="${esc(item.id)}">${remainText(item.due, now)}</div>`;
  return el;
}

function emptyEl() {
  const el = document.createElement('div');
  el.className = 'dl-empty';
  el.innerHTML = '<div class="dl-empty-mark">✓</div>'
    + '<p>没有未完成的作业或考试</p>'
    + '<p class="dl-hint">点右上角「添加」，或从学习通 / 雨课堂复制一段带截止时间的文字来「粘贴导入」。</p>';
  return el;
}

function summaryText(open, overdue) {
  if (!open.length) return '全部完成';
  const parts = [open.length + ' 项未完成'];
  if (overdue.length) parts.push(overdue.length + ' 项已逾期');
  const next = open.find((it) => it.due >= Date.now());
  if (next) parts.push('最近 ' + fmtDue(next.due));
  return parts.join(' · ');
}

/** 每 30 秒只改剩余时间文本；逾期状态变了才重画列表，避免打断滚动。 */
function tick() {
  if (!ctx || ctx.ui.depth > 0 || !listEl) return;
  const now = Date.now();
  const open = items.filter((it) => !it.done).sort((a, b) => a.due - b.due);
  const sig = open.map((it) => (it.due < now ? '1' : '0')).join('');
  if (sig !== lastOverdue) {
    renderList();
    return;
  }
  for (const el of listEl.querySelectorAll('[data-remain]')) {
    const item = items.find((it) => it.id === el.getAttribute('data-remain'));
    if (item) el.textContent = remainText(item.due, now);
  }
  summaryEl.textContent = summaryText(open, open.filter((it) => it.due < now));
}

// ==================== 添加 / 编辑 ====================

function openSyncedDetail(item) {
  const page = ctx.ui.push({ onPop: () => renderList() });
  page.root.innerHTML = `
    <div class="dl-page">
      <header class="dl-page-head">
        <button class="dl-back" type="button" data-close aria-label="返回">‹</button>
        <h1>${esc(item.title)}</h1>
      </header>
      <div class="dl-form">
        <p class="dl-meta">${item.course ? esc(item.course) + ' · ' : ''}截止 ${fmtDue(item.due)}</p>
        <p class="dl-hint">这条来自学习通同步，内容不能在这里修改；标记完成后下次同步会保留。</p>
        <div class="dl-actions">
          <button id="f-toggle" class="dl-primary" type="button">${item.done ? '恢复为未完成' : '标记完成'}</button>
        </div>
      </div>
    </div>`;
  page.root.querySelector('[data-close]').addEventListener('click', () => page.close());
  page.root.querySelector('#f-toggle').addEventListener('click', async () => {
    item.done = !item.done;
    await persist();
    renderList();
    await syncNotifications();
    page.close();
  });
}

function openEditor(item) {
  const editing = !!item;
  const due = item ? item.due : defaultDue();
  const offsets = item ? [...(item.offsets || [])] : [...DEFAULT_OFFSETS];
  const page = ctx.ui.push({ onPop: () => renderList() });
  page.root.innerHTML = `
    <div class="dl-page">
      <header class="dl-page-head">
        <button class="dl-back" type="button" data-close aria-label="返回">‹</button>
        <h1>${editing ? '编辑' : '添加'}截止</h1>
      </header>
      <div class="dl-form">
        <label class="dl-field">标题
          <input id="f-title" maxlength="80" autocomplete="off" placeholder="例：第三章作业">
        </label>
        <label class="dl-field">课程（可选）
          <input id="f-course" maxlength="40" autocomplete="off" placeholder="例：高等数学">
        </label>
        <label class="dl-field">类型
          <select id="f-kind">
            <option value="homework">作业</option>
            <option value="exam">考试</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label class="dl-field">截止时间
          <input id="f-due" type="datetime-local">
        </label>
        <div class="dl-field">
          <span>提醒</span>
          <div class="dl-offsets">
            ${OFFSET_CHOICES.map((o) => `
              <label class="dl-chip">
                <input type="checkbox" data-offset="${o.m}"${offsets.includes(o.m) ? ' checked' : ''}>
                <span>${o.label}</span>
              </label>`).join('')}
          </div>
          <p class="dl-hint">不勾就不提醒；提醒走系统通知，App 没开也会弹。</p>
        </div>
        <div class="dl-actions">
          <button id="f-save" class="dl-primary" type="button">保存</button>
        </div>
        ${editing ? '<button id="f-delete" class="dl-delete" type="button">删除这条</button>' : ''}
      </div>
    </div>`;

  const $ = (sel) => page.root.querySelector(sel);
  $('#f-title').value = item ? item.title : '';
  $('#f-course').value = item ? item.course : '';
  $('#f-kind').value = item ? item.kind : 'homework';
  $('#f-due').value = toLocalInput(due);

  page.root.querySelector('[data-close]').addEventListener('click', () => page.close());
  $('#f-save').addEventListener('click', async () => {
    const title = $('#f-title').value.trim();
    const course = $('#f-course').value.trim();
    const kind = $('#f-kind').value;
    const dueRaw = $('#f-due').value;
    const nextDue = dueRaw ? new Date(dueRaw).getTime() : NaN;
    const nextOffsets = Array.from(page.root.querySelectorAll('input[data-offset]:checked'))
      .map((el) => Number(el.getAttribute('data-offset')));

    if (!title) {
      ctx.ui.toast('先写个标题');
      $('#f-title').focus();
      return;
    }
    if (!Number.isFinite(nextDue)) {
      ctx.ui.toast('截止时间没填对');
      return;
    }

    const next = {
      id: item ? item.id : genId(),
      title: title.slice(0, 80),
      course: course.slice(0, 40),
      kind: KIND_LABEL[kind] ? kind : 'other',
      due: nextDue,
      done: item ? item.done : false,
      offsets: nextOffsets,
      source: 'manual',
      readonly: false,
      url: '',
    };
    const index = items.findIndex((it) => it.id === next.id);
    if (index >= 0) items[index] = next;
    else items.push(next);

    await persist();
    renderList();
    await syncNotifications();
    page.close();
  });

  const del = $('#f-delete');
  if (del) {
    let armed = false;
    let timer = null;
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        del.textContent = '再点一次确认删除';
        del.classList.add('is-armed');
        timer = setTimeout(() => {
          armed = false;
          del.textContent = '删除这条';
          del.classList.remove('is-armed');
        }, 3000);
        return;
      }
      clearTimeout(timer);
      items = items.filter((it) => it.id !== item.id);
      await persist();
      renderList();
      await syncNotifications();
      page.close();
    });
  }
}

// ==================== 粘贴导入 ====================

function openImport() {
  const page = ctx.ui.push({ onPop: () => renderList() });
  page.root.innerHTML = `
    <div class="dl-page">
      <header class="dl-page-head">
        <button class="dl-back" type="button" data-close aria-label="返回">‹</button>
        <h1>粘贴导入</h1>
      </header>
      <div class="dl-form">
        <p class="dl-hint">每行一条，例如：<br>
          <code>高等数学 第三章作业 2026-11-20 23:59</code><br>
          <code>线性代数｜期末考试｜12月1日 09:00</code><br>
          没写时间按 23:59 算；没写年份按最近的日期推断。</p>
        <textarea id="f-paste" rows="8" placeholder="把学习通 / 雨课堂里的作业、考试列表复制到这里"></textarea>
        <div class="dl-actions">
          <button id="f-parse" type="button">解析</button>
          <button id="f-import" class="dl-primary" type="button" disabled>导入</button>
        </div>
        <div id="f-preview" class="dl-preview"></div>
      </div>
    </div>`;

  const $ = (sel) => page.root.querySelector(sel);
  const preview = $('#f-preview');
  const importBtn = $('#f-import');
  let parsed = [];

  page.root.querySelector('[data-close]').addEventListener('click', () => page.close());

  $('#f-parse').addEventListener('click', () => {
    const result = parsePaste($('#f-paste').value);
    parsed = result.items;
    importBtn.disabled = parsed.length === 0;
    importBtn.textContent = parsed.length ? '导入 ' + parsed.length + ' 条' : '导入';
    if (!parsed.length) {
      preview.innerHTML = '<p class="dl-warn-text">没识别到截止时间。每行一条，日期写成 '
        + '2026-11-20 23:59 或 11月20日 23:59。</p>'
        + (result.skipped.length
          ? '<p class="dl-hint">跳过的行：' + result.skipped.slice(0, 4).map(esc).join('；') + '</p>'
          : '');
      return;
    }
    preview.innerHTML = '<p class="dl-ok">识别到 ' + parsed.length + ' 条：</p>'
      + parsed.slice(0, 8).map((it) =>
        '<p class="dl-preview-line">'
        + '<span class="dl-badge ' + esc(it.kind) + '">' + esc(KIND_LABEL[it.kind]) + '</span> '
        + esc(it.course ? it.course + ' · ' : '') + esc(it.title)
        + ' <span class="dl-quiet">' + fmtDue(it.due) + '</span></p>').join('')
      + (parsed.length > 8 ? '<p class="dl-hint">还有 ' + (parsed.length - 8) + ' 条…</p>' : '')
      + (result.skipped.length
        ? '<p class="dl-hint">另跳过 ' + result.skipped.length + ' 行（没找到日期）</p>'
        : '');
  });

  importBtn.addEventListener('click', async () => {
    const known = new Set(items.map(keyOf));
    let added = 0;
    for (const item of parsed) {
      const key = keyOf(item);
      if (known.has(key)) continue;
      known.add(key);
      items.push(item);
      added += 1;
    }
    if (!added) {
      ctx.ui.toast('这些条目已经在列表里了');
      return;
    }
    await persist();
    renderList();
    await syncNotifications();
    ctx.ui.toast('已导入 ' + added + ' 条');
    page.close();
  });
}

// ==================== 已完成 ====================

function openCompleted() {
  const done = items.filter((it) => it.done).sort((a, b) => b.due - a.due);
  const page = ctx.ui.push({ onPop: () => renderList() });
  page.root.innerHTML = `
    <div class="dl-page">
      <header class="dl-page-head">
        <button class="dl-back" type="button" data-close aria-label="返回">‹</button>
        <h1>已完成 · ${done.length}</h1>
      </header>
      <div class="dl-form">
        <div id="f-done" class="dl-list"></div>
      </div>
    </div>`;

  const $ = (sel) => page.root.querySelector(sel);
  page.root.querySelector('[data-close]').addEventListener('click', () => page.close());
  const box = $('#f-done');

  if (!done.length) {
    box.innerHTML = '<p class="dl-hint">还没有标记完成的条目。在主列表点左边的圆圈就能完成一条。</p>';
    return;
  }

  for (const item of done) {
    const row = document.createElement('div');
    row.className = 'dl-item is-done';
    row.innerHTML = `
      <button class="dl-check is-on" type="button" data-act="restore" aria-label="恢复">✓</button>
      <div class="dl-body">
        <div class="dl-line">
          <span class="dl-badge ${esc(item.kind)}">${esc(KIND_LABEL[item.kind] || '其他')}</span>
          <span class="dl-title">${esc(item.title)}</span>
        </div>
        <div class="dl-meta">${item.course ? esc(item.course) + ' · ' : ''}截止 ${fmtDue(item.due)}</div>
      </div>
      <button class="dl-link" type="button" data-act="remove"${item.source === 'chaoxing' ? ' hidden' : ''}>删除</button>`;
    row.addEventListener('click', async (event) => {
      const act = event.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'restore') {
        item.done = false;
      } else {
        items = items.filter((it) => it.id !== item.id);
      }
      await persist();
      renderList();
      await syncNotifications();
      page.close();
    });
    box.appendChild(row);
  }
}

// ==================== 提醒 ====================

async function syncNotifications() {
  let failed = false;
  // 只撤自己排过的键，避免误伤同一条拓展下别处排的通知。
  for (const key of scheduledKeys) {
    try {
      await ctx.notify.cancel(key);
    } catch (_) {}
  }
  scheduledKeys = [];
  const now = Date.now();
  for (const item of items) {
    if (item.done || item.due <= now) continue;
    for (const offset of item.offsets || []) {
      const at = item.due - offset * 60000;
      if (at <= now + 30000) continue;
      const key = 'dl:' + item.id + ':' + offset;
      try {
        await ctx.notify.schedule({
          key,
          title: '还有 ' + offsetLabel(offset) + '：' + clip(item.title, 60),
          body: (item.course ? item.course + ' · ' : '') + '截止 ' + fmtDue(item.due),
          at,
        });
        scheduledKeys.push(key);
      } catch (e) {
        failed = true;
      }
    }
  }
  try {
    await ctx.storage.set('notifiedKeys', scheduledKeys);
  } catch (_) {}
  setWarn(failed ? '提醒没能排上：请确认 App 已允许通知，再到系统设置里打开后重新进入本页。' : '');
}

function setWarn(text) {
  if (!warnEl) return;
  warnEl.textContent = text || '';
  warnEl.classList.toggle('hidden', !text);
}

function offsetLabel(minutes) {
  const choice = OFFSET_CHOICES.find((o) => o.m === minutes);
  if (choice) return choice.label.replace('提前 ', '');
  if (minutes % 10080 === 0) return (minutes / 10080) + ' 周';
  if (minutes % 1440 === 0) return (minutes / 1440) + ' 天';
  if (minutes % 60 === 0) return (minutes / 60) + ' 小时';
  return minutes + ' 分钟';
}

/** 打开页面时弹一次：逾期和 24 小时内到期的先提醒，不打扰时就点「知道了」。 */
function maybePopup() {
  if (popupShown || !rootEl || !rootEl.isConnected || ctx.ui.depth > 0) return;
  const now = Date.now();
  const overdue = items.filter((it) => !it.done && it.due < now).sort((a, b) => a.due - b.due);
  const soon = items.filter((it) => !it.done && it.due >= now && it.due - now <= 86400000)
    .sort((a, b) => a.due - b.due);
  if (!overdue.length && !soon.length) return;
  popupShown = true;

  const rows = [...overdue.slice(0, 3), ...soon.slice(0, 4)].slice(0, 5);
  const title = overdue.length && soon.length
    ? overdue.length + ' 项已逾期，' + soon.length + ' 项 24 小时内截止'
    : overdue.length
      ? overdue.length + ' 项已逾期'
      : soon.length + ' 项 24 小时内截止';

  const box = document.createElement('div');
  box.className = 'dl-modal';
  box.innerHTML = `
    <div class="dl-modal-card">
      <h2>${esc(title)}</h2>
      <ul>${rows.map((it) => `
        <li>
          <span class="dl-badge ${esc(it.kind)}">${esc(KIND_LABEL[it.kind] || '其他')}</span>
          <span class="dl-modal-name">${esc(it.title)}</span>
          <span class="dl-quiet">${remainText(it.due, now)}</span>
        </li>`).join('')}</ul>
      <button class="dl-primary" type="button">知道了</button>
    </div>`;
  rootEl.appendChild(box);
  const close = () => box.remove();
  box.querySelector('button').addEventListener('click', close);
  box.addEventListener('click', (event) => {
    if (event.target === box) close();
  });
}

// ==================== 解析 ====================

const RE_FULL_DATE = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/;
const RE_MONTH_DAY = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
const RE_TIME = /(\d{1,2})\s*[:时点]\s*(\d{1,2})?/;
const RE_LEADING = /^(?:作业|考试|测验|截止时间|截止日期|截止|ddl|due)\s*[:：\-]?\s*/i;
const RE_TRAILING = /\s*(?:截止时间|截止日期|截止|ddl)\s*[:：]?\s*$/i;
const RE_DATE_CELL = new RegExp(
  '^\\s*(?:' + RE_FULL_DATE.source + '|' + RE_MONTH_DAY.source + ')'
  + '(?:\\s+\\d{1,2}\\s*[:时点]\\s*\\d{1,2}?)?\\s*$');

function parsePaste(text) {
  const now = new Date();
  const out = [];
  const skipped = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const item = parseLine(line, now);
    if (!item) {
      skipped.push(line.trim());
      continue;
    }
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return { items: out, skipped };
}

function parseLine(rawLine, now) {
  const raw = normalize(rawLine).trim();
  if (!raw) return null;

  const full = RE_FULL_DATE.exec(raw);
  const monthDay = full ? null : RE_MONTH_DAY.exec(raw);
  if (!full && !monthDay) return null;

  const matched = full || monthDay;
  const year = full ? Number(full[1]) : 0;
  const month = Number(full ? full[2] : monthDay[1]);
  const day = Number(full ? full[3] : monthDay[2]);
  const dateText = matched[0];

  const after = raw.slice(matched.index + dateText.length);
  let hour = 23;
  let minute = 59;
  let timeText = '';
  const time = RE_TIME.exec(after);
  if (time && time.index <= 12) {
    hour = Number(time[1]);
    minute = time[2] ? Number(time[2]) : 0;
    if (hour > 23 || minute > 59) return null;
    timeText = time[0];
  }

  let due;
  if (year) {
    due = new Date(year, month - 1, day, hour, minute, 0, 0);
  } else {
    due = new Date(now.getFullYear(), month - 1, day, hour, minute, 0, 0);
    // 没写年份：过去超过 45 天的按明年算
    if (due.getTime() < now.getTime() - 45 * 86400000) {
      due = new Date(now.getFullYear() + 1, month - 1, day, hour, minute, 0, 0);
    }
  }
  if (!Number.isFinite(due.getTime()) || due.getMonth() !== month - 1 || due.getDate() !== day) {
    return null;
  }

  const kind = detectKind(raw);
  const cells = raw.split('\t').map((cell) => cell.trim()).filter(Boolean);
  let course = '';
  let title = '';

  // 表格粘贴：单独的日期列 ⇒ 左边是课程、右边是标题
  const dateCell = cells.findIndex((cell) => RE_DATE_CELL.test(cell));
  if (dateCell >= 0 && cells.length >= 2) {
    const rest = cells.filter((_, index) => index !== dateCell);
    if (rest.length >= 2) {
      course = rest[0];
      title = rest.slice(1).join(' ');
    } else {
      title = rest[0] || '';
    }
  }

  if (!title) {
    let label = raw.replace(dateText, ' ');
    if (timeText) label = label.replace(timeText, ' ');
    // ISO 写法里日期和时间之间那个 T 也去掉
    label = label.replace(/(^|\s)[Tt](?=\s|$)/g, ' ');
    label = label.replace(/\s+/g, ' ').trim();

    // 只有剥掉标签后还剩内容才剥，别把「考试」这种整行就一个词剥成空
    const withoutLeading = label.replace(RE_LEADING, '').trim();
    if (withoutLeading) label = withoutLeading;
    const withoutTrailing = label.replace(RE_TRAILING, '').trim();
    if (withoutTrailing) label = withoutTrailing;

    const parts = label.split(/\s*(?:[|｜·•]|\s-\s)\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      course = parts[0];
      title = parts.slice(1).join(' ');
    } else {
      title = parts[0] || label;
    }
  }

  title = title.replace(/^[\s:：,，、.。;\-|｜]+|[\s:：,，、.。;\-|｜]+$/g, '');
  course = course.replace(/^[\s:：,，、.。;\-|｜]+|[\s:：,，、.。;\-|｜]+$/g, '');
  if (!title) title = course || '未命名';

  return {
    id: genId(),
    title: title.slice(0, 80),
    course: course.slice(0, 40),
    kind,
    due: due.getTime(),
    done: false,
    offsets: [...DEFAULT_OFFSETS],
  };
}

function detectKind(line) {
  if (/(考试|期末|期中|补考|机考|考核|测评)/.test(line)) return 'exam';
  if (/(作业|实验|报告|论文|作文|写作|测验|习题)/.test(line)) return 'homework';
  return 'other';
}

function normalize(text) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/[／]/g, '/')
    .replace(/[．]/g, '.')
    .replace(/[－—–]/g, '-')
    .replace(/\u3000/g, ' ');
}

// ==================== 存储 / 杂项 ====================

async function loadInventory() {
  try {
    const raw = await ctx.storage.get(STORE_KEY);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((it) => it && Number(it.due) > 0)
      .map((it) => ({
        id: typeof it.id === 'string' && it.id ? it.id : genId(),
        title: String(it.title || '未命名').slice(0, 80),
        course: String(it.course || '').slice(0, 40),
        kind: KIND_LABEL[it.kind] ? it.kind : 'other',
        due: Number(it.due),
        done: !!it.done,
        offsets: Array.isArray(it.offsets)
          ? it.offsets.map(Number).filter((n) => n > 0)
          : [...DEFAULT_OFFSETS],
        source: it.source === 'chaoxing' ? 'chaoxing' : 'manual',
        readonly: it.source === 'chaoxing',
        url: String(it.url || ''),
      }));
  } catch (e) {
    return [];
  }
}

function persist() {
  return ctx.storage.set(STORE_KEY, items);
}

function keyOf(item) {
  return item.title + '|' + item.due + '|' + item.course;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtDue(ms) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = (sameYear ? '' : d.getFullYear() + '-') + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  return date + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function toLocalInput(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function defaultDue() {
  const d = new Date(Date.now() + 2 * 3600000);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function remainText(due, now) {
  const diff = due - (now || Date.now());
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  let span;
  if (days > 0) span = hours > 0 ? days + ' 天 ' + hours + ' 小时' : days + ' 天';
  else if (hours > 0) span = minutes > 0 ? hours + ' 小时 ' + minutes + ' 分' : hours + ' 小时';
  else span = Math.max(1, minutes) + ' 分钟';
  return diff >= 0 ? '剩 ' + span : '已逾期 ' + span;
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
