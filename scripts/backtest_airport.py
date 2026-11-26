#!/usr/bin/env python3
"""机场线（小樽—札幌—新千岁机场）的封路回测：前一天的 MSM 能不能事先看出札樽道、道央道南段的封路，门槛该定多少。

一日游的雪带规则（R8）是拿道央道札幌—旭川段回测出来的；机场线两段的地形和封路原因不一样（札樽道沿石狩湾，
西北季风时多吹雪；道央道南段相对背风、大雪时长时间封），所以这里单独回测，门槛可以不同。

- 数据：Open-Meteo 往期预报接口里“提前一天那一轮”的 MSM（precipitation／temperature_2m／wind_speed_10m 的 _previous_day1），
  格点与网站机场线雪带地图（data/latest/msm_grid_b.json）相同：机场线两侧 20 公里内 160 个点。
  取过的数存在 data/backtest/msm_prev_day1_airport_grid.json.gz，再跑不用重取。
- 标签：data/source/nexco_x_*.txt（NEXCO 东日本北海道支社 X 帐号的封路帖）经 scripts/labels/x_labels.py 算出的
  天气类封闭区间，分两段：
    B1 札樽道：小樽IC—札幌JCT 全段；
    B2 道央道南段：新千歳空港IC—札幌JCT。
  按网站的六个时段（06–09……21–24）看：某时段里这一段任何方向有天气类封闭在生效，就算这个时段封着。
  某天“封路”指 06–24 时有任何一个时段封着（只在 00–06 时封、06 时前解除的不算）。
  只用 labels.csv 里逐日核对过的日子。
- 格点分组：按离这一段路线（日报的取样点连线：B1 小樽—钱函—札幌，B2 札幌—北广岛—惠庭—新千岁机场）的距离，
  分“沿线”（4 公里以内）、10 公里以内、20 公里以内三组，组内各点取最大值。
- 预报窗口：和一日游一样往前多看 6 小时。某时段 [h0, h1) 用结束时刻在 h0−3 到 h1 的 3 小时合计、h0 到 h1 的 6 小时合计，
  以及 h0−6 到 h1 之间的逐时风速和推算视程。
- 冷降水：气温 ≤0.5 ℃ 那几个小时的降水。
- 推算视程：用规则里的公式（风速乘 0.81 折到 1.2 m 高）。fresh（地上有能吹起来的新雪）按“之前 24 小时冷降水 ≥0.5 mm、
  之前 12 小时气温高于 0.5 ℃ 的降水 <1 mm，并且当时气温 ≤0 ℃”近似。
- 只回测数值模式这一半；气象厅的信号去年没有存档。

用法：python3 scripts/backtest_airport.py（要能连 previous-runs-api.open-meteo.com，GitHub Actions 里跑）
输出：data/backtest/airport.md、data/backtest/airport.json
"""
import datetime as dt, gzip, json, math, pathlib, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'scripts' / 'labels'))
import backtest_snowband as B  # noqa: E402
import x_labels as XL  # noqa: E402

OUT = ROOT / 'data' / 'backtest'
CACHE = OUT / 'msm_prev_day1_airport_grid.json.gz'
CHUNK = 40
COLD = B.COLD
SLOTS = [(6, 9), (9, 12), (12, 15), (15, 18), (18, 21), (21, 24)]

LINE_B = [(43.19, 141.00), (43.14, 141.21), (43.06, 141.35), (42.98, 141.56), (42.88, 141.58), (42.78, 141.69)]
SEG_LINE = {'B1': LINE_B[:3], 'B2': LINE_B[2:]}
SEG_NAME = {'B1': '札樽道（小樽IC—札幌JCT）', 'B2': '道央道南段（新千歳空港IC—札幌JCT）'}
SEG_UNITS = {
    'B1': {('札樽', i) for i in range(len(XL.SATO) - 1)},
    'B2': {('道央', i) for i in range(XL.POS['道央']['新千歳空港IC'], XL.POS['道央']['札幌JCT'])},
}
GROUPS = [('沿线', 4.0), ('10 公里内', 10.5), ('20 公里内', 20.5)]


def xy(p):
    return ((p[1] - 141.6) * math.cos(math.radians(43.35)) * 111.32, (p[0] - 43.35) * 110.57)


def dist(p, line):
    px, py = xy(p)
    best = 1e9
    for a, b in zip(line, line[1:]):
        ax, ay = xy(a); bx, by = xy(b)
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(px - ax - t * dx, py - ay - t * dy))
    return best


def grid():
    """与 scripts/fetch-data.mjs 的 gridPointsB 相同。"""
    pts = {}
    for i in range(-6, 11):
        lat = round(42.90 + i * 0.05, 3)
        if lat > 43.40 + 1e-9:
            break
        for j in range(-5, 16):
            lon = round(141.05 + j * 0.0625, 4)
            if lon > 141.99 + 1e-9:
                break
            if dist((lat, lon), LINE_B) <= 20.5:
                pts[f'{lat:.3f},{lon:.4f}'] = (lat, lon)
    return pts


def fetch(points, start, end):
    names = list(points)
    out = {}
    for k in range(0, len(names), CHUNK):
        part = names[k:k + CHUNK]
        q = {
            'latitude': ','.join(str(points[n][0]) for n in part),
            'longitude': ','.join(str(points[n][1]) for n in part),
            'models': 'jma_msm',
            'hourly': 'precipitation_previous_day1,temperature_2m_previous_day1,wind_speed_10m_previous_day1',
            'wind_speed_unit': 'ms',
            'start_date': start.isoformat(), 'end_date': (end + dt.timedelta(days=1)).isoformat(),
            'timezone': 'Asia/Tokyo', 'elevation': ','.join('nan' for _ in part), 'cell_selection': 'nearest',
        }
        url = 'https://previous-runs-api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode(q, safe=',/')
        last = None
        for attempt in range(6):
            try:
                with urllib.request.urlopen(url, timeout=240) as r:
                    j = json.loads(r.read())
                break
            except urllib.error.HTTPError as e:
                last = f'{e.code} {e.read()[:200]!r}'
                time.sleep(75 if e.code == 429 else 15 * (attempt + 1))
            except Exception as e:  # 网络中断
                last = repr(e)
                time.sleep(15 * (attempt + 1))
        else:
            raise RuntimeError(f'previous-runs-api 取不到（第 {k // CHUNK + 1} 批）：{last}')
        j = j if isinstance(j, list) else [j]
        for n, jj in zip(part, j):
            h = jj['hourly']
            q10 = lambda v: None if v is None else round(v * 10)
            out[n] = {'time': h['time'], 'P': [q10(v) for v in h['precipitation_previous_day1']],
                      'T': [q10(v) for v in h['temperature_2m_previous_day1']],
                      'V': [q10(v) for v in h['wind_speed_10m_previous_day1']]}
        print(f'  取到第 {k // CHUNK + 1} 批（{len(part)} 点，{start}～{end}）', flush=True)
        time.sleep(65)  # 免费接口每分钟有上限
    return out


def load_or_fetch(points, L):
    rng = [(a.isoformat(), b.isoformat()) for a, b in B.seasons(L)]
    cache = {'note': '前一天那一轮 MSM 的逐时降水（mm×10）、气温（℃×10）、10 m 风速（m/s×10）；time 为该小时结束的东京时间。',
             'seasons': {}}
    if CACHE.exists():
        with gzip.open(CACHE, 'rt', encoding='utf-8') as f:
            cache = json.load(f)
    for a, b in rng:
        key = f'{a}~{b}'
        got = cache['seasons'].get(key)
        if got and all(n in got for n in points):
            continue
        print(f'取 {key}', flush=True)
        cache['seasons'][key] = fetch(points, dt.date.fromisoformat(a), dt.date.fromisoformat(b))
    with gzip.open(CACHE, 'wt', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, separators=(',', ':'))
    # 合并成 {点: {时刻: (P, T, V)}}
    data = {n: {} for n in points}
    for key, season in cache['seasons'].items():
        if tuple(key.split('~')) not in rng:
            continue
        for n in points:
            s = season[n]
            for t, p, T, V in zip(s['time'], s['P'], s['T'], s['V']):
                if p is None or T is None or V is None:
                    continue
                data[n][dt.datetime.fromisoformat(t)] = (p / 10, T / 10, V / 10)
    return data


def vis(V, P, T, fresh):
    N = P * 0.2778 / 1.2
    if T <= 0 and fresh and V > 0:
        N += 18 * 8 ** (-0.35 / (0.4 * 0.036 * V))
    Mf = max(N * 0.81 * V, 1e-6)
    return 10 ** (2.85 - 0.773 * math.log10(Mf))


def point_series(s):
    """s：{时刻: (P, T, V)} → {时刻: dict(c3, c6, c1, V, vis)}。"""
    ts = sorted(s)
    cold = {t: (p if T <= COLD else 0.0) for t, (p, T, V) in s.items()}
    warm = {t: (p if T > COLD else 0.0) for t, (p, T, V) in s.items()}
    out = {}
    for t in ts:
        p, T, V = s[t]
        w = lambda n, src: sum(src.get(t - dt.timedelta(hours=k), 0.0) for k in range(n))
        c3, c6 = w(3, cold), w(6, cold)
        fresh = w(24, cold) >= 0.5 and w(12, warm) < 1.0
        out[t] = {'c1': cold[t], 'c3': c3, 'c6': c6, 'V': V, 'T': T, 'vis': vis(V, p if T <= 1 else 0.0, T, fresh)}
    return out


def closed_slots(spans, units, d):
    res = []
    for h0, h1 in SLOTS:
        w0 = dt.datetime.combine(d, dt.time()) + dt.timedelta(hours=h0)
        w1 = dt.datetime.combine(d, dt.time()) + dt.timedelta(hours=h1)
        c = any((road, i) in units and any(a < w1 and b > w0 for a, b in iv) for (road, i, s), iv in spans.items())
        res.append(c)
    return res


# 规则：(名称, 函数(feat) → bool)；feat 是某组在某时段窗口里的统计量
def P_rule(x3, x6):
    name = ' 或 '.join(([f'3h≥{x3:g}'] if x3 else []) + ([f'6h≥{x6:g}'] if x6 else []))
    return (name, lambda f: (x3 is not None and f['c3'] >= x3) or (x6 is not None and f['c6'] >= x6))


def WS_rule(v, p):
    return (f'风≥{v:g} 且当小时冷降水≥{p:g}', lambda f: f['ws'][p] >= v)


def VIS_rule(m):
    return (f'推算视程<{m:g} m', lambda f: f['vis'] < m)


def OR(*rs):
    return (' ｜ '.join(r[0] for r in rs), lambda f: any(r[1](f) for r in rs))


RULES = [P_rule(x, None) for x in (3, 4, 5, 6, 7, 8, 10)] + \
        [P_rule(a, b) for a, b in ((4, 6), (4.5, 6), (5, 7), (5, 8), (6, 8), (6, 10), (7, 10), (8, 12), (10, 14))] + \
        [P_rule(None, b) for b in (6, 8, 10, 12, 15)] + \
        [WS_rule(v, p) for v in (6, 8, 10, 12, 14) for p in (0.5, 1, 2)] + \
        [VIS_rule(m) for m in (200, 300, 500)] + \
        [OR(P_rule(a, b), WS_rule(v, p)) for a, b in ((5, 8), (6, 10), (7, 10)) for v, p in ((8, 1), (10, 1), (12, 0.5))] + \
        [OR(P_rule(a, b), VIS_rule(200)) for a, b in ((5, 8), (6, 10), (7, 10))]


def window_feats(series, names, d, h0, h1):
    base = dt.datetime.combine(d, dt.time())
    e3 = [base + dt.timedelta(hours=h) for h in range(h0 - 3, h1 + 1)]
    e6 = [base + dt.timedelta(hours=h) for h in range(h0, h1 + 1)]
    eh = [base + dt.timedelta(hours=h) for h in range(h0 - 5, h1 + 1)]
    c3 = c6 = 0.0
    v_min = 1e9
    ws = {0.5: 0.0, 1: 0.0, 2: 0.0}   # 当小时冷降水达到 p 的那些小时里的最大风速
    for n in names:
        s = series[n]
        c3 = max([c3] + [s[t]['c3'] for t in e3 if t in s])
        c6 = max([c6] + [s[t]['c6'] for t in e6 if t in s])
        for t in eh:
            if t in s:
                v_min = min(v_min, s[t]['vis'])
                for p in ws:
                    if s[t]['c1'] >= p and s[t]['V'] > ws[p]:
                        ws[p] = s[t]['V']
    return {'c3': c3, 'c6': c6, 'vis': v_min, 'ws': ws}


def stats(pairs):
    fire = sum(1 for f, c in pairs if f); hit = sum(1 for f, c in pairs if f and c)
    closed = sum(1 for f, c in pairs if c)
    prec = hit / fire if fire else 0.0; rec = hit / closed if closed else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {'fired': fire, 'hit': hit, 'false': fire - hit, 'missed': closed - hit, 'closed': closed,
            'precision': round(prec, 3), 'recall': round(rec, 3), 'f1': round(f1, 3)}


def main():
    L = B.labels('机场线高速段封路')
    checked = sorted(dt.date.fromisoformat(d) for d, (c, _) in L.items() if c == '是' and B.in_season(L, d))
    ev, cover = XL.load()
    _, _, spans = XL.simulate(ev, cover, with_spans=True)
    pts = grid()
    print(f'格点 {len(pts)} 个，核对过的日子 {len(checked)} 天', flush=True)
    raw = load_or_fetch(pts, L)
    series = {n: point_series(raw[n]) for n in pts}
    res = {'points': len(pts), 'days': len(checked), 'segments': {}}
    md = ['# 机场线封路回测（前一天的 MSM）', '',
          f'核对过封路的日子 {len(checked)} 天（{checked[0]}～{checked[-1]}，中间跳过 4–10 月）。格点 {len(pts)} 个（机场线两侧 20 公里）。'
          '口径见 scripts/backtest_airport.py 开头。“天”按 06–24 时有没有封路算；“时段”按网站的六个 3 小时时段算。'
          '准确率＝亮的里面真封了的比例，召回率＝封了的里面事先亮了的比例，F1 是两者的调和平均。', '']
    for seg in ('B1', 'B2'):
        units = SEG_UNITS[seg]
        lab = {d: closed_slots(spans, units, d) for d in checked}
        n_day = sum(1 for d in checked if any(lab[d])); n_slot = sum(sum(v) for v in lab.values())
        seg_res = {'closed_days': n_day, 'closed_slots': n_slot,
                   'closed_dates': [d.isoformat() for d in checked if any(lab[d])], 'groups': {}}
        md += [f'## {SEG_NAME[seg]}', '', f'06–24 时封过路的日子 {n_day} 天，封着的时段 {n_slot} 个（共 {len(checked) * 6} 个）。', '']
        for gname, km in GROUPS:
            names = [n for n, p in pts.items() if dist(p, SEG_LINE[seg]) <= km]
            feats = {d: [window_feats(series, names, d, h0, h1) for h0, h1 in SLOTS] for d in checked}
            rows = []
            for rname, fn in RULES:
                slot_pairs, day_pairs, fired_days, missed_days = [], [], [], []
                for d in checked:
                    fs = [fn(f) for f in feats[d]]
                    slot_pairs += list(zip(fs, lab[d]))
                    df, dc = any(fs), any(lab[d])
                    day_pairs.append((df, dc))
                    if df:
                        fired_days.append(d.isoformat()[2:] + ('●' if dc else '○'))
                    elif dc:
                        missed_days.append(d.isoformat()[2:])
                rows.append({'rule': rname, 'day': stats(day_pairs), 'slot': stats(slot_pairs),
                             'fired_days': fired_days, 'missed_days': missed_days})
            seg_res['groups'][gname] = {'n_points': len(names), 'rules': rows}
            top = sorted(rows, key=lambda r: (-r['day']['f1'], -r['slot']['f1']))[:12]
            md += [f'### {gname}（{len(names)} 个格点），按“天”的 F1 排前 12', '',
                   '| 门槛 | 亮的天数 | 其中封路 | 准确率 | 召回率 | F1 | 时段：亮／中／准确率／召回率 |', '|---|---|---|---|---|---|---|']
            for r in top:
                a, s = r['day'], r['slot']
                md.append(f"| {r['rule']} | {a['fired']} | {a['hit']} | {a['precision']:.0%} | {a['recall']:.0%} | {a['f1']:.2f} | "
                          f"{s['fired']}／{s['hit']}／{s['precision']:.0%}／{s['recall']:.0%} |")
            r8 = next(r for r in rows if r['rule'] == '3h≥7 或 6h≥10')
            md += ['', f"对照：一日游的雪带门槛（3h≥7 或 6h≥10）在这一组亮 {r8['day']['fired']} 天，其中封路 {r8['day']['hit']} 天，"
                       f"漏 {r8['day']['missed']} 天。", '']
        best = max(seg_res['groups']['沿线']['rules'], key=lambda r: (r['day']['f1'], r['slot']['f1']))
        md += [f"沿线组 F1 最高的门槛“{best['rule']}”：亮的日子 {'、'.join(best['fired_days']) or '无'}；"
               f"漏掉的封路日 {'、'.join(best['missed_days']) or '无'}。", '']
        res['segments'][seg] = seg_res
    (OUT / 'airport.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    (OUT / 'airport.json').write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8')
    print('写好了 data/backtest/airport.md、airport.json')


if __name__ == '__main__':
    main()
