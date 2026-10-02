"""Extract the campus footprint and road curves from the original overall drawing."""
from pathlib import Path
import json
import fitz
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'static/showcase/assets'
SOURCE = Path('D:/南非巴法拉内光储项目/08_Technical/图纸/附图1 总平面布置图.pdf')

def build():
    page = fitz.open(SOURCE)[0]
    paths = page.get_drawings()
    def outline(index):
        return [[round(item[1].x, 4), round(item[1].y, 4)] for item in paths[index]['items'] if item[0] == 'l']
    source_boundary = outline(24216)[:6]
    boundary = [source_boundary[i] for i in (0,5,4,3,2,1)]
    dedicated = json.loads((ASSETS/'bess-ground-boundary.json').read_text(encoding='utf-8'))['points']
    # Corresponding six clipped polygon vertices in both source sheets.
    xy = np.array(dedicated + dedicated)
    observed = np.array(boundary + boundary)
    design = np.zeros((12, 3))
    design[:6, 0] = xy[:6, 0]; design[:6, 1] = 1
    design[6:, 0] = xy[6:, 1]; design[6:, 2] = 1
    scale, tx, ty = np.linalg.lstsq(design, np.r_[observed[:6, 0], observed[6:, 1]], rcond=None)[0]
    residual = np.linalg.norm(np.array(dedicated)*scale+[tx,ty]-np.array(boundary), axis=1)
    assert max(residual) < 0.4, residual
    def sample(indices):
        points = []
        for index in indices:
            for item in paths[index]['items']:
                if item[0] == 'l':
                    segment = [item[1], item[2]]
                elif item[0] == 'c':
                    a,b,c,d = item[1:]
                    segment = [a*(1-t)**3+b*3*(1-t)**2*t+c*3*(1-t)*t*t+d*t**3 for t in np.linspace(0,1,17)]
                else:
                    continue
                for point in segment:
                    if not points or np.linalg.norm(np.array(points[-1])-[point.x,point.y]) > 0.01:
                        points.append([round(point.x,4),round(point.y,4)])
        return points
    aisles = []
    for a,b in [(25773,25774),(26300,26301),(26850,26851)]:
        aisles.append([[(paths[a]['items'][0][k][axis]+paths[b]['items'][0][k][axis])/2 for axis in (0,1)] for k in (1,2)])
    # The PDF legend identifies the magenta square/post line as FENCE, distinct
    # from the red SITE BOUNDARY and black yard footprints. Keep this local
    # stretch open: it continues around the PV field outside the BESS view.
    def marker(index):
        rect=paths[index]['rect']
        assert paths[index]['color']==(1.,0.,1.) and len(paths[index]['items'])==5
        return [round((rect.x0+rect.x1)/2,4),round((rect.y0+rect.y1)/2,4)]
    fence=[marker(27525),list(paths[27527]['items'][0][1]),
           list(paths[27549]['items'][1][2]),marker(27605),marker(27639)]
    assert abs(fence[2][0]-444.66)<0.01 and abs(fence[3][0]-444.66)<0.01
    gate_t=(954-fence[2][1])/(fence[3][1]-fence[2][1])
    campus = {'source':SOURCE.name,'basis':'原PDF坐标；储能详图按六个对应外轮廓点统一比例映射。建筑与设备外形仍为展示概括。',
              'bessTransform':[float(scale),float(tx),float(ty)], 'registrationErrorPoints':float(max(residual)),
              'bessBoundary':boundary, 'stationBoundary':outline(64213), 'omBoundary':outline(64230),
              'fencePolyline':fence,'fenceBasis':'总平面图例FENCE对应的粉色点线；此处只提取储能配套附近段，不推定右侧闭合边。',
              'fenceGate':{'edgeIndex':2,'t':gate_t,'basis':'展示入口按道路与围栏交点定位；不作为施工门位'},
              'roads':[sample(range(64221,64226)),sample([64226,64227,64228]),
                       [[386,954],[450,954],[459,954],[468.36,944.32]]], 'aisles':aisles}
    (ASSETS/'bess-campus-layout.json').write_text(json.dumps(campus,ensure_ascii=False,indent=2),encoding='utf-8')
    page.get_pixmap(matrix=fitz.Matrix(3,3),clip=fitz.Rect(426,812,622,1125)).save(ASSETS/'bess-plan-reference.png')
    print('Source campus extracted; maximum registration error:',round(max(residual),3),'PDF points')

if __name__ == '__main__':
    build()
