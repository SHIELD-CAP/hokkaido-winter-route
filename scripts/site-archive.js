// 网站判级存档：用和网站完全相同的 site/src/engine.js 取数、判级，把结果存进 data/site_log/。
// 网站本身在访问者设备上现算、算完不留；这份存档用来在冬天结束后检验网站的真实成绩。
//
// 用法：
//   node scripts/site-archive.js              在线：像网站一样直接取气象厅和 Open-Meteo（GitHub Actions 里用这个）
//   SITE_ARCHIVE_OFFLINE=1 node scripts/site-archive.js
//                                             离线自检：气象厅产品用 data/archive 里最新的一份，模式用 data/latest 的副本，
//                                             只检查格式，不写进 data/site_log
//
// Open-Meteo 取不到（429、网络错误）时，MSM、ECMWF 改用仓库副本 data/latest/msm.json、ifs.json，并在 inputs 里写明。
'use strict';
global.HKR_NO_AUTOSTART = true;
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const HKR = require(path.join(ROOT, 'site/src/engine.js'));
const RAW = HKR._test.RAW;
const OFFLINE = !!process.env.SITE_ARCHIVE_OFFLINE;
const JST = 9 * 3600e3;

function readJson(f) { const b = fs.readFileSync(f); return JSON.parse(f.endsWith('.gz') ? zlib.gunzipSync(b) : b); }
function iso(ms) { return ms ? new Date(ms).toISOString() : null; }
function jstStamp(ms) { const d = new Date(ms + JST); const p = n => String(n).padStart(2, '0'); return { y: String(d.getUTCFullYear()), m: p(d.getUTCMonth() + 1), d: p(d.getUTCDate()), hm: p(d.getUTCHours()) + p(d.getUTCMinutes()), text: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} JST` }; }

// 仓库副本 → 网站引擎用的格式（点的顺序按 HKR.PTS）
function repoModel(key) {
  const f = path.join(ROOT, 'data/latest', key === 'msm' ? 'msm.json' : 'ifs.json');
  const norm = readJson(f);
  const byId = Object.fromEntries(norm.points.map(p => [p.id, p]));
  const om = HKR.PTS.map(p => { const q = byId[p.id]; return q ? { latitude: q.grid_lat, longitude: q.grid_lon, elevation: q.elevation, hourly: q.hourly } : null; });
  return { data: HKR.compactOM(om), init: Date.parse(norm.init_utc), fetched: Date.parse(norm.fetched_utc) };
}
function useRepo(key, why) {
  const r = repoModel(key);
  RAW[key] = { ok: true, data: r.data, fetchedAt: r.fetched };
  RAW['meta_' + key] = { ok: true, data: { init: r.init, avail: r.init }, fetchedAt: r.fetched };
  return { source: 'repo', reason: why, init: iso(r.init), repo_fetched: iso(r.fetched) };
}

function latestArchive(key) {
  const base = path.join(ROOT, 'data/archive');
  let best = null;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith(key + '_') && (!best || e.name > path.basename(best))) best = p;
    }
  })(base);
  return best;
}

async function load() {
  const inputs = {};
  if (OFFLINE) {
    for (const [key, url, tf] of HKR.JOBS) {
      if (/open-meteo/.test(url)) continue;
      const f = latestArchive(key);
      if (!f) { RAW[key] = { ok: false, err: '离线自检：存档里没有' }; continue; }
      try { RAW[key] = { ok: true, data: tf ? tf(readJson(f)) : readJson(f), fetchedAt: Date.now() }; inputs[key] = { source: 'archive', file: path.relative(ROOT, f) }; }
      catch (e) { RAW[key] = { ok: false, err: '离线自检：存档格式读不了（' + e.message + '）' }; }
    }
    RAW.obs = { ok: false, err: '离线自检：不取实况' };
    RAW.ens = { ok: false, err: '离线自检：不取' };
    inputs.msm = useRepo('msm', '离线自检');
    inputs.ifs = useRepo('ifs', '离线自检');
    return inputs;
  }
  await HKR.loadAll(true);
  for (const key of ['msm', 'ifs']) {
    const r = RAW[key], m = RAW['meta_' + key];
    if (r && r.ok) inputs[key] = { source: 'live', init: m && m.ok ? iso(m.data.init) : null };
    else inputs[key] = useRepo(key, r ? r.err : '没有结果');
  }
  return inputs;
}

function slimReasons(rs) { return (rs || []).map(r => ({ level: r.level, rule: r.rule || '', text: r.text, short: r.short || '', dk: r.dk || '' })); }

(async () => {
  const t0 = Date.now();
  const inputs = await load();
  const now = Date.now();
  const V = HKR.buildView(RAW, now);
  // 各项输入的状态（取数成功与否、错误原文）
  for (const [key] of HKR.JOBS) {
    const r = RAW[key];
    if (!inputs[key] && /^meta_/.test(key) && inputs[key.slice(5)]) { inputs[key] = { source: inputs[key.slice(5)].source }; continue; }
    if (!inputs[key]) inputs[key] = r ? (r.ok ? { source: OFFLINE ? 'archive' : 'live' } : { source: 'error', err: r.err }) : { source: 'missing' };
  }
  inputs.obs = RAW.obs ? (RAW.obs.ok ? { source: 'live', latest: iso(RAW.obs.data.latest) } : { source: 'error', err: RAW.obs.err }) : { source: 'missing' };
  const st = jstStamp(now);
  const out = {
    schema: 1,
    run_utc: iso(now), run_jst: st.text, seconds: Math.round((now - t0) / 1000),
    commit: process.env.GITHUB_SHA || null,
    rules: V.meta.rulesVersion, freshness: V.meta.freshness,
    inputs,
    sources: (V.sources || []).map(s => ({ name: s.name, status: s.status, reportTime: s.reportTime, note: s.note })),
    banners: (V.banners || []).map(b => ({ level: b.level, text: b.text })),
    routes: V.routes.map(rt => ({
      id: rt.id, short: rt.short,
      days: rt.days.map(d => {
        const o = { date: d.date, level: d.level, headline: d.headline || '', missing: d.missing || [], reasons: (d.reasons || []).map(r => ({ level: r.level, text: r.text })) };
        if (d.segments) o.segments = d.segments.map(s => ({ id: s.id, name: s.name, time: s.time, level: s.level, past: !!s.past, reasons: slimReasons(s.reasons), raw: s.raw || [] }));
        if (d.grid) o.grid = { rows: d.grid.rows.map(r => r.id + ' ' + r.name), cols: d.grid.cols, cells: d.grid.cells.map(row => row.map(c => ({ level: c.level, past: !!c.past, reasons: slimReasons(c.reasons), raw: c.raw || [] }))) };
        return o;
      })
    }))
  };
  const json = JSON.stringify(out);
  const lv = { black: '⬛', red: '🔴', orange: '🟠', green: '🟢', gray: '⬜' };
  for (const rt of out.routes) console.log(rt.short, rt.days.map(d => d.date.slice(5) + (lv[d.level] || d.level)).join(' '));
  console.log('输入：', Object.entries(inputs).map(([k, v]) => `${k}:${v.source}${v.init ? '(' + v.init + ')' : ''}${v.err ? '(' + String(v.err).slice(0, 60) + ')' : ''}`).join(' '));
  const rawJson = JSON.stringify({ run_utc: iso(now), now, commit: process.env.GITHUB_SHA || null, RAW });
  if (OFFLINE) { console.log('离线自检，不写文件；结果 JSON', json.length, '字节，gzip 后', zlib.gzipSync(json).length, '字节；输入整包', rawJson.length, '字节，gzip 后', zlib.gzipSync(rawJson).length, '字节'); return; }
  // 输入整包：传给 buildView 的全部数据，以后改了规则可以在真实历史上重放（HKR.buildView(RAW, now)）。放在另一个分支，不让主分支越来越大
  if (process.env.SITE_INPUTS_DIR) {
    const idir = path.join(process.env.SITE_INPUTS_DIR, st.y, st.m, st.d);
    fs.mkdirSync(idir, { recursive: true });
    fs.writeFileSync(path.join(idir, st.hm + '.json.gz'), zlib.gzipSync(rawJson));
    console.log('输入整包：', path.join(st.y, st.m, st.d, st.hm + '.json.gz'), rawJson.length, '字节');
  }
  const dir = path.join(ROOT, 'data/site_log', st.y, st.m, st.d);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, st.hm + '.json.gz');
  fs.writeFileSync(f, zlib.gzipSync(json));
  console.log('已存：', path.relative(ROOT, f), json.length, '字节');
})().catch(e => { console.error('出错：', e && e.stack || e); process.exit(1); });
