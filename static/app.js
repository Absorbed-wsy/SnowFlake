(function(){
"use strict";

var ICON={done:"✓",draft:"◔",todo:"○"};
var STATUS_TEXT={todo:"待办",draft:"草案",done:"完成"};
var STEP_KEYS=["step0","step1","step2","step3","step4","step5","step6","step7","step8","step9","step10"];
var TIMELINE_LABELS={step0:"核心",step1:"一句话",step2:"一段话",step3:"人物",step4:"一页大纲",step5:"人物大纲",step6:"四页大纲",step7:"人物宝典",step8:"场景清单",step9:"场景双模",step10:"写作"};
var FLOW_KEY="flow";
var THEMES=["light","dark","green","sepia"];
var THEME_LABELS={light:"浅色",dark:"深色",green:"护眼绿",sepia:"暖纸色"};
var THEME_ICONS={light:"☀️",dark:"🌙",green:"🌱",sepia:"📜"};
var ITEM_LABELS={step7:"人物",step8:"场景",step9:"场景",step10:"章节"};
var COLORS=["yellow","red","green","blue","purple"];
var COLOR_LABELS={yellow:"黄色",red:"红色",green:"绿色",blue:"蓝色",purple:"紫色"};
var DOCUMENT_VERSION=2;
var EMPTY_DOCUMENT={version:DOCUMENT_VERSION,blocks:[]};

var projectData=null;
var currentProject="";
var currentKey="preamble";
var knownMtime=0;
var csrfToken="";
var PASSWORD_REQUIRED=false;
var editMode=false;
var dirty=false;
var editRevision=0;
var savingSection=false;
var itemDrafts=[];
var editingChapter=null;
var activeEditor=null;
var pendingConflict=null;
var autosaveTimer=null;
var pollTimer=null;
var renameProjectOriginal="";
var deleteProjectStage=0;
var deleteProjectTarget="";
var serverDisconnected=false;

function escapeHtml(value){
  return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function textToHtml(value){return escapeHtml(value).replace(/\n/g,"<br>");}

function clone(value){return JSON.parse(JSON.stringify(value));}

function localFetch(url,options){
  return fetch(url,options).then(function(response){
    serverDisconnected=false;
    return response;
  }).catch(function(error){
    serverDisconnected=true;
    var saved=document.getElementById("saved-tag");
    if(saved)setSaved("本地服务未连接",true);
    if(error&&error.name==="TypeError")throw new Error("无法连接本地服务，请重新启动 SnowFlake");
    throw error;
  });
}

function postJson(url,data){
  var headers={"Content-Type":"application/json"};
  if(csrfToken)headers["X-CSRF-Token"]=csrfToken;
  return localFetch(url,{method:"POST",headers:headers,body:JSON.stringify(data)}).then(function(response){
    if(response.status===401&&PASSWORD_REQUIRED){showLogin();throw new Error("未登录");}
    return response;
  });
}

function getJson(url){
  return localFetch(url).then(function(response){
    if(response.status===401&&PASSWORD_REQUIRED){showLogin();throw new Error("未登录");}
    return response.json().then(function(data){
      if(!response.ok)throw new Error(data.error||"请求失败");
      return data;
    });
  });
}

function showLogin(){
  document.getElementById("login-screen").style.display="";
  document.getElementById("app-main").style.display="none";
}

function showApp(){
  document.getElementById("login-screen").style.display="none";
  document.getElementById("app-main").style.display="";
}

window.doLogin=async function(){
  var password=document.getElementById("login-password").value;
  var error=document.getElementById("login-error");
  error.textContent="";
  try{
    var response=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:password})});
    if(!response.ok){var failed=await response.json();throw new Error(failed.error||"密码错误");}
    var config=await fetch("/api/config").then(function(r){return r.json();});
    csrfToken=config.csrf_token||"";
    showApp();
    await loadApp();
  }catch(errorValue){error.textContent=errorValue.message||"连接失败";}
};

window.doLock=async function(){
  if(editMode&&dirty){await save(true);if(dirty){toast("当前修改尚未保存，请稍后重试",true);return;}}
  if(window.FlowBoard)await window.FlowBoard.flush();
  try{await fetch("/api/logout",{method:"POST"});}catch(ignore){}
  stopTimers();
  currentProject="";projectData=null;csrfToken="";editMode=false;dirty=false;
  if(window.FlowBoard)window.FlowBoard.reset();
  showLogin();
  document.getElementById("login-password").value="";
};

async function init(){
  initTheme();
  document.getElementById("menu-btn").addEventListener("click",toggleSidebar);
  document.getElementById("sidebar-backdrop").addEventListener("click",closeSidebar);
  document.getElementById("project-picker").addEventListener("change",onPickProject);
  document.addEventListener("focusin",function(event){
    if(event.target&&event.target.classList&&event.target.classList.contains("rich-editor"))activeEditor=event.target;
  });
  document.addEventListener("keydown",onKeydown);
  try{
    var config=await getJson("/api/config");
    csrfToken=config.csrf_token||"";
    PASSWORD_REQUIRED=!!config.auth_required;
    document.getElementById("lock-btn").style.display=PASSWORD_REQUIRED?"":"none";
    if(PASSWORD_REQUIRED){
      var session=await fetch("/api/projects");
      if(!session.ok){showLogin();return;}
    }
    showApp();
    await loadApp();
  }catch(error){showLogin();}
}

function stopTimers(){
  if(autosaveTimer){clearInterval(autosaveTimer);autosaveTimer=null;}
  if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
}

async function loadApp(){
  stopTimers();
  var result=await getJson("/api/projects");
  populatePicker(result.projects||[]);
  var last=localStorage.getItem("sf_project");
  var match=(result.projects||[]).find(function(item){return item.name===last;});
  currentProject=(match&&match.name)||((result.projects||[])[0]&&result.projects[0].name)||"";
  document.getElementById("project-picker").value=currentProject;
  if(currentProject){
    await loadProject();
    pollTimer=setInterval(poll,2500);
    autosaveTimer=setInterval(function(){if(editMode&&dirty)save(true);},30000);
  }else{
    renderEmptyWorkspace();
  }
}

function populatePicker(projects){
  var picker=document.getElementById("project-picker");
  picker.innerHTML="";
  if(!projects.length){var empty=document.createElement("option");empty.textContent="尚无作品";empty.value="";picker.appendChild(empty);}
  else projects.forEach(function(project){var option=document.createElement("option");option.value=project.name;option.textContent=project.name;picker.appendChild(option);});
  document.getElementById("project-rename-btn").disabled=!projects.length;
  document.getElementById("project-delete-btn").disabled=!projects.length;
}

async function onPickProject(){
  if(window.FlowBoard)await window.FlowBoard.flush();
  if(editMode&&dirty&&!confirm("当前修改尚未保存，仍要切换作品吗？")){document.getElementById("project-picker").value=currentProject;return;}
  currentProject=document.getElementById("project-picker").value;
  localStorage.setItem("sf_project",currentProject);
  currentKey="preamble";editMode=false;dirty=false;editingChapter=null;
  await loadProject();
}

async function newProject(){
  var name=prompt("新作品名称：");
  if(!name)return;
  try{
    var response=await postJson("/api/project/create",{name:name});
    var result=await response.json();
    if(!response.ok)throw new Error(result.error||"创建失败");
    populatePicker(result.projects||[]);
    currentProject=result.name;
    document.getElementById("project-picker").value=currentProject;
    localStorage.setItem("sf_project",currentProject);
    currentKey="preamble";editMode=false;dirty=false;
    await loadProject();
    toast("已创建："+currentProject);
  }catch(error){toast(error.message,true);}
}

async function openRenameProject(){
  if(!currentProject)return;
  if(window.FlowBoard)await window.FlowBoard.flush();
  if(editMode&&dirty){
    await save(true);
    if(dirty){toast("当前修改尚未保存，暂不能修改作品名",true);return;}
  }
  renameProjectOriginal=currentProject;
  var input=document.getElementById("rename-project-name");
  input.value=currentProject;
  updateRenameProject();
  document.getElementById("rename-project-modal").classList.add("show");
  setTimeout(function(){input.focus();input.select();},0);
}

function closeRenameProject(){
  document.getElementById("rename-project-modal").classList.remove("show");
  renameProjectOriginal="";
  document.getElementById("rename-project-name").value="";
  var button=document.getElementById("rename-project-confirm");
  button.textContent="保存新名称";
  button.disabled=true;
}

function updateRenameProject(){
  var value=document.getElementById("rename-project-name").value.trim();
  var valid=!!value&&value!==renameProjectOriginal;
  document.getElementById("rename-project-confirm").disabled=!valid;
  var hint=document.getElementById("rename-project-hint");
  hint.textContent=value===renameProjectOriginal?"请输入一个不同的新名称。":"仅修改名称，雪花步骤、人物、章节和走向图都会完整保留。";
}

async function confirmRenameProject(){
  if(!renameProjectOriginal)return;
  var input=document.getElementById("rename-project-name");
  var newName=input.value.trim();
  if(!newName||newName===renameProjectOriginal){updateRenameProject();return;}
  var button=document.getElementById("rename-project-confirm");
  button.disabled=true;button.textContent="正在保存…";
  try{
    var response=await postJson("/api/project/rename",{project:renameProjectOriginal,new_name:newName});
    var result=await response.json();
    if(!response.ok)throw new Error(result.error||"重命名失败");
    closeRenameProject();
    populatePicker(result.projects||[]);
    currentProject=result.name;
    document.getElementById("project-picker").value=currentProject;
    document.getElementById("project-picker").title="切换作品（当前："+currentProject+"）";
    localStorage.setItem("sf_project",currentProject);
    await loadProject();
    toast("已重命名为："+currentProject);
  }catch(error){
    button.textContent="保存新名称";
    updateRenameProject();
    toast(error.message,true);
  }
}

async function openDeleteProject(){
  if(!currentProject)return;
  if(window.FlowBoard)await window.FlowBoard.flush();
  if(editMode&&dirty){
    await save(true);
    if(dirty){toast("当前修改尚未保存，暂不能删除文稿",true);return;}
  }
  deleteProjectTarget=currentProject;
  deleteProjectStage=1;
  renderDeleteProjectStep();
  document.getElementById("delete-project-modal").classList.add("show");
  document.getElementById("delete-project-next").focus();
}

function closeDeleteProject(){
  document.getElementById("delete-project-modal").classList.remove("show");
  deleteProjectStage=0;
  deleteProjectTarget="";
  document.getElementById("delete-project-confirm-name").value="";
  var button=document.getElementById("delete-project-confirm");
  button.textContent="永久删除";
  button.disabled=true;
}

function renderDeleteProjectStep(){
  var titles=["","删除当前设计文稿？","请再次确认删除","输入文稿名称完成确认"];
  var messages=["",
    "该操作将删除这份文稿中的全部雪花步骤、章节、人物资料和故事走向图。",
    "删除后无法在工作台内撤销。其他设计文稿和应用设置不会受到影响。",
    "这是最后一次确认。只有输入与下方完全一致的名称，才能永久删除。"
  ];
  document.getElementById("delete-project-step").textContent="确认 "+deleteProjectStage+" / 3";
  document.getElementById("delete-project-title").textContent=titles[deleteProjectStage];
  document.getElementById("delete-project-message").textContent=messages[deleteProjectStage];
  document.getElementById("delete-project-name").textContent=deleteProjectTarget;
  document.getElementById("delete-project-confirm-wrap").classList.toggle("show",deleteProjectStage===3);
  document.getElementById("delete-project-next").style.display=deleteProjectStage<3?"":"none";
  document.getElementById("delete-project-next").textContent=deleteProjectStage===1?"继续确认":"继续，输入名称";
  document.getElementById("delete-project-confirm").style.display=deleteProjectStage===3?"":"none";
  if(deleteProjectStage===3){
    var input=document.getElementById("delete-project-confirm-name");
    input.value="";
    updateDeleteConfirmation();
    setTimeout(function(){input.focus();},0);
  }
}

function advanceDeleteProject(){
  if(deleteProjectStage<1||deleteProjectStage>=3)return;
  deleteProjectStage+=1;
  renderDeleteProjectStep();
}

function updateDeleteConfirmation(){
  var input=document.getElementById("delete-project-confirm-name");
  var matches=input.value===deleteProjectTarget;
  document.getElementById("delete-project-confirm").disabled=!matches;
  var hint=document.getElementById("delete-project-match-hint");
  hint.textContent=matches?"名称匹配，可以删除":"名称必须完全一致";
  hint.classList.toggle("matched",matches);
}

async function confirmDeleteProject(){
  if(deleteProjectStage!==3)return;
  var input=document.getElementById("delete-project-confirm-name");
  if(input.value!==deleteProjectTarget){updateDeleteConfirmation();return;}
  var button=document.getElementById("delete-project-confirm");
  button.disabled=true;button.textContent="正在删除…";
  try{
    var response=await postJson("/api/project/delete",{project:deleteProjectTarget,confirmation_name:input.value});
    var result=await response.json();
    if(!response.ok)throw new Error(result.error||"删除失败");
    var deletedName=result.name;
    closeDeleteProject();
    if(window.FlowBoard)window.FlowBoard.reset();
    currentProject="";projectData=null;currentKey="preamble";editMode=false;dirty=false;editingChapter=null;
    localStorage.removeItem("sf_project");
    document.getElementById("global-stats").innerHTML="";
    await loadApp();
    toast("已删除："+deletedName);
  }catch(error){
    button.textContent="永久删除";
    updateDeleteConfirmation();
    toast(error.message,true);
  }
}

function fileToBase64(file){
  return new Promise(function(resolve,reject){
    var reader=new FileReader();
    reader.onload=function(){resolve(String(reader.result).split(",")[1]||"");};
    reader.onerror=function(){reject(new Error("无法读取数据库文件"));};
    reader.readAsDataURL(file);
  });
}

async function importDatabase(file){
  if(!file)return;
  if(window.FlowBoard)await window.FlowBoard.flush();
  try{
    setSaved("正在导入…");
    var encoded=await fileToBase64(file);
    var response=await postJson("/api/project/import-db",{filename:file.name,data:encoded});
    var result=await response.json();
    if(!response.ok)throw new Error(result.error||"导入失败");
    populatePicker(result.projects||[]);
    currentProject=result.names[0]||currentProject;
    document.getElementById("project-picker").value=currentProject;
    localStorage.setItem("sf_project",currentProject);
    currentKey="preamble";editMode=false;dirty=false;
    await loadProject();
    toast("已导入 "+result.names.length+" 部作品");
  }catch(error){setSaved("导入失败",true);toast(error.message,true);}
}

async function loadProject(){
  if(!currentProject)return;
  projectData=await getJson("/api/project?project="+encodeURIComponent(currentProject));
  knownMtime=projectData.mtime;
  renderAll();
  setSaved("已保存 "+formatTime(projectData.saved_at));
}

function renderAll(){renderSidebar();renderTimeline();renderContent();updateProgress();}

function renderEmptyWorkspace(){
  document.getElementById("sidebar").innerHTML="";
  document.getElementById("timeline").innerHTML="";
  document.getElementById("content").innerHTML='<div class="card"><div class="empty"><div class="big">✎</div><div class="t">还没有作品</div><div class="s">新建作品，或导入另一个 SnowFlake 数据库</div></div></div>';
}

function renderSidebar(){
  var progress=projectData.stats.progress;
  var html='<div class="sidebar-summary"><span>创作进度</span><strong>'+progress.done+' / '+progress.total+'</strong></div>';
  html+='<div class="grp">基础</div>'+sidebarLink("preamble","标题与简介")+sidebarLink(FLOW_KEY,"故事走向图");
  html+='<div class="grp">雪花步骤</div>';
  projectData.nodes.forEach(function(node){html+=sidebarLink(node.key,node.short,node.status);});
  var sidebar=document.getElementById("sidebar");sidebar.innerHTML=html;
  sidebar.querySelectorAll("a[data-key]").forEach(function(link){link.onclick=function(){selectSection(link.dataset.key);};});
}

function sidebarLink(key,label,status){
  return '<a data-key="'+key+'" class="'+(currentKey===key?'active':'')+'"><span>'+escapeHtml(label)+'</span>'
    +(status?'<span class="st '+status+'">'+ICON[status]+'</span>':'')+'</a>';
}

function renderTimeline(){
  var html='<div class="timeline-track" role="list">';
  projectData.nodes.forEach(function(node){
    var active=currentKey===node.key;
    var label=node.full+'，'+STATUS_TEXT[node.status];
    var stateIcon=node.status==="done"?"✓":(node.status==="draft"?"•":"");
    html+='<button type="button" class="node '+node.status+(active?' active':'')+'" data-key="'+node.key+'" role="listitem" aria-label="'+escapeHtml(label)+'" title="'+escapeHtml(label)+'"'+(active?' aria-current="step"':'')+'>'
      +'<span class="step-state" aria-hidden="true">'+stateIcon+'</span>'
      +'<span class="lbl">'+escapeHtml(TIMELINE_LABELS[node.key]||node.short)+'</span></button>';
  });
  html+='</div>';
  var timeline=document.getElementById("timeline");timeline.innerHTML=html;
  timeline.querySelectorAll(".node").forEach(function(node){node.onclick=function(){selectSection(node.dataset.key);};});
}

async function selectSection(key){
  if(key===currentKey){closeSidebar();return;}
  if(currentKey===FLOW_KEY&&window.FlowBoard)await window.FlowBoard.flush();
  if(editMode&&dirty&&!confirm("当前修改尚未保存，仍要离开吗？"))return;
  if(currentKey===FLOW_KEY&&window.FlowBoard)window.FlowBoard.unmount();
  currentKey=key;editMode=false;dirty=false;editingChapter=null;activeEditor=null;
  renderAll();closeSidebar();
}

function renderContent(){
  var content=document.getElementById("content");
  document.querySelector("main").classList.toggle("flow-mode",currentKey===FLOW_KEY);
  if(currentKey===FLOW_KEY){
    content.innerHTML='<div id="flow-root"></div>';
    if(window.FlowBoard)window.FlowBoard.mount(document.getElementById("flow-root"),currentProject);
    return;
  }
  var section=projectData.sections[currentKey];
  if(!section){content.innerHTML='<div class="card"><div class="empty">栏目不存在</div></div>';return;}
  var status=STEP_KEYS.indexOf(currentKey)>=0?section.status:null;
  var header='<div class="sec-head"><h2>'+escapeHtml(section.title)+'</h2>';
  if(status)header+='<span class="badge '+status+'">'+ICON[status]+' '+STATUS_TEXT[status]+'</span>';
  header+='<div class="sec-actions">';
  if(editMode){header+='<button class="primary" onclick="save(false)">保存 <span class="kbd">Ctrl+S</span></button><button class="ghost" onclick="cancelEdit()">取消</button>';}
  else{header+='<button class="primary" onclick="enterEdit()">编辑</button>';}
  if(status){header+='<div class="tri">'+["todo","draft","done"].map(function(item){return '<button class="seg '+item+(status===item?' active':'')+'" onclick="changeStatus(\''+item+'\')">'+STATUS_TEXT[item]+'</button>';}).join("")+'</div>';}
  header+='</div></div>';
  content.innerHTML='<section class="card">'+header+'<div id="section-body"></div></section>';
  var body=document.getElementById("section-body");
  if(editMode)renderEditor(body,section);else renderView(body,section);
}

function renderView(container,section){
  if(section.kind==="document"){
    var html=documentToHtml(section.document);
    container.innerHTML=html?'<div class="view structured-view">'+html+'</div>':'<div class="empty"><div class="big">✦</div><div class="t">这一部分还没有内容</div><div class="s">点击“编辑”开始设计</div></div>';
    return;
  }
  if(!section.items.length){container.innerHTML='<div class="empty"><div class="big">✦</div><div class="t">还没有'+ITEM_LABELS[currentKey]+'</div><div class="s">点击“编辑”开始添加</div></div>';return;}
  var html='<div class="'+(section.kind==="chapters"?'chapter-grid':'item-list')+'">';
  section.items.forEach(function(item,index){
    var text=documentPlainText(item.document);
    if(section.kind==="chapters"){
      html+='<article class="chapter-card" onclick="openChapter('+index+')"><div class="chapter-card-title">'+escapeHtml(item.title)+'</div><div class="chapter-card-preview">'+escapeHtml(text.slice(0,100)||"（空）")+'</div><div class="chapter-card-meta">'+text.length+' 字符</div></article>';
    }else{
      html+='<article class="item-card"><div class="item-title">'+escapeHtml(item.title)+'</div><div class="item-body view structured-view">'+documentToHtml(item.document)+'</div></article>';
    }
  });
  container.innerHTML=html+'</div>';
}

function renderEditor(container,section){
  if(section.kind==="document"){
    container.innerHTML=editorToolbar()+'<div id="rich-editor" class="rich-editor view" contenteditable="true" role="textbox" aria-multiline="true">'+(documentToHtml(section.document)||'<p><br></p>')+'</div>';
    bindEditor(container.querySelector(".rich-editor"));
    return;
  }
  if(section.kind==="chapters")renderChapterEditor(container);
  else renderItemsEditor(container);
}

function editorToolbar(){
  var colors=COLORS.map(function(color){return '<button type="button" class="annotation-swatch '+color+'" onclick="applyHighlight(\''+color+'\')" title="'+COLOR_LABELS[color]+'标注"></button>';}).join("");
  return '<div class="rich-toolbar">'
    +'<select onchange="formatBlock(this.value);this.value=\'\'" aria-label="段落格式"><option value="">段落格式</option><option value="p">正文</option><option value="h2">二级标题</option><option value="h3">三级标题</option><option value="blockquote">引用</option></select>'
    +'<button type="button" onclick="formatInline(\'bold\')"><b>B</b></button><button type="button" onclick="formatInline(\'italic\')"><i>I</i></button><button type="button" onclick="formatInline(\'strikeThrough\')"><s>S</s></button>'
    +'<button type="button" onclick="formatInline(\'insertUnorderedList\')">• 列表</button><button type="button" onclick="formatInline(\'insertOrderedList\')">1. 列表</button><button type="button" onclick="insertTable()">表格</button>'
    +'<span class="rich-toolbar-spacer"></span><span class="annotation-label">标注</span>'+colors+'<button type="button" class="annotation-clear" onclick="clearHighlight()">清除</button>'
    +'<span id="autosave-tag"></span></div>';
}

function bindEditor(editor){
  editor.addEventListener("input",markDirty);
  editor.addEventListener("focus",function(){activeEditor=editor;});
}

function markDirty(){dirty=true;editRevision++;}

function renderItemsEditor(container){
  var html='<div class="item-toolbar"><button class="primary" onclick="addItem()">＋ '+ITEM_LABELS[currentKey]+'</button></div><div class="item-edit-list">';
  itemDrafts.forEach(function(item,index){
    html+='<article class="item-edit-card"><div class="item-edit-head"><input class="item-title-input" data-index="'+index+'" value="'+escapeHtml(item.title)+'" oninput="updateItemTitle('+index+',this.value)" placeholder="'+ITEM_LABELS[currentKey]+'名称"><button class="item-del-btn" onclick="deleteItem('+index+')">×</button></div>'
      +editorToolbar()+'<div class="rich-editor item-rich-editor view" data-index="'+index+'" contenteditable="true">'+(documentToHtml(item.document)||'<p><br></p>')+'</div></article>';
  });
  container.innerHTML=html+'</div>';
  container.querySelectorAll(".rich-editor").forEach(bindEditor);
}

function renderChapterEditor(container){
  if(editingChapter!==null&&itemDrafts[editingChapter]){
    var chapter=itemDrafts[editingChapter];
    container.innerHTML='<div class="chapter-write"><div class="chapter-write-head"><button class="ghost" onclick="closeChapterEditor()">← 章节列表</button><input class="chapter-title-input" value="'+escapeHtml(chapter.title)+'" oninput="updateItemTitle('+editingChapter+',this.value)"></div>'
      +editorToolbar()+'<div id="chapter-rich-editor" class="rich-editor chapter-rich-editor view" contenteditable="true">'+(documentToHtml(chapter.document)||'<p><br></p>')+'</div></div>';
    bindEditor(container.querySelector(".rich-editor"));
    return;
  }
  var html='<div class="chapter-toolbar"><button class="primary" onclick="addItem()">＋ 新章节</button></div><div class="chapter-grid-edit">';
  itemDrafts.forEach(function(item,index){html+='<article class="chapter-edit-card" onclick="editChapter('+index+')"><div class="chapter-edit-title">'+escapeHtml(item.title)+'</div><div class="chapter-edit-meta">'+documentPlainText(item.document).length+' 字符</div><div class="chapter-edit-actions"><button class="ibtn-sm ibtn-del" onclick="event.stopPropagation();deleteItem('+index+')">×</button></div></article>';});
  container.innerHTML=html+'</div>';
}

function openChapter(index){enterEdit();editingChapter=index;renderContent();}

function editChapter(index){captureEditors();editingChapter=index;renderContent();}

function closeChapterEditor(){captureEditors();editingChapter=null;renderContent();}

function addItem(){
  captureEditors();
  itemDrafts.push({title:"未命名"+ITEM_LABELS[currentKey],document:clone(EMPTY_DOCUMENT)});
  markDirty();
  if(currentKey==="step10")editingChapter=itemDrafts.length-1;
  renderContent();
}

function deleteItem(index){
  if(!confirm("确定删除这个"+ITEM_LABELS[currentKey]+"吗？"))return;
  captureEditors();itemDrafts.splice(index,1);markDirty();editingChapter=null;renderContent();
}

function updateItemTitle(index,value){if(itemDrafts[index]){itemDrafts[index].title=value;markDirty();}}

function captureEditors(){
  if(!editMode)return;
  var section=projectData.sections[currentKey];
  if(!section)return;
  if(section.kind==="items"){
    document.querySelectorAll(".item-rich-editor").forEach(function(editor){var index=Number(editor.dataset.index);if(itemDrafts[index])itemDrafts[index].document=editorToDocument(editor);});
  }else if(section.kind==="chapters"&&editingChapter!==null){
    var editor=document.getElementById("chapter-rich-editor");if(editor&&itemDrafts[editingChapter])itemDrafts[editingChapter].document=editorToDocument(editor);
  }
}

function enterEdit(){
  editMode=true;dirty=false;editRevision=0;savingSection=false;editingChapter=null;
  var section=projectData&&projectData.sections[currentKey];
  itemDrafts=section&&section.kind!=="document"?clone(section.items):[];
  renderContent();
}

function cancelEdit(){editMode=false;dirty=false;editRevision=0;savingSection=false;editingChapter=null;itemDrafts=[];activeEditor=null;renderContent();}

async function save(autosave,force){
  if(!editMode||currentKey===FLOW_KEY||savingSection)return;
  savingSection=true;
  var sentRevision=editRevision;
  var section=projectData.sections[currentKey];
  var payload={project:currentProject,key:currentKey,status:section.status,mtime:force?0:knownMtime};
  if(section.kind==="document"){
    var editor=document.getElementById("rich-editor");
    payload.document=editorToDocument(editor);
  }else{
    captureEditors();
    payload.document=section.document;
    payload.items=itemDrafts.map(function(item){return {id:item.id,title:item.title,document:item.document};});
  }
  try{
    setSaved("保存中…");
    var response=await postJson("/api/section/save",payload);
    var result=await response.json();
    if(response.status===409){pendingConflict=payload;showConflict();return;}
    if(!response.ok)throw new Error(result.error||"保存失败");
    projectData=result.project;knownMtime=projectData.mtime;pendingConflict=null;
    if(sentRevision!==editRevision){
      dirty=true;updateProgress();renderSidebar();renderTimeline();setSaved("有新修改待保存");
      setTimeout(function(){save(true);},80);return;
    }
    dirty=false;
    if(!autosave){editMode=false;editingChapter=null;itemDrafts=[];renderAll();}
    else{
      if(section.kind!=="document")itemDrafts=clone(projectData.sections[currentKey].items);
      updateProgress();renderSidebar();renderTimeline();
    }
    setSaved("已保存 "+formatTime(projectData.saved_at));
    if(!autosave)toast("已保存到数据库");
  }catch(error){setSaved("保存失败",true);toast(error.message,true);}
  finally{savingSection=false;}
}

async function changeStatus(status){
  var section=projectData.sections[currentKey];
  if(!section||savingSection)return;
  savingSection=true;
  var sentRevision=editRevision;
  var payload={project:currentProject,key:currentKey,status:status,mtime:knownMtime};
  if(editMode){
    if(section.kind==="document")payload.document=editorToDocument(document.getElementById("rich-editor"));
    else{captureEditors();payload.document=section.document;payload.items=itemDrafts.map(function(item){return {id:item.id,title:item.title,document:item.document};});}
  }
  try{
    var response=await postJson("/api/section/save",payload);var result=await response.json();
    if(response.status===409){pendingConflict=payload;showConflict();return;}
    if(!response.ok)throw new Error(result.error||"更新失败");
    projectData=result.project;knownMtime=projectData.mtime;
    if(editMode&&sentRevision!==editRevision){
      dirty=true;updateProgress();renderSidebar();renderTimeline();setSaved("有新修改待保存");
      setTimeout(function(){save(true);},80);
    }else{
      dirty=false;
      if(editMode&&section.kind!=="document")itemDrafts=clone(projectData.sections[currentKey].items);
      renderAll();
    }
    toast("已标记为"+STATUS_TEXT[status]);
  }catch(error){toast(error.message,true);}
  finally{savingSection=false;}
}

function showConflict(){
  if(document.getElementById("conflict-modal"))return;
  var modal=document.createElement("div");modal.id="conflict-modal";
  modal.innerHTML='<div class="modal-box"><h3>作品已在其他页面更新</h3><p>刷新可保留另一页面的版本；覆盖会使用当前编辑内容。</p><div class="btns"><button class="ghost" onclick="reloadAfterConflict()">刷新</button><button class="danger" onclick="overwriteConflict()">覆盖保存</button></div></div>';
  document.body.appendChild(modal);
}

async function overwriteConflict(){
  var modal=document.getElementById("conflict-modal");if(modal)modal.remove();
  if(!pendingConflict)return;
  pendingConflict.mtime=0;
  try{
    var response=await postJson("/api/section/save",pendingConflict);var result=await response.json();
    if(!response.ok)throw new Error(result.error||"覆盖失败");
    projectData=result.project;knownMtime=projectData.mtime;pendingConflict=null;dirty=false;editMode=false;renderAll();toast("已覆盖保存");
  }catch(error){toast(error.message,true);}
}

async function reloadAfterConflict(){var modal=document.getElementById("conflict-modal");if(modal)modal.remove();pendingConflict=null;editMode=false;dirty=false;await loadProject();}

function cleanInlineHtml(source){
  var template=document.createElement("template");template.innerHTML=source||"";
  function walk(node){
    if(node.nodeType===Node.TEXT_NODE)return escapeHtml(node.nodeValue);
    if(node.nodeType!==Node.ELEMENT_NODE)return "";
    var tag=node.tagName.toLowerCase();
    var aliases={b:"strong",i:"em",del:"s",strike:"s"};tag=aliases[tag]||tag;
    var inner=Array.prototype.map.call(node.childNodes,walk).join("");
    if(tag==="br")return "<br>";
    if(["strong","em","s","u","code"].indexOf(tag)>=0)return "<"+tag+">"+inner+"</"+tag+">";
    if(tag==="mark"){
      var color=node.getAttribute("data-color");if(COLORS.indexOf(color)<0)color="yellow";
      return '<mark data-color="'+color+'">'+inner+'</mark>';
    }
    return inner;
  }
  return Array.prototype.map.call(template.content.childNodes,walk).join("");
}

function editorToDocument(editor){
  if(!editor)return clone(EMPTY_DOCUMENT);
  var blocks=[];
  Array.prototype.forEach.call(editor.childNodes,function(node){
    if(node.nodeType===Node.TEXT_NODE){if(node.nodeValue.trim())blocks.push({type:"paragraph",html:escapeHtml(node.nodeValue)});return;}
    if(node.nodeType!==Node.ELEMENT_NODE)return;
    var tag=node.tagName.toLowerCase();
    if(/^h[1-6]$/.test(tag)){blocks.push({type:"heading",level:Number(tag.slice(1)),html:cleanInlineHtml(node.innerHTML)});}
    else if(tag==="blockquote"){blocks.push({type:"quote",html:cleanInlineHtml(node.innerHTML)});}
    else if(tag==="ul"||tag==="ol"){
      var items=[];node.querySelectorAll(":scope > li").forEach(function(item){items.push({html:cleanInlineHtml(item.innerHTML)});});
      blocks.push({type:tag==="ol"?"ordered_list":"unordered_list",items:items});
    }else if(tag==="table"){
      var rows=[];var hasHeader=!!node.querySelector("th");
      node.querySelectorAll("tr").forEach(function(row){rows.push(Array.prototype.map.call(row.querySelectorAll(":scope > th,:scope > td"),function(cell){return cleanInlineHtml(cell.innerHTML);}));});
      blocks.push({type:"table",header:hasHeader,align:[],rows:rows});
    }else if(tag==="hr"){blocks.push({type:"divider"});}
    else{blocks.push({type:"paragraph",html:cleanInlineHtml(node.innerHTML)});}
  });
  return {version:DOCUMENT_VERSION,blocks:blocks};
}

function documentToHtml(documentValue){
  var documentData=documentValue&&Array.isArray(documentValue.blocks)?documentValue:EMPTY_DOCUMENT;
  return documentData.blocks.map(function(block){
    if(block.type==="heading"){var level=Math.max(1,Math.min(6,Number(block.level)||2));return "<h"+level+">"+(block.html||"")+"</h"+level+">";}
    if(block.type==="paragraph")return "<p>"+(block.html||"<br>")+"</p>";
    if(block.type==="quote")return "<blockquote>"+(block.html||"")+"</blockquote>";
    if(block.type==="divider")return "<hr>";
    if(block.type==="unordered_list"||block.type==="ordered_list"){
      var tag=block.type==="ordered_list"?"ol":"ul";return "<"+tag+">"+(block.items||[]).map(function(item){return "<li>"+(item.html||"")+"</li>";}).join("")+"</"+tag+">";
    }
    if(block.type==="table"){
      var rows=block.rows||[];var html="<table>";rows.forEach(function(row,index){var cellTag=block.header&&index===0?"th":"td";html+="<tr>"+row.map(function(cell){return "<"+cellTag+">"+cell+"</"+cellTag+">";}).join("")+"</tr>";});return html+"</table>";
    }
    return "";
  }).join("");
}

function documentPlainText(documentValue){
  var wrapper=document.createElement("div");wrapper.innerHTML=documentToHtml(documentValue);return wrapper.textContent||"";
}

function formatInline(command){if(!activeEditor)return;activeEditor.focus();document.execCommand(command,false,null);markDirty();}

function formatBlock(tag){if(!activeEditor||!tag)return;activeEditor.focus();document.execCommand("formatBlock",false,tag);markDirty();}

function insertTable(){
  if(!activeEditor)return;activeEditor.focus();
  document.execCommand("insertHTML",false,'<table><tr><th>标题</th><th>标题</th></tr><tr><td>内容</td><td>内容</td></tr></table><p><br></p>');markDirty();
}

function selectionInsideEditor(){
  var selection=window.getSelection();if(!activeEditor||!selection||!selection.rangeCount||selection.isCollapsed)return null;
  var range=selection.getRangeAt(0);if(!activeEditor.contains(range.commonAncestorContainer))return null;return range;
}

function applyHighlight(color){
  var range=selectionInsideEditor();if(!range){toast("请先在编辑区选择文字",true);return;}
  try{var fragment=range.extractContents();var mark=document.createElement("mark");mark.dataset.color=color;mark.appendChild(fragment);range.insertNode(mark);markDirty();}catch(error){toast("请在同一段内选择文字",true);}
}

function clearHighlight(){
  var range=selectionInsideEditor();if(!range){toast("请先选择要清除标注的文字",true);return;}
  var marks=activeEditor.querySelectorAll("mark[data-color]");var changed=false;
  marks.forEach(function(mark){if(range.intersectsNode(mark)){mark.replaceWith.apply(mark,Array.from(mark.childNodes));changed=true;}});
  if(changed)markDirty();
}

function updateProgress(){
  if(!projectData)return;var progress=projectData.stats.progress;
  document.getElementById("progress-fill").style.width=progress.percent+"%";
  document.getElementById("progress-pct").textContent=progress.percent+"%";
  document.getElementById("global-stats").innerHTML='<span class="gs-item"><span class="gs-label">全文字符</span><span class="gs-val">'+projectData.stats.total_chars+'</span></span><span class="gs-item"><span class="gs-label">已完成</span><span class="gs-val">'+progress.done+'/'+progress.total+'</span></span>';
}

function toggleSearch(){var panel=document.getElementById("search-panel");var open=panel.classList.toggle("open");if(open)document.getElementById("search-input").focus();}
function onSearchKey(event){if(event.key==="Enter")doSearch();if(event.key==="Escape")toggleSearch();}
async function doSearch(){
  var query=document.getElementById("search-input").value.trim();var target=document.getElementById("search-results");if(!query){target.innerHTML="";return;}
  try{var data=await getJson("/api/search?project="+encodeURIComponent(currentProject)+"&q="+encodeURIComponent(query));target.innerHTML=data.results.length?data.results.map(function(item){return '<button class="sr-item" onclick="goSearchResult(\''+item.key+'\')"><span class="sr-title">'+escapeHtml(item.title)+'</span><span class="sr-snippet">'+escapeHtml(item.snippet)+'</span></button>';}).join(""):'<div class="sr-empty">没有找到相关内容</div>';}
  catch(error){target.innerHTML='<div class="sr-empty">搜索失败</div>';}
}
function goSearchResult(key){currentKey=key;editMode=false;renderAll();toggleSearch();}

async function poll(){
  if(!currentProject||editMode)return;
  var reconnecting=serverDisconnected;
  try{
    var result=await getJson("/api/project/mtime?project="+encodeURIComponent(currentProject));
    serverDisconnected=false;
    if(reconnecting){await loadProject();toast("本地服务已恢复");return;}
    if(result.mtime>knownMtime+0.001)showBanner();
  }catch(ignore){}
}
async function reloadProject(){hideBanner();editMode=false;dirty=false;editRevision=0;savingSection=false;await loadProject();}
function showBanner(){document.getElementById("ext-banner").classList.add("show");}
function hideBanner(){document.getElementById("ext-banner").classList.remove("show");}

async function openSettings(){
  try{var settings=await getJson("/api/settings");document.getElementById("settings-db").value=settings.database||"";document.getElementById("settings-port").value=settings.port;document.getElementById("settings-password").value="";document.getElementById("settings-password").placeholder=settings.password_set?"已设置；留空表示不修改":"留空表示不启用密码";document.getElementById("settings-clear-password").checked=false;document.getElementById("settings-modal").classList.add("show");}catch(error){toast(error.message,true);}
}
function closeSettings(){document.getElementById("settings-modal").classList.remove("show");}
async function saveSettings(){
  var payload={port:Number(document.getElementById("settings-port").value)};var password=document.getElementById("settings-password").value;var clear=document.getElementById("settings-clear-password").checked;if(clear)payload.password="";else if(password)payload.password=password;
  try{var response=await postJson("/api/settings",payload);var result=await response.json();if(!response.ok)throw new Error(result.error||"保存失败");PASSWORD_REQUIRED=!!result.auth_required;document.getElementById("lock-btn").style.display=PASSWORD_REQUIRED?"":"none";closeSettings();toast(result.restart_required?"设置已保存，端口重启后生效":"设置已保存");if(password&&!clear)setTimeout(showLogin,500);}catch(error){toast(error.message,true);}
}

function initTheme(){applyTheme(localStorage.getItem("sf_theme")||"green");}
function applyTheme(theme){if(THEMES.indexOf(theme)<0)theme="green";document.documentElement.dataset.theme=theme;localStorage.setItem("sf_theme",theme);var button=document.getElementById("theme-toggle");if(button){button.textContent=THEME_ICONS[theme];button.title="切换主题（当前："+THEME_LABELS[theme]+"）";}}
function toggleTheme(){var current=document.documentElement.dataset.theme||"green";var next=THEMES[(THEMES.indexOf(current)+1)%THEMES.length];applyTheme(next);toast(THEME_LABELS[next]);}
function toggleSidebar(){var open=document.getElementById("sidebar").classList.toggle("open");document.getElementById("sidebar-backdrop").classList.toggle("show",open);document.getElementById("menu-btn").setAttribute("aria-expanded",String(open));}
function closeSidebar(){document.getElementById("sidebar").classList.remove("open");document.getElementById("sidebar-backdrop").classList.remove("show");document.getElementById("menu-btn").setAttribute("aria-expanded","false");}

function formatTime(value){return value&&value.length>=16?value.slice(11,16):"";}
function setSaved(text,error){var target=document.getElementById("saved-tag");target.textContent=text;target.classList.toggle("error",!!error);}
function toast(message,error){var target=document.getElementById("toast");target.textContent=message;target.className="toast show"+(error?" err":"");clearTimeout(target._timer);target._timer=setTimeout(function(){target.className="toast";},2600);}

function onKeydown(event){
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="s"){event.preventDefault();if(editMode)save(false);else if(currentKey===FLOW_KEY&&window.FlowBoard)window.FlowBoard.flush();}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="f"){event.preventDefault();toggleSearch();}
  if(event.key==="Escape"&&document.getElementById("rename-project-modal").classList.contains("show")){closeRenameProject();return;}
  if(event.key==="Escape"&&document.getElementById("delete-project-modal").classList.contains("show")){closeDeleteProject();return;}
  if(event.key==="Escape"&&editMode)cancelEdit();
}

window.newProject=newProject;
window.openRenameProject=openRenameProject;
window.closeRenameProject=closeRenameProject;
window.updateRenameProject=updateRenameProject;
window.confirmRenameProject=confirmRenameProject;
window.openDeleteProject=openDeleteProject;
window.closeDeleteProject=closeDeleteProject;
window.advanceDeleteProject=advanceDeleteProject;
window.updateDeleteConfirmation=updateDeleteConfirmation;
window.confirmDeleteProject=confirmDeleteProject;
window.importDatabase=importDatabase;
window.enterEdit=enterEdit;
window.cancelEdit=cancelEdit;
window.save=save;
window.changeStatus=changeStatus;
window.openChapter=openChapter;
window.editChapter=editChapter;
window.closeChapterEditor=closeChapterEditor;
window.addItem=addItem;
window.deleteItem=deleteItem;
window.updateItemTitle=updateItemTitle;
window.formatInline=formatInline;
window.formatBlock=formatBlock;
window.insertTable=insertTable;
window.applyHighlight=applyHighlight;
window.clearHighlight=clearHighlight;
window.overwriteConflict=overwriteConflict;
window.reloadAfterConflict=reloadAfterConflict;
window.toggleSearch=toggleSearch;
window.onSearchKey=onSearchKey;
window.doSearch=doSearch;
window.goSearchResult=goSearchResult;
window.reloadProject=reloadProject;
window.openSettings=openSettings;
window.closeSettings=closeSettings;
window.saveSettings=saveSettings;
window.toggleTheme=toggleTheme;
window.SnowflakeAPI={getJson:getJson,postJson:postJson,toast:toast,textToHtml:textToHtml,escapeHtml:escapeHtml};

init();
})();
