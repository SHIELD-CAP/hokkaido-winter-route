# data

- `closures.csv`：高速封路日志，每条写开始、解除、区间、原因、出处和核对程度，用来回测规则。
- `latest/msm.json`、`latest/ifs.json`：GitHub Actions（`.github/workflows/fetch-data.yml`）每 3 小时、另在日本时间 05:40 和 19:40 向 Open-Meteo 取的 MSM 和 ECMWF IFS 格点数值，按取样点编号整理。这一次取不到时，保留上一次成功的版本；新旧看文件里的 `fetched_utc`（取数时刻）和 `init_utc`（模式起算时刻）。
- `latest/status.json`：最近一次运行，各来源取没取到。
- `fetch_log.csv`：每次运行、每个来源的 HTTP 状态码。用来统计 GitHub 这边取 Open-Meteo 的成功率。
- `archive/年/月/日/`：每次运行存一份 MSM；气象厅的警报注意报、危险度时间序列、天气预报、早期注意信息、地域时序预报，内容有变化时存一份。都用 gzip 压缩，原样保存，没有加工。气象厅网站不保留这些产品的历史版本，这里存下来是为了以后回测。

取样点：A1–A10、B1–B6 与网站一致；E1–E5 是道央道沿线新增的点（江别东 IC、江别东—岩见泽之间、三笠 IC、美呗 IC、奈井江砂川 IC），坐标取自各 IC 收费站的位置。

出处：模式数值为 Weather data by Open-Meteo.com，按 CC BY 4.0 使用，原始模式是日本气象厅的 MSM 和 ECMWF 的 IFS。气象厅产品出自気象庁ホームページ。
