"""Build source-faithful project previews from the existing drawing vectors."""
from pathlib import Path
import json
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'static/showcase/assets'
SVG = 'http://www.w3.org/2000/svg'
ET.register_namespace('', SVG)
CROP_ORIGIN = (423, 69)  # Verified against all 4,318 PV quads in the original PDF.
STYLE = ''':root{--plan-ink:oklch(27% 0.012 60);--plan-muted:oklch(45% 0.015 65);--plan-accent:oklch(51% 0.12 43);--plan-wash:oklch(94% 0.025 55);--plan-font:"Segoe UI","Microsoft YaHei",sans-serif}
path[data-zone]{fill:var(--plan-ink);opacity:.82}
.yard{fill:var(--plan-wash);stroke:var(--plan-accent);stroke-width:1}
.road,.aisle{fill:none;stroke:var(--plan-muted);stroke-width:1.2;opacity:.65}
.fence{fill:none;stroke:var(--plan-muted);stroke-width:.7;stroke-dasharray:2 2}
.point{fill:var(--plan-ink)}
text{fill:var(--plan-ink);font-family:var(--plan-font)}
.leader{fill:none;stroke:var(--plan-accent);stroke-width:2}
'''

def svg(bounds, title, description):
    root = ET.Element(f'{{{SVG}}}svg', {'viewBox': ' '.join(f'{v:g}' for v in bounds), 'role': 'img', 'aria-labelledby': 'title description'})
    ET.SubElement(root, f'{{{SVG}}}title', {'id': 'title'}).text = title
    ET.SubElement(root, f'{{{SVG}}}desc', {'id': 'description'}).text = description
    ET.SubElement(root, f'{{{SVG}}}style').text = STYLE
    return root

def points_path(points, closed=False):
    return 'M' + 'L'.join(f'{x:g},{y:g}' for x, y in points) + ('Z' if closed else '')

def pv_rows(root, drawing):
    for zone in drawing['zones']:
        assert all(len(quad) == 4 for quad in zone['rows'])
        ET.SubElement(root, f'{{{SVG}}}path', {'d': ''.join(points_path(quad, True) for quad in zone['rows']), 'data-zone': str(zone['zone']), 'data-row-count': str(len(zone['rows']))})

def campus_paths(root, campus):
    for key in ('bessBoundary', 'stationBoundary', 'omBoundary'):
        ET.SubElement(root, f'{{{SVG}}}path', {'d': points_path(campus[key], True), 'class': 'yard', 'data-source-key': key})
    # The third stored road is a display-only west approach, so use only the two PDF paths.
    for road in campus['roads'][:2]:
        ET.SubElement(root, f'{{{SVG}}}path', {'d': points_path(road), 'class': 'road'})

def save(root, name):
    output = ASSETS / name
    ET.ElementTree(root).write(output, encoding='utf-8', xml_declaration=True)
    return ET.parse(output).getroot()

def build():
    drawing = json.loads((ASSETS / 'site-plan-rows.json').read_text(encoding='utf-8'))
    campus = json.loads((ASSETS / 'bess-campus-layout.json').read_text(encoding='utf-8'))
    width, height = drawing['crop']
    root = svg((0, 0, width, height), '巴法拉内光储场区总平面示意', '保留附图1的13个光伏分区及全部组件排位置；左下储能、站区和运维场坪按原图坐标复绘。颜色不代表标段或建设状态。')
    pv_rows(root, drawing)
    group = ET.SubElement(root, f'{{{SVG}}}g', {'transform': f'translate(-{CROP_ORIGIN[0]} -{CROP_ORIGIN[1]})', 'data-crop-origin': '423 69'})
    campus_paths(group, campus)
    ET.SubElement(root, f'{{{SVG}}}path', {'d': 'M160,972H205L230,1000', 'class': 'leader'})
    ET.SubElement(root, f'{{{SVG}}}text', {'x': '245', 'y': '1012', 'font-size': '28'}).text = '储能与配套'
    ET.SubElement(root, f'{{{SVG}}}text', {'x': '940', 'y': '990', 'font-size': '28'}).text = '光伏场区 · 13 个分区'
    assert len(drawing['zones']) == 13
    saved = save(root, 'project-plan.svg')
    original = {str(z['zone']): ''.join(points_path(quad, True) for quad in z['rows']) for z in drawing['zones']}
    assert {p.attrib['data-zone']: p.attrib['d'] for p in saved.findall(f'{{{SVG}}}path') if 'data-zone' in p.attrib} == original
    assert saved.find(f'{{{SVG}}}g').attrib['transform'] == 'translate(-423 -69)'
    for path in saved.find(f'{{{SVG}}}g').findall(f'{{{SVG}}}path'):
        if 'data-source-key' in path.attrib:
            assert path.attrib['d'] == points_path(campus[path.attrib['data-source-key']], True)

    points = [point for z in drawing['zones'] for row in z['rows'] for point in row]
    left, top = min(p[0] for p in points)-24, min(p[1] for p in points)-24
    bounds = (left, top, max(p[0] for p in points)-left+24, max(p[1] for p in points)-top+24)
    preview = svg(bounds, '光伏分区与组件排', '附图1全部光伏组件排原始位置，不代表建设状态。')
    pv_rows(preview, drawing)
    save(preview, 'pv-plan-preview.svg')

    preview = svg((426, 812, 196, 313), '储能、开关站与运维区', '附图1原始场坪、道路与局部围栏；设备点位按附图3-2配准，仅为点位示意，不代表设备尺寸或采购数量。虚线对应原图粉色FENCE，不补画闭合边。')
    campus_paths(preview, campus)
    for aisle in campus['aisles']:
        ET.SubElement(preview, f'{{{SVG}}}path', {'d': points_path(aisle), 'class': 'aisle'})
    fence = ET.SubElement(preview, f'{{{SVG}}}path', {'d': points_path(campus['fencePolyline']), 'class': 'fence'})
    equipment = json.loads((ASSETS / 'bess-equipment-layout.json').read_text(encoding='utf-8'))
    scale, tx, ty = campus['bessTransform']
    for x, y in equipment['symbols']['battery']:
        ET.SubElement(preview, f'{{{SVG}}}circle', {'cx': f'{x*scale+tx:.4f}', 'cy': f'{y*scale+ty:.4f}', 'r': '1.2', 'class': 'point'})
    for x, y, label in ((506, 894, '运维区'), (521, 960, '开关站')):
        ET.SubElement(preview, f'{{{SVG}}}text', {'x': str(x), 'y': str(y), 'font-size': '6', 'text-anchor': 'middle'}).text = label
    saved = save(preview, 'campus-plan-preview.svg')
    assert not fence.attrib['d'].endswith('Z')
    circles = saved.findall(f'{{{SVG}}}circle')
    assert len(circles) == len(equipment['symbols']['battery'])
    for node, (x, y) in zip(circles, equipment['symbols']['battery']):
        assert abs(float(node.attrib['cx'])-(x*scale+tx)) < .001
        assert abs(float(node.attrib['cy'])-(y*scale+ty)) < .001
    print('Built 3 drawing previews: 13 zones / 4,318 original rows; campus registration and open fence preserved.')

if __name__ == '__main__':
    build()
