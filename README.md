# ❋ SnowFlake V2.2.4 — 桌面小说设计工作台

一个本地优先的 Windows 桌面创作工具，用雪花写作法设计长篇小说，并用可编辑走向图管理主线、人物线、伏笔和关键节点。桌面版使用独立窗口运行，不会打开外部浏览器，也不需要用户安装 Python。

## 存储架构

`snowflake.db` 是统一数据源，应用版本为 V2.2.4，数据库结构版本为 3。V2 数据库会在首次打开时无损升级。数据库分别保存：

- 作品及更新时间；
- 第0～10步的栏目、状态和排序；
- 人物、场景与章节条目；
- 块式富文本文档；
- 走向图栏目、节点、连线和视角；
- 服务端口与访问密码。

正文以结构化 JSON 块保存，段落、标题、列表、表格、引用和重点标注都是独立数据类型。

## 主要功能

- 在一个 SQLite 数据库中管理多部作品；
- 雪花写作法第0～10步及待办、草案、完成状态；
- 可视化富文本编辑，支持标题、列表、表格、引用和五色标注；
- 人物、场景、章节使用独立条目记录；
- 故事走向图支持节点搜索、标签/状态筛选、小地图、框选多选、批量移动与对齐、网格吸附；
- 走向图支持可折叠分轨、按卷/章节分组、节点宽度调整和自动避障连线；
- 四种界面主题；
- 全文搜索与并发更新检测；
- 桌面版自动使用随机本地端口，并支持访问密码；
- 从另一个 SnowFlake V2.0 SQLite 数据库合并导入作品。

桌面版始终先进入主界面，不会在启动阶段要求选择数据库。默认数据库路径为 EXE 所在目录下的 `snowflake.db`：文件存在就直接使用，不存在也不影响启动，并在首次新建作品时自动创建。

可在“⚙ 应用设置”中修改数据库目录。所选目录中若已有 `snowflake.db`，应用直接原地使用，绝不复制；若不存在，则在该目录首次新建作品时创建。目录配置、窗口状态、日志和 WebView 临时数据均保存在 EXE 所在目录，因此请将完整程序文件夹放在当前用户有写入权限的位置。

## 使用桌面版

构建产物位于：

```text
dist\SnowFlake\SnowFlake.exe
```

复制整个 `dist\SnowFlake` 文件夹到其他位置后，双击 `SnowFlake.exe` 即可使用。Windows 10/11 需要 Microsoft Edge WebView2 Runtime，系统通常已经包含该组件。

桌面版支持以下启动参数：

```text
SnowFlake.exe [--db 数据库路径] [--portable] [--debug]
```

- `--db`：使用指定数据库；
- `--portable`：兼容旧命令，桌面版现在默认即为便携模式；
- `--debug`：启用桌面窗口调试模式。

## 构建桌面版

```powershell
.\build-desktop.ps1
```

脚本会创建独立的 `.venv-desktop` 环境、安装 `requirements-desktop.txt` 中的依赖、生成应用图标并通过 PyInstaller 构建目录版应用。发布包和源代码仓库都不包含任何数据库。

构建脚本默认使用清华 PyPI 镜像；如需使用其他软件源，可以传入 `-IndexUrl`，传入空字符串则使用本机 pip 的默认配置。

## 开发模式

环境要求：Python 3.8+，无需安装第三方包。

```bash
python snowflake.py
```

默认仅监听 `http://localhost:10000`，需通过 `--db` 指定开发模式的数据库路径。

```text
python snowflake.py [--db 数据库路径] [--port 端口] [--lan] [-v]
```

- `--db`：指定 SQLite 数据库路径；
- `--port`：临时覆盖数据库中的服务端口；
- `--lan`：允许局域网设备访问；
- `-v`：显示 HTTP 访问日志。

## 网页使用

- 顶部作品下拉：切换数据库中的作品；
- “改名”：修改当前作品名称，所有设计内容和走向图保持不变；
- “＋ 新建”：创建空白作品及完整雪花步骤；
- “删除”：经过三次确认后删除当前设计文稿，最后一次必须准确输入文稿名称；
- “导入数据库”：选择 `.db`、`.sqlite` 或 `.sqlite3`，合并其中的作品；
- “⚙”：选择数据库目录、查看当前数据库文件并修改服务端口和密码；
- 左侧“故事走向图”：编辑关键节点、分支、分轨和关系。

同名导入作品会自动追加序号。开发模式下端口修改在重启后生效，密码修改立即生效。

## 项目结构

```text
SnowFlake/
├── desktop.py
├── snowflake.py
├── SnowFlake.spec
├── build-desktop.ps1
├── requirements-desktop.txt
├── assets/
│   ├── snowflake.ico
│   └── version_info.txt
├── scripts/
│   └── create_icon.py
├── static/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── flow.css
│   └── flow.js
├── tests/
│   ├── test_desktop.py
│   └── test_snowflake.py
├── README.md
└── LICENSE
```

## 开源协议

MIT，见 `LICENSE`。
