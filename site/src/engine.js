/* =====================================================================
 * 北海道冬季路线出行参考 · 取数与判定层
 * 只做三件事：从气象厅、Open-Meteo 取公开数据；按固定规则给每条路线、
 * 每天、每段（格）定等级；拼成界面层要的 VIEW 交给 window.renderApp。
 * 本文件不画界面。纯函数挂在 HKR 上，方便离线测试。
 * ===================================================================== */
(function (root) {
'use strict';

const BUILD = '__BUILD__';        // build.py 换成仓库提交号的前 7 位；直接用源码（存档脚本）时保持原样
const RULES_VERSION = 'v6.1 · 2026-11-28 晚修订' + (/^__/.test(BUILD) ? '' : ' · 代码 ' + BUILD);
const JMA = 'https://www.jma.go.jp/bosai/';
const OM = 'https://api.open-meteo.com/v1/forecast';
const OME = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const H = 3600e3, DAY = 24 * H, JST = 9 * H;
const NDAYS = 8;                 // 今天 + 之后 7 天
const CACHE_TTL = 15 * 60e3;     // 同一会话 15 分钟内不重复取
const CACHE_PREFIX = 'hkr6:';   // 改了解析方式就换前缀，旧版本缓存的数据不再使用

/* ---------------- 时间（一律按日本时间） ---------------- */
const pad = n => String(n).padStart(2, '0');
function jp(ms) { const d = new Date(ms + JST); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() }; }
function dateStr(ms) { const p = jp(ms); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
function msAt(ds, hour) { const [y, m, d] = ds.split('-').map(Number); return Date.UTC(y, m - 1, d, hour || 0) - JST; }
function addDays(ds, n) { return dateStr(msAt(ds, 12) + n * DAY); }
function omMs(s) { return Date.parse(s.length === 16 ? s + ':00+09:00' : s); }       // Open-Meteo 本地时间串
function fmtMD(ms) { const p = jp(ms); return `${p.m}/${p.d} ${pad(p.h)}:${pad(p.mi)}`; }
function fmtHM(ms) { const p = jp(ms); return `${pad(p.h)}:${pad(p.mi)}`; }
function dayNum(ds) { return Number(ds.slice(8, 10)); }
const DOW = ['日', '一', '二', '三', '四', '五', '六'];
function durH(s) { if (!s) return null; let m = /^PT(\d+)H$/.exec(s); if (m) return +m[1]; m = /^P(\d+)D$/.exec(s); if (m) return 24 * m[1]; return null; }
function periodLabel(s, e) {           // 例：24日12–24时；跨天：23日18时–24日06时
  const a = jp(s), b = jp(e - 1);
  const eh = jp(e).h === 0 ? 24 : jp(e).h;
  if (a.d === b.d) return `${a.d}日${pad(a.h)}–${pad(eh)}时`;
  return `${a.d}日${pad(a.h)}时–${b.d}日${pad(eh)}时`;
}

function blocksLabel(blocks) {   // 相连的 3 小时格合成一段
  const bs = blocks.slice().sort((x, y) => x.s - y.s), parts = [];
  bs.forEach(b => { const last = parts[parts.length - 1]; if (last && last.e === b.s) last.e = b.e; else parts.push({ s: b.s, e: b.e }); });
  return parts.map(p => periodLabel(p.s, p.e)).join('、');
}
function hourLabel(t, ds) { const p = jp(t); return dateStr(t) === ds ? p.h : (p.h === 0 ? 24 : p.h + 24); }

/* ---------------- 地名、代码 ---------------- */
const SUB = {
  '016010': '石狩地区', '016020': '空知地区', '016030': '后志地区',
  '012010': '上川地区', '012020': '留萌地区'
};
const OFFICE = { '016000': '石狩、空知、后志预报区', '012000': '上川、留萌预报区' };
const officeOf = sub => sub.slice(0, 3) + '000';
// 市町村代码 → [中文名, 预报区, 气象厅二次细分区域名]（二次细分按气象厅 bosai/common/const/area.json 的 class15s，2026-11-23 核对）
const MUNI = {
  '0110000': ['札幌', '016000', '石狩中部'], '0121700': ['江别', '016000', '石狩中部'], '0121000': ['岩见泽', '016000', '南空知'],
  '0121500': ['美呗', '016000', '南空知'], '0142400': ['奈井江', '016000', '中空知'], '0122600': ['砂川', '016000', '中空知'],
  '0122500': ['泷川', '016000', '中空知'], '0122800': ['深川', '016000', '北空知'], '0121600': ['芦别', '016000', '中空知'],
  '0122200': ['三笠', '016000', '南空知'], '0120300': ['小樽', '016000', '後志北部'], '0123400': ['北广岛', '016000', '石狩南部'],
  '0123100': ['惠庭', '016000', '石狩南部'], '0122400': ['千岁', '016000', '石狩南部'],
  '0120400': ['旭川', '012000', '上川中部'], '0145800': ['东川', '012000', '上川中部'], '0145900': ['美瑛', '012000', '上川中部'],
  '0146000': ['上富良野', '012000', '上川南部'], '0122900': ['富良野', '012000', '上川南部'], '0145200': ['鹰栖', '012000', '上川中部'],
  '0145300': ['东神乐', '012000', '上川中部'], '0146100': ['中富良野', '012000', '上川南部']
};
const WARN_NAME = {
  '02': '暴风雪警报', '03': '大雨警报', '04': '洪水警报', '05': '暴风警报', '06': '大雪警报', '07': '波浪警报', '08': '风暴潮警报',
  '10': '大雨注意报', '12': '大雪注意报', '13': '风雪注意报', '14': '雷电注意报', '15': '强风注意报', '16': '波浪注意报',
  '17': '融雪注意报', '18': '洪水注意报', '19': '风暴潮注意报', '20': '浓雾注意报', '21': '干燥注意报', '22': '雪崩注意报',
  '23': '低温注意报', '24': '霜冻注意报', '25': '着冰注意报（船体积冰）', '26': '着雪注意报（电线、树木积雪）',
  '32': '暴风雪特别警报', '33': '大雨特别警报', '35': '暴风特别警报', '36': '大雪特别警报', '37': '波浪特别警报', '38': '风暴潮特别警报'
};
const WARN_RED = new Set(['02', '06', '32', '36']);   // 暴风雪、大雪警报及其特别警报
const WARN_WIND_ONLY = new Set(['05', '35', '15']);       // 暴风警报、暴风特别警报、强风注意报：只有风，不计等级
const WARN_ORANGE_ALL = new Set(['12', '13', '26']);   // 大雪、风雪、着雪注意报：所有路段
const WARN_ORANGE_MTN = new Set(['22']);                     // 雪崩注意报：只算山路
const INACTIVE = new Set(['解除', '発表警報・注意報はなし']);   // 没有 status 的条目按“生效”算，宁可多报

/* 数值模式取样点（顺序决定请求里的顺序） */
const PTS = [
  ['A1', '札幌', 43.06, 141.35], ['A2', '岩见泽', 43.20, 141.76], ['A3', '砂川、泷川之间', 43.53, 141.91],
  ['A4', '深川', 43.72, 142.05], ['A5', '旭山动物园', 43.77, 142.48], ['A6', '美瑛', 43.59, 142.47],
  ['A7', '白金（青池）', 43.49, 142.61], ['A8', '富良野', 43.34, 142.38], ['A9', '道道 135 号富良野隧道一带', 43.344, 142.26],
  ['A10', '国道 452 号桂泽湖山口一带', 43.295, 142.09], ['B1', '小樽', 43.19, 141.00], ['B2', '钱函', 43.14, 141.21],
  ['B4', '北广岛', 42.98, 141.56], ['B5', '惠庭', 42.88, 141.58], ['B6', '新千岁机场', 42.78, 141.69],
  // 道央道沿线加密的格点（R8 雪带用，坐标取自各 IC 收费站）
  ['E1', '江别东 IC', 43.107, 141.598], ['E2', '江别东 IC 与岩见泽 IC 之间', 43.142, 141.681], ['E3', '三笠 IC', 43.243, 141.827],
  ['E4', '美呗 IC', 43.334, 141.890], ['E5', '奈井江砂川 IC', 43.450, 141.915]
].map(([id, name, lat, lon]) => ({ id, name, lat, lon }));
const PT = Object.fromEntries(PTS.map(p => [p.id, p]));
const ENS_PTS = [['A3', 43.53, 141.91], ['B1', 43.19, 141.00], ['B6', 42.78, 141.69]];

/* 路线 */
const ROUTE_A = {
  id: 'A', short: '一日游', name: '旭山·美瑛·白金一日游', kind: 'timeline',
  desc: '08:30 札幌接人，走道央自动车道（道央道，高速公路）到旭川，游旭山动物园、美瑛、白金青池；傍晚经富良野、芦别翻山，从三笠上道央道回札幌，约 20:00 到。',
  subs: ['016010', '016020', '012010'], offRoute: ['016030', '012020'],
  segments: [
    { id: 'S1', name: '去程高速', time: '09:00–11:00', h0: 9, h1: 11, kind: 'hwy', black: true,
      places: '札幌→江别→岩见泽→三笠→美呗→砂川→泷川→深川→鹰栖→旭川（道央道）',
      pts: ['A2', 'A3', 'A4'], windPts: ['A2', 'A3', 'A4'],
      bandPts: ['A1', 'E1', 'E2', 'A2', 'E3', 'E4', 'E5', 'A3', 'A4'], bandPre: 15, obsSt: ['14163', '14136', '15356', '15321', '15241', '15161'], nowSt: ['14136', '15356', '15321', '15241', '15161'], subs: ['016010', '016020', '012010'],
      munis: ['0110000', '0121700', '0121000', '0122200', '0121500', '0142400', '0122600', '0122500', '0122800', '0145200', '0120400'] },
    { id: 'S2', name: '旭川—美瑛—白金', time: '11:00–17:00', h0: 11, h1: 17, kind: 'local',
      places: '旭山动物园→美瑛→圣诞树、千代田牧场→白须瀑布→青池',
      pts: ['A5', 'A6', 'A7'], windPts: ['A5', 'A6', 'A7'], subs: ['012010'],
      munis: ['0120400', '0145300', '0145800', '0145900'] },
    { id: 'S3', name: '回程山路（天黑）', time: '17:00–19:00', h0: 17, h1: 19, kind: 'mtn',
      places: '青池→上富良野→中富良野→富良野→道道 135 号→芦别→国道 452 号（桂泽湖）→三笠',
      pts: ['A7', 'A8', 'A9', 'A10'], windPts: ['A7', 'A9', 'A10'], subs: ['012010', '016020'],
      munis: ['0145900', '0146000', '0146100', '0122900', '0121600', '0122200'] },
    { id: 'S4', name: '回程高速', time: '19:00–20:00', h0: 19, h1: 20, kind: 'hwy', black: true,
      places: '三笠→岩见泽→江别→札幌（道央道）',
      pts: ['A2', 'A1'], windPts: ['A2', 'A1'],
      bandPts: ['E3', 'A2', 'E2', 'E1', 'A1'], bandPre: 14, obsSt: ['14163', '14136', '15356'], nowSt: ['14136', '15356', '14163'], subs: ['016020', '016010'],
      munis: ['0122200', '0121000', '0121700', '0110000'] }
  ],
  ens: { idx: 0, name: '砂川、泷川之间', segs: ['S1', 'S4'] }
};
const ROUTE_B = {
  id: 'B', short: '机场线', name: '小樽⇔札幌⇔新千岁机场', kind: 'grid',
  desc: '札樽自动车道（札樽道，小樽—札幌）和道央道（札幌—新千岁机场），两个方向都算。06–24 时按 6 个三小时时段、两段路分别判定；00–06 时不判定。',
  subs: ['016030', '016010'], offRoute: ['016020'],
  rows: [
    { id: 'B1', name: '札樽道段', places: '小樽—朝里—钱函—札幌西（沿石狩湾）', kind: 'hwy', black: true,
      pts: ['B1', 'B2'], windPts: ['B1', 'B2'], nowSt: ['16091', '14163'], subs: ['016030', '016010'], munis: ['0120300', '0110000'] },
    { id: 'B2', name: '道央道段', places: '札幌南—北广岛—惠庭—千岁—新千岁机场', kind: 'hwy', black: true,
      pts: ['A1', 'B4', 'B5', 'B6'], windPts: ['A1', 'B4', 'B5', 'B6'], nowSt: ['14163', '14206', '14296'], subs: ['016010'],
      bandPts: ['A1', 'B4', 'B5', 'B6'], bandNoOrg: true,   // 雪带（R8）：2026-11-27 按机场线回测加；时间窗是本时段和之前 6 小时，不用 4.5／6 mm 那条
      munis: ['0110000', '0123400', '0123100', '0122400'] }
  ],
  cols: [[6, 9], [9, 12], [12, 15], [15, 18], [18, 21], [21, 24]]
};
const ROUTES = [ROUTE_A, ROUTE_B];
// 每段（行）经过的二次细分区域，用来判断预报里“〇〇 では …”那一句管不管本段
// 回程山路另外认“山沿い では”“山間部 では”（山区那一句）
ROUTE_A.segments.concat(ROUTE_B.rows).forEach(sg => { sg.areas15 = [...new Set(sg.munis.map(m => MUNI[m][2]))].concat(sg.kind === 'mtn' ? ['山沿い', '山間部'] : []); });

/* ---------------- 天气电码中文（气象厅 TELOPS 118 项） ---------------- */
const TELOPS_ZH = {
  100: '晴', 101: '晴有时多云', 102: '晴，一阵雨', 103: '晴，有时有雨', 104: '晴，一阵雪', 105: '晴，有时有雪',
  106: '晴，一阵雨或雪', 107: '晴，有时有雨或雪', 108: '晴，一阵雨或雷雨', 110: '晴，之后有时多云', 111: '晴转多云',
  112: '晴，之后一阵雨', 113: '晴，之后有时有雨', 114: '晴转雨', 115: '晴，之后一阵雪', 116: '晴，之后有时有雪',
  117: '晴转雪', 118: '晴转雨或雪', 119: '晴转雨或雷雨', 120: '晴，早晚一阵雨', 121: '晴，早晨一阵雨',
  122: '晴，傍晚一阵雨', 123: '晴，山区雷雨', 124: '晴，山区有雪', 125: '晴，午后雷雨', 126: '晴，中午前后起雨',
  127: '晴，傍晚起雨', 128: '晴，夜里雨', 130: '早晨有雾，之后晴', 131: '晴，黎明有雾', 132: '晴，早晚多云',
  140: '晴，有时有雨并伴有雷', 160: '晴，一阵雪或雨', 170: '晴，有时有雪或雨', 181: '晴转雪或雨',
  200: '多云', 201: '多云有时晴', 202: '多云，一阵雨', 203: '多云，有时有雨', 204: '多云，一阵雪', 205: '多云，有时有雪',
  206: '多云，一阵雨或雪', 207: '多云，有时有雨或雪', 208: '多云，一阵雨或雷雨', 209: '雾', 210: '多云，之后有时晴',
  211: '多云转晴', 212: '多云，之后一阵雨', 213: '多云，之后有时有雨', 214: '多云转雨', 215: '多云，之后一阵雪',
  216: '多云，之后有时有雪', 217: '多云转雪', 218: '多云转雨或雪', 219: '多云转雨或雷雨', 220: '多云，早晚一阵雨',
  221: '多云，早晨一阵雨', 222: '多云，傍晚一阵雨', 223: '多云，白天有时晴', 224: '多云，中午前后起雨',
  225: '多云，傍晚起雨', 226: '多云，夜里雨', 228: '多云，中午前后起雪', 229: '多云，傍晚起雪', 230: '多云，夜里雪',
  231: '多云，海上和沿岸有雾或毛毛雨', 240: '多云，有时有雨并伴有雷', 250: '多云，有时有雪并伴有雷',
  260: '多云，一阵雪或雨', 270: '多云，有时有雪或雨', 281: '多云转雪或雨',
  300: '雨', 301: '雨，有时晴', 302: '雨，时下时停', 303: '雨，有时有雪', 304: '雨或雪', 306: '大雨',
  308: '雨并伴有暴风', 309: '雨，一阵雪', 311: '雨转晴', 313: '雨转多云', 314: '雨，之后有时有雪', 315: '雨转雪',
  316: '雨或雪，之后晴', 317: '雨或雪，之后多云', 320: '早晨雨，之后晴', 321: '早晨雨，之后多云', 322: '雨，早晚一阵雪',
  323: '雨，中午前后起转晴', 324: '雨，傍晚起转晴', 325: '雨，夜里晴', 326: '雨，傍晚起转雪', 327: '雨，夜里转雪',
  328: '雨，一阵下得很大', 329: '雨，一阵雨夹雪', 340: '雪或雨', 350: '雨并伴有雷', 361: '雪或雨，之后晴',
  371: '雪或雨，之后多云', 400: '雪', 401: '雪，有时晴', 402: '雪，时下时停', 403: '雪，有时有雨', 405: '大雪',
  406: '风雪较强', 407: '暴风雪', 409: '雪，一阵雨', 411: '雪转晴', 413: '雪转多云', 414: '雪转雨', 420: '早晨雪，之后晴',
  421: '早晨雪，之后多云', 422: '雪，中午前后起转雨', 423: '雪，傍晚起转雨', 425: '雪，一阵下得很大',
  426: '雪转雨夹雪', 427: '雪，一阵雨夹雪', 450: '雪并伴有雷'
};
const TELOPS_SNOW = c => /雪/.test(TELOPS_ZH[c] || '');
const TELOPS_RAIN_THEN_SNOW = new Set([314, 315, 326, 327]);
const TELOPS_STORM = { 405: '大雪', 406: '风雪较强', 407: '暴风雪' };

/* ---------------- 气象厅短期预报文字 → 中文参考译文 ---------------- */
const TIME_WORDS = {
  '朝晩': '早晚', '朝のうち': '早晨', '朝': '早上', '昼前': '上午', '昼頃': '中午前后', '昼過ぎ': '午后', '日中': '白天',
  '夕方': '傍晚', '夜のはじめ頃': '入夜时', '夜遅く': '深夜', '夜半': '半夜', '夜': '夜里', '未明': '凌晨', '明け方': '黎明'
};
const PLACE_WORDS = { '海上': '海上', '山沿い': '山区', '内陸': '内陆', '沿岸': '沿岸', '平地': '平地', '海岸': '海岸' };
const WORDS = {
  '晴れ': '晴', 'くもり': '多云', '雨': '雨', '雪': '雪', 'みぞれ': '雨夹雪', '霧': '雾', '霧雨': '毛毛雨', '雷': '雷',
  '雷雨': '雷雨', '大雪': '大雪', '大雨': '大雨', 'ふぶく': '有吹雪', '吹雪': '吹雪', '暴風雪': '暴风雪',
  '雨か雪': '雨或雪', '雪か雨': '雪或雨', '雨か雷雨': '雨或雷雨', '雪か雷': '雪或雷',
  '後': '转', '時々': '有时', '一時': '一阵', 'から': '起', 'まで': '为止', '激しく': '猛烈', '強く': '强', 'やや強く': '稍强',
  '非常に強く': '非常强', '猛烈に': '猛烈', '降る': '下', '降り': '下', '所により': '局地', '伴有雷': '伴有雷', '局地': '局地',
  '北の風': '北风', '北東の風': '东北风', '東の風': '东风', '南東の風': '东南风', '南の風': '南风', '南西の風': '西南风',
  '西の風': '西风', '北西の風': '西北风', '風': '风'
};
const AREA_ZH = { '後志': '后志', '日本海側': '日本海一侧', '太平洋側': '太平洋一侧', 'オホーツク海側': '鄂霍次克海一侧', '山間部': '山区', '陸上': '陆上' };
const zhArea = t => Object.keys(AREA_ZH).reduce((s, k) => s.split(k).join(AREA_ZH[k]), t);
const hasKana = s => /[぀-ヿ]/.test(s);
function zhForecast(ja, isWind) {
  if (!ja) return '';
  let s = String(ja).replace(/[　\s]+/g, ' ').trim();
  s = s.replace(/(雨|雪) か (雨|雪|雷雨|雷)/g, '$1か$2')                 // “雪 か 雨”分开写的也认
    .replace(/雷 を伴う/g, '伴有雷').replace(/暴風雪 を伴う/g, '伴有暴风雪').replace(/暴風 を伴う/g, '伴有暴风')
    .replace(/多い 所 では (\S+)/g, '局地$1').replace(/(\S+) の 所 あり/g, '局地$1')
    .replace(/(\S+) では/g, '＠$1').replace(/ は /g, ' ').replace(/ で /g, ' ， ');
  const toks = s.split(' ');
  const out = [];
  const isTime = t => !!TIME_WORDS[t];
  const PRECIP = /^(雨|雪|みぞれ|雷|雷雨|大雪|大雨|霧|霧雨|雨か雪|雪か雨|雨か雷雨|雪か雷)$/;
  let pk = '';                                   // 前一个词的类别：time / place / local / freq / after / to / comma / 其他
  for (let i = 0; i < toks.length; i++) {
    let t = toks[i], place = false;
    if (t.charAt(0) === '＠') { place = true; t = t.slice(1); }
    const prevTok = (toks[i - 1] || '').replace(/^＠/, '');
    let z, comma = false, kind = '';
    if (isTime(t) && toks[i + 1] === 'まで') { z = '到' + TIME_WORDS[t] + '为止'; i++; comma = true; kind = 'time'; }   // 朝 まで → 到早上为止
    else if (isTime(t)) { z = TIME_WORDS[t]; comma = pk !== 'to'; kind = 'time'; }
    else if (place || PLACE_WORDS[t]) { z = PLACE_WORDS[t] || zhArea(t); comma = true; kind = 'place'; }
    else if (t === '，') { z = '，'; kind = 'comma'; }
    else if (t === 'から') { const to = isTime(toks[i + 1]); z = to ? '到' : '起'; kind = to ? 'to' : 'from'; }   // 昼過ぎ から 夕方 → 午后到傍晚
    else if (t === '後' && (toks[i + 1] === '時々' || toks[i + 1] === '一時')) { z = '之后'; comma = true; kind = 'after'; }
    else if (t === '後') { z = '转'; comma = !!isWind && !PLACE_WORDS[prevTok] && pk !== 'place'; }
    else if (t === '時々' || t === '一時') { z = WORDS[t]; comma = pk !== 'after' && pk !== 'local' && pk !== 'time' && pk !== 'place'; kind = 'freq'; }
    else if (t === '所により') { z = '局地'; comma = true; kind = 'local'; }
    else if (t === 'はじめ') z = '起初';
    else if (t === '猛ふぶき') z = '有猛烈的吹雪';
    else {
      z = WORDS[t] != null ? WORDS[t] : t;
      if (!isWind && PRECIP.test(t) && /^(time|place|local|after)$/.test(pk)) z = '有' + z;   // 夜里有雨、山区有大雪、局地有雪
      else if (!isWind && PRECIP.test(t) && pk === 'freq' && out[out.length - 1] === '有时') z = '有' + z;   // 有时有雪
    }
    const last = out.length ? out[out.length - 1] : '';
    if (comma && out.length && last !== '，' && pk !== 'local' && pk !== 'from') out.push('，');
    out.push(z);
    pk = kind;
  }
  let r = out.join('').replace(/，，+/g, '，').replace(/^，|，$/g, '');
  if (hasKana(r)) r += '（有的词没能自动译出，请对照日文原文）';
  if (isWind) {
    const notes = [], rest = String(ja).replace(/やや強く|非常に強く/g, '');
    if (/やや強く/.test(ja)) notes.push('稍强＝平均风速 10–15 m/s');
    if (/強く/.test(rest)) notes.push('强＝15–20 m/s');
    if (/非常に強く/.test(ja)) notes.push('非常强＝20–30 m/s');
    if (notes.length) r += `（${notes.join('；')}）`;
  }
  return r;
}
function landPart(ja) { return String(ja || '').split(/海上/)[0]; }
// 预报文字里“〇〇 では …”只说那个小地区（例：“南の風 やや強く 後 北西の風 石狩北部 では 南西の風 強く”）。
// 只保留主句和本段经过的小地区那几句；“海上 では”自然被去掉。
function fcFor(ja, areas15) {
  const parts = String(ja || '').replace(/[\u3000\s]+/g, ' ').trim().split(/ ?(\S+) では /);
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) if ((areas15 || []).includes(parts[i])) out += ' ' + parts[i + 1];
  return out;
}

/* ---------------- 取数（浏览器端） ---------------- */
function cacheGet(key) {
  try { const c = sessionStorage.getItem(CACHE_PREFIX + key); if (!c) return null; const o = JSON.parse(c); if (Date.now() - o.t < CACHE_TTL) return o; } catch (e) { /* 存储不可用 */ }
  return null;
}
function cacheSet(key, d) { try { sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), d })); } catch (e) { /* 满了就算了 */ } }
function cacheClear() {
  try { const ks = []; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && k.startsWith(CACHE_PREFIX)) ks.push(k); } ks.forEach(k => sessionStorage.removeItem(k)); } catch (e) { /* 忽略 */ }
}
const SHORT_TTL = 5 * 60e3;   // 警报和时间序列变得快，缓存短一些
function cacheGetTtl(key, ttl) {
  try { const c = sessionStorage.getItem(CACHE_PREFIX + key); if (!c) return null; const o = JSON.parse(c); if (Date.now() - o.t < ttl) return o; } catch (e) { /* 存储不可用 */ }
  return null;
}
async function fetchOnce(url, opts) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const tm = setTimeout(() => ctrl && ctrl.abort(), opts.timeout || 12000);
  try {
    const r = await fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-cache' });
    if (r.status === 429) { const e = new Error('Open-Meteo 的免费访问次数暂时用完了（按网络出口计算），请过几分钟再试'); e.noRetry = true; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return opts.text ? await r.text() : await r.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('超时（' + Math.round((opts.timeout || 12000) / 1000) + ' 秒）');
    throw e;
  } finally { clearTimeout(tm); }
}
async function getData(key, url, transform, opts) {
  opts = opts || {};
  const ttl = /^(warn|tl|obs)/.test(key) ? SHORT_TTL : CACHE_TTL;
  const c = cacheGetTtl(key, ttl);
  if (c) return { data: c.d, fetchedAt: c.t, cached: true };
  let raw;
  try { raw = await fetchOnce(url, opts); }
  catch (e) { if (e.noRetry) throw e; await new Promise(r => setTimeout(r, 800)); raw = await fetchOnce(url, opts); }   // 失败自动重试一次
  const d = transform ? transform(raw) : raw;       // 解析器认不出结构时会报错，这一项就记成取数失败
  cacheSet(key, d);
  return { data: d, fetchedAt: Date.now(), cached: false };
}

/* ---------------- 解析：早期注意情報 ---------------- */
function parseProb(json) {
  const out = { rd: null, periods: [], daily: [], hasSnow: false, hasWind: false, minStart: null };
  if (!Array.isArray(json)) throw new Error('早期注意信息的结构和预期不同（不是数组），可能是气象厅改了格式');
  for (const blk of json) {
    if (!blk || !blk.timeSeries) continue;
    const rd = Date.parse(blk.reportDatetime);
    if (!out.rd || rd > out.rd) out.rd = rd;
    for (const ts of blk.timeSeries) {
      const defs = (ts.timeDefineArray && ts.timeDefineArray.length) ? ts.timeDefineArray.map(t => ({ s: Date.parse(t.dateTime), h: durH(t.duration) }))
        : (ts.timeDefines || []).map((t, i, a) => ({ s: Date.parse(t), h: a[i + 1] ? (Date.parse(a[i + 1]) - Date.parse(t)) / H : 24 }));
      for (const area of ts.areas || []) {
        const pick = re => { const p = (area.properties || []).find(x => re.test(x.type || '')); return p ? p.probabilities || [] : null; };
        const sn = pick(/^(大)?雪[^風]*警報級/), wd = pick(/^(暴)?風.*警報級/);
        if (sn) out.hasSnow = true;
        if (wd) out.hasWind = true;
        defs.forEach((d, i) => {
          const rec = { code: area.code, s: d.s, e: d.s + (d.h || 24) * H, snow: (sn || [])[i] || '', wind: (wd || [])[i] || '' };
          if ((d.h || 24) >= 24) out.daily.push({ code: area.code, date: dateStr(d.s), snow: rec.snow, wind: rec.wind });
          else { out.periods.push(rec); if (out.minStart == null || d.s < out.minStart) out.minStart = d.s; }
        });
      }
    }
  }
  if (!out.periods.length && !out.daily.length) throw new Error('早期注意信息里没有解析出任何时段，可能是气象厅改了格式');
  if (!out.hasWind || !out.hasSnow) throw new Error(`早期注意信息里没找到“${out.hasWind ? '雪' : '風'}の警報級の可能性”这一项，可能是气象厅改了名称`);
  return out;
}

/* ---------------- 解析：警報・注意報（r8：每类电文各保留最新一份） ---------------- */
function parseWarn(json) {
  const out = { rd: null, areas: {}, seen: {}, reports: 0 };   // areas[code] = [{code, status, rd}]；seen：电文里出现过的地区（不管有没有警报）
  if (!Array.isArray(json)) throw new Error('警报・注意报的结构和预期不同（不是数组）');
  const latest = {};
  for (const rep of json) {
    if (!rep || !rep.warning) continue;
    const k = rep.dataTypeCode || 'x';
    if (!latest[k] || latest[k].reportDatetime < rep.reportDatetime) latest[k] = rep;
  }
  for (const rep of Object.values(latest)) {
    out.reports++;
    const rd = Date.parse(rep.reportDatetime);
    if (!out.rd || rd > out.rd) out.rd = rd;
    for (const cls of ['class10Items', 'class20Items']) {
      for (const it of rep.warning[cls] || []) {
        if (it.areaCode) out.seen[it.areaCode] = true;
        for (const k of it.kinds || []) {
          if (!k.code || INACTIVE.has(k.status)) continue;
          (out.areas[it.areaCode] = out.areas[it.areaCode] || []).push({ code: k.code, status: k.status, rd });
        }
      }
    }
  }
  if (!out.reports || !Object.keys(out.seen).length) throw new Error('警报・注意报里没有解析出任何地区，可能是气象厅改了格式');
  return out;
}

/* ---------------- 解析：天気予報（三天＋周间） ---------------- */
function parseForecast(json) {
  const out = { rd: null, short: {}, week: null, weekRd: null };
  if (!Array.isArray(json) || !json[0]) return out;
  const f0 = json[0];
  out.rd = Date.parse(f0.reportDatetime);
  const ts0 = (f0.timeSeries || [])[0];
  if (ts0) {
    const dates = (ts0.timeDefines || []).map(t => dateStr(Date.parse(t)));
    for (const a of ts0.areas || []) {
      const code = a.area && a.area.code;
      out.short[code] = { name: a.area.name, days: {} };
      dates.forEach((ds, i) => { out.short[code].days[ds] = { wcode: +((a.weatherCodes || [])[i] || 0), weather: (a.weathers || [])[i] || '', wind: (a.winds || [])[i] || '' }; });
    }
  }
  const f1 = json[1];
  if (f1 && f1.timeSeries && f1.timeSeries[0]) {
    out.weekRd = Date.parse(f1.reportDatetime);
    const t0 = f1.timeSeries[0], a = (t0.areas || [])[0];
    const t1 = f1.timeSeries[1], tA = t1 && (t1.areas || [])[0];
    if (a) {
      const dates = (t0.timeDefines || []).map(t => dateStr(Date.parse(t)));
      const tDates = t1 ? (t1.timeDefines || []).map(t => dateStr(Date.parse(t))) : [];
      out.week = { code: a.area.code, name: a.area.name, station: tA && tA.area ? tA.area.name : '', days: {} };
      dates.forEach((ds, i) => {
        const j = tDates.indexOf(ds);
        out.week.days[ds] = {
          wcode: +((a.weatherCodes || [])[i] || 0), pop: (a.pops || [])[i] || '', rel: (a.reliabilities || [])[i] || '',
          tmin: tA && j >= 0 ? (tA.tempsMin || [])[j] || '' : '', tmax: tA && j >= 0 ? (tA.tempsMax || [])[j] || '' : ''
        };
      });
    }
  }
  return out;
}

/* ---------------- 解析：危険度の時系列（warning_timeline） ---------------- */
const num = v => {   // “10”“１０”“15～20”“10以上”都取其中最大的数
  const s = String(v == null ? '' : v).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const ms = s.match(/\d+(?:\.\d+)?/g);
  return ms ? Math.max(...ms.map(Number)) : null;
};
function pickLocals(locals, prefer) {
  const land = (locals || []).filter(l => l.areaName !== '海上');
  if (prefer) { const p = land.find(l => l.areaName === prefer); if (p) return [p]; }
  return land;
}
const mergeMax = (a, b) => (a ? a.map((v, i) => (b[i] == null ? v : (v == null ? b[i] : Math.max(v, b[i])))) : b);   // 同一种量出现两次时逐格取大，不让后来的盖掉前面的
function parseTimeline(json) {
  const out = { rd: null, blocks: [], areas: {}, daily: { blocks: [], areas: {} }, dailyList: [] };
  if (!json || !Array.isArray(json.timeSeries)) throw new Error('危险度时间序列的结构和预期不同');
  out.rd = Date.parse(json.reportDatetime);
  json.timeSeries.forEach(ts => {
    // timeDefines 可能是 {dateTime,duration} 对象，也可能是字符串、另带 timeDefineArray（早期注意情报就是这样）
    const tda = (ts.timeDefineArray && ts.timeDefineArray.length) ? ts.timeDefineArray : (ts.timeDefines || []);
    const defs = tda.map(t => (typeof t === 'string' ? { s: Date.parse(t), h: null } : { s: Date.parse(t.dateTime), h: durH(t.duration) }));
    defs.forEach((d, i) => { if (d.h == null && defs[i + 1] && defs[i + 1].s > d.s) d.h = (defs[i + 1].s - d.s) / H; });
    if (defs.length > 1 && defs[defs.length - 1].h == null) defs[defs.length - 1].h = defs[defs.length - 2].h;
    if (!defs.length) return;
    const is3h = defs[0].h === 3;
    if (!is3h && !(defs[0].h >= 12)) return;   // 12、24 小时一格的部分（雪崩、着冰等）另存一份
    const tgt = is3h ? out : { blocks: [], areas: {} };
    if (!is3h) out.dailyList.push(tgt);
    tgt.blocks = defs.map(d => ({ s: d.s, e: d.s + d.h * H }));
    for (const cls of ['class10Items', 'class20Items']) {
      for (const it of ts[cls] || []) {
        const A = tgt.areas[it.areaCode] = tgt.areas[it.areaCode] || {};
        for (const k of it.kinds || []) {
          for (const fp of k.forecastParts || []) {
            const n = defs.length;
            const maxOf = ls => { const vals = []; for (let i = 0; i < n; i++) { let m = null; ls.forEach(l => { const v = num(((l.values || [])[i] || {}).value); if (v != null && (m == null || v > m)) m = v; }); vals.push(m); } return vals; };
            const all = pickLocals(fp.locals);
            if (!all.length) continue;
            if (fp.type === '最大風速') A.wind = mergeMax(A.wind, maxOf(all));
            else if (fp.type === '６時間最大降雪量') {
              A.snow6 = mergeMax(A.snow6, maxOf(pickLocals(fp.locals, '平地')));   // 平地：高速和市区用
              A.snow6max = mergeMax(A.snow6max, maxOf(all));                       // 含山间部：山路用
            }
          }
          for (const sp of k.significancyParts || []) {
            const ls = pickLocals(sp.locals);
            if (!ls.length) continue;
            const n = defs.length, vals = [];
            for (let i = 0; i < n; i++) { let m = 0; ls.forEach(l => { const c = String((l.codes || [])[i] || '0'); const v = parseInt(c.charAt(0), 10) || 0; if (v > m) m = v; }); vals.push(m); }
            const key = { '風危険度': 'windSig', '雪危険度': 'snowSig', 'なだれ危険度': 'avaSig', '着雪危険度': 'accSig', '着氷危険度': 'iceSig' }[sp.type];
            if (key) A[key] = mergeMax(A[key], vals);
          }
        }
      }
    }
  });
  if (!out.blocks.length) throw new Error('危险度时间序列里没有解析出 3 小时格，可能是气象厅改了格式');
  return out;
}

/* ---------------- 解析：地域時系列予報（各细分地区 3 小时一格的天气、风速范围，到明天夜里） ---------------- */
function parseVPFD(json) {
  const a = json && json.areaTimeSeries;
  if (!a || !Array.isArray(a.timeDefines) || !a.timeDefines.length) throw new Error('地域时序预报的结构和预期不同，可能是气象厅改了格式');
  const blocks = a.timeDefines.map((t, i) => {
    const s = Date.parse(t.dateTime), h = durH(t.duration) || 3;
    const w = (a.wind || [])[i] || {}, nums = String(w.range || '').match(/\d+/g) || [];
    return { s, e: s + h * H, weather: String((a.weather || [])[i] || ''), lo: nums.length ? +nums[0] : null, hi: nums.length ? +nums[nums.length - 1] : null, dir: w.direction || '' };
  });
  const p = json.pointTimeSeries || {};
  const temps = (p.timeDefines || []).map((t, i) => ({ t: Date.parse(t.dateTime), v: (p.temperature || [])[i] })).filter(x => x.v != null && x.v !== '' && isFinite(+x.v)).map(x => ({ t: x.t, v: +x.v }));
  return { rd: Date.parse(json.reportDateTime), blocks, point: p.pointNameJP || '', temps };
}

/* ---------------- 解析：気象解説情報（只留北海道相关的） ---------------- */
function filterInfo(json) {
  if (!Array.isArray(json) || !json.length) throw new Error('气象解说信息列表的结构和预期不同，可能是气象厅改了格式');
  return json.filter(x => x && /^(北海道地方|石狩・空知・後志地方|上川・留萌地方)気象解説情報/.test(x.headTitle || '') &&
      (!x.editorialOffice || /札幌管区気象台|旭川地方気象台/.test(x.editorialOffice)))
    .map(x => ({ rd: Date.parse(x.reportDatetime), title: x.headTitle, serial: x.serial, eventId: x.eventId, areaType: x.areaType, areaCode: x.areaCode, infoType: x.infoType, jsonName: x.jsonName }));
}
function activeBulletins(list, now) {
  const byEvent = {};
  for (const b of list || []) { if (!byEvent[b.eventId] || byEvent[b.eventId].rd < b.rd) byEvent[b.eventId] = b; }
  return Object.values(byEvent).filter(b => now - b.rd <= 72 * H && b.infoType !== '取消').map(b => {
    const m = /（([^）]+)）/.exec(b.title || ''), items = m ? m[1] : '';
    const routes = b.areaCode === '012000' ? ['A'] : ['A', 'B'];
    return Object.assign({}, b, {
      items, routes,
      snowy: /大雪|暴風雪|風雪|着雪|なだれ/.test(items), windy: /暴風|強風/.test(items),
      url: `https://www.jma.go.jp/bosai/information/#area_type=${b.areaType || 'offices'}&area_code=${b.areaCode}` + (b.jsonName ? `&info_id=${b.jsonName}&format=text` : '')
    });
  }).sort((a, b) => b.rd - a.rd);
}


/* ---------------- 解析：気象解説情報的正文（headlineText 这一句） ----------------
 * 气象厅的写法很固定：“〇〇地方では、[时段][现象]に、[时段][现象]に（十分）注意／警戒してください。”
 * 这里把它拆成：地区、每组的时段和现象、要求的程度，再拼出中文。拆不开的部分只做提醒，不参与判定。 */
const ZEN = x => String(x || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const TW = { '未明': [0, 3], '明け方': [3, 6], '朝のうち': [6, 9], '朝': [6, 9], '昼前': [9, 12], '昼頃': [11, 13], '昼過ぎ': [12, 15], '日中': [9, 18],
  '夕方': [15, 18], '夜のはじめ頃': [18, 21], '夜遅く': [21, 24], '夜': [18, 24], '午前': [0, 12], '午後': [12, 24] };
const TWRE = '夜のはじめ頃|朝のうち|明け方|昼過ぎ|夜遅く|未明|昼前|昼頃|日中|夕方|午前|午後|朝|夜';
// 解说信息里的地区名 → 本页的细分地区。“日本海側”按气象厅的地区划分包括宗谷北部、上川、留萌、空知、石狩、后志、桧山，
// 本页的五个地区都在里面；“日本海側南部”“日本海側北部”的边界本页没有核实，按范围不明处理（只提醒，不计等级）。
const AREA_SUBS = { '石狩': ['016010'], '空知': ['016020'], '後志': ['016030'], '上川': ['012010'], '留萌': ['012020'], '日本海側': ['016010', '016020', '016030', '012010', '012020'] };
const AREA_OTHER = new Set(['宗谷', '網走', '北見', '紋別', '釧路', '根室', '十勝', '胆振', '日高', '渡島', '檜山', 'オホーツク海側', '太平洋側', '太平洋側西部', '太平洋側東部']);
const AREA_ZH2 = { '日本海側': '日本海一侧', '日本海側北部': '日本海一侧北部', '日本海側南部': '日本海一侧南部', '太平洋側': '太平洋一侧', '太平洋側西部': '太平洋一侧西部', '太平洋側東部': '太平洋一侧东部',
  'オホーツク海側': '鄂霍次克海一侧', '網走': '网走', '北見': '北见', '紋別': '纹别', '釧路': '钏路', '十勝': '十胜', '渡島': '渡岛', '檜山': '桧山', '後志': '后志' };
const VERB_ZH = { '厳重警戒': '要严加警戒', '警戒': '要提高警惕', '十分注意': '要充分注意', '注意': '要注意' };
const VERB_SHORT = { '厳重警戒': '严加警戒', '警戒': '警惕', '十分注意': '充分注意', '注意': '注意' };
const areaNames = ja => String(ja || '').replace(/^(また|引き続き)、?/, '').replace(/地方$/, '').split(/[・と]/).map(x => x.replace(/地方$/, '')).filter(Boolean);
function bulAreaZh(ja) {
  const names = areaNames(ja);
  if (!names.length) return '';
  if (names.some(n => /北海道/.test(n))) return '北海道全境';
  const side = names.some(n => /側/.test(n));
  return (side ? '北海道' : '') + names.map(n => AREA_ZH2[n] || n).join(side ? '和' : '、') + (side ? '' : '地区');
}
const HZ = [   // 长的在前
  ['暴風雪', '暴风雪', 'snow'], ['大雪', '大雪', 'snow'], ['ふぶき', '吹雪', 'snow'], ['吹雪', '吹雪', 'snow'], ['風雪', '风雪', 'snow'],
  ['交通障害', '交通受阻', 'traffic'], ['路面の凍結', '路面结冰', 'snow'], ['路面凍結', '路面结冰', 'snow'], ['着雪', '着雪（电线、树木积雪）', 'snow'],
  ['吹きだまり', '吹积的雪堆', 'snow'], ['なだれ', '雪崩', 'ava'], ['雪崩', '雪崩', 'ava'], ['竜巻などの激しい突風', '龙卷风等猛烈的突发强风', 'other'], ['激しい突風', '猛烈的突发强风', 'other'], ['突風', '突发强风', 'other'],
  ['暴風', '暴风', 'wind'], ['強風', '强风', 'wind'], ['落雷', '雷击', 'other'], ['ひょう', '冰雹', 'other'], ['急な強い雨', '突然的强降雨', 'other'],
  ['大雨', '大雨', 'other'], ['高波', '高浪', 'other'], ['高潮', '风暴潮', 'other'], ['低温', '低温', 'other'], ['濃霧', '浓雾', 'other'],
  ['融雪', '融雪', 'other'], ['土砂災害', '山体滑坡等土砂灾害', 'other'], ['浸水', '低洼地积水', 'other'], ['増水', '河水上涨', 'other']
];
function dayMs(rdMs, d, hour) {   // “24日”按发布日所在的月份算，跨月时往后推
  const p = jp(rdMs);
  let y = p.y, m = p.m;
  if (d < p.d - 15) { m += 1; if (m > 12) { m = 1; y += 1; } }
  return Date.UTC(y, m - 1, d, hour) - JST;
}
function parseTimeExpr(txt, rdMs) {
  const t = ZEN(txt);
  const re = new RegExp(`^(引き続き)?\\s*(?:(\\d{1,2})日)?(${TWRE})?(?:から(?:(\\d{1,2})日)?(${TWRE})?)?(にかけて|まで|は|の間)?[、，]?`);
  const m = re.exec(t);
  if (!m || (!m[2] && !m[3] && !m[4] && !m[5])) return null;
  const [all, cont, d1, t1, d2, t2] = m;
  const hasFrom = /から/.test(all);
  let s, e;
  if (hasFrom) {
    if (!d1 && !t1) return null;
    const day1 = d1 ? +d1 : jp(rdMs).d;
    s = dayMs(rdMs, day1, t1 ? TW[t1][0] : 0);
    const day2 = d2 ? +d2 : day1;
    e = dayMs(rdMs, day2, t2 ? TW[t2][1] : 24);
  } else {
    if (!d1) return null;
    s = rdMs;
    e = dayMs(rdMs, +d1, t1 ? TW[t1][1] : 24);
  }
  if (!(e > s)) return null;
  return { s, e, len: all.length, cont: !!cont };
}
function rangeZh(s, e, rdMs) {
  const a = jp(s), b = jp(e - 1), eh = jp(e).h === 0 ? 24 : jp(e).h;
  if (Math.abs(s - rdMs) < 60e3) return `到${b.d}日${eh}时为止`;
  if (a.d === b.d) return `${a.d}日${a.h}–${eh}时`;
  return `${a.d}日${a.h}时到${b.d}日${eh}时`;
}
function parseHazards(txt) {
  let rest = txt; const out = [];
  for (const [ja, zh, kind] of HZ) { if (rest.includes(ja)) { out.push({ ja, zh, kind }); rest = rest.split(ja).join('　'); } }
  return out;
}
function hazardsZh(hz) {
  const snow = hz.filter(h => h.kind === 'snow').map(h => h.zh), traffic = hz.some(h => h.kind === 'traffic');
  const others = hz.filter(h => h.kind !== 'snow' && h.kind !== 'traffic').map(h => h.zh);
  const parts = [];
  if (traffic && snow.length) parts.push(`${snow.join('、')}造成的交通受阻`);
  else if (traffic) parts.push('交通受阻');
  else parts.push(...snow);
  parts.push(...others);
  return parts.join('、');
}
function parseBulletin(json) {
  if (!json || typeof json.headlineText !== 'string') throw new Error('气象解说信息正文的结构和预期不同');
  const rd = Date.parse(json.reportDatetime);
  const head = json.headlineText.replace(/\s+/g, '');
  const allAreas = (json.headlineInfo || []).flatMap(h => (h.areas || []).flatMap(a => (a.area || []).map(z => z.code)));
  const out = { rd, head, sentences: [], parsedAll: true };
  head.split('。').map(x => x.trim()).filter(Boolean).forEach(sen => {
    let body = sen.replace(/^また、/, '');
    const vm = /に(十分に?|厳重に)?(注意|警戒)(?:してください|し)?$/.exec(body) || /に(十分に?|厳重に)?(注意|警戒)してください/.exec(body);
    if (!vm) { out.parsedAll = false; out.sentences.push({ raw: sen, ok: false }); return; }
    const verb = vm[2] === '警戒' ? (vm[1] === '厳重に' ? '厳重警戒' : '警戒') : (vm[1] ? '十分注意' : '注意');
    body = body.slice(0, vm.index);
    // 一句里可能有几个“〇〇では”
    const chunks = [];
    const areaRe = /([^、。]*?(?:地方|側|部))では、?/g;
    let m, last = null;
    while ((m = areaRe.exec(body))) { if (last) last.text = body.slice(last.end, m.index); last = { area: m[1], end: areaRe.lastIndex }; chunks.push(last); }
    if (last) last.text = body.slice(last.end); else chunks.push({ area: '', text: body });
    for (const c of chunks) {
      let codes = null, broad = false;
      const an = c.area.replace(/^(また|引き続き)、?/, '');
      if (!an) codes = allAreas.filter(x => SUB[x]);
      else if (/北海道地方/.test(an)) codes = Object.keys(SUB);
      else {
        const names = areaNames(an);
        if (names.every(n => AREA_SUBS[n] || AREA_OTHER.has(n))) codes = [...new Set([].concat(...names.map(n => AREA_SUBS[n] || [])))]; else broad = true;
      }
      const groups = [];
      c.text.replace(/に、?$/, '').split(/に、/).map(x => x.replace(/^、+|、+$/g, '').trim()).filter(Boolean).forEach(gt => {
        const t = parseTimeExpr(gt, rd);
        const hzText = t ? ZEN(gt).slice(t.len) : gt;
        const hz = parseHazards(hzText);
        if (!t) out.parsedAll = false;
        groups.push({ s: t ? t.s : null, e: t ? t.e : null, hz, ja: gt, zh: (t ? rangeZh(t.s, t.e, rd) + '，' : '') + (hz.length ? hazardsZh(hz) : '（这部分没能自动翻译）') });
      });
      const areaZh = /北海道地方/.test(an) ? '北海道全境' : an ? bulAreaZh(an) : (codes && codes.length ? codes.map(x => SUB[x].replace('地区', '')).join('、') + '地区' : '');
      out.sentences.push({ ok: true, verb, areaJa: c.area, areaZh, codes, broad, all: /北海道地方/.test(an), groups });
    }
  });
  out.zh = out.sentences.map(sn => {
    if (!sn.ok) return '（有一句没能自动翻译，请看原文）';
    return `${sn.areaZh ? sn.areaZh + '：' : ''}${sn.groups.map(g => g.zh).join('；')}，${VERB_ZH[sn.verb]}`;
  }).join('。') + '。';
  return out;
}

/* ---------------- 解析：Open-Meteo ---------------- */
function compactOM(json) {
  const arr = Array.isArray(json) ? json : [json];
  return arr.map(o => {
    const h = o && o.hourly; if (!h || !h.time) return null;
    const r = x => (x || []).map(v => v == null ? null : Math.round(v * 100) / 100);
    return { lat: o.latitude, lon: o.longitude, elev: o.elevation, t: h.time.map(omMs), T: r(h.temperature_2m), P: r(h.precipitation), R: r(h.rain), S: r(h.snowfall), W: r(h.wind_speed_10m), G: r(h.wind_gusts_10m), D: r(h.wind_direction_10m) };
  });
}
function compactEns(json) {
  const arr = Array.isArray(json) ? json : [json];
  return arr.map(o => {
    const h = o && o.hourly; if (!h || !h.time) return null;
    const mem = [];
    for (let m = 0; m <= 50; m++) {
      const sfx = m === 0 ? '' : '_member' + pad(m);
      const w = h['wind_speed_10m' + sfx], s = h['snowfall' + sfx];
      if (w && s) mem.push({ w, s });
    }
    return { t: h.time.map(omMs), mem };
  });
}
function compactMeta(j) { return j ? { init: (j.last_run_initialisation_time || 0) * 1000, avail: (j.last_run_availability_time || 0) * 1000 } : null; }

/* 某点某时段的逐时数据 */
function hoursOf(series, ws, we) {
  const out = [];
  if (!series) return out;
  for (let i = 0; i < series.t.length; i++) { const t = series.t[i]; if (t >= ws && t <= we) out.push(i); }
  return out;
}
function complete(series, idx) { return idx.length > 0 && idx.every(i => series.W[i] != null && series.S[i] != null && series.T[i] != null); }
function sumRange(series, key, a, b) { let s = 0, n = 0; for (let i = 0; i < series.t.length; i++) { const t = series.t[i]; if (t > a && t <= b && series[key][i] != null) { s += series[key][i]; n++; } } return n ? s : null; }

/* ---------------- 判定（v4 网站版，2026-11-25） ---------------- */
const SNOW_T = 2;        // 格点气温不高于这个值的降水，按“可能是雪”算（湿雪也算“有雪”；Open-Meteo 的 snowfall 以 0 ℃ 一刀切，会漏湿雪）
const SNOW_MIN = 0.1;    // “有降雪”的下限（cm/h），压掉 0.01 这类零星值
const W_ORANGE = 8;      // O1：高速平均风 8 m/s 以上并有雪判橙
const W_ORANGE_SLOW = 10; // O1：回程山路、美瑛一段车速低，10 m/s 以上并有雪才判橙
const W_RED = 14;        // R2：气象厅订正过的风速 14 m/s 以上并有雪判红（数值模式的风改走推定视程）
const VIS_RED = 200, VIS_ORANGE = 500;   // R3、O1：推定视程（米）
const DRY_T = 0;         // 干雪：气温 0 ℃ 以下
const BAND_T = 0.5;                       // R8、O9、R9：气温不高于 0.5 ℃ 的降水才算
const BAND_RED = { h3: 7, h6: 10 }, BAND_ORG = { h3: 4.5, h6: 6 };   // R8、O9：3 小时、6 小时合计（mm）
// R8f、O9f：第 4～6 天一日游高速段的雪带（2026-11-28 M 定：和前 3 天同一个标准，同一种颜色代表同样的危险程度；两家全球模式都达到才亮）。
// 量是目标日 01–24 时沿线 9 个点里最多的一点、0.5 ℃ 以下的降水全天合计（mm）；门槛按 2025–26 冬季加 2026 年 11 月 176 天回测定
// （scripts/lead_agree.py：红的日子约七成封过路，和前 3 天的红相当；橙约四成，和前 3 天的橙相当）。只能当排名用，不是实际雪量。
const FAR_BAND = { red: { e: 4.8, g: 4.2 }, org: { e: 3.6, g: 3.3 } };
const FAR_PTS = ['A1', 'A2', 'A3', 'A4', 'E1', 'E2', 'E3', 'E4', 'E5'];   // 和回测同样的 9 个点（一日游去程雪带的格点）
const OBS_P3 = 5, OBS_S3 = 6, OBS_VIS = 500, OBS_AHEAD = 8;   // R9：实测 3 小时降水（mm）、3 小时降雪（cm）、10 分钟视程（m）；只管最新观测之后 8 小时内开始的时段
/* 折算降雪量 Q（cm/h）：取 Open-Meteo 的 snowfall 与“降水量×0.7（气温≤SNOW_T 时）”中较大的一个，只用来判“有没有雪”，不展示 */
function withQ(s) {
  if (!s) return s;
  const Q = s.t.map((_, i) => { const S = s.S[i], P = s.P[i], T = s.T[i]; if (S == null && P == null) return null; return Math.max(S || 0, (P != null && T != null && T <= SNOW_T) ? P * 0.7 : 0); });
  return Object.assign({}, s, { Q });
}
const RANK = { black: 4, red: 3, orange: 2, gray: 1, green: 0 };
const PRIO = ['K4', 'K1', 'K2', 'R1', 'R9', 'R2', 'R3', 'R5', 'R7', 'R4', 'H2', 'R8', 'R8f', 'R4m', 'W1', 'W2', 'O1', 'O2', 'R9o', 'O9', 'O9f', 'O6', 'O3', 'O4', 'O7', 'O5', 'R7o', 'O8', 'E1', 'H1'];
const prio = r => { const i = PRIO.indexOf(r.rule); return i < 0 ? 99 : i; };
const byLevelPrio = (a, b) => (RANK[b.level] - RANK[a.level]) || (prio(a) - prio(b));
const LV_WORD = { black: '可能交通瘫痪', red: '不宜出行', orange: '要注意' };
function zhTitle(t) {
  const m = /^(.*?)気象解説情報(?:（(.*)）)?$/.exec(String(t || ''));
  if (!m) return String(t || '');
  const area = m[1].replace('後志', '后志').replace(/・/g, '、').replace(/地方$/, '地区');
  return `${area}气象解说信息${m[2] ? '（' + zhItems(m[2]) + '）' : ''}`;
}
function zhItems(s) {
  return String(s || '').replace(/暴風雪/g, '暴风雪').replace(/暴風/g, '暴风').replace(/強風/g, '强风').replace(/風雪/g, '风雪')
    .replace(/高波/g, '高浪').replace(/発達する低気圧/g, '发展中的低气压').replace(/降ひょう/g, '冰雹').replace(/ひょう/g, '冰雹')
    .replace(/落雷/g, '雷击').replace(/竜巻/g, '龙卷风').replace(/突風/g, '突发强风').replace(/なだれ/g, '雪崩').replace(/着雪/g, '着雪')
    .replace(/高潮/g, '风暴潮').replace(/濃霧/g, '浓雾').replace(/低温/g, '低温').replace(/融雪/g, '融雪').replace(/[・\s]+/g, '、');
}
const maxLv = (a, b) => (RANK[a] >= RANK[b] ? a : b);
const f1 = v => (v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, ''));
const BFT = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];   // 蒲福风级各级下限（m/s）
const bft = w => BFT.filter(x => w >= x).length;
const tC = v => (v == null ? '—' : (v < 0 ? '−' + f1(-v) : f1(v)) + ' ℃');
const f2 = v => (v == null || !isFinite(v) ? '—' : (Math.round(v * 100) / 100).toFixed(2));
const STALE_NAME = { prob: '早期注意信息', fc: '气象厅预报', tl: '危险度时间序列', msm: 'MSM 模式', ifs: 'ECMWF 模式', ens: '集合预报', vp: '地域时序预报' };

function mkReason(level, rule, text, src, short, extra) { return Object.assign({ level, rule, text, src: src || '', short: short || text, dk: text }, extra || {}); }

/* 气象厅当天预报文字里，雪从几点起可能出现：0＝全天，12＝“雨 後 雪”（转雪时刻没写，按下半天），15＝“雨 夕方 から 雪”，18＝“雨 夜 雪”；
 * 没有雪（或只有“雨か雪”“みぞれ”这类湿雪）返回 null。只看本段经过的小地区（见 fcFor）。 */
function fcSnowFrom(ja, areas15) {
  const t = fcFor(ja, areas15).replace(/雨か雪/g, '雨か…').replace(/みぞれ/g, '…');
  const i = t.search(/雪|ふぶ/);
  if (i < 0) return null;
  const before = t.slice(0, i);
  const ms = before.match(new RegExp(TWRE, 'g'));
  if (ms) return TW[ms[ms.length - 1]][0];
  return /後|のち/.test(before) ? 12 : 0;
}
/* 预报的“強く”和雪是不是落在同一段时间：风的文字按“後”分成前后几段，有“強く”的那一段要和下雪的时段重叠 */
function strongWithSnow(weatherMain, land, areas15, re) {
  const from = fcSnowFrom(weatherMain, areas15);
  if (from == null) return false;
  const parts = String(land || '').split(/後|のち/);
  const n = parts.length;
  return parts.some((p, k) => (re || /強く/).test(p.replace(/やや強く/g, '')) && 24 * (k + 1) / n > from);
}
/* 某段某时段有没有雪的迹象（凡是“风”的规则都先问这一句）：模式算出 0 ℃ 以下的降雪；气象厅预报文字或地域时序预报写到这个时段有雪；
 * 没有三天预报的日子看一周预报的天气代码。返回能写进说明的依据，空列表＝没有雪的迹象。 */
function snowSigns(ctx, seg, ds, a, b) {
  const why = [];
  for (const [mk, label] of [['msm', 'MSM'], ['ifs', 'ECMWF']]) {
    const M = ctx.om[mk]; if (!M || !M.ok) continue;
    const hit = seg.pts.some(pid => { const s = M.series[pid]; return s && hoursOf(s, a, b).some(i => s.S[i] != null && s.S[i] >= SNOW_MIN && s.T[i] != null && s.T[i] <= DRY_T); });
    if (hit) { why.push(`数值模式 ${label} 算出这时有降雪`); break; }
  }
  for (const sc of seg.subs) {
    const V = ctx.vp && ctx.vp[sc];
    if (V && V.ok && V.blocks.some(bl => bl.s < b && bl.e > a && /雪/.test(bl.weather) && !/雨/.test(bl.weather))) { why.push('气象厅地域时序预报这时有雪'); break; }
  }
  for (const sc of seg.subs) {
    const f = ctx.fc[officeOf(sc)];
    const d = f && f.ok && f.short[sc] && f.short[sc].days[ds];
    if (d && d.weather) { const from = fcSnowFrom(d.weather, seg.areas15); if (from != null && b > msAt(ds, from)) { why.push('气象厅预报这时有雪'); break; } continue; }
    const w = f && f.ok && f.week && f.week.days[ds];
    if (w && w.wcode && TELOPS_SNOW(w.wcode)) { why.push('气象厅一周预报这天有雪'); break; }
  }
  return why;
}
/* 今天生效的警报、注意报管不管某段时间（2026-11-28 定）：看危険度の時系列里这个市町在这段时间的对应一项有没有达到它的级别。
 * 返回 true／false；时间序列没取到、没有这个市町或这一项、没有和这段时间重叠的格时返回 null（这时按“目前有效”算） */
const WARN_TL = { '02': ['windSig', 3], '05': ['windSig', 3], '35': ['windSig', 3], '06': ['snowSig', 3], '12': ['snowSig', 2], '13': ['windSig', 2], '26': ['accSig', 2] };
function warnCovers(ctx, mc, code, a, b) {
  const m = WARN_TL[code]; if (!m) return null;
  const tl = ctx.tl[MUNI[mc][1]];
  if (!tl || !tl.ok) return null;
  const A = tl.areas[mc]; if (!A || !A[m[0]]) return null;
  let seen = false;
  for (let i = 0; i < tl.blocks.length; i++) {
    const bl = tl.blocks[i]; if (!(bl.s < b && bl.e > a)) continue;
    seen = true;
    if ((A[m[0]][i] || 0) >= m[1]) return true;
  }
  return seen ? false : null;
}
/* 不分时段的预报文字（ふぶく、やや強く、雨雪转换）要有同一时段的佐证才计等级（2026-11-28 定）：地域时序预报这一时段的天气有雪，
 * 或危険度の時系列本段市町这一时段雪达到注意报标准、6 小时降雪 1 cm 以上。wet＝雨雪转换，“雨か雪”“みぞれ”也算。
 * 返回 true／false；这一天两样都没有 3 小时格（例如后天）时返回 null */
function jmaSlotSnow(ctx, seg, a, b, wet) {
  let seen = false;
  for (const sc of seg.subs) {
    const V = ctx.vp && ctx.vp[sc];
    if (!V || !V.ok) continue;
    for (const bl of V.blocks) {
      if (!(bl.s < b && bl.e > a)) continue;
      seen = true;
      if (/雪/.test(bl.weather) && (wet || !/雨/.test(bl.weather))) return true;
      if (wet && /みぞれ/.test(bl.weather)) return true;
    }
  }
  for (const mc of seg.munis) {
    const tl = ctx.tl[MUNI[mc][1]]; if (!tl || !tl.ok) continue;
    const A = tl.areas[mc]; if (!A) continue;
    const s6 = (seg.kind === 'mtn' ? A.snow6max : A.snow6) || A.snow6 || [];
    for (let i = 0; i < tl.blocks.length; i++) {
      const bl = tl.blocks[i]; if (!(bl.s < b && bl.e > a)) continue;
      seen = true;
      if (((A.snowSig || [])[i] || 0) >= 2 || (s6[i] != null && s6[i] >= 1)) return true;
    }
  }
  return seen ? false : null;
}
/* R8f、O9f 用：目标日 01–24 时结束的 24 个小时、0.5 ℃ 以下的降水合计，9 个点取最大；有一个点缺小时就返回 null（和回测一样） */
function farP24(F, ds) {
  if (!F || !F.ok) return null;
  const a = msAt(ds, 0), b = msAt(ds, 24);
  let best = null;
  for (const s of F.data) {
    if (!s) return null;
    let sum = 0, n = 0;
    for (let i = 0; i < s.t.length; i++) {
      const t = s.t[i]; if (t <= a || t > b) continue;
      if (s.P[i] == null || s.T[i] == null) return null;
      n++; if (s.T[i] <= BAND_T) sum += s.P[i];
    }
    if (n < 24) return null;
    best = best == null ? sum : Math.max(best, sum);
  }
  return best == null ? null : Math.round(best * 100) / 100;
}
/* 气象厅一周预报（石狩、空知、后志）这天的天气有没有雪：R8f 要的“气象厅雪的信号”。返回 { snow, zh }，没取到返回 null */
function farWeekSnow(ctx, ds) {
  const f = ctx.fc['016000'];
  const w = f && f.ok && f.week && f.week.days[ds];
  if (!w || !w.wcode) return null;
  return { snow: TELOPS_SNOW(w.wcode), zh: TELOPS_ZH[w.wcode] || `天气代码 ${w.wcode}`, rd: f.weekRd };
}
/* 雪带最近几轮（data/latest/band_history.json，GitHub Actions 每 3 小时用网站同一个程序算一次存下）：
 * 返回比当前这一轮早的最近 3 轮 [{ init, v3, v6 }]，按起算时刻从早到晚 */
function bandHistFor(ctx, key, liveInit) {
  const hist = ctx.bandHist;
  if (!hist || !liveInit) return [];
  return hist.filter(r => r.init < liveInit && r.cells[key]).map(r => ({ init: r.init, v3: r.cells[key][0], v6: r.cells[key][1], pn: r.cells[key][2] })).slice(-3);
}
const runLabel = ms => { const p = jp(ms); return `${p.d}日${pad(p.h)}时`; };
const bandKey = (route, seg, ds) => (route.kind === 'timeline' ? `${route.id}|${ds}|${seg.id}` : `${route.id}|${ds}|${seg.id}|${pad(seg.h0)}`);
const bandOver = (v3, v6) => v3 >= BAND_RED.h3 || (v6 != null && v6 >= BAND_RED.h6);
/* 本段格点在某段时间里的气温（先用 MSM，没有再用 ECMWF）；没有数返回 null */
function modelTemps(ctx, seg, a, b) {
  for (const mk of ['msm', 'ifs']) {
    const M = ctx.om[mk]; if (!M || !M.ok) continue;
    const ts = [];
    seg.pts.forEach(pid => { const s = M.series[pid]; if (!s) return; hoursOf(s, a, b).forEach(i => { if (s.T[i] != null) ts.push(s.T[i]); }); });
    if (ts.length) return ts;
  }
  return null;
}
/* 推定视程（v4 规则；札幌管区气象台飞雪流量法和松泽 2007 的视程经验式，风速乘 0.81 折算到 1.2 m 高）：小时平均视程，单位 m。
 * V：10 m 高平均风速（m/s）；P：每小时降水量（mm，气温 1 ℃ 以下才算）；T：气温；fresh：最近一次降雨或融雪之后又有新雪、且 0 ℃ 以下 */
function visOf(V, P, T, fresh) {
  let N = (P || 0) * 0.2778 / 1.2;
  if (T <= 0 && fresh && V > 0) N += 18 * Math.pow(8, -0.35 / (0.4 * 0.036 * V));
  const Mf = Math.max(N * 0.81 * V, 1e-6);
  return Math.pow(10, 2.85 - 0.773 * Math.log10(Mf));
}
const visTxt = v => (v >= 10000 ? '10 km 以上' : v >= 1000 ? f1(v / 1000) + ' km' : Math.round(v / 10) * 10 + ' m');
/* 逐时的“新雪”标记：下雨（0 ℃ 以上）或气温升到 1 ℃ 以上，地上的雪湿了、再冻住就吹不起来；之后又下了雪（0 ℃ 以下）才算有新雪 */
function freshFlags(s) {
  const out = []; let fresh = false;
  for (let i = 0; i < s.t.length; i++) {
    const T = s.T[i], P = s.P[i], Rn = s.R[i], S = s.S[i];
    if (T == null) { out.push(false); continue; }
    if ((Rn != null && Rn >= 0.2 && T > 0) || T > 1) fresh = false;
    if (T <= 0 && ((S != null && S >= 0.2) || (P != null && P >= 0.3))) fresh = true;
    out.push(fresh && T <= 0);
  }
  return out;
}
/* (a, b] 里气温 0 ℃ 以下的降水合计（mm）；这段时间一个数都没有返回 null */
function sumCold(s, a, b) {
  let sum = 0, n = 0;
  for (let i = 0; i < s.t.length; i++) { const t = s.t[i]; if (t > a && t <= b && s.P[i] != null && s.T[i] != null) { n++; if (s.T[i] <= DRY_T) sum += s.P[i]; } }
  return n ? sum : null;
}
/* (a, b] 里气温 ≤0.5 ℃ 的降水合计（mm），要求这 n 个小时的降水和气温都有数，否则返回 null（R8、O9） */
function bandSum(s, a, b, n) {
  let sum = 0, k = 0;
  for (let i = 0; i < s.t.length; i++) {
    const t = s.t[i]; if (t <= a || t > b) continue;
    if (s.P[i] == null || s.T[i] == null) return null;
    k++; if (s.T[i] <= BAND_T) sum += s.P[i];
  }
  return k === n ? sum : null;
}
/* O3 结冰：之前 48 小时累计降雨 5 mm 以上，之后降到 −3 ℃ 以下；或雨停后 12 小时内的夜间到清晨降到 0 ℃ 以下，并且路面有水：
 * 这场雨（雨停前 12 小时内）3 mm 以上，或本段 AMeDAS 积雪深当天减少 5 cm 以上（融雪水，只用实测；2026-11-26 定）。
 * 从结冰起点到第二天 10 时判橙；之后只在 18 时到次日 9 时继续判橙，直到白天最高气温回到 3 ℃ 以上，或又下了 5 cm 以上的新雪。 */
function freezeCheck(s, ws, we, melt, today) {
  let rain = 0, lastRain = null;
  for (let i = 0; i < s.t.length; i++) { const t = s.t[i]; if (t > we - 48 * H && t <= we && s.R[i] != null && s.R[i] > 0) { rain += s.R[i]; if (s.R[i] >= 0.2) lastRain = t; } }
  if (lastRain == null) return null;
  let r12 = 0;
  for (let i = 0; i < s.t.length; i++) { const t = s.t[i]; if (t > lastRain - 12 * H && t <= lastRain && s.R[i] != null && s.R[i] > 0) r12 += s.R[i]; }
  const meltOK = !!melt && dateStr(lastRain) === today;
  const wet = r12 >= 3 || meltOK;
  if (rain < 5 && !wet) return null;
  let t0 = null, tmin = null, how = null;
  for (let i = 0; i < s.t.length; i++) {
    const t = s.t[i], T = s.T[i];
    if (t <= lastRain || T == null) continue;
    if (t > we) break;
    const h = jp(t).h, night = h >= 18 || h < 9;
    if (rain >= 5 && T <= -3) { t0 = t; tmin = T; how = 'cold'; break; }
    if (wet && night && t - lastRain <= 12 * H && T <= 0) { t0 = t; tmin = T; how = r12 >= 3 ? 'rain' : 'melt'; break; }
  }
  if (t0 == null) return null;
  const base = { rain, r12, how, melt: how === 'melt' ? melt : null, t0, tmin, hh: fmtMD(t0) };
  const until10 = msAt(addDays(dateStr(t0), 1), 10);
  if (ws < until10 && we > t0) return base;
  let reset = false, newSnow = 0;
  for (let i = 0; i < s.t.length; i++) {
    const t = s.t[i]; if (t <= t0 || t > ws) continue;
    const h = jp(t).h;
    if (h >= 9 && h < 18 && s.T[i] != null && s.T[i] >= 3) reset = true;
    if (s.S[i]) newSnow += s.S[i];
  }
  if (reset || newSnow >= 5) return null;
  const hs = jp(ws).h, he = jp(we).h || 24;
  return (hs >= 18 || hs < 9 || he > 18) ? Object.assign(base, { late: true }) : null;
}
/* 结冰第二款的融雪水：模式格点对应的 AMeDAS 站（要有积雪计），当天 0 时到最新整点积雪深减少 5 cm 以上 */
const MELT_ST = { A1: '14163', A2: '15356', A3: '15241', A4: '15161', A5: '12442', A6: '12551', A7: '12551', A8: '12626', A9: '12626', A10: '15251',
  B1: '16091', B2: '16091', B4: '14206', B5: '14206', B6: '14296', E1: '15356', E2: '15356', E3: '15356', E4: '15321', E5: '15241' };
function meltOf(ctx, pid) {
  const M = ctx.obs && ctx.obs.map, st = MELT_ST[pid], m = M && st && M[st];
  if (!m || m.sd == null || m.sd0 == null) return null;
  const cm = m.sd0 - m.sd;
  return cm >= 5 ? { cm, name: m.name } : null;
}
/* 危险度时间序列的 6 小时降雪相加时用的市町村分组和门槛（v4 R4、O2） */
const SNOW_GRP = {
  sap: { munis: ['0110000', '0121700', '0123400', '0123100', '0122400'], red: { h6: 20, h12: 30, h24: 40 }, org: { h12: 20, h24: 25 } },
  ots: { munis: ['0120300', '0121000', '0121500', '0122600', '0122500', '0122800', '0121600', '0122200', '0142400'], red: { h12: 40, h24: 50 }, org: { h12: 30 } },
  kam: { munis: ['0120400', '0145900', '0122900', '0146000', '0145800', '0145200', '0145300', '0146100'], red: { h12: 40 }, org: { h12: 25 } }
};
const grpOf = mc => Object.keys(SNOW_GRP).find(k => SNOW_GRP[k].munis.includes(mc));

function evalWindow(ctx, route, seg, ds, offset) {
  const now = ctx.now, ws = msAt(ds, seg.h0), we = msAt(ds, seg.h1);
  const R = [], missing = [], ctxInfo = [], notes = [], used = new Set();
  const add = r => R.push(r);
  if (offset === 0 && now >= we) return { past: true, level: 'gray', reasons: [mkReason('gray', 'past', '这个时段已经过去。', '')], missing: [], notes: [], raw: [] };
  const lvB = seg.black ? 'black' : 'red';   // ⬛ 只用于札幌、小樽、千岁一线（机场线全线、一日游在札幌的起止两段）
  const offices = [...new Set(seg.subs.map(officeOf))];
  const winSnow = snowSigns(ctx, seg, ds, ws, we);   // 本段本时段有没有雪的迹象
  const official = [];   // R3 要的“气象厅对本段、本时段的信号”（［中］不算）
  const ev = { snowJma: false, windEv: false };   // snowJma：气象厅一侧有雪的信号（给模式单独判红作佐证）；windEv：本段有达到 O1 的风雪
  const addOff = x => { if (!official.includes(x)) official.push(x); };
  const bandSig = new Set();   // R8 要的“气象厅雪的信号”（雪带取数时间窗里）；早期注意信息的［中］不算（2026-11-26 定）
  const bandS0 = seg.bandPts ? ws - (seg.bandPre || 6) * H : ws;   // 雪带取数时间窗：去程从前一天 18 时、回程从当天 05 时起（2026-11-26 定）
  let bandOut = null;   // 这一轮 MSM 的雪带最大值，存档脚本记进 band_history.json

  /* 0. 先看早期注意信息里本段、本时段有没有［高］：R3 的官方信号要用 */
  for (const off of offices) {
    const P = ctx.prob.by[off]; if (!P || !P.ok) continue;
    const mySubs = seg.subs.filter(sc => officeOf(sc) === off);
    if (P.periods.some(p => mySubs.includes(p.code) && p.s < we && p.e > ws && (p.snow === '高' || (p.wind === '高' && winSnow.length)))) addOff('早期注意信息［高］');
  }

  /* 1. 现在生效的警报、注意报（只算今天）。2026-11-28 改：按危険度の時系列看它管哪几个小时，本时段不在范围内的不计等级（写进提醒）；
   * 时间序列认不出时（没取到、没有这个市町或对应的一项）才按“目前有效”算 */
  if (offset === 0) {
    const byCode = {}, notIn = {};
    let warnGap = false;
    for (const mc of seg.munis) {
      const W = ctx.warn.by[MUNI[mc][1]];
      if (!W || !W.ok) { warnGap = true; continue; }
      for (const w of W.areas[mc] || []) {
        const cov = warnCovers(ctx, mc, w.code, ws, we);
        if (cov === false) {
          const o = notIn[w.code] = notIn[w.code] || { munis: [], rd: w.rd };
          if (!o.munis.includes(MUNI[mc][0])) o.munis.push(MUNI[mc][0]);
          // 雪带（R8）的雪信号看的是雪带取数时间窗：本时段之前、窗里还管着的照算
          if (seg.bandPts && ['02', '06', '12', '13'].includes(w.code) && warnCovers(ctx, mc, w.code, bandS0, we)) bandSig.add(WARN_NAME[w.code]);
          continue;
        }
        const b = byCode[w.code] = byCode[w.code] || { munis: [], rd: w.rd, byTl: true };
        if (!b.munis.includes(MUNI[mc][0])) b.munis.push(MUNI[mc][0]);
        if (cov === null) b.byTl = false;
        if (w.rd > b.rd) b.rd = w.rd;
      }
    }
    if (warnGap) missing.push('警报、注意报');
    for (const [code, o] of Object.entries(notIn)) {
      if (byCode[code] || !WARN_NAME[code] || code === '15') continue;
      notes.push({ key: 'wn|' + code + '|' + ds + '|' + seg.h0, munis: o.munis.slice(), tpl: m => `气象厅对${m.join('、')}发布的${WARN_NAME[code]}目前有效，但按危险度时间序列，${pad(seg.h0)}–${pad(seg.h1)} 时不在它管的时间里，这个时段不按它判级。` });
    }
    for (const [code, b] of Object.entries(byCode)) {
      const nm = WARN_NAME[code] || `一种本页不认识的警报或注意报（气象厅代码 ${code}），请看原文`;
      const src = `气象厅警报、注意报，${fmtMD(b.rd)} 发布`, who = b.munis.join('、');
      const inTl = b.byTl && WARN_TL[code] ? '，按危险度时间序列这个时段在它管的时间里' : '';
      const mk = (lv, rule, rt, tail) => add(mkReason(lv, rule, `气象厅对${who}发布了${nm}，目前有效${inTl}${tail || ''}。`, src, `${who}的${WARN_NAME[code] ? nm + '目前有效' : '不认识的警报代码 ' + code}`, { rt }));
      if (code === '32' || code === '36') { mk(lvB, 'K4', code === '32' ? '吹雪' : '大雪'); addOff(nm); ev.snowJma = true; bandSig.add(nm); }
      else if (code === '02' || code === '06') { mk('red', 'R1', code === '02' ? '吹雪' : '大雪'); addOff(nm); ev.snowJma = true; bandSig.add(nm); }
      else if (code === '13') { mk('orange', 'O1', '吹雪'); addOff(nm); ev.snowJma = true; ev.windEv = true; bandSig.add(nm); }
      else if (code === '12') { mk('orange', 'O2', '大雪'); addOff(nm); ev.snowJma = true; bandSig.add(nm); }
      else if (code === '26') add(mkReason('orange', 'O2', `气象厅对${who}发布了${nm}，目前有效${inTl}。`, src, `${who}的${nm}目前有效`, { rt: '其他', dk: 'warn|26' }));
      else if (code === '22') { if (seg.kind === 'mtn') mk('orange', 'O2', '其他', '（回程山路经过山区）'); }
      else if (code === '05' || code === '35') mk('orange', 'W1', '只有风', '；只有风的信息本页最多判橙');
      else if (code === '15') notes.push({ key: 'wo|15', munis: b.munis.slice(), tpl: m => `气象厅对${m.join('、')}发布了强风注意报，目前有效。只有风、没有雪的情况本页不计等级。` });
      else if (!WARN_NAME[code]) mk('orange', 'W2', '其他');
    }
  }

  /* 2. 气象解说信息：读正文的要点句，按其中的地区、时段、现象和要求的程度定等级 */
  let bulGap = !ctx.infoOk && offset <= 2;
  for (const b of ctx.bulletins) {
    if (!b.routes.includes(route.id)) continue;
    if (b.areaCode !== '010100' && !seg.subs.some(sc => officeOf(sc) === b.areaCode)) continue;
    const title = `《${zhTitle(b.title)}》第 ${b.serial} 号`;
    if (!b.body) { if (offset <= 2) bulGap = true; continue; }
    const src = `气象厅气象解说信息${title}，${fmtMD(b.rd)} 发布`;
    b.body.sentences.forEach((sn, si) => {
      if (!sn.ok) { if (offset <= 2) notes.push({ key: 'bx|' + b.eventId + '|' + si, text: `气象厅${title}里有一句本页没能自动拆开，请点页面顶部的提示看原文。` }); return; }
      const mine = (sn.codes || []).filter(c => seg.subs.includes(c));
      sn.groups.forEach((g, gi) => {
        const kinds = new Set(g.hz.map(h => h.kind));
        const snowy = kinds.has('snow') || (kinds.has('traffic') && !kinds.has('wind') && !kinds.has('other'));
        if (g.s == null || g.e == null) {
          if (snowy && offset <= 2 && (sn.broad || mine.length)) notes.push({ key: 'bt|' + b.eventId + '|' + si + '|' + gi, text: `气象厅${title}提到${sn.areaZh}${g.zh}，${VERB_ZH[sn.verb] || '要注意'}，但本页没能读出它说的时段，所以不计等级，请看原文。` });
          return;
        }
        if (!(g.s < we && g.e > ws)) return;
        const vZh = VERB_ZH[sn.verb] || '要注意';
        const k = b.eventId + '|' + si + '|' + gi;
        if (sn.broad) {
          if (snowy) notes.push({ key: 'bb|' + k, text: `气象厅气象解说信息（${fmtMD(b.rd)} 发布）：${sn.areaZh}${g.zh}，${vZh}。“${sn.areaZh.replace(/^北海道/, '')}”具体包括哪些地区，本页没有核实，所以不计等级，请自己判断是否包括本段。` });
          return;
        }
        if (!mine.length) return;
        const areaZh = sn.all ? '北海道全境' : sn.areaZh;
        const head = `${areaZh}${g.zh}，${vZh}`;
        if (snowy) {
          const red = sn.verb === '警戒' || sn.verb === '厳重警戒';
          const hzs = hazardsZh(g.hz.filter(h => h.kind === 'snow' || h.kind === 'traffic'));
          const rt = /吹雪|暴风雪|吹积|地吹雪/.test(g.zh + hzs) ? '吹雪' : '大雪';
          add(mkReason(red ? 'red' : 'orange', red ? 'R5' : 'O6', `气象厅气象解说信息（${fmtMD(b.rd)} 发布）：${head}。`, src, `气象解说信息提醒${areaZh}${VERB_SHORT[sn.verb] || '注意'}${hzs}`, { dk: 'bul|' + k, rt }));
          addOff('气象解说信息'); ev.snowJma = true;
        } else if (kinds.has('ava') && seg.kind === 'mtn') {
          add(mkReason('orange', 'O6', `气象厅气象解说信息（${fmtMD(b.rd)} 发布）：${head}（回程山路经过山区）。`, src, `气象解说信息提醒${areaZh}${VERB_SHORT[sn.verb] || '注意'}雪崩`, { dk: 'bula|' + k, rt: '其他' }));
        } else if (kinds.has('wind')) {
          notes.push({ key: 'bw|' + k, text: `气象厅气象解说信息（${fmtMD(b.rd)} 发布）：${head}。只有风、没有雪的情况本页不计等级。` });
        }
      });
    });
  }
  if (bulGap) missing.push('气象解说信息');

  /* 3. 气象厅天气预报（同样内容的几个地区合成一条）；本段经过的每个地区都要有预报 */
  const fcHits = {};
  const fcHit = (key, rule, lv, rt, mk) => { const h = fcHits[key] = fcHits[key] || { rule, lv, rt, mk, subs: [] }; const nm = SUB[mk.sc].replace('地区', ''); if (!h.subs.includes(nm)) h.subs.push(nm); };
  let fcGap = false;
  const weekDone = new Set();
  const windTxt = {};   // 各小地区预报陆上风：0 没写强度 1 やや強く 2 強く 3 非常に強く（判［中］的风一项用）
  for (const sc of seg.subs) {
    const off = officeOf(sc), f = ctx.fc[off];
    const d = f && f.ok && f.short[sc] && f.short[sc].days[ds];
    if (d && d.weather) {
      used.add('fc:' + off);
      const wj = fcFor(d.weather, seg.areas15), land = fcFor(d.wind, seg.areas15), rd = f.rd;   // 只看本段经过的小地区
      const main = seg.kind === 'mtn' ? wj : wj.split(/山沿い|所により|山間部/)[0];
      const vstrong = /非常に強く/.test(land), strong = /強く/.test(land.replace(/やや強く|非常に強く/g, '')), mild = /やや強く/.test(land);
      windTxt[sc] = vstrong ? 3 : strong ? 2 : mild ? 1 : 0;
      const zhw = zhForecast(wj);
      // 2026-11-28 定：不分时段的预报文字（ふぶく、やや強く、雨雪转换）要地域时序预报或危険度の時系列同一时段也有雪才计等级，否则写进提醒
      const noConf = (what, c) => notes.push({ key: 'fcnc|' + what + '|' + sc + '|' + ds, text: `气象厅预报 ${SUB[sc]}：${zhw}。其中${what}没写时段，本页只在地域时序预报或危险度时间序列同一时段也有雪时按它判橙；${c === null ? '这一天没有这两样分时段的预报可以核对' : '有的时段两样都没有雪'}，那些时段不按它判级。` });
      if (/猛ふぶき/.test(wj)) fcHit('K1f', 'K1', lvB, '吹雪', { sc, rd, zh: zhw });
      else if (/暴風雪/.test(wj)) fcHit('X2|' + zhw, 'O1', 'orange', '吹雪', { sc, rd, zh: zhw });   // 2026-11-28：不分时段的“暴風雪”最多判橙，不再整天判红
      else {
        if (/大雪/.test(wj)) fcHit('X1|大|' + zhw, 'O2', 'orange', '大雪', { sc, rd, zh: zhw, storm: '有大雪' });
        if (/ふぶく|吹雪/.test(wj)) { const c = jmaSlotSnow(ctx, seg, ws, we); if (c) fcHit('X1|吹|' + zhw, 'O1', 'orange', '吹雪', { sc, rd, zh: zhw, storm: '有吹雪', conf: true }); else noConf('“有吹雪”', c); }
      }
      if (/大雪|ふぶく|吹雪|暴風雪|猛ふぶき/.test(wj)) ev.snowJma = true;
      if (/雪/.test(main) && (vstrong || strong || mild)) {
        if (vstrong && strongWithSnow(main, land, seg.areas15, /非常に強く/)) { fcHit('K1w', 'K1', lvB, '吹雪', { sc, rd }); ev.windEv = true; }
        else if ((vstrong || strong) && strongWithSnow(main, land, seg.areas15)) { fcHit('R2w', 'R2', 'red', '吹雪', { sc, rd }); ev.windEv = true; }
        else if (vstrong || strong) { fcHit('O1w|s', 'O1', 'orange', '吹雪', { sc, rd, split: true }); ev.windEv = true; }
        else { const c = jmaSlotSnow(ctx, seg, ws, we); if (c) { fcHit('O1w|m', 'O1', 'orange', '吹雪', { sc, rd, split: false, conf: true }); ev.windEv = true; } else noConf('陆上风“やや強く”（稍强）并有雪', c); }
      } else if (vstrong) fcHit('Wv', 'W1', 'orange', '只有风', { sc, rd });
      // O4 雨雪转换：预报写“雨後雪”“雨か雪”“みぞれ”，并且这段时间气温在 −1～2 ℃；2026-11-28 起还要同一时段有雪的佐证（见上）
      if (TELOPS_RAIN_THEN_SNOW.has(d.wcode) || /雨か雪|みぞれ|雨 (後|のち) 雪|雨 .*から 雪|雨 (夜|夕方|夜遅く|昼過ぎ|未明|明け方)( は)? 雪/.test(wj)) {
        const ts = modelTemps(ctx, seg, ws, we);
        if (!ts || ts.some(t => t >= -1 && t <= 2)) { const c = jmaSlotSnow(ctx, seg, ws, we, true); if (c) fcHit('O4', 'O4', 'orange', '结冰', { sc, rd, noT: !ts }); else noConf('雨雪转换', c); }
      }
      continue;
    }
    const w = f && f.ok && f.week && f.week.days[ds];
    if (w && w.wcode) {
      used.add('fc:' + off);
      if (weekDone.has(off)) continue;
      weekDone.add(off);
      const zh = TELOPS_ZH[w.wcode] || `天气代码 ${w.wcode}`, src = `气象厅一周预报，${fmtMD(f.weekRd)} 发布`;
      if (w.wcode === 407) add(mkReason('red', 'R2', `气象厅一周预报 ${OFFICE[off]}：${zh}。`, src, `一周预报${zh}`, { rt: '吹雪' }));
      else if (w.wcode === 405) add(mkReason('orange', 'O2', `气象厅一周预报 ${OFFICE[off]}：${zh}。`, src, `一周预报${zh}`, { rt: '大雪' }));
      else if (w.wcode === 406) add(mkReason('orange', 'O1', `气象厅一周预报 ${OFFICE[off]}：${zh}。`, src, `一周预报${zh}`, { rt: '吹雪' }));
      if (TELOPS_RAIN_THEN_SNOW.has(w.wcode)) add(mkReason('orange', 'O4', `气象厅一周预报 ${OFFICE[off]}：${zh}（先雨后雪，路面容易结冰）。`, src, `一周预报先雨后雪`, { rt: '结冰' }));
      if (w.rel === 'C') notes.push({ key: 'rel|' + off, text: `气象厅一周预报对${OFFICE[off]}这天的可信度为 C（三档里最低），预报还可能大改，等级也可能跟着变。` });
      continue;
    }
    if (offset <= 5) fcGap = true;
  }
  for (const [key, h] of Object.entries(fcHits)) {
    const src = `气象厅天气预报，${fmtMD(h.mk.rd)} 发布`;
    let tpl, sh;
    if (key === 'K1f') { tpl = a => `气象厅预报 ${a}：${h.mk.zh}（写到猛烈吹雪）。`; sh = a => `${a}预报写到猛烈吹雪`; }
    else if (key.startsWith('X2|')) { tpl = a => `气象厅预报 ${a}：${h.mk.zh}（写到暴风雪）。预报文字不分时段，最多判橙。`; sh = a => `${a}预报写到暴风雪`; }
    else if (key.startsWith('X1|')) { tpl = a => `气象厅预报 ${a}：${h.mk.zh}。${h.mk.conf ? '这句没写时段，地域时序预报或危险度时间序列在这个时段也有雪。' : ''}`; sh = a => `${a}预报${h.mk.storm}`; }
    else if (key === 'K1w') { tpl = a => `气象厅预报 ${a}：陆上风非常强（平均 20 m/s 以上），并且和雪在同一段时间。`; sh = a => `${a}预报风非常强并有雪`; }
    else if (key === 'R2w') { tpl = a => `气象厅预报 ${a}：陆上风强（平均 15 m/s 以上），并且和雪在同一段时间。`; sh = a => `${a}预报风强并有雪`; }
    else if (key.startsWith('O1w')) { tpl = a => `气象厅预报 ${a}：陆上风${h.mk.split ? '强' : '稍强（平均 10–15 m/s）'}，并且有雪${h.mk.split ? '；不过按预报的先后，强风和雪不在同一段时间，所以只判橙' : ''}${h.mk.conf ? '；这句没写时段，地域时序预报或危险度时间序列在这个时段也有雪' : ''}。`; sh = a => `${a}预报风${h.mk.split ? '强' : '稍强'}并有雪`; }
    else if (key === 'Wv') { tpl = a => `气象厅预报 ${a}：陆上风非常强（平均 20 m/s 以上），但这段时间没有雪。只有风时本页最多判橙。`; sh = a => `${a}预报风非常强（没有雪）`; }
    else { tpl = a => `气象厅预报 ${a}：雨雪转换（雨夹雪，或先雨后雪）${h.mk.noT ? '' : '，这段时间气温在 −1～2 ℃ 之间'}，路面容易结冰。`; sh = a => `${a}预报雨雪转换`; }
    const areaTxt = list => list.join('、') + '地区';
    add(mkReason(h.lv, h.rule, tpl(areaTxt(h.subs)), src, sh(areaTxt(h.subs)), { dk: 'fc|' + key, areas: h.subs.slice(), tpl: l => tpl(areaTxt(l)), shf: l => sh(areaTxt(l)), rt: h.rt }));
  }
  if (fcGap) missing.push('气象厅预报');

  /* 4. 危険度の時系列（今天、明天的 3 小时格）：同一种信号把市町村和相连时段合成一条 */
  const tlHits = {};
  const tlHit = (key, o, nm, blk, val) => {
    const h = tlHits[key] = tlHits[key] || Object.assign({ munis: [], blocks: [], vals: [] }, o);
    if (!h.munis.includes(nm)) h.munis.push(nm);
    if (!h.blocks.some(x => x.s === blk.s)) h.blocks.push(blk);
    if (val != null) h.vals.push(val);
  };
  let tlGap = false;
  const tlWindOnly = {};
  for (const tlk of offices) {
    const tl = ctx.tl[tlk];
    if (!tl || !tl.ok) { if (offset === 0) tlGap = true; continue; }
    if (tl.blocks.some(b => b.s < we && b.e > ws)) used.add('tl:' + tlk);
    tl.blocks.forEach((b, i) => {
      const near = b.s < we + 3 * H && b.e > ws - 3 * H;   // 本时段和前后相邻一格
      const inBand = !!seg.bandPts && b.s < we + 3 * H && b.e > bandS0 - 3 * H;   // 雪带取数时间窗和前后相邻一格
      if (!near && !inBand) return;
      const inWin = b.s < we && b.e > ws;
      const modelSnow = inWin && snowSigns(ctx, seg, ds, b.s, b.e).length > 0;
      for (const mc of seg.munis) {
        if (MUNI[mc][1] !== tlk) continue;
        const A = tl.areas[mc]; if (!A) continue;
        const nm = MUNI[mc][0];
        const wsig = (A.windSig || [])[i] || 0, ssig = (A.snowSig || [])[i] || 0, asig = (A.accSig || [])[i] || 0;
        if (ssig >= 2 && inBand) bandSig.add('危险度时间序列里' + nm + '的雪达到注意报标准');   // R8 的信号看雪带时间窗里的各格和前后相邻一格
        if (!near) continue;
        if (ssig >= 2 || wsig >= 2) addOff('危险度时间序列');   // R3(b)：本时段或前后相邻一格达到注意报标准
        if (!inWin) continue;
        const s6arr = (seg.kind === 'mtn' ? A.snow6max : A.snow6) || A.snow6 || [];
        const w = (A.wind || [])[i], s6 = s6arr[i];
        const s6adj = Math.max(s6 || 0, s6arr[i - 1] || 0, s6arr[i + 1] || 0);
        // 这一格有没有像样的雪：雪危险度达到注意报、6 小时降雪 3 cm 以上，或模式、预报有雪的迹象
        const blkSnow = ssig >= 2 || (s6 != null && s6 >= 3) || modelSnow;
        if (ssig >= 2) ev.snowJma = true;
        if (wsig >= 2) {
          if (blkSnow) { tlHit(`W${wsig >= 3 ? 3 : 2}|风`, { rule: wsig >= 3 ? 'R1' : 'O1', lv: wsig >= 3 ? 'red' : 'orange', rt: '吹雪', what: `风达到${wsig >= 3 ? '警报' : '注意报'}的标准，这时有雪`, rd: tl.rd }, nm, b); ev.windEv = true; }
          else { const lvl = wsig >= 3 ? 3 : 2; const o = tlWindOnly[lvl] = tlWindOnly[lvl] || { munis: [], blocks: [] }; if (!o.munis.includes(nm)) o.munis.push(nm); if (!o.blocks.some(x => x.s === b.s)) o.blocks.push(b); }
        }
        if (ssig >= 3) tlHit('R1|雪', { rule: 'R1', lv: 'red', rt: '大雪', what: '雪达到警报的标准', rd: tl.rd }, nm, b);
        else if (ssig === 2) tlHit('O2|雪', { rule: 'O2', lv: 'orange', rt: '大雪', what: '雪达到注意报的标准', rd: tl.rd }, nm, b);
        if (asig >= 2) tlHit('O2|着雪', { rule: 'O2', lv: 'orange', rt: '其他', what: '着雪（电线、树木积雪）达到注意报的标准', rd: tl.rd }, nm, b);
        // R2：最大风速 14 m/s 以上，同一格或相邻一格 6 小时降雪 3 cm 以上，气温 0 ℃ 以下（气温取本段格点的模式值，没有就不卡）
        const tsB = modelTemps(ctx, seg, b.s, b.e), coldB = !tsB || Math.min(...tsB) <= DRY_T;
        if (w != null && w >= W_RED && s6adj >= 3 && coldB) { tlHit('R2|w', { rule: 'R2', lv: 'red', rt: '吹雪', what: 'wind', rd: tl.rd }, nm, b, { w, s6: s6adj }); ev.windEv = true; }
        else if (w != null && w >= (seg.kind === 'hwy' ? W_ORANGE : W_ORANGE_SLOW) && blkSnow && s6 != null && s6 >= 1) { tlHit('O1|w', { rule: 'O1', lv: 'orange', rt: '吹雪', what: 'wind', rd: tl.rd }, nm, b, { w, s6 }); ev.windEv = true; }
        else if (w != null && w >= W_ORANGE_SLOW && !blkSnow && wsig < 2) { const o = tlWindOnly['v'] = tlWindOnly['v'] || { munis: [], blocks: [], w: 0 }; if (!o.munis.includes(nm)) o.munis.push(nm); if (!o.blocks.some(x => x.s === b.s)) o.blocks.push(b); o.w = Math.max(o.w, w); }
        // R4、O2：按 6 小时降雪相加（不重叠的 6 小时格相加）
        const g = grpOf(mc);
        if (g && s6 != null) {
          const T = SNOW_GRP[g];
          const v6 = s6, v12 = Math.max(s6 + (s6arr[i - 2] || 0), s6 + (s6arr[i + 2] || 0));
          let v24 = 0;
          for (const j0 of [i - 6, i - 4, i - 2, i]) { let sum = 0; for (let j = j0; j <= j0 + 6; j += 2) sum += s6arr[j] || 0; v24 = Math.max(v24, sum); }
          const red = (T.red.h6 && v6 >= T.red.h6) || (T.red.h12 && v12 >= T.red.h12) || (T.red.h24 && v24 >= T.red.h24);
          const o12 = seg.kind === 'mtn' ? Math.min(T.org.h12, 20) : T.org.h12;
          const org = v12 >= o12 || (T.org.h24 && v24 >= T.org.h24);
          if (red) tlHit('R4|sum', { rule: 'R4', lv: 'red', rt: '大雪', what: 'sum', rd: tl.rd }, nm, b, { v6, v12, v24 });
          else if (org) tlHit('O2|sum', { rule: 'O2', lv: 'orange', rt: '大雪', what: 'sum', rd: tl.rd }, nm, b, { v6, v12, v24 });
          if (red || org) ev.snowJma = true;
        }
      }
    });
    if (seg.kind === 'mtn') (tl.dailyList || []).forEach(D => D.blocks.forEach((b, i) => {
      if (!(b.s < we && b.e > ws)) return;
      for (const mc of seg.munis) {
        if (MUNI[mc][1] !== tlk) continue;
        const A = D.areas[mc];
        if (A && (A.avaSig || [])[i] >= 2) tlHit('O2|ava', { rule: 'O2', lv: 'orange', rt: '其他', what: 'ava', rd: tl.rd, daily: true }, MUNI[mc][0], b);
      }
    }));
  }
  if (tlGap) missing.push('危险度时间序列');
  if (tlHits['W3|风']) delete tlHits['W2|风'];
  if (tlHits['R2|w']) delete tlHits['O1|w'];
  if (tlHits['R4|sum']) delete tlHits['O2|sum'];
  for (const [lvl, o] of Object.entries(tlWindOnly)) notes.push({ key: `tlw|${lvl}|${ds}`, munis: o.munis, blocks: o.blocks,
    tpl: (m, bl) => lvl === 'v'
      ? `气象厅危险度时间序列：${m.join('、')}${blocksLabel(bl)}最大风速 ${o.w} m/s，但这几格没有像样的降雪（6 小时不到 3 cm，模式和预报也没有雪），本页不计等级。`
      : `气象厅危险度时间序列：${m.join('、')}${blocksLabel(bl)}风达到${lvl === '3' ? '警报' : '注意报'}的标准，但这几格没有像样的降雪。只有风、没有雪的情况本页不计等级。` });
  for (const [key, h] of Object.entries(tlHits)) {
    const src = `气象厅危险度时间序列，${fmtMD(h.rd)} 发布`;
    const per = h.daily ? '这段时间' : blocksLabel(h.blocks);
    let tpl, sh;
    if (h.what === 'wind') {
      const mw = Math.max(...h.vals.map(v => v.w)), ms = Math.max(...h.vals.map(v => v.s6));
      tpl = l => `气象厅危险度时间序列：${l.join('、')}${per}最大风速 ${mw} m/s（${bft(mw)} 级），${h.rule === 'R2' ? '同一格或相邻一格' : ''}6 小时降雪 ${ms} cm。`;
      sh = l => `${l.join('、')}最大风速 ${mw} m/s（${bft(mw)} 级）并有降雪`;
    } else if (h.what === 'sum') {
      const m6 = Math.max(...h.vals.map(v => v.v6)), m12 = Math.max(...h.vals.map(v => v.v12)), m24 = Math.max(...h.vals.map(v => v.v24));
      tpl = l => `气象厅危险度时间序列：${l.join('、')}${per}，按 6 小时降雪相加：6 小时最多 ${m6} cm，12 小时 ${m12} cm，24 小时 ${m24} cm。`;
      sh = l => `${l.join('、')}累计降雪多（12 小时 ${m12} cm）`;
    } else if (h.what === 'ava') {
      tpl = l => `气象厅危险度时间序列：${l.join('、')}雪崩达到注意报的标准（回程山路经过山区）。`;
      sh = l => `${l.join('、')}雪崩达到注意报的标准`;
    } else {
      tpl = l => `气象厅危险度时间序列：${l.join('、')}${per}${h.what}。`;
      sh = l => `${l.join('、')}${per}${h.what}`;
    }
    add(mkReason(h.lv, h.rule, tpl(h.munis), src, sh(h.munis), { dk: 'tl|' + key + '|' + per, areas: h.munis.slice(), tpl, shf: sh, rt: h.rt }));
  }

  /* 5. 地域时序预报（今天、明天，各细分地区 3 小时一格的天气和风速范围） */
  if (offset <= 1) {
    const vpHits = {};
    for (const sc of seg.subs) {
      const V = ctx.vp && ctx.vp[sc]; if (!V || !V.ok) continue;
      V.blocks.forEach(b => {
        if (!(b.s < we && b.e > ws)) return;
        used.add('vp:' + sc);
        const dry = /雪/.test(b.weather) && !/雨/.test(b.weather), wet = /雪/.test(b.weather) && /雨|みぞれ/.test(b.weather);
        const hit = (key, rule, lv, rt) => { const h = vpHits[key] = vpHits[key] || { rule, lv, rt, rd: V.rd, subs: [], blocks: [], lo: 0, hi: 0, wx: new Set() }; const nm = SUB[sc].replace('地区', ''); if (!h.subs.includes(nm)) h.subs.push(nm); if (!h.blocks.some(x => x.s === b.s)) h.blocks.push(b); h.lo = Math.max(h.lo, b.lo || 0); h.hi = Math.max(h.hi, b.hi || 0); h.wx.add(b.weather); };
        if (dry && b.lo != null) {
          if (b.lo >= 20) hit('K1', 'K1', lvB, '吹雪');
          else if (b.lo >= 15) hit('R2', 'R2', 'red', '吹雪');
          else if (b.lo >= 10) hit('O1', 'O1', 'orange', '吹雪');
          if (b.lo >= 10) ev.windEv = true;
        } else if (b.lo != null && b.lo >= 20) notes.push({ key: 'vpw|' + sc + '|' + b.s, text: `气象厅地域时序预报：${SUB[sc]}${periodLabel(b.s, b.e)}风速 ${b.lo}–${b.hi} m/s，但天气不是雪。只有风、没有雪的情况本页最多判橙。` });
        if (wet) {
          const tv = V.temps.filter(x => x.t >= b.s && x.t <= b.e).map(x => x.v);
          if (tv.length && tv.some(t => t >= -1 && t <= 2)) hit('O4', 'O4', 'orange', '结冰');
        }
      });
    }
    for (const [key, h] of Object.entries(vpHits)) {
      const src = `气象厅地域时序预报，${fmtMD(h.rd)} 发布`;
      const per = blocksLabel(h.blocks), wx = [...h.wx].map(x => x.replace('または', '或').replace('くもり', '多云').replace('晴れ', '晴')).join('、');
      const txt = key === 'O4' ? `气象厅地域时序预报：${h.subs.join('、')}地区${per}天气“${wx}”，气温在 −1～2 ℃ 之间，雨雪转换，路面容易结冰。`
        : `气象厅地域时序预报：${h.subs.join('、')}地区${per}天气“雪”，风速 ${h.lo}–${h.hi} m/s。`;
      add(mkReason(h.lv, h.rule, txt, src, key === 'O4' ? `${h.subs.join('、')}地区雨雪转换` : `${h.subs.join('、')}地区预报风速 ${h.lo}–${h.hi} m/s 并有雪`, { dk: 'vp|' + key + '|' + per, rt: h.rt }));
    }
  }

  /* 6. 数值模式（MSM、ECMWF IFS 最近的陆地格点原值）：每个模式、每条规则只留最严重的一个点 */
  const raw = [];
  let modelOK = false;
  const best = { MSM: {}, ECMWF: {} };
  for (const [mk, label] of [['msm', 'MSM'], ['ifs', 'ECMWF']]) {
    const M = ctx.om[mk];
    if (!M || !M.ok) continue;
    let anyComplete = false;
    const bb = best[label];
    const keep = (rule, v, pn, hh, extra) => { if (!bb[rule] || v > bb[rule].v) bb[rule] = { v, pn, hh, extra }; };
    for (const pid of seg.pts) {
      const s = M.series[pid]; if (!s) continue;
      const idxAll = hoursOf(s, ws, we);
      const idx = idxAll.filter(i => s.W[i] != null && s.T[i] != null && s.P[i] != null);
      if (!idx.length) continue;
      if (idx.length === idxAll.length) anyComplete = true;
      used.add(mk);
      const pn = PT[pid].name, isWind = seg.windPts.includes(pid);
      if (!s.fresh) s.fresh = freshFlags(s);
      for (const i of idx) {
        const W = s.W[i], T = s.T[i], P = s.P[i], Q = s.Q[i] || 0, hh = hourLabel(s.t[i], ds);
        if (isWind) { const Pe = T <= 1 ? P : 0, v = visOf(W, Pe, T, s.fresh[i]); keep('vis', -v, pn, hh, { v, W, P: Pe, T, fresh: s.fresh[i] }); }
        if (isWind && Q >= SNOW_MIN && W >= (seg.kind === 'hwy' ? W_ORANGE : W_ORANGE_SLOW)) keep('wo', W, pn, hh);
        if (seg.kind === 'mtn' && Q >= SNOW_MIN && T <= -3) keep('cold', -T, pn, hh, T);
        const p12 = sumCold(s, s.t[i] - 12 * H, s.t[i]), p24 = sumCold(s, s.t[i] - 24 * H, s.t[i]);
        if (p12 != null) keep('p12', p12, pn, hh);
        if (p24 != null) keep('p24', p24, pn, hh);
      }
      const fz = freezeCheck(s, ws, we, meltOf(ctx, pid), ctx.today);
      if (fz) keep('freeze', fz.rain, pn, fz.hh, fz);
      if (!raw.some(r => r.pid === pid)) raw.push({ pid, model: label === 'MSM' ? 'MSM（日本气象厅中尺度模式）' : 'ECMWF IFS（欧洲中期天气预报中心的全球模式）', point: `${pn}附近的陆地格点（北纬 ${f2(s.lat)}°，东经 ${f2(s.lon)}°，模式地形高度 ${Math.round(s.elev)} m）`,
        rows: idx.map(i => ({ h: pad(hourLabel(s.t[i], ds)), w: s.W[i], g: s.G[i], sn: s.S[i], rn: s.R[i], t: s.T[i] })) });
      let mx = null; idx.forEach(i => { if (!mx || s.W[i] > mx.W) mx = { W: s.W[i], hh: hourLabel(s.t[i], ds) }; });
      const snowSum = idx.reduce((a, i) => a + (s.Q[i] || 0), 0);
      ctxInfo.push({ label, pn, W: mx.W, hh: mx.hh, snowSum });
    }
    if (anyComplete) modelOK = true;
  }
  const mSrc = hits => `Open-Meteo 提供的模式格点数值（${hits.join('、')}）`;
  const both = rule => ['MSM', 'ECMWF'].filter(m => best[m][rule]);
  // 推定视程：取两个模式里最低的
  {
    const hits = both('vis').map(m => ({ m, x: best[m].vis })).sort((a, b) => a.x.extra.v - b.x.extra.v);
    if (hits.length) {
      const top = hits[0], x = top.x.extra, vTxt = visTxt(x.v);
      const det = `${top.x.pn}附近格点 ${top.x.hh} 时：风 ${f1(x.W)} m/s，每小时降水 ${f1(x.P)} mm，${tC(x.T)}${x.fresh ? '，地上有新雪' : ''}（${top.m}）`;
      if (x.v < VIS_RED && official.length) add(mkReason('red', 'R3', `推定视程约 ${vTxt}，不到 ${VIS_RED} m（${det}）；气象厅对本段、本时段也有信号：${official.join('、')}。`, mSrc([top.m]), `推定视程约 ${vTxt}（${top.x.pn}），气象厅有对应信号`, { dk: 'model|vis', model: true, rt: '吹雪' }));
      else if (x.v < VIS_RED) add(mkReason('orange', 'O8', `推算视程很低（约 ${vTxt}，${det}），但气象厅没有本段、本时段的对应信号，所以只判橙。`, mSrc([top.m]), `推定视程约 ${vTxt}（${top.x.pn}），气象厅没有对应信号`, { dk: 'model|vis', model: true, rt: '吹雪' }));
      else if (x.v < VIS_ORANGE) add(mkReason('orange', 'O1', `推定视程约 ${vTxt}，不到 ${VIS_ORANGE} m（${det}）。`, mSrc([top.m]), `推定视程约 ${vTxt}（${top.x.pn}）`, { dk: 'model|vis', model: true, rt: '吹雪' }));
      ctxInfo.push({ vis: x.v, pn: top.x.pn, hh: top.x.hh, m: top.m });
    }
  }
  // 风＋雪（O1）
  {
    const hits = both('wo');
    if (hits.length) {
      const top = best[hits[0]].wo;
      add(mkReason('orange', 'O1', `${hits.length === 2 ? '两个数值模式（MSM、ECMWF）都算出' : '数值模式 ' + hits[0] + ' 算出'}平均风速 ${seg.kind === 'hwy' ? W_ORANGE : W_ORANGE_SLOW} m/s 以上并有降雪（${hits.map(m => `${hits.length === 2 ? m + '：' : ''}${best[m].wo.pn}附近格点 ${best[m].wo.hh} 时 ${f1(best[m].wo.v)} m/s`).join('；')}）。`, mSrc(hits), `${top.pn}附近格点风速 ${f1(top.v)} m/s 并有降雪（${hits.join('、')}）`, { dk: 'model|wo', model: true, rt: '吹雪' }));
      ev.windEv = true;
    }
  }
  // 雪量（毫米，0 ℃ 以下的降水）：R4 12 小时 22 mm 或 24 小时 28 mm；O2 12 小时 15 mm
  let kModel = null;
  {
    const lvOf = m => { const a = best[m].p12, b = best[m].p24; if (!a && !b) return null; const v12 = a ? a.v : 0, v24 = b ? b.v : 0; return { m, v12, v24, pn: (v12 >= 22 || !b ? a : b).pn, red: v12 >= 22 || v24 >= 28, org: v12 >= 15 }; };
    const L = ['MSM', 'ECMWF'].map(lvOf).filter(Boolean);
    const msm = L.find(x => x.m === 'MSM');
    if (seg.black && msm && (msm.v12 >= 30 || msm.v24 >= 35)) kModel = msm;
    const reds = L.filter(x => x.red), orgs = L.filter(x => x.org && !x.red);
    const desc = x => `${x.m}：${x.pn}附近格点 12 小时 ${f1(x.v12)} mm、24 小时 ${f1(x.v24)} mm`;
    if (reds.length) {
      const other = L.filter(x => !reds.includes(x)).some(x => x.org);
      add(mkReason('red', 'R4m', `数值模式算出 0 ℃ 以下的降水 12 小时 22 mm 以上或 24 小时 28 mm 以上（${reds.map(desc).join('；')}）。札幌下大雪时每 1 mm 降水常积 1.0–1.6 cm 雪。`, mSrc(reds.map(x => x.m)), `${reds[0].pn}附近格点 12 小时降水 ${f1(reds[0].v12)} mm（0 ℃ 以下，${reds.map(x => x.m).join('、')}）`, { dk: 'model|snow', model: true, rt: '大雪', support: reds.length === 2 || other }));
    } else if (orgs.length) add(mkReason('orange', 'O2', `数值模式算出 0 ℃ 以下的降水 12 小时 15 mm 以上（${orgs.map(desc).join('；')}）。`, mSrc(orgs.map(x => x.m)), `${orgs[0].pn}附近格点 12 小时降水 ${f1(orgs[0].v12)} mm（0 ℃ 以下）`, { dk: 'model|snow', model: true, rt: '大雪' }));
  }
  // 回程山路：有雪并且 −3 ℃ 以下（O7）
  {
    const hits = both('cold');
    if (hits.length) { const x = best[hits[0]].cold; add(mkReason('orange', 'O7', `回程山路天黑、没有备用路：数值模式算出有雪并且气温在 −3 ℃ 以下（${x.pn}附近格点 ${x.hh} 时 ${tC(x.extra)}，${hits.join('、')}）。`, mSrc(hits), `${x.pn}附近格点下雪、${tC(x.extra)}`, { dk: 'model|cold', model: true, rt: '结冰' })); }
  }
  // 结冰（O3）
  {
    const hits = both('freeze');
    if (hits.length) { const x = best[hits[0]].freeze, z = x.extra;
      const cause = z.how === 'cold' ? `先下雨（${x.pn}附近格点前 48 小时约 ${f1(z.rain)} mm），之后气温降到 ${tC(z.tmin)}`
        : z.how === 'rain' ? `雨停前 12 小时下了约 ${f1(z.r12)} mm（${x.pn}附近格点），雨停后 12 小时内的夜里降到 ${tC(z.tmin)}`
        : `下过雨，${z.melt.name}今天积雪化掉 ${z.melt.cm} cm（AMeDAS 实测，路边有融雪水），${x.pn}附近格点雨停后 12 小时内的夜里降到 ${tC(z.tmin)}`;
      add(mkReason('orange', 'O3', `${cause}，从 ${z.hh} 前后起路面容易结冰${z.late ? '；之后的夜间到清晨仍按容易结冰算，直到白天回到 3 ℃ 以上或又下 5 cm 以上的新雪' : ''}（${hits.join('、')}）。`, mSrc(hits), `${x.pn}附近格点雨后降温`, { dk: 'model|freeze', model: true, rt: '结冰' })); }
  }
  if (!modelOK) missing.push('数值模式');

  /* 6b. 雪带（R8、O9；v6，2026-11-26 改时间窗；2026-11-27 加机场线道央道段，时间窗为本时段和之前 6 小时，不用 4.5／6 mm 预警）：一日游的去程、回程高速。去程看前一天 18 时到 11 时、回程看 05–20 时，MSM 在道央道沿线格点 0.5 ℃ 以下的降水 3 小时或 6 小时合计 */
  if (seg.bandPts && ctx.om.msm && ctx.om.msm.ok) {
    const s0 = bandS0;
    const winTxt = seg.bandPre ? (seg.h0 === 9 ? '前一天 18 时到当天 11 时' : '当天 05–20 时') : '本时段和之前 6 小时';
    let top = null;
    for (const pid of seg.bandPts) {
      const s = ctx.om.msm.series[pid]; if (!s) continue;
      for (let i = 0; i < s.t.length; i++) {
        const t = s.t[i];
        if (t - 3 * H < s0 || t > we) continue;   // 只取完全落在“之前 6 小时到本时段结束”里的窗口
        const v3 = bandSum(s, t - 3 * H, t, 3);
        if (v3 == null) continue;
        const v6 = t - 6 * H >= s0 ? bandSum(s, t - 6 * H, t, 6) : null;
        const sc = Math.max(v3 / BAND_RED.h3, v6 != null ? v6 / BAND_RED.h6 : 0);
        if (!top || sc > top.sc) top = { sc, v3, v6, pn: PT[pid].name, pid, t, hh: t <= msAt(ds, 0) ? '前一天 ' + (jp(t).h || 24) : hourLabel(t, ds) };
      }
    }
    if (top) {
      const red = top.v3 >= BAND_RED.h3 || (top.v6 != null && top.v6 >= BAND_RED.h6);
      const org = red || top.v3 >= BAND_ORG.h3 || (top.v6 != null && top.v6 >= BAND_ORG.h6);
      (seg.bandPts ? snowSigns(ctx, seg, ds, bandS0, we) : winSnow).filter(x => /^气象厅/.test(x)).forEach(x => bandSig.add(x));
      const cmR = v => `约 ${Math.round(v)}–${Math.round(v * 1.6)} cm 雪`;   // 札幌、岩见泽实测大雪时每毫米降水积 1.0–1.6 cm
      const amt = `MSM 算出${top.pn}附近格点到 ${top.hh} 时为止 3 小时降水 ${f1(top.v3)} mm（${cmR(top.v3)}）${top.v6 != null ? `、6 小时 ${f1(top.v6)} mm（${cmR(top.v6)}）` : ''}（只算 0.5 ℃ 以下；取数时间窗是${winTxt}）`;
      // 2026-11-28 定：写出量对红线（不写百分比），以及最近几轮各自的量（data/latest/band_history.json）
      bandOut = { v3: Math.round(top.v3 * 10) / 10, v6: top.v6 != null ? Math.round(top.v6 * 10) / 10 : null, pn: top.pn };
      const by6 = top.v6 != null && top.v6 / BAND_RED.h6 > top.v3 / BAND_RED.h3;
      const vsLine = by6 ? `6 小时 ${f1(top.v6)} mm（红线 ${BAND_RED.h6} mm）` : `3 小时 ${f1(top.v3)} mm（红线 ${BAND_RED.h3} mm）`;
      const prev = bandHistFor(ctx, bandKey(route, seg, ds), ctx.msmInit);
      let histTxt = '', histShort = '';
      if (prev.length) {
        const all = prev.concat([{ init: ctx.msmInit, v3: top.v3, v6: top.v6, pn: top.pn }]);
        const n = all.filter(x => bandOver(x.v3, x.v6)).length, nowOver = bandOver(top.v3, top.v6);
        const tail = nowOver && n === 1 ? '，雪带是这一轮新出现的' : (!nowOver && n > 0 ? '，之前越过线，最新一轮在线下' : '');
        histTxt = `最近几轮 MSM（按起算时刻）的 3 小时最大值：${all.map((x, i) => `${runLabel(x.init)} ${f1(x.v3)} mm${x.v3 < BAND_RED.h3 && x.v6 != null && x.v6 >= BAND_RED.h6 ? `（6 小时 ${f1(x.v6)} mm）` : ''}${x.pn && x.pn !== top.pn ? `（${x.pn}）` : ''}${i === all.length - 1 ? '（最新）' : ''}`).join(' · ')}；${all.length} 轮里 ${n} 轮越线${tail}。地点没注明的和最新一轮相同（${top.pn}附近）。`;
        histShort = `，最近 ${all.length} 轮 ${n} 轮越线${nowOver && n === 1 ? '（新出现）' : ''}`;
      }
      const src = 'Open-Meteo 提供的模式格点数值（MSM）', short = `${top.pn}附近格点雪带 ${vsLine}${histShort}`;
      if (red || (org && !seg.bandNoOrg)) {   // 2026-11-28：出了雪带依据才加表（机场线道央道段只到预警线时不出依据，见下）。依据表原来只列本时段的几个小时，雪带算到的时刻常在时段之前，表里全是 0；这里把算到的那 6 小时（或 3 小时）单列在最前面
        const s = ctx.om.msm.series[top.pid], a = top.t - (top.v6 != null ? 6 : 3) * H;
        const hl = t => (t <= msAt(ds, 0) ? '前一天 ' + (jp(t).h || 24) : pad(hourLabel(t, ds)));
        const rows = []; for (let i = 0; i < s.t.length; i++) if (s.t[i] > a && s.t[i] <= top.t) rows.push({ h: hl(s.t[i]), w: s.W[i], g: s.G[i], sn: s.S[i], rn: s.R[i], t: s.T[i] });
        if (rows.length) raw.unshift({ pid: 'band', model: 'MSM（日本气象厅中尺度模式）', point: `${top.pn}附近的陆地格点：雪带算到的那几个小时（北纬 ${f2(s.lat)}°，东经 ${f2(s.lon)}°）`, rows });
      }
      if (red && bandSig.size) add(mkReason('red', 'R8', `雪带：${amt}，达到 3 小时 7 mm 或 6 小时 10 mm 的红线；气象厅这时也有雪的信号（${[...bandSig].join('、')}）。这种宽二三十公里的雪带，风不大也会让道央道封路（2026-11-25 江别东 IC—美呗 IC 那次就是）。${histTxt}`, src, short, { dk: 'model|band', model: true, rt: '大雪' }));
      else if (red) add(mkReason('orange', 'O9', `雪带：${amt}，达到红线，但气象厅这时没有雪的信号，所以判橙。${histTxt}`, src, short + '，气象厅没有雪的信号', { dk: 'model|band', model: true, rt: '大雪' }));
      else if (org && !seg.bandNoOrg) add(mkReason('orange', 'O9', `雪带预警：${amt}，达到 3 小时 4.5 mm 或 6 小时 6 mm 的橙线（红线是 3 小时 7 mm 或 6 小时 10 mm）。窄雪带前一天能报出“这一带可能有”，报不准落在哪几公里，当天早上要看实况。${histTxt}`, src, short, { dk: 'model|band', model: true, rt: '大雪' }));
    }
  }

  /* 6e. 第 4～6 天的雪带（R8f、O9f；2026-11-28 M 定）：和前 3 天同一个标准，同一种颜色代表同样的危险程度。MSM 算不到这么远，
   * 改看两家全球模式（ECMWF 的 0.25 度版、气象厅 GSM），两家都达到才亮；判红还要气象厅一周预报这天写了雪，没写降为橙（和 R8 一样）。
   * 只用于一日游的去程、回程高速：回测的标签是道央道札幌—旭川段有没有封路。 */
  if (route.id === 'A' && seg.bandPts && offset >= 3 && offset <= 5) {
    const e = farP24(ctx.far.ifs025, ds), g = farP24(ctx.far.gsm, ds);
    if (e == null || g == null) missing.push(e == null ? 'ECMWF（0.25 度版）模式' : 'GSM 模式');
    else {
      const red = e > FAR_BAND.red.e && g > FAR_BAND.red.g, org = e > FAR_BAND.org.e && g > FAR_BAND.org.g;
      const vals = `ECMWF 算出 ${f1(e)} mm（红线 ${FAR_BAND.red.e}、橙线 ${FAR_BAND.org.e} mm），GSM ${f1(g)} mm（红线 ${FAR_BAND.red.g}、橙线 ${FAR_BAND.org.g} mm）`;
      const what = `第 4～6 天的雪带信号：取沿线 9 个点（札幌到深川）里最多的一点，这天全天 0.5 ℃ 以下的降水合计，${vals}`;
      const why = '全球模式一格二三十到五十多公里，峰值被摊平，这些数只能当排名用，不是实际雪量；门槛按 176 天回测定，同一种颜色和前 3 天的封路比例相当。进入前 3 天后改看 MSM。';
      const src = 'Open-Meteo 提供的 ECMWF（0.25 度版）和气象厅 GSM 格点数值';
      const shortV = `两家全球模式都报雪多（ECMWF ${f1(e)}、GSM ${f1(g)} mm）`;
      const wk = farWeekSnow(ctx, ds);
      if (red && wk && wk.snow) add(mkReason('red', 'R8f', `${what}，两家都过红线；气象厅一周预报这天也有雪（${wk.zh}）。回测里这样的日子约七成封过路。${why}`, src, shortV, { dk: 'far|band', model: true, rt: '大雪', allowFar: true }));
      else if (red) add(mkReason('orange', 'O9f', `${what}，两家都过红线，但气象厅一周预报这天${wk ? `没写雪（${wk.zh}）` : '没取到'}，所以判橙。${why}`, src, shortV + '，一周预报没写雪', { dk: 'far|band', model: true, rt: '大雪' }));
      else if (org) add(mkReason('orange', 'O9f', `${what}，两家都过橙线。回测里这样的日子约四成封过路。${why}`, src, shortV, { dk: 'far|band', model: true, rt: '大雪' }));
      else if (e > FAR_BAND.org.e || g > FAR_BAND.org.g) notes.push({ key: 'far1|' + ds, text: `第 4～6 天的雪带信号：只有一家全球模式报雪多（${vals}），两家没有同时到线，按规则不亮。` });
    }
  }

  /* 6c. 当天实况（R9；v6）：沿线 AMeDAS 过去 3 小时。只管今天、开始时刻在最新观测之后 8 小时以内的高速时段 */
  if (offset === 0 && seg.obsSt) {
    const O = ctx.obs;
    if (O && O.ok && !O.stale && ws - O.time <= OBS_AHEAD * H) {
      const ms = seg.obsSt.map(id => O.st[id]).filter(Boolean);
      const pr = ms.filter(m => m.p3 != null && m.p3 >= OBS_P3 && m.cold).sort((a, b) => b.p3 - a.p3);
      const sn = ms.filter(m => m.s3 != null && m.s3 >= OBS_S3).sort((a, b) => b.s3 - a.s3);
      const vl = ['15356', '14163'].map(id => O.st[id]).filter(m => m && m.visLow >= 2);
      const when = fmtHM(O.time), src = `气象厅 AMeDAS 实测，到 ${when} 为止`;
      const snTxt = sn.length ? `；3 小时降雪 ${sn.map(m => `${m.name} ${m.s3} cm`).join('、')}` : '';
      const vlTxt = vl.map(m => `${m.name}最近 1 小时 10 分钟视程有 ${m.visLow} 次不到 ${OBS_VIS} m（最低 ${m.visMin} m）`).join('；');
      if (pr.length) add(mkReason('red', 'R9', `实况：到 ${when} 为止的 3 小时，${pr.map(m => `${m.name}降水 ${f1(m.p3)} mm`).join('、')}，这 3 小时气温都在 0.5 ℃ 以下${snTxt}${vlTxt ? '；' + vlTxt : ''}。正在下这么大的雪，道央道往往已经封了或马上要封。`, src, `${pr[0].name}实测 3 小时降水 ${f1(pr[0].p3)} mm`, { dk: 'obs', rt: '大雪' }));
      else if (sn.length && vl.length) add(mkReason('red', 'R9', `实况：到 ${when} 为止 3 小时降雪 ${sn.map(m => `${m.name} ${m.s3} cm`).join('、')}，并且${vlTxt}。`, src, `${sn[0].name}实测 3 小时降雪 ${sn[0].s3} cm、视程反复低于 ${OBS_VIS} m`, { dk: 'obs', rt: '吹雪' }));
      else if (sn.length) add(mkReason('orange', 'R9o', `实况：到 ${when} 为止 3 小时降雪 ${sn.map(m => `${m.name} ${m.s3} cm`).join('、')}，降雪 ${OBS_S3} cm 以上，但降水量和视程没到红线。`, src, `${sn[0].name}实测 3 小时降雪 ${sn[0].s3} cm`, { dk: 'obs', rt: '大雪' }));
    }
  }

  /* 7. 早期注意信息（［中］［高］） */
  let probGap = false;
  const highs = [];
  const windNote = (key, who, p) => notes.push({ key: 'pw|' + key, text: `${who}：气象厅早期注意信息里出现暴风（暴风雪）警报级天气的可能性为“${p}”，但这段时间的预报和模式都没有雪。只有风、没有雪的情况本页不计等级。` });
  for (const off of offices) {
    const P = ctx.prob.by[off];
    if (!P || !P.ok) { if (offset <= 4) probGap = true; continue; }
    const src = `气象厅早期注意信息，${fmtMD(P.rd)} 发布`;
    used.add('prob:' + off);
    const mySubs = seg.subs.filter(sc => officeOf(sc) === off);
    const ps = P.periods.filter(p => p.s < we && p.e > ws);
    const subPs = ps.filter(p => mySubs.includes(p.code));
    let covered = false;
    const one = (where, v, k, daily, code) => {
      const item = k === 'snow' ? '大雪警报级' : '暴风（暴风雪）警报级', rt = k === 'snow' ? '大雪' : '吹雪';
      if (k === 'wind' && !winSnow.length) { windNote((code || '') + '|' + where, where, v); return; }
      if (v === '高') { highs.push({ where, item, rt, src, daily }); if (k === 'snow') ev.snowJma = true; return; }
      // ［中］的风一项：预报文字本段地区的陆上风没有“やや強く”以上，本段也没有达到 O1 的风雪，就只提醒
      if (k === 'wind' && !((windTxt[code] || 0) >= 1 || ev.windEv)) { notes.push({ key: 'pm|' + where, text: `${where}：气象厅早期注意信息里出现暴风（暴风雪）警报级天气的可能性为“中”，但本段预报的陆上风没有“稍强”以上，气象厅的风速和模式在本段也都没到橙线（沿海市町的暴风基准分陆上、海上两套，这个“中”可能来自海上），所以不计等级。` }); return; }
      add(mkReason('orange', 'O5', `${where}：出现${item}天气的可能性为“中”。单独的“中”最多判橙，可能升级；气象厅每天 05、11、17 时更新。`, src, `${where}出现${item}天气的可能性为“中”`, { rt, dk: 'p5|' + where + '|' + k }));
    };
    if (subPs.length) {
      covered = true;
      for (const p of subPs) { const where = `${SUB[p.code]}${periodLabel(p.s, p.e)}`; if (p.snow) one(where, p.snow, 'snow', false, p.code); if (p.wind) one(where, p.wind, 'wind', false, p.code); }
      for (const p of ps.filter(p => route.offRoute.includes(p.code))) {
        for (const [k, item] of [['snow', '大雪'], ['wind', '暴风（暴风雪）']]) if (p[k] === '中' || p[k] === '高')
          notes.push({ key: 'po|' + p.code + '|' + p.s + '|' + k, text: `邻近的${SUB[p.code]}（本段不经过）${periodLabel(p.s, p.e)}：出现${item}警报级天气的可能性为“${p[k]}”。不经过的地区本页不计等级。` });
      }
    } else {
      const dAll = P.daily.filter(d => d.date === ds);
      const dSub = dAll.filter(d => mySubs.includes(d.code));
      const ds0 = dSub.length ? dSub : dAll.filter(d => !SUB[d.code]);
      if (ds0.length) {
        covered = true;
        for (const d of ds0) {
          const where = `${SUB[d.code] || OFFICE[off]}${dayNum(ds)}日`;
          if (d.snow) one(where, d.snow, 'snow', true, d.code);
          if (d.wind) one(where, d.wind, 'wind', true, d.code);
        }
      }
    }
    if (!covered && offset === 0 && P.minStart != null && we <= P.minStart) covered = true;
    if (!covered && (offset <= 4 || ds <= P.maxDate)) probGap = true;
  }
  if (probGap) missing.push('早期注意信息');
  // ［高］：本段有橙级佐证（O1、O2 或警报注意报，以及更高的）就判红，没有判橙；只按整个预报区给的日子只认模式的佐证
  if (highs.length) {
    const EVID = new Set(['O1', 'O2', 'W2', 'K1', 'K4', 'R1', 'R2', 'R3', 'R4', 'R4m', 'R5', 'R8', 'O9', 'R9', 'R9o']);
    const evid = R.filter(r => RANK[r.level] >= RANK.orange && EVID.has(r.rule));
    highs.forEach(h => {
      const evs = h.daily ? evid.filter(r => r.model) : evid;
      if (evs.length) add(mkReason('red', 'R7', `${h.where}：出现${h.item}天气的可能性为“高”，本段也有佐证（${evs[0].short}${h.daily ? '；这几天只有模式的数，模式只有一家' : ''}）。`, h.src, `${h.where}出现${h.item}天气的可能性为“高”，本段有佐证`, { rt: h.rt, allowFar: h.daily, dk: 'p7|' + h.where + h.item }));
      else add(mkReason('orange', 'R7o', `${h.where}：出现${h.item}天气的可能性为“高”，但本段没有橙级佐证（气象厅给了“高”，本段没有佐证），所以判橙，可能升级。`, h.src, `${h.where}出现${h.item}天气的可能性为“高”（本段没有佐证）`, { rt: h.rt, dk: 'p7o|' + h.where + h.item }));
    });
  }
  // K2(2) 只满足一半：可能升到⬛
  if (kModel) {
    const offHalf = official.includes('早期注意信息［高］') || official.includes('大雪警报') || official.includes('暴风雪警报');
    if (offHalf) add(mkReason('red', 'K2', `可能升到“交通瘫痪”：气象厅有［高］或大雪警报，MSM 也算出 ${kModel.pn}附近 12 小时 ${f1(kModel.v12)} mm、24 小时 ${f1(kModel.v24)} mm（0 ℃ 以下）。还要看气象厅写的 24 小时预想降雪是否到 50 cm，本页没有读这一项，所以先判红。`, mSrc(['MSM']), `MSM 降水达到极端暴雪线，气象厅也有信号`, { rt: '大雪', model: true, dk: 'model|k2' }));
  }

  /* 8. 集合预报（第 4 天起，只写数，最多判橙） */
  if (offset >= 3) {
    const E = ctx.ens;
    const useA = route.id === 'A' && route.ens.segs.includes(seg.id);
    const useB = route.id === 'B';
    if (useA || useB) {
      if (!E.ok) missing.push('集合预报');
      else {
        used.add('ens');
        const pick = useA ? [[0, ROUTE_A.ens.name]] : (seg.id === 'B2' ? [[2, '新千岁机场']] : [[1, '小樽']]);
        for (const [ix, nm] of pick) {
          const c = E.counts[ix] && E.counts[ix][ds];
          if (!c || !c.n) { missing.push('集合预报'); continue; }
          const n = c.n, t15 = Math.ceil(15 * n / 51);
          const txt = `ECMWF 集合预报的 ${n} 个成员里，当天在${nm}附近格点算出“风速 ${W_RED} m/s 以上并有降雪”的有 ${c.nR} 个，“${W_ORANGE} m/s 以上并有降雪”（橙线）的有 ${c.nO} 个`;
          if (ix !== 1 && c.nR >= t15) add(mkReason('orange', 'E1', `${txt}。第 4 天起最多判橙，可能升级。`, `Open-Meteo 提供的 ECMWF 集合预报（${n} 个成员）`, `${nm}附近格点：集合预报 ${c.nR}/${n} 个成员到红线`, { rt: '吹雪', model: true }));
          else notes.push({ key: 'ens|' + ix + '|' + ds, text: `${txt}${ix === 1 ? '（这个格点包含大片海面，风速偏大，只作参考）' : ''}。` });
          ctxInfo.push({ ens: true, nm, n, nR: c.nR, nO: c.nO });
        }
      }
    }
  }

  /* 6d. 实况优先（2026-11-26 定）：今天已经开始或 3 小时内开始的时段，危险度时间序列报的雪、风＋雪和着雪注意报，
   * 如果本段各站最近 1 小时是 1 ℃ 以上的雨或没下、平均风不到 8 m/s，并且 MSM 接下来 3 小时没有 0.5 ℃ 以下的降水，就不计等级 */
  if (offset === 0 && seg.nowSt && ctx.obs && ctx.obs.ok && !ctx.obs.stale && ctx.obs.map && ws - ctx.obs.time <= 3 * H) {
    const ms = seg.nowSt.map(id => ctx.obs.map[id]).filter(Boolean);
    const okSt = ms.length === seg.nowSt.length && ms.every(m => m.wind != null && m.wind < 8 && (m.p1 === 0 || (m.p1 != null && m.T != null && m.T >= 1)));
    const M = ctx.om.msm;
    let msmWarm = false;
    if (okSt && M && M.ok) {
      const t1 = ctx.obs.time, t2 = t1 + 3 * H;
      let n = 0, cold = false;
      (seg.bandPts || seg.pts).forEach(pid => { const s = M.series[pid]; if (!s) return; for (let i = 0; i < s.t.length; i++) { const t = s.t[i]; if (t > t1 && t <= t2) { n++; if (s.P[i] != null && s.P[i] > 0 && s.T[i] != null && s.T[i] <= BAND_T) cold = true; } } });
      msmWarm = n > 0 && !cold;
    }
    if (okSt && msmWarm) {
      const drop = R.filter(r => (/^tl\|/.test(r.dk || '') && !/^tl\|O2\|ava/.test(r.dk)) || r.dk === 'warn|26');
      if (drop.length) {
        const keep = R.filter(r => !drop.includes(r)); R.length = 0; keep.forEach(r => R.push(r));
        const stTxt = ms.map(m => `${m.name}${m.p1 ? ` ${f1(m.p1)} mm` : '没下'}、${f1(m.T)} ℃、风 ${f1(m.wind)} m/s`).join('；');
        notes.push({ key: 'nowover|' + seg.id + '|' + ds, text: `实况优先：到 ${fmtHM(ctx.obs.mapTime || ctx.obs.time)} 本段各站是 1 ℃ 以上的雨或没下、风不到 8 m/s（${stTxt}），MSM 接下来 3 小时也不转雪，所以气象厅危险度时间序列这一时段报的雪${drop.some(r => r.dk === 'warn|26') ? '和着雪注意报' : ''}不计等级（${drop.map(r => r.short).join('；')}）。` });
      }
    }
  }

  /* 汇总 */
  // O8：模式单独判红，要有气象厅或另一个模式的佐证，没有就降为橙
  R.forEach(r => {
    if (r.rule === 'R4m' && r.level === 'red' && !r.support && !ev.snowJma) {
      r.level = 'orange'; r.rule = 'O8'; r.tpl = null; r.areas = null;
      r.text += '只有一个模式算到这个量，气象厅和另一个模式都没有对应信号，所以降为橙。'; r.short += '（只有一个模式）';
    }
  });
  // 第 4 天起最高判橙（［高］加模式佐证的例外除外）
  if (offset >= 3) R.forEach(r => {
    if (RANK[r.level] >= RANK.red && !r.allowFar) { r.level = 'orange'; r.tpl = null; r.areas = null; r.text += '第 4 天起最多判橙，可能升级。'; r.short += '（第 4 天起最多判橙）'; }
  });
  let level = 'green';
  R.forEach(r => { level = maxLv(level, r.level); });
  const staleUsed = [...used].filter(k => ctx.stale && ctx.stale[k]).map(k => STALE_NAME[k.split(':')[0]] || k);
  if (staleUsed.length) missing.push(`偏旧的数据（${[...new Set(staleUsed)].join('、')}）`);
  const uniqMissing = [...new Set(missing)];
  if (level === 'green' && uniqMissing.length) level = 'gray';
  const seen = new Set(), reasons = [];
  R.sort(byLevelPrio).forEach(r => { if (!seen.has(r.text)) { seen.add(r.text); reasons.push(r); } });
  if (level === 'green' || level === 'gray') {
    const mw = ctxInfo.filter(c => !c.ens && c.W != null).sort((a, b) => b.W - a.W)[0];
    const mv = ctxInfo.find(c => c.vis != null);
    if (mw) reasons.push(mkReason('green', 'ctx', `这段时间，模式数值里风最大的是${mw.pn}附近的格点：${mw.hh} 时 ${f1(mw.W)} m/s（${mw.label}）${mv ? `；推定视程最低${mv.vis >= 10000 ? '也在 10 km 以上' : '约 ' + visTxt(mv.vis)}（${mv.pn}，${mv.m}）` : ''}。`, 'Open-Meteo 提供的模式格点数值'));
    const en = ctxInfo.find(c => c.ens);
    if (en) reasons.push(mkReason('green', 'ctx', `ECMWF 集合预报的 ${en.n} 个成员里，当天算出“风速 ${W_RED} m/s 以上并有降雪”的有 ${en.nR} 个，“${W_ORANGE} m/s 以上并有降雪”的有 ${en.nO} 个（${en.nm}附近格点）。`, 'Open-Meteo 提供的 ECMWF 集合预报'));
  }
  if (level === 'gray' && !reasons.some(r => r.level === 'gray')) reasons.unshift(mkReason('gray', 'miss', `缺少数据：${uniqMissing.join('、')}，所以不能给绿色。`, ''));
  const out = reasons.map(r => (r.rt && RANK[r.level] >= RANK.orange && !/^［/.test(r.text) ? Object.assign({}, r, { text: `［${r.rt}］${r.text}` }) : r));
  return { past: false, level, reasons: out, missing: uniqMissing, notes, raw: raw.map(({ pid, ...r }) => r), band: bandOut };
}

/* 集合预报按天计数：每个成员在这一天任一时次“风速 ≥ 14 m/s 且降雪 > 0”算 1 个（nR）；“≥ 8 m/s 且降雪 > 0”算 nO */
function ensCounts(E) {
  return (E || []).map(p => {
    if (!p) return null;
    const days = {};
    p.t.forEach(t => { const ds = dateStr(t); days[ds] = days[ds] || { nR: 0, nO: 0, n: p.mem.length }; });
    for (const m of p.mem) {
      const hR = new Set(), hO = new Set();
      p.t.forEach((t, i) => {
        const w = m.w[i], s = m.s[i];
        if (w == null || s == null || !(s > 0)) return;
        const ds = dateStr(t);
        if (w >= W_RED) hR.add(ds);
        if (w >= W_ORANGE) hO.add(ds);
      });
      hR.forEach(ds => { days[ds].nR++; });
      hO.forEach(ds => { days[ds].nO++; });
    }
    return days;
  });
}


/* 把各段（格）的依据合成当天的依据：同一条信号只留一条，地区、市町村合并 */
function mergeNotes(lists) {
  // 普通提醒按 key 去重；带 tpl 的（市町村、时段可合并的）把各段（格）的市町村和时段并起来再出文字
  const map = new Map(), out = [];
  (lists || []).forEach(l => (l || []).forEach(n => {
    const m = map.get(n.key);
    if (!m) { const o = n.tpl ? { key: n.key, munis: n.munis.slice(), blocks: (n.blocks || []).slice(), tpl: n.tpl } : n; map.set(n.key, o); out.push(o); return; }
    if (!n.tpl) return;
    n.munis.forEach(x => { if (!m.munis.includes(x)) m.munis.push(x); });
    (n.blocks || []).forEach(b => { if (!m.blocks.some(y => y.s === b.s)) m.blocks.push(b); });
  }));
  return out.map(n => (n.tpl ? n.tpl(n.munis, n.blocks.sort((a, b) => a.s - b.s)) : n.text));
}
function aggregateReasons(units, nameOf, allCount, groupOf) {
  const agg = new Map();
  units.forEach(u => u.reasons.forEach(r => {
    if (r.level === 'green' || r.level === 'gray') return;
    const k = r.dk.startsWith('model|') ? (groupOf || nameOf)(u) + '|' + r.dk : r.dk;
    if (!agg.has(k)) agg.set(k, Object.assign({}, r, { segs: [], areas: r.areas ? [] : null }));
    const a = agg.get(k);
    if (!a.segs.includes(nameOf(u))) a.segs.push(nameOf(u));
    if (r.areas) r.areas.forEach(x => { if (!a.areas.includes(x)) a.areas.push(x); });
  }));
  const out = [];
  agg.forEach(a => {
    if (a.areas && a.tpl) { a.text = a.tpl(a.areas); a.short = a.shf(a.areas); }
    a.seg = a.segs.length === allCount && allCount > 1 ? '全程' : a.segs.join('、');
    out.push(a);
  });
  return out.sort(byLevelPrio);
}

/* ---------------- 组装 VIEW ---------------- */
function headlineOf(reasons, level, where, missing) {
  if (level === 'green') return '规则用到的数据都没有超过门槛，没有触发任何规则（不等于安全）。';
  const lack = (missing || []).filter(m => !/^偏旧/.test(m)), old = (missing || []).find(m => /^偏旧/.test(m));
  const oldTxt = old ? `有的数据偏旧${old.replace(/^偏旧的数据/, '')}` : '';
  if (level === 'gray') return `无法判定：${[lack.length ? '缺少' + lack.join('、') : '', oldTxt].filter(Boolean).join('；') || '缺少数据'}。`;
  const top = reasons.filter(r => r.level === level);
  if (!top.length) return '';
  const kinds = new Set(top.map(r => r.rule));
  const onlyModel = level === 'red' && top.every(r => r.model) && !reasons.some(r => !r.model && RANK[r.level] >= RANK.orange && r.rule !== 'O5' && r.rule !== 'R7o');
  let h = where ? `${where}。` : '';
  const rt = top[0].rt ? `（${top[0].rt}）` : '';
  if (onlyModel) h += `红色只来自数值模式（${top[0].short}）；气象厅目前没有对应时段的警报级信息。`;
  else h += `主要依据${rt}：${top[0].short}${kinds.size > 1 ? '；另有其他依据' : ''}。`;
  if (lack.length || oldTxt) h += `另外${[lack.length ? '缺少' + lack.join('、') : '', oldTxt].filter(Boolean).join('，')}，实际等级可能更高。`;
  return h;
}
// 2026-11-28 改为按路段分写（原来把两段的时段并在一起写“两段路都……”，会让人以为两段整段时间都是这个等级）
function cellsWhere(route, cells, level) {
  const parts = route.rows.map((r, ri) => {
    const hit = route.cols.map((c, ci) => cells[ri][ci].level === level && !cells[ri][ci]._past);
    const ranges = []; let start = null;
    route.cols.forEach(([a, b], ci) => { if (hit[ci]) { if (start == null) start = a; if (ci === route.cols.length - 1 || !hit[ci + 1]) { ranges.push(`${pad(start)}–${pad(b)}`); start = null; } } });
    return ranges.length ? `${r.name} ${ranges.join('、')} 时` : null;
  }).filter(Boolean);
  return `${parts.join('，')}${LV_WORD[level] || ''}`;
}
function dayJma(ctx, route, ds) {
  const out = { forecast: [], early: [], earlyNote: '', timeline: [] };
  const subs = route.subs;
  for (const sc of subs) {
    const f = ctx.fc[officeOf(sc)];
    const d = f && f.ok && f.short[sc] && f.short[sc].days[ds];
    if (d && d.weather) out.forecast.push({ area: SUB[sc], ja: d.weather.replace(/[　]+/g, ' '), zh: zhForecast(d.weather), windJa: d.wind ? d.wind.replace(/[　]+/g, ' ') : '', windZh: zhForecast(d.wind, true) });
  }
  if (!out.forecast.length) {
    const offs = [...new Set(subs.map(officeOf))];
    for (const off of offs) {
      const f = ctx.fc[off];
      const d = f && f.ok && f.week && f.week.days[ds];
      if (d && d.wcode) {
        const rel = { A: 'A（高）', B: 'B（中）', C: 'C（低，预报可能大改）' }[d.rel] || '';
        const bits = [];
        if (d.pop !== '') bits.push(`降水概率 ${d.pop}%`);
        if (rel) bits.push(`可信度 ${rel}`);
        if (d.tmin !== '' || d.tmax !== '') bits.push(`${f.week.station}气温 ${d.tmin || '—'} ～ ${d.tmax || '—'} ℃`);
        out.forecast.push({ area: OFFICE[off] + '（一周预报）', ja: '', zh: TELOPS_ZH[d.wcode] || `天气代码 ${d.wcode}`, windJa: '', windZh: bits.join('，') });
      }
    }
  }
  const prob = ctx.prob;
  if (!prob.ok) out.earlyNote = '早期注意信息没取到。';
  else {
    const dayS = msAt(ds, 0), dayE = msAt(ds, 24);
    const ps = prob.periods.filter(p => p.s < dayE && p.e > dayS && (subs.includes(p.code) || route.offRoute.includes(p.code)));
    if (ps.length) {
      ps.forEach(p => {
        for (const [k, item] of [['snow', '大雪'], ['wind', '暴风（暴风雪）']]) if (p[k] === '中' || p[k] === '高')
          out.early.push({ area: SUB[p.code] + (route.offRoute.includes(p.code) ? '（不在路线上）' : ''), item: item + '警报级', level: p[k], period: periodLabel(p.s, p.e) });
      });
      if (!out.early.length) out.earlyNote = `当天沿线各地区出现大雪、暴风雪警报级天气的可能性都是空白（${fmtMD(prob.rd)} 发布）。`;
    } else {
      const offs = [...new Set(subs.map(officeOf))];
      const dl = prob.daily.filter(d => d.date === ds && offs.includes(d.code));
      dl.forEach(d => { for (const [k, item] of [['snow', '大雪'], ['wind', '暴风（暴风雪）']]) if (d[k] === '中' || d[k] === '高') out.early.push({ area: (OFFICE[d.code] || SUB[d.code] || d.code) + '（未细分）', item: item + '警报级', level: d[k], period: `${dayNum(ds)}日全天` }); });
      if (!out.early.length) out.earlyNote = dl.length ? `当天出现大雪、暴风雪警报级天气的可能性是空白（${fmtMD(prob.rd)} 发布）。` : `早期注意信息只发到 ${dayNum(prob.maxDate)} 日，这一天还没有。`;
    }
  }
  const tlAreas = route.id === 'A' ? [['016000', '016010'], ['016000', '016020'], ['012000', '012010']] : [['016000', '016030'], ['016000', '016010']];
  for (const [off, sc] of tlAreas) {
    const tl = ctx.tl[off];
    if (!tl || !tl.ok) continue;
    const A = tl.areas[sc]; if (!A) continue;
    const cols = [], wind = [], snow6h = [];
    tl.blocks.forEach((b, i) => { if (dateStr(b.s) !== ds) return; const a = jp(b.s).h, e = jp(b.e).h || 24; cols.push(`${pad(a)}-${pad(e)}`); wind.push((A.wind || [])[i]); snow6h.push((A.snow6 || [])[i]); });
    if (cols.length) out.timeline.push({ area: SUB[sc], cols, wind, snow6h });
  }
  return out;
}

function buildRouteDays(ctx, route) {
  const days = [];
  for (let k = 0; k < NDAYS; k++) {
    const ds = addDays(ctx.today, k);
    const p = jp(msAt(ds, 12));
    const day = { date: ds, label: `${p.d}日`, dow: DOW[p.dow], isToday: k === 0, trend: k >= 3 };
    let level = 'green', reasons = [], missing = [];
    if (route.kind === 'timeline') {
      day.segments = route.segments.map(seg => {
        const r = evalWindow(ctx, route, seg, ds, k);
        return Object.assign({ id: seg.id, name: seg.name, time: seg.time, places: seg.places }, { level: r.level, reasons: r.reasons, raw: r.raw, past: r.past, band: r.band || null, _past: r.past, _missing: r.missing, _notes: r.notes });
      });
      const live = day.segments.filter(s => !s._past);
      if (!live.length) { level = 'gray'; day.past = true; reasons = [mkReason('gray', 'past', '今天一日游的时段已经过去，请看明天及之后的日子。', '')]; day.headline = '今天的行程时段已过。'; }
      else {
        level = live.reduce((a, s) => maxLv(a, s.level), 'green');
        live.forEach(s => s._missing.forEach(m => { if (!missing.includes(m)) missing.push(m); }));
        if (level === 'green' && missing.length) level = 'gray';
        reasons = aggregateReasons(live, u => u.name, live.length);
        const segNames = live.filter(s => s.level === level).map(s => s.name);
        const word = LV_WORD[level] || '';
        day.headline = headlineOf(reasons, level, RANK[level] >= RANK.orange ? (segNames.length === live.length && live.length > 1 ? '全程' + word : segNames.join('、') + word) : '', missing);
        if (level === 'green') reasons = live.flatMap(s => s.reasons.filter(r => r.rule === 'ctx').map(r => Object.assign({}, r, { text: `${s.name}：${r.text}` }))).slice(0, 4);
      }
      day.notes = mergeNotes(live.map(s => s._notes));
      day.segments.forEach(s => { delete s._past; delete s._missing; delete s._notes; });
    } else {
      const cols = route.cols.map(([a, b]) => `${pad(a)}–${pad(b)}`);
      const cells = route.rows.map(row => route.cols.map(([a, b]) => {
        const seg = Object.assign({}, row, { h0: a, h1: b });
        const r = evalWindow(ctx, route, seg, ds, k);
        return { level: r.level, reasons: r.reasons, raw: r.raw, past: r.past, band: r.band || null, _past: r.past, _missing: r.missing, _notes: r.notes, _row: row.name, _col: `${pad(a)}–${pad(b)}` };
      }));
      // 高速封闭的解除一般要等除雪、巡查结束：红格之后的一格至少是橙
      cells.forEach(row => row.forEach((c, ci) => {
        const prev = row[ci - 1];
        if (!prev || prev._past || c._past) return;
        if (prev.level === 'black' && RANK[c.level] < RANK.red) {
          c.level = 'red';
          c.reasons = [mkReason('red', 'H2', '［其他］前一个时段可能交通瘫痪。高速封闭要等 NEXCO 公告解除，除雪、巡查常常要好几个小时，这个时段按不宜出行算。', '本页规则', '前一时段可能交通瘫痪，封闭解除有滞后', { rt: '其他' })].concat(c.reasons.filter(r => r.level !== 'green'));
        } else if (prev.level === 'red' && (c.level === 'green' || c.level === 'gray')) {
          c.level = 'orange';
          c.reasons = [mkReason('orange', 'H1', '［其他］前一个时段不宜出行。高速公路封闭的解除一般要等除雪、巡查结束，常常比天气好转晚几个小时。', '本页规则', '前一时段不宜出行，封闭解除常有滞后', { rt: '其他' })].concat(c.reasons.filter(r => r.level !== 'green'));
        }
      }));
      const live = cells.flat().filter(c => !c._past);
      if (!live.length) { level = 'gray'; day.past = true; reasons = [mkReason('gray', 'past', '今天的时段都已经过去，请看明天及之后的日子。', '')]; day.headline = '今天的时段已过。'; }
      else {
        level = live.reduce((a, c) => maxLv(a, c.level), 'green');
        live.forEach(c => c._missing.forEach(m => { if (!missing.includes(m)) missing.push(m); }));
        if (level === 'green' && missing.length) level = 'gray';
        reasons = aggregateReasons(live, u => u._col + ' 时' + u._row, -1, u => u._row).map(r => Object.assign(r, { cell: r.segs[0], seg: '' }));
        day.headline = headlineOf(reasons, level, RANK[level] >= RANK.orange ? cellsWhere(route, cells, level) : '', missing);
        if (level === 'green') reasons = [mkReason('green', 'ctx', '6 个时段、两段路都没有触发规则。', '')];
      }
      day.notes = mergeNotes(live.map(c => c._notes));
      day.grid = { rows: route.rows.map(r => ({ id: r.id, name: r.name, places: r.places })), cols, cells: cells.map(row => row.map(c => { delete c._past; delete c._missing; delete c._notes; delete c._row; delete c._col; return c; })) };
    }
    day.level = level;
    day.reasons = reasons.slice(0, 10).map(r => {
      const t0 = r.rt && RANK[r.level] >= RANK.orange && !/^［/.test(r.text) ? `［${r.rt}］${r.text}` : r.text;
      return { level: r.level, text: r.seg ? `【${r.seg}】${t0}` : (r.cell && r.dk && r.dk.startsWith('model|') ? `【最早在 ${r.cell}】${t0}` : t0), src: r.src };
    });
    day.missing = missing;
    day.jma = dayJma(ctx, route, ds);
    days.push(day);
  }
  return days;
}

function srcStatus(name, st, rd, note) { return { name, status: st, reportTime: rd ? fmtMD(rd) + ' 发布' : '', note: note || '' }; }

function buildView(raw, now) {
  const today = dateStr(now);
  const ctx = { now, today };
  // 早期注意情報：两个预报区分开记，取到哪一份就用哪一份
  const probBy = {};
  for (const [off, key] of [['016000', 'prob016'], ['012000', 'prob012']]) {
    const r = raw[key];
    if (r && r.ok) {
      const d = r.data, dates = d.periods.map(p => dateStr(p.e - 1)).concat(d.daily.map(x => x.date)).sort();
      probBy[off] = { ok: true, rd: d.rd, periods: d.periods, daily: d.daily, minStart: d.minStart, maxDate: dates[dates.length - 1] || today };
    } else probBy[off] = { ok: false };
  }
  const okProbs = Object.values(probBy).filter(p => p.ok);
  ctx.prob = { by: probBy, ok: okProbs.length > 0, partial: okProbs.length === 1, rd: okProbs.length ? Math.min(...okProbs.map(p => p.rd)) : null,
    periods: [].concat(...okProbs.map(p => p.periods)), daily: [].concat(...okProbs.map(p => p.daily)), maxDate: okProbs.map(p => p.maxDate).sort().slice(-1)[0] || today };
  // 警报：同样分开记
  const warnBy = {};
  for (const [off, key] of [['016000', 'warn016'], ['012000', 'warn012']]) { const r = raw[key]; warnBy[off] = r && r.ok ? { ok: true, areas: r.data.areas, rd: r.data.rd } : { ok: false, areas: {} }; }
  ctx.warn = { by: warnBy, areas: Object.assign({}, warnBy['016000'].areas, warnBy['012000'].areas) };
  // 预报
  ctx.fc = {};
  for (const [k, key] of [['016000', 'fc016'], ['012000', 'fc012']]) { const r = raw[key]; ctx.fc[k] = r && r.ok ? Object.assign({ ok: true }, r.data) : { ok: false }; }
  // 时间序列
  ctx.tl = {};
  for (const [k, key] of [['016000', 'tl016'], ['012000', 'tl012']]) { const r = raw[key]; ctx.tl[k] = r && r.ok ? Object.assign({ ok: true }, r.data) : { ok: false }; }
  // 地域时序预报（不算必需：没取到不影响给绿色）
  ctx.vp = {};
  for (const sc of ['016010', '016020', '016030', '012010']) { const r = raw['vp' + sc]; ctx.vp[sc] = r && r.ok ? Object.assign({ ok: true }, r.data) : { ok: false }; }
  // 解说情报
  ctx.infoOk = !!(raw.info && raw.info.ok);
  ctx.bulletins = ctx.infoOk ? activeBulletins(raw.info.data, now).map(b => {
    const r = b.jsonName ? raw['bul_' + b.jsonName] : null;
    const body = r && r.ok ? r.data : null;
    // 正文里所有时段都已经结束：这份解说已经过期，不再提示（仍列在数据自检里）
    const ends = body ? [].concat(...body.sentences.filter(sn => sn.ok).map(sn => sn.groups.map(g => g.e))) : [];
    const expired = !!body && body.parsedAll && ends.length > 0 && ends.every(e => e != null && e <= now);
    return Object.assign({}, b, { body, bodyErr: body ? '' : (!b.jsonName ? '列表里没有正文的文件名' : r ? r.err : '正在取'), expired });
  }) : [];
  // 模式
  ctx.om = {};
  for (const mk of ['msm', 'ifs']) {
    const r = raw[mk];
    if (r && r.ok && Array.isArray(r.data)) { const series = {}; PTS.forEach((p, i) => { series[p.id] = withQ(r.data[i]); }); ctx.om[mk] = { ok: true, series }; }
    else ctx.om[mk] = { ok: false };
  }
  ctx.far = {};
  for (const mk of ['ifs025', 'gsm']) { const r = raw[mk]; ctx.far[mk] = r && r.ok && Array.isArray(r.data) && r.data.length === FAR_PTS.length ? { ok: true, data: r.data } : { ok: false }; }
  ctx.msmInit = raw.meta_msm && raw.meta_msm.ok && raw.meta_msm.data ? raw.meta_msm.data.init : null;
  ctx.bandHist = raw.bandhist && raw.bandhist.ok ? raw.bandhist.data : null;
  ctx.ens = raw.ens && raw.ens.ok ? { ok: true, counts: ensCounts(raw.ens.data) } : { ok: false };
  ctx.obs = obsCtx(raw.obs, now);

  /* 数据新旧：偏旧的数据判红、判橙照用，但用到它的时段不给绿色 */
  ctx.stale = {};
  const LIM = { prob: 13, fc: 13, tl: 8 };
  for (const [off, k1, k2, k3] of [['016000', 'prob016', 'fc016', 'tl016'], ['012000', 'prob012', 'fc012', 'tl012']]) {
    for (const [kind, key] of [['prob', k1], ['fc', k2], ['tl', k3]]) { const r = raw[key]; if (r && r.ok && r.data.rd && now - r.data.rd > LIM[kind] * H) ctx.stale[kind + ':' + off] = true; }
  }
  const initOf = mk => (raw['meta_' + mk] && raw['meta_' + mk].ok && raw['meta_' + mk].data ? raw['meta_' + mk].data.init : null);
  for (const [mk, lim] of [['msm', 18], ['ifs', 24]]) { const init = initOf(mk); if (raw[mk] && raw[mk].ok && (!init || now - init > lim * H)) ctx.stale[mk] = true; }

  /* 数据自检 */
  const sources = [];
  const jmaSrc = (name, key, staleKey, lim) => {
    const r = raw[key];
    if (!r) return srcStatus(name, 'loading');
    if (!r.ok) return srcStatus(name, 'error', null, r.err);
    const st = staleKey && ctx.stale[staleKey];
    return srcStatus(name, st ? 'stale' : 'ok', r.data.rd, st ? `超过 ${lim} 小时没有更新，用到它的时段不显示绿色。` : '');
  };
  sources.push(jmaSrc('气象厅 早期注意信息（石狩、空知、后志预报区）', 'prob016', 'prob:016000', 13));
  sources.push(jmaSrc('气象厅 早期注意信息（上川、留萌预报区）', 'prob012', 'prob:012000', 13));
  sources.push(jmaSrc('气象厅 警报、注意报（石狩、空知、后志预报区）', 'warn016'));
  sources.push(jmaSrc('气象厅 警报、注意报（上川、留萌预报区）', 'warn012'));
  sources.push(jmaSrc('气象厅 天气预报与一周预报（石狩、空知、后志预报区）', 'fc016', 'fc:016000', 13));
  sources.push(jmaSrc('气象厅 天气预报与一周预报（上川、留萌预报区）', 'fc012', 'fc:012000', 13));
  sources.push(jmaSrc('气象厅 危险度时间序列（石狩、空知、后志预报区）', 'tl016', 'tl:016000', 8));
  sources.push(jmaSrc('气象厅 危险度时间序列（上川、留萌预报区）', 'tl012', 'tl:012000', 8));
  {
    const vs = ['016010', '016020', '016030', '012010'].map(sc => raw['vp' + sc]);
    const okv = vs.filter(r => r && r.ok);
    if (vs.some(r => !r)) sources.push(srcStatus('气象厅 地域时序预报（石狩、空知、后志、上川地区）', 'loading'));
    else sources.push(srcStatus('气象厅 地域时序预报（石狩、空知、后志、上川地区）', okv.length === 4 ? 'ok' : 'error', okv.length ? Math.max(...okv.map(r => r.data.rd)) : null, okv.length === 4 ? '今天、明天各地区 3 小时一格的天气和风速范围。' : `有 ${4 - okv.length} 个地区没取到；这一项不是必需的，不影响给绿色。`));
  }
  if (!raw.info) sources.push(srcStatus('气象厅 气象解说信息', 'loading'));
  else if (!raw.info.ok) sources.push(srcStatus('气象厅 气象解说信息', 'error', null, raw.info.err + '（今后 3 天不显示绿色）'));
  else {
    const bad = ctx.bulletins.filter(b => !b.body && b.bodyErr !== '正在取');
    const desc = b => `《${zhTitle(b.title)}》第 ${b.serial} 号（${fmtMD(b.rd)}）${b.body ? (b.expired ? '，所说的时段都已结束' : b.body.parsedAll ? '，正文已读' : '，正文有一部分没能自动拆开') : '，正文' + (b.bodyErr === '正在取' ? '正在取' : '没取到：' + b.bodyErr)}`;
    sources.push(srcStatus('气象厅 气象解说信息', bad.length ? 'error' : 'ok', null, ctx.bulletins.length ? `最近 72 小时发布过：${ctx.bulletins.map(desc).join('；')}。${bad.length ? '没取到正文的那几份所涉及的今后 3 天不显示绿色。' : ''}` : '最近 72 小时没有与路线相关的气象解说信息。'));
  }
  for (const [mk, name, lim] of [['msm', 'Open-Meteo：日本气象厅 MSM 模式（中尺度数值预报，约 78 小时）', 18], ['ifs', 'Open-Meteo：ECMWF IFS 模式（欧洲中期天气预报中心的全球模式）', 24]]) {
    const r = raw[mk];
    if (!r) { sources.push(srcStatus(name, 'loading')); continue; }
    if (!r.ok) { sources.push(srcStatus(name, 'error', null, r.err)); continue; }
    const init = initOf(mk), st = ctx.stale[mk];
    sources.push(srcStatus(name, st ? 'stale' : 'ok', null, init ? `这一轮的起算时刻是 ${fmtMD(init)}${st ? `，超过 ${lim} 小时，用到它的时段不显示绿色` : ''}。` : '没取到这一轮的起算时刻，无法确认新旧，按偏旧处理。'));
  }
  for (const [mk, name] of [['ifs025', 'Open-Meteo：ECMWF IFS 0.25 度版（第 4～6 天的雪带用）'], ['gsm', 'Open-Meteo：日本气象厅 GSM 全球模式（第 4～6 天的雪带用）']]) {
    const r = raw[mk];
    if (!r) sources.push(srcStatus(name, 'loading'));
    else if (!r.ok) sources.push(srcStatus(name, 'error', null, r.err + '（一日游第 4～6 天的去程、回程高速因此不显示绿色）'));
    else sources.push(srcStatus(name, 'ok', null, '沿线 9 个点，只用于一日游第 4～6 天的去程、回程高速。'));
  }
  if (!raw.bandhist) sources.push(srcStatus('本站存档：雪带最近几轮', 'loading'));
  else if (!raw.bandhist.ok) sources.push(srcStatus('本站存档：雪带最近几轮', 'error', null, raw.bandhist.err + '（只少了雪带依据里“最近几轮”那一句，不影响判级）'));
  else { const rs = raw.bandhist.data; sources.push(srcStatus('本站存档：雪带最近几轮', 'ok', null, rs.length ? `GitHub 上每 3 小时用本页同一个程序算一次存下，现有 ${rs.length} 轮，最新一轮起算于 ${fmtMD(rs[rs.length - 1].init)}。` : '还没有存下的轮次。')); }
  const ensN = ctx.ens.ok ? Math.max(0, ...ctx.ens.counts.filter(Boolean).map(d => Math.max(0, ...Object.values(d).map(x => x.n || 0)))) : 0;
  if (!raw.ens) sources.push(srcStatus('Open-Meteo：ECMWF 集合预报', 'loading'));
  else sources.push(raw.ens.ok ? srcStatus('Open-Meteo：ECMWF 集合预报', 'ok', null, `${ensN} 个成员，用于第 4 天起。`) : srcStatus('Open-Meteo：ECMWF 集合预报', 'error', null, raw.ens.err));

  if (!raw.obs) sources.push(srcStatus('气象厅 AMeDAS 实测（当天高速时段的实况一条）', 'loading'));
  else if (!raw.obs.ok) sources.push(srcStatus('气象厅 AMeDAS 实测（当天高速时段的实况一条）', 'error', null, raw.obs.err + '（只影响当天高速时段的实况一条，不影响给绿色）'));
  else sources.push({ name: '气象厅 AMeDAS 实测（当天高速时段的实况一条）', status: ctx.obs.stale ? 'stale' : 'ok', reportTime: fmtMD(ctx.obs.time) + ' 观测',
    note: (ctx.obs.stale ? '最新观测超过 90 分钟，这一条暂不使用。' : '') + `札幌、江别、岩见泽、美呗、泷川、深川，取到 ${Object.keys(ctx.obs.st).length} 个站。` });

  /* 路线 */
  const routes = ROUTES.map(rt => ({ id: rt.id, short: rt.short, name: rt.name, desc: rt.desc, kind: rt.kind, days: buildRouteDays(ctx, rt) }));

  /* 取数时刻：取各项里最早的一个 */
  const fetched = Object.values(raw).filter(r => r && r.ok && r.fetchedAt).map(r => r.fetchedAt);
  const fetchedAt = fetched.length ? Math.min(...fetched) : now;

  /* 横幅 */
  const banners = [];
  const redNow = {};
  for (const [mc, list] of Object.entries(ctx.warn.areas || {})) {
    if (!MUNI[mc]) continue;
    list.filter(w => WARN_RED.has(w.code)).forEach(w => { const k = w.code + '|' + MUNI[mc][1]; const o = redNow[k] = redNow[k] || { ms: [], rd: w.rd }; if (!o.ms.includes(MUNI[mc][0])) o.ms.push(MUNI[mc][0]); if (w.rd > o.rd) o.rd = w.rd; });
  }
  Object.entries(redNow).forEach(([k, o]) => { const [code, off] = k.split('|'); banners.push({ level: 'red', text: `气象厅 ${fmtMD(o.rd)} 发布：${o.ms.join('、')} ${WARN_NAME[code] || '气象厅代码 ' + code + ' 的警报'}，目前有效（本页 ${fmtHM(fetchedAt)} 取得，之后可能已有变化）。`, url: `https://www.jma.go.jp/bosai/warning/#area_type=offices&area_code=${off}` }); });
  // 气象解说信息：每份（同一事件只取最新一份）一条，正文要点附参考译文；所说时段都已结束的不再提示
  // 2026-11-28：只有讲雪、吹雪、暴风、雪崩的才放页首横幅（这类才可能影响等级）；其他的（雷击、突发强风、冰雹等）折成一行放在结论卡下面
  // 2026-11-28 第二轮审阅后改：先分类再截断（原来先取前 3 份再分类，讲雪的可能被截掉）；除了标题，也看正文拆出的现象；
  // 正文没取到或有句子没拆开的，看不出讲不讲雪，也留在页首——折叠行写着“不影响等级”，这句话必须是真的
  const bulletinsFolded = [];
  const bulSnowy = b => /雪|ふぶき|吹雪|暴風|なだれ|着氷/.test(b.title || '') || !b.body
    || (b.body.sentences || []).some(sn => !sn.ok || (sn.groups || []).some(g => (g.hz || []).some(h => h.kind === 'snow' || h.kind === 'traffic' || h.kind === 'ava')));
  const bulText = b => {
    const head = `气象厅《${zhTitle(b.title)}》第 ${b.serial} 号（${fmtMD(b.rd)} 发布）`;
    return b.body ? `${head}要点：${b.body.zh}${b.body.parsedAll ? '' : '（有一部分没能自动翻译）'}`
      : `${head}的正文${b.bodyErr === '正在取' ? '正在取' : '没取到（' + b.bodyErr + '）'}，请看原文。`;
  };
  const liveBul = ctx.bulletins.filter(b => !b.expired);
  liveBul.filter(bulSnowy).slice(0, 3).forEach(b => banners.push({ level: 'orange', tag: '气象解说', text: bulText(b) + (b.body ? '中文是本页的参考译文，以原文为准。' : ''), url: b.url }));
  liveBul.filter(b => !bulSnowy(b)).forEach(b => bulletinsFolded.push({ title: zhTitle(b.title), text: bulText(b), url: b.url }));
  const errNames = [...new Set(sources.filter(s => s.status === 'error').map(s => s.name.replace(/（.*$/, '')))];
  if (errNames.length) banners.push({ level: 'info', text: `有 ${errNames.length} 项数据没取到（${errNames.join('、')}）。用得到这些数据的日子不会显示绿色。可以点“刷新”重试。` });
  const staleNames = [...new Set(sources.filter(s => s.status === 'stale').map(s => s.name.replace(/（.*$/, '')))];
  if (staleNames.length) banners.push({ level: 'info', text: `有的数据太旧（${staleNames.join('、')}），用到它们的时段不显示绿色。请点“刷新”，或到页面底部的“数据自检”看详情。` });

  const rd = ctx.fc['016000'].ok ? ctx.fc['016000'].rd : null;
  const msmInit = initOf('msm');
  const pending = JOBS.filter(j => !raw[j[0]]).length;
  const fresh = [rd ? `气象厅预报 ${fmtMD(rd)} 发布` : null, msmInit ? `MSM 模式 ${fmtMD(msmInit)} 起算` : null, `本页 ${fmtHM(fetchedAt)} 取数（日本时间）`].filter(Boolean).join('；') + (pending ? `；还有 ${pending} 项在取` : '');
  const fp = jp(fetchedAt), useDate = `${fp.y}年${fp.m}月${fp.d}日 ${pad(fp.h)}:${pad(fp.mi)}`;

  return {
    meta: { title: '北海道冬季路线出行参考', freshness: fresh, rulesVersion: RULES_VERSION, loading: false, refreshing: !!pending, generatedAt: now },
    disclaimerShort: '个人整理的出行参考，不是天气预报或警报。本页只看天气，看不到封路和 JR 停运的实况；一切以官方发布的信息为准。',
    disclaimerLong: '本页不做天气预报，也不发布警报。页面上的天气内容有两类：一是气象厅已经发布的预报、警报、注意报、早期注意信息、危险度时间序列和气象解说信息，中文是参考译文；二是数值预报模式在附近陆地格点上的计算结果（经 Open-Meteo 取得；没有按海拔修正；降雪量来自模式，或由 Open-Meteo 用降水量和气温换算；第 4 天以后大部分时刻是它插值出来的），可能与实际相差很大。等级是按“规则说明”里公开的固定门槛对这些数据做的归类：绿色只说明这些数据没有超过门槛，不代表道路畅通，也不代表可以放心出行。本页看不到道路封闭、封路预告和 JR 停运、减班的信息：道路是否封闭、限速，以道路管理者（NEXCO 东日本、北海道开发局等）和警方的实时信息为准；铁路以 JR 北海道的发布为准。依据本页做出的出行决定，请自行判断并承担后果。',
    banners, bulletinsFolded,
    routes,
    amedas: raw.amedas ? amedasView(raw.amedas) : { status: amedasLoading ? 'loading' : 'idle', time: '', rows: [] },
    links: LINKS,
    rulesText: RULES_TEXT,
    sources: sources.concat([!raw.amedas ? srcStatus('气象厅 AMeDAS 实测（“沿线实测”一栏）', 'loading', null, '展开“沿线实测”时才去取，只供查看；判定用的实况见上面的“当天高速时段的实况一条”。') : raw.amedas.ok ? { name: '气象厅 AMeDAS 实测（“沿线实测”一栏）', status: raw.amedas.data.stale ? 'stale' : 'ok', reportTime: fmtMD(raw.amedas.data.timeMs) + ' 观测', note: raw.amedas.data.stale ? '最新观测超过 1 小时，可能是气象厅更新慢。' : '只供查看；判定用的实况见上面的“当天高速时段的实况一条”。' } : srcStatus('气象厅 AMeDAS 实测（“沿线实测”一栏）', 'error', null, raw.amedas.err)]),
    attribution: [
      { parts: ['出典：気象庁ホームページ（', { t: '天気予報', u: 'https://www.jma.go.jp/bosai/forecast/' }, '、地域時系列予報、', { t: '警報・注意報', u: 'https://www.jma.go.jp/bosai/warning/' }, '、', { t: '早期注意情報', u: 'https://www.jma.go.jp/bosai/probability/' }, '、', { t: '気象解説情報', u: 'https://www.jma.go.jp/bosai/information/' }, '、', { t: 'アメダス', u: 'https://www.jma.go.jp/bosai/amedas/' }, `）。${useDate} 利用。上記の情報を加工して作成（抜粋、中国語への翻訳、独自の基準による分類）。編集の責任は本ページの作成者にあります。`] },
      { parts: [`中文：以上内容出自日本气象厅网站（天气预报、地域时序预报、警报和注意报、早期注意信息、气象解说信息、AMeDAS 实测），本页 ${useDate} 取用。本页对它做了节选、翻译，并按自己的规则归类；加工的责任在本页作者，加工后的内容不是气象厅发布的。`] },
      { parts: ['模式数值：', { t: 'Weather data by Open-Meteo.com', u: 'https://open-meteo.com/' }, '，按', { t: '知识共享 署名 4.0 国际许可（CC BY 4.0）', u: 'https://creativecommons.org/licenses/by/4.0/' }, '使用；原始模式是日本气象厅的中尺度模式（MSM）和欧洲中期天气预报中心（ECMWF）的 IFS 及其集合预报。本页显示的数值没有修改；判定时把 2 ℃ 以下的降水也按可能是雪来算（见规则说明）。'] },
      { parts: ['道路封闭与限速信息不由本页提供。'] }
    ]
  };
}

/* ---------------- AMeDAS 实况（R9 用，随页面一起取） ---------------- */
const OBS_ST = [['14163', '札幌'], ['14136', '江别'], ['15356', '岩见泽'], ['15321', '美呗'], ['15241', '泷川'], ['15161', '深川']];
/* 单站 3 小时一个文件（10 分钟一条）：只留气温、过去 3 小时降水、过去 1 小时降雪（整点才有）、视程 */
function pickObs(j) {
  const out = {};
  const g = x => (Array.isArray(x) && x[0] != null ? x[0] : null);
  for (const [k, v] of Object.entries(j || {})) {
    if (!/^\d{14}$/.test(k) || !v) continue;
    const t = Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), +k.slice(8, 10), +k.slice(10, 12)) - JST;
    out[t] = { T: g(v.temp), p3: g(v.precipitation3h), s1: g(v.snow1h), vis: g(v.visibility) };
  }
  if (!Object.keys(out).length) throw new Error('AMeDAS 单站数据的结构认不出来');
  return out;
}
/* 每站：最新一条的过去 3 小时降水；这 3 小时的气温是否都 ≤0.5 ℃；最近 3 个整点的 1 小时降雪相加；最近 1 小时 10 分钟视程低于 500 m 的次数 */
function obsCtx(r, now) {
  if (!r) return { ok: false, loading: true };
  if (!r.ok) return { ok: false };
  const st = {};
  for (const [id, name] of OBS_ST) {
    const recs = r.data.st[id]; if (!recs) continue;
    const ts = Object.keys(recs).map(Number).filter(t => t <= r.data.latest).sort((a, b) => a - b);
    if (!ts.length) continue;
    const tL = ts[ts.length - 1], last = recs[tL];
    const temps = ts.filter(t => t > tL - 3 * H).map(t => recs[t].T).filter(x => x != null);
    const h0 = Math.floor(tL / H) * H;
    const s1 = [0, 1, 2].map(k => recs[h0 - k * H] ? recs[h0 - k * H].s1 : null);
    const vis = ts.filter(t => t > tL - H).map(t => recs[t].vis).filter(x => x != null);
    st[id] = { id, name, t: tL, p3: last.p3, cold: temps.length >= 12 && temps.every(T => T <= BAND_T),
      s3: s1.every(x => x != null) ? s1.reduce((a, b) => a + b, 0) : null,
      visLow: vis.filter(v => v < OBS_VIS).length, visMin: vis.length ? Math.min(...vis) : null };
  }
  const time = r.data.latest, mp = r.data.map || {}, map = {};
  if (mp.now) for (const [id, v] of Object.entries(mp.now)) map[id] = Object.assign({}, v, { sd0: mp.d0 && mp.d0[id] ? mp.d0[id].sd : null });
  return { ok: Object.keys(st).length > 0, st, time, stale: now - time > 90 * 60e3, map: mp.now ? map : null, mapTime: mp.time };
}

/* ---------------- AMeDAS（懒加载，只展示） ---------------- */
const AMEDAS = [['14163', '札幌'], ['14136', '江别'], ['15356', '岩见泽'], ['15321', '美呗'], ['15241', '泷川'], ['15161', '深川'], ['12442', '旭川'], ['12451', '东川'], ['12551', '美瑛'], ['12596', '上富良野'], ['12626', '富良野'], ['15251', '芦别'], ['16091', '小樽'], ['14206', '惠庭岛松'], ['14296', '千岁']];
function amedasPick(map) {
  const v = (o, k) => (o && Array.isArray(o[k]) && o[k][0] != null ? o[k][0] : null);
  return AMEDAS.map(([id, name]) => { const o = map[id]; return { name, temp: v(o, 'temp'), wind: v(o, 'wind'), depth: v(o, 'snow'), s24: v(o, 'snow24h') }; });
}
function amedasView(a) {
  if (!a.ok) return { status: 'error', time: '', rows: [] };
  return { status: 'ok', time: `${fmtMD(a.data.timeMs)} 观测`, rows: a.data.rows };
}

/* ---------------- 链接、规则说明 ---------------- */
const LINKS = [
  { group: '道路信息', intro: '本页不显示封路实况，只放链接：JARTIC、iHighway、NEXCO 东日本和国土交通省的网站，使用条款都不许把它们的内容转载到别的网站。封没封路，请点下面的链接直接看。高速和国道都要看，开第一个 JARTIC；只看高速，开第二个 iHighway，不用先同意条款。', items: [
    { name: 'JARTIC（日本道路交通信息中心）', url: 'https://www.jartic.or.jp/', note: '高速、国道和都道府县道的封闭、管制、拥堵都在这里；iHighway 和ドラとら的高速信息也来自它。第一次打开要先同意它的使用条款（日文），同意后才显示' },
    { name: 'iHighway 高速交通信息图·北海道（NEXCO 西日本集团运营）', url: 'https://ihighway.jp/pcsite/map/?area=area01', note: '只看高速时最快：一打开就是北海道各条高速的地图，标出封闭、防滑链管制、冬季轮胎管制和事故，还有道路摄像头；不用登录，也不用先同意条款。不含国道；信息来自 JARTIC' },
    { name: 'NEXCO 东日本的高速公路交通信息网站“ドラとら”（DriveTraffic）', url: 'https://www.drivetraffic.jp/', note: '道央道、札樽道的封闭、限速和摄像头；深夜维护打不开时看上面两个' },
    { name: 'NEXCO 东日本北海道支社的 X 账号（@e_nexco_kita）', url: 'https://x.com/e_nexco_kita', note: '暴风雪来之前常会预告可能封闭的路段和时间' },
    { name: '国土交通省 道路信息提供系统', url: 'https://www.road-info-prvs.mlit.go.jp/roadinfo', note: '国道的封闭和路况' },
    { name: '北海道开发局的道路信息 X 账号（@hkd_mlit_road）', url: 'https://x.com/hkd_mlit_road', note: '国道封闭的即时通知' },
    { name: '“北の道ナビ”（北海道道路信息综合导航，寒地土木研究所）', url: 'https://northern-road.ceri.go.jp/navi/', note: '冬季封闭路段、山口路况、道路摄像头汇总' }
  ] },
  { group: '航班运行提示', intro: '本页不显示航班会不会停飞：新千岁机场、日本航空、全日空的网站使用条款都不许转载其内容。请点下面的链接，直接看它们发布的信息。', items: [
    { name: '新千岁机场 今日航班（北海道エアポート）', url: 'https://www.hokkaido-airports.com/ja/new-chitose/airport/fis/', note: '各航空公司当天的出发、到达和取消' },
    { name: '日本航空 天气对航班的影响预判（日文：運航の見通し）', url: 'https://www.jal.co.jp/jp/ja/other/weather_info_dom/', note: '列出因天气可能延误、取消、返航或备降的机场，看有没有“札幌（新千歳）”；只管日本航空集团自己运营的航班' },
    { name: '全日空 国内线运行情况（日文：運航状況のご案内）', url: 'https://www.ana.co.jp/fs/dom/jp/', note: '页面里有同样的天气影响预判（運航の見通し）；不含 AIRDO 等其他公司运营的代码共享航班' }
  ] },
  { group: '气象厅发布的内容', items: [
    { name: '警报、注意报（石狩、空知、后志预报区）', url: 'https://www.jma.go.jp/bosai/warning/#area_type=offices&area_code=016000', note: '页面里有危险度时间序列' },
    { name: '警报、注意报（上川、留萌预报区）', url: 'https://www.jma.go.jp/bosai/warning/#area_type=offices&area_code=012000', note: '页面里有危险度时间序列' },
    { name: '早期注意信息（日文：早期注意情報）', url: 'https://www.jma.go.jp/bosai/probability/#area_type=offices&area_code=016000', note: '今后 5 天内出现警报级天气的可能性' },
    { name: '气象解说信息（日文：気象解説情報）', url: 'https://www.jma.go.jp/bosai/information/#area_type=offices&area_code=016000', note: '大雪、暴风雪过程的解说原文' },
    { name: 'AMeDAS（气象厅的自动气象站网）实测', url: 'https://www.jma.go.jp/bosai/amedas/#area_type=offices&area_code=016000', note: '各站的气温、风和积雪' },
    { name: '札幌管区气象台 通知列表（日文：お知らせ一覧）', url: 'https://www.data.jma.go.jp/sapporo/oshirase/ichiran.html', note: '气象台、北海道开发局、NEXCO 联合发出的暴风雪、大雪呼吁会发在这里' },
    { name: '新千岁机场 机场气象解说情报（日文：飛行場気象解説情報）', url: 'https://www.data.jma.go.jp/airinfo/data/awfo_comment.html?RJCC#contents_area2', note: '气象厅给航空公司和航空管制的机场天气预报，管约 30 小时；标黄、标红的时段是风、视程、降雪对起降不利的时候' }
  ] },
  { group: '铁路', items: [
    { name: 'JR 北海道 列车运行信息', url: 'https://www3.jrhokkaido.co.jp/webunkou/', note: '机场快线“快速エアポート”停运时看这里；风雪前一天傍晚常会预告减班、末班提前' },
    { name: '北海道新闻 JR 停运一览', url: 'https://www.hokkaido-np.co.jp/jr_unkyu_info/', note: '分“今天”“明天”列出快速エアポート和特急的停运' }
  ] }
];
const RULES_TEXT = [
  '等级有五种。⬛ 交通瘫痪：基本动不了，大面积封路、停运；只用于札幌、小樽、千岁（新千岁机场）一线，即机场线两段和一日游的去程、回程高速。🔴 不宜出行：这段路这个时段可能封高速，或让札幌市区大面积堵车。🟠 要注意：能走，但会明显变慢，要有预案。🟢 没有触发任何规则：只说明下面这些数据没有超过门槛，不等于安全。⬜ 无法判定：缺数据或数据太旧，所以不给绿色。橙色以上的每条依据都标明风险类型：吹雪（视线差）、大雪（雪深、除雪跟不上）、结冰（雨后或融雪后降温）、其他（雪崩、着雪、封闭解除滞后等）；只有风的标“只有风”。',
  '本页只看天气。高速、国道有没有封闭，有没有预防性封路或夜间排雪封闭的预告，JR 有没有减班、末班提前或停运，本页都看不到；这些请看页面下方“道路信息”“铁路”里的官方入口；航班会不会停飞看“航班运行提示”里的机场和航空公司官网。',
  '每条路线按固定时段判定。一日游分四段：去程高速 09–11 时、旭川—美瑛—白金 11–17 时、回程山路 17–19 时、回程高速 19–20 时。机场线分札樽道段和道央道段，各按 06–09、09–12、12–15、15–18、18–21、21–24 时判定，00–06 时不判定。当天的等级取各段（各格）里最严重的一个。',
  '总的原则：北海道冬天下雪是常态，不因为下雪就判不宜出行。判红、判黑必须有本段、本时段的证据；整片地区的信号（早期注意信息、不分时段的预报文字）单独出现时最多判橙。只有风、没有雪不计等级，写进提醒（平均风 18 m/s、没有雪也不判红）；只有预报写陆上风“非常に強く”（平均 20 m/s 以上）或有暴风警报时判橙，类型写“只有风”。第 4 天起最高判橙（例外两个，都见下：早期注意信息“高”加模式佐证；一日游高速段的雪带，第 4～6 天按同样的危险程度判红、橙），写“可能升级”。',
  '下面说到的词：早期注意信息（日文：早期注意情報）是气象厅对今后 5 天内出现警报级天气的可能性给出的“高”“中”；注意报（日文：注意報）是比警报低一级的提醒；危险度时间序列是气象厅按 3 小时一格、到市町给出的风、雪预报值和达到注意报、警报标准的时段，是预报员订正过的数；地域时序预报（日文：地域時系列予報）是气象厅按细分地区、3 小时一格给出的天气和风速范围；气象解说信息（日文：気象解説情報）是气象台在大雪、暴风雪过程前后发布的说明；MSM 是日本气象厅的中尺度模式（约 5 公里一格，算到约 78 小时后）；ECMWF 是欧洲中期天气预报中心，IFS 是它的全球模式；GSM 是日本气象厅的全球模式；集合预报是同一个模式用略有不同的初始条件算 51 遍。风力等级按蒲福风级：5 级 8.0–10.7 m/s，6 级 10.8–13.8 m/s，7 级 13.9–17.1 m/s。',
  '⬛ 交通瘫痪（只用于札幌、小樽、千岁一线）：① 预报文字写本段地区陆上风“非常に強く”（平均 20 m/s 以上）并且和雪在同一段时间，或写到“猛ふぶき”（猛烈吹雪）；或地域时序预报的风速范围下限 20 m/s 以上并且天气是雪。② 大雪特别警报、暴风雪特别警报。③ 机场线前一个时段是⬛，这个时段至少判🔴（高速封闭要等 NEXCO 公告解除）。早期注意信息“高”或大雪警报，加上 MSM 在机场线 12 小时降水 30 mm 或 24 小时 35 mm 以上（0 ℃ 以下）时，本页只判🔴并写“可能升到⬛”：还要核对气象厅写的 24 小时预想降雪量，本页没有读这一项。',
  '🔴 不宜出行：① 本段沿线的市、町现在有暴风雪警报或大雪警报（只算今天；按危险度时间序列看它管哪几个小时，本时段不在里面的不计等级、写进提醒，时间序列认不出时按“目前有效”算）；危险度时间序列在本段时段内雪达到警报标准，或风达到警报标准并且有雪。② 风加雪，红线 14 m/s，只用气象厅订正过的数：危险度时间序列的最大风速 14 m/s 以上，同一格或相邻一格 6 小时降雪 3 cm 以上，气温 0 ℃ 以下；或地域时序预报的风速范围下限 15 m/s 以上并且天气是雪；或预报文字本段地区陆上风“強く”（平均 15 m/s 以上）并且和雪在同一段时间（“海上 では”不算）。③ 推定视程（见下）不到 200 m，并且气象厅对本段、本时段有信号：大雪、风雪注意报或大雪、暴风雪警报，危险度时间序列本格或前后一格达到注意报标准，早期注意信息“高”，或气象解说信息点名本段地区、本时段的大雪或吹雪；没有这些信号的降为🟠。④ 雪量：危险度时间序列的 6 小时降雪相加，札幌、江别、北广岛、惠庭、千岁 6 小时 20 cm、12 小时 30 cm 或 24 小时 40 cm 以上；小樽、岩见泽、美呗、砂川、泷川、深川、芦别、三笠 12 小时 40 cm 或 24 小时 50 cm 以上；旭川、美瑛、富良野、上富良野、东川 12 小时 40 cm 以上；或 MSM 在本段格点 0 ℃ 以下的降水 12 小时 22 mm 或 24 小时 28 mm 以上。⑤ 气象解说信息对本段地区、本时段的大雪、暴风雪、吹雪、吹积或它们造成的交通受阻要求“警戒”。⑥ 早期注意信息“高”，并且本段有橙色一级的佐证（风加雪、雪量或注意报）。',
  '🟠 要注意：① 吹雪：推定视程不到 500 m；危险度时间序列或模式显示高速平均风 8 m/s 以上并有雪（湿雪也算），回程山路、美瑛一段 10 m/s 以上并有雪；地域时序预报风速“10–14 m/s”并且天气是雪；预报文字陆上风“やや強く”（稍强，10–15 m/s）并且有雪，或预报写“ふぶく”“吹雪”，或写到“暴風雪”（预报文字不分时段，写到暴风雪也最多判橙；“やや強く”“ふぶく”还要地域时序预报或危险度时间序列同一时段也有雪，否则只写进提醒）；风雪注意报管着本时段（看法同🔴①）。② 雪量：札幌一线 12 小时 20 cm 或 24 小时 25 cm 以上，小樽和空知各市 12 小时 30 cm 以上，上川各市町 12 小时 25 cm 以上，回程山路 12 小时 20 cm 以上（都按危险度时间序列的 6 小时降雪相加）；MSM 12 小时 0 ℃ 以下的降水 15 mm 以上；大雪、着雪注意报管着本时段（看法同🔴①），或危险度时间序列雪、着雪达到注意报标准；回程山路另算雪崩注意报。③ 结冰：之前 48 小时降雨 5 mm 以上、之后降到 −3 ℃ 以下，或雨停后 12 小时内的夜间到清晨降到 0 ℃ 以下、并且路面有水（这场雨 3 mm 以上，或当天沿线 AMeDAS 积雪化掉 5 cm 以上）；从降到冰点起到第二天 10 时判橙，之后只在 18 时到次日 9 时继续判橙，直到白天回到 3 ℃ 以上，或又下了 5 cm 以上的新雪。④ 雨雪转换：预报写“雨後雪”“雨か雪”“みぞれ”，或地域时序预报写“雨または雪”，并且这段时间气温在 −1～2 ℃；预报文字这一条还要地域时序预报或危险度时间序列同一时段也有雪（雨夹雪也算）。⑤ 早期注意信息“中”（风一项要本段有雪，并且预报的风有“やや強く”以上，或本段风雪到了橙线）。⑥ 气象解说信息对本段要求“注意”“充分注意”；回程山路另算雪崩。⑦ 回程山路（17–19 时天黑、没有备用路）：模式算出有雪并且气温 −3 ℃ 以下。⑧ 本来够红、但只来自一个模式而气象厅和另一个模式都不支持，或推定视程不到 200 m 但气象厅没有对应信号，或落在第 4 天以后：降为橙。⑨ 机场线前一个时段不宜出行（封闭解除常比天气好转晚）。',
  '雪带和当天实况（2026-11-25 加，用于一日游的去程、回程高速；2026-11-27 起雪带也用于机场线的道央道段；看的是降水毫米数，不是风）：🔴 ⑦ 雪带：MSM 在道央道沿线格点任一个，0.5 ℃ 以下的降水 3 小时合计 7 mm（大约积雪 7–11 cm）或 6 小时合计 10 mm 以上，并且气象厅在同一段时间里有雪的信号（危险度时间序列雪达到注意报标准，大雪、风雪注意报或警报，或预报写这时有雪；早期注意信息的“中”不算）；没有雪的信号降为🟠。取数的时间窗：去程看前一天 18 时到当天 11 时，回程看当天 05–20 时，因为封路常常是前一晚或凌晨的雪带造成、一直封到上午的。去程看札幌、江别东 IC、江别东 IC 与岩见泽 IC 之间、岩见泽、三笠 IC、美呗 IC、奈井江砂川 IC、砂川与泷川之间、深川九个格点，回程只看三笠 IC 到札幌这五个。🟠 ⑩ 雪带预警：同样的格点 3 小时 4.5 mm 或 6 小时 6 mm 以上。雪带的依据写出量和红线，以及最近几轮 MSM 各自的量和几轮越线（GitHub 上每 3 小时用本页同一个程序算一次存下）；判红、判橙只看最新一轮。🔴 ⑧ 当天实况：只用于今天、开始时刻在最新观测之后 8 小时以内的高速时段。沿线 AMeDAS（去程：札幌、江别、岩见泽、美呗、泷川、深川；回程：札幌、江别、岩见泽）任一站过去 3 小时降水 5 mm 以上，并且这 3 小时气温都在 0.5 ℃ 以下；或过去 3 小时降雪 6 cm 以上，并且岩见泽或札幌最近 1 小时的 10 分钟视程有 2 次以上不到 500 m。只有降雪 6 cm 以上判🟠（⑪）。实况优先：今天已经开始或 3 小时内开始的时段，如果沿线 AMeDAS 都是 1 ℃ 以上的雨或没下、风不到 8 m/s，MSM 接下来 3 小时也不转雪，危险度时间序列报的雪、风雪和着雪注意报就不计等级。为什么看毫米数：2026-11-25 道央道江别东 IC—美呗 IC 封路时，岩见泽平均风只有 2–8 m/s，雪带宽二三十公里，按风和推定视程的规则都只到橙；按厘米数算，札幌一冬有二十天 3 小时降雪 8 cm 以上，按毫米数算 3 小时 6 mm 以上只有十三天，其中九天附近的高速封了路。门槛和时间窗是用 2025–26 冬季加 2026 年 11 月逐日核对过封路的 176 天回测定的（前一天的 MSM 达到这条门槛的 32 天里，21 天道央道札幌—旭川段封了路；没达到的 144 天里只有 11 天封路），数据、脚本和结果公开在 GitHub 仓库 SHIELD-CAP/hokkaido-winter-route。',
  '机场线的雪带（2026-11-27 加，按机场线单独回测）：道央道段（札幌—新千岁机场）也用雪带红线，看札幌、北广岛、惠庭、新千岁机场四个格点，取数时间窗是本时段和之前 6 小时；达到 3 小时 7 mm 或 6 小时 10 mm 并有气象厅雪的信号判🔴，没有雪的信号判🟠，不用 4.5／6 mm 那条预警。札樽道段不用雪带：那里封路主要看风，靠“平均风 8 m/s 以上并有雪”判🟠（吹雪）。回测用同样的 176 天和前一天的 MSM，只算因天气封路（不算事先公告的夜间除雪封闭）：道央道段封路 12 次，这四个点达到红线的 10 天里 5 天当天真封了，12 次接住 6 次；札樽道封路 15 次，雪量门槛只接住 4 次，“风 8 m/s 以上并有雪”接住 11 次，但亮了 40 天、当天真封的只有 12 天，所以只判橙。样本小，数字还会变。',
  '第 4～6 天的雪带（2026-11-28 加，只用于一日游的去程、回程高速）：MSM 算不到这么远，改看两家全球模式——ECMWF 的 0.25 度版和日本气象厅 GSM（Open-Meteo 给的 GSM 是约 55 公里一格、6 小时一个值）。取沿线 9 个点（札幌到深川）里最多的一点，这天全天 0.5 ℃ 以下的降水合计：两家都过红线（ECMWF 4.8 mm、GSM 4.2 mm）并且气象厅一周预报这天写了雪判🔴，没写雪判🟠；两家都过橙线（ECMWF 3.6 mm、GSM 3.3 mm）判🟠；只有一家过线不亮，写进提醒。全球模式一格二三十到五十多公里，峰值被摊平，前 3 天的毫米门槛它们够不到（176 天里两家同时到 MSM 红线的一天都没有），所以这几个数只能当排名用，不是实际雪量。门槛按 2025–26 冬季加 2026 年 11 月的 176 天回测定，让同一种颜色和前 3 天的封路比例相当：红的日子约七成当天封过路（前 3 天的红是 69%），橙约四成（前 3 天 42%），绿 5%–8%（前 3 天 3%）。门槛是在同样这些天上挑的，结果偏乐观，冬天结束后用新数据再核。',
  '推定视程：用模式的 10 m 风速、每小时降水（1 ℃ 以下才算）、气温，以及“最近一次下雨或融雪之后有没有新雪”，按札幌管区气象台的飞雪流量方法和松泽（2007）的视程经验式，计算小时平均视程。风速乘 0.81 折算到 1.2 m 高是本页自己加的，所以算出的数比原式大一成半左右，不要和别处发布的视程直接比较。200 m、500 m 两条线是用 2025–26 冬季的封路日回测定的；瞬间视程可能低到小时平均的五分之一。',
  '数值模式的数用的是 Open-Meteo 提供的附近陆地格点的计算结果，没有按海拔修正。判雪量一律看降水毫米数加气温，不看换算出的厘米数：Open-Meteo 给 MSM 的降雪按每毫米降水 0.7 cm 换算，札幌实测大雪时每毫米降水常积 1.0–1.6 cm 雪。石狩湾那种局地强降雪带，ECMWF 常常整个漏掉，所以判大雪以 MSM 为主。MSM 只算到约 78 小时后，之后只有 ECMWF。第 4 天起看 ECMWF 集合预报：51 个成员里有多少个在当天算出“14 m/s 以上并有雪”（红线）和“8 m/s 以上并有雪”（橙线）；红线成员有 15 个以上时判橙，其余只写数。',
  '只做提醒、不改变等级的：只讲风的信息（强风注意报，以及早期注意信息、危险度时间序列、地域时序预报、气象解说信息里没有雪的那部分）；只涉及不经过路线的地区，或范围对不上具体地区的部分（例如“日本海側南部”）；一周预报可信度为 C；小樽附近格点的集合预报（这个格点包含大片海面，风速偏大）。',
  '给绿色要求本段该有的数据都在：今后 5 天内的早期注意信息、气象厅预报（本段经过的每个地区）、至少一个数值模式在本段时段内的完整数据；今后 3 天还要有气象解说信息的列表和相关正文；今天还要有警报、注意报和危险度时间序列；第 4 天起，用到集合预报的段还要有集合预报；一日游第 4～6 天的去程、回程高速还要有 ECMWF 0.25 度版和 GSM。缺任一项，或用到的数据太旧，就显示无法判定。地域时序预报不算必需。',
  '雪带地图（2026-11-26 加）：每条路线的“气象厅发布的内容”上方有一张“雪带地图”，一日游画道央道两侧、机场线画小樽—札幌—新千岁机场两侧 20 公里内的 MSM 网格，逐小时播放，按气温把降水换算成降雪厘米数（0 ℃ 以上 0.9 倍，−2～0 ℃ 1.3 倍，−4～−2 ℃ 1.5 倍，−4 ℃ 以下 1.7 倍，取自岩见泽、札幌去冬实测），红框是 3 小时 0.5 ℃ 以下的降水到了 7 mm；机场线那张另有橙框，是那一小时平均风 8 m/s 以上并有雪（0.5 ℃ 以下的降水 0.5 mm 以上）。地图只给人看，不参与判级：回测显示把两侧 10–20 公里也算进雪带规则，每多接住一次封路要多出约 10 天红色。',
  '本页按“判定规则 v6”的网站版计算（2026-11-25 晚在 v4 上加了雪带和当天实况两条；2026-11-26 改了雪带的取数时间窗和雪的信号、结冰第二款的雨量下限，加了实况优先；2026-11-28 晚改了今天警报、注意报的时段，不分时段的预报文字最多判橙并要同一时段的佐证，雪带依据写出红线和最近几轮，加了第 4～6 天的雪带）。网站版没有做的部分：高速和国道的封闭实况、封路预告和夜间排雪封闭（NEXCO 东日本和国土交通省网站的条款都不许未经同意转载，所以只在“官方信息链接”里放链接），JR 的停运和减班，tenki.jp 的点预报，气象台联合呼吁的正文；AMeDAS 实测只用于当天高速时段的实况一条。规则只看天气，不看事故、施工、冬季封闭等道路本身的情况。出发前一定要看道路信息。'
];

/* ---------------- 主流程（浏览器） ---------------- */
const RAW = {};
let loadingNow = false, amedasLoading = false, lastForced = 0, lastLoad = 0;
function omUrl(model, days, past) {
  const lat = PTS.map(p => p.lat).join(','), lon = PTS.map(p => p.lon).join(','), el = PTS.map(() => 'nan').join(',');
  return `${OM}?latitude=${lat}&longitude=${lon}&elevation=${el}&cell_selection=land&hourly=temperature_2m,precipitation,rain,snowfall,wind_speed_10m,wind_gusts_10m,wind_direction_10m&models=${model}&wind_speed_unit=ms&timezone=Asia%2FTokyo&past_days=${past}&forecast_days=${days}`;
}
// 第 4～6 天雪带（R8f、O9f）用的两家全球模式：取法和回测（scripts/backtest_lead.py）一样——同样 9 个点、不加 elevation 和 cell_selection，只要气温和降水
function farUrl(model) {
  const pts = FAR_PTS.map(id => PT[id]);
  return `${OM}?latitude=${pts.map(p => p.lat).join(',')}&longitude=${pts.map(p => p.lon).join(',')}&hourly=temperature_2m,precipitation&models=${model}&timezone=Asia%2FTokyo&forecast_days=7`;
}
function compactFar(json) {
  const arr = Array.isArray(json) ? json : [json];
  if (arr.length !== FAR_PTS.length) throw new Error(`返回了 ${arr.length} 个点，应为 ${FAR_PTS.length} 个`);
  return arr.map(o => {
    const h = o && o.hourly; if (!h || !h.time) return null;
    const r = x => (x || []).map(v => v == null ? null : Math.round(v * 100) / 100);
    return { t: h.time.map(omMs), P: r(h.precipitation), T: r(h.temperature_2m) };
  });
}
function parseBandHist(j) {
  if (!j || !Array.isArray(j.runs)) throw new Error('雪带最近几轮的文件结构和预期不同');
  return j.runs.map(r => ({ init: Date.parse(r.init_utc), cells: r.cells || {} })).filter(r => isFinite(r.init)).sort((a, b) => a.init - b.init);
}
const BAND_HIST_URL = 'https://raw.githubusercontent.com/SHIELD-CAP/hokkaido-winter-route/main/data/latest/band_history.json';
const ENS_URL = `${OME}?latitude=${ENS_PTS.map(p => p[1]).join(',')}&longitude=${ENS_PTS.map(p => p[2]).join(',')}&elevation=${ENS_PTS.map(() => 'nan').join(',')}&cell_selection=land&hourly=wind_speed_10m,snowfall&models=ecmwf_ifs025&forecast_days=8&wind_speed_unit=ms&timezone=Asia%2FTokyo&temporal_resolution=hourly_6`;
const JOBS = [
  ['prob016', JMA + 'probability/data/probability/r8/016000.json', parseProb],
  ['prob012', JMA + 'probability/data/probability/r8/012000.json', parseProb],
  ['warn016', JMA + 'warning/data/r8/016000.json', parseWarn],
  ['warn012', JMA + 'warning/data/r8/012000.json', parseWarn],
  ['fc016', JMA + 'forecast/data/forecast/016000.json', parseForecast],
  ['fc012', JMA + 'forecast/data/forecast/012000.json', parseForecast],
  ['tl016', JMA + 'warning_timeline/data/016000.json', parseTimeline],
  ['tl012', JMA + 'warning_timeline/data/012000.json', parseTimeline],
  ['info', JMA + 'information/data/r8/information.json', filterInfo],
  ['vp016010', JMA + 'jmatile/data/wdist/VPFD/016010.json', parseVPFD],
  ['vp016020', JMA + 'jmatile/data/wdist/VPFD/016020.json', parseVPFD],
  ['vp016030', JMA + 'jmatile/data/wdist/VPFD/016030.json', parseVPFD],
  ['vp012010', JMA + 'jmatile/data/wdist/VPFD/012010.json', parseVPFD],
  ['msm', omUrl('jma_msm', 4, 2), compactOM],
  ['ifs', omUrl('ecmwf_ifs', 8, 2), compactOM],
  ['ens', ENS_URL, compactEns],
  ['meta_msm', 'https://api.open-meteo.com/data/jma_msm/static/meta.json', compactMeta],
  ['meta_ifs', 'https://api.open-meteo.com/data/ecmwf_ifs/static/meta.json', compactMeta],
  ['ifs025', farUrl('ecmwf_ifs025'), compactFar],
  ['gsm', farUrl('jma_gsm'), compactFar],
  ['bandhist', BAND_HIST_URL, parseBandHist]
];
function draw(view) { if (root.renderApp) root.renderApp(view); }
let LAST = null;
function errorView(e) {
  return { meta: { title: '北海道冬季路线出行参考', freshness: '计算出错' }, banners: [{ level: 'error', text: '页面计算出错：' + (e && e.message) + '。请点“刷新”；如果一直出错，说明规则代码有问题，请不要再参考本页。' }] };
}
function redraw() {
  try { LAST = buildView(RAW, Date.now()); draw(LAST); }
  catch (e) { draw(errorView(e)); if (root.console) console.error(e); }
}
async function loadAll(force) {
  if (loadingNow) return;
  if (force && Date.now() - lastForced < 60e3) {   // 强制刷新至少隔 1 分钟，免得把免费额度用完
    if (LAST) draw(Object.assign({}, LAST, { banners: [{ level: 'info', text: '刚刚刷新过，数据在 1 分钟内不会有变化。请稍后再点。' }].concat(LAST.banners || []) }));
    return;
  }
  loadingNow = true;
  if (force) { lastForced = Date.now(); cacheClear(); }
  JOBS.forEach(([k]) => { delete RAW[k]; });
  delete RAW.obs;
  Object.keys(RAW).filter(k => k.startsWith('bul_')).forEach(k => { delete RAW[k]; });
  if (LAST) draw(Object.assign({}, LAST, { meta: Object.assign({}, LAST.meta, { refreshing: true }) }));
  else draw({ meta: { title: '北海道冬季路线出行参考', loading: true, freshness: '正在取数据…', rulesVersion: RULES_VERSION } });
  let shown = false, timer = null;
  const t0 = Date.now();
  const schedule = () => {   // 前 3 秒先等齐，之后每到一项就重画一次（最多每 300 毫秒一次）
    if (Date.now() - t0 < 3000 && JOBS.some(([k]) => !RAW[k])) return;
    if (timer) return;
    timer = setTimeout(() => { timer = null; shown = true; redraw(); }, 300);
  };
  const graceTimer = setTimeout(() => { if (!shown) { shown = true; redraw(); } }, 3000);
  const obsDone = loadObs().then(schedule);
  await Promise.all(JOBS.map(async ([key, url, tf]) => {
    try { const r = await getData(key, url, tf); RAW[key] = { ok: true, data: r.data, fetchedAt: r.fetchedAt }; }
    catch (e) { RAW[key] = { ok: false, err: `${e.message}（${url.split('?')[0]}）` }; }
    schedule();
    if (key === 'info') { await loadBodies(); schedule(); }   // 列表到了再取各份解说的正文
  }));
  await obsDone;
  clearTimeout(graceTimer); if (timer) { clearTimeout(timer); timer = null; }
  redraw();
  lastLoad = Date.now();
  loadingNow = false;
  if (RAW.amedas && RAW.amedas.ok) { delete RAW.amedas; loadAmedas(); }   // 用户已经展开过实测，就一起更新
}
/* 气象解说信息的正文：最近 72 小时、同一事件最新的那份，每份一个小 JSON */
async function loadBodies() {
  if (!RAW.info || !RAW.info.ok) return;
  const list = activeBulletins(RAW.info.data, Date.now()).filter(b => b.jsonName);
  await Promise.all(list.map(async b => {
    const key = 'bul_' + b.jsonName, url = JMA + 'information/data/r8/denbun/' + b.jsonName + '.json';
    try { const r = await getData(key, url, parseBulletin); RAW[key] = { ok: true, data: r.data, fetchedAt: r.fetchedAt }; }
    catch (e) { RAW[key] = { ok: false, err: `${e.message}（${url}）` }; }
  }));
}
/* 结冰第二款（融雪）和实况优先用：最新整点和当天 0 时两张 AMeDAS 全站图 */
const MAP_ST = [['14163', '札幌'], ['14136', '江别'], ['15356', '岩见泽'], ['15321', '美呗'], ['15241', '泷川'], ['15161', '深川'], ['12442', '旭川'], ['12551', '美瑛'], ['12626', '富良野'], ['15251', '芦别'], ['16091', '小樽'], ['14206', '惠庭岛松'], ['14296', '千岁']];
function pickMap(j) {
  const out = {}, g = x => (Array.isArray(x) && x[0] != null ? x[0] : null);
  for (const [id, name] of MAP_ST) { const v = j && j[id]; if (v) out[id] = { name, T: g(v.temp), p1: g(v.precipitation1h), wind: g(v.wind), sd: g(v.snow) }; }
  if (!Object.keys(out).length) throw new Error('AMeDAS 全站图的结构认不出来');
  return out;
}
/* R9 用的实况：最新时刻所在的 3 小时文件和前一个文件，6 个站 */
async function loadObs() {
  try {
    const t = await getData('obs_time', JMA + 'amedas/data/latest_time.txt', s => String(s).trim(), { text: true });
    const latest = Date.parse(t.data);
    if (!isFinite(latest)) throw new Error('AMeDAS 最新时刻读不出来');
    const p = jp(latest), b0 = Math.floor(p.h / 3) * 3;
    const q = jp(msAt(`${p.y}-${pad(p.m)}-${pad(p.d)}`, b0) - 3 * H);
    const blocks = [`${q.y}${pad(q.m)}${pad(q.d)}_${pad(q.h)}`, `${p.y}${pad(p.m)}${pad(p.d)}_${pad(b0)}`];
    const st = {};
    await Promise.all(OBS_ST.map(async ([id]) => {
      const recs = {};
      for (const blk of blocks) {
        try { const r = await getData(`obs_${id}_${blk}`, JMA + `amedas/data/point/${id}/${blk}.json`, pickObs); Object.assign(recs, r.data); }
        catch (e) { /* 缺一个文件就少几条，下面按有的算 */ }
      }
      if (Object.keys(recs).length) st[id] = recs;
    }));
    if (!Object.keys(st).length) throw new Error('6 个站的单站数据都没取到');
    const map = {};
    const pm = jp(latest), dsm = `${pm.y}-${pad(pm.m)}-${pad(pm.d)}`, stampOf = h => `${pm.y}${pad(pm.m)}${pad(pm.d)}${pad(h)}0000`;
    const [mNow, m00] = await Promise.all([pm.h, 0].map(h => getData('obsmap_' + stampOf(h), JMA + `amedas/data/map/${stampOf(h)}.json`, pickMap).catch(() => null)));
    if (mNow) { map.now = mNow.data; map.time = msAt(dsm, pm.h); }
    if (m00) map.d0 = m00.data;
    RAW.obs = { ok: true, data: { latest, st, map }, fetchedAt: Date.now() };
  } catch (e) { RAW.obs = { ok: false, err: e.message }; }
}
async function loadAmedas() {
  if (amedasLoading) return;
  amedasLoading = true;
  if (LAST) redraw();
  try {
    const t = await getData('amedas_time', JMA + 'amedas/data/latest_time.txt', s => String(s).trim(), { text: true });
    const latest = Date.parse(t.data);
    if (!isFinite(latest)) throw new Error('AMeDAS 最新时刻读不出来');
    const p = jp(latest);
    const stamp = `${p.y}${pad(p.m)}${pad(p.d)}${pad(p.h)}0000`;
    const r = await getData('amedas_' + stamp, JMA + `amedas/data/map/${stamp}.json`, j => ({ rows: amedasPick(j) }));
    RAW.amedas = { ok: true, data: { rows: r.data.rows, timeMs: msAt(`${p.y}-${pad(p.m)}-${pad(p.d)}`, p.h), stale: Date.now() - latest > H } };
  } catch (e) { RAW.amedas = { ok: false, err: e.message }; }
  amedasLoading = false;
  if (LAST) redraw();
}

const HKR = { RULES_VERSION, PTS, ROUTES, OBS_ST, pickObs, obsCtx, bandSum, _test: { loadObs, RAW }, TELOPS_ZH, JOBS, zhForecast, parseBulletin, parseProb, parseWarn, parseForecast, parseTimeline, parseVPFD, compactMeta, filterInfo, activeBulletins, compactOM, compactEns, ensCounts, evalWindow, buildView, visOf, dateStr, msAt, periodLabel, loadAll };
root.HKR = HKR;
if (typeof module !== 'undefined' && module.exports) module.exports = HKR;

if (typeof document !== 'undefined' && !root.HKR_NO_AUTOSTART) {
  root.onRefresh = () => loadAll(true);
  root.onAmedasOpen = () => { if (!RAW.amedas && !amedasLoading) loadAmedas(); };
  const stale = () => lastLoad && Date.now() - lastLoad > CACHE_TTL;
  document.addEventListener('visibilitychange', () => { if (!document.hidden && stale()) loadAll(false); });
  setInterval(() => { if (!document.hidden && stale()) loadAll(false); }, 60e3);   // 页面一直开着时，每 15 分钟自动更新
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => loadAll(false));
  else loadAll(false);
}
})(typeof window !== 'undefined' ? window : globalThis);
