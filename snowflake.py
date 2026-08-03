#!/usr/bin/env python3

import argparse
import datetime
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import webbrowser
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

def _find_static_dir():
    script_dir = Path(__file__).resolve().parent
    for base in (script_dir, Path(os.getcwd())):
        candidate = base / "static"
        if (candidate / "index.html").is_file():
            return candidate
    return script_dir / "static"


STATIC_DIR = _find_static_dir()

NOTES_DIR = os.getcwd()
PORT = 10000
PASSWORD = None
BACKUP_DIR = None
BACKUP_REMOTE = None
BACKUP_PASSWORD = None
VERBOSE = False
CSRF_TOKEN = secrets.token_hex(32)
SESSION_SECRET = secrets.token_hex(32)
SESSION_COOKIE = "sf_token"

WRITE_LOCK = threading.RLock()

NODES = [
    ("step0", "0·核心",     "第0步：核心（内核＋基调＋设定）",   2, "第0步", "第0步"),
    ("step1", "1·一句话",   "第1步：一句话概括",            2, "第1步", "第1步"),
    ("step2", "2·一段话",   "第2步：一段话概括",            2, "第2步", "第2步"),
    ("step3", "3·人物",     "第3步：一页纸人物介绍",        2, "第3步", "第3步"),
    ("step4", "4·一页大纲", "第4步：一页纸大纲",            2, "第4步", "第4步"),
    ("step5", "5·人物大纲", "第5步：人物大纲",              2, "第5步", "第5步"),
    ("step6", "6·四页大纲", "第6步：四页大纲",              2, "第6步", "第6步"),
    ("step7", "7·人物宝典", "第7步：人物宝典",              2, "第7步", "第7步"),
    ("step8", "8·场景清单", "第8步：场景清单",              2, "第8步", "第8步"),
    ("step9", "9·场景双模式", "第9步：场景双模式",          2, "第9步", "第9步"),
    ("step10", "10·写作", "第10步：写作",              2, "第10步", "第10步"),
]
OTHER = []
INSERT_HEADING = {
    "step0": "## 第0步 · 核心（内核＋基调＋设定）",
    "step1": "## 第1步 · 一句话概括",
    "step2": "## 第2步 · 一段话概括",
    "step3": "## 第3步 · 一页纸人物介绍",
    "step4": "## 第4步 · 一页纸大纲",
    "step5": "## 第5步 · 人物大纲",
    "step6": "## 第6步 · 四页大纲",
    "step7": "## 第7步 · 人物宝典",
    "step8": "## 第8步 · 场景清单",
    "step9": "## 第9步 · 场景双模式",
    "step10": "## 第10步 · 写作",
}
SECTION_META = {n[0]: (n[3], n[4]) for n in NODES}
for _k, _l, _h in OTHER:
    SECTION_META[_k] = (2, _h[3:].strip())
SECTION_KEYS = {"preamble"} | {n[0] for n in NODES}
KEY_TOK = {n[0]: n[5] for n in NODES if n[5]}

TEMPLATE = """# 《[暂名]》创作笔记
> （一句话简介）

## 雪花写作法进度看板
- [ ] **第0步：核心（内核＋基调＋设定）**
- [ ] 第1步：一句话概括
- [ ] 第2步：一段话概括（三幕）
- [ ] 第3步：一页纸人物介绍
- [ ] 第4步：一页纸大纲
- [ ] 第5步：人物大纲
- [ ] 第6步：四页大纲
- [ ] 第7步：人物宝典
- [ ] 第8步：场景清单
- [ ] 第9步：场景双模式
- [ ] 第10步：写作
"""


def find_config_path(base=None):
    base = base or os.getcwd()
    for name in ("snowflake.json", "config.json"):
        p = os.path.join(base, name)
        if os.path.isfile(p):
            return p
    return None


def _set_nodes(custom):
    global NODES, SECTION_META, INSERT_HEADING, KEY_TOK, SECTION_KEYS
    if not custom:
        return False
    result = []
    for n in custom:
        if isinstance(n, (list, tuple)) and len(n) >= 6:
            result.append(tuple(n[:6]))
        elif isinstance(n, dict):
            result.append((
                n.get("key", ""),
                n.get("short", ""),
                n.get("full", ""),
                n.get("level", 2),
                n.get("prefix", ""),
                n.get("token", ""),
            ))
    NODES = result
    SECTION_META = {n[0]: (n[3], n[4]) for n in NODES}
    for _k, _l, _h in OTHER:
        SECTION_META[_k] = (2, _h[3:].strip())
    SECTION_KEYS = {"preamble"} | {n[0] for n in NODES}
    KEY_TOK = {n[0]: n[5] for n in NODES if n[5]}
    INSERT_HEADING.clear()
    for n in NODES:
        INSERT_HEADING[n[0]] = "## " + n[4]
    for _k, _l, _h in OTHER:
        INSERT_HEADING[_k] = _h
    return True


def load_config(config_path):
    global NOTES_DIR, PORT, PASSWORD, BACKUP_DIR, BACKUP_REMOTE, BACKUP_PASSWORD
    if not config_path or not os.path.isfile(config_path):
        return False
    try:
        with open(config_path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return False
    if data.get("dir"):
        NOTES_DIR = os.path.abspath(data["dir"])
    if data.get("port"):
        PORT = data["port"]
    if "password" in data:
        PASSWORD = data["password"] or None
    if data.get("backup_dir"):
        BACKUP_DIR = os.path.abspath(data["backup_dir"])
    if data.get("backup_remote"):
        BACKUP_REMOTE = data["backup_remote"]
    if data.get("backup_password"):
        BACKUP_PASSWORD = data["backup_password"]
    _set_nodes(data.get("nodes", []))
    return True


def notes_path(name):
    name = os.path.basename(name or "")
    if not name.endswith(".md") or name in ("", ".", "..") or name.startswith("."):
        raise ValueError("无效文件名：%r" % name)
    return os.path.join(NOTES_DIR, name)


def list_files():
    out = []
    try:
        names = os.listdir(NOTES_DIR)
    except OSError:
        return out
    for n in sorted(names):
        if not n.endswith(".md") or n.upper() in ("CLAUDE.MD", "README.MD") or n.startswith("."):
            continue
        p = os.path.join(NOTES_DIR, n)
        if os.path.isfile(p):
            try:
                mt = os.path.getmtime(p)
            except OSError:
                mt = 0.0
            out.append({"name": n, "mtime": mt})
    return out


def read_notes(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def file_mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def heading_level(line):
    m = re.match(r"^(#{1,6})\s", line)
    return len(m.group(1)) if m else 0


def find_block(lines, level, prefix):
    hashes = "#" * level
    for i, l in enumerate(lines):
        if l.startswith(hashes + " ") and not l.startswith(hashes + "#"):
            if l[level + 1:].lstrip().startswith(prefix):
                end = len(lines)
                for j in range(i + 1, len(lines)):
                    hl = heading_level(lines[j])
                    if 0 < hl <= level:
                        end = j
                        break
                return l, i + 1, end
    return None


def first_h2_index(lines):
    for i, l in enumerate(lines):
        if heading_level(l) == 2:
            return i
    return len(lines)


def parse_progress(lines):
    out = {}
    blk = find_block(lines, 2, "雪花写作法进度看板")
    if not blk:
        return out
    _, s, e = blk
    for j in range(s, e):
        m = re.match(r"\s*-\s*\[([ xX~])\]\s*(.*)", lines[j])
        if not m:
            continue
        mark = m.group(1)
        st = "done" if mark in ("x", "X") else ("draft" if mark == "~" else "todo")
        text = m.group(2)
        for n in NODES:
            tok = n[5]
            if tok and tok in text:
                out[tok] = st
    return out


def node_status(node, prog):
    return prog.get(node[5], "todo")


def build_doc(path):
    md = read_notes(path)
    lines = md.split("\n")
    h2 = first_h2_index(lines)
    preamble = "\n".join(lines[:h2])
    prog = parse_progress(lines)
    sections = {}

    sections["preamble"] = {"title": "标题与简介",
                            "exists": bool(preamble.strip()),
                            "body": preamble.strip()}
    for key, label, head in OTHER:
        blk = find_block(lines, 2, head[3:].strip())
        if blk:
            sections[key] = {"title": blk[0].lstrip("#").strip(), "exists": True,
                              "body": "\n".join(lines[blk[1]:blk[2]]).strip()}
        else:
            sections[key] = {"title": label, "exists": False, "body": ""}
    for key, _short, full, level, prefix, _tok in NODES:
        blk = find_block(lines, level, prefix)
        if blk:
            sections[key] = {"title": blk[0].lstrip("#").strip(), "exists": True,
                              "body": "\n".join(lines[blk[1]:blk[2]]).strip()}
        else:
            sections[key] = {"title": full, "exists": False, "body": ""}

    nodes = [{"key": n[0], "short": n[1], "full": n[2],
              "status": node_status(n, prog)} for n in NODES]

    total_chars = 0
    total_words_zh = 0
    total_words_en = 0
    section_counts = {}
    for k, sec in sections.items():
        text = (sec.get("body") or "").strip()
        zh = len(re.findall(r'[\u4e00-\u9fff\u3400-\u4dbf]', text))
        en_words = len(re.findall(r'[a-zA-Z]+', text))
        chars = len(text)
        section_counts[k] = {"chars": chars, "zh_chars": zh, "en_words": en_words}
        total_chars += chars
        total_words_zh += zh
        total_words_en += en_words

    done_count = sum(1 for n in nodes if n["status"] == "done")
    draft_count = sum(1 for n in nodes if n["status"] == "draft")
    total_steps = len(nodes)
    progress_pct = round(done_count / total_steps * 100) if total_steps else 0

    return {"sections": sections, "nodes": nodes,
            "mtime": file_mtime(path),
            "saved_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "stats": {"total_chars": total_chars, "total_words_zh": total_words_zh,
                      "total_words_en": total_words_en, "section_counts": section_counts,
                      "progress": {"done": done_count, "draft": draft_count,
                                   "total": total_steps, "percent": progress_pct}}}


def replace_preamble(md, new_preamble):
    lines = md.split("\n")
    h2 = first_h2_index(lines)
    if h2 >= len(lines):
        return new_preamble.rstrip("\n") + "\n"
    rest = "\n".join(lines[h2:])
    return new_preamble.rstrip("\n") + "\n\n" + rest


def replace_block(md, level, prefix, new_body):
    lines = md.split("\n")
    blk = find_block(lines, level, prefix)
    if not blk:
        return None
    _, s, e = blk
    body = new_body.rstrip("\n")
    new_lines = lines[:s] + (body.split("\n") if body else []) + lines[e:]
    return "\n".join(new_lines) + "\n"


def insert_block(md, key, body):
    lines = md.split("\n")
    heading = INSERT_HEADING[key]
    body = body.rstrip("\n")
    block = [heading] + (body.split("\n") if body else [])
    pos = None

    if key.startswith("step"):
        num = int(key[4:])
        for i, l in enumerate(lines):
            hm = re.match(r"^## 第(\d+)步", l)
            if hm and int(hm.group(1)) > num:
                pos = i
                break
    if pos is None:
        out = lines[:]
        while out and out[-1].strip() == "":
            out.pop()
        out.append("")
        out += block
    else:
        out = lines[:pos] + [""] + block + [""] + lines[pos:]
    return "\n".join(out) + "\n"


def set_status(md, tok, status):
    mark = {"done": "x", "draft": "~", "todo": " "}[status]
    lines = md.split("\n")
    blk = find_block(lines, 2, "雪花写作法进度看板")
    if not blk:
        return md
    _, s, e = blk
    for j in range(s, e):
        if re.match(r"\s*-\s*\[[ xX~]\]", lines[j]) and tok in lines[j]:
            lines[j] = re.sub(r"(\s*-\s*\[)[ xX~](\])",
                              lambda m: m.group(1) + mark + m.group(2),
                              lines[j], count=1)
            break
    return "\n".join(lines) + "\n"


def write_notes(path, md):
    with WRITE_LOCK:
        if os.path.exists(path):
            shutil.copy2(path, path + ".bak")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(md)
        os.replace(tmp, path)
    _do_backup(path)


def _build_scp_cmd(path):
    if BACKUP_PASSWORD:
        env = dict(os.environ)
        env["SSHPASS"] = BACKUP_PASSWORD
        cmd = ["sshpass", "-e", "scp", "-q", "-o", "ConnectTimeout=5",
               "-o", "StrictHostKeyChecking=accept-new", path, BACKUP_REMOTE]
    else:
        env = None
        cmd = ["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
               "-o", "StrictHostKeyChecking=accept-new", path, BACKUP_REMOTE]
    return cmd, env


def _run_remote_backup(path):
    cmd, env = _build_scp_cmd(path)
    try:
        result = subprocess.run(cmd, env=env, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, timeout=30)
        if result.returncode != 0:
            err = result.stderr.decode("utf-8", "replace").strip()
            print("  [备份] 远程备份失败(退出码 %d): %s" % (result.returncode, err), flush=True)
    except subprocess.TimeoutExpired:
        print("  [备份] 远程备份超时(>30s)", flush=True)
    except Exception as e:
        print("  [备份] 远程备份失败: %s" % e, flush=True)


def _remote_backup_probe():
    if not BACKUP_REMOTE:
        return
    host = BACKUP_REMOTE.rsplit(":", 1)[0]
    if not host:
        return
    if BACKUP_PASSWORD:
        env = dict(os.environ)
        env["SSHPASS"] = BACKUP_PASSWORD
        cmd = ["sshpass", "-e", "ssh", "-o", "ConnectTimeout=5",
               "-o", "StrictHostKeyChecking=accept-new", host, "true"]
    else:
        env = None
        cmd = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
               "-o", "StrictHostKeyChecking=accept-new", host, "true"]
    try:
        result = subprocess.run(cmd, env=env, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, timeout=15)
        if result.returncode == 0:
            print("  远程备份: 连通性自检通过", flush=True)
        else:
            err = result.stderr.decode("utf-8", "replace").strip()
            print("  [警告] 远程备份自检失败(退出码 %d): %s" % (result.returncode, err), flush=True)
            print("  [警告] 保存时仍会尝试备份, 失败仅打印警告", flush=True)
    except subprocess.TimeoutExpired:
        print("  [警告] 远程备份自检超时", flush=True)
    except Exception as e:
        print("  [警告] 远程备份自检出错: %s" % e, flush=True)


def _do_backup(path):
    if BACKUP_DIR:
        dest = os.path.join(BACKUP_DIR, os.path.basename(path))
        if os.path.abspath(dest) != os.path.abspath(path):
            try:
                os.makedirs(BACKUP_DIR, exist_ok=True)
                shutil.copy2(path, dest)
            except Exception as e:
                print("  [备份] 本地备份失败: %s" % e, flush=True)
    if BACKUP_REMOTE:
        threading.Thread(target=_run_remote_backup, args=(path,), daemon=True).start()


def _command_available(cmd):
    try:
        subprocess.run([cmd, "-V"], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def handle_save(path, key, body, status, expected_mtime=None):
    with WRITE_LOCK:
        current_mtime = file_mtime(path)
        if expected_mtime is not None and expected_mtime > 0 and current_mtime > expected_mtime + 0.001:
            return None, True
        md = read_notes(path)
        if body is not None:
            if key == "preamble":
                md = replace_preamble(md, body)
            elif key in SECTION_META:
                level, prefix = SECTION_META[key]
                new_md = replace_block(md, level, prefix, body)
                if new_md is None:
                    new_md = insert_block(md, key, body)
                md = new_md
            else:
                raise ValueError("bad key: %s" % key)
        if status is not None and key in KEY_TOK:
            md = set_status(md, KEY_TOK[key], status)
        write_notes(path, md)
        return build_doc(path), False


def create_file(name):
    path = notes_path(name)
    if os.path.exists(path):
        raise ValueError("文件已存在：%s" % name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(TEMPLATE)
    _do_backup(path)
    return path


def _make_session_token():
    ts = str(int(datetime.datetime.now().timestamp()))
    payload = ts + ":" + secrets.token_hex(16)
    sig = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return payload + ":" + sig


def _verify_session(headers):
    cookie_header = headers.get("Cookie", "")
    for part in cookie_header.split(";"):
        part = part.strip()
        if part.startswith(SESSION_COOKIE + "="):
            token = part[len(SESSION_COOKIE) + 1:]
            try:
                payload, sig = token.rsplit(":", 1)
                expected_sig = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
                if hmac.compare_digest(sig, expected_sig):
                    ts = payload.split(":")[0]
                    if int(ts) > int(datetime.datetime.now().timestamp()) - 86400:
                        return True
            except Exception:
                pass
    return False


def check_auth(headers):
    if not PASSWORD:
        return True
    return _verify_session(headers)


def check_csrf(headers):
    token = headers.get("X-CSRF-Token", "")
    if not token or not CSRF_TOKEN:
        return False
    return hmac.compare_digest(token, CSRF_TOKEN)


def guess_content_type(path):
    ct, _ = mimetypes.guess_type(path)
    return ct or "application/octet-stream"


def search_notes(path, query):
    doc = build_doc(path)
    results = []
    q_low = query.lower()
    if not q_low:
        return {"results": []}
    for key, sec in doc["sections"].items():
        body = (sec.get("body") or "").strip()
        if not body:
            continue
        lines = body.split("\n")
        for i, line in enumerate(lines):
            if q_low in line.lower():
                start = max(0, i - 1)
                end = min(len(lines), i + 2)
                snippet = "\n".join(lines[start:end])
                results.append({"key": key, "line": i + 1, "snippet": snippet,
                                "title": sec.get("title", key)})
    return {"results": results}


CLIENT_DISCONNECTED = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if body and self.command != "HEAD":
                self.wfile.write(body)
        except CLIENT_DISCONNECTED:
            pass

    def _send_file(self, filepath):
        if not filepath.is_file():
            self._send(404, b"not found")
            return
        ct = guess_content_type(str(filepath))
        if ct.startswith("text/") or ct == "application/javascript":
            ct += "; charset=utf-8"
        with open(filepath, "rb") as f:
            data = f.read()
        try:
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
        except CLIENT_DISCONNECTED:
            pass

    def _file_arg(self):
        q = parse_qs(urlparse(self.path).query)
        name = (q.get("file") or [None])[0]
        return notes_path(name)

    def do_GET(self):
        p = urlparse(self.path).path
        PUBLIC_PATHS = {"/", "/index.html", "/style.css", "/app.js", "/api/config"}
        if PASSWORD and p not in PUBLIC_PATHS and not check_auth(self.headers):
            self._send(401, json.dumps({"error": "未登录"}, ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8")
            return
        try:
            if p in ("/", "/index.html"):
                self._send_file(STATIC_DIR / "index.html")
            elif p == "/style.css":
                self._send_file(STATIC_DIR / "style.css")
            elif p == "/app.js":
                self._send_file(STATIC_DIR / "app.js")
            elif p == "/api/files":
                self._send(200, json.dumps({"files": list_files(), "dir": NOTES_DIR},
                                           ensure_ascii=False).encode("utf-8"),
                           "application/json; charset=utf-8")
            elif p == "/api/doc":
                self._send(200, json.dumps(build_doc(self._file_arg()), ensure_ascii=False).encode("utf-8"),
                           "application/json; charset=utf-8")
            elif p == "/api/mtime":
                self._send(200, json.dumps({"mtime": file_mtime(self._file_arg())}).encode("utf-8"),
                           "application/json; charset=utf-8")
            elif p == "/api/raw":
                self._send(200, read_notes(self._file_arg()).encode("utf-8"),
                           "text/plain; charset=utf-8")
            elif p == "/api/config":
                self._send(200, json.dumps({"csrf_token": CSRF_TOKEN,
                                            "auth_required": bool(PASSWORD)},
                                           ensure_ascii=False).encode("utf-8"),
                           "application/json; charset=utf-8")
            elif p == "/api/export":
                self._send(200, read_notes(self._file_arg()).encode("utf-8"),
                           "text/markdown; charset=utf-8")
            elif p == "/api/search":
                path = self._file_arg()
                q = parse_qs(urlparse(self.path).query)
                query = (q.get("q") or [""])[0]
                if not query:
                    self._send(200, json.dumps({"results": []}, ensure_ascii=False).encode("utf-8"),
                               "application/json; charset=utf-8")
                else:
                    self._send(200, json.dumps(search_notes(path, query),
                                               ensure_ascii=False).encode("utf-8"),
                               "application/json; charset=utf-8")
            else:
                fname = STATIC_DIR / p.lstrip("/")
                if fname.is_file() and str(fname).startswith(str(STATIC_DIR)):
                    self._send_file(fname)
                else:
                    self._send(404, b"not found")
        except ValueError as e:
            self._send(400, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8")
        except Exception as e:
            print("  [错误] %s: %s" % (self.path, e), flush=True)
            self._send(500, json.dumps({"error": "服务器内部错误"}, ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8")

    def do_POST(self):
        p = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            data = {}
        if p == "/api/login":
            pwd = data.get("password", "")
            if PASSWORD is not None and hmac.compare_digest(pwd, PASSWORD):
                token = _make_session_token()
                body = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Set-Cookie", SESSION_COOKIE + "=" + token + "; Path=/; SameSite=Lax; HttpOnly")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            else:
                self._send(401, json.dumps({"ok": False, "error": "密码错误"}, ensure_ascii=False).encode("utf-8"),
                            "application/json; charset=utf-8")
            return
        if p == "/api/logout":
            body = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Set-Cookie", SESSION_COOKIE + "=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if PASSWORD and not check_auth(self.headers):
            self._send(401, json.dumps({"ok": False, "error": "未登录"}, ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8")
            return
        if not check_csrf(self.headers):
            self._send(403, json.dumps({"ok": False, "error": "CSRF token mismatch"},
                                        ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8")
            return
        try:
            if p == "/api/save":
                path = notes_path(data.get("file"))
                key = data.get("key")
                body = data.get("body")
                status = data.get("status")
                expected_mtime = data.get("mtime")
                try:
                    doc_result, conflict = handle_save(path, key, body, status, expected_mtime)
                except ValueError as e:
                    self._send(400, json.dumps({"ok": False, "error": str(e)},
                                               ensure_ascii=False).encode("utf-8"),
                                "application/json; charset=utf-8")
                    return
                if conflict:
                    current_doc = build_doc(path)
                    self.send_response(409)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    body_bytes = json.dumps({
                        "ok": False,
                        "error": "文件已被外部修改，请刷新后重试",
                        "current_mtime": current_doc["mtime"],
                        "nodes": current_doc["nodes"],
                        "saved_at": current_doc["saved_at"],
                    }, ensure_ascii=False).encode("utf-8")
                    self.send_header("Content-Length", str(len(body_bytes)))
                    self.end_headers()
                    self.wfile.write(body_bytes)
                    return
                self._send(200, json.dumps(
                    {"ok": True, "nodes": doc_result["nodes"], "mtime": doc_result["mtime"],
                     "saved_at": doc_result["saved_at"], "stats": doc_result["stats"]}, ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8")
            elif p == "/api/newfile":
                create_file(data.get("name", ""))
                self._send(200, json.dumps({"ok": True, "files": list_files()},
                                           ensure_ascii=False).encode("utf-8"),
                            "application/json; charset=utf-8")
            else:
                self._send(404, b"not found")
        except ValueError as e:
            self._send(400, json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8")
        except Exception as e:
            print("  [错误] %s: %s" % (self.path, e), flush=True)
            self._send(500, json.dumps({"ok": False, "error": "服务器内部错误"}, ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8")

    def log_message(self, fmt, *args):
        if VERBOSE:
            BaseHTTPRequestHandler.log_message(self, fmt, *args)


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    global NOTES_DIR, PORT, PASSWORD, BACKUP_DIR, BACKUP_REMOTE, VERBOSE

    ap = argparse.ArgumentParser(
        description="雪花写作法工作台 —— 可视化编辑雪花法设计文件的本地网页工具")
    ap.add_argument("--config", default=None,
                    help="配置文件路径；不指定则自动查找当前目录下的 snowflake.json / config.json")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="打印 HTTP 访问日志（默认静默，仅打印错误/备份告警）")
    args = ap.parse_args()

    VERBOSE = args.verbose

    if args.config:
        config_path = os.path.abspath(args.config)
        if not os.path.isfile(config_path):
            ap.error("配置文件不存在：%s" % config_path)
    else:
        config_path = find_config_path()
    load_config(config_path)

    if not os.path.isdir(NOTES_DIR):
        ap.error("目录不存在：%s" % NOTES_DIR)

    if BACKUP_DIR:
        try:
            os.makedirs(BACKUP_DIR, exist_ok=True)
        except OSError as e:
            ap.error("备份目录无法创建：%s (%s)" % (BACKUP_DIR, e))

    if BACKUP_REMOTE:
        if not _command_available("scp"):
            ap.error("找不到 scp 命令，请确保系统已安装 OpenSSH 客户端")
        if BACKUP_PASSWORD and not _command_available("sshpass"):
            ap.error("配置了远端备份密码，但找不到 sshpass 命令；请安装 sshpass，或在配置中改用免密登录")
        _remote_backup_probe()

    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    ip = lan_ip()

    auth_info = "  认证: 已启用（密码保护）" if PASSWORD else "  认证: 无（局域网内均可用）"
    sep = "=" * 56
    print(sep)
    print("  \u274b \u96ea\u82b1\u5199\u4f5c\u6cd5\u5de5\u4f5c\u53f0\u5df2\u542f\u52a8")
    print("  \u672c\u673a:   http://localhost:%d" % PORT)
    print("  \u5c40\u57df\u7f51: http://%s:%d" % (ip, PORT))
    print("  \u6587\u4ef6\u76ee\u5f55: %s" % NOTES_DIR)
    print(auth_info)
    if VERBOSE:
        print("  日志: 已开启访问日志（--verbose）")
    files = [f["name"] for f in list_files()]
    print("  发现 %d 个设计文件：%s" % (len(files), "、".join(files) or "（无）"))
    if BACKUP_DIR:
        print("  本地备份: %s" % BACKUP_DIR)
    if BACKUP_REMOTE:
        print("  远程备份: %s" % BACKUP_REMOTE)
    print("  每次保存自动 .bak 备份；Ctrl-C 退出")
    print(sep)

    t = threading.Thread(target=lambda: httpd.serve_forever(), daemon=True)
    t.start()

    try:
        webbrowser.open("http://localhost:%d" % PORT)
    except Exception:
        pass

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n\u518d\u89c1\u3002")
        httpd.shutdown()


if __name__ == "__main__":
    main()