#!/usr/bin/env python3
"""试探 Open-Meteo 往期预报接口（previous-runs-api）里，各模式提前 1～5 天的预报从哪天起取得到。
为"提前 3～5 天回测"（第三轮审阅 Q4）做准备：只取岩見沢一个点、几个日子，看非空值有多少。
结果写进 data/backtest/probe_previous_runs.md。要能连 previous-runs-api.open-meteo.com（在 GitHub Actions 里跑）。
"""
import json, time, urllib.request, urllib.parse, datetime

MODELS = ['ecmwf_ifs025', 'ecmwf_ifs', 'jma_gsm', 'jma_msm']
DAYS = ['2018-12-15', '2021-12-15', '2024-01-15', '2024-12-15', '2025-11-15', '2025-12-15', '2026-02-15']
OFFS = [1, 2, 3, 4, 5]
LAT, LON = 43.20, 141.76   # 岩見沢

def get(model, day):
    hourly = ','.join([f'precipitation_previous_day{n}' for n in OFFS] + ['temperature_2m_previous_day3', 'wind_speed_10m_previous_day3'])
    q = {'latitude': LAT, 'longitude': LON, 'hourly': hourly, 'models': model, 'start_date': day, 'end_date': day,
         'timezone': 'Asia/Tokyo', 'wind_speed_unit': 'ms'}
    url = 'https://previous-runs-api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode(q, safe=',')
    for i in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:200]
            if e.code != 429 and e.code < 500:
                return {'error': f'HTTP {e.code} {body}'}
            err = f'HTTP {e.code} {body}'
        except Exception as e:
            err = str(e)
        time.sleep(15 * (i + 1))
    return {'error': err}

rows = ['# Open-Meteo 往期预报试探（岩見沢一点，每格是当天 24 小时里非空的小时数）', '',
        f'生成：{datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%MZ")}（世界时）。变量 precipitation_previous_dayN 是“提前约 N×24 小时的预报”。', '',
        '| 模式 | 日期 | 提前1天 | 提前2天 | 提前3天 | 提前4天 | 提前5天 | 提前3天气温 | 提前3天风 | 备注 |', '|---|---|---|---|---|---|---|---|---|---|']
for m in MODELS:
    for d in DAYS:
        j = get(m, d)
        if 'error' in j:
            rows.append(f'| {m} | {d} | | | | | | | | {j["error"][:80]} |'); continue
        h = j.get('hourly', {})
        cnt = lambda k: sum(1 for v in h.get(k, []) if v is not None)
        cells = [str(cnt(f'precipitation_previous_day{n}')) for n in OFFS]
        rows.append(f'| {m} | {d} | ' + ' | '.join(cells) + f' | {cnt("temperature_2m_previous_day3")} | {cnt("wind_speed_10m_previous_day3")} | |')
        time.sleep(1)
open('data/backtest/probe_previous_runs.md', 'w', encoding='utf-8').write('\n'.join(rows) + '\n')
print('\n'.join(rows))
