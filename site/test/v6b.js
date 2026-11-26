// 2026-11-26 修订的定点检查：雪带时间窗、结冰第二款的雨量和融雪下限、实况优先
// 用 /tmp/live/ 里 2026-11-25 12:30 存下的实时数据，改动个别输入，看等级是否按规则变化
global.HKR_NO_AUTOSTART = true;
const fs = require('fs');
const HKR = require('../src/engine.js');
const L = '/tmp/live/';
const now = Date.parse(process.argv[2] || '2026-11-25T12:30:00+09:00');
const H = 3600e3;
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
function load() {
  const RAW = {};
  for (const [key, url, tf] of HKR.JOBS) {
    try { RAW[key] = { ok: true, data: tf ? tf(JSON.parse(fs.readFileSync(L + 'raw_' + key + '.json', 'utf8'))) : null, fetchedAt: now }; }
    catch (e) { RAW[key] = { ok: false, err: e.message }; }
  }
  for (const b of HKR.activeBulletins(RAW.info.data, now)) if (b.jsonName) {
    try { RAW['bul_' + b.jsonName] = { ok: true, data: HKR.parseBulletin(JSON.parse(fs.readFileSync(L + 'bul_' + b.jsonName + '.json', 'utf8'))), fetchedAt: now }; } catch (e) { /* 没存的跳过 */ }
  }
  return RAW;
}
const idx = id => HKR.PTS.findIndex(p => p.id === id);
const today = HKR.dateStr(now), tomorrow = HKR.dateStr(now + 24 * H);
const at = (ds, h) => HKR.msAt(ds, h);
const dayOf = (V, rid, k) => V.routes.find(r => r.id === rid).days[k];
// 把某些格点改成“干、暖”，再按需要加降水和降温
function calm(RAW, ids) {
  ['msm', 'ifs'].forEach(k => ids.forEach(id => { const s = RAW[k].data[idx(id)]; if (!s) return;
    s.P = s.P.map(() => 0); s.R = s.R.map(() => 0); s.S = s.S.map(() => 0); s.W = s.W.map(() => 2); s.T = s.T.map(() => 3); s.fresh = null; }));
}
function setHours(RAW, ids, a, b, f) {
  ['msm', 'ifs'].forEach(k => ids.forEach(id => { const s = RAW[k].data[idx(id)]; if (!s) return;
    s.t.forEach((t, j) => { if (t > a && t <= b) f(s, j); }); s.fresh = null; }));
}
const reasonsOf = c => (c.reasons || []).map(r => r.rule + ' ' + r.text).join(' / ');
const ALL_A = ['A1', 'A2', 'A3', 'A4', 'E1', 'E2', 'E3', 'E4', 'E5'];
const ALL_B = ['B1', 'B2', 'A1', 'B4', 'B5', 'B6'];

console.log('1. 雪带时间窗：前一天 21–24 时的雪带，第二天的去程高速要看到；回程高速不看前一天');
{
  const RAW = load();
  calm(RAW, ALL_A);
  // 今天 21–24 时岩见泽格点（存下的数据里没有 E 系列格点）每小时 3.2 mm、−2 ℃（3 小时 9.6 mm），明天去程应当判雪带
  setHours(RAW, ['A2'], at(today, 21), at(today, 24), (s, j) => { s.P[j] = 3.2; s.S[j] = 2.2; s.T[j] = -2; });
  const V = HKR.buildView(RAW, now);
  const s1 = dayOf(V, 'A', 1).segments.find(s => s.id === 'S1');
  const s4 = dayOf(V, 'A', 1).segments.find(s => s.id === 'S4');
  const hasBand = seg => (seg.reasons || []).some(r => (r.rule === 'R8' || r.rule === 'O9') && /雪带/.test(r.text));
  ok(hasBand(s1), '明天去程高速有雪带：' + s1.level + '｜' + reasonsOf(s1).slice(0, 160));
  ok((s1.reasons || []).some(r => /前一天/.test(r.text)), '依据里写明是前一天的时刻');
  ok(!hasBand(s4), '明天回程高速不受前一天晚上的雪带影响：' + s4.level);
}

console.log('2. 结冰第二款：雨 2.1 mm 不算；3.6 mm 算；2.1 mm 加当天融雪 8 cm 也算');
{
  const run = (mmPerH, melt) => {
    const RAW = load();
    calm(RAW, ALL_B);
    setHours(RAW, ['B4', 'B5', 'B6'], at(today, 12), at(today, 15), (s, j) => { s.P[j] = mmPerH; s.R[j] = mmPerH; s.T[j] = 3; });
    setHours(RAW, ['B4', 'B5', 'B6'], at(today, 21), at(tomorrow, 9), (s, j) => { s.T[j] = -1; });
    if (melt) {
      const latest = now - 20 * 60e3;
      RAW.obs = { ok: true, data: { latest, st: { '14163': { [latest]: { T: 3, p3: 0, s1: 0, vis: null } } },
        map: { time: latest, now: { '14206': { name: '惠庭岛松', T: 5, p1: 0, wind: 2, sd: 4 } }, d0: { '14206': { name: '惠庭岛松', T: -1, p1: 0, wind: 1, sd: 12 } } } }, fetchedAt: now };
    }
    const V = HKR.buildView(RAW, now);
    const c = dayOf(V, 'B', 0).grid.cells[1][5];   // 道央道段 21–24 时
    return c;
  };
  const c1 = run(0.7, false), c2 = run(1.2, false), c3 = run(0.7, true);
  const o3 = c => (c.reasons || []).some(r => r.rule === 'O3');
  ok(!o3(c1), '2.1 mm、没有融雪：不判结冰（' + c1.level + '）');
  ok(o3(c2), '3.6 mm：判结冰（' + c2.level + '）｜' + reasonsOf(c2).slice(0, 120));
  ok(o3(c3) && (c3.reasons || []).some(r => /积雪化掉 8 cm/.test(r.text)), '2.1 mm 加当天融雪 8 cm：判结冰，依据写融雪｜' + reasonsOf(c3).slice(0, 140));
}

console.log('3. 实况优先：机场线札樽道段今天 12–15 时，着雪注意报在、实况是雨、模式不转雪 → 不计等级；实况在下雪 → 照常');
{
  const run = (Tnow, p1) => {
    const RAW = load();
    calm(RAW, ALL_B);
    RAW.warn016.data.areas['0120300'] = [{ code: '26', status: '発表', rd: now - 2 * H }];
    const latest = now - 20 * 60e3;
    const st = n => ({ name: n, T: Tnow, p1, wind: 3, sd: 0 });
    RAW.obs = { ok: true, data: { latest, st: { '14163': { [latest]: { T: Tnow, p3: 0, s1: 0, vis: null } } },
      map: { time: latest, now: { '16091': st('小樽'), '14163': st('札幌') }, d0: {} } }, fetchedAt: now };
    const V = HKR.buildView(RAW, now);
    return { c: dayOf(V, 'B', 0).grid.cells[0][2], notes: (dayOf(V, 'B', 0).notes || []).map(n => (typeof n === 'string' ? n : n.text || '')).join(' / ') };
  };
  const warm = run(3.5, 1.5), snow = run(0.0, 1.5);
  const accr = c => (c.reasons || []).some(r => /着雪注意报/.test(r.text));
  ok(!accr(warm.c) && /实况优先/.test(warm.notes), '3.5 ℃ 的雨：着雪注意报不计等级，写进提醒（' + warm.c.level + '）');
  ok(accr(snow.c), '0 ℃（不是 1 ℃ 以上的雨）：着雪注意报照常计（' + snow.c.level + '）');
}

console.log('4. 机场线道央道段的雪带（2026-11-27 加）：北广岛格点 3 小时 8.4 mm 判雪带；4.5–7 mm 之间不判；札樽道段不判雪带');
{
  const run = mmPerH => {
    const RAW = load();
    calm(RAW, ALL_B);
    // 明天 12–15 时北广岛格点每小时 mmPerH、−2 ℃
    setHours(RAW, ['B4'], at(tomorrow, 12), at(tomorrow, 15), (s, j) => { s.P[j] = mmPerH; s.S[j] = mmPerH * 0.7; s.T[j] = -2; });
    const V = HKR.buildView(RAW, now);
    const g = dayOf(V, 'B', 1).grid.cells;
    return { b2: g[1][2], b1: g[0][2], b2next: g[1][3] };
  };
  const band = c => (c.reasons || []).filter(r => (r.rule === 'R8' || r.rule === 'O9') && /雪带/.test(r.text));
  const a = run(2.8), b = run(1.8);
  ok(band(a.b2).length > 0, '道央道段 12–15 时 3 小时 8.4 mm：有雪带（' + a.b2.level + '）｜' + band(a.b2).map(r => r.rule + ' ' + r.text).join(' / ').slice(0, 200));
  ok(band(a.b2next).length > 0, '15–18 时（之前 6 小时里有雪带）也有雪带（' + a.b2next.level + '）');
  ok(band(a.b1).length === 0, '札樽道段不判雪带（' + a.b1.level + '）');
  ok(band(b.b2).length === 0, '3 小时 5.4 mm：机场线不用 4.5／6 mm 的预警（' + b.b2.level + '）');
}

console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
