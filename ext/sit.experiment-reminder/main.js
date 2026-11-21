/*! SIT大物实验提醒 for AntiSIT — Cordis extension.
 *  Copyright (C) 2026 AntiSIT contributors
 *  SPDX-License-Identifier: GPL-3.0-only
 *
 *  只读：登录学校「基础信息平台」→ 进「报告系统」→ 拉大学物理实验的报告列表，
 *  把**未提交**的报告按截止时间排出来（开始时间、截止时间、倒计时），到点前推通知。
 *
 *  隐私：账号与密码只落在本机加密凭据（ctx.secrets），不打印、不上传、不写进任何
 *  日志；界面上密码永远是掩码。实验系统只有校内明文 http，所以走 App 的
 *  ctx.net.campus（服务器模式下会自动经校园隧道代理出去）。
 */

const PORTAL_DEFAULT = 'http://210.35.98.35:8000';
const REPORT_DEFAULT = 'http://210.35.98.35:8003';

// 学校登录页里写死的 AES 口令（BaseInfo/Login.js 的 Encrypt3），不是用户凭据。
const PLATFORM_AES_KEY = '1234567891234567';

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const KEY_PASS = 'xr.password';
const KEY_COOKIES = 'xr.cookies';
const OFFSETS_KEY = 'xr.offsets';
const DEFAULT_OFFSETS = [1440, 180, 30];
const OFFSET_CHOICES = [
  { m: 10080, label: '提前 1 周' },
  { m: 1440, label: '提前 1 天' },
  { m: 180, label: '提前 3 小时' },
  { m: 30, label: '提前 30 分钟' },
];

// 报告系统里 SubResult 的语义：0 = 未提交，3 = 超时提交（交过但晚了）。
const SUBMITTED_LATE = 3;

let ctx = null;
let rootEl = null;
let listEl = null;
let summaryEl = null;
let warnEl = null;
let accountEl = null;
let ticker = null;
let items = [];
let lastOverdue = '';
let scheduledKeys = [];

const state = {
  account: '',
  hasPassword: false,
  syncing: false,
  error: '',
  stage: '',
  lastSync: 0,
  background: false,
  timer: null,
  offsets: [...DEFAULT_OFFSETS],
  armedClear: false,
  server: { portal: PORTAL_DEFAULT, report: REPORT_DEFAULT },
  semester: '',
};

const jars = new Map();

export default {
  name: 'sit-experiment-reminder',
  inject: ['ui', 'storage', 'notify', 'secrets', 'net', 'permissions', 'background'],
  async apply(host) {
    ctx = host;
    rootEl = ctx.ui.root;
    rootEl.innerHTML = `
      <div class="xr">
        <header class="xr-head">
          <div class="xr-heading">
            <h1>SIT大物实验提醒</h1>
            <p id="xr-summary">正在读取…</p>
          </div>
          <button id="xr-refresh" class="xr-primary" type="button">刷新</button>
        </header>
        <p id="xr-warn" class="xr-warn hidden"></p>
        <div class="xr-tools">
          <button id="xr-late" type="button">超时提交</button>
          <button id="xr-about" type="button">说明</button>
        </div>
        <div id="xr-account" class="xr-account"></div>
        <div id="xr-list" class="xr-list"></div>
      </div>`;

    summaryEl = rootEl.querySelector('#xr-summary');
    warnEl = rootEl.querySelector('#xr-warn');
    listEl = rootEl.querySelector('#xr-list');
    accountEl = rootEl.querySelector('#xr-account');

    ctx.effect(() => {
      const onRefresh = () => syncNow();
      const onLate = () => openLate();
      const onAbout = () => openAbout();
      rootEl.querySelector('#xr-refresh').addEventListener('click', onRefresh);
      rootEl.querySelector('#xr-late').addEventListener('click', onLate);
      rootEl.querySelector('#xr-about').addEventListener('click', onAbout);
      accountEl.addEventListener('click', onAccountClick);
      accountEl.addEventListener('change', onAccountChange);
      listEl.addEventListener('click', onListClick);
      return () => {
        rootEl.querySelector('#xr-refresh').removeEventListener('click', onRefresh);
        rootEl.querySelector('#xr-late').removeEventListener('click', onLate);
        rootEl.querySelector('#xr-about').removeEventListener('click', onAbout);
        accountEl.removeEventListener('click', onAccountClick);
        accountEl.removeEventListener('change', onAccountChange);
        listEl.removeEventListener('click', onListClick);
      };
    });

    ctx.effect(() => {
      ticker = setInterval(tick, 30000);
      return () => {
        clearInterval(ticker);
        ticker = null;
      };
    });

    ctx.effect(() => () => {
      stopBackgroundTimer();
      if (state.background) ctx.background.keepAlive({ enabled: false }).catch(() => {});
    });

    await loadState();
    renderAccount();
    renderList();
    await syncNow();
    if (state.background) startBackgroundTimer();
  },
};

// ==================== 状态 ====================

async function loadState() {
  state.account = (await ctx.storage.get('xr.account')) || '';
  state.lastSync = Number(await ctx.storage.get('xr.lastSync')) || 0;
  state.background = !!(await ctx.storage.get('xr.background'));
  state.semester = (await ctx.storage.get('xr.semester')) || '';
  const stored = await ctx.storage.get(OFFSETS_KEY);
  if (Array.isArray(stored)) {
    const list = stored.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (list.length) state.offsets = list;
  }
  const server = await ctx.storage.get('xr.server');
  if (server && server.portal && server.report) {
    state.server.portal = server.portal;
    state.server.report = server.report;
  }
  const cached = await ctx.storage.get('xr.items');
  if (Array.isArray(cached)) items = cached.filter((it) => it && it.id);
  try {
    const pass = await ctx.secrets.get(KEY_PASS);
    state.hasPassword = !!(pass && pass.length);
  } catch (_) {
    state.hasPassword = false;
  }
  await loadCookies();
}

async function loadCookies() {
  jars.clear();
  try {
    const raw = await ctx.secrets.get(KEY_COOKIES);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    Object.keys(parsed || {}).forEach((key) => {
      const jar = parsed[key];
      if (jar && typeof jar === 'object') jars.set(key, Object.assign({}, jar));
    });
  } catch (_) {
    jars.clear();
  }
}

async function saveCookies() {
  try {
    const out = {};
    jars.forEach((jar, key) => { out[key] = jar; });
    await ctx.secrets.set(KEY_COOKIES, JSON.stringify(out));
  } catch (_) {}
}

function jarOf(url, create) {
  let host = '';
  try {
    host = new URL(url).host;
  } catch (_) {
    return null;
  }
  let jar = jars.get(host);
  if (!jar && create) {
    jar = {};
    jars.set(host, jar);
  }
  return jar || null;
}

function cookieHeaderFor(url) {
  const jar = jarOf(url, false);
  if (!jar) return '';
  return Object.keys(jar).map((name) => name + '=' + jar[name]).join('; ');
}

function absorbCookies(url, setCookies) {
  if (!Array.isArray(setCookies) || !setCookies.length) return false;
  const jar = jarOf(url, true);
  if (!jar) return false;
  let changed = false;
  for (const line of setCookies) {
    const pair = String(line || '').split(';')[0];
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!name) continue;
    if (jar[name] !== value) {
      jar[name] = value;
      changed = true;
    }
  }
  return changed;
}

async function resetSession() {
  jars.clear();
  try {
    await ctx.secrets.remove(KEY_COOKIES);
  } catch (_) {}
}

// ==================== 请求 ====================

function encodeForm(fields) {
  return Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(fields[k])))
    .join('&');
}

/**
 * 打一次校内接口。
 *
 * 两点实测踩出来的注意：
 * 1. **不能带 X-Requested-With: XMLHttpRequest** —— 报告系统的会话判定会因此把
 *    后续请求当成未登录，直接回登录页 HTML；
 * 2. Cookie 按 host:port 分开存 —— 门户(:8000) 与报告系统(:8003) 在同一个 IP 上各有
 *    各的 ASP.NET 会话，混在一起会互相顶掉。
 */
async function request(base, path, options) {
  const opts = options || {};
  const method = opts.method || 'POST';
  const url = base.replace(/\/+$/, '') + path;
  const headers = Object.assign(
    {
      Accept: opts.accept || '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'User-Agent': UA,
    },
    opts.headers || {},
  );
  const cookie = cookieHeaderFor(url);
  if (cookie) headers.Cookie = cookie;
  let body;
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=utf-8';
    body = encodeForm(opts.form);
  }
  if (opts.referer) headers.Referer = opts.referer;

  const res = await ctx.net.campus({
    method,
    url,
    headers,
    body,
    responseEncoding: opts.binary ? 'base64' : undefined,
  });
  if (absorbCookies(url, res.setCookies)) saveCookies().catch(() => {});
  return {
    status: res.status,
    text: res.text || '',
    headers: res.headers || {},
  };
}

function isJson(res) {
  const type = String((res.headers || {})['Content-Type'] || '').toLowerCase();
  if (type.indexOf('json') >= 0) return true;
  const text = String(res.text || '').trim();
  return text.startsWith('{') || text.startsWith('[');
}

function parseJson(res, what) {
  if (!isJson(res)) {
    throw new Error(what + '返回的是登录页：会话可能已失效，点「重新登录」再试');
  }
  try {
    return JSON.parse(res.text);
  } catch (e) {
    throw new Error(what + '返回了看不懂的内容');
  }
}

// ==================== 登录 ====================

async function readCreds() {
  let password = '';
  try {
    password = (await ctx.secrets.get(KEY_PASS)) || '';
  } catch (_) {}
  return { account: state.account, password };
}

/** 完整登录：先直接进报告系统；不行再走「基础信息平台 → 角色菜单 → 报告系统」。 */
async function loginWith(account, password) {
  await resetSession();
  state.stage = '登录报告系统…';
  renderAccount();

  const direct = await tryReportLogin(account, password);
  if (direct.ok) return direct;

  state.stage = '登录基础信息平台…';
  renderAccount();
  const portal = await tryPortalLogin(account, password);
  if (!portal.ok) return { ok: false, error: portal.error || '登录失败' };

  if (portal.menu) state.server.report = portal.menu;
  state.stage = '进入报告系统…';
  renderAccount();
  const remote = await tryReportLogin(account, password);
  if (!remote.ok) return { ok: false, error: remote.error || '报告系统没进去' };
  return remote;
}

async function tryReportLogin(account, password) {
  try {
    const res = await request(state.server.report, '/Login/RemoteUserLogin', {
      form: { userId: account, userPass: password },
      accept: 'application/json, text/javascript, */*; q=0.01',
    });
    const json = parseJson(res, '报告系统登录');
    if (!json.IsSuccess) {
      return { ok: false, error: String(json.ErrorInfo || '登录失败，账号或密码不对') };
    }
    const data = json.Data || {};
    if (data.UserID) state.account = String(data.UserID);
    if (data.SemesterID) {
      state.semester = String(data.SemesterID);
      await ctx.storage.set('xr.semester', state.semester);
    }
    await saveCookies();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

async function tryPortalLogin(account, password) {
  const base = state.server.portal;
  try {
    await request(base, '/', { method: 'GET', accept: 'text/html' });
    const info = await request(base, '/BaseInfo/Login/getInfo', { form: {} });
    let needCode = false;
    try {
      needCode = !!(JSON.parse(info.text || '{}').v);
    } catch (_) {}
    if (!needCode) return await submitPortalLogin(base, account, password, '');
    const code = await askCaptcha(base);
    if (!code) return { ok: false, error: '需要验证码，已取消' };
    return await submitPortalLogin(base, account, password, code);
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

async function submitPortalLogin(base, account, password, code) {
  try {
    const res = await request(base, '/BaseInfo/Login/ValidateLogin', {
      form: {
        uname: account,
        // 页面里是 haha.he(Encrypt3(密码))：AES-128-ECB + 两次 base64
        pwd: platformPass(password, PLATFORM_AES_KEY),
        checkcode: code,
      },
      referer: base + '/',
    });
    const json = parseJson(res, '基础信息平台登录');
    if (!json.IsSuccess) {
      return { ok: false, error: String(json.Data || json.ErrorInfo || '账号或密码不对') };
    }
    const data = json.Data || {};
    const jsid = data.JSID || data.JiaoSeID || '';
    await request(base, '/BaseInfo/Login/GetRoleUser', {
      form: { user: account, js: jsid },
      referer: base + '/',
    });
    await request(base, '/BaseInfo/Index/', { method: 'GET', accept: 'text/html' });
    const menuRes = await request(base, '/BaseInfo/Login/RoleMenu', { form: {} });
    return { ok: true, menu: pickReportUrl(menuRes.text) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** 从角色菜单里挑「报告系统」那台的地址。 */
function pickReportUrl(raw) {
  try {
    const outer = JSON.parse(String(raw || ''));
    const inner = JSON.parse(outer.Data || '{}');
    const menus = Array.isArray(inner.menus) ? inner.menus : [];
    for (const m of menus) {
      const name = String(m.menuname || '');
      const url = String(m.dizhi || '');
      if (!url) continue;
      if (/报告/.test(name) || url.indexOf(':8003') >= 0) {
        try {
          return new URL(url).origin;
        } catch (_) {
          return url.replace(/\/Login\/.*$/, '');
        }
      }
    }
  } catch (_) {}
  return '';
}

async function askCaptcha(base) {
  let image = '';
  try {
    const res = await request(base, '/Ashx/CheckCode.ashx?t=' + Date.now(), {
      method: 'GET',
      binary: true,
    });
    image = 'data:image/gif;base64,' + String(res.text || '').trim();
  } catch (_) {
    image = '';
  }
  return new Promise((resolve) => {
    const page = ctx.ui.push({ onPop: () => resolve('') });
    const imgTag = image
      ? '<img alt="验证码" src="' + image + '" style="width:100%;max-width:220px;'
        + 'border-radius:10px;border:1px solid var(--antisit-border,#e3e3e8)">'
      : '';
    page.root.innerHTML = `
      <div class="xr-page">
        <header class="xr-page-head">
          <button class="xr-back" type="button" data-close aria-label="返回">‹</button>
          <h1>输入验证码</h1>
        </header>
        <div class="xr-form">
          <p class="xr-hint">学校这次要求验证码。</p>${imgTag}
          <label class="xr-field">验证码
            <input id="code-input" maxlength="6" autocomplete="off" inputmode="numeric" placeholder="4 位数字">
          </label>
          <div class="xr-actions">
            <button id="code-ok" class="xr-primary" type="button">确定</button>
          </div>
        </div>
      </div>`;
    const input = page.root.querySelector('#code-input');
    page.root.querySelector('[data-close]').addEventListener('click', () => page.close());
    page.root.querySelector('#code-ok').addEventListener('click', () => {
      const value = input.value.trim();
      page.close();
      resolve(value);
    });
    setTimeout(() => input.focus(), 60);
  });
}

// ==================== 同步 ====================

async function syncNow() {
  if (state.syncing) return;
  const creds = await readCreds();
  if (!creds.account) {
    state.error = '还没有登录：点「登录」填学号与密码';
    renderAccount();
    renderList();
    return;
  }
  state.syncing = true;
  state.error = '';
  state.stage = '';
  renderAccount();
  renderList();
  try {
    let list = await fetchReports();
    if (!list) {
      if (!creds.password) throw new Error('登录已失效：点「重新登录」再输一次密码');
      state.stage = '登录已失效，正在重登…';
      renderAccount();
      const login = await loginWith(creds.account, creds.password);
      if (!login.ok) throw new Error(login.error || '重新登录失败');
      list = await fetchReports();
      if (!list) throw new Error('报告系统仍然要求登录，请点「重新登录」');
    }
    items = list;
    state.lastSync = Date.now();
    await ctx.storage.set('xr.lastSync', state.lastSync);
    await ctx.storage.set('xr.items', items);
    renderAccount();
    await syncNotifications();
    ctx.ui.toast(summaryText() || '已同步');
  } catch (e) {
    state.error = errText(e);
  } finally {
    state.syncing = false;
    state.stage = '';
    renderAccount();
    renderList();
  }
}

/** 取报告列表；返回 null 表示会话失效（需要重登）。 */
async function fetchReports() {
  state.stage = '读取报告列表…';
  renderAccount();
  const res = await request(
    state.server.report,
    '/ReportStudent/ResultInquiry/GetStudentReportScore',
    {
      form: {
        courseNo: '-999',
        labID: '',
        labType: '',
        reportName: '',
        startDate: '',
        endDate: '',
        pageIndex: 1,
        pageSize: 200,
      },
      accept: 'application/json, text/javascript, */*; q=0.01',
    },
  );
  if (!isJson(res)) return null;
  const json = JSON.parse(res.text);
  const rows = Array.isArray(json.DataList) ? json.DataList : [];
  return rows.map(toItem).filter(Boolean);
}

function toItem(row) {
  if (!row) return null;
  const title = String(row.PaperName || row.LabName || '').trim();
  if (!title) return null;
  return {
    id: 'r' + [row.CourseID, row.LabID, row.Weeks, row.WeekID].join('-'),
    title: title.slice(0, 80),
    course: String(row.CourseName || '').slice(0, 40),
    teacher: String(row.TeacherName || '').slice(0, 20),
    start: parseLabDate(row.LabStartDateTime, false),
    due: parseLabDate(row.LabLastDateTime, true),
    late: Number(row.SubResult) === SUBMITTED_LATE,
    submitted: Number(row.SubResult) !== 0,
    status: String(row.SubResult_String || ''),
    uploadedAt: String(row.ReportUpLoadTime || ''),
    score: String(row.TotalScore_String || ''),
  };
}

/** 「第7周-星期四2026/10/29」→ 时间戳；[endOfDay] 时补到当天 23:59:59。 */
function parseLabDate(raw, endOfDay) {
  const text = String(raw || '');
  const m = /(20\d{2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/.exec(text);
  if (!m) return 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return 0;
  return endOfDay ? ms + 24 * 3600 * 1000 - 1000 : ms;
}

// ==================== 渲染 ====================

function openReports() {
  return items
    .filter((it) => !it.submitted)
    .sort((a, b) => (a.due || 0) - (b.due || 0) || (a.start || 0) - (b.start || 0));
}

function lateReports() {
  return items.filter((it) => it.late).sort((a, b) => (b.due || 0) - (a.due || 0));
}

function summaryText() {
  const open = openReports();
  if (!open.length) return items.length ? '没有待提交的报告' : '';
  const now = Date.now();
  const overdue = open.filter((it) => it.due && it.due < now);
  const parts = [open.length + ' 份待提交'];
  if (overdue.length) parts.push(overdue.length + ' 份已逾期');
  const next = open.find((it) => !it.due || it.due >= now);
  if (next && next.due) parts.push('最近 ' + fmtFull(next.due) + ' 截止');
  if (state.semester) parts.push('学期 ' + state.semester);
  return parts.join(' · ');
}

function renderList() {
  if (!listEl) return;
  if (state.syncing && !items.length) {
    listEl.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'xr-empty';
    box.innerHTML = '<p>正在连接实验系统…</p>'
      + '<p class="xr-hint">' + esc(state.stage || '读取报告列表') + '</p>';
    listEl.appendChild(box);
    return;
  }
  const open = openReports();
  const now = Date.now();
  lastOverdue = open.map((it) => (it.due && it.due < now ? '1' : '0')).join('');
  listEl.innerHTML = '';

  if (!open.length) {
    listEl.appendChild(emptyEl());
  } else {
    const overdue = open.filter((it) => it.due && it.due < now);
    const pending = open.filter((it) => !it.due || it.due >= now);
    if (pending.length) listEl.appendChild(section('待提交', pending, now));
    if (overdue.length) listEl.appendChild(section('已逾期未交', overdue, now));
  }
  if (summaryEl) summaryEl.textContent = summaryText() || '还没有数据';
}

function section(title, list, now) {
  const wrap = document.createElement('section');
  wrap.className = 'xr-section';
  const head = document.createElement('h2');
  head.textContent = title + '（' + list.length + '）';
  wrap.appendChild(head);
  for (const item of list) wrap.appendChild(itemEl(item, now));
  return wrap;
}

function itemEl(item, now) {
  const row = document.createElement('div');
  const over = item.due && item.due < now;
  row.className = 'xr-item' + (over ? ' is-overdue' : '');
  row.setAttribute('data-id', item.id);
  const course = item.course ? '<span>' + esc(item.course) + '</span>' : '';
  const startText = item.start ? fmtFull(item.start) : '未排';
  const dueText = item.due ? fmtFull(item.due) : '未排';
  row.innerHTML = `
    <div class="xr-body">
      <div class="xr-line">
        <span class="xr-title">${esc(item.title)}</span>
        ${over ? '<span class="xr-badge is-overdue">已逾期</span>' : ''}
      </div>
      <div class="xr-meta">
        ${course}
        <span>开始 ${esc(startText)}</span>
        <span>截止 ${esc(dueText)}</span>
      </div>
    </div>
    <span class="xr-remain${over ? ' is-overdue' : ''}" data-remain="${esc(item.id)}">${item.due ? remainText(item.due, now) : '—'}</span>`;
  return row;
}

function emptyEl() {
  const el = document.createElement('div');
  el.className = 'xr-empty';
  const text = items.length
    ? '<p>没有待提交的实验报告</p><p class="xr-hint">都交完了，或者这一轮还没排实验。</p>'
    : '<p>还没有数据</p><p class="xr-hint">先点「登录」填学号与密码，再点「刷新」。</p>';
  el.innerHTML = '<div class="xr-empty-mark">✓</div>' + text;
  return el;
}

function tick() {
  if (!ctx || ctx.ui.depth > 0 || !listEl) return;
  const now = Date.now();
  const open = openReports();
  const sig = open.map((it) => (it.due && it.due < now ? '1' : '0')).join('');
  if (sig !== lastOverdue) {
    renderList();
    return;
  }
  for (const el of listEl.querySelectorAll('[data-remain]')) {
    const item = items.find((it) => it.id === el.getAttribute('data-remain'));
    if (item && item.due) el.textContent = remainText(item.due, now);
  }
  if (summaryEl) summaryEl.textContent = summaryText() || '还没有数据';
}

function onListClick(event) {
  const row = event.target.closest('[data-id]');
  if (!row) return;
  const item = items.find((it) => it.id === row.getAttribute('data-id'));
  if (item) openDetail(item);
}

function detailRows(item) {
  return [
    ['课程', item.course || '—'],
    ['实验', item.title],
    ['实验时间', item.start ? fmtFull(item.start) : '未排'],
    ['提交截止', item.due ? fmtFull(item.due) : '未排'],
    ['状态', item.status || (item.submitted ? '已提交' : '未提交')],
    ['上传时间', item.uploadedAt || '—'],
    ['成绩', item.score || '—'],
    ['指导教师', item.teacher || '—'],
  ];
}

function openDetail(item) {
  const page = ctx.ui.push({ onPop: () => renderList() });
  const body = detailRows(item).map((row) => '<div class="xr-info-row">'
    + '<span class="xr-info-key">' + esc(row[0]) + '</span>'
    + '<span class="xr-info-val">' + esc(row[1]) + '</span>'
    + '</div>').join('');
  page.root.innerHTML = `
    <div class="xr-page">
      <header class="xr-page-head">
        <button class="xr-back" type="button" data-close aria-label="返回">‹</button>
        <h1>${esc(item.title)}</h1>
      </header>
      <div class="xr-info">${body}</div>
      <p class="xr-hint" style="margin-top:14px">报告要在浏览器里写，插件只负责提醒。</p>
    </div>`;
  page.root.querySelector('[data-close]').addEventListener('click', () => page.close());
}

function openLate() {
  const list = lateReports();
  const page = ctx.ui.push({ onPop: () => renderList() });
  page.root.innerHTML = `
    <div class="xr-page">
      <header class="xr-page-head">
        <button class="xr-back" type="button" data-close aria-label="返回">‹</button>
        <h1>超时提交</h1>
      </header>
      <p class="xr-hint" style="margin-bottom:12px">这些报告已经交过，只是晚于截止时间；
        算不算分要看实验中心的规定。</p>
      <div id="late-list"></div>
    </div>`;
  page.root.querySelector('[data-close]').addEventListener('click', () => page.close());
  const box = page.root.querySelector('#late-list');
  if (!list.length) {
    box.innerHTML = '<div class="xr-empty"><p>没有超时提交的报告</p></div>';
    return;
  }
  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'xr-item is-late';
    const dueText = item.due ? fmtFull(item.due) : '—';
    const upText = item.uploadedAt ? '提交 ' + item.uploadedAt : '';
    row.innerHTML = '<div class="xr-body">'
      + '<div class="xr-line"><span class="xr-title">' + esc(item.title) + '</span>'
      + '<span class="xr-badge">超时提交</span></div>'
      + '<div class="xr-meta"><span>截止 ' + esc(dueText) + '</span>'
      + (upText ? '<span>' + esc(upText) + '</span>' : '')
      + '</div></div>';
    box.appendChild(row);
  }
}

function openAbout() {
  const page = ctx.ui.push({ onPop: () => renderList() });
  page.root.innerHTML = `
    <div class="xr-page">
      <header class="xr-page-head">
        <button class="xr-back" type="button" data-close aria-label="返回">‹</button>
        <h1>关于这个插件</h1>
      </header>
      <div class="xr-info">
        <div class="xr-info-row">
          <span class="xr-info-key">数据来源</span>
          <span class="xr-info-val">学校「报告系统」里的学生报告列表，只读：只看未提交、
            开始时间与提交截止时间。</span>
        </div>
        <div class="xr-info-row">
          <span class="xr-info-key">隐私</span>
          <span class="xr-info-val">学号与密码只存在本机的加密凭据里（系统 Keystore），
            不上传、不打印，界面上永远是掩码。</span>
        </div>
        <div class="xr-info-row">
          <span class="xr-info-key">网络</span>
          <span class="xr-info-val">实验系统只有校内明文地址，插件用 App 的「校内明文 http」
            通道；服务器模式下会自动经校园隧道代理出去。</span>
        </div>
      </div>
      <p class="xr-hint" style="margin-top:14px">当前服务器：
        ${esc(state.server.portal)} → ${esc(state.server.report)}</p>
    </div>`;
  page.root.querySelector('[data-close]').addEventListener('click', () => page.close());
}

// ==================== 账号卡 ====================

function renderAccount() {
  if (!accountEl) return;
  const signed = !!state.account;
  const status = state.syncing
    ? (state.stage || '同步中…')
    : state.lastSync
      ? agoText(state.lastSync)
      : signed ? '还没同步过' : '未登录';
  const primary = signed
    ? '<button class="xr-btn" type="button" data-act="sync"'
      + (state.syncing ? ' disabled' : '') + '>同步</button>'
    : '<button class="xr-btn" type="button" data-act="login">登录</button>';
  const clearLink = signed
    ? '<button class="xr-link xr-quiet-link" type="button" data-act="clear">'
      + (state.armedClear ? '再点一次退出' : '退出登录') + '</button>'
    : '';
  const offsets = OFFSET_CHOICES.map((o) => '<label class="xr-offset">'
    + '<input type="checkbox" data-offset="' + o.m + '"'
    + (state.offsets.indexOf(o.m) >= 0 ? ' checked' : '') + '>'
    + '<span>' + o.label + '</span></label>').join('');
  const err = state.error ? '<p class="xr-warn-text">' + esc(state.error) + '</p>' : '';

  accountEl.innerHTML = '<div class="xr-acc-row">'
    + '<span class="xr-dot' + (state.syncing ? ' is-busy' : '') + '"></span>'
    + '<span class="xr-acc-title">实验平台</span>'
    + '<span class="xr-acc-text">'
    + esc((signed ? state.account + ' · ' : '') + status) + '</span>'
    + primary
    + '</div>'
    + '<div class="xr-acc-actions">'
    + '<button class="xr-link" type="button" data-act="login">'
    + (signed ? '重新登录' : '登录') + '</button>'
    + clearLink
    + '</div>'
    + '<div class="xr-acc-offsets">'
    + '<span class="xr-acc-offset-title">默认提醒</span>'
    + '<div class="xr-offsets">' + offsets + '</div>'
    + '<p class="xr-hint">按截止时间提前推送；改完会自动重排。</p>'
    + '</div>'
    + '<div class="xr-acc-bg">'
    + '<button class="xr-link" type="button" data-act="background">'
    + (state.background ? '关闭后台刷新' : '开启后台刷新') + '</button>'
    + '<span class="xr-hint">保持本页打开并退到后台，每 30 分钟同步一次。</span>'
    + '</div>'
    + err;
  if (warnEl) {
    const text = state.error && !state.syncing ? state.error : '';
    warnEl.textContent = text;
    warnEl.classList.toggle('hidden', !text);
  }
}

function onAccountClick(event) {
  const act = event.target.closest('[data-act]');
  if (!act) return;
  const name = act.getAttribute('data-act');
  if (name === 'sync') syncNow();
  else if (name === 'login') openLogin();
  else if (name === 'clear') clearAll();
  else if (name === 'background') toggleBackground();
}

async function onAccountChange(event) {
  const raw = event.target.getAttribute && event.target.getAttribute('data-offset');
  if (raw == null) return;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const set = new Set(state.offsets);
  if (event.target.checked) set.add(minutes);
  else set.delete(minutes);
  state.offsets = [...set].sort((a, b) => b - a);
  await ctx.storage.set(OFFSETS_KEY, state.offsets);
  await syncNotifications();
  ctx.ui.toast(state.offsets.length
    ? '实验报告提醒：' + state.offsets.map(offsetLabel).join(' / ')
    : '已关闭实验报告提醒');
}

function openLogin() {
  const page = ctx.ui.push({ onPop: () => renderAccount() });
  page.root.innerHTML = `
    <div class="xr-page">
      <header class="xr-page-head">
        <button class="xr-back" type="button" data-close aria-label="返回">‹</button>
        <h1>登录实验平台</h1>
      </header>
      <div class="xr-form">
        <p class="xr-hint">填「基础信息平台 / 报告系统」用的学号与密码，和
          ${esc(state.server.portal)} 登录页是同一套。</p>
        <label class="xr-field">学号 / 账号
          <input id="f-account" autocomplete="username" inputmode="text" maxlength="32"
            placeholder="学号，例如 2025xxxxxxx">
        </label>
        <label class="xr-field">密码
          <input id="f-password" type="password" autocomplete="current-password" maxlength="64"
            placeholder="不显示、不打印">
        </label>
        <div class="xr-actions">
          <button id="f-save" class="xr-primary" type="button">保存并同步</button>
        </div>
        <p class="xr-hint">密码只写进本机加密凭据（ctx.secrets），源码、日志、界面都不留明文。</p>
      </div>
    </div>`;
  const account = page.root.querySelector('#f-account');
  const password = page.root.querySelector('#f-password');
  account.value = state.account || '';
  page.root.querySelector('[data-close]').addEventListener('click', () => page.close());
  page.root.querySelector('#f-save').addEventListener('click', async () => {
    const a = account.value.trim();
    const p = password.value;
    if (!a || !p) {
      ctx.ui.toast('账号和密码都要填');
      return;
    }
    await ctx.storage.set('xr.account', a);
    await ctx.secrets.set(KEY_PASS, p);
    state.account = a;
    state.hasPassword = true;
    state.error = '';
    renderAccount();
    page.close();
    await syncNow();
  });
  setTimeout(() => account.focus(), 60);
}

async function clearAll() {
  if (!state.armedClear) {
    state.armedClear = true;
    renderAccount();
    setTimeout(() => {
      if (!state.armedClear) return;
      state.armedClear = false;
      renderAccount();
    }, 3000);
    return;
  }
  state.armedClear = false;
  try {
    await ctx.secrets.remove(KEY_PASS);
    await ctx.secrets.remove(KEY_COOKIES);
  } catch (_) {}
  await ctx.storage.remove('xr.account');
  await ctx.storage.remove('xr.items');
  await ctx.storage.remove('xr.lastSync');
  await ctx.storage.remove('xr.semester');
  try {
    await ctx.notify.cancelAll();
  } catch (_) {}
  jars.clear();
  items = [];
  state.account = '';
  state.hasPassword = false;
  state.lastSync = 0;
  state.semester = '';
  state.error = '';
  renderAccount();
  renderList();
  ctx.ui.toast('已退出：本机的账号、密码与缓存都清掉了');
}

async function toggleBackground() {
  if (state.background) {
    state.background = false;
    await ctx.storage.set('xr.background', false);
    stopBackgroundTimer();
    try {
      await ctx.background.keepAlive({ enabled: false });
    } catch (_) {}
    renderAccount();
    ctx.ui.toast('已关闭后台刷新');
    return;
  }
  try {
    await ctx.background.keepAlive({
      enabled: true,
      title: 'SIT大物实验提醒',
      text: '正在后台刷新实验报告',
    });
    state.background = true;
    await ctx.storage.set('xr.background', true);
    startBackgroundTimer();
    renderAccount();
    ctx.ui.toast('已开启后台刷新');
  } catch (e) {
    const message = errText(e);
    if (message) ctx.ui.toast(message);
  }
}

function startBackgroundTimer() {
  stopBackgroundTimer();
  state.timer = setInterval(() => {
    syncNow().catch(() => {});
  }, 30 * 60 * 1000);
}

function stopBackgroundTimer() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

// ==================== 提醒 ====================

async function syncNotifications() {
  for (const key of scheduledKeys) {
    try {
      await ctx.notify.cancel(key);
    } catch (_) {}
  }
  scheduledKeys = [];
  const now = Date.now();
  let failed = false;
  for (const item of openReports()) {
    if (!item.due || item.due <= now) continue;
    for (const offset of state.offsets) {
      const at = item.due - offset * 60000;
      if (at <= now - 5 * 60000) continue;
      const key = 'xr:' + item.id + ':' + offset;
      try {
        await ctx.notify.schedule({
          key,
          title: '大物实验报告还有 ' + offsetLabel(offset),
          body: item.title + ' · 截止 ' + fmtFull(item.due),
          at: at > now + 30000 ? at : now + 30000,
        });
        scheduledKeys.push(key);
      } catch (_) {
        failed = true;
      }
    }
  }
  try {
    await ctx.storage.set('xr.notifiedKeys', scheduledKeys);
  } catch (_) {}
  if (failed && warnEl) {
    warnEl.textContent = '提醒没能排上：确认 App 已允许通知后再进来一次。';
    warnEl.classList.remove('hidden');
  }
}

function offsetLabel(minutes) {
  const choice = OFFSET_CHOICES.find((o) => o.m === minutes);
  if (choice) return choice.label.replace('提前 ', '');
  if (minutes % 10080 === 0) return (minutes / 10080) + ' 周';
  if (minutes % 1440 === 0) return (minutes / 1440) + ' 天';
  if (minutes % 60 === 0) return (minutes / 60) + ' 小时';
  return minutes + ' 分钟';
}

// ==================== 工具 ====================

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function fmtFull(ms) {
  const d = new Date(ms);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function remainText(due, now) {
  const diff = due - now;
  const mins = Math.round(Math.abs(diff) / 60000);
  let text;
  if (mins < 60) text = mins + ' 分钟';
  else if (mins < 1440) text = Math.round(mins / 60) + ' 小时';
  else text = Math.round(mins / 1440) + ' 天';
  return diff < 0 ? '逾期 ' + text : '还剩 ' + text;
}

function agoText(ms) {
  const diff = Date.now() - ms;
  if (diff < 60000) return '刚刚同步';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前同步';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前同步';
  return Math.floor(diff / 86400000) + ' 天前同步';
}

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function errText(error) {
  if (!error) return '';
  const message = String(error.message || error);
  if (/用户没有允许/.test(message)) return '你没有允许这条访问授权';
  if (/未知接口|net\.campus/.test(message)) {
    return 'App 版本太旧：需要 1.44.0 起的「校内明文 http」能力';
  }
  if (/连不上|连接失败|Connection|超时/.test(message)) {
    return '连不上实验系统：确认设备在校园网里，或先到「我的 → 校园服务」连上校园网'
      + '（服务器模式会自动走隧道）';
  }
  return message.length > 160 ? message.slice(0, 160) + '…' : message;
}

// ==================== 平台口令 ====================
//
// 学校登录页给密码做的处理是 haha.he(Encrypt3(明文))：
//   Encrypt3 = AES-128-ECB/PKCS7（固定口令 1234567891234567，见 BaseInfo/Login.js）→ base64
//   haha.he  = 再 base64 一次
// 下面自己实现 AES-128-ECB，免得在拓展里依赖任何外部库。

const AES_RCON = [1, 2, 4, 8, 16, 32, 64, 128, 27, 54];
const AES_TABLES = buildAesTables();

function buildAesTables() {
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = x;
    log[x] = i;
    x = (x ^ (x << 1) ^ ((x & 0x80) ? 0x11b : 0)) & 0xff;
  }
  for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255];
  const mul = (a, b) => ((a === 0 || b === 0) ? 0 : exp[log[a] + log[b]]);
  const sbox = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    const inv = i === 0 ? 0 : exp[255 - log[i]];
    let s = inv;
    let r = inv;
    for (let j = 0; j < 4; j += 1) {
      r = ((r << 1) | (r >>> 7)) & 0xff;
      s ^= r;
    }
    sbox[i] = s ^ 0x63;
  }
  return { mul, sbox };
}

function aesExpandKey(key) {
  const rk = new Uint8Array(176);
  rk.set(key, 0);
  let r = 0;
  for (let i = 16; i < 176; i += 4) {
    let t = [rk[i - 4], rk[i - 3], rk[i - 2], rk[i - 1]];
    if (i % 16 === 0) {
      t = [t[1], t[2], t[3], t[0]].map((b) => AES_TABLES.sbox[b]);
      t[0] ^= AES_RCON[r];
      r += 1;
    }
    for (let j = 0; j < 4; j += 1) rk[i + j] = rk[i - 16 + j] ^ t[j];
  }
  return rk;
}

function aesEncryptBlock(rk, s) {
  for (let i = 0; i < 16; i += 1) s[i] ^= rk[i];
  for (let round = 1; round <= 10; round += 1) {
    for (let i = 0; i < 16; i += 1) s[i] = AES_TABLES.sbox[s[i]];
    const t = Uint8Array.from(s);
    for (let r = 1; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) s[r + 4 * c] = t[r + 4 * ((c + r) % 4)];
    }
    if (round !== 10) {
      for (let c = 0; c < 4; c += 1) {
        const a0 = s[4 * c];
        const a1 = s[4 * c + 1];
        const a2 = s[4 * c + 2];
        const a3 = s[4 * c + 3];
        s[4 * c] = AES_TABLES.mul(a0, 2) ^ AES_TABLES.mul(a1, 3) ^ a2 ^ a3;
        s[4 * c + 1] = a0 ^ AES_TABLES.mul(a1, 2) ^ AES_TABLES.mul(a2, 3) ^ a3;
        s[4 * c + 2] = a0 ^ a1 ^ AES_TABLES.mul(a2, 2) ^ AES_TABLES.mul(a3, 3);
        s[4 * c + 3] = AES_TABLES.mul(a0, 3) ^ a1 ^ a2 ^ AES_TABLES.mul(a3, 2);
      }
    }
    for (let i = 0; i < 16; i += 1) s[i] ^= rk[round * 16 + i];
  }
}

function utf8Bytes(text) {
  const out = [];
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    const cp = value.codePointAt(i);
    if (cp > 0xffff) i += 1;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
  }
  return Uint8Array.from(out);
}

function b64encode(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    out += b1 === undefined ? '=' : chars[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    out += b2 === undefined ? '=' : chars[b2 & 63];
  }
  return out;
}

/** 学校登录页的密码处理：AES-128-ECB/PKCS7 → base64 → 再 base64。 */
function platformPass(raw, keyStr) {
  const key = utf8Bytes(keyStr);
  const data = utf8Bytes(raw);
  const pad = 16 - (data.length % 16);
  const buf = new Uint8Array(data.length + pad);
  buf.set(data);
  buf.fill(pad, data.length);
  const rk = aesExpandKey(key);
  const out = new Uint8Array(buf.length);
  for (let off = 0; off < buf.length; off += 16) {
    const block = Uint8Array.from(buf.subarray(off, off + 16));
    aesEncryptBlock(rk, block);
    out.set(block, off);
  }
  return b64encode(utf8Bytes(b64encode(out)));
}
