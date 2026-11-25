// v4 规则的几处定点检查：在当天的实时数据上改动个别输入，看等级是否按规则变化
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
const day = (V, rid, k) => V.routes.find(r => r.id === rid).days[k];
const today = HKR.dateStr(now), tomorrow = HKR.dateStr(now + 24 * H);

console.log('0. 原样数据能算完，没有 ⬛');
{ const V = HKR.buildView(load(), now); ok(V.routes.every(r => r.days.every(d => d.level !== 'black')), '今天的实际数据没有交通瘫痪'); }

console.log('1. 大雪特别警报（36）：机场线判 ⬛，一日游的旭川—美瑛段只到 🔴');
{
  const RAW = load();
  RAW.warn016.data.areas['0110000'] = [{ code: '36', status: '発表', rd: now - H }];
  RAW.warn012.data.areas['0120400'] = [{ code: '36', status: '発表', rd: now - H }];
  const V = HKR.buildView(RAW, now);
  const g = day(V, 'B', 0).grid;
  ok(g.cells[1].some(c => c.level === 'black'), '道央道段有 ⬛');
  const segA = day(V, 'A', 0).segments.find(s => s.id === 'S2');
  ok(segA.level === 'red', '旭川—美瑛—白金段是 🔴（不给 ⬛）：' + segA.level);
  ok(V.routes.find(r => r.id === 'B').days[0].headline.includes('交通瘫痪'), '结论写“交通瘫痪”');
}

console.log('2. 危险度时间序列：14 m/s 加 6 小时 3 cm 判红，12 m/s 只判橙');
for (const [w, want] of [[15, 'red'], [12, 'orange']]) {
  const RAW = load();
  const tl = RAW.tl016.data, A = tl.areas['0120300'];   // 小樽
  const i = tl.blocks.findIndex(b => HKR.dateStr(b.s) === tomorrow && new Date(b.s + 9 * H).getUTCHours() === 12);
  A.wind[i] = w; A.snow6[i] = 5; A.snowSig[i] = 1; A.windSig[i] = 1;
  // 模式气温压到 0 ℃ 以下
  ['msm', 'ifs'].forEach(k => RAW[k].data.forEach(s => { if (s) s.T = s.T.map((t, j) => (s.t[j] >= tl.blocks[i].s && s.t[j] <= tl.blocks[i].e ? -3 : t)); }));
  const V = HKR.buildView(RAW, now);
  const c = day(V, 'B', 1).grid.cells[0][2];   // 札樽道段 12–15
  ok(c.level === want || (want === 'orange' && c.level === 'orange'), `风 ${w} m/s：札樽道 12–15 时是 ${c.level}（应为 ${want}）`);
}

console.log('3. 早期注意信息：［中］只判橙；［高］没有佐证判橙，有佐证判红');
{
  for (const [v, evid, want] of [['中', false, 'orange'], ['高', false, 'orange'], ['高', true, 'red']]) {
    const RAW = load();
    const P = RAW.prob016.data;
    P.periods.filter(p => p.code === '016010' && HKR.dateStr(p.s) === tomorrow).forEach(p => { p.snow = v; });
    if (!evid) {   // 去掉本段所有橙级证据：模式改成无风无雪，时间序列清零，预报文字改成晴
      ['msm', 'ifs'].forEach(k => RAW[k].data.forEach(s => { if (s) { s.W = s.W.map(() => 2); s.P = s.P.map(() => 0); s.S = s.S.map(() => 0); s.R = s.R.map(() => 0); s.T = s.T.map(() => -2); } }));
      Object.values(RAW.tl016.data.areas).forEach(A => { ['wind', 'snow6', 'snow6max', 'windSig', 'snowSig', 'accSig'].forEach(k => { if (A[k]) A[k] = A[k].map(() => 0); }); });
      Object.values(RAW.fc016.data.short).forEach(a => Object.values(a.days).forEach(d => { d.weather = '晴れ'; d.wind = '西の風'; d.wcode = 100; }));
      ['vp016010', 'vp016030'].forEach(k => RAW[k].data.blocks.forEach(b => { b.weather = '晴れ'; b.lo = 3; b.hi = 5; }));
    } else {
      const A = RAW.tl016.data.areas['0110000'], tl = RAW.tl016.data;
      tl.blocks.forEach((b, i) => { if (HKR.dateStr(b.s) === tomorrow) { A.snowSig[i] = 2; } });
    }
    const V = HKR.buildView(RAW, now);
    const c = day(V, 'B', 1).grid.cells[1];
    const lv = c.reduce((a, x) => (['green', 'gray', 'orange', 'red', 'black'].indexOf(x.level) > ['green', 'gray', 'orange', 'red', 'black'].indexOf(a) ? x.level : a), 'green');
    ok(lv === want, `［${v}］${evid ? '有' : '没有'}佐证：道央道段明天最高 ${lv}（应为 ${want}）`);
  }
}

console.log('4. 第 4 天起最多判橙');
{
  const RAW = load();
  const d4 = HKR.dateStr(now + 4 * 24 * H);
  RAW.ifs.data.forEach(s => { if (!s) return; s.t.forEach((t, j) => { if (HKR.dateStr(t) === d4) { s.P[j] = 4; s.T[j] = -4; s.S[j] = 3; s.W[j] = 12; } }); });
  const V = HKR.buildView(RAW, now);
  const d = day(V, 'B', 4);
  ok(d.level === 'orange', `第 5 天（${d4}）机场线是 ${d.level}`);
  ok(d.reasons.some(r => /第 4 天起最多判橙|只有一个模式/.test(r.text)), '依据里写明为什么只判橙');
}

console.log('5. 推定视程：不到 200 m 但气象厅没有信号只判橙');
{
  const RAW = load();
  const tl = RAW.tl016.data;
  Object.values(tl.areas).forEach(A => { ['windSig', 'snowSig'].forEach(k => { if (A[k]) A[k] = A[k].map(() => 1); }); ['wind', 'snow6'].forEach(k => { if (A[k]) A[k] = A[k].map(() => 0); }); });
  RAW.prob016.data.periods.forEach(p => { p.snow = ''; p.wind = ''; });
  RAW.msm.data.forEach((s, pi) => { if (!s) return; s.t.forEach((t, j) => { if (HKR.dateStr(t) === tomorrow) { s.W[j] = 15; s.P[j] = 2; s.T[j] = -5; s.S[j] = 2; s.R[j] = 0; } }); s.fresh = null; });
  Object.values(RAW.fc016.data.short).forEach(a => Object.values(a.days).forEach(d => { d.weather = 'くもり'; d.wind = '西の風'; d.wcode = 200; }));
  ['vp016010', 'vp016030'].forEach(k => RAW[k].data.blocks.forEach(b => { b.weather = 'くもり'; b.lo = 3; b.hi = 5; }));
  const V = HKR.buildView(RAW, now);
  const c = day(V, 'B', 1).grid.cells[1][2];
  ok(c.level === 'orange', `道央道段明天 12–15 时是 ${c.level}`);
  ok(c.reasons.some(r => /气象厅没有本段、本时段的对应信号/.test(r.text)), '依据写明“气象厅没有对应信号”');
  console.log('     视程（15 m/s，每小时 2 mm，−5 ℃，有新雪）＝', Math.round(HKR.visOf(15, 2, -5, true)), 'm');
}
console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
