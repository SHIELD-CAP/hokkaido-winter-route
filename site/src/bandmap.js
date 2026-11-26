/* 雪带地图：道央道两侧 20 公里内的 MSM 网格，逐小时播放。
 * 数据是 GitHub Actions 每 3 小时取一次、存在仓库里的 data/latest/msm_grid.json（scripts/fetch-data.mjs），
 * 第一次展开这张卡片时才去读。只用于看，不参与判级（判级仍只看沿线 9 个格点，见规则说明）。
 * 海岸线：Natural Earth 1:10m 陆地（公有领域），裁到本图范围。 */
(function () {
  const URL_GRID = 'https://raw.githubusercontent.com/SHIELD-CAP/hokkaido-winter-route/main/data/latest/msm_grid.json';
  const COAST = [[140.85,43.192],[140.913,43.204],[140.988,43.227],[141.011,43.229],[141.022,43.224],[141.012,43.211],[141.004,43.193],[141.022,43.175],[141.033,43.172],[141.07,43.169],[141.111,43.156],[141.136,43.152],[141.157,43.143],[141.169,43.141],[141.187,43.142],[141.201,43.144],[141.228,43.154],[141.304,43.197],[141.371,43.251],[141.397,43.28],[141.423,43.318],[141.44,43.362],[141.44,43.408],[141.427,43.435],[141.371,43.497],[141.36,43.524],[141.362,43.543],[141.375,43.561],[141.391,43.579],[141.373,43.618],[141.364,43.628],[141.367,43.646],[141.344,43.69],[141.337,43.713],[141.344,43.732],[141.358,43.756],[141.385,43.791],[141.402,43.804],[141.425,43.815],[141.448,43.822],[141.491,43.827],[141.51,43.833],[141.528,43.841],[141.585,43.875],[141.616,43.903],[141.641,43.938],[141.659,43.984],[141.667,44.025],[141.67,44.067],[141.655,44.1]];
  const P9 = [['札幌', 43.06, 141.35], ['江别东IC', 43.107, 141.598], ['', 43.142, 141.681], ['岩见泽', 43.20, 141.76], ['三笠IC', 43.243, 141.827],
    ['美呗IC', 43.334, 141.890], ['奈井江砂川IC', 43.450, 141.915], ['砂川・泷川', 43.53, 141.91], ['深川', 43.72, 142.05]];
  const SNOW_BR = [0.5, 1, 2, 3, 4, 6], SNOW_C = ['#dbe9fb', '#b5d4f4', '#85b7eb', '#378add', '#185fa5', '#0c447c', '#26215c'];
  const RAIN_C = ['#c8e6c9', '#81c784'];
  const LON0 = 141.05, LON1 = 142.4, LAT0 = 42.9, LAT1 = 43.95, KX = Math.cos(43.4 * Math.PI / 180);
  const W = 360, PAD = 8, SX = (W - 2 * PAD) / ((LON1 - LON0 + 0.0625) * KX), H = Math.round((LAT1 - LAT0 + 0.05) * SX + 2 * PAD);
  const X = lon => PAD + (lon - LON0 + 0.03125) * KX * SX, Y = lat => PAD + (LAT1 + 0.025 - lat) * SX;
  // 降水换算降雪（cm/mm），岩见泽、札幌 2025–26 冬季实测：3 小时降水 2 mm 以上、气温 0.5 ℃ 以下时，降雪厘米数与降水毫米数之比的中位数
  const ratio = T => (T > 0 ? 0.9 : T > -2 ? 1.3 : T > -4 ? 1.5 : 1.7);
  const f1 = v => (Math.round(v * 10) / 10).toFixed(1);
  let root = null, data = null, idx = 0, timer = null, loading = false, sel = -1;

  function el(tag, attrs, html) { const e = document.createElement(tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }

  function build() {
    root = el('details', { class: 'card', 'data-k': 'bandmap', id: 'bandmap' });
    root.innerHTML = '<summary>雪带地图（MSM，道央道两侧 20 公里）<span class="muted" id="bm-sum">点开看</span></summary>' +
      '<div class="dbody"><p class="muted small" style="margin-bottom:8px">只看，不参与判级。颜色是按气温把降水换算成的降雪量，红框是 3 小时 0.5 ℃ 以下的降水到了雪带红线（7 mm）。</p>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><button type="button" class="btn" id="bm-play" style="min-width:56px">播放</button>' +
      '<input type="range" id="bm-sl" min="0" max="1" step="1" value="0" style="flex:1" aria-label="选择时间"></div>' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:4px" id="bm-time">正在读取…</div>' +
      '<div id="bm-svg"></div><div class="small" id="bm-leg" style="display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:6px;color:var(--ink2)"></div>' +
      '<p class="small" id="bm-info" style="margin-top:8px;min-height:20px;color:var(--ink2)">点任意方块看那一格的数</p>' +
      '<p class="muted small" id="bm-foot" style="margin-top:6px"></p></div>';
    root.addEventListener('toggle', () => { if (root.open) load(); else stop(); });
    root.querySelector('#bm-play').addEventListener('click', () => (timer ? stop() : play()));
    root.querySelector('#bm-sl').addEventListener('input', e => { stop(); idx = +e.target.value; draw(); });
    root.querySelector('#bm-svg').addEventListener('click', e => { const c = e.target.closest('[data-i]'); if (c) { sel = +c.dataset.i; info(); } });
    const leg = root.querySelector('#bm-leg');
    leg.innerHTML = ['0.5–1', '1–2', '2–3', '3–4', '4–6', '6+'].map((t, i) => `<span style="display:flex;align-items:center;gap:4px"><span style="width:11px;height:11px;border-radius:2px;background:${SNOW_C[i + 1]}"></span>${t}</span>`).join('') +
      '<span>cm/时（雪）</span>' +
      `<span style="display:flex;align-items:center;gap:4px"><span style="width:11px;height:11px;border-radius:2px;background:${RAIN_C[1]}"></span>雨</span>` +
      '<span style="display:flex;align-items:center;gap:4px"><span style="width:11px;height:11px;border:2px solid #e24b4a"></span>3 小时 ≥7 mm（约 9 cm 雪）</span>';
  }

  function load() {
    if (data || loading) return;
    loading = true;
    fetch(URL_GRID + '?cb=' + Date.now(), { cache: 'no-store' }).then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(j => {
      data = j; loading = false; prep(); draw(); play();
    }).catch(e => { loading = false; root.querySelector('#bm-time').textContent = '数据没读到（' + e + '），稍后再点开试试'; });
  }

  function prep() {
    const n = data.time.length;
    data.cold3 = data.points.map((_, i) => {
      const c = data.prec[i].map((p, k) => (p != null && data.temp[i][k] != null && data.temp[i][k] <= 5 ? p / 10 : 0));
      return c.map((_, k) => (k >= 2 ? c[k] + c[k - 1] + c[k - 2] : null));
    });
    let last = n - 1;
    while (last > 0 && data.prec.every(r => r[last] == null)) last--;
    const now = Date.now();
    let start = data.time.findIndex(t => new Date(t + ':00+09:00').getTime() >= now - 3600e3);
    if (start < 0) start = 0;
    data.i0 = Math.max(0, start - 6); data.i1 = last;
    idx = start;
    const sl = root.querySelector('#bm-sl'); sl.min = data.i0; sl.max = data.i1; sl.value = idx;
    const ft = new Date(data.fetched_utc);
    root.querySelector('#bm-foot').textContent = `数据：${data.source}，GitHub Actions 取于 ${ft.toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo', hour12: false })}（东京时间）。` +
      '降雪按气温换算：0 ℃ 以上 0.9 倍，−2～0 ℃ 1.3 倍，−4～−2 ℃ 1.5 倍，−4 ℃ 以下 1.7 倍（岩见泽、札幌去冬实测的中位数）。海岸线：Natural Earth。';
    root.querySelector('#bm-sum').textContent = `MSM 到 ${label(data.i1, true)}`;
    // 静态部分：海岸、路线、地名
    const cw = 0.0625 * KX * SX, ch = 0.05 * SX;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="道央道两侧雪带地图" style="display:block;touch-action:manipulation">`;
    s += `<polygon points="${COAST.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ')}" fill="var(--card2)" stroke="var(--line)" stroke-width="1"/>`;
    s += '<g id="bm-cells">' + data.points.map((p, i) => `<rect data-i="${i}" x="${(X(p[1]) - cw / 2).toFixed(1)}" y="${(Y(p[0]) - ch / 2).toFixed(1)}" width="${cw.toFixed(1)}" height="${ch.toFixed(1)}" fill="transparent" stroke="none"/>`).join('') + '</g>';
    s += `<polyline points="${P9.map(p => X(p[2]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ')}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>`;
    s += P9.map(p => `<circle cx="${X(p[2]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="3.5" fill="var(--card)" stroke="var(--ink)" stroke-width="1.5"/>`).join('');
    s += P9.filter(p => p[0] && !/IC$/.test(p[0])).map(p => `<text x="${(X(p[2]) + 7).toFixed(1)}" y="${(Y(p[1]) + 4).toFixed(1)}" font-size="12" fill="var(--ink2)" stroke="var(--card)" stroke-width="3" paint-order="stroke">${p[0]}</text>`).join('');
    s += `<text x="${X(141.22).toFixed(1)}" y="${Y(43.32).toFixed(1)}" font-size="12" fill="var(--ink3)" text-anchor="middle">石狩湾</text></svg>`;
    root.querySelector('#bm-svg').innerHTML = s;
  }

  function label(k, short) {
    const t = new Date(data.time[k] + ':00+09:00'), p = new Date(t.getTime() - 3600e3);
    const hh = d => String(d.getHours()).padStart(2, '0');
    return short ? `${t.getMonth() + 1}/${t.getDate()} ${hh(t)} 时` : `${p.getMonth() + 1}/${p.getDate()} ${hh(p)}–${hh(t)} 时`;
  }

  function cellColor(p, T) {
    if (p == null || T == null || p < 0.2) return 'transparent';
    if (T > 0.5) return p >= 2 ? RAIN_C[1] : RAIN_C[0];
    const cm = p * ratio(T);
    if (cm < 0.5) return SNOW_C[0];
    let i = 0; while (i < SNOW_BR.length && cm >= SNOW_BR[i]) i++;
    return SNOW_C[i];
  }

  function draw() {
    if (!data || !root.querySelector('#bm-cells')) return;
    const rects = root.querySelectorAll('#bm-cells rect');
    rects.forEach((r, i) => {
      const p = data.prec[i][idx], T = data.temp[i][idx];
      r.setAttribute('fill', cellColor(p == null ? null : p / 10, T == null ? null : T / 10));
      const c3 = data.cold3[i][idx];
      r.setAttribute('stroke', c3 != null && c3 >= 7 ? '#e24b4a' : 'none');
      r.setAttribute('stroke-width', '1.4');
    });
    root.querySelector('#bm-sl').value = idx;
    const past = new Date(data.time[idx] + ':00+09:00').getTime() <= Date.now();
    root.querySelector('#bm-time').textContent = label(idx) + (past ? '（已过去，MSM 前几轮的预报值）' : '');
    if (sel >= 0) info();
  }

  function info() {
    if (!data || sel < 0) return;
    const pt = data.points[sel], p = data.prec[sel][idx], T = data.temp[sel][idx], c3 = data.cold3[sel][idx];
    const side = pt[4] === 'W' ? '西北侧' : '东南侧';
    let t = `北纬 ${pt[0].toFixed(2)}、东经 ${pt[1].toFixed(2)}（离道央道约 ${Math.round(pt[2])} 公里，${side}）：`;
    if (p == null || T == null) t += '这一小时没有数';
    else {
      const mm = p / 10, tc = T / 10;
      t += mm < 0.1 ? `这一小时没有降水（${f1(tc)} ℃）` : tc <= 0.5 ? `约 ${f1(mm * ratio(tc))} cm 雪（降水 ${f1(mm)} mm，${f1(tc)} ℃）` : `雨 ${f1(mm)} mm（${f1(tc)} ℃）`;
      if (c3 != null && c3 > 0) t += `；3 小时 0.5 ℃ 以下的降水 ${f1(c3)} mm`;
    }
    root.querySelector('#bm-info').textContent = t;
  }

  function play() { stop(); if (!data) return; root.querySelector('#bm-play').textContent = '暂停'; timer = setInterval(() => { idx = idx >= data.i1 ? data.i0 : idx + 1; draw(); }, 700); }
  function stop() { if (timer) clearInterval(timer); timer = null; if (root) root.querySelector('#bm-play').textContent = '播放'; }

  // 主界面每次重画都会换掉里面的节点，地图卡片单独保留，重画后挂回占位处
  window.mountBandMap = function (slot) {
    if (!slot) return;
    if (!root) build();
    slot.replaceWith(root);
  };
})();
