#!/usr/bin/env python3
"""定时任务（做法 B，2026-11-28 晚起）用：让 GitHub 用网站同一个程序（site/src/engine.js）取数、判级，再把结果摘要打印出来。

做法：
1. 触发 GitHub Actions 的“网站判级存档”（site-archive.yml），等它跑完（最多 10 分钟），再把本仓库更新到最新；
   GitHub 上取 Open-Meteo 不受云端额度限制，算出的等级和网站当时显示的一样。
2. 触发不了或等不到，就用仓库里最新的一份存档，并写明它是几点算的。
3. 仓库里 12 小时内一份存档都没有，就在临时目录里自己跑一次 scripts/site-archive.js（Open-Meteo 取不到时它改用仓库副本）。
输出：
- 屏幕上的摘要：每条路线、每天、每段（格）的等级和依据短句，以及提醒和缺的数据；
- /tmp/engine_state.json：按 state/*.json 的格式写好的“程序”一栏（a_engine、b_engine），定时任务写回仓库时照抄。
用法：python3 scripts/engine_summary.py --run evening   （晚间日报：明天起 7 天）
      python3 scripts/engine_summary.py --run morning   （晨间复查：今天、明天）
      加 --no-dispatch 只读仓库里已有的存档。
"""
import argparse, datetime as dt, glob, gzip, json, os, re, shutil, subprocess, sys, time

REPO = 'SHIELD-CAP/hokkaido-winter-route'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JST = dt.timezone(dt.timedelta(hours=9))
LV = {'black': '⬛', 'red': '🔴', 'orange': '🟠', 'green': '🟢', 'gray': '⬜'}
RANK = {'black': 4, 'red': 3, 'orange': 2, 'gray': 1, 'green': 0}
DOW = '一二三四五六日'


def sh(cmd, cwd=None):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=cwd)


def last_line(r):
    t = (r.stderr or r.stdout or '').strip().splitlines()
    return t[-1][:200] if t else f'退出码 {r.returncode}'


def dispatch_and_wait(timeout=600):
    t0 = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=10)
    r = sh(f'gh api -X POST repos/{REPO}/actions/workflows/site-archive.yml/dispatches -f ref=main')
    if r.returncode:
        return False, '触发 GitHub 上的“网站判级存档”失败：' + last_line(r)
    end = time.time() + timeout
    while time.time() < end:
        time.sleep(15)
        q = sh(f"gh api 'repos/{REPO}/actions/workflows/site-archive.yml/runs?per_page=5'")
        if q.returncode:
            continue
        try:
            runs = json.loads(q.stdout).get('workflow_runs', [])
        except Exception:
            continue
        mine = [x for x in runs if dt.datetime.fromisoformat(x['created_at'].replace('Z', '+00:00')) >= t0]
        if mine and mine[0]['status'] == 'completed':
            return mine[0]['conclusion'] == 'success', f"GitHub 上的“网站判级存档”运行结束：{mine[0]['conclusion']}"
    return False, '触发了 GitHub 上的“网站判级存档”，等了 10 分钟还没跑完'


def update_repo():
    r = sh('git fetch --depth 1 origin main && git reset --hard origin/main', cwd=ROOT)
    return r.returncode == 0, last_line(r)


def newest_log(root):
    fs = sorted(glob.glob(os.path.join(root, 'data/site_log/*/*/*/*.json.gz')))
    return fs[-1] if fs else None


def run_local():
    tmp = '/tmp/hwr_engine'
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.copytree(ROOT, tmp, ignore=shutil.ignore_patterns('.git'))
    r = sh('node scripts/site-archive.js', cwd=tmp)
    f = newest_log(tmp)
    return f, ('在云端自己跑了一次网站程序' + ('' if r.returncode == 0 else '，出错：' + last_line(r)))


def rt_of(text):
    m = re.match(r'［([^］]+)］', text or '')
    return m.group(1) if m else ''


def item(level, reasons, span, past=False, missing=None):
    if past:
        return ['已过']
    if level == 'green':
        return ['🟢']
    if level == 'gray':
        return ['⬜', '缺' + '、'.join(missing or []) if missing else '缺数据']
    top = next((r for r in reasons or [] if r.get('level') == level), {})
    return [LV.get(level, level), rt_of(top.get('text', '')) or '其他', top.get('rule', ''), span]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', choices=['evening', 'morning'], required=True)
    ap.add_argument('--no-dispatch', action='store_true')
    a = ap.parse_args()
    notes = []
    if not a.no_dispatch:
        ok, msg = dispatch_and_wait()
        notes.append(msg)
        u, umsg = update_repo()
        if not u:
            notes.append('更新仓库失败：' + umsg)
    f = newest_log(ROOT)
    now = dt.datetime.now(JST)
    age_h = None
    if f:
        m = re.search(r'site_log/(\d{4})/(\d\d)/(\d\d)/(\d\d)(\d\d)\.json\.gz$', f)
        t = dt.datetime(*map(int, m.groups()), tzinfo=JST)
        age_h = (now - t).total_seconds() / 3600
    if not f or age_h > 12:
        f, msg = run_local()
        notes.append(msg)
        age_h = 0
    if not f:
        print('程序的等级：一份都没拿到。' + '；'.join(notes))
        sys.exit(2)
    J = json.load(gzip.open(f))
    rel = os.path.relpath(f, ROOT) if f.startswith(ROOT) else f
    print(f"程序（网站同一个程序）的结果：{rel}，{J.get('run_jst')} 算的（距现在约 {age_h:.1f} 小时），代码提交 {str(J.get('commit') or '')[:7] or '未知'}，规则 {J.get('rules')}")
    for n in notes:
        print('  取得过程：' + n)
    if age_h is not None and age_h > 3:
        print(f'  ⚠ 这份结果已经 {age_h:.1f} 小时，报告的“数据情况”里要写明。')
    inp = J.get('inputs', {})
    msm = inp.get('msm', {})
    print(f"  MSM：{'直接取' if msm.get('source') == 'live' else '仓库副本' if msm.get('source') == 'repo' else msm.get('source')}，起算 {msm.get('init')}")
    bad = [f"{k}（{v.get('source')}{'：' + str(v.get('err'))[:80] if v.get('err') else ''}）" for k, v in inp.items() if v.get('source') in ('error', 'missing')]
    if bad:
        print('  程序没取到的输入：' + '；'.join(bad))
    for s in J.get('sources', []):
        if s.get('status') in ('error', 'stale'):
            print(f"  数据自检 {s['status']}：{s['name']}｜{s.get('note', '')[:150]}")
    for b in J.get('banners', []):
        print(f"  页面提示：{b.get('text', '')[:200]}")

    today = now.date()
    rng = (1, 8) if a.run == 'evening' else (0, 2)
    state_days = []
    for rt in J['routes']:
        print(f"\n== {rt['short']}")
        for d in rt['days']:
            ds = dt.date.fromisoformat(d['date'])
            k = (ds - today).days
            if not (rng[0] <= k < rng[1]):
                continue
            print(f"\n{ds.month}/{ds.day}({DOW[ds.weekday()]}) D+{k} {LV.get(d['level'], d['level'])} {d.get('headline', '')}" + (f"（缺：{'、'.join(d['missing'])}）" if d.get('missing') else ''))
            sd = next((x for x in state_days if x['date'] == d['date']), None)
            if not sd:
                sd = {'date': d['date']}
                state_days.append(sd)
            if d.get('segments'):
                sd['a_engine'] = {}
                for s in d['segments']:
                    sd['a_engine'][s['name'].split('（')[0]] = item(s['level'], s.get('reasons'), s.get('time', '').replace(':00', ''), s.get('past'), d.get('missing'))
                    if s.get('past'):
                        print(f"  {s['name']} {s['time']}：已过")
                        continue
                    rs = [r for r in s.get('reasons', []) if RANK.get(r.get('level'), 0) >= 2]
                    print(f"  {s['name']} {s['time']} {LV.get(s['level'], s['level'])}" + ('' if rs else '（没有触发规则）'))
                    for r in rs[:6]:
                        print(f"    - {LV.get(r['level'])} {r.get('rule', '')}：{r.get('short', '')}")
            if d.get('grid'):
                g = d['grid']
                sd['b_engine'] = {}
                for ci, col in enumerate(g['cols']):
                    cells = [(g['rows'][ri], row[ci]) for ri, row in enumerate(g['cells'])]
                    if all(c.get('past') for _, c in cells):
                        sd['b_engine'][col] = ['已过']
                        continue
                    live = [(rn, c) for rn, c in cells if not c.get('past')]
                    rn, worst = max(live, key=lambda x: RANK.get(x[1]['level'], 0))
                    sd['b_engine'][col] = item(worst['level'], worst.get('reasons'), rn.split(' ', 1)[-1], False, d.get('missing'))
                    for rn2, c in live:
                        rs = [r for r in c.get('reasons', []) if RANK.get(r.get('level'), 0) >= 2]
                        if rs:
                            print(f"  {col} {rn2.split(' ', 1)[-1]} {LV.get(c['level'])}：" + '；'.join(f"{r.get('rule', '')} {r.get('short', '')}" for r in rs[:4]))
                if all(v == ['🟢'] for v in sd['b_engine'].values()):
                    print('  六个时段两段路都没有触发规则')
            for n in d.get('notes', [])[:8]:
                print(f"  提醒：{n}")
    out = {'file': rel, 'run_jst': J.get('run_jst'), 'commit': str(J.get('commit') or '')[:7], 'rules': J.get('rules'),
           'msm': msm, 'age_hours': round(age_h or 0, 1), 'notes': notes, 'days': state_days}
    with open('/tmp/engine_state.json', 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print('\n已写 /tmp/engine_state.json（state 里“程序”一栏 a_engine、b_engine 照抄它）')


if __name__ == '__main__':
    main()
