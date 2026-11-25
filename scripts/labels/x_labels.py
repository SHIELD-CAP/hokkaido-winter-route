#!/usr/bin/env python3
"""由 data/source/nexco_x_*.txt（NEXCO 東日本北海道支社 X 帐号的封路帖）算出逐日封路标签，和 data/labels.csv 对照。

做法：按 IC 顺序把每条【開始】【解除】【原因変更】落到相邻两个 IC 之间的小段上，分方向、分“天气类／其他”记状态。
某天 0 时还封着的段，加上当天有天气类事件碰到的段，就是这一天封过的段。
- 天气类：原因里有 吹雪、除雪、雪、視界、凍結。事故、火災、故障車、動物侵入、工事、緊急作業 等不算。
- 一日游高速段：道央道 札幌IC—旭川鷹栖IC（札幌南IC—札幌IC、札幌南IC—札幌JCT 不算）。
- 机场线高速段：道央道 新千歳空港IC—札幌JCT，札樽道 小樽IC—札幌JCT 全段。
- 某天“封路”指当天任何时刻有封闭在生效，包括前一天起的封闭延续到当天、当天解除的封闭。
- 汇总帖（类型记为 ?）只作参考，不改状态。
- 一日游行程时段封路：去程高速 09–11 时（札幌IC→旭川鷹栖IC，北行）或回程高速 19–20 时（三笠IC→札幌IC，南行）
  有天气类封闭在生效。要逐条按时刻算，所以只有 data/source/ 里有原文的日子才有这一列。

用法：
  python3 scripts/labels/x_labels.py                 列出每天的结果，并和 labels.csv 对照，报告不一致的日子
  python3 scripts/labels/x_labels.py --write 2026-11-01:2026-11-30
                                                     把这段日期的结果写进 labels.csv（逐日核对记为“是”）
data/source/ 里的帖子要先补齐这段日期，并在文件头加“# 覆盖：起～止”；覆盖段之前就开始、段内才解除的封闭，
靠“当天有解除”记上，但如果段前开始、段后才解除、段内没有任何帖子，就会漏，所以覆盖段的起点要取在没有封闭的日子。
"""
import collections, csv, datetime as dt, glob, io, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]

DOO = ['大沼公園IC', '森IC', '落部IC', '八雲IC', '国縫IC', '長万部IC', '黒松内JCT', '豊浦IC', '虻田洞爺湖IC', '伊達IC',
       '室蘭IC', '登別室蘭IC', '登別東IC', '白老IC', '苫小牧西IC', '苫小牧中央IC', '苫小牧東IC', '新千歳空港IC', '千歳IC',
       '千歳恵庭JCT', '恵庭IC', '北広島IC', '札幌南IC', '大谷地IC', '札幌JCT', '札幌IC', '江別西IC', '江別東IC', '岩見沢IC',
       '三笠IC', '美唄IC', '奈井江砂川IC', '滝川IC', '深川JCT', '深川IC', '旭川鷹栖IC', '旭川北IC', '比布JCT', '和寒IC',
       '士別剣淵IC', '名寄IC']
SATO = ['小樽IC', '小樽JCT', '朝里IC', '銭函IC', '手稲IC', '札幌西IC', '新川IC', '札幌北IC', '伏古IC', '雁来IC', '札幌JCT']
POS = {'道央': {n: i for i, n in enumerate(DOO)}, '札樽': {n: i for i, n in enumerate(SATO)}}
A_UNITS = {('道央', i) for i in range(POS['道央']['札幌IC'], POS['道央']['旭川鷹栖IC'])}
B_UNITS = {('道央', i) for i in range(POS['道央']['新千歳空港IC'], POS['道央']['札幌JCT'])} | \
          {('札樽', i) for i in range(len(SATO) - 1)}
# 行程时段（与网站一致）：去程高速 09–11 时，札幌IC→旭川鷹栖IC 北行；回程高速 19–20 时，三笠IC→札幌IC 南行
TRIP_COL = '一日游行程时段封路'
TRIP = [({('道央', i) for i in range(POS['道央']['札幌IC'], POS['道央']['旭川鷹栖IC'])}, '+', 9, 11),
        ({('道央', i) for i in range(POS['道央']['札幌IC'], POS['道央']['三笠IC'])}, '-', 19, 20)]
WEATHER = re.compile('吹雪|除雪|雪|視界|凍結')
LINE = re.compile(r'^(\d{4}-\d\d-\d\d \d\d:\d\d) (\S+) (.*?) \| (.*)$')
PAIR = re.compile(r'([^,⇔⇒()]+?)([⇔⇒])([^,⇔⇒()]+?)(?:\(([^)]*)\))?(?=,|$)')


COVER = re.compile(r'^# 覆盖：(\d{4}-\d\d-\d\d)～(\d{4}-\d\d-\d\d)')


def load():
    """返回（帖子列表，覆盖的日期段）。覆盖段写在文件头的“# 覆盖：起～止”行里，只有这些日子的结果可信。"""
    ev, cover = [], []
    for fn in sorted(glob.glob(str(ROOT / 'data' / 'source' / 'nexco_x_*.txt'))):
        for raw in open(fn, encoding='utf-8'):
            raw = raw.rstrip('\n')
            c = COVER.match(raw)
            if c:
                cover.append((dt.date.fromisoformat(c.group(1)), dt.date.fromisoformat(c.group(2))))
                continue
            m = LINE.match(raw)
            if not m:
                continue
            t, typ, reason, segs = m.groups()
            pairs = []
            for seg in segs.split('; '):
                road, rest = seg.split(' ', 1)
                for pm in PAIR.finditer(rest.rstrip('⇔')):
                    a, arrow, b, _ = pm.groups()
                    pairs.append((road, a.strip(), arrow, b.strip()))
            old, new = (reason.split('⇒', 1) if typ == '原因変更' and '⇒' in reason else (None, reason))
            ev.append({'t': dt.datetime.strptime(t, '%Y-%m-%d %H:%M'), 'type': typ, 'reason': reason,
                       'old': old, 'new': new, 'pairs': pairs, 'raw': raw})
    ev.sort(key=lambda e: e['t'])
    return ev, cover


def cat(reason):
    return 'W' if reason and WEATHER.search(reason) else 'O'


def units_dirs(road, a, arrow, b, warn):
    p = POS[road]
    if a not in p or b not in p:
        warn.add(f'不认识的 IC：{road} {a} {b}')
        return [], []
    lo, hi = sorted((p[a], p[b]))
    return [(road, i) for i in range(lo, hi)], (['+', '-'] if arrow == '⇔' else (['+'] if p[b] > p[a] else ['-']))


def simulate(ev, cover):
    """返回 {日期: {'A': bool, 'B': bool, 'A_ev': [...], 'B_ev': [...]}}，只含覆盖段里的日子。
    每个覆盖段开始时状态清零：段前已经在封、段内才解除的封闭，靠“当天有解除”记上。"""
    warn = set()
    state = collections.defaultdict(set)
    since, spans = {}, collections.defaultdict(list)  # 天气类封闭的起点；每段（道路、小段、方向）的封闭区间
    by_day = collections.defaultdict(list)
    for e in ev:
        by_day[e['t'].date()].append(e)
    days = {}
    alld = sorted({x for a, b in cover for x in (a + dt.timedelta(days=k) for k in range((b - a).days + 1))})
    def close_all(t):
        for k, t0 in since.items():
            spans[k].append((t0, t))
        since.clear()

    for d in alld:
        d0 = dt.datetime.combine(d, dt.time())
        if d - dt.timedelta(days=1) not in days:
            close_all(d0)
            state.clear()
        v = days[d] = {'A': False, 'B': False, 'A_ev': [], 'B_ev': []}
        open_units = {(r, i) for (r, i, s), c in state.items() if 'W' in c}
        v['A'] = bool(open_units & A_UNITS)
        v['B'] = bool(open_units & B_UNITS)
        for e in by_day.get(d, []):
            if e['type'] not in ('開始', '解除', '原因変更'):
                continue
            newc, oldc = cat(e['new']), (cat(e['old']) if e['old'] else None)
            touched = set()
            for road, a, arrow, b in e['pairs']:
                us, ds = units_dirs(road, a, arrow, b, warn)
                for u in us:
                    for s in ds:
                        k = (u[0], u[1], s)
                        was = 'W' in state[k]
                        if e['type'] == '開始':
                            state[k].add(newc)
                        elif e['type'] == '解除':
                            if newc == 'W' and not was:
                                spans[k].append((d0, e['t']))  # 不知道何时封上的：按当天 0 时起算
                            state[k].discard(newc)
                        else:
                            if oldc:
                                state[k].discard(oldc)
                            state[k].add(newc)
                        now = 'W' in state[k]
                        if now and not was:
                            since[k] = e['t']
                        elif was and not now:
                            spans[k].append((since.pop(k), e['t']))
                    touched.add(u)
            if 'W' in (newc, oldc):
                if touched & A_UNITS:
                    v['A'] = True; v['A_ev'].append(e['raw'])
                if touched & B_UNITS:
                    v['B'] = True; v['B_ev'].append(e['raw'])
    if alld:
        close_all(dt.datetime.combine(alld[-1] + dt.timedelta(days=1), dt.time()))
    for d, v in days.items():
        hit = False
        for units, sign, h0, h1 in TRIP:
            w0, w1 = dt.datetime.combine(d, dt.time(h0)), dt.datetime.combine(d, dt.time(h1))
            for (road, i, s_), iv in spans.items():
                if s_ == sign and (road, i) in units and any(a < w1 and b > w0 for a, b in iv):
                    hit = True
        v['trip'] = hit
    return days, warn


def main():
    days, warn = simulate(*load())
    lp = ROOT / 'data' / 'labels.csv'
    rows = list(csv.DictReader(open(lp, encoding='utf-8')))
    yn = lambda b: '是' if b else '否'
    if '--write' in sys.argv:
        spans = [tuple(dt.date.fromisoformat(x) for x in a.split(':')) for a in sys.argv[sys.argv.index('--write') + 1:]]
        have = {r['日期'] for r in rows}
        for a, b in spans:
            d = a
            while d <= b:
                if d not in days:
                    sys.exit(f'{d} 没有帖子覆盖，先补 data/source/')
                if d.isoformat() not in have:
                    rows.append({'日期': d.isoformat(), '逐日核对': '是', '一日游高速段封路': '', '机场线高速段封路': '', TRIP_COL: '', '备注': ''})
                d += dt.timedelta(days=1)
        for r in rows:
            r.setdefault(TRIP_COL, '')
            d = dt.date.fromisoformat(r['日期'])
            if any(a <= d <= b for a, b in spans):
                r['逐日核对'], r['一日游高速段封路'], r['机场线高速段封路'] = '是', yn(days[d]['A']), yn(days[d]['B'])
                r[TRIP_COL] = yn(days[d]['trip'])
        rows.sort(key=lambda r: r['日期'])
        fields = ['日期', '逐日核对', '一日游高速段封路', '机场线高速段封路', TRIP_COL, '备注']
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=fields, lineterminator='\n')
        w.writeheader(); w.writerows(rows)
        lp.write_text(buf.getvalue(), encoding='utf-8')
        print('已写入', lp)
        return
    bad = 0
    for r in rows:
        d = dt.date.fromisoformat(r['日期'])
        if r['逐日核对'] != '是' or d not in days:
            continue
        got = (yn(days[d]['A']), yn(days[d]['B']), yn(days[d]['trip']))
        have = (r['一日游高速段封路'], r['机场线高速段封路'], r.get(TRIP_COL) or got[2])
        if got != have:
            bad += 1
            print(f"不一致 {d}: labels.csv 一日游={have[0]} 机场线={have[1]} 行程时段={have[2]}；X 帖 {got[0]} {got[1]} {got[2]}")
    print(f'对照完毕：帖子覆盖 {len(days)} 天，labels.csv 里逐日核对过、又有帖子覆盖的日子中 {bad} 天不一致。')
    for w_ in sorted(warn):
        print(w_, file=sys.stderr)


if __name__ == '__main__':
    main()
