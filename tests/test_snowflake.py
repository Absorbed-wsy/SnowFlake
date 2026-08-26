#!/usr/bin/env python3

import base64
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import snowflake as sf


def document(*blocks):
    return {"version": sf.DOCUMENT_VERSION, "blocks": list(blocks)}


class DatabaseTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmpdir, "snowflake.db")
        self.original = (sf.DB_PATH, sf.PORT, sf.PASSWORD_HASH)
        sf.PORT = 10000
        sf.PASSWORD_HASH = None
        sf.init_database(self.db_path)

    def tearDown(self):
        sf.DB_PATH, sf.PORT, sf.PASSWORD_HASH = self.original
        shutil.rmtree(self.tmpdir)

    def create(self, name="测试作品"):
        return sf.create_project(name)


class TestStructuredDocuments(unittest.TestCase):
    def test_normalizes_supported_blocks(self):
        raw = document(
            {"type": "heading", "level": 9, "html": "标题"},
            {"type": "paragraph", "html": "正文<strong>加粗</strong>"},
            {"type": "unordered_list", "items": [{"html": "条目"}]},
            {"type": "table", "header": True, "rows": [["甲", "乙"]]},
            {"type": "divider"},
        )
        result = sf.normalize_document(raw)
        self.assertEqual(result["version"], sf.DOCUMENT_VERSION)
        self.assertEqual(result["blocks"][0]["level"], 6)
        self.assertEqual([item["type"] for item in result["blocks"]],
                         ["heading", "paragraph", "unordered_list", "table", "divider"])

    def test_sanitizes_inline_html(self):
        value = sf.sanitize_inline('<script>alert(1)</script><strong onclick="x">安全</strong>'
                                   '<mark data-color="red">重点</mark><img src=x>')
        self.assertNotIn("script", value)
        self.assertNotIn("onclick", value)
        self.assertNotIn("img", value)
        self.assertIn("<strong>安全</strong>", value)
        self.assertIn('data-color="red"', value)

    def test_rejects_non_structured_document(self):
        for value in ("plain text", [], {"version": sf.DOCUMENT_VERSION}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                sf.normalize_document(value)

    def test_extracts_plain_text(self):
        value = document(
            {"type": "heading", "level": 2, "html": "标题"},
            {"type": "paragraph", "html": "第一行<br><strong>第二行</strong>"},
            {"type": "table", "rows": [["甲", "乙"]]},
        )
        text = sf.document_text(value)
        self.assertIn("标题", text)
        self.assertIn("第一行\n第二行", text)
        self.assertIn("甲 | 乙", text)


class TestProjectNames(unittest.TestCase):
    def test_accepts_plain_name(self):
        self.assertEqual(sf._project_name("从白垩纪末日开始"), "从白垩纪末日开始")

    def test_rejects_empty_hidden_and_paths(self):
        for value in ("", ".hidden", "../novel", "folder/novel"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                sf._project_name(value)


class TestDatabaseSchema(DatabaseTestCase):
    def test_schema_and_integrity(self):
        conn = sqlite3.connect(self.db_path)
        try:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            version = conn.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()[0]
            integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            conn.close()
        required = {"projects", "sections", "section_items", "flow_viewports", "flow_lanes",
                    "flow_nodes", "flow_edges", "settings", "metadata"}
        self.assertTrue(required.issubset(tables))
        self.assertEqual(version, str(sf.SCHEMA_VERSION))
        self.assertEqual(integrity, "ok")

    def test_new_project_has_all_sections(self):
        self.create()
        project = sf.load_project("测试作品")
        self.assertEqual(len(project["sections"]), 12)
        self.assertEqual(len(project["nodes"]), 11)
        self.assertEqual(project["sections"]["step10"]["kind"], "chapters")

    def test_duplicate_project_name_gets_suffix(self):
        self.assertEqual(self.create("作品"), "作品")
        self.assertEqual(self.create("作品"), "作品 (2)")

    def test_lists_projects_sorted(self):
        self.create("乙")
        self.create("甲")
        self.assertEqual([item["name"] for item in sf.list_projects()], ["乙", "甲"])

    def test_renames_project_without_losing_content(self):
        self.create("旧书名")
        sf.save_section("旧书名", "step0", document({"type": "paragraph", "html": "核心设定"}))
        flow = sf.default_flow()
        flow["nodes"] = [{
            "id": "rename-node", "lane": "main", "title": "保留节点", "summary": "", "details": "",
            "type": "event", "status": "idea", "volume": "", "color": "neutral", "linked_section": "",
            "tags": [], "x": 100, "y": 100, "width": 220,
        }]
        sf.save_flow("旧书名", flow)

        self.assertEqual(sf.rename_project("旧书名", "新书名"), "新书名")
        with self.assertRaisesRegex(ValueError, "作品不存在"):
            sf.load_project("旧书名")
        renamed = sf.load_project("新书名")
        self.assertIn("核心设定", sf.document_text(renamed["sections"]["step0"]["document"]))
        self.assertEqual(sf.load_flow("新书名")["flow"]["nodes"][0]["title"], "保留节点")

    def test_rename_rejects_existing_project_name(self):
        self.create("甲")
        self.create("乙")
        with self.assertRaisesRegex(ValueError, "已有同名作品"):
            sf.rename_project("甲", "乙")
        self.assertEqual([item["name"] for item in sf.list_projects()], ["乙", "甲"])

    def test_delete_project_requires_exact_confirmation_name(self):
        self.create("待删除作品")
        with self.assertRaisesRegex(ValueError, "作品名不匹配"):
            sf.delete_project("待删除作品", "待删除作品 ")
        self.assertEqual(sf.load_project("待删除作品")["name"], "待删除作品")

    def test_delete_project_cascades_project_content_only(self):
        self.create("保留作品")
        self.create("待删除作品")
        sf.save_section("待删除作品", "step7", sf.EMPTY_DOCUMENT, None, [
            {"title": "待删除人物", "document": document({"type": "paragraph", "html": "内容"})}
        ])
        flow = sf.default_flow()
        flow["nodes"] = [{
            "id": "delete-node", "lane": "main", "title": "待删除节点", "summary": "", "details": "",
            "type": "event", "status": "idea", "volume": "", "color": "neutral", "linked_section": "",
            "tags": [], "x": 100, "y": 100, "width": 220,
        }]
        sf.save_flow("待删除作品", flow)

        self.assertEqual(sf.delete_project("待删除作品", "待删除作品"), "待删除作品")
        self.assertEqual([item["name"] for item in sf.list_projects()], ["保留作品"])
        with self.assertRaisesRegex(ValueError, "作品不存在"):
            sf.load_project("待删除作品")
        conn = sqlite3.connect(self.db_path)
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM sections WHERE project_id NOT IN "
                                          "(SELECT id FROM projects)").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM flow_nodes").fetchone()[0], 0)
        finally:
            conn.close()

    def test_settings_persist(self):
        sf.set_setting("port", 12345)
        sf.set_setting("password_hash", sf.hash_password("secret"))
        sf.load_runtime_settings()
        self.assertEqual(sf.PORT, 12345)
        self.assertTrue(sf.verify_password("secret", sf.PASSWORD_HASH))
        self.assertNotIn("secret", sf.PASSWORD_HASH)

    def test_migrates_v2_flow_columns_without_losing_rows(self):
        legacy_path = os.path.join(self.tmpdir, "legacy-v2.db")
        conn = sqlite3.connect(legacy_path)
        try:
            conn.executescript("""
                CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                INSERT INTO metadata VALUES('schema_version','2');
                CREATE TABLE flow_viewports(project_id INTEGER PRIMARY KEY,x REAL,y REAL,zoom REAL,updated_at REAL);
                CREATE TABLE flow_lanes(project_id INTEGER,id TEXT,name TEXT,color TEXT,height REAL,position INTEGER,PRIMARY KEY(project_id,id));
                CREATE TABLE flow_nodes(project_id INTEGER,id TEXT,lane_id TEXT,title TEXT,summary TEXT,details TEXT,type TEXT,status TEXT,volume TEXT,color TEXT,linked_section TEXT,tags_json TEXT,x REAL,y REAL,width REAL,PRIMARY KEY(project_id,id));
                CREATE TABLE flow_edges(project_id INTEGER,id TEXT,source_id TEXT,target_id TEXT,type TEXT,label TEXT,color TEXT,PRIMARY KEY(project_id,id));
                INSERT INTO flow_viewports VALUES(7,10,20,1.1,123);
                INSERT INTO flow_lanes VALUES(7,'main','主线','green',520,0);
                INSERT INTO flow_nodes VALUES(7,'n1','main','旧节点','','','event','idea','第一卷','neutral','', '[]',100,80,220);
            """)
            conn.commit()
        finally:
            conn.close()
        try:
            sf.init_database(legacy_path)
            conn = sqlite3.connect(legacy_path)
            columns = {
                "view": {row[1] for row in conn.execute("PRAGMA table_info(flow_viewports)")},
                "lane": {row[1] for row in conn.execute("PRAGMA table_info(flow_lanes)")},
                "node": {row[1] for row in conn.execute("PRAGMA table_info(flow_nodes)")},
            }
            self.assertEqual(conn.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()[0], "3")
            self.assertTrue({"snap_grid", "group_mode"}.issubset(columns["view"]))
            self.assertIn("collapsed", columns["lane"])
            self.assertIn("chapter", columns["node"])
            self.assertEqual(conn.execute("SELECT title FROM flow_nodes WHERE id='n1'").fetchone()[0], "旧节点")
        finally:
            conn.close()
            sf.DB_PATH = self.db_path


class TestSectionStorage(DatabaseTestCase):
    def setUp(self):
        super().setUp()
        self.create()

    def test_saves_and_loads_document(self):
        value = document({"type": "paragraph", "html": "结构化正文<strong>重点</strong>"})
        result, conflict = sf.save_section("测试作品", "step0", value, "done", None, 0)
        self.assertFalse(conflict)
        self.assertEqual(result["sections"]["step0"]["document"]["blocks"][0]["type"], "paragraph")
        self.assertEqual(result["sections"]["step0"]["status"], "done")
        self.assertNotIn("content", result)

    def test_saves_items_as_independent_records(self):
        items = [
            {"title": "陆衍", "document": document({"type": "paragraph", "html": "主角"})},
            {"title": "应星", "document": document({"type": "paragraph", "html": "核心"})},
        ]
        result, _ = sf.save_section("测试作品", "step7", EMPTY := sf.EMPTY_DOCUMENT, "draft", items, 0)
        saved = result["sections"]["step7"]["items"]
        self.assertEqual([item["title"] for item in saved], ["陆衍", "应星"])
        self.assertTrue(all(isinstance(item["id"], int) for item in saved))
        self.assertEqual(result["sections"]["step7"]["status"], "draft")
        self.assertEqual(EMPTY, sf.EMPTY_DOCUMENT)

    def test_saves_chapters(self):
        chapters = [{"title": "第一章", "document": document({"type": "paragraph", "html": "地震"})}]
        result, _ = sf.save_section("测试作品", "step10", sf.EMPTY_DOCUMENT, None, chapters, 0)
        self.assertEqual(result["sections"]["step10"]["items"][0]["title"], "第一章")

    def test_item_identity_survives_edits(self):
        first, _ = sf.save_section(
            "测试作品", "step7", sf.EMPTY_DOCUMENT, None,
            [{"title": "陆衍", "document": document({"type": "paragraph", "html": "主角"})}], 0)
        item = first["sections"]["step7"]["items"][0]
        second, _ = sf.save_section(
            "测试作品", "step7", sf.EMPTY_DOCUMENT, None,
            [{"id": item["id"], "title": "陆衍（更新）", "document": item["document"]}], first["mtime"])
        updated = second["sections"]["step7"]["items"][0]
        self.assertEqual(updated["id"], item["id"])
        self.assertEqual(updated["title"], "陆衍（更新）")

    def test_item_identity_survives_idless_autosaves(self):
        first, _ = sf.save_section(
            "测试作品", "step7", sf.EMPTY_DOCUMENT, None,
            [{"title": "陆衍", "document": document({"type": "paragraph", "html": "初稿"})}], 0)
        item_id = first["sections"]["step7"]["items"][0]["id"]
        second, _ = sf.save_section(
            "测试作品", "step7", sf.EMPTY_DOCUMENT, None,
            [{"title": "陆衍", "document": document({"type": "paragraph", "html": "自动保存"})}],
            first["mtime"])
        self.assertEqual(second["sections"]["step7"]["items"][0]["id"], item_id)

    def test_conflict_detection(self):
        original = sf.project_mtime("测试作品")
        sf.save_section("测试作品", "step0", document({"type": "paragraph", "html": "第一次"}), None, None, original)
        result, conflict = sf.save_section("测试作品", "step0", document({"type": "paragraph", "html": "过期"}), None, None, original)
        self.assertIsNone(result)
        self.assertTrue(conflict)

    def test_concurrent_different_sections_keep_both(self):
        jobs = [("step%d" % index, document({"type": "paragraph", "html": "标记%d" % index}))
                for index in range(6)]
        with ThreadPoolExecutor(max_workers=6) as executor:
            list(executor.map(lambda item: sf.save_section("测试作品", item[0], item[1], None), jobs))
        project = sf.load_project("测试作品")
        for index in range(6):
            self.assertIn("标记%d" % index, sf.document_text(project["sections"]["step%d" % index]["document"]))

    def test_stats_include_documents_and_items(self):
        sf.save_section("测试作品", "step0", document({"type": "paragraph", "html": "正文内容"}), "done")
        sf.save_section("测试作品", "step7", sf.EMPTY_DOCUMENT, None,
                        [{"title": "人物", "document": document({"type": "paragraph", "html": "人物内容"})}])
        project = sf.load_project("测试作品")
        self.assertGreaterEqual(project["stats"]["total_chars"], len("正文内容人物人物内容"))
        self.assertEqual(project["stats"]["progress"]["done"], 1)

    def test_searches_section_and_item_documents(self):
        sf.save_section("测试作品", "step0", document({"type": "paragraph", "html": "远古阴谋"}))
        sf.save_section("测试作品", "step7", sf.EMPTY_DOCUMENT, None,
                        [{"title": "陆衍", "document": document({"type": "paragraph", "html": "遗民血脉"})}])
        self.assertEqual(sf.search_project("测试作品", "远古")["results"][0]["key"], "step0")
        self.assertEqual(sf.search_project("测试作品", "血脉")["results"][0]["title"], "陆衍")


class TestStoryFlow(DatabaseTestCase):
    def setUp(self):
        super().setUp()
        self.create()

    def test_default_flow_is_relationally_stored(self):
        flow = sf.load_flow("测试作品")["flow"]
        self.assertEqual(len(flow["lanes"]), 3)
        conn = sqlite3.connect(self.db_path)
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM flow_lanes").fetchone()[0], 3)
        finally:
            conn.close()

    def test_save_and_load_node_and_edge(self):
        flow = sf.default_flow()
        flow["nodes"] = [
            {"id": "n1", "title": "开始", "lane": "main", "x": 100, "y": 80},
            {"id": "n2", "title": "转折", "lane": "main", "x": 500, "y": 80},
        ]
        flow["edges"] = [{"id": "e1", "from": "n1", "to": "n2", "type": "advance"}]
        result, conflict = sf.save_flow("测试作品", flow)
        self.assertFalse(conflict)
        self.assertEqual(len(result["flow"]["nodes"]), 2)
        self.assertEqual(sf.load_flow("测试作品")["flow"]["edges"][0]["to"], "n2")

    def test_flow_conflict(self):
        first, _ = sf.save_flow("测试作品", sf.default_flow())
        sf.save_flow("测试作品", sf.default_flow())
        result, conflict = sf.save_flow("测试作品", sf.default_flow(), first["mtime"])
        self.assertIsNone(result)
        self.assertTrue(conflict)

    def test_normalizer_drops_orphan_edges_and_clamps_geometry(self):
        flow = sf.default_flow()
        flow["lanes"][0]["height"] = 9000
        flow["nodes"] = [{"id": "n1", "title": "远端", "lane": "main", "x": 32000, "y": 9000}]
        flow["edges"] = [{"id": "e1", "from": "missing", "to": "n1"}]
        result = sf.normalize_flow(flow)
        self.assertEqual(result["lanes"][0]["height"], 1200)
        self.assertEqual(result["nodes"][0]["x"], 32000)
        self.assertEqual(result["edges"], [])

    def test_all_editor_types_round_trip(self):
        flow = sf.default_flow()
        node_types = ["event", "clue", "turn", "crisis", "climax", "foreshadow", "payoff"]
        edge_types = ["advance", "cause", "foreshadow", "conflict", "branch", "merge"]
        flow["nodes"] = [
            {"id": "n%d" % index, "title": node_type, "type": node_type,
             "lane": "main", "x": index * 280, "y": 80}
            for index, node_type in enumerate(node_types)
        ]
        flow["edges"] = [
            {"id": "e%d" % index, "from": "n%d" % index, "to": "n%d" % (index + 1),
             "type": edge_type}
            for index, edge_type in enumerate(edge_types)
        ]
        saved, conflict = sf.save_flow("测试作品", flow)
        self.assertFalse(conflict)
        self.assertEqual([node["type"] for node in saved["flow"]["nodes"]], node_types)
        self.assertEqual([edge["type"] for edge in saved["flow"]["edges"]], edge_types)

    def test_enhanced_view_lane_and_node_properties_round_trip(self):
        flow = sf.default_flow()
        flow["viewport"].update({"snap_grid": False, "group_mode": "chapter"})
        flow["lanes"][0]["collapsed"] = True
        flow["nodes"] = [{
            "id": "enhanced", "title": "章节节点", "lane": "main", "status": "fixed",
            "volume": "第一卷", "chapter": "第三章", "tags": ["主线", "转折"],
            "x": 100, "y": 80, "width": 360,
        }]
        saved, conflict = sf.save_flow("测试作品", flow)
        self.assertFalse(conflict)
        result = saved["flow"]
        self.assertFalse(result["viewport"]["snap_grid"])
        self.assertEqual(result["viewport"]["group_mode"], "chapter")
        self.assertTrue(result["lanes"][0]["collapsed"])
        self.assertEqual(result["nodes"][0]["chapter"], "第三章")
        self.assertEqual(result["nodes"][0]["width"], 360)


class TestDatabaseImport(DatabaseTestCase):
    def test_imports_only_structured_database_and_renames_duplicates(self):
        source_path = os.path.join(self.tmpdir, "source.db")
        target_path = os.path.join(self.tmpdir, "target.db")
        sf.init_database(source_path)
        sf.create_project("同名作品")
        sf.save_section("同名作品", "step0", document({"type": "paragraph", "html": "来自源数据库"}), "done")
        with open(source_path, "rb") as handle:
            encoded = base64.b64encode(handle.read()).decode("ascii")
        sf.init_database(target_path)
        sf.create_project("同名作品")
        names = sf.import_database("source.db", encoded)
        self.assertEqual(names, ["同名作品 (2)"])
        imported = sf.load_project(names[0])
        self.assertIn("来自源数据库", sf.document_text(imported["sections"]["step0"]["document"]))
        self.assertEqual(imported["sections"]["step0"]["status"], "done")

    def test_rejects_non_database(self):
        encoded = base64.b64encode(b"not a database").decode("ascii")
        with self.assertRaises(ValueError):
            sf.import_database("fake.db", encoded)

    def test_rejects_wrong_extension(self):
        encoded = base64.b64encode(b"SQLite format 3\x00garbage").decode("ascii")
        with self.assertRaises(ValueError):
            sf.import_database("fake.txt", encoded)


class TestSecurityAndAssets(unittest.TestCase):
    def test_auth_without_password(self):
        original = sf.PASSWORD_HASH
        sf.PASSWORD_HASH = None
        try:
            self.assertTrue(sf.check_auth({}))
        finally:
            sf.PASSWORD_HASH = original

    def test_password_hash_verification(self):
        encoded = sf.hash_password("correct horse")
        self.assertTrue(sf.verify_password("correct horse", encoded))
        self.assertFalse(sf.verify_password("wrong", encoded))
        self.assertNotIn("correct horse", encoded)

    def test_csrf(self):
        self.assertTrue(sf.check_csrf({"X-CSRF-Token": sf.CSRF_TOKEN}))
        self.assertFalse(sf.check_csrf({}))

    def test_static_assets_exist(self):
        for name in ("index.html", "style.css", "app.js", "flow.css", "flow.js"):
            with self.subTest(name=name):
                self.assertTrue((sf.STATIC_DIR / name).is_file())

    def test_http_logging_respects_verbose_flag(self):
        original = sf.VERBOSE
        try:
            sf.VERBOSE = False
            with patch("http.server.BaseHTTPRequestHandler.log_message") as mocked:
                sf.Handler.log_message(object(), "GET /x")
                mocked.assert_not_called()
            sf.VERBOSE = True
            with patch("http.server.BaseHTTPRequestHandler.log_message") as mocked:
                sf.Handler.log_message(object(), "GET /x")
                mocked.assert_called_once()
        finally:
            sf.VERBOSE = original

    def test_server_refuses_duplicate_port(self):
        first = sf.ExclusiveThreadingHTTPServer(("127.0.0.1", 0), sf.Handler)
        try:
            port = first.server_address[1]
            with self.assertRaises(OSError):
                sf.ExclusiveThreadingHTTPServer(("127.0.0.1", port), sf.Handler)
        finally:
            first.server_close()


if __name__ == "__main__":
    unittest.main()
