// 由 GitHub Actions 定时运行（.github/workflows/fetch-data.yml）。
// 做三件事：
//   1. 向 Open-Meteo 取 MSM（日本气象厅中尺度模式）和 ECMWF IFS 的格点数值，写进 data/latest/，供网站和两个定时任务在自己取不到时读取；
//   2. 把这一轮的 MSM 存档（data/archive/），以后回测用；
//   3. 气象厅的警报注意报、危险度时间序列、天气预报、早期注意信息、地域时序预报，内容有变化时存档。气象厅网站不保留这些产品的历史版本，不自己存就没有回测材料。
// 每次每个来源取没取到，都记进 data/fetch_log.csv。
// 只用 Node 20 自带的功能，不装任何依赖。

import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = process.cwd();
const UA = 'hokkaido-winter-route data fetcher (https://github.com/SHIELD-CAP/hokkaido-winter-route)';

// 取样点：前 15 个与网站一致；E1–E5 是道央道沿线新增的点，坐标取自各 IC 收费站的位置。
const POINTS = [
  ['A1', '札幌', 43.06, 141.35], ['A2', '岩见泽', 43.20, 141.76], ['A3', '砂川、泷川之间', 43.53, 141.91],
  ['A4', '深川', 43.72, 142.05], ['A5', '旭山动物园', 43.77, 142.48], ['A6', '美瑛', 43.59, 142.47],
  ['A7', '白金（青池）', 43.49, 142.61], ['A8', '富良野', 43.34, 142.38], ['A9', '道道 135 号富良野隧道一带', 43.344, 142.26],
  ['A10', '国道 452 号桂泽湖山口一带', 43.295, 142.09], ['B1', '小樽', 43.19, 141.00], ['B2', '钱函', 43.14, 141.21],
  ['B4', '北广岛', 42.98, 141.56], ['B5', '惠庭', 42.88, 141.58], ['B6', '新千岁机场', 42.78, 141.69],
  ['E1', '江别东 IC', 43.107, 141.598], ['E2', '江别东 IC—岩见泽 IC 之间', 43.142, 141.681], ['E3', '三笠 IC', 43.243, 141.827],
  ['E4', '美呗 IC', 43.334, 141.890], ['E5', '奈井江砂川 IC', 43.450, 141.915]
];
const VARS = ['temperature_2m', 'precipitation', 'rain', 'snowfall', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m'];

function omUrl(model, days, past) {
  const lat = POINTS.map(p => p[2]).join(','), lon = POINTS.map(p => p[3]).join(','), el = POINTS.map(() => 'nan').join(',');
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&elevation=${el}&cell_selection=land&hourly=${VARS.join(',')}&models=${model}&wind_speed_unit=ms&timezone=Asia%2FTokyo&past_days=${past}&forecast_days=${days}`;
}

const JMA = 'https://www.jma.go.jp/bosai/';
const JMA_JOBS = [
  ['prob016', JMA + 'probability/data/probability/r8/016000.json'],
  ['prob012', JMA + 'probability/data/probability/r8/012000.json'],
  ['warn016', JMA + 'warning/data/r8/016000.json'],
  ['warn012', JMA + 'warning/data/r8/012000.json'],
  ['fc016', JMA + 'forecast/data/forecast/016000.json'],
  ['fc012', JMA + 'forecast/data/forecast/012000.json'],
  ['tl016', JMA + 'warning_timeline/data/016000.json'],
  ['tl012', JMA + 'warning_timeline/data/012000.json'],
  ['vp016010', JMA + 'jmatile/data/wdist/VPFD/016010.json'],
  ['vp016020', JMA + 'jmatile/data/wdist/VPFD/016020.json'],
  ['vp016030', JMA + 'jmatile/data/wdist/VPFD/016030.json'],
  ['vp012010', JMA + 'jmatile/data/wdist/VPFD/012010.json']
];

const now = new Date();
const iso = now.toISOString();
const stamp = iso.slice(0, 16).replace(/[-:]/g, '') + 'Z';            // 20261125T1340Z
const jst = new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' JST';
const dayDir = path.join('data', 'archive', iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10));
const logRows = [];

async function get(url, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
      const text = await r.text();
      if (r.ok) return { ok: true, status: r.status, text };
      last = { ok: false, status: r.status, text };
      if (r.status !== 429 && r.status < 500) break;               // 4xx（429 以外）重试也没用
    } catch (e) { last = { ok: false, status: 0, text: String(e) }; }
    await new Promise(res => setTimeout(res, 20000 * (i + 1)));
  }
  return last;
}

function log(source, res, note = '') {
  const reason = res.ok ? '' : (res.text || '').replace(/[\r\n,]+/g, ' ').slice(0, 120);
  logRows.push([iso, source, res.status, res.ok ? res.text.length : 0, (note || reason).replace(/,/g, ' ')].join(','));
}

async function write(file, data) {
  await mkdir(path.dirname(path.join(ROOT, file)), { recursive: true });
  await writeFile(path.join(ROOT, file), data);
}

// Open-Meteo 的多点返回是数组，按 POINTS 的顺序；整理成按点编号的对象，方便任务和网站读。
function normalize(model, url, arr, meta) {
  const list = Array.isArray(arr) ? arr : [arr];
  return {
    model, fetched_utc: iso, fetched_jst: jst,
    init_utc: meta && meta.last_run_initialisation_time ? new Date(meta.last_run_initialisation_time * 1000).toISOString() : null,
    source: 'Weather data by Open-Meteo.com (CC BY 4.0); original model: ' + (model === 'jma_msm' ? 'JMA MSM' : 'ECMWF IFS'),
    url,
    points: list.map((d, i) => ({
      id: POINTS[i][0], name: POINTS[i][1], lat: POINTS[i][2], lon: POINTS[i][3],
      grid_lat: d.latitude, grid_lon: d.longitude, elevation: d.elevation,
      hourly: d.hourly
    }))
  };
}

async function openMeteo(key, model, days, past, archive) {
  const url = omUrl(model, days, past);
  const metaRes = await get(`https://api.open-meteo.com/data/${model}/static/meta.json`, 2);
  let meta = null;
  try { meta = metaRes.ok ? JSON.parse(metaRes.text) : null; } catch { meta = null; }
  const res = await get(url);
  log('open-meteo:' + key, res);
  if (!res.ok) return false;
  let json;
  try { json = JSON.parse(res.text); } catch (e) { log('open-meteo:' + key, { ok: false, status: res.status, text: 'JSON 解析失败' }); return false; }
  const norm = normalize(model, url, json, meta);
  const body = JSON.stringify(norm);
  await write(`data/latest/${key}.json`, body);
  if (archive) await write(path.join(dayDir, `${key}_${stamp}.json.gz`), gzipSync(body));
  return norm.init_utc || true;
}

async function jma() {
  const hashFile = 'data/latest/jma_hashes.json';
  let hashes = {};
  if (existsSync(path.join(ROOT, hashFile))) { try { hashes = JSON.parse(await readFile(path.join(ROOT, hashFile), 'utf8')); } catch { hashes = {}; } }
  let ok = 0, changed = 0;
  for (const [key, url] of JMA_JOBS) {
    const res = await get(url, 2);
    if (!res.ok) { log('jma:' + key, res); continue; }
    ok++;
    const h = createHash('sha256').update(res.text).digest('hex').slice(0, 16);
    if (hashes[key] === h) continue;                                 // 内容没变，不重复存
    hashes[key] = h; changed++;
    await write(path.join(dayDir, 'jma', `${key}_${stamp}.json.gz`), gzipSync(res.text));
    log('jma:' + key, res, '有变化，已存档');
  }
  await write(hashFile, JSON.stringify(hashes, null, 1));
  return { ok, changed };
}

const msmInit = await openMeteo('msm', 'jma_msm', 4, 2, true);
const ifsInit = await openMeteo('ifs', 'ecmwf_ifs', 8, 2, false);
const j = await jma();

const status = {
  fetched_utc: iso, fetched_jst: jst,
  msm: msmInit ? { ok: true, init_utc: msmInit === true ? null : msmInit } : { ok: false },
  ifs: ifsInit ? { ok: true, init_utc: ifsInit === true ? null : ifsInit } : { ok: false },
  jma: { ok: j.ok, of: JMA_JOBS.length, archived_changed: j.changed },
  note: 'msm.json / ifs.json 取不到时保留上一次成功的版本；判断新旧请看 msm.json 里的 fetched_utc 和 init_utc。'
};
// status 只在至少一个来源成功时更新的字段，失败的来源在 fetch_log.csv 里有记录
await write('data/latest/status.json', JSON.stringify(status, null, 1));

const logFile = path.join(ROOT, 'data', 'fetch_log.csv');
if (!existsSync(logFile)) await write('data/fetch_log.csv', 'utc,source,http_status,bytes,note\n');
if (logRows.length) await appendFile(logFile, logRows.join('\n') + '\n');
console.log(JSON.stringify(status));
