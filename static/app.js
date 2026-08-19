(function(){
"use strict";

var ICON = {done:"✓", draft:"◔", todo:"○"};
var STATUS_TXT = {done:"已完成", draft:"草案", todo:"待办"};
var STXT = {todo:"待办", draft:"草案", done:"完成"};
var STEP_KEYS = ["step0","step1","step2","step3","step4","step5","step6","step7","step8","step9","step10"];
var SUPPORTS_STATUS = new Set(STEP_KEYS);
var ITEM_KEYS = new Set(["step7","step8","step9"]);
var WRITING_KEY = "step10";
var THEMES = ["light","dark","green","sepia"];
var THEME_LABELS = {light:"\u6d45\u8272", dark:"\u6df1\u8272", green:"\u62a4\u773c\u7eff", sepia:"\u62a4\u773c\u9ec4"};
var THEME_ICONS = {light:"\u2600\ufe0f", dark:"\ud83c\udf19", green:"\ud83c\udf31", sepia:"\ud83d\udc24"};

var ITEM_LABELS = {
  step7: "人物",
  step8: "场景",
  step9: "场景"
};

var doc = null, currentKey = "preamble", editMode = false, dirty = false, knownMtime = 0, currentFile = "";
var csrfToken = "";
var PASSWORD_REQUIRED = false;
var AUTOSAVE_INTERVAL = 30000;
var autosaveTimer = null;
var pollTimer = null;
var editingChapter = null;
var chapterData = [];
var itemData = [];

function escapeHtml(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function postJson(url, data){
  var headers = {"Content-Type":"application/json"};
  if(csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return fetch(url, {method:"POST", headers:headers, body:JSON.stringify(data)}).then(function(r){
    if(r.status === 401 && PASSWORD_REQUIRED){
      showLogin();
      return Promise.reject(new Error("未登录"));
    }
    return r;
  });
}

function authFetch(url, options){
  return fetch(url, options).then(function(r){
    if(r.status === 401 && PASSWORD_REQUIRED){
      showLogin();
      return Promise.reject(new Error("未登录"));
    }
    return r;
  });
}

function authFetchJson(url){
  return fetch(url).then(function(r){
    if(r.status === 401 && PASSWORD_REQUIRED){
      showLogin();
      return Promise.reject(new Error("未登录"));
    }
    return r.json();
  });
}

function showLogin(){
  var ls = document.getElementById("login-screen");
  var am = document.getElementById("app-main");
  if(ls) ls.style.display = "";
  if(am) am.style.display = "none";
}

function migrateStoragePrefix(){
  ["file", "theme"].forEach(function(k){
    var nk = "sf_" + k, ok = "xuh_" + k;
    if(localStorage.getItem(nk) === null){
      var old = localStorage.getItem(ok);
      if(old !== null){
        localStorage.setItem(nk, old);
        localStorage.removeItem(ok);
      }
    } else {
      localStorage.removeItem(ok);
    }
  });
}

function showApp(){
  var ls = document.getElementById("login-screen");
  var am = document.getElementById("app-main");
  if(ls) ls.style.display = "none";
  if(am) am.style.display = "";
}

var loginInProgress = false;
window.doLogin = async function(){
  if(loginInProgress) return;
  var pwd = document.getElementById("login-password").value;
  var errEl = document.getElementById("login-error");
  var btn = document.getElementById("login-btn");
  errEl.textContent = "";
  btn.disabled = true;
  loginInProgress = true;
  try{
    var res = await fetch("/api/login", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({password:pwd})
    });
    if(res.ok){
      csrfToken = "";
      try{ var cfg = await fetch("/api/config"); csrfToken = (await cfg.json()).csrf_token||""; }catch(e){}
      showApp();
      await loadApp();
      document.addEventListener("keydown", onKeydown);
    } else {
      var d = await res.json();
      errEl.textContent = d.error || "密码错误";
      document.getElementById("login-password").value = "";
      document.getElementById("login-password").focus();
    }
  }catch(e){
    errEl.textContent = "连接失败";
  }
  btn.disabled = false;
  loginInProgress = false;
};

window.doLock = async function(){
  try{ await fetch("/api/logout",{method:"POST"}); }catch(e){}
  csrfToken = "";
  if(autosaveTimer){ clearInterval(autosaveTimer); autosaveTimer = null; }
  if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
  currentFile = "";
  currentKey = "preamble";
  doc = null;
  editMode = false;
  dirty = false;
  knownMtime = 0;
  editingChapter = null;
  chapterData = [];
  itemData = [];
  showLogin();
  document.getElementById("login-password").value = "";
  document.getElementById("login-password").focus();
};

async function loadApp(){
  var fl = await authFetchJson("/api/files");
  populatePicker(fl.files || []);
  var last = localStorage.getItem("sf_file");
  var found = (fl.files||[]).find(function(f){return f.name===last});
  currentFile = (found && found.name) || (fl.files&&fl.files[0]&&fl.files[0].name) || "";
  document.getElementById("file-picker").value = currentFile;
  if(currentFile){
    await loadDoc();
    pollTimer = setInterval(poll, 2500);
    startAutosave();
  } else {
    document.getElementById("content").innerHTML = '<div class="card"><div class="empty"><div class="big">\u270e</div><div class="t">\u8fd8\u6ca1\u6709\u8bbe\u8ba1\u6587\u4ef6</div><div class="s">\u70b9\u9876\u90e8\u300c\uff0b \u65b0\u5efa\u300d\u521b\u5efa\u7b2c\u4e00\u672c</div></div></div>';
  }
}

async function init(){
  migrateStoragePrefix();
  document.getElementById("menu-btn").addEventListener("click", toggleSidebar);
  document.getElementById("sidebar-backdrop").addEventListener("click", closeSidebar);
  document.getElementById("file-picker").addEventListener("change", onPickFile);
  initTheme();
  var authRequired = false;
  try{
    var cfg = await authFetchJson("/api/config");
    csrfToken = cfg.csrf_token || "";
    PASSWORD_REQUIRED = !!cfg.auth_required;
    authRequired = PASSWORD_REQUIRED;
  }catch(e){}
  if(authRequired){
    document.getElementById("lock-btn").style.display = "";
    var sess = await fetch("/api/files");
    if(sess.ok){
      showApp();
      await loadApp();
      document.addEventListener("keydown", onKeydown);
    } else {
      showLogin();
    }
    return;
  }
  document.getElementById("lock-btn").style.display = "none";
  showApp();
  await loadApp();
  document.addEventListener("keydown", onKeydown);
}

function parseItems(body){
  var items = [];
  var lines = body.split("\n");
  var cur = null;
  for(var i = 0; i < lines.length; i++){
    var m = /^###\s*(.*)$/.exec(lines[i]);
    if(m){
      if(cur) items.push(cur);
      cur = {title: m[1], body: ""};
    } else if(cur){
      cur.body += (cur.body ? "\n" : "") + lines[i];
    }
  }
  if(cur) items.push(cur);
  return items;
}

function buildItemsBody(items){
  var parts = [];
  for(var i = 0; i < items.length; i++){
    var t = (items[i].title || "").trim() || "\u672a\u547d\u540d";
    var b = (items[i].body || "").trim();
    parts.push("### " + t);
    if(b) parts.push(b);
  }
  return parts.join("\n");
}

function initTheme(){
  var saved = localStorage.getItem("sf_theme");
  if(saved && THEMES.indexOf(saved) >= 0){
    applyTheme(saved);
  } else if(window.matchMedia && window.matchMedia("(prefers-color-scheme:dark)").matches){
    applyTheme("dark");
    localStorage.setItem("sf_theme","dark");
  } else {
    applyTheme("green");
    localStorage.setItem("sf_theme","green");
  }
}

function applyTheme(name){
  document.documentElement.removeAttribute("data-theme");
  if(name !== "light") document.documentElement.setAttribute("data-theme", name);
  var btn = document.getElementById("theme-toggle");
  if(btn){
    btn.textContent = THEME_ICONS[name] || "\ud83c\udf19";
    btn.title = "切换主题（当前："+(THEME_LABELS[name]||"浅色")+"）";
    btn.setAttribute("aria-label", btn.title);
  }
}

function toggleTheme(){
  var current = localStorage.getItem("sf_theme") || "light";
  var idx = THEMES.indexOf(current);
  if(idx < 0) idx = 0;
  var next = THEMES[(idx + 1) % THEMES.length];
  localStorage.setItem("sf_theme", next);
  applyTheme(next);
  toast(THEME_LABELS[next]);
}

function toggleSidebar(){
  var sb = document.getElementById("sidebar");
  var bd = document.getElementById("sidebar-backdrop");
  sb.classList.toggle("open");
  bd.classList.toggle("show");
}

function closeSidebar(){
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebar-backdrop").classList.remove("show");
}

function populatePicker(files){
  var sel = document.getElementById("file-picker");
  sel.innerHTML = files.map(function(f){return '<option value="'+escapeHtml(f.name)+'">'+escapeHtml(f.name)+'</option>'}).join("");
}

function onPickFile(){
  if(editMode && dirty && !confirm("\u6709\u672a\u4fdd\u5b58\u7684\u4fee\u6539\uff0c\u5207\u6362\u6587\u4ef6\u5c06\u4e22\u5f03\uff0c\u786e\u5b9a\uff1f")){
    document.getElementById("file-picker").value = currentFile;
    return;
  }
  currentFile = document.getElementById("file-picker").value;
  localStorage.setItem("sf_file", currentFile);
  editMode = false; dirty = false;
  loadDoc();
}

async function newFile(){
  var name = prompt("\u65b0\u5efa\u8bbe\u8ba1\u6587\u4ef6\u540d\uff08\u53ef\u4e0d\u542b .md\uff09\uff1a");
  if(!name) return;
  name = name.trim();
  if(!name.endsWith(".md")) name = name + ".md";
  var r = await postJson("/api/newfile", {name:name});
  var j = await r.json();
  if(j.ok){
    populatePicker(j.files);
    currentFile = name;
    localStorage.setItem("sf_file", name);
    document.getElementById("file-picker").value = name;
    editMode = false; dirty = false;
    await loadDoc();
    toast("\u5df2\u521b\u5efa "+name);
  } else {
    toast("\u521b\u5efa\u5931\u8d25\uff1a"+(j.error||""), true);
  }
}

async function loadDoc(){
  try{
    doc = await authFetchJson("/api/doc?file="+encodeURIComponent(currentFile));
  }catch(e){ toast("\u52a0\u8f7d\u5931\u8d25", true); return; }
  knownMtime = doc.mtime || 0;
  setSaved(doc.saved_at);
  updateProgress();
  renderSidebar(); renderTimeline(); select(currentKey);
}

function setSaved(t){
  document.getElementById("saved-tag").textContent = t ? ("\u5df2\u4fdd\u5b58 " + t) : "";
}

function updateProgress(){
  if(!doc || !doc.stats) return;
  var p = doc.stats.progress;
  var fill = document.getElementById("progress-fill");
  var pct = document.getElementById("progress-pct");
  if(fill && pct){
    fill.style.width = p.percent + "%";
    pct.textContent = p.percent + "%";
  }
  var gs = document.getElementById("global-stats");
  if(gs){
    var s = doc.stats;
    var progress = s.progress || {};
    gs.innerHTML = '<span class="gs-item"><span class="gs-label">全文字符</span><span class="gs-val">'+s.total_chars+'</span></span>'
      + '<span class="gs-item"><span class="gs-label">已完成</span><span class="gs-val">'+(progress.done||0)+'/'+(progress.total||0)+'</span></span>';
  }
}

function renderSidebar(){
  var sb = document.getElementById("sidebar");
  var progress = (doc.stats && doc.stats.progress) || {};
  var h = '<div class="sidebar-summary"><span>创作进度</span><strong>'+ (progress.done||0) +' / '+ (progress.total||0) +'</strong></div>';
  h += '<div class="grp">\u57fa\u7840</div>';
  h += sideItem("preamble","\u6807\u9898\u4e0e\u7b80\u4ecb");
  h += '<div class="grp">\u96ea\u82b1\u6b65\u9aa4</div>';
  STEP_KEYS.forEach(function(k){
    var n = doc.nodes.find(function(x){return x.key===k});
    h += '<a data-key="'+k+'" class="'+(k===currentKey?'active':'')+'"><span>'+escapeHtml(n?n.short:k)+'</span><span class="st '+(n?n.status:'todo')+'">'+ICON[n?n.status:'todo']+'</span></a>';
  });
  sb.innerHTML = h;
  sb.querySelectorAll("a").forEach(function(a){a.onclick=function(){select(a.dataset.key); closeSidebar();}});
}

function sideItem(key, label){
  return '<a data-key="'+key+'" class="'+(key===currentKey?'active':'')+'"><span>'+escapeHtml(label)+'</span></a>';
}

function renderTimeline(){
  var tl = document.getElementById("timeline");
  var h = '';
  doc.nodes.forEach(function(n, i){
    if(i===0) h += '<div class="tl-phase"><span class="tl-phase-label">创作路径</span></div>';
    h += '<div class="node '+n.status+' '+(n.key===currentKey?'active':'')+'" data-key="'+n.key+'" title="'+escapeHtml(n.full)+'"><span class="dot"></span><span class="lbl">'+escapeHtml(n.short)+'</span></div>';
    if(i < doc.nodes.length-1) h += '<span class="arrow '+(i===0?'grow':'')+'">\u203a</span>';
  });
  tl.innerHTML = h;
  tl.querySelectorAll(".node").forEach(function(el){el.onclick=function(){select(el.dataset.key);}});
}

function select(key){
  if(editMode && dirty && !confirm("\u6709\u672a\u4fdd\u5b58\u7684\u4fee\u6539\uff0c\u653e\u5f03\uff1f")) return;
  currentKey = key; editMode = false; dirty = false; editingChapter = null; chapterData = []; itemData = [];
  renderSidebar(); renderTimeline(); renderContent();
}

function renderContent(){
  var c = document.getElementById("content");
  var sec = doc.sections[currentKey];
  var node = doc.nodes.find(function(n){return n.key===currentKey});
  var status = node ? node.status : null;
  var isItemSection = ITEM_KEYS.has(currentKey);

  var head = '<div class="card"><div class="sec-head">'
    + '<h2>'+escapeHtml(sec.title)+'</h2>'
    + (status ? '<span id="status-badge" class="badge '+status+'" title="\u624b\u52a8\u4e09\u6001\uff1a\u5b8c\u6210 / \u8349\u6848 / \u5f85\u529e">'+ICON[status]+' '+STATUS_TXT[status]+'</span>' : "")
    + '<div class="sec-actions">';
  if(SUPPORTS_STATUS.has(currentKey)){
    var st = status || "todo";
    head += '<div class="tri" id="tri">'
      + ["todo","draft","done"].map(function(s){
          return '<button class="seg '+s+(st===s?' active':'')+'" data-st="'+s+'" onclick="onStatus(\''+s+'\')">'+STXT[s]+'</button>';
        }).join("")
      + '</div>';
  }
  if(!editMode){
    head += '<button onclick="enterEdit()">'+(sec.exists?'\u7f16\u8f91':'\u5f00\u59cb\u64b0\u5199')+'</button>';
    head += '<button class="ghost" onclick="downloadRaw()">\u5bfc\u51fa\u672c\u8282</button>';
  } else {
    head += '<button class="primary" onclick="save()">\u4fdd\u5b58 <span class="kbd">Ctrl+S</span></button>';
    head += '<button class="ghost" onclick="cancelEdit()">\u53d6\u6d88 <span class="kbd">Esc</span></button>';
  }
  head += '</div></div><div id="body-area"></div></div>';
  c.innerHTML = head;
  renderBody();
}

function renderBody(){
  var area = document.getElementById("body-area");
  var sec = doc.sections[currentKey];
  var isItemSection = ITEM_KEYS.has(currentKey);
  var isWritingSection = currentKey === WRITING_KEY;

  if(editMode && editingChapter !== null && isWritingSection){
    renderChapterEditor(area, sec);
  } else if(editMode){
    area.className = isItemSection ? "item-editor" : "editor";
    if(isItemSection){
      renderItemEditor(area, sec);
    } else if(isWritingSection){
      renderWritingEditor(area, sec);
    } else {
      area.innerHTML = '<div class="toolbar"><span class="hint">修改 Markdown，右侧即时预览；保存后将回写当前文件。</span><span id="autosave-tag"></span></div>'
        + '<div class="panes">'
        + '<section class="editor-pane source-pane"><div class="editor-pane-label"><span>Markdown 源稿</span><span>可直接编辑</span></div><textarea id="ta" oninput="onEdit()" spellcheck="false" aria-label="Markdown 源稿">'+escapeHtml(sec.body)+'</textarea></section>'
        + '<section class="editor-pane preview-pane"><div class="editor-pane-label"><span>阅读预览</span><span>实时更新</span></div><div class="preview view" id="pv"></div></section>'
        + '</div>';
      refreshPreview();
    }
  } else {
    area.className = "";
    if(isWritingSection && sec.body.trim()){
      renderWritingView(area, sec);
    } else if(isItemSection && sec.body.trim()){
      renderItemView(area, sec);
    } else if(sec.body.trim()){
      area.innerHTML = '<div class="view">'+mdToHtml(sec.body)+'</div>';
    } else {
      area.innerHTML = '<div class="empty"><div class="big">\u270e</div><div class="t">\u8fd9\u4e00\u8282\u8fd8\u6ca1\u6709\u5185\u5bb9</div><div class="s">\u70b9\u53f3\u4e0a\u300c\u5f00\u59cb\u64b0\u5199\u300d\u521b\u5efa\u5b83</div></div>';
    }
  }
}

function renderItemView(area, sec){
  var items = parseItems(sec.body);
  if(items.length === 0){
    area.innerHTML = '<div class="view">'+mdToHtml(sec.body)+'</div>';
    return;
  }
  var label = ITEM_LABELS[currentKey] || "\u6761\u76ee";
  var h = '<div class="item-list">';
  items.forEach(function(item, idx){
    h += '<div class="item-card">';
    h += '<div class="item-title">'+mdToHtml("### "+item.title)+'</div>';
    if(item.body.trim()){
      h += '<div class="item-body">'+mdToHtml(item.body)+'</div>';
    } else {
      h += '<div class="item-empty">\uff08\u7a7a\uff09</div>';
    }
    h += '</div>';
  });
  h += '</div>';
  h += '<div class="item-summary">'+label+'\u5171 '+items.length+' \u6761</div>';
  area.innerHTML = h;
}

function renderItemEditor(area, sec){
  itemData = parseItems(sec.body);
  if(itemData.length === 0 && sec.body.trim()){
    itemData = [{title: "\u672a\u547d\u540d"+(ITEM_LABELS[currentKey]||"\u6761\u76ee"), body: sec.body}];
  }
  renderItemList(area);
}

function renderItemList(area){
  var label = ITEM_LABELS[currentKey] || "\u6761\u76ee";
  var h = '<div class="item-toolbar">'
    + '<span class="hint">\u6bcf\u6761'+label+'\u72ec\u7acb\u7f16\u8f91\uff0c\u4fdd\u5b58\u65f6\u81ea\u52a8\u5408\u5e76\u4e3a Markdown\u3002</span>'
    + '<button onclick="addItem()" title="\u6dfb\u52a0\u65b0'+label+'">\uff0b \u65b0\u589e</button>'
    + '</div>';
  h += '<div class="item-edit-list">';
  if(itemData.length === 0){
    h += '<div class="item-empty-hint">\u8fd8\u6ca1\u6709'+label+'\uff0c\u70b9\u51fb\u300c\uff0b \u65b0\u589e\u300d\u6dfb\u52a0</div>';
  }
  itemData.forEach(function(item, idx){
    h += '<div class="item-edit-card" data-idx="'+idx+'">';
    h += '<div class="item-edit-head">';
    h += '<input type="text" class="item-title-input" value="'+escapeHtml(item.title)+'" placeholder="'+label+'\u540d\u79f0" oninput="onItemTitleChange('+idx+', this.value)">';
    h += '<button class="item-del-btn" onclick="deleteItem('+idx+')" title="\u5220\u9664">\u2715</button>';
    h += '</div>';
    h += '<div class="item-edit-panes">';
    h += '<textarea class="item-body-input" oninput="onItemBodyChange('+idx+', this.value)" spellcheck="false" placeholder="'+label+'\u8be6\u7ec6\u5185\u5bb9\u2026">'+escapeHtml(item.body)+'</textarea>';
    h += '<div class="item-edit-preview view" id="item-pv-'+idx+'">'+mdToHtml(item.body)+'</div>';
    h += '</div></div>';
  });
  h += '</div>';
  area.innerHTML = h;
}

window.addItem = function(){
  var label = ITEM_LABELS[currentKey] || "\u6761\u76ee";
  itemData.push({title: "", body: ""});
  dirty = true;
  var area = document.getElementById("body-area");
  renderItemList(area);
  var inputs = area.querySelectorAll(".item-title-input");
  if(inputs.length > 0) inputs[inputs.length - 1].focus();
};

window.deleteItem = function(idx){
  itemData.splice(idx, 1);
  dirty = true;
  var area = document.getElementById("body-area");
  renderItemList(area);
};

window.onItemTitleChange = function(idx, val){
  itemData[idx].title = val;
  dirty = true;
};

window.onItemBodyChange = function(idx, val){
  itemData[idx].body = val;
  dirty = true;
  var pv = document.getElementById("item-pv-"+idx);
  if(pv) pv.innerHTML = mdToHtml(val);
};

function parseChapters(body){
  var items = parseItems(body);
  return items.map(function(it){
    return {title: it.title, body: it.body};
  });
}

function buildChaptersBody(chapters){
  return buildItemsBody(chapters);
}

function renderWritingView(area, sec){
  var chapters = parseChapters(sec.body);
  if(chapters.length === 0){
    area.innerHTML = '<div class="empty"><div class="big">\u270e</div><div class="t">\u8fd8\u6ca1\u6709\u7ae0\u8282</div><div class="s">\u70b9\u53f3\u4e0a\u300c\u5f00\u59cb\u64b0\u5199\u300d\u521b\u5efa\u7ae0\u8282</div></div>';
    return;
  }
var totalChars = 0;
  chapters.forEach(function(ch){
    var t = (ch.body || "").trim();
    totalChars += t.replace(/\s/g, "").length;
  });
  var h = '<div class="chapter-grid">';
  chapters.forEach(function(ch, idx){
    var t = (ch.body || "").trim();
    var chars = t.replace(/\s/g, "").length;
    var preview = t.substring(0, 60).replace(/\n/g," ");
    if(t.length > 60) preview += "\u2026";
    h += '<div class="chapter-card" onclick="openChapter('+idx+')">';
    h += '<div class="chapter-card-title">'+escapeHtml(ch.title)+'</div>';
    h += '<div class="chapter-card-preview">'+escapeHtml(preview||'\uff08\u7a7a\uff09')+'</div>';
    h += '<div class="chapter-card-meta">'+chars+' \u5b57\u7b26</div>';
    h += '</div>';
  });
  h += '</div>';
  h += '<div class="chapter-summary">\u5171 '+chapters.length+' \u7ae0 \u00b7 '+totalChars+' \u5b57\u7b26</div>';
  area.innerHTML = h;
}

function renderWritingEditor(area, sec){
  if(!chapterData || chapterData.length === 0 || !dirty){
    chapterData = parseChapters(sec.body);
    if(chapterData.length === 0 && sec.body.trim()){
      chapterData = [{title: "\u672a\u547d\u540d\u7ae0\u8282", body: sec.body}];
    }
  }
  renderChapterList(area);
}

function renderChapterList(area){
  var h = '<div class="chapter-toolbar">';
  h += '<span class="hint">\u6bcf\u7ae0\u72ec\u7acb\u7f16\u8f91\uff0c\u70b9\u51fb\u8fdb\u5165\u5199\u4f5c\u3002</span>';
  h += '<button onclick="addChapter()">\uff0b \u65b0\u7ae0</button>';
  h += '</div>';
  h += '<div class="chapter-grid-edit">';
  if(chapterData.length === 0){
    h += '<div class="item-empty-hint">\u8fd8\u6ca1\u6709\u7ae0\u8282\uff0c\u70b9\u51fb\u300c\uff0b \u65b0\u7ae0\u300d\u6dfb\u52a0</div>';
  }
  chapterData.forEach(function(ch, idx){
    var t = (ch.body || "").trim();
    var chars = t.replace(/\s/g, "").length;
    h += '<div class="chapter-edit-card" onclick="openChapter('+idx+')">';
    h += '<div class="chapter-edit-title">'+escapeHtml(ch.title || '\u672a\u547d\u540d')+'</div>';
    h += '<div class="chapter-edit-meta">'+chars+' \u5b57\u7b26</div>';
    h += '<div class="chapter-edit-actions">';
    h += '<button class="ibtn-sm" onclick="event.stopPropagation(); renameChapter('+idx+')" title="\u91cd\u547d\u540d">\u270f\ufe0f</button>';
    h += '<button class="ibtn-sm ibtn-del" onclick="event.stopPropagation(); deleteChapter('+idx+')" title="\u5220\u9664">\u2715</button>';
    h += '</div></div>';
  });
  h += '</div>';
  area.innerHTML = h;
}

function renderChapterEditor(area, sec){
  var ch = chapterData[editingChapter];
  if(!ch){ editingChapter = null; renderBody(); return; }
  var h = '<div class="chapter-write">';
  h += '<div class="chapter-write-head">';
  h += '<button class="ghost" onclick="backToChapterList()">\u2190 \u8fd4\u56de\u7ae0\u8282\u5217\u8868</button>';
  h += '<span class="chapter-write-title">\u300c'+escapeHtml(ch.title||'\u672a\u547d\u540d')+'\u300d</span>';
  h += '<span class="chapter-write-count" id="ch-count">'+countZhEn(ch.body)+'</span>';
  h += '</div>';
  h += '<textarea class="chapter-write-area" id="chapter-ta" oninput="onChapterInput()" spellcheck="false" placeholder="\u5728\u8fd9\u91cc\u5199\u4f5c\u2026">'+escapeHtml(ch.body)+'</textarea>';
  h += '</div>';
  area.innerHTML = h;
  document.getElementById("chapter-ta").focus();
}

function countZhEn(text){
  var t = (text||"").trim();
  var chars = t.replace(/\s/g, "").length;
  return chars + ' \u5b57\u7b26';
}

window.openChapter = function(idx){
  if(editingChapter !== null && dirty && chapterData[editingChapter]){
    chapterData[editingChapter].body = document.getElementById("chapter-ta").value;
  }
  var wasEditing = editMode;
  if(!wasEditing){
    editMode = true; dirty = false;
    if(!chapterData || chapterData.length === 0){
      chapterData = parseChapters(doc.sections[currentKey].body);
    }
  }
  editingChapter = idx;
  if(!wasEditing) dirty = false;
  renderBody();
};

window.backToChapterList = function(){
  if(editingChapter !== null){
    var ta = document.getElementById("chapter-ta");
    if(ta) chapterData[editingChapter].body = ta.value;
  }
  editingChapter = null;
  renderBody();
};

window.addChapter = function(){
  var title = prompt("\u65b0\u7ae0\u8282\u540d\u79f0\uff1a", "\u7b2c "+(chapterData.length+1)+" \u7ae0");
  if(!title) return;
  chapterData.push({title: title.trim(), body: ""});
  dirty = true;
  var area = document.getElementById("body-area");
  renderChapterList(area);
};

window.deleteChapter = function(idx){
  if(!confirm("\u786e\u5b9a\u522a\u9664\u300c"+chapterData[idx].title+"\u300d\uff1f")) return;
  chapterData.splice(idx, 1);
  dirty = true;
  var area = document.getElementById("body-area");
  renderChapterList(area);
};

window.renameChapter = function(idx){
  var name = prompt("\u91cd\u547d\u540d\u7ae0\u8282\uff1a", chapterData[idx].title);
  if(name === null) return;
  chapterData[idx].title = name.trim();
  dirty = true;
  var area = document.getElementById("body-area");
  renderChapterList(area);
};

window.onChapterInput = function(){
  var ta = document.getElementById("chapter-ta");
  if(ta && editingChapter !== null){
    chapterData[editingChapter].body = ta.value;
    dirty = true;
    var cnt = document.getElementById("ch-count");
    if(cnt) cnt.textContent = countZhEn(ta.value);
  }
};

function enterEdit(){ editMode = true; dirty = false; editingChapter = null; chapterData = []; renderContent(); }
function cancelEdit(){
  if(dirty && !confirm("\u653e\u5f03\u672a\u4fdd\u5b58\u7684\u4fee\u6539\uff1f")) return;
  editMode=false; dirty=false; editingChapter=null; chapterData=[]; renderContent();
}
var PREVIEW_DEBOUNCE_MS = 300;
var previewTimer = null;
function onEdit(){ dirty = true; schedulePreview(); }
function schedulePreview(){
  if(previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(function(){ previewTimer = null; refreshPreview(); }, PREVIEW_DEBOUNCE_MS);
}
function refreshPreview(){
  var ta = document.getElementById("ta");
  if(ta) document.getElementById("pv").innerHTML = mdToHtml(ta.value);
}

async function save(isAutosave){
  var body;
  if(editingChapter !== null && currentKey === WRITING_KEY){
    var cta = document.getElementById("chapter-ta");
    if(cta) chapterData[editingChapter].body = cta.value;
    body = buildChaptersBody(chapterData);
  } else if(currentKey === WRITING_KEY){
    body = buildChaptersBody(chapterData);
  } else if(ITEM_KEYS.has(currentKey)){
    body = buildItemsBody(itemData);
  } else {
    var ta = document.getElementById("ta");
    if(!ta) return;
    body = ta.value;
  }
  var r = await postJson("/api/save", {file:currentFile, key:currentKey, body:body, mtime:knownMtime});
  if(r.status === 409){
    if(isAutosave) return;
    var j = await r.json();
    doc = await authFetchJson("/api/doc?file="+encodeURIComponent(currentFile));
    knownMtime = doc.mtime; setSaved(doc.saved_at);
    showConflict(j);
    return;
  }
  var j = await r.json();
  if(!doc) return;
  if(j.ok){
    doc.sections[currentKey].body = body;
    doc.sections[currentKey].exists = true;
    doc.nodes = j.nodes; knownMtime = j.mtime; setSaved(j.saved_at);
    if(j.stats) doc.stats = j.stats;
    if(isAutosave){
      dirty = false; hideBanner();
      updateProgress(); renderTimeline(); renderSidebar();
      showAutosaveTag();
    } else {
      editMode = false; dirty = false; editingChapter = null; hideBanner();
      updateProgress();
      renderTimeline(); renderSidebar(); renderContent(); toast("\u5df2\u4fdd\u5b58");
    }
  } else {
    if(!isAutosave) toast("\u4fdd\u5b58\u5931\u8d25\uff1a" + (j.error||"\u672a\u77e5\u9519\u8bef"), true);
  }
}

function showConflict(info){
  var modal = document.createElement("div");
  modal.id = "conflict-modal";
  modal.innerHTML = '<div class="modal-box">'
    + '<h3>\u26a0\ufe0f \u6587\u4ef6\u88ab\u5916\u90e8\u4fee\u6539</h3>'
    + '<p>\u8be5\u6587\u4ef6\u5df2\u88ab\u5176\u4ed6\u7a0b\u5e8f\u4fee\u6539\uff0c\u76f4\u63a5\u4fdd\u5b58\u4f1a\u8986\u76d6\u5916\u90e8\u66f4\u6539\u3002</p>'
    + '<div class="btns">'
    + '<button onclick="forceOverwrite()" class="danger">\u5f3a\u5236\u8986\u76d6</button>'
    + '<button onclick="cancelAndReload()" class="ghost">\u53d6\u6d88\u5e76\u91cd\u65b0\u52a0\u8f7d</button>'
    + '</div></div>';
  document.body.appendChild(modal);
}

async function forceOverwrite(){
  dismissConflict();
  var body;
  if(editingChapter !== null && currentKey === WRITING_KEY){
    var cta = document.getElementById("chapter-ta");
    if(cta) chapterData[editingChapter].body = cta.value;
    body = buildChaptersBody(chapterData);
  } else if(currentKey === WRITING_KEY){
    body = buildChaptersBody(chapterData);
  } else if(ITEM_KEYS.has(currentKey)){
    body = buildItemsBody(itemData);
  } else {
    var ta = document.getElementById("ta");
    body = ta ? ta.value : "";
  }
  var r = await postJson("/api/save", {file:currentFile, key:currentKey, body:body, mtime:0});
  var j = await r.json();
  if(!doc) return;
  if(j.ok){
    doc.sections[currentKey].body = body;
    doc.sections[currentKey].exists = true;
    doc.nodes = j.nodes; knownMtime = j.mtime; setSaved(j.saved_at);
    if(j.stats) doc.stats = j.stats;
    editMode = false; dirty = false; editingChapter = null; hideBanner();
    updateProgress();
    renderTimeline(); renderSidebar(); renderContent(); toast("\u5df2\u5f3a\u5236\u4fdd\u5b58");
  } else {
    toast("\u4fdd\u5b58\u5931\u8d25\uff1a"+(j.error||""), true);
  }
}

async function cancelAndReload(){
  dismissConflict();
  editMode = false; dirty = false; hideBanner();
  await loadDoc();
  toast("\u5df2\u91cd\u65b0\u52a0\u8f7d");
}

function dismissConflict(){
  var m = document.getElementById("conflict-modal");
  if(m) m.remove();
}

function startAutosave(){
  if(autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = setInterval(function(){
    if(editMode && dirty){
      save(true);
    }
  }, AUTOSAVE_INTERVAL);
}

function showAutosaveTag(){
  var el = document.getElementById("autosave-tag");
  if(el){
    el.textContent = "\u81ea\u52a8\u4fdd\u5b58\u4e2d\u2026";
    el.classList.add("show");
    setTimeout(function(){ el.classList.remove("show"); }, 2000);
  }
}

async function onStatus(s){
  var r = await postJson("/api/save", {file:currentFile, key:currentKey, body:null, status:s, mtime:knownMtime});
  if(r.status === 409){
    var j = await r.json();
    doc = await authFetchJson("/api/doc?file="+encodeURIComponent(currentFile));
    knownMtime = doc.mtime; setSaved(doc.saved_at);
    showConflict(j);
    return;
  }
  var j = await r.json();
  if(!doc) return;
  if(j.ok){
    doc.nodes = j.nodes; knownMtime = j.mtime; setSaved(j.saved_at); hideBanner();
    if(j.stats) doc.stats = j.stats;
    updateProgress();
    var badge = document.getElementById("status-badge");
    if(badge){ badge.className = "badge "+s; badge.innerHTML = ICON[s]+" "+STATUS_TXT[s]; }
    document.querySelectorAll("#tri .seg").forEach(function(b){b.classList.toggle("active", b.dataset.st===s);});
    renderTimeline(); renderSidebar();
    if(!editMode) renderContent();
    toast("\u5df2\u6807\u8bb0\u4e3a" + STXT[s]);
  } else {
    toast("\u64cd\u4f5c\u5931\u8d25\uff1a" + (j.error||""), true);
  }
}

function downloadRaw(){
  var body;
  if(ITEM_KEYS.has(currentKey) && editMode){
    body = buildItemsBody(itemData);
  } else {
    body = doc.sections[currentKey].body;
  }
  var blob = new Blob([body],{type:"text/markdown"});
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = currentKey+".md";
  a.click();
}

function exportFull(){
  window.open("/api/export?file="+encodeURIComponent(currentFile), "_blank");
}

function toggleSearch(){
  var panel = document.getElementById("search-panel");
  panel.classList.toggle("open");
  if(panel.classList.contains("open")){
    document.getElementById("search-input").focus();
  } else {
    document.getElementById("search-results").innerHTML = "";
    document.getElementById("search-input").value = "";
  }
}

function onSearchKey(e){
  if(e.key === "Enter") doSearch();
  if(e.key === "Escape") toggleSearch();
}

async function doSearch(){
  var input = document.getElementById("search-input");
  var q = (input.value || "").trim();
  var results = document.getElementById("search-results");
  if(!q){ results.innerHTML = ""; return; }
  try{
    var j = await authFetchJson("/api/search?file="+encodeURIComponent(currentFile)+"&q="+encodeURIComponent(q));
    if(!j.results || j.results.length === 0){
      results.innerHTML = '<div class="sr-empty">\u672a\u627e\u5230\u5339\u914d\u7ed3\u679c</div>';
      return;
    }
    results.innerHTML = j.results.map(function(item){
      var snip = escapeHtml(item.snippet);
      var re = new RegExp("("+escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+")","gi");
      snip = snip.replace(re, "<mark>$1</mark>");
      return '<div class="sr-item" data-key="'+escapeHtml(item.key)+'">'
        + '<span class="sr-title">'+escapeHtml(item.title)+'</span>'
        + ' <span class="sr-line">\u7b2c '+escapeHtml(String(item.line))+' \u884c</span>'
        + '<div class="sr-snippet">'+snip+'</div>'
        + '</div>';
    }).join("");
    results.querySelectorAll(".sr-item").forEach(function(el){
      el.onclick = function(){ goSearchResult(el.dataset.key); };
    });
  }catch(e){
    results.innerHTML = '<div class="sr-empty">\u641c\u7d22\u5931\u8d25</div>';
  }
}

function goSearchResult(key){
  toggleSearch();
  select(key);
}

async function poll(){
  try{
    var j = await authFetchJson("/api/mtime?file="+encodeURIComponent(currentFile));
    if(!j.mtime || j.mtime <= knownMtime) return;
    knownMtime = j.mtime;
    if(editMode) showBanner();
    else await loadDoc();
  }catch(e){}
}

async function reloadDoc(fromBanner){
  await loadDoc(); hideBanner();
  if(fromBanner) toast("\u5df2\u5237\u65b0");
}

function showBanner(){ document.getElementById("ext-banner").classList.add("show"); }
function hideBanner(){ document.getElementById("ext-banner").classList.remove("show"); }

var toastTimer = null;
function toast(msg, isErr){
  var t = document.getElementById("toast");
  t.textContent = msg;
  t.style.background = isErr ? "#e0556b" : "var(--accent)";
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){t.classList.remove("show");}, 1600);
}

function onKeydown(e){
  if(e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT"){
    if(e.key === "Escape" && editMode){ cancelEdit(); e.preventDefault(); }
    if((e.ctrlKey || e.metaKey) && e.key === "s"){ e.preventDefault(); if(editMode) save(); }
    return;
  }
  if((e.ctrlKey || e.metaKey) && e.key === "s"){ e.preventDefault(); if(editMode) save(); }
  if((e.ctrlKey || e.metaKey) && e.key === "f"){ e.preventDefault(); toggleSearch(); }
  if(e.key === "Escape"){
    if(document.getElementById("search-panel").classList.contains("open")){ toggleSearch(); return; }
    if(editMode) cancelEdit();
  }
  if(!editMode){
    if(e.key === "ArrowUp" || e.key === "ArrowLeft"){ e.preventDefault(); navigateStep(-1); }
    if(e.key === "ArrowDown" || e.key === "ArrowRight"){ e.preventDefault(); navigateStep(1); }
  }
  if(e.key === "Tab" && SUPPORTS_STATUS.has(currentKey)){
    var node = doc.nodes.find(function(n){return n.key===currentKey});
    if(node){
      e.preventDefault();
      var order = ["todo","draft","done"];
      var next = order[(order.indexOf(node.status)+1) % 3];
      onStatus(next);
    }
  }
}

function navigateStep(dir){
  var allKeys = ["preamble"].concat(STEP_KEYS);
  var idx = allKeys.indexOf(currentKey);
  if(idx < 0) return;
  var newIdx = idx + dir;
  if(newIdx < 0) newIdx = allKeys.length - 1;
  if(newIdx >= allKeys.length) newIdx = 0;
  select(allKeys[newIdx]);
}

function inlineMd(s){
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\*])\*([^\*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  return s;
}

function splitRow(l){return l.replace(/^\s*\|/,"").replace(/\|\s*$/,"").split("|").map(function(s){return s.trim();});}
function parseAlign(l){return l.replace(/^\s*\|/,"").replace(/\|\s*$/,"").split("|").map(function(c){c=c.trim();if(c.startsWith(":")&&c.endsWith(":"))return"center";if(c.endsWith(":"))return"right";if(c.startsWith(":"))return"left";return"";});}
function isHr(l){return /^\s*([-*_])(\s*\1){2,}\s*$/.test(l)||l.trim()==="---";}

function mdToHtml(src){
  var lines=String(src).replace(/\r/g,"").split("\n"); var out=[]; var i=0;

  function isSpecial(l){
    return /^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+\.\s|\s*>)/.test(l) || isHr(l);
  }

  while(i<lines.length){
    var line=lines[i];
    if(/^```/.test(line)){
      var fence=line.match(/^```\s*(.*)/);
      var lang=fence?fence[1]:"";
      var c=[];i++;while(i<lines.length&&!/^```/.test(lines[i])){c.push(lines[i]);i++;}
      i++;
      var cls=lang?' class="language-'+escapeHtml(lang)+'"' : '';
      out.push("<pre><code"+cls+">"+escapeHtml(c.join("\n"))+"</code></pre>");
      continue;
    }
    var hm=/^(#{1,6})\s+(.*)$/.exec(line);
    if(hm){out.push("<h"+hm[1].length+">"+inlineMd(hm[2])+"</h"+hm[1].length+">");i++;continue;}
    if(isHr(line)){out.push("<hr>");i++;continue;}
    if(/^\s*>\s?/.test(line)){
      var q=[];
      while(i<lines.length&&/^\s*>\s?/.test(lines[i])){q.push(lines[i].replace(/^\s*>\s?/,""));i++;}
      out.push("<blockquote>"+mdToHtml(q.join("\n"))+"</blockquote>");
      continue;
    }
    if(/\|/.test(line)&&i+1<lines.length&&/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i+1])&&/\|/.test(lines[i+1])){
      var header=splitRow(line);i+=2;var aligns=parseAlign(lines[i-1]);var rows=[];
      while(i<lines.length&&/\|/.test(lines[i])){rows.push(splitRow(lines[i]));i++;}
      var t="<table><thead><tr>";header.forEach(function(c,j){t+='<th'+(aligns[j]?' style="text-align:'+aligns[j]+'"':"")+">"+inlineMd(c)+"</th>";});
      t+="</tr></thead><tbody>";rows.forEach(function(r){t+="<tr>";header.forEach(function(_,j){t+='<td'+(aligns[j]?' style="text-align:'+aligns[j]+'"':"")+">"+inlineMd(r[j]||"")+"</td>";});t+="</tr>";});
      t+="</tbody></table>";out.push(t);continue;
    }
    var listResult=parseList(lines,i);
    if(listResult){out.push(listResult.html);i=listResult.next;continue;}
    if(line.trim()===""){i++;continue;}
    var para=[];
    while(i<lines.length&&lines[i].trim()!==""&&!isSpecial(lines[i])
      &&!(/\|/.test(lines[i])&&i+1<lines.length&&/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i+1]))){
      para.push(lines[i]);i++;
    }
    if(para.length)out.push("<p>"+para.map(inlineMd).join("<br>")+"</p>");
  }
  return out.join("\n");
}

function parseList(lines, start){
  var line=lines[start];
  var ulMatch=/^(\s*)([-*+])\s(?:\[([ xX~])\]\s)?(.*)$/.exec(line);
  var olMatch=/^(\s*)(\d+\.)\s(.*)$/.exec(line);
  if(!ulMatch&&!olMatch) return null;
  var isUl=!!ulMatch;
  var baseIndent=isUl?ulMatch[1].length:olMatch[1].length;
  var items=[];
  var idx=start;
  while(idx<lines.length){
    var l=lines[idx];
    var m;
    if(isUl){
      m=/^(\s*)([-*+])\s(?:\[([ xX~])\]\s)?(.*)$/.exec(l);
      if(!m) break;
      items.push({indent:m[1].length, checkbox:m[3]||null, text:m[4], line:l});
    } else {
      m=/^(\s*)(\d+\.)\s(.*)$/.exec(l);
      if(!m) break;
      items.push({indent:m[1].length, text:m[3], line:l});
    }
    idx++;
  }
  var html=buildList(items, 0, isUl);
  return {html:html.html, next:idx};
}

function buildList(items, idx, isUl){
  var out=isUl?"<ul>":"<ol>";
  var i=idx;
  while(i<items.length){
    var item=items[i];
    var text=inlineMd(item.text);
    if(item.checkbox!==null&&item.checkbox!==undefined){
      var box;
      if(item.checkbox==="x"||item.checkbox==="X") box='<input type="checkbox" checked disabled>';
      else if(item.checkbox==="~") box='<input type="checkbox" disabled style="opacity:.45">';
      else box='<input type="checkbox" disabled>';
      text=box+" "+text;
    }
    var nextItem=items[i+1];
    if(nextItem&&nextItem.indent>item.indent){
      var sub=buildList(items, i+1, isUl);
      out+='<li class="'+(item.checkbox!==null&&item.checkbox!==undefined?"task":"")+'">'+text+sub.html+"</li>";
      i=sub.next;
    } else if(nextItem&&nextItem.indent<item.indent){
      out+='<li class="'+(item.checkbox!==null&&item.checkbox!==undefined?"task":"")+'">'+text+"</li>";
      break;
    } else {
      out+='<li class="'+(item.checkbox!==null&&item.checkbox!==undefined?"task":"")+'">'+text+"</li>";
      i++;
    }
  }
  out+=isUl?"</ul>":"</ol>";
  return {html:out, next:i};
}

window.newFile=newFile;
window.enterEdit=enterEdit;
window.cancelEdit=cancelEdit;
window.save=save;
window.onStatus=onStatus;
window.downloadRaw=downloadRaw;
window.reloadDoc=reloadDoc;
window.toggleTheme=toggleTheme;
window.forceOverwrite=forceOverwrite;
window.cancelAndReload=cancelAndReload;
window.exportFull=exportFull;
window.toggleSearch=toggleSearch;
window.doSearch=doSearch;
window.goSearchResult=goSearchResult;
window.onSearchKey=onSearchKey;
window.addItem=addItem;
window.deleteItem=deleteItem;
window.onItemTitleChange=onItemTitleChange;
window.onItemBodyChange=onItemBodyChange;

init();
})();
