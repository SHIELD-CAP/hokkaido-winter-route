#!/usr/bin/env python3
"""提前 3～5 天：ECMWF 和 GSM 两家都报高、只有一家报高、都不报高，后来封路的比例各是多少。

不联网，读 scripts/backtest_lead.py 的结果 data/backtest/lead3to5.json（每天每家的 P24、P6、TOT）和 data/labels.csv。
"高"用 backtest_lead.py 同样的分法：该家、该提前量 176 天里的三分位，取上面三分之一（> 第 2/3 位那个值）。
"晴好"：9 个点全天降水都 <1 mm。区间是威尔逊 95% 区间；封路日常连着几天，实际不确定性更大。样本内，没有调门槛。
用法：python3 scripts/lead_agree.py    结果：data/backtest/lead3to5_agree.md
"""
import csv, json, math, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
J = json.load(open(ROOT / 'data' / 'backtest' / 'lead3to5.json', encoding='utf-8'))


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def pct(k, n):
    if not n:
        return '—'
    a, b = wilson(k, n)
    return f'{k / n:.0%}（{a:.0%}–{b:.0%}）'


lab = {}
with open(ROOT / 'data' / 'labels.csv', encoding='utf-8') as f:
    for r in csv.DictReader(f):
        if r['逐日核对'] == '是':
            lab[r['日期']] = (r['一日游高速段封路'] == '是', r['一日游行程时段封路'] == '是')

lines = ['# 提前 3～5 天：两家模式一致与否，后来封路的比例', '',
         '读 `data/backtest/lead3to5.json`（`scripts/backtest_lead.py` 的结果），脚本 `scripts/lead_agree.py`，口径见脚本开头。',
         'P24：目标日 9 个点里最大的全天冷降水（气温 ≤0.5 ℃ 那几个小时的降水合计）；P6：最大的连续 6 小时冷降水。', '']
for feat in ('P24', 'P6'):
    for L in (3, 4, 5):
        E, G = J[f'ecmwf_ifs025|{L}']['days'], J[f'jma_gsm|{L}']['days']
        days = sorted(set(E) & set(G) & set(lab))

        def cut(D):
            v = sorted(D[d][feat] for d in D)
            return v[2 * len(v) // 3]
        qe, qg = cut(E), cut(G)
        he = {d: E[d][feat] > qe for d in days}
        hg = {d: G[d][feat] > qg for d in days}
        na = sum(lab[d][0] for d in days)
        nt = sum(lab[d][1] for d in days)
        lines += [f'## {feat}，提前 {L} 天（{len(days)} 天；全天封路 {na} 天、行程时段 {nt} 天；高档：ECMWF >{qe:g} mm，GSM >{qg:g} mm）', '',
                  '| 两家的情况 | 天数 | 全天封路 | 比例（95% 区间） | 行程时段封路 | 比例（95% 区间） |', '|---|---|---|---|---|---|']
        for name, f in (('两家都高', lambda d: he[d] and hg[d]), ('只有 ECMWF 高', lambda d: he[d] and not hg[d]),
                        ('只有 GSM 高', lambda d: hg[d] and not he[d]), ('两家都不高', lambda d: not he[d] and not hg[d]),
                        ('（合计）任一家高', lambda d: he[d] or hg[d])):
            sel = [d for d in days if f(d)]
            ka, kt = sum(lab[d][0] for d in sel), sum(lab[d][1] for d in sel)
            lines.append(f'| {name} | {len(sel)} | {ka} | {pct(ka, len(sel))} | {kt} | {pct(kt, len(sel))} |')
        lines.append('')
lines += ['## 晴好（9 个点全天降水都 <1 mm）', '', '| 提前 | 两家都晴好：天数／全天封路／行程时段封路 | 任一家晴好：天数／全天封路／行程时段封路 |', '|---|---|---|']
for L in (3, 4, 5):
    E, G = J[f'ecmwf_ifs025|{L}']['days'], J[f'jma_gsm|{L}']['days']
    days = sorted(set(E) & set(G) & set(lab))
    both = [d for d in days if E[d]['TOT'] < 1 and G[d]['TOT'] < 1]
    any_ = [d for d in days if E[d]['TOT'] < 1 or G[d]['TOT'] < 1]
    lines.append(f"| {L} 天 | {len(both)}／{sum(lab[d][0] for d in both)}／{sum(lab[d][1] for d in both)} | "
                 f"{len(any_)}／{sum(lab[d][0] for d in any_)}／{sum(lab[d][1] for d in any_)} |")
# M 2026-11-28 晚上定：第 4～6 天和前 3 天同一个标准（同一种颜色代表同样的危险程度），两家都达到才亮。
# 前 3 天的毫米门槛全球模式够不到（下面第一张表），所以门槛按全球模式自己的量定（第二张表）。
lines += ['', '## 照搬前 3 天的毫米门槛会怎样', '',
          'P6 只是当天 01–24 时内连续 6 小时的最大值，和 R8 的时间窗不完全一样；3 小时 ≥7 mm 必然 6 小时 ≥7 mm，所以"P6 ≥7"的天数是 3 小时红线的上限。', '',
          '| 提前 | 门槛 | ECMWF 达到 | GSM 达到 | 两家都达到（天数／全天封路） |', '|---|---|---|---|---|']
for L in (3, 4, 5):
    E, G = J[f'ecmwf_ifs025|{L}']['days'], J[f'jma_gsm|{L}']['days']
    days = sorted(set(E) & set(G) & set(lab))
    for thr, name in ((10, '6 小时 ≥10 mm（红线）'), (7, '6 小时 ≥7 mm（3 小时红线的上限）'), (6, '6 小时 ≥6 mm（橙线）')):
        b = [d for d in days if E[d]['P6'] >= thr and G[d]['P6'] >= thr]
        lines.append(f"| {L} 天 | {name} | {sum(E[d]['P6'] >= thr for d in days)} | {sum(G[d]['P6'] >= thr for d in days)} | "
                     f"{len(b)}／{sum(lab[d][0] for d in b)} |")
RE, RG, OE, OG = 4.8, 4.2, 3.6, 3.3
lines += ['', f'## 按同样危险程度定的门槛（M 选的）：红＝ECMWF >{RE} 且 GSM >{RG} mm，橙＝ECMWF >{OE} 且 GSM >{OG} mm 而不到红，其余绿', '',
          '量是目标日 9 个点里最大的全天冷降水（P24）。门槛是在同样这 176 天上挑的，结果偏乐观；冬天结束后用新数据再核。', '',
          '| 提前 | 颜色 | 天数 | 全天封路 | 比例（95% 区间） | 行程时段封路 | 比例（95% 区间） |', '|---|---|---|---|---|---|---|']
for L in (3, 4, 5):
    E, G = J[f'ecmwf_ifs025|{L}']['days'], J[f'jma_gsm|{L}']['days']
    days = sorted(set(E) & set(G) & set(lab))

    def col(d):
        e, g = E[d]['P24'], G[d]['P24']
        return '红' if (e > RE and g > RG) else ('橙' if (e > OE and g > OG) else '绿')
    for c in ('红', '橙', '绿'):
        sel = [d for d in days if col(d) == c]
        ka, kt = sum(lab[d][0] for d in sel), sum(lab[d][1] for d in sel)
        lines.append(f'| {L} 天 | {c} | {len(sel)} | {ka} | {pct(ka, len(sel))} | {kt} | {pct(kt, len(sel))} |')
sb = json.load(open(ROOT / 'data' / 'backtest' / 'snowband_2025-26.json', encoding='utf-8'))['msm_prev_day1']['windows']
k = '加长：去程从前一天 18 时到 11 时，回程 05–20 时|{}|{}'
r8a, r8t = sb[k.format('R8 3h≥7 或 6h≥10', '全天封路')], sb[k.format('R8 3h≥7 或 6h≥10', '行程时段封路')]
o9a, o9t = sb[k.format('O9 3h≥4.5 或 6h≥6', '全天封路')], sb[k.format('O9 3h≥4.5 或 6h≥6', '行程时段封路')]
n_all, c_all, c_trip = len(lab), sum(v[0] for v in lab.values()), sum(v[1] for v in lab.values())
lines += ['', '对照：前 3 天（提前一天的 MSM，只算雪量这一半，`snowband_2025-26.json`）', '',
          '| 颜色 | 天数 | 全天封路 | 行程时段封路 |', '|---|---|---|---|',
          f"| 红（R8） | {r8a['fired']} | {r8a['hit']}（{r8a['hit'] / r8a['fired']:.0%}） | {r8t['hit']}（{r8t['hit'] / r8t['fired']:.0%}） |",
          f"| 橙（够 O9、不够 R8） | {o9a['fired'] - r8a['fired']} | {o9a['hit'] - r8a['hit']}（{(o9a['hit'] - r8a['hit']) / (o9a['fired'] - r8a['fired']):.0%}） | "
          f"{o9t['hit'] - r8t['hit']}（{(o9t['hit'] - r8t['hit']) / (o9a['fired'] - r8a['fired']):.0%}） |",
          f"| 绿 | {n_all - o9a['fired']} | {c_all - o9a['hit']}（{(c_all - o9a['hit']) / (n_all - o9a['fired']):.0%}） | "
          f"{c_trip - o9t['hit']}（{(c_trip - o9t['hit']) / (n_all - o9a['fired']):.0%}） |"]
(ROOT / 'data' / 'backtest' / 'lead3to5_agree.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('\n'.join(lines))
