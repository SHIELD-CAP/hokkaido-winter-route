# 网站源码

公开网站 https://hokkaido-winter-route.netlify.app 的源码。纯静态单页：访客的浏览器直接向气象厅（JMA）和 Open-Meteo 取数，在浏览器里按固定规则算等级。

- `src/engine.js`：取数、解析和判定引擎；公开的规则说明在里面的 `RULES_TEXT`。
- `ui/ui.html`：界面。
- `src/bandmap.js`：“雪带地图”（2026-11-26 晚加，同晚加机场线）。每条路线的“气象厅发布的内容”上方一张：一日游读仓库里的 `data/latest/msm_grid.json`（道央道两侧），机场线读 `msm_grid_b.json`（小樽—札幌—新千岁机场两侧），都是 GitHub Actions 每 3 小时取的 MSM 网格，打开那一栏时才从 raw.githubusercontent.com 读。按气温把每小时降水换算成降雪厘米（0.9／1.3／1.5／1.7 倍）画色块，3 小时冷降水 ≥7 mm 的格子描红边；可拖动、播放。只看不判级。海岸线取自 Natural Earth（公有领域）。`build.py` 把它接在 `engine.js` 后面，CSP 的 connect-src 加了 raw.githubusercontent.com。
- `build.py`：把两者合成 `dist/index.html`，并写 `dist/_headers`（安全头和 CSP）。`dist/` 不进仓库。
- `test/`：开发时用的测试。`v4.js`、`synth.js`、`bulletins.js` 用内置样例数据；`live.js`、`live_v6.js` 读开发机上临时存下的实时数据（路径写死在脚本里），只能在那台机器上跑。

部署：这个仓库没有连到 Netlify，推送不会自动部署。改完先 `python3 build.py`，再用 Netlify 的部署工具上传 `dist/`。免费版每月 300 积分，一次正式部署扣 15。

数据出处：気象庁ホームページ；Weather data by Open-Meteo.com（CC BY 4.0）；海岸线 Natural Earth。
