#!/usr/bin/env python3

import argparse
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

    def tearDown(self):
        sf.DB_PATH = self.original_db
        sf.PORT = self.original_port
        self.temporary.cleanup()

    @staticmethod
    def args(**values):
        defaults = {"db": None, "portable": False, "empty": False, "debug": False,
                    "smoke_test": False}
        defaults.update(values)
        return argparse.Namespace(**defaults)

    def test_explicit_database_path_is_used_directly(self):
        database = self.root / "custom" / "novels.db"
        data_dir, resolved, imported = desktop.resolve_paths(self.args(db=str(database)))
        self.assertEqual(data_dir, database.parent)
        self.assertEqual(resolved, database)
        self.assertIsNone(imported)
        self.assertTrue(database.parent.is_dir())

    def test_first_desktop_run_copies_existing_database(self):
        legacy_dir = self.root / "legacy"
        target_dir = self.root / "desktop-data"
        legacy_dir.mkdir()
        source = legacy_dir / "snowflake.db"
        sf.init_database(str(source))
        sf.create_project("迁移作品")
        with patch.object(desktop, "executable_dir", return_value=legacy_dir), \
                patch.object(desktop, "default_data_dir", return_value=target_dir):
            data_dir, database, imported = desktop.resolve_paths(self.args())
        self.assertEqual(data_dir, target_dir)
        self.assertEqual(imported, source)
        conn = sqlite3.connect(database)
        try:
            self.assertEqual(conn.execute("SELECT name FROM projects").fetchone()[0], "迁移作品")
        finally:
            conn.close()

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
