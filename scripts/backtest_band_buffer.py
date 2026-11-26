#!/usr/bin/env python3
"""雪带（R8／O9）加宽格点的回测，只用标准库。

问题：MSM 报的雪带常常离实际位置偏 10–20 公里。现在只看道央道沿线 9 个格点（回程 5 个），
雪带落在格点之间或路线两侧时看不到。把路线两侧 5、10、15、20 公里内的 MSM 网格都算进来，
接住的封路和空报各变多少？

做法：
- 网格：北纬 42.90–43.95、东经 141.05–142.40，按 MSM 自己的网格间距（纬度 0.05°、经度 0.0625°，约 5 公里）取点，
  只留离路线 20 公里以内的。去程路线是 札幌→江別東IC→江別東—岩見沢之间→岩見沢→三笠IC→美唄IC→奈井江砂川IC→砂川・滝川→深川
  这几个格点连成的折线（和 R8 的 9 个格点一致）；回程是 札幌→……→三笠IC 那一段。
- 数据：Open-Meteo 往期预报接口里“提前一天那一轮”的 MSM（precipitation_previous_day1、temperature_2m_previous_day1），
  与 scripts/backtest_snowband.py 相同；冷降水＝气温 ≤0.5 ℃ 那几个小时的降水。
- 时间窗：与现行规则相同，去程看前一天 18 时到当天 11 时，回程看当天 05–20 时；另算一遍全天口径作对照。
- 每一档半径的点集＝现行 9 个格点（回程 5 个）加上离路线不超过该半径的网格点，任一点达到门槛就算亮。
- 标签：data/labels.csv 里逐日核对过的日子；“全天封路”看一日游高速段当天有没有封，“行程时段封路”看去程 09–11 时、回程 19–20 时有没有封着。

用法：python3 scripts/backtest_band_buffer.py   （要能连 previous-runs-api.open-meteo.com；取过的数存在
      data/backtest/msm_prev_day1_cold_grid.json.gz，再跑时直接读，不重取）
输出：data/backtest/band_buffer.md、data/backtest/band_buffer.json
"""
import datetime as dt, gzip, json, math, pathlib, sys, time, urllib.error, urllib.parse, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import backtest_snowband as B  # noqa: E402

OUT = B.OUT
CACHE = OUT / 'msm_prev_day1_cold_grid.json.gz'

OUT_LINE = [B.P9[k] for k in ('A1 札幌', 'E1 江別東IC', 'E2 江別東IC—岩見沢IC 之间', 'A2 岩見沢', 'E3 三笠IC',
                              'E4 美唄IC', 'E5 奈井江砂川IC', 'A3 砂川・滝川', 'A4 深川')]
RET_LINE = OUT_LINE[:5]
LAT0 = 43.35
RADII = (5, 10, 15, 20)
WIN = {'out': (-5, 11), 'ret': (6, 20)}          # 与现行规则相同（win_max 的参数）
WIN_ALL = {'out': (-1, 24), 'ret': None}           # 全天口径
RULES = (('R8 3h≥7 或 6h≥10', 7, 10), ('O9 3h≥4.5 或 6h≥6', 4.5, 6))
CHUNK = 45


def xy(p):
    return ((p[1] - 141.6) * math.cos(math.radians(LAT0)) * 111.32, (p[0] - LAT0) * 110.57)


def dist_side(p, line):
    """到折线的最短距离（公里）和在路线前进方向的哪一侧（'左'＝西北侧，'右'＝东南侧）。"""
    best = (1e9, '')
    px, py = xy(p)
    for a, b in zip(line, line[1:]):
        ax, ay = xy(a)
        bx, by = xy(b)
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        d = math.hypot(px - ax - t * dx, py - ay - t * dy)
        if d < best[0]:
            cross = dx * (py - ay) - dy * (px - ax)
            best = (d, '左' if cross > 0 else '右')
    return best


def grid():
    pts = {}
    i = 0
    while 42.90 + i * 0.05 <= 43.95 + 1e-9:
        lat = round(42.90 + i * 0.05, 3)
        j = 0
        while 141.05 + j * 0.0625 <= 142.40 + 1e-9:
            lon = round(141.05 + j * 0.0625, 4)
            d, s = dist_side((lat, lon), OUT_LINE)
            if d <= 20.5:
                dr, _ = dist_side((lat, lon), RET_LINE)
                pts[f'G{lat:.2f}_{lon:.4f}'] = {'lat': lat, 'lon': lon, 'd_out': round(d, 1), 'd_ret': round(dr, 1), 'side': s}
            j += 1
        i += 1
    return pts


def fetch(points, start, end):
    """points：{名称: (纬度, 经度)}；分批取，碰到 429 等一会儿再取。"""
    names = list(points)
    out = {}
    for k in range(0, len(names), CHUNK):
        part = names[k:k + CHUNK]
        q = {
            'latitude': ','.join(str(points[n][0]) for n in part),
            'longitude': ','.join(str(points[n][1]) for n in part),
            'models': 'jma_msm', 'hourly': 'precipitation_previous_day1,temperature_2m_previous_day1',
            'start_date': start.isoformat(), 'end_date': (end + dt.timedelta(days=1)).isoformat(),
            'timezone': 'Asia/Tokyo', 'elevation': ','.join('nan' for _ in part), 'cell_selection': 'nearest',
        }
        url = 'https://previous-runs-api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode(q, safe=',/')
        last = None
        for attempt in range(6):
            try:
                with urllib.request.urlopen(url, timeout=180) as r:
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
            cold = {}
            for t, p, T in zip(h['time'], h['precipitation_previous_day1'], h['temperature_2m_previous_day1']):
                if p is None or T is None:
                    continue
                cold[t] = round(p if T <= B.COLD else 0.0, 2)
            out[n] = {'cell': [jj.get('latitude'), jj.get('longitude')], 'cold': cold}
        time.sleep(65)  # 免费接口每分钟有上限，一批之间隔开
    return out


def load_or_fetch(points, L):
    rng = [(a.isoformat(), b.isoformat()) for a, b in B.seasons(L)]
    cache = None
    if CACHE.exists():
        with gzip.open(CACHE, 'rt', encoding='utf-8') as f:
            cache = json.load(f)
    data = {n: {'cell': None, 'cold': {}} for n in points}
    have = {tuple(x) for x in cache['ranges']} if cache else set()
    for a, b in rng:
        if cache and (a, b) in have and all(n in cache['points'] for n in points):
            for n in points:
                data[n]['cell'] = cache['points'][n]['cell']
                for t, v in cache['points'][n]['cold'].items():
                    if a <= t[:10] <= (dt.date.fromisoformat(b) + dt.timedelta(days=1)).isoformat():
                        data[n]['cold'][t] = v
            continue
        got = fetch(points, dt.date.fromisoformat(a), dt.date.fromisoformat(b))
        for n, v in got.items():
            data[n]['cell'] = v['cell']
            data[n]['cold'].update(v['cold'])
    # 存缓存：只存非零小时，另记每点有数据的小时范围
    store = {'note': '前一天那一轮 MSM 的逐时冷降水（气温 ≤0.5 ℃ 的小时的降水，mm）；cold 里只列非零小时，'
                     'hours 是有数据的小时数；时刻为该小时结束的东京时间。',
             'ranges': rng, 'points': {}}
    for n, v in data.items():
        store['points'][n] = {'cell': v['cell'], 'hours': len(v['cold']),
                              'cold': {t: c for t, c in v['cold'].items() if c}}
    with gzip.open(CACHE, 'wt', encoding='utf-8') as f:
        json.dump(store, f, ensure_ascii=False)
    return data


def main():
    L = B.labels()
    LT = B.labels('一日游行程时段封路')
    OUT.mkdir(parents=True, exist_ok=True)
    G = grid()
    pts = {n: (v['lat'], v['lon']) for n, v in G.items()}
    pts.update(B.P9)
    data = load_or_fetch(pts, L)
    # 逐时冷降水序列：每个季节从第一天的前一天到最后一天的后一天，缺的小时按 0 算
    S = {n: {} for n in pts}
    for a, b in B.seasons(L):
        start = dt.datetime(a.year, a.month, a.day) - dt.timedelta(days=1)
        end = dt.datetime(b.year, b.month, b.day) + dt.timedelta(days=2)
        for n in pts:
            cold = data[n]['cold']
            t = start
            while t <= end:
                S[n][t] = cold.get(t.strftime('%Y-%m-%dT%H:%M'), 0.0)
                t += dt.timedelta(hours=1)
    roll = {n: (B.rolling(s, 3), B.rolling(s, 6)) for n, s in S.items()}

    # 去掉落在同一个 MSM 网格里的重复点
    seen, dup = {}, set()
    for n in pts:
        c = tuple(data[n]['cell'] or ())
        if c and c in seen and n.startswith('G'):
            dup.add(n)
        else:
            seen[c] = n
    gnames = [n for n in G if n not in dup]

    def sets(r, side=None):
        out = list(B.P9) + [n for n in gnames if G[n]['d_out'] <= r + 0.5 and (side is None or G[n]['side'] == side)]
        ret = list(B.RET5) + [n for n in gnames if G[n]['d_ret'] <= r + 0.5 and (side is None or G[n]['side'] == side)]
        return out, ret

    variants = [('现行 9 个格点（回程 5 个）', list(B.P9), list(B.RET5))]
    for r in RADII:
        o, rt = sets(r)
        variants.append((f'加上路线两侧 {r} 公里以内（去程 {len(o)} 点、回程 {len(rt)} 点）', o, rt))
    for side, nm in (('左', '只加西北侧'), ('右', '只加东南侧')):
        o, rt = sets(20, side)
        variants.append((f'{nm} 20 公里以内（去程 {len(o)} 点、回程 {len(rt)} 点）', o, rt))

    def signal(names_out, names_ret, win):
        sig, who = {}, {}
        for d in B.season_days(L):
            best = (0.0, 0.0, '')
            for n in names_out:
                m3, m6 = B.win_max(roll[n][0], roll[n][1], d, *win['out'])
                if m3 > best[0]:
                    best = (m3, best[1], n)
                best = (best[0], max(best[1], m6), best[2])
            if win['ret']:
                for n in names_ret:
                    m3, m6 = B.win_max(roll[n][0], roll[n][1], d, *win['ret'])
                    if m3 > best[0]:
                        best = (m3, best[1], n)
                    best = (best[0], max(best[1], m6), best[2])
            sig[d.isoformat()] = (best[0], best[1])
            who[d.isoformat()] = best[2]
        return sig, who

    rows = ['| 点集 | 时间窗 | 门槛 | 对照的标签 | 亮的天数 | 其中封路 | 没封路 | 漏掉的封路日 |', '|---|---|---|---|---|---|---|---|']
    js = {'grid_points': len(gnames), 'duplicates_dropped': len(dup), 'results': {}, 'days': {}}
    base = {}
    diffs = []
    for vname, o, rt in variants:
        for wname, win in (('现行时间窗', WIN), ('全天', WIN_ALL)):
            sig, who = signal(o, rt, win)
            js['days'][f'{vname}|{wname}'] = {k: [round(v[0], 1), round(v[1], 1), who[k]] for k, v in sig.items()}
            for rname, r3, r6 in RULES:
                for lname, LL in (('全天封路', L), ('行程时段封路', LT)):
                    res = B.score(sig, LL, [(rname, r3, r6)])[0]
                    key = (wname, rname, lname)
                    js['results'][f'{vname}|{wname}|{rname}|{lname}'] = res
                    rows.append(f"| {vname} | {wname} | {rname} | {lname} | {res['fired']} | {res['hit']} | {res['false']} | "
                                f"{res['missed']}／{B.n_closed(LL)} |")
                    if vname.startswith('现行'):
                        base[key] = res
                    elif wname == '现行时间窗':
                        b = base[key]
                        new = [x for x in res['fired_days'] if x not in b['fired_days']]
                        if new:
                            diffs.append(f"- {vname}，{rname}，对{lname}：新亮 {len(new)} 天（{'、'.join(new)}）")
    # 新亮的日子里，最大值落在哪个点、离路线多远
    detail = []
    for vname, o, rt in variants[1:]:
        if '20 公里' not in vname or '只加' in vname:
            continue
        sig, who = signal(o, rt, WIN)
        sig0, who0 = signal(*variants[0][1:], WIN)
        for d in sorted(sig):
            c, a = L.get(d, ('否', '不详'))
            if c != '是':
                continue
            for rname, r3, r6 in RULES:
                if B.fired(*sig[d], r3, r6) and not B.fired(*sig0[d], r3, r6):
                    n = who[d]
                    g = G.get(n, {})
                    _, at = LT.get(d, ('否', '不详'))
                    detail.append(f"| {d} | {rname[:2]} | {sig[d][0]:.1f}／{sig[d][1]:.1f} | {sig0[d][0]:.1f}／{sig0[d][1]:.1f} | "
                                  f"{n} | {g.get('d_out', '')} 公里，{g.get('side', '')}侧 | {'封' if a == '是' else '没封'} | {at} |")
                    break
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).strftime('%Y-%m-%d %H:%M')
    md = [f'# 雪带加宽格点回测\n\n生成：{now}（东京时间），脚本 `scripts/backtest_band_buffer.py`，做法见脚本开头。'
          f'回测范围：{"，".join(f"{a}～{b}" for a, b in B.seasons(L))}；逐日核对过的 {B.n_checked(L)} 天，'
          f'一日游高速段全天封路 {B.n_closed(L)} 天，行程时段封路 {B.n_closed(LT)} 天。'
          f'网格点 {len(gnames)} 个（去掉落在同一 MSM 网格里的 {len(dup)} 个重复点）。'
          '“现行时间窗”是去程前一天 18 时到当天 11 时、回程 05–20 时；“全天”是当天 01–24 时结束的窗口。\n\n'
          '这里所有点都按“最近的网格、不做海拔订正”取数，现行 9 个格点也一样，所以第一行的数字可能和 snowband_2025-26.md 里的略有出入。\n\n'
          '数据：Open-Meteo 往期预报接口，Weather data by Open-Meteo.com（CC BY 4.0），原始模式为日本气象厅 MSM。',
          '## 结果\n\n' + '\n'.join(rows),
          '## 和现行 9 个格点相比新亮的日子（现行时间窗，●封了 ○没封）\n\n' + ('\n'.join(diffs) or '无'),
          '## 加到 20 公里后新亮的日子，最大值落在哪里（现行时间窗）\n\n'
          '| 日期 | 规则 | 3h／6h 冷降水（mm） | 现行 9 点的 3h／6h | 最大值所在网格点 | 离去程路线 | 当天封路 | 行程时段封路 |\n|---|---|---|---|---|---|---|---|\n'
          + ('\n'.join(detail) or '| 无 | | | | | | | |')]
    (OUT / 'band_buffer.md').write_text('\n\n'.join(md) + '\n', encoding='utf-8')
    js['generated_jst'] = now
    (OUT / 'band_buffer.json').write_text(json.dumps(js, ensure_ascii=False, indent=1), encoding='utf-8')
    print('written', OUT / 'band_buffer.md')


if __name__ == '__main__':
    main()
