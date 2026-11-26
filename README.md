# hokkaido-winter-route

北海道冬季两条路线的出行风险判定：判定规则、高速封路日志，以及每天两次判定的记录。

- 路线甲：札幌—旭山動物園—美瑛—白金（青い池）一日游，回程走道道353、国道237、道道135、国道452 到三笠IC 上道央道。
- 路线乙：小樽⇔札幌⇔新千歳空港（札樽道、道央道）。
- 公开网站：https://hokkaido-winter-route.netlify.app （2026-11-25 23:16 起按 v6 的网站版规则计算：只看天气，含雪带规则和当天 AMeDAS 实况一条，不含封路实况和预告、JR 停运、tenki.jp；在看网页的那台设备上直接向气象厅和 Open-Meteo 取数）。源码在 `site/`，说明见 `site/README.md`。

## 目录

- `rules/v6.md`：现行判定规则（2026-11-25 晚起），晚间日报（20:20，看未来 7 天）和晨间复查（06:20，看当天和第二天）共用。`rules/v4.md` 是上一版，留作对照。
- `analysis/`：复盘和审阅记录。`2026-11-25_漏报与雪带规则.md` 说明 v6 为什么加雪带规则、依据哪些数据。
- `data/closures.csv`：高速封路日志，从 2025–26 年冬季开始，每条写开始、解除、区间、原因、出处和核对程度，用来回测规则。
- `data/labels.csv`：逐日标签（哪天一日游高速段、机场线高速段封了路，哪些日子逐日核对过）。
- `data/obs/`：岩見沢、札幌两站 2025–26 冬季和本季的逐时实测。
- `data/backtest/`、`scripts/backtest_snowband.py`：雪带规则回测，改了脚本或标签，GitHub Actions 会自动重跑（`.github/workflows/backtest.yml`）。
- `data/latest/`、`data/archive/`：GitHub Actions 定时向 Open-Meteo 取的 MSM、ECMWF 数值，以及气象厅产品的存档；说明见 `data/README.md`。两个定时任务取 Open-Meteo 被拒时读这里。
- `state/`：预留给每次判定的记录，目前没有在用。2026-11-26 实测：接入了本仓库的定时任务，运行时可以直接 `git clone`、`git push` 写进来；两个每日任务建于本仓库之前，还没有实测能不能写。格式和测试经过见 `state/README.md`。

## 这里不放什么

仓库是公开的，任何人都能看。行程日期、住址、联系方式这类个人信息一律不放进来。
