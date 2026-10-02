"""Run: python tools/check_warehouse_design.py; checks shared tokens without a browser."""
from pathlib import Path
import math
import re

root = Path(__file__).resolve().parents[1]
tokens = (root / 'static/tokens.css').read_text(encoding='utf-8')
css = (root / 'static/style.css').read_text(encoding='utf-8')
values = dict(re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', tokens + '\n' + css))
assert set(re.findall(r'var\((--[\w-]+)', css + tokens)) <= values.keys()
assert not re.search(r':\s*(?:#[0-9a-fA-F]{3,8}\b|rgba?\()', css)
assert css.count('{') == css.count('}')
assert 'overflow-x: clip' in css and 'prefers-reduced-motion' in css
assert 'outline: 3px solid var(--color-focus)' in css

def linear_rgb(name):
    value = values[name]
    if value.startswith('var('):
        return linear_rgb(re.search(r'var\((--[\w-]+)\)', value)[1])
    match = re.fullmatch(r'oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)', value)
    assert match, (name, value)
    light, chroma, hue = map(float, match.groups())
    light /= 100
    a, b = chroma * math.cos(math.radians(hue)), chroma * math.sin(math.radians(hue))
    l = (light + .3963377774 * a + .2158037573 * b) ** 3
    m = (light - .1055613458 * a - .0638541728 * b) ** 3
    s = (light - .0894841775 * a - 1.291485548 * b) ** 3
    rgb = (4.0767416621*l - 3.3077115913*m + .2309699292*s,
           -1.2684380046*l + 2.6097574011*m - .3413193965*s,
           -.0041960863*l - .7034186147*m + 1.707614701*s)
    return tuple(max(0, min(1, x)) for x in rgb)

def luminance(name):
    r, g, b = linear_rgb(name)
    return .2126*r + .7152*g + .0722*b

pairs = [('ink', 'paper'), ('ink-2', 'paper'), ('ink-2', 'sidebar'),
         ('accent-ink', 'accent'), ('accent', 'accent-wash'),
         ('green', 'green-wash'), ('amber', 'amber-wash'), ('red', 'red-wash')]
for foreground, background in pairs:
    x, y = sorted((luminance('--color-' + foreground), luminance('--color-' + background)))
    ratio = (y + .05) / (x + .05)
    assert ratio >= 4.5, (foreground, background, ratio)
    print(f'{foreground}/{background}: {ratio:.2f}:1')
print('PASS: colour contrast, token references, bounded tables and reduced-motion source rules.')
