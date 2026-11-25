#!/usr/bin/env python3
"""从气象厅“過去の気象データ検索”取气象官署（有人站改的特别地域气象观测所也算）的逐时观测，存成 CSV。

用法：python3 scripts/obs/etrn_hourly.py 府县号 站号 起始日 结束日 输出.csv
例：  python3 scripts/obs/etrn_hourly.py 15 47413 2025-11-01 2026-03-31 data/obs/iwamizawa_47413_hourly.csv
      （岩見沢 prec_no=15 block_no=47413；札幌 prec_no=14 block_no=47412）

页面是 hourly_s1.php（官署用的版式，有视程）。美唄、滝川、深川、江別这类 AMeDAS 站用 hourly_a1.php，
列的顺序不同，没有视程，这个脚本不处理。
输出列：日期, 时（该小时结束的时刻，1–24）, 降水量_mm, 气温_C, 平均风速_ms, 降雪_cm, 积雪深_cm, 视程_km。
“--”（没有降水、降雪）记 0；缺测记空。数值后面的 ) ] 是气象厅的品质记号，去掉后照用。
"""
import csv, datetime, html, re, sys, time, urllib.request

def num(s):
    s = s.replace(')', '').replace(']', '').strip()
    if s == '--':
        return 0.0
    try:
        return float(s)
    except ValueError:
        return None

def day_rows(prec, block, d):
    url = (f'https://www.data.jma.go.jp/stats/etrn/view/hourly_s1.php?prec_no={prec}&block_no={block}'
           f'&year={d.year}&month={d.month}&day={d.day}&view=')
    for k in range(3):
        try:
            t = urllib.request.urlopen(url, timeout=30).read().decode('utf-8', 'ignore')
            break
        except Exception:
            time.sleep(2 + 3 * k)
    else:
        raise RuntimeError('取不到 ' + url)
    out = []
    for r in re.findall(r'<tr class="mtx"[^>]*>(.*?)</tr>', t, re.S):
        c = [html.unescape(re.sub(r'<[^>]+>', '', x)).strip() for x in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', r, re.S)]
        if len(c) != 17 or not c[0].isdigit():
            continue
        # 列：時 気圧(現地) 気圧(海面) 降水量 気温 露点 蒸気圧 湿度 風速 風向 日照 全天日射 降雪 積雪 天気 雲量 視程
        out.append([d.isoformat(), int(c[0]), num(c[3]), num(c[4]), num(c[8]), num(c[12]), num(c[13]), num(c[16])])
    return out

if __name__ == '__main__':
    prec, block, a, b, dst = sys.argv[1:6]
    d, end = datetime.date.fromisoformat(a), datetime.date.fromisoformat(b)
    with open(dst, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(['日期', '时', '降水量_mm', '气温_C', '平均风速_ms', '降雪_cm', '积雪深_cm', '视程_km'])
        while d <= end:
            w.writerows(['' if v is None else v for v in r] for r in day_rows(prec, block, d))
            d += datetime.timedelta(days=1)
            time.sleep(0.3)
