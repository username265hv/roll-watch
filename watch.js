'use strict';

/**
 * 换月提醒 · GitHub Actions 版
 *
 * 由 GitHub 每 5 分钟触发一次，跑在 GitHub 自己的机器上，不依赖任何人的电脑或沙箱。
 *
 * 流程：拉配置 → 拉行情 → 算「折合每月」→ 对比阈值 → 超了就推 Bark。
 *
 * 配置来源有优先级：
 *   1. 沙箱服务上的最新值（你在网页 / 安卓里改的），前提是它这段时间内有心跳
 *   2. 仓库里的 config.json 备份
 * 拿得到第 1 种就顺手写回 config.json，等于自动备份，沙箱哪天没了也不影响推送。
 *
 * 口径与界面一致：卖出近月看买一，买入远月看卖一，已含一次买卖价差。
 */

const fs = require('fs');
const path = require('path');

const CFG_FILE = path.join(__dirname, 'config.json');
const STATE_FILE = path.join(__dirname, 'state.json');

const PRODUCTS = [
  { k: 'IM', t: '中证1000', m: 200, u: '点', night: false },
  { k: 'I',  t: '铁矿石',   m: 100, u: '元/吨', night: true },
  { k: 'IC', t: '中证500',  m: 200, u: '点', night: false },
  { k: 'IF', t: '沪深300',  m: 300, u: '点', night: false },
  { k: 'IH', t: '上证50',   m: 300, u: '点', night: false },
];

const DEFAULTS = {
  enabled: false,
  bark: '',
  onlySession: true,
  cooldownMin: 0,
  thresholds: {},
  positions: {},
};

const ENV = process.env;
const SANDBOX = (ENV.SANDBOX_URL || '').replace(/\/+$/, '');
const SANDBOX_KEY = ENV.SANDBOX_KEY || '';
const BARK = ENV.BARK_URL || '';
// 长跑模式：一次 job 连续盯多久（分钟）。0 = 只跑一轮就退出（本地调试用）。
// GitHub 单 job 上限 6 小时，这里留 10 分钟余量给 checkout/commit。
const LOOP_MIN = Number(ENV.LOOP_MINUTES || 0);
// 每轮间隔。默认 60 秒——采样是瞬时快照，越密越不容易漏掉盘中的短暂突破。
// 但也不能再快了：新浪行情接口对短时间高频请求会限流，1 分钟是稳妥的极限。
const LOOP_STEP_SEC = Number(ENV.LOOP_STEP_SEC || 60);
const LOOP_STEP_MS = LOOP_STEP_SEC * 1000;
// 拉配置、回写心跳这类"维持性"动作没必要每轮都做，按轮次降频即可
const SYNC_EVERY = Math.max(1, Math.round(300 / LOOP_STEP_SEC));
const FORCE_ANYTIME = ENV.FORCE_ANYTIME === '1';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- 读写

function readJson(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return def;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------- 时间

/** 北京时间，不依赖 runner 的时区（runner 是 UTC） */
function bjNow(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  return {
    wd: d.getUTCDay(),
    hm: d.getUTCHours() * 100 + d.getUTCMinutes(),
    label: ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2),
    date: d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2),
  };
}

function inSession(prod, t) {
  if (t.wd === 0 || t.wd === 6) return false;
  if (t.hm >= 915 && t.hm <= 1135) return true;
  if (t.hm >= 1255 && t.hm <= 1505) return true;
  if (prod.night && t.hm >= 2100 && t.hm <= 2305) return true;
  return false;
}

/**
 * 下一个交易时段的开始时刻（时间戳）。未来 4 天内找不到就返回 0。
 * 用途：定时任务可能在任何时间点被触发，收盘后触发的话没必要占着 runner 空转 6 小时。
 * 时间点跟 inSession 对齐：09:15 / 12:55 / 21:00（夜盘只有铁矿那几个品种）。
 */
function nextSessionStartTs() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const bjMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 8 * 3600 * 1000;
  const slots = [915, 1255, 2100];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const dayBase = bjMidnight + i * 86400000;
    const wd = new Date(dayBase + 8 * 3600 * 1000).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const hm of slots) {
      const ts = dayBase + Math.floor(hm / 100) * 3600000 + (hm % 100) * 60000;
      if (ts > Date.now()) out.push(ts);
    }
  }
  return out.length ? Math.min(...out) : 0;
}

/**
 * 北京时间今天最后一个交易时段的收盘时刻（时间戳）。周末返回 0。
 * 长跑模式靠它提前收工——下午 15:05 收完就别占着 runner 空转。
 * 注意夜盘 23:05 收盘，不跨零点是运气。
 */
function lastSessionEndToday() {
  const t = bjNow();
  if (t.wd === 0 || t.wd === 6) return 0;
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  // 以「北京当日 00:00」为基准拼出 23:05，再换算回真实时间戳
  const bjMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 8 * 3600 * 1000;
  return bjMidnight + 23 * 3600 * 1000 + 5 * 60 * 1000;
}

// ---------------------------------------------------------------- 合约

function candidateCodes(key, t) {
  const d = new Date((t ? Date.now() : Date.now()) + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const out = [];
  for (let i = 0; i < 12; i++) {
    const k = mo - 1 + i;
    out.push(key + ('0' + ((y + Math.floor(k / 12)) % 100)).slice(-2) + ('0' + ((k % 12) + 1)).slice(-2));
  }
  return out;
}

function monthsBetween(a, b) {
  const ya = 2000 + parseInt(a.slice(-4, -2), 10), ma = parseInt(a.slice(-2), 10);
  const yb = 2000 + parseInt(b.slice(-4, -2), 10), mb = parseInt(b.slice(-2), 10);
  const n = (yb * 12 + mb) - (ya * 12 + ma);
  return n === 0 ? 1 : Math.abs(n);
}

function money(v) {
  const s = Math.abs(Math.round(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v >= 0 ? '+' : '-') + s;
}

// ---------------------------------------------------------------- 行情

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

async function getText(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const res = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    // 新浪返回 GBK，只取数字和 ASCII，用 latin1 足够，且不会因解码失败丢数据
    return { status: res.status, body: buf.toString('latin1') };
  } finally {
    clearTimeout(timer);
  }
}

const num = (s) => {
  const v = parseFloat(s);
  return isNaN(v) ? 0 : v;
};

function parseQuote(code, payload) {
  const s = (payload || '').trim();
  if (!s) return null;
  const f = s.split(',');
  if (f.length < 15) return null;

  const out = { code, price: 0, preSettle: 0, oi: 0, bid: 0, ask: 0, date: null, time: null };
  const numericFirst = /^[0-9+-]/.test(f[0]);

  if (numericFirst) {
    // 中金所：开,高,低,最新,量,额,持仓,...,昨结(14),...,买一(16),...,卖一(26)
    out.price = num(f[3]);
    out.oi = num(f[6]);
    out.preSettle = num(f[14]);
    if (f.length > 26) {
      out.bid = num(f[16]);
      out.ask = num(f[26]);
    }
  } else {
    // 大商所：名称,时间,开,高,低,昨收,买一(6),卖一(7),最新(8),结算,昨结(10),...,持仓(13)
    out.price = num(f[8]);
    out.preSettle = num(f[10]);
    out.oi = num(f[13]);
    out.bid = num(f[6]);
    out.ask = num(f[7]);
    if (/^\d{6}$/.test(f[1])) {
      out.time = f[1].slice(0, 2) + ':' + f[1].slice(2, 4) + ':' + f[1].slice(4, 6);
    }
  }

  for (let i = 0; i < f.length; i++) {
    const v = f[i].trim();
    if (!out.date && /^\d{4}-\d{2}-\d{2}$/.test(v)) out.date = v;
    else if (!out.time && /^\d{2}:\d{2}:\d{2}$/.test(v)) out.time = v;
  }

  if (out.price <= 0) out.price = out.preSettle;
  if (out.price <= 0) return null;
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchQuotes(codes) {
  const url = 'https://hq.sinajs.cn/list=' + codes.map((c) => 'nf_' + c).join(',');
  const headers = {
    Referer: 'https://finance.sina.com.cn',
    'User-Agent': UA,
    Accept: '*/*',
  };
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await getText(url, headers, 8000);
      if (r.status !== 200) throw new Error('上游 HTTP ' + r.status);
      const quotes = {};
      const re = /var hq_str_nf_([A-Z0-9]+)="([^"]*)"/g;
      let m;
      while ((m = re.exec(r.body)) !== null) {
        const q = parseQuote(m[1], m[2]);
        if (q) quotes[q.code] = q;
      }
      if (Object.keys(quotes).length) return quotes;
      throw new Error('返回为空');
    } catch (e) {
      lastErr = e;
      if (i < 2) await sleep(500 * (i + 1));
    }
  }
  throw lastErr || new Error('取数失败');
}

// ---------------------------------------------------------------- 推送

function sanitizeBark(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(https?:\/\/[^\/?#\s]+)([^?#\s]*)/);
  if (!m) return '';
  const origin = m[1];
  const rest = (m[2] || '').replace(/^\/+|\/+$/g, '');
  if (!rest) return origin;
  const seg = rest.split('/');
  if (seg.length > 1 && /^[A-Za-z0-9_-]{8,}$/.test(seg[0])) return origin + '/' + seg[0];
  return origin + '/' + rest;
}

async function barkSend(rawUrl, title, body) {
  const base = sanitizeBark(rawUrl);
  if (!base) return { ok: false, error: 'bark 地址无效' };
  const sep = base.indexOf('?') >= 0 ? '&' : '?';
  const url = base + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body)
    + sep + 'group=' + encodeURIComponent('换月助手') + '&level=active';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    clearTimeout(timer);
    let code = res.status, msg = '';
    try {
      const j = JSON.parse(text);
      if (j.code !== undefined) code = j.code;
      msg = j.message || '';
    } catch (e) { /* 非 JSON 就按状态码判断 */ }
    return { ok: res.status === 200 && (code === 200 || code === 201), status: res.status, code, message: msg };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------- 配置

/**
 * 从沙箱服务取最新配置。
 * 只有当它最近 10 分钟内有心跳才认，否则说明服务睡了或已经不跑了，用仓库备份。
 */
async function pullRemoteCfg() {
  if (!SANDBOX) return null;
  const q = SANDBOX_KEY ? '?sharecode=' + encodeURIComponent(SANDBOX_KEY) : '';
  try {
    const r = await getText(SANDBOX + '/api/alert/config' + q, {}, 8000);
    if (r.status !== 200) return null;
    const j = JSON.parse(r.body);
    const c = j.cfg || j;
    const fresh = Number(c.now) - Number(c.lastBeat) < 10 * 60 * 1000;
    if (!fresh) {
      log('沙箱心跳已过期，改用仓库备份配置');
      return null;
    }
    const out = {
      enabled: !!c.enabled,
      onlySession: !!c.onlySession,
      cooldownMin: Number(c.cooldownMin) || 0,
      thresholds: c.thresholds || {},
      positions: c.positions || {},
    };
    // bark 优先用 Secrets（不落在公开仓库里）
    out.bark = '';
    return out;
  } catch (e) {
    log('拉沙箱配置失败：' + e.message);
    return null;
  }
}

/** 把这次执行的结果回写给沙箱，面板上的「监控中」看的就是这个 */
async function beat(payload) {
  if (!SANDBOX) return;
  const q = SANDBOX_KEY ? '?sharecode=' + encodeURIComponent(SANDBOX_KEY) : '';
  try {
    await fetch(SANDBOX + '/api/alert/beat' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    log('回写心跳失败：' + e.message);
  }
}

// ---------------------------------------------------------------- 主流程

// 长跑时 state 必须跨轮保留：冷却窗口、已推记录都靠它，否则 5 分钟后会重复推。
let RUN_STATE = null;
function loadState() {
  if (!RUN_STATE) {
    RUN_STATE = readJson(STATE_FILE, { lastPush: {}, lastKeep: 0 });
    if (!RUN_STATE.lastPush) RUN_STATE.lastPush = {};
  }
  return RUN_STATE;
}

/** 跑一轮检查。原来的 main，逻辑没动，只是改成可被循环反复调用。 */
async function runOnce(opts) {
  const doSync = !opts || opts.sync !== false;   // 只有该同步的轮次才拉配置、写心跳
  const localCfg = Object.assign({}, DEFAULTS, readJson(CFG_FILE, {}));
  const state = loadState();

  let cfg = localCfg;
  let cfgChanged = false;

  if (doSync) {
    const remote = await pullRemoteCfg();
    if (remote) {
      cfg = Object.assign({}, localCfg, remote);
      const backup = Object.assign({}, localCfg, remote);
      if (!sameJson(backup, localCfg)) {
        writeJson(CFG_FILE, backup);
        cfgChanged = true;
        log('配置已从沙箱同步并备份到仓库');
      }
    }
  }

  // 搬家过 30 天就碰一下仓库，避免 GitHub 因为长期没有提交而停掉定时任务
  let keepTouched = false;
  if (Date.now() - (state.lastKeep || 0) > 30 * 86400 * 1000) {
    state.lastKeep = Date.now();
    keepTouched = true;
  }

  const now = bjNow();
  const result = { at: Date.now(), label: now.label, session: false, items: [], pushed: [], skipped: null };

  const barkUrl = BARK || cfg.bark;
  if (!barkUrl) { result.skipped = 'no-bark'; log('没配 Bark，跳过'); }
  else if (!cfg.enabled) { result.skipped = 'disabled'; log('提醒已关闭，跳过'); }
  else {
    for (const p of PRODUCTS) {
      const th = Number((cfg.thresholds || {})[p.k]);
      const posCode = (cfg.positions || {})[p.k];
      if (!th || !posCode) continue;
      if (cfg.onlySession && !inSession(p, now)) continue;
      result.session = true;

      let quotes;
      try {
        quotes = await fetchQuotes(candidateCodes(p.k));
      } catch (e) {
        result.items.push({ product: p.k, error: 'fetch: ' + e.message });
        log(p.t + ' 取数失败：' + e.message);
        continue;
      }

      // 已到期合约新浪仍返回旧快照，只留最新交易日那批
      let latest = null;
      Object.keys(quotes).forEach((k) => {
        if (quotes[k].date && (!latest || quotes[k].date > latest)) latest = quotes[k].date;
      });
      if (latest) {
        Object.keys(quotes).forEach((k) => {
          if (quotes[k].date !== latest) delete quotes[k];
        });
      }

      const posQ = quotes[posCode];
      if (!posQ) {
        result.items.push({ product: p.k, pos: posCode, error: '持仓合约无报价（可能已到期）' });
        log(p.t + ' 持仓 ' + posCode + ' 无报价');
        continue;
      }

      const later = Object.keys(quotes).sort().filter((k) => k > posCode);
      const hits = [];
      for (const code of later) {
        const far = quotes[code];
        const bidOk = posQ.bid > 0;
        const askOk = far.ask > 0;
        const leg0 = bidOk ? posQ.bid : posQ.price;
        const leg1 = askOk ? far.ask : far.price;
        const m = monthsBetween(posCode, code);
        const per = (leg0 - leg1) / m;
        if (per >= th) hits.push({ code, months: m, per, cash: per * p.m, missing: !bidOk || !askOk });
      }

      result.items.push({ product: p.k, pos: posCode, threshold: th, later: later.length, hits: hits.length });
      if (!hits.length) { log(p.t + ' ' + posCode + ' 阈值 ' + th + '，' + later.length + ' 个可换，未达标'); continue; }

      const key = p.k + '|' + posCode + '|' + hits.map((h) => h.code).join(',');
      const last = state.lastPush[key] || 0;
      if (cfg.cooldownMin > 0 && Date.now() - last < cfg.cooldownMin * 60000) {
        result.items[result.items.length - 1].cooldown = true;
        log(p.t + ' 达标但在冷却期内，不推');
        continue;
      }

      hits.sort((a, b) => b.per - a.per);
      const best = hits[0];
      const lines = hits.slice(0, 3).map((h) => (h.code.slice(-4) + '（' + h.months + '个月）折合 '
        + h.per.toFixed(1) + ' ' + p.u + '/月 ≈ ' + money(h.cash) + ' 元/手/月'
        + (h.missing ? ' · 缺盘口' : '')));

      const title = '换月机会 · ' + p.t + ' 超 ' + th + ' ' + p.u + '/月';
      const body = '持仓 ' + posCode.slice(-4) + ' →\n' + lines.join('\n')
        + (hits.length > 3 ? '\n…另有 ' + (hits.length - 3) + ' 个合约也达标' : '')
        + '\n\n' + now.label + ' 盘中 · 对手价口径';

      const sent = await barkSend(barkUrl, title, body);
      if (sent.ok) {
        state.lastPush[key] = Date.now();
        result.pushed.push({ product: p.k, pos: posCode, best: best.code, per: Number(best.per.toFixed(2)) });
        log(p.t + ' 已推送：' + best.code + ' 折合 ' + best.per.toFixed(1));
      } else {
        result.items.push({ product: p.k, error: 'push failed: ' + (sent.error || sent.message || sent.status) });
        log(p.t + ' 推送失败：' + (sent.error || sent.message || sent.status));
      }
    }
  }

  if (result.pushed.length || keepTouched || cfgChanged) writeJson(STATE_FILE, state);

  // 心跳 5 分钟一次足够（沙箱按 8 分钟判新鲜），不必每轮都占用一次请求
  if (doSync) await beat(result);

  console.log('RESULT ' + JSON.stringify(result));
  return result;
}

/**
 * 长跑模式：一个 job 连续盯到收盘，内部每 5 分钟一轮。
 * 关键收益——把「一天必须准点触发 288 次」降级成「一天触发 2 次」，
 * 就算 GitHub 的定时器大面积跳票也不影响。沙箱死不死更无所谓了。
 */
async function main() {
  if (!LOOP_MIN) {
    await runOnce();
    return;
  }

  const hardStop = Date.now() + LOOP_MIN * 60000;

  // 定时任务在什么时候被唤起都不一定。收盘后被唤起就别占着 runner 空转，
  // 直接交还给下一个触发点——后面还有一串冗余的 cron 兜着。
  // FORCE_ANYTIME=1 用于本地调试，跳过时段判断。
  const anyInSession = FORCE_ANYTIME || PRODUCTS.some((p) => inSession(p, bjNow()));
  if (!anyInSession) {
    const ns = nextSessionStartTs();
    if (!ns) {
      log('接下来几个交易日都没有交易时段，退出');
      return;
    }
    const waitStart = ns - Date.now();
    // 70 分钟以内就等着开盘（午休刚过、夜盘前一小时这类情况），再远就交给后面的定时器
    if (waitStart > 70 * 60000) {
      log('距下一个交易时段还有 ' + Math.round(waitStart / 60000) + ' 分钟，本次不启动监听');
      return;
    }
    if (waitStart > 0) {
      log('提前 ' + Math.round(waitStart / 60000) + ' 分钟被唤起，等到开盘再开始');
      await sleep(waitStart);
    }
  }

  log('长跑启动：最多盯 ' + LOOP_MIN + ' 分钟，每 ' + LOOP_STEP_SEC + ' 秒一轮');

  for (let round = 1; ; round++) {
    try {
      await runOnce({ sync: (round - 1) % SYNC_EVERY === 0 });
    } catch (e) {
      log('第 ' + round + ' 轮异常：' + ((e && e.message) || e));
    }

    const now = Date.now();
    const dayEnd = lastSessionEndToday();
    let stopAt = hardStop;
    if (dayEnd > now && dayEnd < stopAt) stopAt = dayEnd;   // 收盘就提前收工，不空转

    if (now >= stopAt) {
      log('到点收工，共跑 ' + round + ' 轮');
      break;
    }

    const nextTick = Math.ceil((now + 2000) / LOOP_STEP_MS) * LOOP_STEP_MS;
    const wait = Math.min(nextTick, stopAt) - now;
    if (wait < 5000) break;   // 剩不到 5 秒就别再起一轮了
    log('第 ' + round + ' 轮完成，' + Math.round(wait / 1000) + ' 秒后继续');
    await sleep(wait);
  }
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack || e));
  // 不让 workflow 挂红：挂了 GitHub 会给账号发失败邮件，天天骚扰
  process.exit(0);
});
