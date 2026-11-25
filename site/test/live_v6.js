// v6 测试：气象厅产品用 /tmp/live6 里刚取的；MSM、ECMWF 用仓库副本（或存档）；实况用 /tmp/live6 里的单站文件
// 用法：node test/live_v6.js [当前时刻 ISO] [msm 文件] [实况最新时刻 ISO]
//   例：node test/live_v6.js                         （现在）
//       node test/live_v6.js 2026-11-25T08:05+09:00 /path/msm_20261125T1342Z.json.gz 2026-11-25T08:00+09:00
global.HKR_NO_AUTOSTART = true;
const fs = require('fs'), zlib = require('zlib');
const HKR = require('../src/engine.js');
const L = '/tmp/live6/';
const REPO = '/home/claude/hokkaido-winter-route/data/latest/';
const now = process.argv[2] ? Date.parse(process.argv[2]) : Date.now();
const msmFile = process.argv[3] || REPO + 'msm.json';
const obsLatest = process.argv[4] ? Date.parse(process.argv[4]) : null;

function readJson(f) { const b = fs.readFileSync(f); return JSON.parse(f.endsWith('.gz') ? zlib.gunzipSync(b) : b); }
function toOM(norm) {   // 仓库里整理过的格式 → Open-Meteo 原始格式（多点数组），点的顺序按网站 PTS
  const byId = Object.fromEntries(norm.points.map(p => [p.id, p]));
  return HKR.PTS.map(p => { const q = byId[p.id]; return q ? { latitude: q.grid_lat, longitude: q.grid_lon, elevation: q.elevation, hourly: q.hourly } : null; });
}
const RAW = {};
for (const [key, url, tf] of HKR.JOBS) {
  if (/open-meteo/.test(url)) continue;
  try { const j = readJson(L + 'raw_' + key + '.json'); RAW[key] = { ok: true, data: tf ? tf(j) : j, fetchedAt: now }; }
  catch (e) { RAW[key] = { ok: false, err: e.message }; }
}
const msm = readJson(msmFile), ifs = readJson(REPO + 'ifs.json');
RAW.msm = { ok: true, data: HKR.compactOM(toOM(msm)), fetchedAt: now };
RAW.ifs = { ok: true, data: HKR.compactOM(toOM(ifs)), fetchedAt: now };
RAW.meta_msm = { ok: true, data: { init: Date.parse(msm.init_utc), avail: Date.parse(msm.init_utc) }, fetchedAt: now };
RAW.meta_ifs = { ok: true, data: { init: Date.parse(ifs.init_utc), avail: Date.parse(ifs.init_utc) }, fetchedAt: now };
RAW.ens = { ok: false, err: '测试里不取' };
// 实况
{
  const st = {};
  let latest = obsLatest;
  for (const [id] of HKR.OBS_ST) {
    const recs = {};
    for (const f of fs.readdirSync(L).filter(f => f.startsWith('obs_' + id + '_'))) Object.assign(recs, HKR.pickObs(readJson(L + f)));
    if (Object.keys(recs).length) st[id] = recs;
  }
  if (latest == null) latest = Math.max(...Object.values(st).map(r => Math.max(...Object.keys(r).map(Number))));
  RAW.obs = { ok: true, data: { latest, st }, fetchedAt: now };
}
const V = HKR.buildView(RAW, now);
console.log('规则', V.meta.rulesVersion, '|', V.meta.freshness);
const E = { black: '⬛', red: '🔴', orange: '🟠', green: '🟢', gray: '⚪' };
const ob = V.sources.find(s => /当天高速时段/.test(s.name)); console.log('实况：', ob && ob.status, ob && ob.reportTime, ob && ob.note);
const rt = V.routes[0];
for (const d of rt.days.slice(0, 3)) {
  console.log(`\n${d.date}（${d.dow}）${E[d.level] || d.level} ${d.headline || ''}`);
  (d.segments || []).forEach(s => {
    console.log(`   ${s.past ? '已过' : (E[s.level] || s.level)} ${s.name} ${s.time}`);
    if (!s.past) s.reasons.filter(r => /雪带|实况/.test(r.text) || process.env.FULL).forEach(r => console.log('       -', E[r.level] || r.level, r.rule || '', r.text.slice(0, 260)));
  });
}
