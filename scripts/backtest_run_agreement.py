#!/usr/bin/env python3
"""几轮都报越线，是不是更可能真封路？——雪带（R8）判红要不要看"几轮一致"（2026-11-28 傍晚 M 的问题）。

只用标准库；要能连 open-meteo.com 的两个往期接口，所以放在 GitHub Actions 里跑。

第一段：相隔 24 小时的两轮（2025–26 冬季加 2026 年 11 月里逐日核对过的日子）
  数据：Open-Meteo 往期预报接口（previous-runs-api）里 MSM 的 *_previous_day1、*_previous_day2，
  即每个时刻"提前约 24 小时"和"提前约 48 小时"的那一轮。
  对每个目标日 D，两轮各自用逐时冷降水（气温 ≤0.5 ℃ 那几个小时的降水），按 R8 的降水门槛（3 小时 ≥7 mm 或 6 小时 ≥10 mm）
  和现行时间窗判：去程看 P9 九个点、前一天 18 时到当天 11 时；回程看 RET5 五个点、当天 05–20 时；去程、回程任一越线即这一天越线。
  分四类：两轮都越线／只有提前一天那轮越线／只有提前两天那轮越线／两轮都没越线，看各类后来封路的比例；
  再比三种判法：现行（只看提前一天那轮）、两轮都越线才算、任一轮越线就算。
  只回测降水量这一半；R8 的另一半"气象厅给了雪的信号"去年没有存档，回测不了。
第二段：相隔 3 小时的连续几轮（只有 2026 年 11 月）
  数据：Open-Meteo 单轮接口（single-runs-api），2026-04-02 起存档每个模式的每一轮。
  对 2026 年 11 月的每个目标日，算每一轮各自的去程、回程雪带最大值（该轮的预报要完整盖住时间窗才算），
  列出有一轮越线或封了路的日子里各轮的变化。晚间日报（20:20）能用到的是前一天 06、09、12、15 时起算的 4 轮
  （15 时那轮要到 19:30–20:30 才出来，可能赶不上）。样本很小，只作个案描述。

时刻：降水是"该小时结束时刻"之前一小时的合计，全部按东京时间；3 小时、6 小时合计不跨缺测的小时。
区间：威尔逊 95% 区间；封路日常连着几天，实际不确定性比区间更大。样本内，没有调门槛。
用法：python3 scripts/backtest_run_agreement.py
结果：data/backtest/run_agreement.md、data/backtest/run_agreement.json
"""
import datetime as dt, json, math, pathlib, sys, time, urllib.error, urllib.parse, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import backtest_snowband as bs  # noqa: E402  复用格点、标签、滑动合计、时间窗，和 R8 的回测同一口径

OUT = bs.OUT
JST = dt.timezone(dt.timedelta(hours=9))
R3, R6 = 7, 10
W_OUT, W_RET = (-5, 11), (6, 20)      # 现行时间窗，与 backtest_snowband.py 的"加长"一行相同
NEED_OUT = (-5, 11)                   # 去程要用到的逐时降水：前一天 19 时到当天 11 时结束的各小时
NEED_RET = (6, 20)                    # 回程：当天 06 时到 20 时结束的各小时
EVENING = (6, 9, 12, 15)              # 晚间日报能用到的 4 轮：前一天这几个钟点（东京时间）起算


def wilson(k, n, z=1.96):
    if n == 0:
        return (float('nan'), float('nan'))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def pct(k, n):
    if n == 0:
        return '—'
    a, b = wilson(k, n)
    return f'{k / n:.0%}（{a:.0%}–{b:.0%}）'


def get(url, tries=5):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode('utf-8', 'replace')[:300]
            except Exception:
                body = ''
            if e.code == 400:            # 参数不对或这一轮不存在，重试没用
                raise RuntimeError(f'HTTP 400 {body}')
            last = f'HTTP {e.code} {body}'
        except Exception as e:
            last = e
        if i < tries - 1:
            time.sleep(15 * (i + 1))
    raise RuntimeError(f'取不到：{last}')


def coords(points):
    return {'latitude': ','.join(str(v[0]) for v in points.values()),
            'longitude': ','.join(str(v[1]) for v in points.values()),
            'elevation': ','.join('nan' for _ in points), 'cell_selection': 'land'}


def cold_series(times, prec, temp):
    s = {}
    for t, p, T in zip(times, prec, temp):
        if p is None or T is None:
            continue
        s[dt.datetime.fromisoformat(t)] = p if T <= bs.COLD else 0.0
    return s


def day_signal(ser, d):
    """ser：{格点: (3 小时合计, 6 小时合计)}。返回 (越线, 3h 最大, 6h 最大, 最接近或超过红线的那一处)。"""
    cand = [(*bs.win_max(*ser[n], d, *W_OUT), '去程 ' + n) for n in bs.P9]
    cand += [(*bs.win_max(*ser[n], d, *W_RET), '回程 ' + n) for n in bs.RET5]
    m3 = max(c[0] for c in cand)
    m6 = max(c[1] for c in cand)
    top = max(cand, key=lambda c: max(c[0] / R3, c[1] / R6))
    return bs.fired(m3, m6, R3, R6), m3, m6, top[2]


# ---------------- 第一段 ----------------
def part_a(L, LT):
    pts = bs.P9
    cold = {n: {1: {}, 2: {}} for n in pts}
    nulls = {1: 0, 2: 0}
    urls = []
    for a, b in bs.seasons(L):
        q = dict(coords(pts), models='jma_msm',
                 hourly=','.join(f'{v}_previous_day{k}' for k in (1, 2) for v in ('precipitation', 'temperature_2m')),
                 start_date=(a - dt.timedelta(days=1)).isoformat(), end_date=(b + dt.timedelta(days=1)).isoformat(),
                 timezone='Asia/Tokyo')
        url = 'https://previous-runs-api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode(q, safe=',/')
        urls.append(url)
        data = get(url)
        data = data if isinstance(data, list) else [data]
        for name, j in zip(pts, data):
            h = j['hourly']
            for k in (1, 2):
                P, T = h[f'precipitation_previous_day{k}'], h[f'temperature_2m_previous_day{k}']
                nulls[k] += sum(1 for p, t in zip(P, T) if p is None or t is None)
                cold[name][k].update(cold_series(h['time'], P, T))
        time.sleep(3)
    ser = {k: {n: (bs.rolling(cold[n][k], 3), bs.rolling(cold[n][k], 6)) for n in pts} for k in (1, 2)}

    days = {}
    for d in bs.season_days(L):
        s1, s2 = day_signal(ser[1], d), day_signal(ser[2], d)
        days[d.isoformat()] = {'d1': [s1[0], round(s1[1], 1), round(s1[2], 1), s1[3]],
                               'd2': [s2[0], round(s2[1], 1), round(s2[2], 1), s2[3]]}

    def lab(LL, d):
        c, v = LL.get(d, ('否', '不详'))
        return None if c != '是' else (v == '是')

    md = ['## 第一段：提前一天、提前两天两轮（相隔 24 小时）', '',
          '数据：Open-Meteo 往期预报接口，MSM 的 precipitation／temperature_2m 的 _previous_day1、_previous_day2。'
          f'缺测的小时：提前一天 {nulls[1]} 个、提前两天 {nulls[2]} 个（九个点合计，含为补前一晚多取的一天）。', '']
    cats = [('两轮都越线', lambda a, b: a and b), ('只有提前一天那轮越线', lambda a, b: a and not b),
            ('只有提前两天那轮越线', lambda a, b: (not a) and b), ('两轮都没越线', lambda a, b: (not a) and (not b))]
    md += ['### 四类日子后来封路的比例', '',
           '| 类别 | 天数 | 一日游高速段全天封路 | 比例（95% 区间） | 天数（行程时段标签） | 行程时段封路 | 比例（95% 区间） |',
           '|---|---|---|---|---|---|---|']
    js_cats = {}
    for name, f in cats:
        sel = [d for d, v in days.items() if f(v['d1'][0], v['d2'][0])]
        a_ = [lab(L, d) for d in sel if lab(L, d) is not None]
        t_ = [lab(LT, d) for d in sel if lab(LT, d) is not None]
        md.append(f'| {name} | {len(a_)} | {sum(a_)} | {pct(sum(a_), len(a_))} | {len(t_)} | {sum(t_)} | {pct(sum(t_), len(t_))} |')
        js_cats[name] = {'n_all': len(a_), 'closed_all': sum(a_), 'n_trip': len(t_), 'closed_trip': sum(t_)}
    all_n = [lab(L, d) for d in days if lab(L, d) is not None]
    trip_n = [lab(LT, d) for d in days if lab(LT, d) is not None]
    md += ['', f'基率：全天封路 {sum(all_n)}／{len(all_n)} 天（{sum(all_n) / len(all_n):.0%}），'
               f'行程时段封路 {sum(trip_n)}／{len(trip_n)} 天（{sum(trip_n) / len(trip_n):.0%}）。', '']

    rules = [('现行：只看提前一天那轮', lambda a, b: a), ('两轮都越线才算', lambda a, b: a and b),
             ('任一轮越线就算', lambda a, b: a or b)]
    md += ['### 三种判法对比', '',
           '| 判法 | 对照的标签 | 判红天数 | 其中真封路 | 命中比例（95% 区间） | 没判红而封了路 | 封路总数 |', '|---|---|---|---|---|---|---|']
    js_rules = {}
    for name, f in rules:
        for lname, LL in (('全天封路', L), ('行程时段封路', LT)):
            fire = hit = miss = tot = 0
            for d, v in days.items():
                y = lab(LL, d)
                if y is None:
                    continue
                on = f(v['d1'][0], v['d2'][0])
                tot += y
                fire += on
                hit += on and y
                miss += (not on) and y
            md.append(f'| {name} | {lname} | {fire} | {hit} | {pct(hit, fire)} | {miss} | {tot} |')
            js_rules[f'{name}|{lname}'] = {'fired': fire, 'hit': hit, 'missed': miss, 'closed': tot}

    md += ['', '### 有一轮越线的日子（● 封了 ○ 没封 · 未核对）', '',
           '| 日期 | 提前一天：3h／6h mm（最接近红线的地方） | 提前两天：3h／6h mm（最接近红线的地方） | 全天 | 行程时段 |', '|---|---|---|---|---|']
    mark = {True: '●', False: '○', None: '·'}
    for d, v in sorted(days.items()):
        if v['d1'][0] or v['d2'][0]:
            c1 = f"{'**' if v['d1'][0] else ''}{v['d1'][1]}／{v['d1'][2]}{'**' if v['d1'][0] else ''}（{v['d1'][3]}）"
            c2 = f"{'**' if v['d2'][0] else ''}{v['d2'][1]}／{v['d2'][2]}{'**' if v['d2'][0] else ''}（{v['d2'][3]}）"
            md.append(f'| {d[2:]} | {c1} | {c2} | {mark[lab(L, d)]} | {mark[lab(LT, d)]} |')
    md.append('\n加粗的是越过红线（3 小时 ≥7 mm 或 6 小时 ≥10 mm）的那一轮。')
    return '\n'.join(md), {'urls': urls, 'categories': js_cats, 'rules': js_rules, 'days': days}


# ---------------- 第二段 ----------------
def part_b(L, LT):
    pts = bs.P9
    now = dt.datetime.now(dt.timezone.utc)
    first_day, last_day = dt.date(2026, 11, 1), (now.astimezone(JST) + dt.timedelta(days=1)).date()
    t = dt.datetime(2026, 10, 30, 12, tzinfo=dt.timezone.utc)
    runs = []
    while t <= now - dt.timedelta(hours=4):
        runs.append(t)
        t += dt.timedelta(hours=3)
    base = dict(coords(pts), models='jma_msm', hourly='precipitation,temperature_2m', timezone='Asia/Tokyo')
    got, errs, note = {}, [], ''
    for r in runs:
        q = dict(base, run=r.strftime('%Y-%m-%dT%H:%M'))
        url = 'https://single-runs-api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode(q, safe=',/:')
        try:
            try:
                data = get(url, tries=4)
            except RuntimeError as e:
                # 单轮接口若不认 elevation／cell_selection，去掉这两项再试一次，以后都不带
                if str(e).startswith('HTTP 400') and 'cell_selection' in base and not got:
                    base.pop('elevation'), base.pop('cell_selection')
                    note = '（单轮接口不认 elevation／cell_selection，第二段改用默认格点选取，与第一段可能差一格）'
                    q = dict(base, run=r.strftime('%Y-%m-%dT%H:%M'))
                    url = 'https://single-runs-api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode(q, safe=',/:')
                    data = get(url, tries=4)
                else:
                    raise
        except Exception as e:
            errs.append(f'{r:%m-%d %H}Z：{e}')
            if not got and len(errs) >= 4:     # 一轮都取不到，多半是接口不支持，别一直试
                break
            continue
        data = data if isinstance(data, list) else [data]
        series = {}
        for name, j in zip(pts, data):
            h = j['hourly']
            series[name] = cold_series(h['time'], h['precipitation'], h['temperature_2m'])
        got[r] = series
        time.sleep(2)

    def covered(s, d, need):
        base_t = dt.datetime(d.year, d.month, d.day)
        return all((base_t + dt.timedelta(hours=h)) in s for h in range(need[0], need[1] + 1))

    res = {}   # 日期 -> {轮次(东京时间字符串): {'out': [m3,m6] 或 None, 'ret': ...}}
    d = first_day
    while d <= last_day:
        row = {}
        for r, series in got.items():
            init_jst = r.astimezone(JST).replace(tzinfo=None)
            # 只看从目标日前两天 21 时到当天 03 时起算的各轮
            if not (dt.datetime(d.year, d.month, d.day) - dt.timedelta(hours=27) <= init_jst <= dt.datetime(d.year, d.month, d.day, 3)):
                continue
            ent = {}
            for seg, need, win, names in (('out', NEED_OUT, W_OUT, bs.P9), ('ret', NEED_RET, W_RET, bs.RET5)):
                # 该轮第一个有效值是起算后 1 小时结束的那一小时；起算时刻本身的值不用
                ok = all(covered(series[n], d, need) for n in names) and \
                    init_jst + dt.timedelta(hours=1) <= dt.datetime(d.year, d.month, d.day) + dt.timedelta(hours=need[0])
                if not ok:
                    ent[seg] = None
                    continue
                vals = [bs.win_max(bs.rolling(series[n], 3), bs.rolling(series[n], 6), d, *win) for n in names]
                ent[seg] = [round(max(v[0] for v in vals), 1), round(max(v[1] for v in vals), 1)]
            row[init_jst.strftime('%m-%d %H')] = ent
        res[d.isoformat()] = row
        d += dt.timedelta(days=1)

    def lab(LL, ds):
        c, v = LL.get(ds, ('否', '不详'))
        return None if c != '是' else (v == '是')

    md = ['## 第二段：相隔 3 小时的连续几轮（2026 年 11 月）', '',
          f'数据：Open-Meteo 单轮接口，取到 {len(got)} 轮'
          + (f'，没取到 {len(errs)} 轮（{"；".join(errs[:6])}{" 等" if len(errs) > 6 else ""}）' if errs else '') + f'。{note}', '']
    if not got:
        md.append('一轮都没取到，第二段从缺。')
        return '\n'.join(md), {'errors': errs}

    def fmt(v):
        if v is None:
            return None
        s = f'{v[0]:g}／{v[1]:g}'
        return f'**{s}**' if bs.fired(v[0], v[1], R3, R6) else s

    ev_rows = []
    md += ['### 各轮的雪带最大值（3 小时／6 小时，mm；加粗＝越过红线；"—"＝该轮没有完整盖住时间窗）', '']
    for ds, row in sorted(res.items()):
        if not row:
            continue
        fired_any = any(e.get(s) and bs.fired(*e[s], R3, R6) for e in row.values() for s in ('out', 'ret'))
        ya, yt = lab(L, ds), lab(LT, ds)
        if not (fired_any or ya):
            continue
        lab_txt = ('标签未到' if ya is None else f"全天{'封了' if ya else '没封'}、行程时段{'封了' if yt else '没封'}")
        md.append(f'**{ds[5:]}**（{lab_txt}）')
        for seg, segname in (('out', '去程（前一天 18 时—当天 11 时）'), ('ret', '回程（当天 05—20 时）')):
            cells = [f'{k[3:5]}日{k[6:8]}时起算 {fmt(e[seg])}' for k, e in sorted(row.items()) if e.get(seg) is not None]
            if cells:
                md.append(f'- {segname}：' + ' · '.join(cells))
        md.append('')
        # 晚间日报能用到的 4 轮里有几轮越线（去程、回程任一）
        dd = dt.date.fromisoformat(ds) - dt.timedelta(days=1)
        ev = [f'{dd:%m-%d} {h:02d}' for h in EVENING]
        flags = []
        for k in ev:
            e = row.get(k)
            if not e or e.get('out') is None or e.get('ret') is None:
                flags.append(None)
            else:
                flags.append(bs.fired(*e['out'], R3, R6) or bs.fired(*e['ret'], R3, R6))
        ev_rows.append((ds, flags, ya, yt))
    md += ['### 晚间日报能用到的 4 轮（前一天 06、09、12、15 时起算）里几轮越线', '',
           '| 日期 | 06 | 09 | 12 | 15 | 越线轮数 | 全天 | 行程时段 |', '|---|---|---|---|---|---|---|---|']
    mk = {True: '●', False: '○', None: '—'}
    for ds, flags, ya, yt in ev_rows:
        n_ok = [f for f in flags if f is not None]
        md.append(f"| {ds[5:]} | {' | '.join(mk[f] for f in flags)} | {sum(n_ok)}／{len(n_ok)} | "
                  f"{'·' if ya is None else ('封' if ya else '没封')} | {'·' if yt is None else ('封' if yt else '没封')} |")
    md.append('\n● 这一轮越线（去程或回程）○ 没越线 — 没取到或没盖住时间窗。')
    return '\n'.join(md), {'errors': errs, 'runs': len(got), 'days': res}


def main():
    L = bs.labels()
    LT = bs.labels('一日游行程时段封路')
    OUT.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(JST).strftime('%Y-%m-%d %H:%M')
    head = ['# 几轮都报越线，是不是更可能真封路？（雪带 R8，只回测降水量这一半）', '',
            f'生成：{now}（东京时间），脚本 `scripts/backtest_run_agreement.py`，口径见脚本开头。'
            '数据：Weather data by Open-Meteo.com（CC BY 4.0），原始模式为日本气象厅 MSM。', '']
    a_md, a_js = part_a(L, LT)
    try:
        b_md, b_js = part_b(L, LT)
    except Exception as e:      # 第二段失败不影响第一段
        b_md, b_js = f'## 第二段\n\n没跑成：{e}', {'error': str(e)}
    (OUT / 'run_agreement.md').write_text('\n'.join(head) + '\n' + a_md + '\n\n' + b_md + '\n', encoding='utf-8')
    (OUT / 'run_agreement.json').write_text(json.dumps({'generated_jst': now, 'part_a': a_js, 'part_b': b_js},
                                                       ensure_ascii=False, indent=1), encoding='utf-8')
    print((OUT / 'run_agreement.md').read_text(encoding='utf-8'))


if __name__ == '__main__':
    main()
