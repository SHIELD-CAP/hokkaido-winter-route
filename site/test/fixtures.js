// 生成本地页面测试用的接口回应：key 是 URL 里能唯一识别的片段
global.HKR_NO_AUTOSTART = true;
const S = require('./synth.js');
const H = 3600e3;
const amedasMap = {};
[['14163', -1.2, 3.1, 0, 0], ['15356', -2.0, 2.4, 6, 1], ['15241', -3.1, 4.0, 12, 2], ['12442', -4.0, 1.5, 9, 0], ['16091', 0.8, 5.2, 0, 0]]
  .forEach(([id, t, w, d, s24]) => { amedasMap[id] = { temp: [t, 0], wind: [w, 0], snow: [d, 0], snow24h: [s24, 0] }; });
const out = {
  'probability/r8/016000': S.probJson('016000', ['016010', '016020', '016030'], { '016010': [6] }),
  'probability/r8/012000': S.probJson('012000', ['012010', '012020'], {}),
  'warning/data/r8/016000': S.warnJson(),
  'warning/data/r8/012000': S.noWarnJson(),
  'forecast/016000': S.fcJson('016000', ['016010', '016020', '016030']),
  'forecast/012000': S.fcJson('012000', ['012010', '012020']),
  'warning_timeline/data/016000': S.tlJson(['0110000', '0121000', '0122500', '0120300', '0121600'], ['016010', '016020', '016030']),
  'warning_timeline/data/012000': S.tlJson(['0120400', '0145900'], ['012010']),
  'information.json': [{ editorialOffice: '札幌管区気象台', headTitle: '石狩・空知・後志地方気象解説情報（大雪・風雪）', reportDatetime: '2026-11-22T16:30:00+09:00', serial: '1', eventId: 'E1', areaType: 'offices', areaCode: '016000', infoType: '発表', jsonName: '20261122073000_0_VPFJ51_016000' }],
  'denbun/20261122073000_0_VPFJ51_016000': { reportDatetime: '2026-11-22T16:30:00+09:00', headlineText: '石狩・空知・後志地方では、２４日昼過ぎから２５日朝にかけて大雪やふぶきによる交通障害に警戒してください。また、２３日夕方から夜遅くにかけて強風に注意してください。', headlineInfo: [{ areas: [{ area: [{ code: '016010' }, { code: '016020' }, { code: '016030' }] }] }] },
  'models=jma_msm': S.omJson(4, 78),
  'models=ecmwf_ifs&': S.omJson(8),
  'ensemble': S.ensJson(),
  'jma_msm/static/meta': { last_run_initialisation_time: (S.now - 4 * H) / 1000 },
  'ecmwf_ifs/static/meta': { last_run_initialisation_time: (S.now - 9 * H) / 1000 },
  'latest_time.txt': '2026-11-23T01:30:00+09:00',
  'amedas/data/map/': amedasMap
};
process.stdout.write(JSON.stringify(out));
