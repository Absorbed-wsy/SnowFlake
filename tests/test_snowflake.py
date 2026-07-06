#!/usr/bin/env python3

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import snowflake as sf


class TestNotesPath(unittest.TestCase):
    def test_normal_md_file(self):
        path = sf.notes_path("test.md")
        self.assertTrue(path.endswith("test.md"))

    def test_rejects_non_md(self):
        with self.assertRaises(ValueError):
            sf.notes_path("test.txt")

    def test_rejects_hidden(self):
        with self.assertRaises(ValueError):
            sf.notes_path(".hidden.md")

    def test_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            sf.notes_path("../etc/passwd")

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            sf.notes_path("")


class TestHeadingLevel(unittest.TestCase):
    def test_h1(self):
        self.assertEqual(sf.heading_level("# Title"), 1)

    def test_h2(self):
        self.assertEqual(sf.heading_level("## Title"), 2)

    def test_h6(self):
        self.assertEqual(sf.heading_level("###### Title"), 6)

    def test_not_heading(self):
        self.assertEqual(sf.heading_level("plain text"), 0)

    def test_not_heading_hash(self):
        self.assertEqual(sf.heading_level("###not heading"), 0)


class TestFindBlock(unittest.TestCase):
    def test_find_existing_block(self):
        lines = [
            "## 第1步 test",
            "body line 1",
            "body line 2",
            "## 第2步 next",
        ]
        result = sf.find_block(lines, 2, "第1步")
        self.assertIsNotNone(result)
        heading, start, end = result
        self.assertEqual(start, 1)
        self.assertEqual(end, 3)

    def test_no_block_found(self):
        lines = ["## other heading", "content"]
        result = sf.find_block(lines, 2, "第1步")
        self.assertIsNone(result)


class TestParseProgress(unittest.TestCase):
    def test_parse_done(self):
        lines = [
            "## 雪花写作法进度看板",
            "- [x] 第0步",
            "- [ ] 第1步",
            "- [~] 第2步",
        ]
        prog = sf.parse_progress(lines)
        self.assertEqual(prog.get("第0步"), "done")
        self.assertEqual(prog.get("第1步"), "todo")
        self.assertEqual(prog.get("第2步"), "draft")

    def test_empty_progress(self):
        lines = ["## Other section"]
        prog = sf.parse_progress(lines)
        self.assertEqual(prog, {})


class TestSetStatus(unittest.TestCase):
    def test_set_done(self):
        md = "## 雪花写作法进度看板\n- [ ] 第0步\n"
        result = sf.set_status(md, "第0步", "done")
        self.assertIn("[x]", result)
        self.assertNotIn("[ ] 第0步", result)

    def test_set_draft(self):
        md = "## 雪花写作法进度看板\n- [x] 第0步\n"
        result = sf.set_status(md, "第0步", "draft")
        self.assertIn("[~]", result)

    def test_set_todo(self):
        md = "## 雪花写作法进度看板\n- [x] 第0步\n"
        result = sf.set_status(md, "第0步", "todo")
        self.assertIn("[ ]", result)


class TestBuildDoc(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.test_file = os.path.join(self.tmpdir, "test.md")
        with open(self.test_file, "w", encoding="utf-8") as f:
            f.write("# Test Novel\n\n"
                    "## 雪花写作法进度看板\n"
                    "- [x] 第0步\n"
                    "- [ ] 第1步\n\n"
                    "## 第0步 · 核心\n核心内容\n")

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_build_doc_parses_sections(self):
        doc = sf.build_doc(self.test_file)
        self.assertIn("preamble", doc["sections"])
        self.assertIn("step0", doc["sections"])
        self.assertEqual(doc["sections"]["step0"]["exists"], True)
        self.assertIn("核心内容", doc["sections"]["step0"]["body"])

    def test_build_doc_parses_status(self):
        doc = sf.build_doc(self.test_file)
        step0 = next(n for n in doc["nodes"] if n["key"] == "step0")
        self.assertEqual(step0["status"], "done")


class TestHandleSave(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.test_file = os.path.join(self.tmpdir, "test.md")
        with open(self.test_file, "w", encoding="utf-8") as f:
            f.write("# Test Novel\n\n"
                    "## 雪花写作法进度看板\n"
                    "- [ ] 第0步\n\n"
                    "## 第0步 · 核心\n旧内容\n")
        self.orig_mtime = os.path.getmtime(self.test_file)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_save_body(self):
        doc, conflict = sf.handle_save(self.test_file, "step0", "新内容", None)
        self.assertFalse(conflict)
        with open(self.test_file, encoding="utf-8") as f:
            self.assertIn("新内容", f.read())

    def test_save_status(self):
        doc, conflict = sf.handle_save(self.test_file, "step0", None, "done")
        self.assertFalse(conflict)
        with open(self.test_file, encoding="utf-8") as f:
            content = f.read()
        self.assertIn("[x]", content)

    def test_conflict_detection(self):
        import time
        time.sleep(0.1)
        with open(self.test_file, "w", encoding="utf-8") as f:
            f.write("# Modified\n")
        doc, conflict = sf.handle_save(self.test_file, "step0", "new", None,
                                         expected_mtime=self.orig_mtime)
        self.assertTrue(conflict)

    def test_no_conflict_when_mtime_matches(self):
        doc, conflict = sf.handle_save(self.test_file, "step0", "新内容", None,
                                         expected_mtime=self.orig_mtime)
        self.assertFalse(conflict)

    def test_backup_created(self):
        sf.handle_save(self.test_file, "step0", "新内容", None)
        self.assertTrue(os.path.exists(self.test_file + ".bak"))


class TestCreateFile(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.orig_dir = sf.NOTES_DIR
        sf.NOTES_DIR = self.tmpdir

    def tearDown(self):
        sf.NOTES_DIR = self.orig_dir
        shutil.rmtree(self.tmpdir)

    def test_create_new_file(self):
        path = sf.create_file("novel.md")
        self.assertTrue(os.path.exists(path))
        with open(path, encoding="utf-8") as f:
            content = f.read()
        self.assertIn("雪花写作法进度看板", content)

    def test_create_existing_raises(self):
        sf.create_file("novel.md")
        with self.assertRaises(ValueError):
            sf.create_file("novel.md")


class TestReplaceBlock(unittest.TestCase):
    def test_replace_existing_block(self):
        md = "## 第1步 · 一句话概括\n旧内容\n\n## 第2步"
        result = sf.replace_block(md, 2, "第1步", "新内容")
        self.assertIn("新内容", result)
        self.assertNotIn("旧内容", result)

    def test_replace_nonexistent_returns_none(self):
        md = "## other\ncontent"
        result = sf.replace_block(md, 2, "第1步", "new")
        self.assertIsNone(result)


class TestInsertBlock(unittest.TestCase):
    def test_insert_step_block(self):
        md = "## 第2步 · 概括\ncontent\n"
        result = sf.insert_block(md, "step1", "新步骤内容")
        self.assertIn("第1步", result)
        self.assertIn("新步骤内容", result)


class TestListFiles(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.orig_dir = sf.NOTES_DIR
        sf.NOTES_DIR = self.tmpdir

    def tearDown(self):
        sf.NOTES_DIR = self.orig_dir
        shutil.rmtree(self.tmpdir)

    def test_lists_md_files(self):
        open(os.path.join(self.tmpdir, "a.md"), "w").close()
        open(os.path.join(self.tmpdir, "b.md"), "w").close()
        open(os.path.join(self.tmpdir, "c.txt"), "w").close()
        files = sf.list_files()
        names = [f["name"] for f in files]
        self.assertIn("a.md", names)
        self.assertIn("b.md", names)
        self.assertNotIn("c.txt", names)

    def test_excludes_claude_md(self):
        open(os.path.join(self.tmpdir, "CLAUDE.md"), "w").close()
        open(os.path.join(self.tmpdir, "ok.md"), "w").close()
        files = sf.list_files()
        names = [f["name"] for f in files]
        self.assertNotIn("CLAUDE.md", names)

    def test_excludes_readme_md(self):
        open(os.path.join(self.tmpdir, "README.md"), "w").close()
        open(os.path.join(self.tmpdir, "readme.md"), "w").close()
        open(os.path.join(self.tmpdir, "ok.md"), "w").close()
        files = sf.list_files()
        names = [f["name"] for f in files]
        self.assertNotIn("README.md", names)
        self.assertNotIn("readme.md", names)
        self.assertIn("ok.md", names)

    def test_excludes_hidden(self):
        open(os.path.join(self.tmpdir, ".hidden.md"), "w").close()
        files = sf.list_files()
        names = [f["name"] for f in files]
        self.assertNotIn(".hidden.md", names)


class TestCheckAuth(unittest.TestCase):
    def test_no_password_always_ok(self):
        sf.PASSWORD = None
        self.assertTrue(sf.check_auth({}))

    def test_password_auth_requirement(self):
        sf.PASSWORD = "test123"
        self.assertFalse(sf.check_auth({}))
        token = sf._make_session_token()
        self.assertTrue(sf.check_auth({"Cookie": "sf_token=" + token}))
        bad_token = "1234:abcd:invalidsig"
        self.assertFalse(sf.check_auth({"Cookie": "sf_token=" + bad_token}))
        self.assertFalse(sf.check_auth({"Cookie": "sf_token=invalid"}))
        sf.PASSWORD = None


class TestCheckCSRF(unittest.TestCase):
    def test_valid_csrf(self):
        token = sf.CSRF_TOKEN
        self.assertTrue(sf.check_csrf({"X-CSRF-Token": token}))

    def test_invalid_csrf(self):
        self.assertFalse(sf.check_csrf({"X-CSRF-Token": "wrong"}))

    def test_missing_csrf(self):
        self.assertFalse(sf.check_csrf({}))


class TestBuildDocStats(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.test_file = os.path.join(self.tmpdir, "test.md")
        with open(self.test_file, "w", encoding="utf-8") as f:
            f.write("# Test Novel\n\n"
                    "## 雪花写作法进度看板\n"
                    "- [x] 第0步\n"
                    "- [ ] 第1步\n\n"
                    "## 第0步 · 核心\n这是核心内容再说一遍\n")

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_stats_present(self):
        doc = sf.build_doc(self.test_file)
        self.assertIn("stats", doc)

    def test_total_chars(self):
        doc = sf.build_doc(self.test_file)
        self.assertIsInstance(doc["stats"]["total_chars"], int)
        self.assertGreater(doc["stats"]["total_chars"], 0)

    def test_section_counts_step0(self):
        doc = sf.build_doc(self.test_file)
        sc = doc["stats"]["section_counts"]["step0"]
        self.assertEqual(sc["zh_chars"], 10)

    def test_progress(self):
        doc = sf.build_doc(self.test_file)
        self.assertEqual(doc["stats"]["progress"]["done"], 1)
        self.assertEqual(doc["stats"]["progress"]["total"], 11)


class TestSearchNotes(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.orig_dir = sf.NOTES_DIR
        sf.NOTES_DIR = self.tmpdir
        self.test_file = os.path.join(self.tmpdir, "search.md")
        with open(self.test_file, "w", encoding="utf-8") as f:
            f.write("# Search Test\n\n"
                    "## 雪花写作法进度看板\n"
                    "- [ ] 第0步\n\n"
                    "## 第0步 · 核心\n核心矛盾是勇气\n")

    def tearDown(self):
        sf.NOTES_DIR = self.orig_dir
        shutil.rmtree(self.tmpdir)

    def test_search_found(self):
        result = sf.search_notes(self.test_file, "勇气")
        self.assertGreater(len(result["results"]), 0)

    def test_search_not_found(self):
        result = sf.search_notes(self.test_file, "不存在的词xyz")
        self.assertEqual(len(result["results"]), 0)

    def test_search_empty_query(self):
        result = sf.search_notes(self.test_file, "")
        self.assertEqual(len(result["results"]), 0)


class TestFindConfigPath(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def _touch(self, name):
        open(os.path.join(self.tmpdir, name), "w").close()

    def test_finds_snowflake_json(self):
        self._touch("snowflake.json")
        self.assertEqual(sf.find_config_path(self.tmpdir),
                         os.path.join(self.tmpdir, "snowflake.json"))

    def test_falls_back_to_config_json(self):
        self._touch("config.json")
        self.assertEqual(sf.find_config_path(self.tmpdir),
                         os.path.join(self.tmpdir, "config.json"))

    def test_snowflake_json_preferred_over_config_json(self):
        self._touch("snowflake.json")
        self._touch("config.json")
        self.assertEqual(sf.find_config_path(self.tmpdir),
                         os.path.join(self.tmpdir, "snowflake.json"))

    def test_returns_none_when_absent(self):
        self.assertIsNone(sf.find_config_path(self.tmpdir))


class TestLoadConfig(unittest.TestCase):
    def setUp(self):
        self._orig = {
            "NOTES_DIR": sf.NOTES_DIR, "PORT": sf.PORT, "PASSWORD": sf.PASSWORD,
            "BACKUP_DIR": sf.BACKUP_DIR, "BACKUP_REMOTE": sf.BACKUP_REMOTE,
            "BACKUP_PASSWORD": getattr(sf, "BACKUP_PASSWORD", None),
            "NODES": sf.NODES[:], "SECTION_META": dict(sf.SECTION_META),
            "SECTION_KEYS": set(sf.SECTION_KEYS), "KEY_TOK": dict(sf.KEY_TOK),
            "INSERT_HEADING": dict(sf.INSERT_HEADING),
        }
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(sf, k, v)
        shutil.rmtree(self.tmpdir)

    def _write(self, obj):
        path = os.path.join(self.tmpdir, "cfg.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f)
        return path

    def test_none_path_returns_false(self):
        self.assertFalse(sf.load_config(None))

    def test_missing_file_returns_false(self):
        before = len(sf.NODES)
        self.assertFalse(sf.load_config(os.path.join(self.tmpdir, "nope.json")))
        self.assertEqual(len(sf.NODES), before)

    def test_loads_scalar_fields(self):
        path = self._write({"dir": self.tmpdir, "port": 8000, "password": "secret",
                            "backup_dir": self.tmpdir, "backup_remote": "u@h:/p",
                            "backup_password": "sshpass"})
        self.assertTrue(sf.load_config(path))
        self.assertEqual(sf.PORT, 8000)
        self.assertEqual(sf.PASSWORD, "secret")
        self.assertEqual(sf.BACKUP_DIR, self.tmpdir)
        self.assertEqual(sf.BACKUP_REMOTE, "u@h:/p")
        self.assertEqual(sf.BACKUP_PASSWORD, "sshpass")

    def test_dir_resolved_to_absolute(self):
        path = self._write({"dir": "."})
        sf.load_config(path)
        self.assertTrue(os.path.isabs(sf.NOTES_DIR))

    def test_empty_password_becomes_none(self):
        path = self._write({"password": ""})
        sf.load_config(path)
        self.assertIsNone(sf.PASSWORD)

    def test_partial_config_leaves_others_unchanged(self):
        path = self._write({"port": 9000})
        sf.load_config(path)
        self.assertEqual(sf.PORT, 9000)
        self.assertIsNone(sf.PASSWORD)
        self.assertIsNone(sf.BACKUP_REMOTE)

    def test_backward_compat_nodes_only(self):
        path = self._write({"nodes": [
            {"key": "c1", "short": "s", "full": "f", "level": 2, "prefix": "p", "token": "t"}
        ]})
        self.assertTrue(sf.load_config(path))
        self.assertEqual(len(sf.NODES), 1)
        self.assertEqual(sf.NODES[0][0], "c1")


class TestDoBackupRemote(unittest.TestCase):
    def setUp(self):
        self._orig = {"BACKUP_DIR": sf.BACKUP_DIR, "BACKUP_REMOTE": sf.BACKUP_REMOTE,
                      "BACKUP_PASSWORD": getattr(sf, "BACKUP_PASSWORD", None)}
        sf.BACKUP_DIR = None
        sf.BACKUP_REMOTE = None
        sf.BACKUP_PASSWORD = None
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, "x.md")
        open(self.path, "w").close()

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(sf, k, v)
        shutil.rmtree(self.tmpdir)

    def test_build_cmd_without_password_uses_batchmode(self):
        sf.BACKUP_REMOTE = "u@h:/p"
        sf.BACKUP_PASSWORD = None
        cmd, env = sf._build_scp_cmd(self.path)
        self.assertIn("scp", cmd)
        self.assertIn("BatchMode=yes", cmd)
        self.assertNotIn("sshpass", cmd)
        self.assertIsNone(env)
        self.assertIn("StrictHostKeyChecking=accept-new", cmd)
        self.assertEqual(cmd[-2], self.path)
        self.assertEqual(cmd[-1], "u@h:/p")

    def test_build_cmd_with_password_uses_sshpass_env(self):
        sf.BACKUP_REMOTE = "u@h:/p"
        sf.BACKUP_PASSWORD = "secret"
        cmd, env = sf._build_scp_cmd(self.path)
        self.assertEqual(cmd[0], "sshpass")
        self.assertIn("-e", cmd)
        self.assertIn("scp", cmd)
        self.assertNotIn("BatchMode=yes", cmd)
        self.assertEqual(env["SSHPASS"], "secret")
        self.assertIn("StrictHostKeyChecking=accept-new", cmd)

    @patch("snowflake.subprocess.run")
    def test_run_remote_backup_warns_on_nonzero_exit(self, mock_run):
        sf.BACKUP_REMOTE = "u@h:/p"
        mock_run.return_value = Mock(returncode=1, stderr=b"permission denied")
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            sf._run_remote_backup(self.path)
        self.assertIn("远程备份失败", buf.getvalue())
        self.assertIn("permission denied", buf.getvalue())

    @patch("snowflake.subprocess.run")
    def test_run_remote_backup_silent_on_success(self, mock_run):
        sf.BACKUP_REMOTE = "u@h:/p"
        mock_run.return_value = Mock(returncode=0, stderr=b"")
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            sf._run_remote_backup(self.path)
        self.assertEqual(buf.getvalue(), "")

    @patch("snowflake.subprocess.run")
    def test_remote_probe_warns_on_failure(self, mock_run):
        sf.BACKUP_REMOTE = "u@h:/p"
        mock_run.return_value = Mock(returncode=255, stderr=b"connection refused")
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            sf._remote_backup_probe()
        self.assertIn("自检", buf.getvalue())

    @patch("snowflake.shutil.copy2")
    def test_local_backup_skips_when_dest_equals_source(self, mock_copy):
        sf.BACKUP_DIR = self.tmpdir
        sf.BACKUP_REMOTE = None
        sf._do_backup(self.path)
        mock_copy.assert_not_called()


class TestCommandAvailable(unittest.TestCase):
    @patch("snowflake.subprocess.run")
    def test_returns_true_when_command_runs(self, mock_run):
        self.assertTrue(sf._command_available("sshpass"))

    @patch("snowflake.subprocess.run")
    def test_returns_false_when_not_found(self, mock_run):
        mock_run.side_effect = FileNotFoundError
        self.assertFalse(sf._command_available("sshpass"))

    @patch("snowflake.subprocess.run")
    def test_returns_false_on_timeout(self, mock_run):
        mock_run.side_effect = sf.subprocess.TimeoutExpired(cmd="x", timeout=5)
        self.assertFalse(sf._command_available("sshpass"))


class TestHandleSaveRaceCondition(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.test_file = os.path.join(self.tmpdir, "race.md")
        with open(self.test_file, "w", encoding="utf-8") as f:
            f.write("# Race\n\n## 雪花写作法进度看板\n")
            for i in range(0, 11):
                f.write("- [ ] 第%d步\n" % i)
            f.write("\n")

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_concurrent_saves_to_distinct_sections_no_lost_update(self):
        from concurrent.futures import ThreadPoolExecutor
        jobs = [("step%d" % i, "唯一标记-第%d步-正文" % i) for i in range(0, 11)]
        with ThreadPoolExecutor(max_workers=11) as ex:
            list(ex.map(lambda kv: sf.handle_save(self.test_file, kv[0], kv[1], None), jobs))
        with open(self.test_file, encoding="utf-8") as f:
            content = f.read()
        present = sum(1 for i in range(0, 11)
                      if ("唯一标记-第%d步-正文" % i) in content)
        self.assertEqual(present, 11,
                         "并发保存静默丢失了 %d 个小节的内容(RMW 未加锁串行)" % (11 - present))


class TestSendToleratesDisconnect(unittest.TestCase):

    class _FakeConn:
        command = "GET"

        def __init__(self, fail_write=False):
            self._fail = fail_write

        def send_response(self, code):
            pass

        def send_header(self, name, value):
            pass

        def end_headers(self):
            pass

        @property
        def wfile(self):
            fail = self._fail

            class W:
                def write(self, data):
                    if fail:
                        raise BrokenPipeError()

            return W()

    def test_send_swallows_broken_pipe(self):
        conn = self._FakeConn(fail_write=True)
        sf.Handler._send(conn, 200, b'{"mtime": 0}')

    def test_send_normal_write_ok(self):
        conn = self._FakeConn(fail_write=False)
        sf.Handler._send(conn, 200, b'{"mtime": 0}')


class TestVerboseLogging(unittest.TestCase):
    def setUp(self):
        self._orig = getattr(sf, "VERBOSE", False)

    def tearDown(self):
        sf.VERBOSE = self._orig

    def test_silent_by_default(self):
        sf.VERBOSE = False
        with patch("http.server.BaseHTTPRequestHandler.log_message") as m:
            sf.Handler.log_message(object(), "GET /x")
            m.assert_not_called()

    def test_logs_when_verbose(self):
        sf.VERBOSE = True
        with patch("http.server.BaseHTTPRequestHandler.log_message") as m:
            sf.Handler.log_message(object(), "GET /x")
            m.assert_called_once()


class TestStaticDir(unittest.TestCase):

    def test_static_dir_contains_index(self):
        self.assertTrue((sf.STATIC_DIR / "index.html").is_file())


if __name__ == "__main__":
    unittest.main()