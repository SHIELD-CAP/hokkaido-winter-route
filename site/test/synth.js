// 离线冒烟测试：用合成数据跑一遍 buildView，检查不报错、等级符合预期
global.HKR_NO_AUTOSTART = true;
const HKR = require('../src/engine.js');
const H = 3600e3;
const now = Date.parse('2026-11-23T01:30:00+09:00');
const d = (s) => Date.parse(s);
const iso = (ms) => new Date(ms + 9 * H).toISOString().slice(0, 19) + '+09:00';

function probJson(office, subs, hot) {
  const t0 = d('2026-11-22T18:00:00+09:00');
  const defs = [[0, 6], [6, 6], [12, 6], [18, 6], [24, 6], [30, 12], [42, 12]].map(([o, h]) => ({ dateTime: iso(t0 + o * H), duration: `PT${h}H` }));
  return [
    { reportDatetime: '2026-11-22T17:00:00+09:00', timeSeries: [{ timeDefines: defs.map(x => x.dateTime), timeDefineArray: defs,
      areas: subs.map(c => ({ code: c, text: 'x', properties: [
        { type: '雪の警報級の可能性', probabilities: defs.map(() => '') },
        { type: '風（風雪）の警報級の可能性', probabilities: defs.map((_, i) => (hot[c] && hot[c].includes(i) ? '中' : '')) }] })) }] },
    { reportDatetime: '2026-11-22T17:00:00+09:00', timeSeries: [{ timeDefines: ['24', '25', '26', '27'].map(x => `2026-11-${x}T00:00:00+09:00`),
      timeDefineArray: ['24', '25', '26', '27'].map(x => ({ dateTime: `2026-11-${x}T00:00:00+09:00`, duration: 'P1D' })),
      areas: [{ code: office, properties: [{ type: '雪の警報級の可能性', probabilities: ['', '', office === '012000' ? '中' : '', ''] }, { type: '風（風雪）の警報級の可能性', probabilities: ['中', '', '', ''] }] }] }] }
  ];
}
function warnJson() {
  return [{ reportDatetime: '2026-11-23T01:00:00+09:00', dataTypeCode: 'VPWW58', warning: { class10Items: [], class20Items: [
    { areaCode: '0122500', kinds: [{ code: '13', status: '発表' }] }, { areaCode: '0110000', kinds: [{ status: '発表警報・注意報はなし' }] }] } },
  { reportDatetime: '2026-11-21T01:00:00+09:00', dataTypeCode: 'VPWW60', warning: { class10Items: [], class20Items: [{ areaCode: '0122500', kinds: [{ code: '12', status: '解除' }] }] } }];
}
function noWarnJson() {
  return [{ reportDatetime: '2026-11-22T09:27:00+09:00', dataTypeCode: 'VPWW61', warning: { class10Items: [{ areaCode: '012010', kinds: [{ status: '発表警報・注意報はなし' }] }], class20Items: [{ areaCode: '0120400', kinds: [{ status: '発表警報・注意報はなし' }] }] } }];
}
function fcJson(office, subs) {
  const dates = ['2026-11-22T17:00:00+09:00', '2026-11-23T00:00:00+09:00', '2026-11-24T00:00:00+09:00'];
  return [
    { reportDatetime: '2026-11-22T17:00:00+09:00', timeSeries: [{ timeDefines: dates, areas: subs.map(c => ({ area: { code: c, name: c }, weatherCodes: ['211', '212', '315'],
      weathers: ['くもり　夜　晴れ　所により　雪', '晴れ　後　くもり　夜　雨　所により　夕方　から　雷　を伴う', '雨　後　雪　で　ふぶく'],
      winds: ['西の風　後　南の風　海上　では　西の風　やや強く', '南の風', '南の風　やや強く　後　北西の風　やや強く'] })) }] },
    { reportDatetime: '2026-11-22T17:00:00+09:00', timeSeries: [
      { timeDefines: ['23', '24', '25', '26', '27', '28', '29'].map(x => `2026-11-${x}T00:00:00+09:00`), areas: [{ area: { code: office, name: office }, weatherCodes: ['212', '315', '205', '260', '206', '206', '260'], pops: ['', '90', '80', '60', '50', '60', '50'], reliabilities: ['', '', 'A', 'B', 'C', 'B', 'C'] }] },
      { timeDefines: ['23', '24', '25', '26', '27', '28', '29'].map(x => `2026-11-${x}T00:00:00+09:00`), areas: [{ area: { code: '14163', name: '札幌' }, tempsMin: ['', '-2', '-4', '-1', '2', '2', '0'], tempsMax: ['', '9', '1', '8', '12', '13', '5'] }] }] }
  ];
}
function tlJson(munis, classes10) {
  const t0 = d('2026-11-23T00:00:00+09:00');
  const defs = Array.from({ length: 8 }, (_, i) => ({ dateTime: iso(t0 + i * 3 * H), duration: 'PT3H' }));
  const kinds = (hot) => [
    { status: '発表', forecastParts: [{ type: '最大風速', locals: [{ areaName: '陸上', values: defs.map((_, i) => ({ value: String(hot && i >= 5 ? 11 : 5), unit: 'm/s' })) }, { areaName: '海上', values: defs.map(() => ({ value: '15', unit: 'm/s' })) }] }] },
    { status: '発表', forecastParts: [{ type: '６時間最大降雪量', locals: [{ values: defs.map((_, i) => ({ value: String(hot && i >= 5 ? 2 : 0), unit: 'cm' })) }] }] },
    { status: '発表', significancyParts: [{ type: '風危険度', locals: [{ areaName: '陸上', codes: defs.map((_, i) => (hot && i >= 6 ? '20' : '01')) }, { areaName: '海上', codes: defs.map(() => '20') }] }] },
    { status: '発表', significancyParts: [{ type: '雪危険度', locals: [{ codes: defs.map(() => '01') }] }] }
  ];
  return { reportDatetime: '2026-11-22T23:00:00+09:00', timeSeries: [
    { timeDefines: defs, class10Items: classes10.map(c => ({ areaCode: c, kinds: kinds(false) })), class20Items: munis.map(m => ({ areaCode: m, kinds: kinds(m === '0110000') })) },
    { timeDefines: [{ dateTime: iso(t0), duration: 'PT24H' }, { dateTime: iso(t0), duration: 'PT24H' }], class10Items: [], class20Items: [] },
    { timeDefines: [{ dateTime: iso(t0), duration: 'PT24H' }, { dateTime: iso(t0 + 24 * H), duration: 'PT24H' }], class10Items: [], class20Items: munis.map(m => ({ areaCode: m, kinds: [{ status: '発表', significancyParts: [{ type: 'なだれ危険度', locals: [{ codes: ['01', m === '0121600' ? '20' : '01'] }] }] }] })) }
  ] };
}
function omJson(days, horizonH) {
  const start = d('2026-11-21T00:00:00+09:00');
  const n = (2 + days) * 24;
  return HKR.PTS.map((p, pi) => {
    const time = [], T = [], P = [], R = [], S = [], W = [], G = [], D = [];
    for (let i = 0; i < n; i++) {
      const t = start + i * H; const s = new Date(t + 9 * H).toISOString().slice(0, 16); time.push(s);
      const hrs = (t - now) / H;
      const beyond = horizonH && hrs > horizonH;
      // 24 日 12 时起风雪（全点），23 日晚雨
      const day = s.slice(0, 10), hh = +s.slice(11, 13);
      let w = 4, sn = 0, rn = 0, tt = -1;
      if (day === '2026-11-23' && hh >= 18) { rn = 1.5; tt = 2; }
      if (day === '2026-11-24' && hh < 10) { rn = 1; tt = 1; }
      if (day === '2026-11-24' && hh >= 12) { w = 11 + (pi % 3); sn = 0.8; tt = -4; }
      if (day === '2026-11-25') { w = 8; sn = 0.3; tt = -5; }
      T.push(beyond ? null : tt); P.push(beyond ? null : rn + sn); R.push(beyond ? null : rn); S.push(beyond ? null : sn); W.push(beyond ? null : w); G.push(null); D.push(beyond ? null : 300);
    }
    return { latitude: p.lat, longitude: p.lon, elevation: 50, hourly: { time, temperature_2m: T, precipitation: P, rain: R, snowfall: S, wind_speed_10m: W, wind_gusts_10m: G, wind_direction_10m: D } };
  });
}
function ensJson() {
  const start = d('2026-11-23T00:00:00+09:00');
  return [0, 1, 2].map(pi => {
    const time = []; for (let i = 0; i < 32; i++) time.push(new Date(start + i * 6 * H + 9 * H).toISOString().slice(0, 16));
    const hourly = { time };
    for (let m = 0; m <= 50; m++) {
      const sfx = m === 0 ? '' : '_member' + String(m).padStart(2, '0');
      hourly['wind_speed_10m' + sfx] = time.map(s => (s.startsWith('2026-11-27') && m < (pi === 0 ? 20 : 8) ? 12 : 5));
      hourly['snowfall' + sfx] = time.map(s => (s.startsWith('2026-11-27') ? 0.5 : 0));
    }
    return { hourly };
  });
}

function rawAll(opts = {}) {
  const ok = (data) => ({ ok: true, data });
  const R = {
    prob016: ok(HKR.parseProb(probJson('016000', ['016010', '016020', '016030'], { '016010': [6] }))),
    prob012: ok(HKR.parseProb(probJson('012000', ['012010', '012020'], {}))),
    warn016: ok(HKR.parseWarn(warnJson())), warn012: ok(HKR.parseWarn(noWarnJson())),
    fc016: ok(HKR.parseForecast(fcJson('016000', ['016010', '016020', '016030']))),
    fc012: ok(HKR.parseForecast(fcJson('012000', ['012010', '012020']))),
    tl016: ok(HKR.parseTimeline(tlJson(['0110000', '0121000', '0122500', '0120300', '0121600'], ['016010', '016020', '016030']))),
    tl012: ok(HKR.parseTimeline(tlJson(['0120400', '0145900'], ['012010']))),
    info: ok(HKR.filterInfo([{ editorialOffice: '札幌管区気象台', headTitle: '石狩・空知・後志地方気象解説情報（大雪・風雪）', reportDatetime: '2026-11-22T16:30:00+09:00', serial: '1', eventId: 'E1', areaType: 'offices', areaCode: '016000', infoType: '発表', jsonName: '20261122073000_0_VPFJ51_016000' }])),
    bul_20261122073000_0_VPFJ51_016000: ok(HKR.parseBulletin({ reportDatetime: '2026-11-22T16:30:00+09:00', headlineText: '石狩・空知・後志地方では、２４日昼過ぎから２５日朝にかけて大雪やふぶきによる交通障害に警戒してください。また、２３日夕方から夜遅くにかけて強風に注意してください。', headlineInfo: [{ areas: [{ area: [{ code: '016010' }, { code: '016020' }, { code: '016030' }] }] }] })),
    msm: ok(HKR.compactOM(omJson(4, 78))), ifs: ok(HKR.compactOM(omJson(8))),
    ens: ok(HKR.compactEns(ensJson())),
    meta_msm: ok({ init: now - 4 * H }), meta_ifs: ok({ init: now - 9 * H })
  };
  for (const k of opts.fail || []) R[k] = { ok: false, err: 'HTTP 500（测试）' };
  return R;
}

function summary(view) {
  const out = [];
  for (const r of view.routes) {
    out.push(`== ${r.short}`);
    for (const day of r.days) {
      let seg = '';
      const L = { red: 'R', orange: 'o', green: 'G', gray: '·' };
      if (day.segments) seg = day.segments.map(s => s.id + ':' + (s.past ? '-' : L[s.level])).join(' ');
      if (day.grid) seg = day.grid.cells.map(row => row.map(c => c.past ? '-' : L[c.level]).join('')).join('/');
      out.push(`${day.date} ${(day.past ? 'past' : day.level).padEnd(6)} ${seg} | ${day.headline}${day.missing.length ? ' [缺:' + day.missing.join(',') + ']' : ''}${day.notes && day.notes.length ? ' {注:' + day.notes.length + '}' : ''}`);
    }
  }
  return out.join('\n');
}

if (require.main !== module) {
  module.exports = { probJson, warnJson, noWarnJson, fcJson, tlJson, omJson, ensJson, now };
  return;
}
let v = HKR.buildView(rawAll(), now);
console.log(summary(v));
console.log('\nBANNERS', JSON.stringify(v.banners, null, 0));
console.log('\nA 24日 reasons:'); v.routes[0].days[1].reasons.forEach(r => console.log(' ', r.level, r.text, '｜', r.src));
console.log('\nA 23日 S3 reasons:'); v.routes[0].days[0].segments[2].reasons.forEach(r => console.log(' ', r.level, r.text));
console.log('\nA 24日 jma:', JSON.stringify(v.routes[0].days[1].jma, null, 0).slice(0, 1500));
console.log('\nB 27日 cells B2 15-18 reasons:'); v.routes[1].days[4].grid.cells[1][3].reasons.forEach(r => console.log(' ', r.level, r.text));
console.log('\nsources:'); v.sources.forEach(s => console.log(' ', s.status, s.name, s.reportTime, s.note));
// 缺数据
v = HKR.buildView(rawAll({ fail: ['prob012', 'ifs', 'ens'] }), now);
console.log('\n--- 缺 prob012、ifs、ens ---\n' + summary(v));
// 过了 20 点
v = HKR.buildView(rawAll(), Date.parse('2026-11-23T20:30:00+09:00'));
console.log('\n--- 20:30 ---\n' + summary(v).split('\n').slice(0, 3).join('\n'));
console.log('\nzh tests:');
['くもり　夜　晴れ　所により　雪', '晴れ　後　くもり　夜　雨　所により　夕方　から　雷　を伴う', '雨　後　雪　で　ふぶく', '雪　で　昼過ぎ　から　ふぶく', '雪　夜　は　大雪　の　所　あり', 'くもり　夜　雨か雪', 'くもり　夕方　から　雨　所により　雷　を伴う'].forEach(t => console.log(' ', t, '→', HKR.zhForecast(t)));
['西の風　後　南の風　海上　では　西の風　やや強く', '南の風　海上　では　後　南の風　強く', '南の風　やや強く　後　北西の風　やや強く', '北の風　強く', '西の風　後　強く'].forEach(t => console.log(' ', t, '→', HKR.zhForecast(t, true)));
