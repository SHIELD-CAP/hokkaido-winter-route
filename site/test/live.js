// 用 /tmp/live 里存下的实时数据跑一遍判定，打印各天、各段的等级和主要依据
// 用法：node test/live.js [当前时刻，ISO 格式，默认用现在]
global.HKR_NO_AUTOSTART = true;
const fs = require('fs');
const HKR = require('../src/engine.js');
const L = '/tmp/live/';
const now = process.argv[2] ? Date.parse(process.argv[2]) : Date.now();
const RAW = {};
for (const [key, url, tf] of HKR.JOBS) {
  try {
    const j = JSON.parse(fs.readFileSync(L + 'raw_' + key + '.json', 'utf8'));
    RAW[key] = { ok: true, data: tf ? tf(j) : j, fetchedAt: now };
  } catch (e) { RAW[key] = { ok: false, err: e.message }; }
}
if (RAW.info.ok) {
  for (const b of HKR.activeBulletins(RAW.info.data, now)) {
    if (!b.jsonName) continue;
    try { RAW['bul_' + b.jsonName] = { ok: true, data: HKR.parseBulletin(JSON.parse(fs.readFileSync(L + 'bul_' + b.jsonName + '.json', 'utf8'))), fetchedAt: now }; }
    catch (e) { RAW['bul_' + b.jsonName] = { ok: false, err: e.message }; }
  }
}
const V = HKR.buildView(RAW, now);
const bad = Object.entries(RAW).filter(([k, r]) => !r.ok).map(([k, r]) => k + ': ' + r.err);
if (bad.length) console.log('取数失败：', bad);
console.log('规则', V.meta.rulesVersion, '|', V.meta.freshness);
V.banners.forEach(b => console.log('[横幅', b.level + ']', b.text.slice(0, 160)));
const E = { black: '⬛', red: '🔴', orange: '🟠', green: '🟢', gray: '⚪' };
for (const rt of V.routes) {
  console.log('\n=====', rt.name);
  for (const d of rt.days) {
    console.log(`\n${d.date}（${d.dow}）${E[d.level] || d.level} ${d.headline || ''}`);
    if (d.segments) d.segments.forEach(s => console.log(`   ${s.past ? '已过' : (E[s.level] || s.level)} ${s.name} ${s.time}：${s.past ? '' : (s.reasons[0] ? s.reasons[0].text.slice(0, 150) : '')}`));
    if (d.grid) d.grid.rows.forEach((r, ri) => console.log(`   ${r.name}：` + d.grid.cells[ri].map((c, ci) => (c.past ? '·' : E[c.level])).join(' ')));
    if (process.env.FULL) d.reasons.forEach(r => console.log('     -', E[r.level], r.text.slice(0, 220)));
  }
}
