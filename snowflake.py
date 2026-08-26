#!/usr/bin/env python3

import argparse
import base64
import datetime
import hashlib
import hmac
import html
import json
import mimetypes
import os
import secrets
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import webbrowser
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


APP_DIR = str(Path(__file__).resolve().parent)
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
STATIC_DIR = RESOURCE_DIR / "static"
DB_PATH = None
PORT = 10000
PASSWORD_HASH = None
VERBOSE = False
DESKTOP_MODE = False
APP_VERSION = "2.2.0"
SCHEMA_VERSION = 3
DOCUMENT_VERSION = 2
CSRF_TOKEN = secrets.token_hex(32)
SESSION_SECRET = secrets.token_hex(32)
SESSION_COOKIE = "sf_token"
WRITE_LOCK = threading.RLock()

FLOW_VERSION = 3
FLOW_DEFAULT_LANE_HEIGHT = 520

SECTION_DEFS = [
    ("preamble", "标题与简介", "document"),
    ("step0", "第0步 · 核心（内核＋基调＋设定）", "document"),
    ("step1", "第1步 · 一句话概括", "document"),
    ("step2", "第2步 · 一段话概括（三幕）", "document"),
    ("step3", "第3步 · 一页纸人物介绍", "document"),
    ("step4", "第4步 · 一页纸大纲", "document"),
    ("step5", "第5步 · 人物大纲", "document"),
    ("step6", "第6步 · 四页大纲", "document"),
    ("step7", "第7步 · 人物宝典", "items"),
    ("step8", "第8步 · 场景清单", "items"),
    ("step9", "第9步 · 场景双模式", "items"),
    ("step10", "第10步 · 写作", "chapters"),
]

STEP_META = {
    key: {"key": key, "short": short, "full": title}
    for (key, title, _kind), short in zip(SECTION_DEFS[1:], [
        "0·核心", "1·一句话", "2·一段话", "3·人物", "4·一页大纲", "5·人物大纲",
        "6·四页大纲", "7·人物宝典", "8·场景清单", "9·场景双模式", "10·写作",
    ])
}

EMPTY_DOCUMENT = {"version": DOCUMENT_VERSION, "blocks": []}


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def _db_connect(path=None, readonly=False):
    target = os.path.abspath(path or DB_PATH or "")
    if not target:
        raise RuntimeError("数据库尚未初始化")
    if readonly:
        conn = sqlite3.connect("file:%s?mode=ro" % target.replace("\\", "/"), uri=True,
                               timeout=10, factory=_ClosingConnection)
    else:
        conn = sqlite3.connect(target, timeout=10, factory=_ClosingConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _db_now(previous=0):
    return max(time.time(), float(previous or 0) + 0.001)


def _create_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('todo','draft','done')),
            kind TEXT NOT NULL CHECK(kind IN ('document','items','chapters')),
            position INTEGER NOT NULL,
            document_json TEXT NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE(project_id,key)
        );
        CREATE TABLE IF NOT EXISTS section_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            position INTEGER NOT NULL,
            document_json TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS flow_viewports (
            project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            x REAL NOT NULL,
            y REAL NOT NULL,
            zoom REAL NOT NULL,
            snap_grid INTEGER NOT NULL DEFAULT 1,
            group_mode TEXT NOT NULL DEFAULT '' CHECK(group_mode IN ('','volume','chapter')),
            updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS flow_lanes (
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            height REAL NOT NULL,
            collapsed INTEGER NOT NULL DEFAULT 0,
            position INTEGER NOT NULL,
            PRIMARY KEY(project_id,id)
        );
        CREATE TABLE IF NOT EXISTS flow_nodes (
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            lane_id TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            details TEXT NOT NULL,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            volume TEXT NOT NULL,
            chapter TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL,
            linked_section TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            width REAL NOT NULL,
            PRIMARY KEY(project_id,id)
        );
        CREATE TABLE IF NOT EXISTS flow_edges (
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            type TEXT NOT NULL,
            label TEXT NOT NULL,
            color TEXT NOT NULL,
            PRIMARY KEY(project_id,id)
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sections_project ON sections(project_id,position);
        CREATE INDEX IF NOT EXISTS idx_items_section ON section_items(section_id,position);
        CREATE INDEX IF NOT EXISTS idx_flow_lanes_project ON flow_lanes(project_id,position);
    """)


def _table_columns(conn, table):
    return {row["name"] for row in conn.execute("PRAGMA table_info(%s)" % table)}


def _migrate_schema(conn, version):
    """Apply small, forward-only migrations while preserving existing projects."""
    current = int(version)
    if current == 2:
        if "snap_grid" not in _table_columns(conn, "flow_viewports"):
            conn.execute("ALTER TABLE flow_viewports ADD COLUMN snap_grid INTEGER NOT NULL DEFAULT 1")
        if "group_mode" not in _table_columns(conn, "flow_viewports"):
            conn.execute("ALTER TABLE flow_viewports ADD COLUMN group_mode TEXT NOT NULL DEFAULT ''")
        if "collapsed" not in _table_columns(conn, "flow_lanes"):
            conn.execute("ALTER TABLE flow_lanes ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0")
        if "chapter" not in _table_columns(conn, "flow_nodes"):
            conn.execute("ALTER TABLE flow_nodes ADD COLUMN chapter TEXT NOT NULL DEFAULT ''")
        current = 3
        conn.execute("UPDATE metadata SET value=? WHERE key='schema_version'", (str(current),))
    if current != SCHEMA_VERSION:
        raise RuntimeError("不支持的数据库版本：%s" % version)


def init_database(path):
    global DB_PATH
    DB_PATH = os.path.abspath(path)
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with _db_connect() as conn:
        conn.execute("PRAGMA journal_mode=DELETE")
        _create_schema(conn)
        row = conn.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
        if row:
            _migrate_schema(conn, row["value"])
        else:
            conn.execute("INSERT INTO metadata(key,value) VALUES('schema_version',?)",
                         (str(SCHEMA_VERSION),))
        conn.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('port',?)", (str(PORT),))
        conn.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('password_hash','')")


def get_setting(key, default=""):
    with _db_connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key, value):
    with WRITE_LOCK, _db_connect() as conn:
        conn.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))


def load_runtime_settings():
    global PORT, PASSWORD_HASH
    try:
        PORT = max(1024, min(65535, int(get_setting("port", PORT))))
    except (TypeError, ValueError):
        PORT = 10000
    PASSWORD_HASH = get_setting("password_hash", "") or None


def hash_password(password):
    password = str(password or "")
    if not password:
        return ""
    iterations = 200000
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256$%d$%s$%s" % (
        iterations,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password, encoded):
    try:
        algorithm, iterations, salt, expected = str(encoded or "").split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", str(password or "").encode("utf-8"),
            base64.b64decode(salt), int(iterations))
        return hmac.compare_digest(base64.b64encode(digest).decode("ascii"), expected)
    except (ValueError, TypeError):
        return False


class _InlineSanitizer(HTMLParser):
    ALLOWED = {"strong", "em", "s", "u", "code", "mark", "br"}
    ALIASES = {"b": "strong", "i": "em", "del": "s", "strike": "s"}
    COLORS = {"yellow", "red", "green", "blue", "purple"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        tag = self.ALIASES.get(tag.lower(), tag.lower())
        if tag not in self.ALLOWED:
            return
        if tag == "br":
            self.parts.append("<br>")
            return
        if tag == "mark":
            color = next((value for name, value in attrs if name == "data-color"), "yellow")
            color = color if color in self.COLORS else "yellow"
            self.parts.append('<mark data-color="%s">' % color)
        else:
            self.parts.append("<%s>" % tag)
        self.stack.append(tag)

    def handle_endtag(self, tag):
        tag = self.ALIASES.get(tag.lower(), tag.lower())
        if tag in self.stack:
            while self.stack:
                open_tag = self.stack.pop()
                self.parts.append("</%s>" % open_tag)
                if open_tag == tag:
                    break

    def handle_data(self, data):
        self.parts.append(html.escape(data, quote=False))

    def get_html(self):
        while self.stack:
            self.parts.append("</%s>" % self.stack.pop())
        return "".join(self.parts)


def sanitize_inline(value, limit=200000):
    parser = _InlineSanitizer()
    parser.feed(str(value or "")[:limit])
    parser.close()
    return parser.get_html()


def normalize_document(value):
    if not isinstance(value, dict):
        raise ValueError("正文必须是结构化文档")
    raw_blocks = value.get("blocks")
    if not isinstance(raw_blocks, list):
        raise ValueError("正文缺少 blocks")
    blocks = []
    for raw in raw_blocks[:2000]:
        if not isinstance(raw, dict):
            continue
        block_type = str(raw.get("type") or "paragraph")
        if block_type in ("paragraph", "quote"):
            blocks.append({"type": block_type, "html": sanitize_inline(raw.get("html"))})
        elif block_type == "heading":
            try:
                level = max(1, min(6, int(raw.get("level", 2))))
            except (TypeError, ValueError):
                level = 2
            blocks.append({"type": "heading", "level": level,
                           "html": sanitize_inline(raw.get("html"))})
        elif block_type in ("unordered_list", "ordered_list"):
            items = []
            for item in raw.get("items", [])[:500] if isinstance(raw.get("items"), list) else []:
                if isinstance(item, dict):
                    clean = {"html": sanitize_inline(item.get("html"))}
                    if "checked" in item:
                        clean["checked"] = bool(item.get("checked"))
                    items.append(clean)
                else:
                    items.append({"html": sanitize_inline(item)})
            blocks.append({"type": block_type, "items": items})
        elif block_type == "table":
            rows = []
            raw_rows = raw.get("rows") if isinstance(raw.get("rows"), list) else []
            for raw_row in raw_rows[:200]:
                if isinstance(raw_row, list):
                    rows.append([sanitize_inline(cell, 20000) for cell in raw_row[:30]])
            width = max((len(row) for row in rows), default=0)
            align = list(raw.get("align") or [])[:width]
            align = [item if item in ("left", "center", "right", "") else "" for item in align]
            while len(align) < width:
                align.append("")
            blocks.append({"type": "table", "header": bool(raw.get("header")),
                           "align": align, "rows": rows})
        elif block_type == "divider":
            blocks.append({"type": "divider"})
    result = {"version": DOCUMENT_VERSION, "blocks": blocks}
    if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > 5 * 1024 * 1024:
        raise ValueError("单个文档不能超过 5MB")
    return result


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.parts.append("\n")


def inline_text(value):
    parser = _TextExtractor()
    parser.feed(str(value or ""))
    return "".join(parser.parts)


def document_text(document):
    lines = []
    for block in normalize_document(document)["blocks"]:
        block_type = block["type"]
        if block_type in ("paragraph", "quote", "heading"):
            lines.append(inline_text(block.get("html")))
        elif block_type in ("unordered_list", "ordered_list"):
            lines.extend(inline_text(item.get("html")) for item in block.get("items", []))
        elif block_type == "table":
            lines.extend(" | ".join(inline_text(cell) for cell in row) for row in block.get("rows", []))
    return "\n".join(line for line in lines if line)


def _project_name(name):
    raw = str(name or "").strip()
    if not raw or raw in (".", "..") or raw.startswith("."):
        raise ValueError("请输入有效作品名")
    if raw != os.path.basename(raw):
        raise ValueError("作品名不能包含路径")
    if len(raw) > 160:
        raise ValueError("作品名过长")
    return raw


def _project_row(name, conn=None):
    key = _project_name(name)
    if conn is not None:
        row = conn.execute("SELECT * FROM projects WHERE name=? COLLATE NOCASE", (key,)).fetchone()
    else:
        with _db_connect() as db:
            row = db.execute("SELECT * FROM projects WHERE name=? COLLATE NOCASE", (key,)).fetchone()
    if not row:
        raise ValueError("作品不存在：%s" % key)
    return row


def _unique_project_name(conn, preferred):
    name = _project_name(preferred)
    base = name
    index = 2
    while conn.execute("SELECT 1 FROM projects WHERE name=? COLLATE NOCASE", (name,)).fetchone():
        name = "%s (%d)" % (base, index)
        index += 1
    return name


def default_flow():
    return {
        "version": FLOW_VERSION,
        "viewport": {"x": 0, "y": 0, "zoom": 1, "snap_grid": True, "group_mode": ""},
        "lanes": [
            {"id": "main", "name": "故事主线", "color": "green", "height": FLOW_DEFAULT_LANE_HEIGHT, "collapsed": False},
            {"id": "mystery", "name": "谜题与伏笔", "color": "purple", "height": FLOW_DEFAULT_LANE_HEIGHT, "collapsed": False},
            {"id": "character", "name": "人物成长", "color": "blue", "height": FLOW_DEFAULT_LANE_HEIGHT, "collapsed": False},
        ],
        "nodes": [],
        "edges": [],
    }


def _flow_text(value, limit):
    return "" if value is None else str(value)[:limit]


def _flow_number(value, default, low, high):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def normalize_flow(data):
    if not isinstance(data, dict):
        raise ValueError("走向图数据必须是对象")
    allowed_colors = {"neutral", "green", "purple", "blue", "yellow", "red"}
    allowed_types = {"event", "clue", "turn", "crisis", "climax", "foreshadow", "payoff"}
    allowed_statuses = {"idea", "draft", "fixed"}
    allowed_edge_types = {"advance", "cause", "foreshadow", "conflict", "branch", "merge"}
    raw_view = data.get("viewport") if isinstance(data.get("viewport"), dict) else {}
    group_mode = _flow_text(raw_view.get("group_mode"), 16)
    result = {
        "version": FLOW_VERSION,
        "viewport": {
            "x": _flow_number(raw_view.get("x"), 0, 0, 10000),
            "y": _flow_number(raw_view.get("y"), 0, 0, 10000),
            "zoom": _flow_number(raw_view.get("zoom"), 1, 0.2, 2.5),
            "snap_grid": bool(raw_view.get("snap_grid", True)),
            "group_mode": group_mode if group_mode in ("", "volume", "chapter") else "",
        },
        "lanes": [], "nodes": [], "edges": [],
    }
    lane_ids = set()
    raw_lanes = data.get("lanes") if isinstance(data.get("lanes"), list) else []
    for raw in raw_lanes[:32]:
        if not isinstance(raw, dict):
            continue
        lane_id = _flow_text(raw.get("id"), 64).strip()
        if not lane_id or lane_id in lane_ids:
            continue
        lane_ids.add(lane_id)
        color = _flow_text(raw.get("color"), 16)
        result["lanes"].append({
            "id": lane_id,
            "name": _flow_text(raw.get("name"), 80).strip() or "未命名剧情线",
            "color": color if color in allowed_colors else "neutral",
            "height": _flow_number(raw.get("height"), FLOW_DEFAULT_LANE_HEIGHT, 280, 1200),
            "collapsed": bool(raw.get("collapsed", False)),
        })
    if not result["lanes"]:
        result["lanes"] = default_flow()["lanes"]
        lane_ids = {lane["id"] for lane in result["lanes"]}
    fallback_lane = result["lanes"][0]["id"]
    node_ids = set()
    raw_nodes = data.get("nodes") if isinstance(data.get("nodes"), list) else []
    for raw in raw_nodes[:1000]:
        if not isinstance(raw, dict):
            continue
        node_id = _flow_text(raw.get("id"), 80).strip()
        if not node_id or node_id in node_ids:
            continue
        node_ids.add(node_id)
        lane = _flow_text(raw.get("lane"), 64)
        color = _flow_text(raw.get("color"), 16)
        node_type = _flow_text(raw.get("type"), 24)
        status = _flow_text(raw.get("status"), 16)
        tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
        result["nodes"].append({
            "id": node_id,
            "title": _flow_text(raw.get("title"), 160).strip() or "未命名节点",
            "summary": _flow_text(raw.get("summary"), 1000),
            "details": _flow_text(raw.get("details"), 20000),
            "type": node_type if node_type in allowed_types else "event",
            "status": status if status in allowed_statuses else "idea",
            "lane": lane if lane in lane_ids else fallback_lane,
            "volume": _flow_text(raw.get("volume"), 100),
            "chapter": _flow_text(raw.get("chapter"), 100),
            "color": color if color in allowed_colors else "neutral",
            "linked_section": _flow_text(raw.get("linked_section"), 40),
            "tags": [_flow_text(tag, 40) for tag in tags[:20] if _flow_text(tag, 40).strip()],
            "x": _flow_number(raw.get("x"), 120, 0, 50000),
            "y": _flow_number(raw.get("y"), 80, 0, 50000),
            "width": _flow_number(raw.get("width"), 220, 180, 420),
        })
    edge_ids = set()
    raw_edges = data.get("edges") if isinstance(data.get("edges"), list) else []
    for raw in raw_edges[:2000]:
        if not isinstance(raw, dict):
            continue
        edge_id = _flow_text(raw.get("id"), 80).strip()
        source = _flow_text(raw.get("from"), 80)
        target = _flow_text(raw.get("to"), 80)
        if not edge_id or edge_id in edge_ids or source not in node_ids or target not in node_ids or source == target:
            continue
        edge_ids.add(edge_id)
        edge_type = _flow_text(raw.get("type"), 24)
        color = _flow_text(raw.get("color"), 16)
        result["edges"].append({
            "id": edge_id, "from": source, "to": target,
            "type": edge_type if edge_type in allowed_edge_types else "advance",
            "label": _flow_text(raw.get("label"), 160),
            "color": color if color in allowed_colors else "neutral",
        })
    return result


def _write_flow(conn, project_id, flow, updated_at):
    normalized = normalize_flow(flow)
    conn.execute("DELETE FROM flow_edges WHERE project_id=?", (project_id,))
    conn.execute("DELETE FROM flow_nodes WHERE project_id=?", (project_id,))
    conn.execute("DELETE FROM flow_lanes WHERE project_id=?", (project_id,))
    conn.execute("DELETE FROM flow_viewports WHERE project_id=?", (project_id,))
    view = normalized["viewport"]
    conn.execute(
        "INSERT INTO flow_viewports(project_id,x,y,zoom,snap_grid,group_mode,updated_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (project_id, view["x"], view["y"], view["zoom"], int(view["snap_grid"]),
         view["group_mode"], updated_at))
    for position, lane in enumerate(normalized["lanes"]):
        conn.execute(
            "INSERT INTO flow_lanes(project_id,id,name,color,height,collapsed,position) "
            "VALUES(?,?,?,?,?,?,?)",
            (project_id, lane["id"], lane["name"], lane["color"], lane["height"],
             int(lane["collapsed"]), position))
    for node in normalized["nodes"]:
        conn.execute(
            "INSERT INTO flow_nodes(project_id,id,lane_id,title,summary,details,type,status,volume,chapter,"
            "color,linked_section,tags_json,x,y,width) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            project_id, node["id"], node["lane"], node["title"], node["summary"], node["details"],
            node["type"], node["status"], node["volume"], node["chapter"], node["color"], node["linked_section"],
            json.dumps(node["tags"], ensure_ascii=False), node["x"], node["y"], node["width"]))
    for edge in normalized["edges"]:
        conn.execute("INSERT INTO flow_edges VALUES(?,?,?,?,?,?,?)", (
            project_id, edge["id"], edge["from"], edge["to"], edge["type"], edge["label"], edge["color"]))
    return normalized


def create_project(name):
    now = _db_now()
    with WRITE_LOCK, _db_connect() as conn:
        key = _unique_project_name(conn, name)
        cur = conn.execute("INSERT INTO projects(name,created_at,updated_at) VALUES(?,?,?)", (key, now, now))
        project_id = cur.lastrowid
        for position, (section_key, title, kind) in enumerate(SECTION_DEFS):
            conn.execute(
                "INSERT INTO sections(project_id,key,title,status,kind,position,document_json,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (project_id, section_key, title, "todo", kind, position,
                 json.dumps(EMPTY_DOCUMENT), now))
        _write_flow(conn, project_id, default_flow(), now)
    return key


def rename_project(name, new_name):
    target_name = _project_name(new_name)
    with WRITE_LOCK, _db_connect() as conn:
        project = _project_row(name, conn)
        if target_name == project["name"]:
            return project["name"]
        duplicate = conn.execute(
            "SELECT 1 FROM projects WHERE name=? COLLATE NOCASE AND id<>?",
            (target_name, project["id"]),
        ).fetchone()
        if duplicate:
            raise ValueError("已有同名作品：%s" % target_name)
        now = _db_now(project["updated_at"])
        conn.execute("UPDATE projects SET name=?,updated_at=? WHERE id=?",
                     (target_name, now, project["id"]))
    return target_name


def delete_project(name, confirmation_name):
    with WRITE_LOCK, _db_connect() as conn:
        project = _project_row(name, conn)
        if str(confirmation_name or "") != project["name"]:
            raise ValueError("输入的作品名不匹配，未执行删除")
        deleted_name = project["name"]
        conn.execute("DELETE FROM projects WHERE id=?", (project["id"],))
    return deleted_name


def list_projects():
    with _db_connect() as conn:
        rows = conn.execute("SELECT name,updated_at FROM projects ORDER BY name COLLATE NOCASE").fetchall()
    return [{"name": row["name"], "mtime": float(row["updated_at"])} for row in rows]


def _load_document(value):
    try:
        return normalize_document(json.loads(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return dict(EMPTY_DOCUMENT)


def load_project(name):
    with _db_connect() as conn:
        project = _project_row(name, conn)
        rows = conn.execute("SELECT * FROM sections WHERE project_id=? ORDER BY position", (project["id"],)).fetchall()
        sections = {}
        total_chars = 0
        for row in rows:
            document = _load_document(row["document_json"])
            text = document_text(document)
            items = []
            item_rows = conn.execute("SELECT * FROM section_items WHERE section_id=? ORDER BY position,id",
                                     (row["id"],)).fetchall()
            for item in item_rows:
                item_document = _load_document(item["document_json"])
                item_text = document_text(item_document)
                total_chars += len(item["title"]) + len(item_text)
                items.append({"id": item["id"], "title": item["title"],
                              "document": item_document, "updated_at": float(item["updated_at"])})
            total_chars += len(text)
            sections[row["key"]] = {
                "key": row["key"], "title": row["title"], "status": row["status"],
                "kind": row["kind"], "document": document, "items": items,
                "updated_at": float(row["updated_at"]), "chars": len(text),
            }
    nodes = []
    for key, meta in STEP_META.items():
        section = sections.get(key, {})
        nodes.append({"key": key, "short": meta["short"], "full": meta["full"],
                      "status": section.get("status", "todo")})
    done = sum(1 for node in nodes if node["status"] == "done")
    draft = sum(1 for node in nodes if node["status"] == "draft")
    mtime = float(project["updated_at"])
    return {
        "name": project["name"], "mtime": mtime,
        "saved_at": datetime.datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "sections": sections, "nodes": nodes,
        "stats": {"total_chars": total_chars,
                  "progress": {"done": done, "draft": draft, "total": len(nodes),
                               "percent": round(done / len(nodes) * 100) if nodes else 0}},
    }


def project_mtime(name):
    try:
        return float(_project_row(name)["updated_at"])
    except ValueError:
        return 0.0


def save_section(name, key, document=None, status=None, items=None, expected_mtime=None):
    valid_keys = {item[0] for item in SECTION_DEFS}
    if key not in valid_keys:
        raise ValueError("无效栏目：%s" % key)
    if status is not None and status not in ("todo", "draft", "done"):
        raise ValueError("无效状态")
    with WRITE_LOCK, _db_connect() as conn:
        project = _project_row(name, conn)
        current_mtime = float(project["updated_at"])
        if expected_mtime is not None and float(expected_mtime or 0) > 0 \
                and current_mtime > float(expected_mtime) + 0.001:
            return None, True
        section = conn.execute("SELECT * FROM sections WHERE project_id=? AND key=?",
                               (project["id"], key)).fetchone()
        if not section:
            raise ValueError("栏目不存在：%s" % key)
        normalized = normalize_document(document) if document is not None else _load_document(section["document_json"])
        new_status = status if status is not None else section["status"]
        new_mtime = _db_now(current_mtime)
        conn.execute("UPDATE sections SET status=?,document_json=?,updated_at=? WHERE id=?",
                     (new_status, json.dumps(normalized, ensure_ascii=False), new_mtime, section["id"]))
        if items is not None:
            if section["kind"] not in ("items", "chapters") or not isinstance(items, list):
                raise ValueError("该栏目不支持条目")
            existing_rows = conn.execute(
                "SELECT id,position FROM section_items WHERE section_id=?", (section["id"],)).fetchall()
            existing = {row["id"] for row in existing_rows}
            existing_by_position = {row["position"]: row["id"] for row in existing_rows}
            retained = set()
            for position, item in enumerate(items[:2000]):
                if not isinstance(item, dict):
                    continue
                title = str(item.get("title") or "未命名条目").strip()[:200]
                item_document = normalize_document(item.get("document") or EMPTY_DOCUMENT)
                try:
                    item_id = int(item.get("id"))
                except (TypeError, ValueError):
                    item_id = None
                if item_id not in existing:
                    item_id = existing_by_position.get(position)
                if item_id in existing and item_id not in retained:
                    conn.execute(
                        "UPDATE section_items SET title=?,position=?,document_json=?,updated_at=? "
                        "WHERE id=? AND section_id=?",
                        (title, position, json.dumps(item_document, ensure_ascii=False), new_mtime,
                         item_id, section["id"]))
                    retained.add(item_id)
                else:
                    cur = conn.execute(
                        "INSERT INTO section_items(section_id,title,position,document_json,created_at,updated_at) "
                        "VALUES(?,?,?,?,?,?)",
                        (section["id"], title, position, json.dumps(item_document, ensure_ascii=False),
                         new_mtime, new_mtime))
                    retained.add(cur.lastrowid)
            stale = existing - retained
            if stale:
                conn.executemany("DELETE FROM section_items WHERE id=? AND section_id=?",
                                 [(item_id, section["id"]) for item_id in stale])
        conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (new_mtime, project["id"]))
    return load_project(name), False


def load_flow(name):
    with _db_connect() as conn:
        project = _project_row(name, conn)
        view = conn.execute("SELECT * FROM flow_viewports WHERE project_id=?", (project["id"],)).fetchone()
        if not view:
            now = _db_now()
            flow = _write_flow(conn, project["id"], default_flow(), now)
            return {"flow": flow, "mtime": now,
                    "saved_at": datetime.datetime.fromtimestamp(now).strftime("%Y-%m-%d %H:%M:%S")}
        lanes = [dict(row) for row in conn.execute(
            "SELECT id,name,color,height,collapsed FROM flow_lanes WHERE project_id=? ORDER BY position", (project["id"],))]
        nodes = []
        for row in conn.execute("SELECT * FROM flow_nodes WHERE project_id=?", (project["id"],)):
            nodes.append({"id": row["id"], "title": row["title"], "summary": row["summary"],
                          "details": row["details"], "type": row["type"], "status": row["status"],
                          "lane": row["lane_id"], "volume": row["volume"], "chapter": row["chapter"],
                          "color": row["color"],
                          "linked_section": row["linked_section"], "tags": json.loads(row["tags_json"]),
                          "x": row["x"], "y": row["y"], "width": row["width"]})
        edges = [{"id": row["id"], "from": row["source_id"], "to": row["target_id"],
                  "type": row["type"], "label": row["label"], "color": row["color"]}
                 for row in conn.execute("SELECT * FROM flow_edges WHERE project_id=?", (project["id"],))]
        flow = normalize_flow({"version": FLOW_VERSION,
                               "viewport": {"x": view["x"], "y": view["y"], "zoom": view["zoom"],
                                            "snap_grid": bool(view["snap_grid"]),
                                            "group_mode": view["group_mode"]},
                               "lanes": lanes, "nodes": nodes, "edges": edges})
        mtime = float(view["updated_at"])
    return {"flow": flow, "mtime": mtime,
            "saved_at": datetime.datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")}


def save_flow(name, flow, expected_mtime=None):
    normalized = normalize_flow(flow)
    with WRITE_LOCK, _db_connect() as conn:
        project = _project_row(name, conn)
        row = conn.execute("SELECT updated_at FROM flow_viewports WHERE project_id=?", (project["id"],)).fetchone()
        current_mtime = float(row["updated_at"]) if row else 0
        if expected_mtime is not None and float(expected_mtime or 0) > 0 \
                and current_mtime > float(expected_mtime) + 0.001:
            return None, True
        new_mtime = _db_now(current_mtime)
        _write_flow(conn, project["id"], normalized, new_mtime)
    return load_flow(name), False


def search_project(name, query):
    needle = str(query or "").strip().lower()
    if not needle:
        return {"results": []}
    project = load_project(name)
    results = []
    for key, section in project["sections"].items():
        sources = [(section["title"], document_text(section["document"]))]
        sources.extend((item["title"], document_text(item["document"])) for item in section["items"])
        for title, text in sources:
            position = text.lower().find(needle)
            if position < 0 and needle not in title.lower():
                continue
            start = max(0, position - 45) if position >= 0 else 0
            snippet = text[start:start + 130].replace("\n", " ")
            results.append({"key": key, "title": title, "snippet": snippet})
            if len(results) >= 100:
                return {"results": results}
    return {"results": results}


def _external_flow(conn, project_id):
    view = conn.execute("SELECT * FROM flow_viewports WHERE project_id=?", (project_id,)).fetchone()
    view_columns = set(view.keys()) if view else set()
    lane_columns = _table_columns(conn, "flow_lanes")
    node_columns = _table_columns(conn, "flow_nodes")
    lanes = [dict(row) for row in conn.execute(
        "SELECT * FROM flow_lanes WHERE project_id=? ORDER BY position", (project_id,))]
    if "collapsed" not in lane_columns:
        for lane in lanes:
            lane["collapsed"] = False
    nodes = []
    for row in conn.execute("SELECT * FROM flow_nodes WHERE project_id=?", (project_id,)):
        nodes.append({"id": row["id"], "title": row["title"], "summary": row["summary"],
                      "details": row["details"], "type": row["type"], "status": row["status"],
                      "lane": row["lane_id"], "volume": row["volume"],
                      "chapter": row["chapter"] if "chapter" in node_columns else "", "color": row["color"],
                      "linked_section": row["linked_section"], "tags": json.loads(row["tags_json"]),
                      "x": row["x"], "y": row["y"], "width": row["width"]})
    edges = [{"id": row["id"], "from": row["source_id"], "to": row["target_id"],
              "type": row["type"], "label": row["label"], "color": row["color"]}
             for row in conn.execute("SELECT * FROM flow_edges WHERE project_id=?", (project_id,))]
    return normalize_flow({"version": FLOW_VERSION,
                           "viewport": {"x": view["x"], "y": view["y"], "zoom": view["zoom"],
                                        "snap_grid": bool(view["snap_grid"]) if "snap_grid" in view_columns else True,
                                        "group_mode": view["group_mode"] if "group_mode" in view_columns else ""}
                           if view else {},
                           "lanes": lanes, "nodes": nodes, "edges": edges})


def import_database(filename, encoded):
    if not str(filename or "").lower().endswith((".db", ".sqlite", ".sqlite3")):
        raise ValueError("请选择 SQLite 数据库文件")
    try:
        payload = base64.b64decode(str(encoded or ""), validate=True)
    except Exception as exc:
        raise ValueError("数据库文件编码无效") from exc
    if len(payload) > 100 * 1024 * 1024:
        raise ValueError("数据库文件不能超过 100MB")
    if not payload.startswith(b"SQLite format 3\x00"):
        raise ValueError("文件不是有效的 SQLite 数据库")
    handle = tempfile.NamedTemporaryFile(prefix="snowflake-import-", suffix=".db", delete=False)
    temp_path = handle.name
    try:
        handle.write(payload)
        handle.close()
        imported = []
        with _db_connect(temp_path, readonly=True) as source:
            if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("导入数据库完整性检查失败")
            version = source.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
            source_version = int(version["value"]) if version else 0
            if source_version not in (2, SCHEMA_VERSION):
                raise ValueError("只能导入 SnowFlake 结构化数据库 v2～v%d" % SCHEMA_VERSION)
            required = {"projects", "sections", "section_items", "flow_viewports", "flow_lanes",
                        "flow_nodes", "flow_edges"}
            tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not required.issubset(tables):
                raise ValueError("数据库缺少 SnowFlake 数据表")
            with WRITE_LOCK, _db_connect() as target:
                for source_project in source.execute("SELECT * FROM projects ORDER BY id"):
                    name = _unique_project_name(target, source_project["name"])
                    now = _db_now()
                    cur = target.execute("INSERT INTO projects(name,created_at,updated_at) VALUES(?,?,?)",
                                         (name, now, now))
                    project_id = cur.lastrowid
                    section_ids = {}
                    source_sections = source.execute(
                        "SELECT * FROM sections WHERE project_id=? ORDER BY position", (source_project["id"],)).fetchall()
                    if {section["key"] for section in source_sections} != {item[0] for item in SECTION_DEFS}:
                        raise ValueError("导入作品缺少完整的雪花设计栏目")
                    for section in source_sections:
                        document = normalize_document(json.loads(section["document_json"]))
                        cur = target.execute(
                            "INSERT INTO sections(project_id,key,title,status,kind,position,document_json,updated_at) "
                            "VALUES(?,?,?,?,?,?,?,?)",
                            (project_id, section["key"], section["title"], section["status"], section["kind"],
                             section["position"], json.dumps(document, ensure_ascii=False), now))
                        section_ids[section["id"]] = cur.lastrowid
                    for old_section_id, new_section_id in section_ids.items():
                        for item in source.execute(
                                "SELECT * FROM section_items WHERE section_id=? ORDER BY position,id",
                                (old_section_id,)):
                            document = normalize_document(json.loads(item["document_json"]))
                            target.execute(
                                "INSERT INTO section_items(section_id,title,position,document_json,created_at,updated_at) "
                                "VALUES(?,?,?,?,?,?)",
                                (new_section_id, item["title"], item["position"],
                                 json.dumps(document, ensure_ascii=False), now, now))
                    _write_flow(target, project_id, _external_flow(source, source_project["id"]), now)
                    imported.append(name)
        return imported
    except sqlite3.DatabaseError as exc:
        raise ValueError("无法读取导入数据库：%s" % exc) from exc
    finally:
        try:
            handle.close()
        except Exception:
            pass
        try:
            os.remove(temp_path)
        except OSError:
            pass


def _make_session_token():
    payload = str(int(time.time())) + ":" + secrets.token_hex(16)
    signature = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return payload + ":" + signature


def _verify_session(headers):
    for part in headers.get("Cookie", "").split(";"):
        part = part.strip()
        if not part.startswith(SESSION_COOKIE + "="):
            continue
        token = part[len(SESSION_COOKIE) + 1:]
        try:
            payload, signature = token.rsplit(":", 1)
            expected = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
            timestamp = int(payload.split(":", 1)[0])
            return hmac.compare_digest(signature, expected) and time.time() - timestamp < 86400 * 7
        except (ValueError, TypeError):
            return False
    return False


def check_auth(headers):
    return not PASSWORD_HASH or _verify_session(headers)


def check_csrf(headers):
    return hmac.compare_digest(headers.get("X-CSRF-Token", ""), CSRF_TOKEN)


def guess_content_type(path):
    return mimetypes.guess_type(str(path))[0] or "application/octet-stream"


class ExclusiveThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def create_http_server(host="127.0.0.1", port=None):
    """Create the HTTP service and publish its actual bound port."""
    global PORT
    requested_port = PORT if port is None else int(port)
    server = ExclusiveThreadingHTTPServer((host, requested_port), Handler)
    PORT = int(server.server_address[1])
    return server


class Handler(BaseHTTPRequestHandler):
    server_version = "SnowFlake/" + APP_VERSION

    def _send(self, status, data=b"", content_type="text/plain; charset=utf-8"):
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store" if "json" in content_type else "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _json(self, status, value):
        self._send(status, json.dumps(value, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _send_file(self, path):
        with open(path, "rb") as handle:
            self._send(200, handle.read(), guess_content_type(path))

    def _project_arg(self):
        query = parse_qs(urlparse(self.path).query)
        return _project_name((query.get("project") or [None])[0])

    def do_GET(self):
        route = urlparse(self.path).path
        public = {"/", "/index.html", "/style.css", "/app.js", "/flow.css", "/flow.js", "/api/config"}
        if PASSWORD_HASH and route not in public and not check_auth(self.headers):
            self._json(401, {"error": "未登录"})
            return
        try:
            if route in ("/", "/index.html"):
                self._send_file(STATIC_DIR / "index.html")
            elif route in ("/style.css", "/app.js", "/flow.css", "/flow.js"):
                self._send_file(STATIC_DIR / route.lstrip("/"))
            elif route == "/api/projects":
                self._json(200, {"projects": list_projects(), "database": DB_PATH})
            elif route == "/api/project":
                self._json(200, load_project(self._project_arg()))
            elif route == "/api/project/mtime":
                self._json(200, {"mtime": project_mtime(self._project_arg())})
            elif route == "/api/flow":
                self._json(200, load_flow(self._project_arg()))
            elif route == "/api/flow/mtime":
                self._json(200, {"mtime": load_flow(self._project_arg())["mtime"]})
            elif route == "/api/config":
                self._json(200, {"csrf_token": CSRF_TOKEN, "auth_required": bool(PASSWORD_HASH),
                                 "storage": "sqlite", "schema_version": SCHEMA_VERSION,
                                 "app_version": APP_VERSION, "desktop": DESKTOP_MODE})
            elif route == "/api/settings":
                self._json(200, {"port": PORT, "password_set": bool(PASSWORD_HASH),
                                 "database": DB_PATH, "desktop": DESKTOP_MODE})
            elif route == "/api/search":
                query = parse_qs(urlparse(self.path).query)
                self._json(200, search_project(self._project_arg(), (query.get("q") or [""])[0]))
            else:
                candidate = (STATIC_DIR / route.lstrip("/")).resolve()
                if candidate.is_file() and os.path.commonpath([str(candidate), str(STATIC_DIR.resolve())]) == str(STATIC_DIR.resolve()):
                    self._send_file(candidate)
                else:
                    self._send(404, b"not found")
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except Exception as exc:
            print("  [错误] %s: %s" % (self.path, exc), flush=True)
            self._json(500, {"error": "服务器内部错误"})

    def do_POST(self):
        global PORT, PASSWORD_HASH
        route = urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except (TypeError, ValueError):
            self._json(400, {"ok": False, "error": "Content-Length 无效"})
            return
        if length < 0:
            self._json(400, {"ok": False, "error": "Content-Length 无效"})
            return
        if length > 150 * 1024 * 1024:
            self._json(413, {"ok": False, "error": "请求内容过大"})
            return
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            data = {}
        if route == "/api/login":
            password = str(data.get("password") or "")
            if PASSWORD_HASH is not None and verify_password(password, PASSWORD_HASH):
                body = json.dumps({"ok": True}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Set-Cookie", SESSION_COOKIE + "=" + _make_session_token()
                                 + "; Path=/; SameSite=Lax; HttpOnly")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self._json(401, {"ok": False, "error": "密码错误"})
            return
        if route == "/api/logout":
            body = json.dumps({"ok": True}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Set-Cookie", SESSION_COOKIE + "=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if PASSWORD_HASH and not check_auth(self.headers):
            self._json(401, {"ok": False, "error": "未登录"})
            return
        if not check_csrf(self.headers):
            self._json(403, {"ok": False, "error": "CSRF token mismatch"})
            return
        try:
            if route == "/api/project/create":
                name = create_project(data.get("name"))
                self._json(200, {"ok": True, "name": name, "projects": list_projects()})
            elif route == "/api/project/rename":
                name = rename_project(data.get("project"), data.get("new_name"))
                self._json(200, {"ok": True, "name": name, "projects": list_projects()})
            elif route == "/api/project/delete":
                name = delete_project(data.get("project"), data.get("confirmation_name"))
                self._json(200, {"ok": True, "name": name, "projects": list_projects()})
            elif route == "/api/project/import-db":
                names = import_database(data.get("filename"), data.get("data"))
                self._json(200, {"ok": True, "names": names, "projects": list_projects()})
            elif route == "/api/section/save":
                result, conflict = save_section(data.get("project"), data.get("key"), data.get("document"),
                                                data.get("status"), data.get("items"), data.get("mtime"))
                if conflict:
                    self._json(409, {"ok": False, "error": "作品已在其他页面更新",
                                     "current_mtime": project_mtime(data.get("project"))})
                else:
                    self._json(200, {"ok": True, "project": result})
            elif route == "/api/settings":
                if DESKTOP_MODE:
                    port = PORT
                    restart_required = False
                else:
                    try:
                        port = int(data.get("port", PORT))
                    except (TypeError, ValueError):
                        raise ValueError("端口必须是数字")
                    if not 1024 <= port <= 65535:
                        raise ValueError("端口范围应为 1024～65535")
                    set_setting("port", port)
                    restart_required = port != PORT
                if "password" in data:
                    password = str(data.get("password") or "")
                    if len(password) > 128:
                        raise ValueError("密码不能超过 128 个字符")
                    PASSWORD_HASH = hash_password(password) or None
                    set_setting("password_hash", PASSWORD_HASH or "")
                self._json(200, {"ok": True, "restart_required": restart_required,
                                 "auth_required": bool(PASSWORD_HASH)})
            elif route == "/api/flow/save":
                result, conflict = save_flow(data.get("project"), data.get("flow"), data.get("mtime"))
                if conflict:
                    self._json(409, {"ok": False, "error": "走向图已在其他页面更新",
                                     "current_mtime": load_flow(data.get("project"))["mtime"]})
                else:
                    self._json(200, {"ok": True, "flow": result["flow"], "mtime": result["mtime"],
                                     "saved_at": result["saved_at"]})
            else:
                self._send(404, b"not found")
        except ValueError as exc:
            self._json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            print("  [错误] %s: %s" % (self.path, exc), flush=True)
            self._json(500, {"ok": False, "error": "服务器内部错误"})

    def log_message(self, fmt, *args):
        if VERBOSE:
            BaseHTTPRequestHandler.log_message(self, fmt, *args)


def lan_ip():
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    global VERBOSE, PORT
    parser = argparse.ArgumentParser(description="雪花写作法本地小说设计工作台")
    parser.add_argument("--db", default=None, help="SQLite 数据库路径（默认：程序目录/snowflake.db）")
    parser.add_argument("--port", type=int, default=None, help="临时覆盖服务端口")
    parser.add_argument("--lan", action="store_true", help="允许局域网设备访问")
    parser.add_argument("-v", "--verbose", action="store_true", help="打印 HTTP 访问日志")
    args = parser.parse_args()
    VERBOSE = args.verbose
    database_path = os.path.abspath(args.db) if args.db else os.path.join(APP_DIR, "snowflake.db")
    init_database(database_path)
    load_runtime_settings()
    if args.port is not None:
        if not 0 <= args.port <= 65535:
            parser.error("端口范围应为 0～65535")
        PORT = args.port
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    server = create_http_server(host, PORT)
    ip = lan_ip()
    print("=" * 56)
    print("  ❋ 雪花写作法工作台已启动")
    print("  版本:   V%s" % APP_VERSION)
    print("  本机:   http://localhost:%d" % PORT)
    if args.lan:
        print("  局域网: http://%s:%d" % (ip, PORT))
    print("  数据库: %s（结构版本 %d）" % (DB_PATH, SCHEMA_VERSION))
    print("  认证: %s" % ("已启用" if PASSWORD_HASH else "无"))
    projects = [item["name"] for item in list_projects()]
    print("  发现 %d 部作品：%s" % (len(projects), "、".join(projects) or "（无）"))
    print("=" * 56)
    try:
        webbrowser.open("http://localhost:%d" % PORT)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
