#!/usr/bin/env python3
"""每 30 分钟取一次 iHighway 的北海道数据，记下道央道、札樽道的封闭和冬季规制什么时候出现、什么时候消失。

数据来源：iHighway（https://ihighway.jp/ ，NEXCO西日本情報テクノロジー运营，路况数据由 JARTIC 提供）。
它的使用须知不许未经许可复制、颁布它的内容，所以这里只记事实（路名、区间、方向、原因、看到的时刻），
不存它的原始 JSON。

写出三样（都在 data/ihighway/）：
- polls/年-月.csv：每次取数一行，记取数时刻、iHighway 的数据时刻、成功与否、北海道各类规制件数。
  用来看哪段时间有数据：两次取数之间没记到的封闭，这里查不出来。
- active.json：此刻还在列的项目（第一次、最后一次看到的数据时刻）。
- events.csv：已经消失的项目，一项一行。开始时刻在“上一次没看到”和“首次看到”之间，
  结束时刻在“最后看到”和“消失后首次没看到”之间；iHighway 本身比现场晚 10–15 分钟。

只用标准库，GitHub Actions 的 ubuntu-latest 自带 python3。
"""
import csv
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))
BASE = 'https://ihighway.jp/datas/json/'
ROADS = ('道央道', '札樽道')
KINDS = {
    'closed': '通行止め',
    'ramp': 'ランプ閉鎖',
    'snowChain': 'チェーン規制',
    'snowTires': '冬用タイヤ等装着規制',
}
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'ihighway')
UA = 'hokkaido-winter-route/1.0 (+https://github.com/SHIELD-CAP/hokkaido-winter-route)'


def fetch(name):
    req = urllib.request.Request(BASE + name, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


def parse_announced(s):
    """'2026年11月28日　03時15分現在' -> '2026-11-28 03:15'"""
    m = re.search(r'(\d{4})年(\d{1,2})月(\d{1,2})日\D*(\d{1,2})時(\d{1,2})分', s or '')
    if not m:
        return s or ''
    y, mo, d, h, mi = map(int, m.groups())
    return f'{y:04d}-{mo:02d}-{d:02d} {h:02d}:{mi:02d}'


def load_active(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {'events': {}}


def main():
    os.makedirs(os.path.join(OUT, 'polls'), exist_ok=True)
    now = datetime.now(JST)
    now_s = now.strftime('%Y-%m-%d %H:%M')
    poll_file = os.path.join(OUT, 'polls', now.strftime('%Y-%m') + '.csv')
    active_path = os.path.join(OUT, 'active.json')
    events_path = os.path.join(OUT, 'events.csv')

    status, announced, counts, listed, err = 'ok', '', {}, None, ''
    try:
        st = fetch('status.json')
        announced = parse_announced(st.get('announced', ''))
        tr = fetch('traffic.json')
        a = tr.get('area01')
        if a is None:
            raise ValueError('traffic.json 里没有 area01')
        counts = {k: v for k, v in (a.get('trafficCount') or {}).items() if v}
        listed = {}
        for kind, items in (a.get('trafficInfo') or {}).items():
            if kind not in KINDS:
                continue
            for it in items or []:
                road = it.get('roadName', '')
                if road not in ROADS:
                    continue
                for inf in it.get('info') or []:
                    key = '|'.join([kind, road, inf.get('title', ''), inf.get('direction', '')])
                    listed[key] = {
                        '种类': KINDS[kind], '道路': road, '区间': inf.get('title', ''),
                        '方向': inf.get('direction', ''), '原因': inf.get('reason', '') or '',
                    }
    except Exception as e:  # 取不到也记一行，便于看出哪段时间没有数据
        status, err = 'error', f'{type(e).__name__}: {e}'[:200]

    # 取数记录
    new_file = not os.path.exists(poll_file)
    with open(poll_file, 'a', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(['取数时刻', 'iHighway数据时刻', '状态', '北海道各类件数', '道央道札樽道在列项数', '错误'])
        w.writerow([now_s, announced, status,
                    ' '.join(f'{k}={v}' for k, v in sorted(counts.items())),
                    '' if listed is None else len(listed), err])

    if listed is None:
        print('取数失败：', err)
        return 0

    stamp = announced or now_s
    state = load_active(active_path)
    events = state.get('events', {})
    prev_poll = state.get('last_poll_announced', '')
    finished = []
    for key, ev in list(events.items()):
        if key in listed:
            ev['最后看到'] = stamp
            reasons = [r for r in ev.get('原因', '').split('、') if r]
            r = listed[key]['原因']
            if r and r not in reasons:
                reasons.append(r)
            ev['原因'] = '、'.join(reasons)
        else:
            ev['消失后首次没看到'] = stamp
            finished.append(ev)
            del events[key]
    for key, ev in listed.items():
        if key not in events:
            events[key] = dict(ev, 上一次没看到=prev_poll, 首次看到=stamp, 最后看到=stamp)

    if finished:
        cols = ['种类', '道路', '区间', '方向', '原因', '上一次没看到', '首次看到', '最后看到', '消失后首次没看到']
        new_ev = not os.path.exists(events_path)
        with open(events_path, 'a', encoding='utf-8', newline='') as f:
            w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
            if new_ev:
                w.writeheader()
            for ev in finished:
                w.writerow(ev)

    state = {'last_poll_jst': now_s, 'last_poll_announced': stamp, 'events': events}
    with open(active_path, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f'{now_s} 数据时刻 {stamp}：在列 {len(events)} 项，本次结束 {len(finished)} 项；北海道各类件数 {counts}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
