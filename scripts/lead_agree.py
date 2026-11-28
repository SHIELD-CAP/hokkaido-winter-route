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
(ROOT / 'data' / 'backtest' / 'lead3to5_agree.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('\n'.join(lines))
