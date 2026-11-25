#!/usr/bin/env python3
"""雪带规则（R8／O9／R9）的回测，只用标准库。

第一段（实况→封路）：data/obs/ 里岩見沢、札幌两站的逐时实测，统计“3 小时降水达到多少”的日子里有几天封了路。
第二段（前一天的 MSM→封路）：Open-Meteo 往期预报接口（previous-runs-api）里“提前一天那一轮”的 MSM
  逐时降水和气温（变量名带 _previous_day1），在道央道沿线格点上按 R8／O9 的门槛算，看亮的日子里有几天封了路。
标签：data/labels.csv 里“逐日核对”为“是”的日子，范围是 2025–26 整个冬季（11-01～3-31）和 2026–27 冬季已标到的日子，天数写在输出里，
  只看一日游高速段（道央道 札幌—旭川）有没有封路，任何时刻封都算。

口径：
- 冷降水：第二段（MSM，对应 R8）是气温 ≤0.5 ℃ 那几个小时的降水相加；第一段（实况，对应 R9）要求窗口里每一小时
  气温都 ≤0.5 ℃，有一小时更暖，这个窗口就记 0。
- 3 小时、6 小时合计按“该小时结束的时刻”滑动，全部用东京时间。
- 全天口径：当天 01:00～次日 00:00 结束的各个窗口里取最大值。
- 行程口径：去程高速 09–11 时和回程高速 19–20 时，各自往前多看 6 小时（03–11 时、13–20 时），只取完全落在里面的窗口。
- 第二段只回测降水量这一半；R8 另一半“气象厅给了雪的信号”，去年冬天的气象厅产品没有存档，回测不了。

用法：python3 scripts/backtest_snowband.py            （两段都跑，要能连 previous-runs-api.open-meteo.com）
      python3 scripts/backtest_snowband.py --obs-only （只跑第一段）
输出：data/backtest/snowband_2025-26.md、data/backtest/snowband_2025-26.json
"""
import csv, datetime as dt, json, pathlib, sys, time, urllib.request, urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'backtest'
SEASONS = [(dt.date(2025, 11, 1), dt.date(2026, 3, 31)), (dt.date(2026, 11, 1), None)]  # None：到 labels.csv 里最后一个核对过的日子
COLD = 0.5

# 生产用的格点（R8：①–④ 加 ⑪–⑮，坐标与网站、定时任务一致）
P9 = {
    'A1 札幌': (43.06, 141.35), 'A2 岩見沢': (43.20, 141.76), 'A3 砂川・滝川': (43.53, 141.91), 'A4 深川': (43.72, 142.05),
    'E1 江別東IC': (43.107, 141.598), 'E2 江別東IC—岩見沢IC 之间': (43.142, 141.681), 'E3 三笠IC': (43.243, 141.827),
    'E4 美唄IC': (43.334, 141.890), 'E5 奈井江砂川IC': (43.450, 141.915),
}
# 2026-11-25 第一次回测用的 8 个格点（后 4 个是当时的近似坐标）
OLD8 = {k: P9[k] for k in ('A1 札幌', 'A2 岩見沢', 'A3 砂川・滝川', 'A4 深川')}
OLD8.update({'EH 江別東附近': (43.13, 141.60), 'KZ 江別東—岩見沢附近': (43.16, 141.70),
             'BB 美唄附近': (43.33, 141.86), 'NS 奈井江砂川附近': (43.43, 141.88)})

RULES_MSM = [  # (名称, 3 小时门槛, 6 小时门槛)，任一条达到就算亮
    ('3h≥6', 6, None), ('3h≥7 或 6h≥10（R8）', 7, 10), ('3h≥8 或 6h≥12', 8, 12),
    ('3h≥5 或 6h≥8', 5, 8), ('3h≥4.5 或 6h≥6（O9）', 4.5, 6),
]
RULES_OBS = [('3h≥5（R9）', 5, None), ('3h≥6', 6, None), ('3h≥7 或 6h≥10', 7, 10), ('3h≥4.5 或 6h≥6', 4.5, 6)]


def labels():
    L = {}
    with open(ROOT / 'data' / 'labels.csv', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            L[r['日期']] = (r['逐日核对'], r['一日游高速段封路'])
    return L


def seasons(L):
    """把 SEASONS 里没写终点的季节补上终点（该季最后一个核对过的日子）。"""
    out = []
    for a, b in SEASONS:
        if b is None:
            ds = [dt.date.fromisoformat(d) for d, (c, _) in L.items() if c == '是' and dt.date.fromisoformat(d) >= a]
            if not ds:
                continue
            b = max(ds)
        out.append((a, b))
    return out


def in_season(L, d):
    d = dt.date.fromisoformat(d) if isinstance(d, str) else d
    return any(a <= d <= b for a, b in seasons(L))


def season_days(L):
    for a, b in seasons(L):
        d = a
        while d <= b:
            yield d
            d += dt.timedelta(days=1)


def n_checked(L):
    """回测范围里逐日核对过的天数。"""
    return sum(1 for d, (c, _) in L.items() if c == '是' and in_season(L, d))


def n_closed(L):
    return sum(1 for d, v in L.items() if v == ('是', '是') and in_season(L, d))


def rolling(series, n):
    """series：{结束时刻: 冷降水}；返回 {结束时刻: 前 n 小时合计}，缺小时的窗口不算。"""
    out = {}
    for t in series:
        ks = [t - dt.timedelta(hours=k) for k in range(n)]
        if all(k in series for k in ks):
            out[t] = sum(series[k] for k in ks)
    return out


def day_windows(d):
    base = dt.datetime(d.year, d.month, d.day)
    allday = [base + dt.timedelta(hours=h) for h in range(1, 25)]
    trip = [(base + dt.timedelta(hours=4), base + dt.timedelta(hours=11)),   # 去程 09–11，往前看 6 小时
            (base + dt.timedelta(hours=14), base + dt.timedelta(hours=20))]  # 回程 19–20，往前看 6 小时
    return allday, trip


def day_max(s3, s6, d, mode):
    allday, trip = day_windows(d)
    if mode == 'all':
        m3 = max((s3.get(t, 0) for t in allday), default=0)
        m6 = max((s6.get(t, 0) for t in allday), default=0)
        return m3, m6
    m3 = m6 = 0.0
    for a, b in trip:
        for t, v in s3.items():
            if t - dt.timedelta(hours=2) >= a and t <= b:
                m3 = max(m3, v)
        for t, v in s6.items():
            if t - dt.timedelta(hours=5) >= a and t <= b:
                m6 = max(m6, v)
    return m3, m6


def fired(m3, m6, r3, r6):
    return m3 >= r3 or (r6 is not None and m6 >= r6)


def score(days, L, key):
    """days：{日期: (m3, m6)}；只在核对过的日子上数。"""
    res = []
    for name, r3, r6 in key:
        fire = hit = false = miss = 0
        fire_days, miss_days = [], []
        for d, (m3, m6) in sorted(days.items()):
            c, a = L.get(d, ('否', '不详'))
            if c != '是':
                continue
            f = fired(m3, m6, r3, r6)
            closed = a == '是'
            if f:
                fire += 1
                fire_days.append(d[2:] + ('●' if closed else '○'))
                if closed:
                    hit += 1
                else:
                    false += 1
            elif closed:
                miss += 1
                miss_days.append(d[2:])
        res.append({'rule': name, 'fired': fire, 'hit': hit, 'false': false, 'missed': miss,
                    'fired_days': fire_days, 'missed_days': miss_days})
    return res


def table(res, total_closed):
    s = ['| 门槛 | 亮的天数 | 其中封路 | 没封路 | 漏掉的封路日 | 亮的日子（●封了 ○没封） |', '|---|---|---|---|---|---|']
    for r in res:
        s.append(f"| {r['rule']} | {r['fired']} | {r['hit']} | {r['false']} | {r['missed']}／{total_closed}（{'、'.join(r['missed_days']) or '无'}） | {'、'.join(r['fired_days']) or '无'} |")
    return '\n'.join(s)


def obs_part(L):
    md, js = [], {}
    stations = [('岩見沢（47413）', 'iwamizawa_47413_hourly.csv'), ('札幌（47412）', 'sapporo_47412_hourly.csv')]
    for name, fn in stations:
        prec, temp, snow = {}, {}, {}
        with open(ROOT / 'data' / 'obs' / fn, encoding='utf-8') as f:
            for r in csv.DictReader(f):
                t = dt.datetime.fromisoformat(r['日期']) + dt.timedelta(hours=int(r['时']))
                prec[t] = float(r['降水量_mm'] or 0)
                temp[t] = float(r['气温_C']) if r['气温_C'] else None
                snow[t] = float(r['降雪_cm'] or 0)
        # 和 R9 一致：窗口里每一小时气温都 ≤0.5 ℃ 才算，否则这个窗口记 0
        def cold_window(n):
            out = {}
            for t in prec:
                ks = [t - dt.timedelta(hours=k) for k in range(n)]
                if all(k in prec for k in ks):
                    ok = all(temp[k] is not None and temp[k] <= COLD for k in ks)
                    out[t] = sum(prec[k] for k in ks) if ok else 0.0
            return out
        s3, s6 = cold_window(3), cold_window(6)
        res_days = {}
        have = {t.date() for t in prec}
        for d in season_days(L):
            if d in have:
                res_days[d.isoformat()] = day_max(s3, s6, d, 'all')
        closed = n_closed(L)
        res = score(res_days, L, RULES_OBS)
        md.append(f'### {name}\n\n全天口径，核对过的 {n_checked(L)} 天，一日游高速段封路 {closed} 天。\n\n' + table(res, closed))
        # 整个冬天（含没核对的日子）达到 3h≥5 的日子，方便以后补标签
        allw = []
        for d_, (m3, m6) in sorted(res_days.items()):
            if m3 >= 5:
                c, a = L.get(d_, ('否', '不详'))
                allw.append(f"{d_[2:]}（{m3:.1f} mm；{'封' if a == '是' else ('没封' if c == '是' else '标签不详')}）")
        md.append(f'回测范围内{name}全天 3 小时冷降水 ≥5 mm 的日子：' + ('、'.join(allw) or '无'))
        js[name] = {'rules': res, 'days': {k: [round(v[0], 1), round(v[1], 1)] for k, v in res_days.items()}}
    return '\n\n'.join(md), js


def fetch_prev_msm(points, start, end):
    lat = ','.join(str(v[0]) for v in points.values())
    lon = ','.join(str(v[1]) for v in points.values())
    q = {
        'latitude': lat, 'longitude': lon, 'models': 'jma_msm',
        'hourly': 'precipitation_previous_day1,temperature_2m_previous_day1',
        'start_date': start.isoformat(), 'end_date': (end + dt.timedelta(days=1)).isoformat(),
        'timezone': 'Asia/Tokyo', 'elevation': ','.join('nan' for _ in points), 'cell_selection': 'land',
    }
    url = 'https://previous-runs-api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode(q, safe=',/')
    last = None
    for k in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                j = json.loads(r.read())
            return (j if isinstance(j, list) else [j]), url
        except Exception as e:
            last = e
            time.sleep(10 * (k + 1))
    raise RuntimeError(f'previous-runs-api 取不到：{last}')


def msm_part(L):
    pts = dict(P9)
    pts.update({k: v for k, v in OLD8.items() if k not in pts})
    cold = {n: {} for n in pts}
    meta = {n: [None, None, 0] for n in pts}
    urls = []
    for a, b in seasons(L):
        data, url = fetch_prev_msm(pts, a, b)
        urls.append(url)
        for (name, _), j in zip(pts.items(), data):
            h = j['hourly']
            meta[name][0], meta[name][1] = j.get('latitude'), j.get('longitude')
            meta[name][2] += sum(1 for v in h['precipitation_previous_day1'] if v is None)
            for t, p, T in zip(h['time'], h['precipitation_previous_day1'], h['temperature_2m_previous_day1']):
                if p is None or T is None:
                    continue
                cold[name][dt.datetime.fromisoformat(t)] = p if T <= COLD else 0.0
    url = ' ; '.join(urls)
    series = {}
    for name in pts:
        series[name] = (rolling(cold[name], 3), rolling(cold[name], 6), meta[name][0], meta[name][1], meta[name][2])

    def set_days(names, mode):
        out, arg = {}, {}
        for d in season_days(L):
            best3 = best6 = 0.0
            who = ''
            for n in names:
                m3, m6 = day_max(series[n][0], series[n][1], d, mode)
                if m3 > best3:
                    best3, who = m3, n
                best6 = max(best6, m6)
            out[d.isoformat()] = (best3, best6)
            arg[d.isoformat()] = who
        return out, arg

    closed = n_closed(L)
    md, js = [], {'url': url, 'grid': {n: {'lat': s[2], 'lon': s[3], 'missing_hours': s[4]} for n, s in series.items()}}
    for set_name, names in (('生产用的 9 个格点（P9）', list(P9)), ('第一次回测的 8 个格点（OLD8）', list(OLD8))):
        for mode, mode_name in (('all', '全天口径'), ('trip', '行程口径')):
            days, arg = set_days(names, mode)
            res = score(days, L, RULES_MSM)
            md.append(f'### {set_name}，{mode_name}\n\n' + table(res, closed))
            js[f'{set_name}|{mode}'] = {'rules': res, 'days': {k: [round(v[0], 1), round(v[1], 1), arg[k]] for k, v in days.items()}}
            if names == list(P9) and mode == 'all':
                lines = []
                for k, (m3, m6) in sorted(days.items()):
                    if fired(m3, m6, 7, 10):
                        c, a = L.get(k, ('否', '不详'))
                        lines.append(f"{k[2:]}（3h {m3:.1f}／6h {m6:.1f} mm，{arg[k]}；{'封' if a == '是' else ('没封' if c == '是' else '标签不详')}）")
                md.append('回测范围内 P9 全天口径达到 R8 降水门槛的日子：' + ('、'.join(lines) or '无'))
    # 单点：每个格点单独当一条规则（R8 门槛、全天口径）
    single = ['| 格点 | 实际网格中心 | 亮的天数 | 其中封路 | 没封路 |', '|---|---|---|---|---|']
    for n in pts:
        days, _ = set_days([n], 'all')
        r = score(days, L, [('R8', 7, 10)])[0]
        s = series[n]
        single.append(f"| {n} | {s[2]:.3f}, {s[3]:.3f} | {r['fired']} | {r['hit']} | {r['false']} |")
    md.append('### 单个格点（R8 降水门槛，全天口径）\n\n' + '\n'.join(single))
    return '\n\n'.join(md), js


def main():
    L = labels()
    OUT.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).strftime('%Y-%m-%d %H:%M')
    rng = '，'.join(f'{a}～{b}' for a, b in seasons(L))
    parts = [f'# 雪带规则回测（2025–26 冬季，加 2026–27 冬季已标到的日子）\n\n生成：{now}（东京时间），脚本 `scripts/backtest_snowband.py`。口径见脚本开头的说明。'
             f'回测范围：{rng}。标签只用“逐日核对”过的 {n_checked(L)} 天（一日游高速段封路 {n_closed(L)} 天），“亮的天数”只数这些天。日期写成“年-月-日”的后两位年份。']
    obs_md, obs_js = obs_part(L)
    parts.append('## 第一段：实况 → 封路\n\n' + obs_md)
    js = {'generated_jst': now, 'obs': obs_js}
    if '--obs-only' not in sys.argv:
        msm_md, msm_js = msm_part(L)
        parts.append('## 第二段：前一天的 MSM → 封路\n\n数据：Open-Meteo 往期预报接口，变量 precipitation_previous_day1、temperature_2m_previous_day1（提前约一天那一轮），'
                     'Weather data by Open-Meteo.com（CC BY 4.0），原始模式为日本气象厅 MSM。\n\n' + msm_md)
        js['msm_prev_day1'] = msm_js
    (OUT / 'snowband_2025-26.md').write_text('\n\n'.join(parts) + '\n', encoding='utf-8')
    (OUT / 'snowband_2025-26.json').write_text(json.dumps(js, ensure_ascii=False, indent=1), encoding='utf-8')
    print('written', OUT)


if __name__ == '__main__':
    main()
