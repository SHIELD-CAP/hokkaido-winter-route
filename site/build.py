#!/usr/bin/env python3
"""把界面层 ui/ui.html 和取数判定层 src/engine.js 合成一个 dist/index.html。
生产版去掉样例数据，首屏显示“正在取数据”。"""
import re, pathlib, sys

root = pathlib.Path(__file__).parent
ui = (root / 'ui' / 'ui.html').read_text(encoding='utf-8')
engine = (root / 'src' / 'engine.js').read_text(encoding='utf-8')

start = ui.index('/* =====================================================================\n * 样例数据')
end_marker = "render(window.VIEW || MOCK_VIEW);"
end = ui.index(end_marker) + len(end_marker)
ui = ui[:start] + "render(window.VIEW || { meta: { loading: true, freshness: '正在取数据…' } });" + ui[end:]
assert 'MOCK' not in ui, 'mock left'

head_extra = ('<meta name="description" content="札幌出发的一日游路线和小樽—札幌—新千岁机场路线，按气象厅公开数据和数值模式自动计算的冬季出行参考等级。">\n'
              '<meta name="robots" content="noindex">\n'
              '<meta name="referrer" content="no-referrer">\n')
ui = ui.replace('<meta name="color-scheme" content="light dark">\n', '<meta name="color-scheme" content="light dark">\n' + head_extra, 1)

if '</script>' in engine:
    sys.exit('engine contains </script>')
out = ui.replace('</body>', '<script>\n' + engine + '\n</script>\n</body>', 1)
dist = root / 'dist'
dist.mkdir(exist_ok=True)
(dist / 'index.html').write_text(out, encoding='utf-8')
(dist / '_headers').write_text(
    "/*\n"
    "  X-Content-Type-Options: nosniff\n"
    "  Referrer-Policy: no-referrer\n"
    "  X-Robots-Tag: noindex\n"
    "  Cache-Control: public, max-age=300\n"
    "  Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src https://www.jma.go.jp https://api.open-meteo.com https://ensemble-api.open-meteo.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\n",
    encoding='utf-8')
print('dist/index.html', len(out.encode('utf-8')), 'bytes')
