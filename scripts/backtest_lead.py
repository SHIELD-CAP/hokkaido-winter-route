#!/usr/bin/env python3
"""提前 3～5 天的回测（第三轮审阅 Q4 的第一步）。

问题：提前三五天，全球模式（ECMWF 0.25 度版、日本气象厅 GSM）报的降水，能不能把"一日游道央道会不会因天气封路"分出高低？
特别是 M 的看法："提前四五六天都预报晴天，到时大概率天气不错，可以放心准备"——晴天那一档后来封路的比例有多低。

口径（事先定好，全部报告，不挑）：
- 模式：ecmwf_ifs025、jma_gsm；提前量：3、4、5 天（Open-Meteo 往期预报接口的 *_previous_day3/4/5，
  即"每个时刻提前约 N×24 小时的预报"）。
- 格点：一日游回测用的 9 个点（①札幌 ②岩見沢 ③砂川・滝川 ④深川，E1–E5 道央道沿线 5 个 IC 附近）。
- 目标日 D 的预测量（取 9 个点里的最大值）：
  P24 = D 日 0–24 时冷降水（该小时气温 ≤0.5 ℃ 的降水）合计；
  P6  = D 日内连续 6 小时冷降水合计的最大值；
  TOT = D 日 0–24 时全部降水合计（不分冷暖），用来定"晴好"：TOT < 1 mm。
- 分档：P24、P6 按 176 天的三分位分低、中、高（值相同的并在一档，实际天数照写）；另列"晴好"（TOT < 1 mm）一档。
- 标签：data/labels.csv 里"逐日核对=是"的 176 天；全天口径用"一日游高速段封路"，行程口径用"一日游行程时段封路"。
- 区间：威尔逊 95% 区间；封路日常连着几天，实际区间更宽。样本内，没有调门槛。
用法：python3 scripts/backtest_lead.py（要能连 previous-runs-api.open-meteo.com，在 GitHub Actions 里跑）
结果：data/backtest/lead3to5.md、lead3to5.json
"""
import csv, json, math, time, urllib.request, urllib.parse, urllib.error, datetime, collections

PTS = [('①札幌', 43.06, 141.35), ('②岩見沢', 43.20, 141.76), ('③砂川・滝川', 43.53, 141.91), ('④深川', 43.72, 142.05),
       ('E1江別東IC', 43.107, 141.598), ('E2江別東—岩見沢', 43.142, 141.681), ('E3三笠IC', 43.243, 141.827),
       ('E4美唄IC', 43.334, 141.890), ('E5奈井江砂川IC', 43.450, 141.915)]
MODELS = ['ecmwf_ifs025', 'jma_gsm']
LEADS = [3, 4, 5]
RANGES = [('2025-11-01', '2025-11-30'), ('2025-12-01', '2025-12-31'), ('2026-01-01', '2026-01-31'),
          ('2026-02-01', '2026-02-28'), ('2026-03-01', '2026-03-31'), ('2026-11-01', '2026-11-25')]
COLD_T = 0.5


def fetch(model, a, b):
    hourly = ','.join(f'{v}_previous_day{n}' for n in LEADS for v in ('precipitation', 'temperature_2m'))
    # 目标日 D 的 0–24 时要用到 D+1 的 00 时，所以结束日多取一天
    b2 = (datetime.date.fromisoformat(b) + datetime.timedelta(days=1)).isoformat()
    q = {'latitude': ','.join(str(p[1]) for p in PTS), 'longitude': ','.join(str(p[2]) for p in PTS),
         'hourly': hourly, 'models': model, 'start_date': a, 'end_date': b2, 'timezone': 'Asia/Tokyo'}
    url = 'https://previous-runs-api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode(q, safe=',')
    last = None
    for i in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                j = json.load(r)
                return j if isinstance(j, list) else [j]
        except urllib.error.HTTPError as e:
            last = f'HTTP {e.code} {e.read().decode()[:200]}'
            if e.code != 429 and e.code < 500:
                break
        except Exception as e:
            last = str(e)
        time.sleep(20 * 2 ** i)
    raise RuntimeError(f'{model} {a}–{b} 取不到：{last}')


def labels():
    out = {}
    for r in csv.DictReader(open('data/labels.csv', encoding='utf-8')):
        if r['逐日核对'] == '是':
            out[r['日期']] = (r['一日游高速段封路'] == '是', r['一日游行程时段封路'] == '是')
    return out


def wilson(k, n, z=1.96):
    if n == 0:
        return (float('nan'), float('nan'))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def main():
    lab = labels()
    days = sorted(lab)
    # series[model][lead][point_idx] = {time_str: (precip, temp)}
    series = {m: {L: [dict() for _ in PTS] for L in LEADS} for m in MODELS}
    for m in MODELS:
        for a, b in RANGES:
            res = fetch(m, a, b)
            for pi, loc in enumerate(res):
                h = loc['hourly']
                for L in LEADS:
                    P, T = h[f'precipitation_previous_day{L}'], h[f'temperature_2m_previous_day{L}']
                    for t, p, tt in zip(h['time'], P, T):
                        series[m][L][pi][t] = (p, tt)
            time.sleep(2)

    def day_hours(d):   # D 日 01 时……D+1 日 00 时（每个值是前一小时的合计，左开右闭）
        d0 = datetime.datetime.fromisoformat(d + 'T00:00')
        return [(d0 + datetime.timedelta(hours=k)).strftime('%Y-%m-%dT%H:%M') for k in range(1, 25)]

    feats = {}   # (m, L) -> {date: {'P24':..,'P6':..,'TOT':..,'ok':bool}}
    for m in MODELS:
        for L in LEADS:
            fd = {}
            for d in days:
                hrs = day_hours(d)
                best24 = best6 = besttot = 0.0
                complete = True
                for pi in range(len(PTS)):
                    s = series[m][L][pi]
                    vals = [s.get(t) for t in hrs]
                    if any(v is None or v[0] is None or v[1] is None for v in vals):
                        complete = False
                        continue
                    cold = [p if tt <= COLD_T else 0.0 for p, tt in vals]
                    tot = sum(p for p, _ in vals)
                    p6 = max(sum(cold[k - 6:k]) for k in range(6, 25))
                    best24, best6, besttot = max(best24, sum(cold)), max(best6, p6), max(besttot, tot)
                fd[d] = {'P24': round(best24, 2), 'P6': round(best6, 2), 'TOT': round(besttot, 2), 'ok': complete}
            feats[(m, L)] = fd

    n_all = len(days)
    base_all = sum(lab[d][0] for d in days)
    base_trip = sum(lab[d][1] for d in days)
    lines = ['# 提前 3～5 天回测：全球模式报的降水能不能把封路分出高低', '',
             f'生成：{datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%MZ")}（世界时），脚本 `scripts/backtest_lead.py`，口径见脚本开头。',
             f'标签：逐日核对过的 {n_all} 天；一日游高速段全天封路 {base_all} 天（{base_all / n_all:.0%}），行程时段封路 {base_trip} 天（{base_trip / n_all:.0%}）。',
             '样本内结果，没有调门槛；封路日常连着几天，实际区间比表里的更宽。数据：Weather data by Open-Meteo.com（CC BY 4.0），往期预报接口。', '']
    out_json = {}
    for m in MODELS:
        for L in LEADS:
            fd = feats[(m, L)]
            usable = [d for d in days if fd[d]['ok']]
            lines += [f'## {m}，提前 {L} 天（有完整数据的 {len(usable)} 天）', '',
                      '| 预测量 | 档 | 门槛 | 天数 | 全天封路 | 比例（95% 区间） | 行程时段封路 | 比例（95% 区间） |', '|---|---|---|---|---|---|---|---|']
            rows_json = []

            def add(name, cat, rule, sel):
                n = len(sel)
                ka = sum(lab[d][0] for d in sel)
                kt = sum(lab[d][1] for d in sel)
                la, ha = wilson(ka, n)
                lt, ht = wilson(kt, n)
                fa = f'{ka / n:.0%}（{la:.0%}–{ha:.0%}）' if n else '—'
                ft = f'{kt / n:.0%}（{lt:.0%}–{ht:.0%}）' if n else '—'
                lines.append(f'| {name} | {cat} | {rule} | {n} | {ka} | {fa} | {kt} | {ft} |')
                rows_json.append({'feature': name, 'cat': cat, 'rule': rule, 'n': n, 'closed_all': ka, 'closed_trip': kt})

            dry = [d for d in usable if fd[d]['TOT'] < 1.0]
            add('TOT', '晴好', '全天降水 <1 mm（9 个点都是）', dry)
            add('TOT', '其余', '全天降水 ≥1 mm', [d for d in usable if fd[d]['TOT'] >= 1.0])
            for feat in ('P24', 'P6'):
                vals = sorted(fd[d][feat] for d in usable)
                q1 = vals[len(vals) // 3]
                q2 = vals[2 * len(vals) // 3]
                low = [d for d in usable if fd[d][feat] <= q1]
                mid = [d for d in usable if q1 < fd[d][feat] <= q2]
                high = [d for d in usable if fd[d][feat] > q2]
                add(feat, '低', f'≤{q1:g} mm', low)
                add(feat, '中', f'{q1:g}–{q2:g} mm', mid)
                add(feat, '高', f'>{q2:g} mm', high)
            lines.append('')
            out_json[f'{m}|{L}'] = {'rows': rows_json, 'days': {d: fd[d] for d in usable}}
    lines += ['## 怎么看', '',
              '- 和基率比：全天封路的基率约 18%，行程时段约 11%。某一档的比例和基率差不多，说明这一档没有信息。',
              '- "晴好"一档用来回答"提前几天都预报晴天，能不能放心准备"：这一档后来封路的比例越接近 0 越可以。',
              '- "高"一档的比例明显高于基率，说明提前这么多天的大雪信号有用；但样本很小，区间很宽。', '']
    open('data/backtest/lead3to5.md', 'w', encoding='utf-8').write('\n'.join(lines))
    json.dump(out_json, open('data/backtest/lead3to5.json', 'w', encoding='utf-8'), ensure_ascii=False)
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
