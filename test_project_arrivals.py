import json, tempfile, threading, unittest, urllib.request
import server as app


class ProjectArrivalsTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); app.DATA=app.Path(self.tmp.name); app.init()

    def tearDown(self): self.tmp.cleanup()

    def test_unmapped_items_are_unknown_not_zero(self):
        with app.connect() as c: result=app.project_arrivals(c)
        cabinet=next(row for row in result['items'] if row['equipment_key']=='bess-cabinet')
        self.assertEqual((cabinet['lot_code'],cabinet['model_display_count']),('Lot-05',86))
        self.assertEqual(cabinet['status'],'unmapped')
        self.assertIsNone(cabinet['received']); self.assertIsNone(cabinet['total']); self.assertIsNone(cabinet['rate'])
        self.assertNotIn('token',result); self.assertNotIn('code',cabinet); self.assertNotIn('batch',cabinet)

    def test_duplicate_identity_and_wrong_unit_are_not_counted(self):
        with app.connect() as c:
            c.execute("INSERT INTO items(code,name,spec,unit,package) VALUES('CAB-1','储能柜','BESS-X','台','A5')")
            c.execute("INSERT INTO items(code,name,spec,unit,package) VALUES('CAB-2','储能柜','BESS-X','台','A5')")
            c.execute("INSERT INTO items(code,name,spec,unit,package) VALUES('CAB-3','电池柜','BESS-Y','套','A5')")
            result=app.project_arrivals(c)
        cabinets=[row for row in result['items'] if row['equipment_key']=='bess-cabinet']
        self.assertEqual([row['status'] for row in cabinets],['multiple_matches','multiple_matches','unit_mismatch'])
        self.assertTrue(all(row['received'] is None and row['rate'] is None for row in cabinets))

    def test_exact_mapping_counts_only_unreversed_non_spare_receipts(self):
        with app.connect() as c:
            c.execute("INSERT INTO items(code,name,spec,unit,package) VALUES('CAB-1','储能柜','BESS-X','台','A5')")
            c.execute('INSERT INTO design(code,qty) VALUES(?,?)',('CAB-1',app.units('100')))
            c.execute("INSERT INTO documents(number,kind,external_ref,operator,party,purpose,created,request_key) VALUES('IN-1','IN','R1','T','T','test',?,'k1')",(app.now(),))
            received_doc=c.execute('SELECT last_insert_rowid()').fetchone()[0]
            c.execute("INSERT INTO lines(doc_id,code,name,spec,unit,batch,box,warehouse,bin,state,qty) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(received_doc,'CAB-1','储能柜','BESS-X','台','B01','C01','W','A1','AVAILABLE',app.units('10')))
            c.execute("INSERT INTO lines(doc_id,code,name,spec,unit,batch,box,warehouse,bin,state,qty) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(received_doc,'CAB-1','储能柜','BESS-X','台','B01','C02','W','A1','SPARE',app.units('2')))
            c.execute("INSERT INTO documents(number,kind,external_ref,operator,party,purpose,created,request_key,reversed_by) VALUES('IN-2','IN','R2','T','T','reversed',?,'k2',99)",(app.now(),))
            reversed_doc=c.execute('SELECT last_insert_rowid()').fetchone()[0]
            c.execute("INSERT INTO lines(doc_id,code,name,spec,unit,batch,box,warehouse,bin,state,qty) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(reversed_doc,'CAB-1','储能柜','BESS-X','台','B02','C01','W','A1','AVAILABLE',app.units('5')))
            result=app.project_arrivals(c)
        cabinet=next(row for row in result['items'] if row['equipment_key']=='bess-cabinet')
        self.assertEqual((cabinet['status'],cabinet['spec'],cabinet['received'],cabinet['total'],cabinet['rate']),('mapped','BESS-X',10,100,0.1))
        self.assertIsNone(cabinet['in_transit'])

    def test_home_warehouse_route_and_read_only_endpoint(self):
        http=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        worker=threading.Thread(target=http.serve_forever,daemon=True); worker.start()
        base=f'http://127.0.0.1:{http.server_address[1]}'
        try:
            with urllib.request.urlopen(base+'/') as response:
                self.assertTrue(response.geturl().endswith('/showcase/?warehouse=1'))
                self.assertIn("'unsafe-inline'",response.headers['Content-Security-Policy'])
                self.assertIn('BESS及配套区',response.read().decode('utf-8'))
            with urllib.request.urlopen(base+'/warehouse') as response:
                warehouse_html=response.read().decode('utf-8')
            self.assertIn('智能仓储系统',warehouse_html)
            self.assertIn('href="/showcase/?warehouse=1#overview"',warehouse_html)
            with urllib.request.urlopen(base+'/showcase/?warehouse=1#overview') as response:
                showcase_html=response.read().decode('utf-8')
            self.assertIn('scene-workspace--site',showcase_html)
            self.assertIn('arrival-board--overlay',showcase_html)
            with urllib.request.urlopen(base+'/showcase/assets/css/showcase.css?rev=59') as response:
                showcase_css=response.read().decode('utf-8')
            self.assertIn('@media(min-width:1051px){.arrival-board--overlay',showcase_css)
            self.assertIn('align-items:start',showcase_css)
            self.assertIn('min(22vw,280px)',showcase_css)
            self.assertIn('.scene-workspace--site .arrival-board--overlay{position:static',showcase_css)
            with urllib.request.urlopen(base+'/api/project-arrivals') as response:
                result=json.loads(response.read())
            self.assertEqual(set(result),{'generated_at','items'})
            self.assertEqual(len(result['items']),5)
            with urllib.request.urlopen(base+'/showcase/assets/js/app.js') as response:
                app_js=response.read().decode('utf-8')
            self.assertIn('/api/project-arrivals',app_js)
            self.assertIn('window.addEventListener("baphalane-arrival-focus"',app_js)
            self.assertIn('arrival-summary-caption',app_js)
            with urllib.request.urlopen(base+'/showcase/assets/js/site-interactions.js') as response:
                site_interactions=response.read().decode('utf-8')
            self.assertIn('arrivalFocus(node.userData.arrivalKeys || [], node.userData.title)',site_interactions)
            with urllib.request.urlopen(base+'/showcase/assets/js/site-model.js') as response:
                site_model=response.read().decode('utf-8')
            self.assertIn('["bess-cabinet"]',site_model)
            self.assertIn('["pcs"]',site_model)
            self.assertIn('["main-transformer"]',site_model)
        finally:
            http.shutdown(); http.server_close(); worker.join(timeout=2)


if __name__=='__main__': unittest.main(verbosity=2)
