#!/usr/bin/env python3

import argparse
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import desktop
import snowflake as sf


class DummyWindow:
    width = 1440
    height = 900
    x = 120
    y = 80


class TestDesktopHelpers(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.original_db = sf.DB_PATH
        self.original_port = sf.PORT
        self.original_password = sf.PASSWORD_HASH
        self.state_patch = patch.object(desktop, "app_state_dir", return_value=self.root / "app-state")
        self.exe_patch = patch.object(desktop, "executable_dir", return_value=self.root / "application")
        self.state_patch.start()
        self.exe_patch.start()

    def tearDown(self):
        sf.DB_PATH = self.original_db
        sf.PORT = self.original_port
        sf.PASSWORD_HASH = self.original_password
        self.exe_patch.stop()
        self.state_patch.stop()
        self.temporary.cleanup()

    @staticmethod
    def args(**values):
        defaults = {"db": None, "portable": False, "debug": False, "smoke_test": False}
        defaults.update(values)
        return argparse.Namespace(**defaults)

    def test_explicit_database_path_is_used_directly(self):
        database = self.root / "custom" / "novels.db"
        runtime_dir, resolved = desktop.resolve_paths(self.args(db=str(database)))
        self.assertEqual(runtime_dir, self.root / "application")
        self.assertEqual(resolved, database)
        self.assertTrue(database.parent.is_dir())

    def test_first_run_defaults_to_executable_directory_without_creating_database(self):
        runtime_dir, database = desktop.resolve_paths(self.args())
        self.assertEqual(runtime_dir, self.root / "application")
        self.assertEqual(database, runtime_dir / "snowflake.db")
        self.assertFalse(database.exists())

    def test_configured_database_directory_is_reused_when_database_is_missing(self):
        chosen = self.root / "chosen"
        desktop.save_database_directory(chosen)
        runtime_dir, database = desktop.resolve_paths(self.args())
        self.assertEqual(runtime_dir, self.root / "application")
        self.assertEqual(database, chosen / "snowflake.db")
        self.assertFalse(database.exists())

    def test_existing_database_in_selected_directory_is_used_without_copying(self):
        source = self.root / "imported" / "snowflake.db"
        sf.init_database(str(source))
        sf.create_project("导入作品")
        result = desktop.switch_database_directory(source.parent)
        self.assertEqual(Path(result["database"]), source)
        self.assertTrue(result["exists"])
        self.assertFalse((self.root / "application" / "snowflake.db").exists())
        try:
            conn = sqlite3.connect(source)
            self.assertEqual(conn.execute("SELECT name FROM projects").fetchone()[0], "导入作品")
        finally:
            conn.close()

    def test_selecting_empty_directory_does_not_create_database(self):
        selected = self.root / "empty"
        result = desktop.switch_database_directory(selected)
        self.assertFalse(result["exists"])
        self.assertFalse((selected / "snowflake.db").exists())
        self.assertEqual(json.loads(desktop.database_state_path().read_text(encoding="utf-8"))[
            "database_directory"], str(selected.resolve()))

    def test_database_is_created_lazily_by_first_project(self):
        database = self.root / "lazy" / "snowflake.db"
        sf.configure_database(str(database))
        self.assertEqual(sf.list_projects(), [])
        self.assertFalse(database.exists())
        sf.create_project("首个作品")
        self.assertTrue(database.is_file())
        self.assertEqual(sf.list_projects()[0]["name"], "首个作品")

    def test_database_header_validation(self):
        invalid = self.root / "invalid.db"
        invalid.write_text("not a database", encoding="utf-8")
        self.assertFalse(desktop.is_sqlite_database(invalid))

    def test_window_state_round_trip_and_bounds(self):
        state_path = self.root / "window.json"
        desktop.save_window_state(state_path, DummyWindow())
        self.assertEqual(desktop.load_window_state(state_path),
                         {"width": 1440, "height": 900, "x": 120, "y": 80})
        state_path.write_text('{"width":10,"height":99999}', encoding="utf-8")
        bounded = desktop.load_window_state(state_path)
        self.assertEqual(bounded["width"], 900)
        self.assertEqual(bounded["height"], 2160)

    def test_http_server_uses_random_loopback_port(self):
        server = sf.create_http_server("127.0.0.1", 0)
        try:
            self.assertEqual(server.server_address[0], "127.0.0.1")
            self.assertGreater(sf.PORT, 0)
        finally:
            server.server_close()


if __name__ == "__main__":
    unittest.main()
