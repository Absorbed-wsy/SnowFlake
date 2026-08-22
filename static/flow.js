(function(){
"use strict";

var DEFAULT_LANE_HEIGHT = 520;
var MIN_LANE_HEIGHT = 280;
var MAX_LANE_HEIGHT = 1200;
var NODE_HEIGHT = 118;
var MIN_STAGE_WIDTH = 6000;
var MIN_STAGE_HEIGHT = 2000;
var STAGE_PADDING_X = 1200;
var STAGE_PADDING_Y = 700;
var TYPE_LABELS = {event:"事件",clue:"线索",turn:"转折",crisis:"危机",climax:"高潮",foreshadow:"伏笔",payoff:"回收"};
var STATUS_LABELS = {idea:"设想",draft:"草案",fixed:"确定"};
var EDGE_LABELS = {advance:"推进",cause:"因果",foreshadow:"伏笔回收",conflict:"冲突",branch:"分支",merge:"汇合"};
var COLORS = ["neutral","yellow","red","green","blue","purple"];
var COLOR_LABELS = {neutral:"跟随分轨",yellow:"黄色",red:"红色",green:"绿色",blue:"蓝色",purple:"紫色"};
var SECTION_LABELS = {
  "":"不关联",preamble:"标题与简介",step0:"第0步 · 核心",step1:"第1步 · 一句话",step2:"第2步 · 一段话",
  step3:"第3步 · 人物",step4:"第4步 · 一页大纲",step5:"第5步 · 人物大纲",step6:"第6步 · 四页大纲",
  step7:"第7步 · 人物宝典",step8:"第8步 · 场景清单",step9:"第9步 · 场景双模式",step10:"第10步 · 写作"
};

var root = null;
var projectName = "";
var flow = null;
var mtime = 0;
var selected = null;
var connectFrom = null;
var connectMode = false;
var dirty = false;
var saving = false;
var saveAgain = false;
var savePromise = null;
var saveTimer = null;
var pollTimer = null;
var viewportTimer = null;
var revision = 0;
var mountToken = 0;
var history = [];
var historyIndex = -1;
var externalChanged = false;

function api(){ return window.SnowflakeAPI; }
function esc(s){ return api() ? api().escapeHtml(s == null ? "" : String(s)) : String(s || ""); }
function clone(value){ return JSON.parse(JSON.stringify(value)); }
function uid(prefix){ return prefix+"-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8); }
function byId(id){ return flow && flow.nodes.find(function(n){return n.id===id;}); }
function edgeById(id){ return flow && flow.edges.find(function(e){return e.id===id;}); }
function laneById(id){ return flow && flow.lanes.find(function(l){return l.id===id;}); }
function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function laneHeight(lane){ return clamp(Number(lane&&lane.height)||DEFAULT_LANE_HEIGHT,MIN_LANE_HEIGHT,MAX_LANE_HEIGHT); }
function laneTopByIndex(index){
  var top=0;
  for(var i=0;i<index;i++)top+=laneHeight(flow.lanes[i]);
  return top;
}
function laneTop(id){
  var idx=flow.lanes.findIndex(function(l){return l.id===id;});
  return laneTopByIndex(Math.max(0,idx));
}
function laneIndexAt(y){
  var top=0;
  for(var i=0;i<flow.lanes.length;i++){
    top+=laneHeight(flow.lanes[i]);
    if(y<top)return i;
  }
  return flow.lanes.length-1;
}
function totalLaneHeight(){ return flow.lanes.reduce(function(sum,lane){return sum+laneHeight(lane);},0); }

function mount(el, project){
  mountToken++;
  var token = mountToken;
  clearTimers();
  root = el;
  projectName = project;
  selected = null;
  connectFrom = null;
  connectMode = false;
  dirty = false;
  externalChanged = false;
  renderLoading();
  api().getJson("/api/flow?project="+encodeURIComponent(projectName)).then(function(result){
    if(token !== mountToken || !root) return;
    flow = result.flow;
    mtime = result.mtime || 0;
    history = [JSON.stringify(flow)];
    historyIndex = 0;
    renderShell();
    startPoll();
  }).catch(function(){
    if(token !== mountToken || !root) return;
    root.innerHTML = '<div class="flow-error"><strong>走向图加载失败</strong><span>请检查本地服务后重试。</span><button onclick="FlowBoard.reload()">重新加载</button></div>';
  });
}

function renderLoading(){
  if(root) root.innerHTML = '<div class="flow-loading"><span class="flow-loading-icon">⌁</span><span>正在加载故事走向图…</span></div>';
}

function clearTimers(){
  if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}
  if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
  if(viewportTimer){clearTimeout(viewportTimer);viewportTimer=null;}
}

function unmount(){
  clearTimers();
  mountToken++;
  root = null;
}

function reset(){
  clearTimers();
  mountToken++;
  root = null;
  projectName = "";
  flow = null;
  selected = null;
  dirty = false;
}

function reload(){
  if(!root || !projectName) return;
  if(dirty&&!confirm("刷新会放弃当前未保存的走向图修改，确定继续？"))return;
  mount(root,projectName);
}

function renderShell(){
  if(!root || !flow) return;
  root.innerHTML = ''+
    '<div class="flow-shell">'+
      '<div class="flow-toolbar">'+
        '<div class="flow-title"><h2>故事走向图</h2><span id="flow-count"></span></div>'+
        '<div class="flow-toolbar-group primary-tools">'+
          '<button class="primary" data-action="add-node">＋ 节点</button>'+
          '<button data-action="connect">↗ 连线</button>'+
          '<button data-action="lanes">☷ 分轨</button>'+
        '</div>'+
        '<div class="flow-toolbar-group">'+
          '<button class="ibtn-sm" data-action="undo" title="撤销 Ctrl+Z">↶</button>'+
          '<button class="ibtn-sm" data-action="redo" title="重做 Ctrl+Y">↷</button>'+
          '<button data-action="layout" title="按分轨和当前先后顺序排列">自动排列</button>'+
        '</div>'+
        '<div class="flow-toolbar-group zoom-tools">'+
          '<button class="ibtn-sm" data-action="zoom-out" title="缩小">−</button>'+
          '<span id="flow-zoom">100%</span>'+
          '<button class="ibtn-sm" data-action="zoom-in" title="放大">＋</button>'+
          '<button data-action="fit" title="缩放并居中显示全部节点（Ctrl+0）">适应内容</button>'+
        '</div>'+
        '<button class="flow-save-state" id="flow-save-state" data-action="reload-external">已保存</button>'+
      '</div>'+
      '<div class="flow-mode-tip" id="flow-mode-tip"></div>'+
      '<div class="flow-workspace">'+
        '<div class="flow-board" id="flow-board" tabindex="0" aria-label="故事走向图画布">'+
          '<div class="flow-stage-space" id="flow-stage-space">'+
            '<div class="flow-stage" id="flow-stage">'+
              '<div class="flow-lane-layer" id="flow-lanes"></div>'+
              '<svg class="flow-edge-layer" id="flow-edges" aria-label="节点连线"></svg>'+
              '<div class="flow-node-layer" id="flow-nodes"></div>'+
            '</div>'+
          '</div>'+
          '<div class="flow-empty" id="flow-empty"><strong>从第一个关键节点开始</strong><span>新增节点后拖动排列，再用“连线”建立剧情走向。</span><button class="primary" data-action="empty-add">＋ 新建节点</button></div>'+
        '</div>'+
        '<section class="flow-inspector" id="flow-inspector"></section>'+
      '</div>'+
    '</div>';
  bindToolbar();
  bindBoard();
  renderAll();
  var board = document.getElementById("flow-board");
  if(board){
    board.scrollLeft = (flow.viewport && flow.viewport.x) || 0;
    board.scrollTop = (flow.viewport && flow.viewport.y) || 0;
  }
}

function bindToolbar(){
  root.querySelector('[data-action="add-node"]').onclick = addNode;
  root.querySelector('[data-action="empty-add"]').onclick = addNode;
  root.querySelector('[data-action="connect"]').onclick = toggleConnect;
  root.querySelector('[data-action="lanes"]').onclick = function(){selected={kind:"lanes"};renderInspector();};
  root.querySelector('[data-action="undo"]').onclick = undo;
  root.querySelector('[data-action="redo"]').onclick = redo;
  root.querySelector('[data-action="layout"]').onclick = autoLayout;
  root.querySelector('[data-action="zoom-out"]').onclick = function(){setZoom(currentZoom()-0.1);};
  root.querySelector('[data-action="zoom-in"]').onclick = function(){setZoom(currentZoom()+0.1);};
  root.querySelector('[data-action="fit"]').onclick = fitContent;
  root.querySelector('[data-action="reload-external"]').onclick = function(){if(externalChanged) reload();};
}

function bindBoard(){
  var board = boardEl();
  board.addEventListener("click", function(e){
    if(e.target.closest(".flow-node") || e.target.closest(".flow-edge-hit")) return;
    if(connectMode){connectFrom=null;updateConnectUI();return;}
    selected=null;renderSelection();renderInspector();
  });
  board.addEventListener("scroll", function(){
    if(viewportTimer) clearTimeout(viewportTimer);
    viewportTimer=setTimeout(function(){captureViewport(true);},180);
  });
  board.addEventListener("wheel", function(e){
    if(!e.ctrlKey) return;
    e.preventDefault();
    setZoom(currentZoom()+(e.deltaY<0?0.1:-0.1));
  },{passive:false});
  board.addEventListener("keydown", function(e){
    if(e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
    if(e.key === "Escape" && connectMode){connectMode=false;connectFrom=null;updateConnectUI();e.preventDefault();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){e.preventDefault();undo();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="y"){e.preventDefault();redo();return;}
    if((e.ctrlKey||e.metaKey)&&e.key==="0"){e.preventDefault();fitContent();return;}
    if((e.ctrlKey||e.metaKey)&&(e.key==="+"||e.key==="=")){e.preventDefault();setZoom(currentZoom()+0.1);return;}
    if((e.ctrlKey||e.metaKey)&&e.key==="-"){e.preventDefault();setZoom(currentZoom()-0.1);return;}
    if((e.key === "Delete" || e.key === "Backspace") && selected){e.preventDefault();deleteSelected();}
  });
  board.addEventListener("pointerdown", startPan);
}

function boardEl(){ return root && root.querySelector("#flow-board"); }
function stageEl(){ return root && root.querySelector("#flow-stage"); }
function currentZoom(){ return flow && flow.viewport ? Number(flow.viewport.zoom)||1 : 1; }

function stageWidth(){
  var max = MIN_STAGE_WIDTH;
  flow.nodes.forEach(function(node){max=Math.max(max,Number(node.x)+Number(node.width||220)+STAGE_PADDING_X);});
  return Math.ceil(max);
}

function stageHeight(){
  var max = Math.max(MIN_STAGE_HEIGHT,totalLaneHeight()+STAGE_PADDING_Y);
  flow.nodes.forEach(function(node){max=Math.max(max,Number(node.y)+NODE_HEIGHT+STAGE_PADDING_Y);});
  return Math.ceil(max);
}

function renderAll(){
  if(!root || !flow) return;
  renderStageSize();
  renderLanes();
  renderNodes();
  renderEdges();
  renderInspector();
  updateToolbar();
  updateEmpty();
}

function renderStageSize(){
  var zoom=currentZoom(), w=stageWidth(), h=stageHeight();
  var stage=stageEl(), space=root.querySelector("#flow-stage-space"), svg=root.querySelector("#flow-edges");
  stage.style.width=w+"px";stage.style.height=h+"px";stage.style.transform="scale("+zoom+")";
  space.style.width=(w*zoom)+"px";space.style.height=(h*zoom)+"px";
  svg.setAttribute("viewBox","0 0 "+w+" "+h);svg.setAttribute("width",w);svg.setAttribute("height",h);
  root.querySelector("#flow-zoom").textContent=Math.round(zoom*100)+"%";
}

function renderLanes(){
  var layer=root.querySelector("#flow-lanes");
  layer.innerHTML=flow.lanes.map(function(lane,idx){
    var height=laneHeight(lane),top=laneTopByIndex(idx);
    return '<div class="flow-lane color-'+esc(lane.color)+'" style="top:'+top+'px;height:'+height+'px">'
      +'<span class="flow-lane-name">'+esc(lane.name)+'</span><span class="flow-lane-hint">可放置多层分支 · '+height+'px</span>'
      +'<button type="button" class="flow-lane-resize" data-resize-lane="'+esc(lane.id)+'" title="上下拖动调整「'+esc(lane.name)+'」高度" aria-label="调整'+esc(lane.name)+'高度"><i></i></button></div>';
  }).join("");
  layer.querySelectorAll("[data-resize-lane]").forEach(function(handle){
    handle.onpointerdown=function(e){startLaneResize(e,handle.dataset.resizeLane);};
  });
}

function renderNodes(){
  var layer=root.querySelector("#flow-nodes");
  layer.innerHTML=flow.nodes.map(function(node){
    var lane=laneById(node.lane);
    var effectiveColor=node.color&&node.color!=="neutral"?node.color:(lane&&lane.color!=="neutral"?lane.color:"blue");
    var isSelected=selected&&selected.kind==="node"&&selected.id===node.id;
    var isSource=connectMode&&connectFrom===node.id;
    var tags=(node.tags||[]).slice(0,2).map(function(t){return '<span>'+esc(t)+'</span>';}).join("");
    return '<article class="flow-node color-'+esc(effectiveColor)+(node.color==="neutral"?' inherits-lane':'')+' '+(isSelected?'selected ':'')+(isSource?'connect-source':'')+'" data-node-id="'+esc(node.id)+'" tabindex="0" title="'+(node.color==="neutral"?'跟随分轨颜色：'+esc(COLOR_LABELS[effectiveColor]||effectiveColor):'节点独立颜色：'+esc(COLOR_LABELS[effectiveColor]||effectiveColor))+'" '
      +'style="left:'+Number(node.x)+'px;top:'+Number(node.y)+'px;width:'+Number(node.width||220)+'px">'
      +'<div class="flow-node-top"><span class="flow-node-type">'+esc(TYPE_LABELS[node.type]||"事件")+'</span><span class="flow-node-status status-'+esc(node.status)+'">'+esc(STATUS_LABELS[node.status]||"设想")+'</span></div>'
      +'<h3>'+esc(node.title)+'</h3><p>'+esc(node.summary||"（暂无摘要）")+'</p>'
      +'<div class="flow-node-meta"><span>'+esc(lane?lane.name:"未分轨")+'</span>'+(node.volume?'<span>'+esc(node.volume)+'</span>':'')+tags+'</div>'
      +'<span class="flow-node-port in"></span><span class="flow-node-port out"></span></article>';
  }).join("");
  layer.querySelectorAll(".flow-node").forEach(function(el){
    el.onclick=function(e){e.stopPropagation();onNodeClick(el.dataset.nodeId);};
    el.ondblclick=function(e){e.stopPropagation();selected={kind:"node",id:el.dataset.nodeId};renderSelection();renderInspector();var input=root.querySelector('[data-field="title"]');if(input){input.focus();input.select();}};
    el.onpointerdown=function(e){startNodeDrag(e,el.dataset.nodeId,el);};
    el.onkeydown=function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();onNodeClick(el.dataset.nodeId);}};
  });
}

function edgePath(edge){
  var from=byId(edge.from),to=byId(edge.to);
  if(!from||!to)return "";
  var sx=Number(from.x)+Number(from.width||220), sy=Number(from.y)+58;
  var tx=Number(to.x), ty=Number(to.y)+58;
  var bend=Math.max(70,Math.abs(tx-sx)*0.45);
  if(tx>=sx) return "M "+sx+" "+sy+" C "+(sx+bend)+" "+sy+", "+(tx-bend)+" "+ty+", "+tx+" "+ty;
  var offset=90+Math.abs(ty-sy)*0.25;
  return "M "+sx+" "+sy+" C "+(sx+offset)+" "+(sy+offset)+", "+(tx-offset)+" "+(ty+offset)+", "+tx+" "+ty;
}

function renderEdges(){
  var svg=root.querySelector("#flow-edges");
  var defs='<defs><marker id="flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker></defs>';
  var html=defs;
  flow.edges.forEach(function(edge){
    var d=edgePath(edge);if(!d)return;
    var from=byId(edge.from),to=byId(edge.to);
    var mx=(Number(from.x)+Number(from.width||220)+Number(to.x))/2;
    var my=(Number(from.y)+Number(to.y))/2+50;
    var active=selected&&selected.kind==="edge"&&selected.id===edge.id;
    html+='<g class="flow-edge-group color-'+esc(edge.color)+(active?' selected':'')+'" data-edge-id="'+esc(edge.id)+'">'
      +'<path class="flow-edge" d="'+d+'" marker-end="url(#flow-arrow)"></path>'
      +'<path class="flow-edge-hit" d="'+d+'" data-edge-id="'+esc(edge.id)+'"></path>'
      +(edge.label?'<text x="'+mx+'" y="'+my+'" text-anchor="middle">'+esc(edge.label)+'</text>':'')+'</g>';
  });
  svg.innerHTML=html;
  svg.querySelectorAll(".flow-edge-hit").forEach(function(path){
    path.onclick=function(e){e.stopPropagation();selected={kind:"edge",id:path.dataset.edgeId};renderSelection();renderInspector();};
  });
}

function renderSelection(){
  if(!root)return;
  root.querySelectorAll(".flow-node").forEach(function(el){el.classList.toggle("selected",selected&&selected.kind==="node"&&selected.id===el.dataset.nodeId);});
  root.querySelectorAll(".flow-edge-group").forEach(function(el){el.classList.toggle("selected",selected&&selected.kind==="edge"&&selected.id===el.dataset.edgeId);});
}

function updateEmpty(){
  root.querySelector("#flow-empty").classList.toggle("show",flow.nodes.length===0);
  root.querySelector("#flow-count").textContent=flow.nodes.length+" 个节点 · "+flow.edges.length+" 条连线";
}

function updateToolbar(){
  var connect=root.querySelector('[data-action="connect"]');
  connect.classList.toggle("active",connectMode);
  root.querySelector('[data-action="undo"]').disabled=historyIndex<=0;
  root.querySelector('[data-action="redo"]').disabled=historyIndex>=history.length-1;
  updateConnectUI();
  updateSaveState();
}

function updateConnectUI(){
  if(!root)return;
  var tip=root.querySelector("#flow-mode-tip");
  if(!connectMode){tip.classList.remove("show");tip.textContent="";return;}
  tip.classList.add("show");
  tip.textContent=connectFrom?"已选择起点，请点击终点节点；按 Esc 退出连线模式。":"连线模式：请先点击起点节点。";
  root.querySelectorAll(".flow-node").forEach(function(el){el.classList.toggle("connect-source",connectFrom===el.dataset.nodeId);});
}

function updateSaveState(text,kind){
  if(!root)return;
  var el=root.querySelector("#flow-save-state");
  if(text){el.textContent=text;el.className="flow-save-state "+(kind||"");return;}
  if(externalChanged){el.textContent="外部有更新 · 刷新";el.className="flow-save-state warning";return;}
  if(saving){el.textContent="保存中…";el.className="flow-save-state saving";return;}
  if(dirty){el.textContent="等待保存";el.className="flow-save-state pending";return;}
  el.textContent="已保存";el.className="flow-save-state";
}

function renderInspector(){
  var panel=root.querySelector("#flow-inspector");
  if(!selected){renderOverview(panel);return;}
  if(selected.kind==="lanes"){renderLaneManager(panel);return;}
  if(selected.kind==="node"){
    var node=byId(selected.id);if(!node){selected=null;renderOverview(panel);return;}
    renderNodeInspector(panel,node);return;
  }
  if(selected.kind==="edge"){
    var edge=edgeById(selected.id);if(!edge){selected=null;renderOverview(panel);return;}
    renderEdgeInspector(panel,edge);return;
  }
}

function renderOverview(panel){
  panel.innerHTML='<div class="flow-inspector-empty"><span class="big">⌁</span><h3>走向图编辑</h3><p>点击节点或连线可编辑详情。拖动空白区域平移，Ctrl + 滚轮缩放；同一剧情分轨内可自由排布多层分支。</p>'
    +'<div class="flow-legend"><strong>节点类型</strong>'
    +Object.keys(TYPE_LABELS).map(function(k){return '<span><i class="type-'+k+'"></i>'+TYPE_LABELS[k]+'</span>';}).join("")+'</div>'
    +'<button data-overview-lanes>管理剧情分轨</button></div>';
  panel.querySelector("[data-overview-lanes]").onclick=function(){selected={kind:"lanes"};renderInspector();};
}

function annotationButtons(){
  return '<div class="annotation-tools flow-annotation-tools" role="group" aria-label="详情重点标注">'
    +["yellow","red","green","blue","purple"].map(function(c){return '<button type="button" class="annotation-swatch '+c+'" data-ann="'+c+'" title="'+COLOR_LABELS[c]+'标注" aria-label="'+COLOR_LABELS[c]+'标注"></button>';}).join("")
    +'<button type="button" class="annotation-clear" data-ann="clear">清除</button></div>';
}

function renderNodeInspector(panel,node){
  panel.innerHTML='<div class="flow-inspector-head"><div><span>剧情节点</span><h3>'+esc(node.title)+'</h3></div><button class="ibtn-sm" data-close title="关闭详情">×</button></div>'
    +'<div class="flow-form">'
    +fieldInput("标题","title",node.title)
    +fieldTextarea("卡片摘要","summary",node.summary,3)
    +'<div class="flow-form-row">'+fieldSelect("类型","type",node.type,TYPE_LABELS)+fieldSelect("状态","status",node.status,STATUS_LABELS)+'</div>'
    +'<div class="flow-form-row">'+laneSelect(node.lane)+fieldInput("所属卷 / 阶段","volume",node.volume)+'</div>'
    +fieldSelect("关联设计步骤","linked_section",node.linked_section,SECTION_LABELS)
    +fieldInput("标签（用逗号分隔）","tags",(node.tags||[]).join(", "))
    +'<label class="flow-field"><span>节点颜色（默认跟随所属分轨）</span><div class="flow-color-options">'+colorButtons(node.color,"node-color")+'</div></label>'
    +'<label class="flow-field flow-details-field"><span>详细说明</span>'+annotationButtons()+'<textarea data-field="details" rows="8" placeholder="补充因果、伏笔、人物选择等详细说明…">'+esc(node.details)+'</textarea></label>'
    +'<div class="flow-details-preview view" id="flow-details-preview">'+(api().textToHtml(node.details)||'<span class="flow-preview-empty">详细说明预览</span>')+'</div>'
    +'<div class="flow-inspector-actions"><button data-duplicate>复制节点</button><button class="danger" data-delete>删除节点</button></div></div>';
  panel.querySelector("[data-close]").onclick=function(){selected=null;renderSelection();renderInspector();};
  bindNodeFields(panel,node);
  panel.querySelectorAll("[data-ann]").forEach(function(btn){btn.onclick=function(){window.applyAnnotation(btn.dataset.ann);};});
  panel.querySelector("[data-duplicate]").onclick=function(){duplicateNode(node);};
  panel.querySelector("[data-delete]").onclick=function(){deleteNode(node.id);};
}

function fieldInput(label,name,value){return '<label class="flow-field"><span>'+label+'</span><input data-field="'+name+'" value="'+esc(value)+'"></label>';}
function fieldTextarea(label,name,value,rows){return '<label class="flow-field"><span>'+label+'</span><textarea data-field="'+name+'" rows="'+rows+'">'+esc(value)+'</textarea></label>';}
function fieldSelect(label,name,value,options){
  return '<label class="flow-field"><span>'+label+'</span><select data-field="'+name+'">'+Object.keys(options).map(function(k){return '<option value="'+esc(k)+'" '+(k===value?'selected':'')+'>'+esc(options[k])+'</option>';}).join("")+'</select></label>';
}
function laneSelect(value){
  var options={};flow.lanes.forEach(function(l){options[l.id]=l.name;});return fieldSelect("所属剧情线","lane",value,options);
}
function colorButtons(value,attr){
  return COLORS.map(function(c){return '<button type="button" class="flow-color '+c+(c===value?' active':'')+'" data-'+attr+'="'+c+'" title="'+COLOR_LABELS[c]+'" aria-label="'+COLOR_LABELS[c]+'"></button>';}).join("");
}
function laneColorButtons(value){
  return COLORS.filter(function(c){return c!=="neutral";}).map(function(c){return '<button type="button" class="flow-color '+c+(c===value?' active':'')+'" data-lane-color="'+c+'" title="分轨颜色：'+COLOR_LABELS[c]+'" aria-label="分轨颜色：'+COLOR_LABELS[c]+'"></button>';}).join("");
}

function bindNodeFields(panel,node){
  panel.querySelectorAll("[data-field]").forEach(function(input){
    input.oninput=function(){
      var key=input.dataset.field;
      if(key==="tags") node.tags=input.value.split(/[,，]/).map(function(s){return s.trim();}).filter(Boolean).slice(0,20);
      else node[key]=input.value;
      if(key==="details") panel.querySelector("#flow-details-preview").innerHTML=api().textToHtml(node.details)||'<span class="flow-preview-empty">详细说明预览</span>';
      if(key==="lane"){
        var idx=flow.lanes.findIndex(function(l){return l.id===node.lane;});
        node.y=Math.max(42,laneTopByIndex(idx)+64);
      }
      updateNodeVisual(node);
      changed();
    };
    input.onchange=function(){commitHistory();};
  });
  panel.querySelectorAll("[data-node-color]").forEach(function(btn){btn.onclick=function(){node.color=btn.dataset.nodeColor;commitHistory();changed();renderNodes();renderEdges();renderInspector();};});
}

function updateNodeVisual(node){
  var card=root.querySelector('[data-node-id="'+cssEscape(node.id)+'"]');
  if(!card){renderNodes();renderEdges();return;}
  card.querySelector("h3").textContent=node.title||"未命名节点";
  card.querySelector("p").textContent=node.summary||"（暂无摘要）";
  card.style.left=Number(node.x)+"px";card.style.top=Number(node.y)+"px";
  if(root.querySelector(".flow-inspector-head h3")) root.querySelector(".flow-inspector-head h3").textContent=node.title||"未命名节点";
  renderNodes();renderEdges();
}

function cssEscape(value){return window.CSS&&CSS.escape?CSS.escape(String(value)):String(value).replace(/[^a-zA-Z0-9_-]/g,"\\$&");}

function renderEdgeInspector(panel,edge){
  var from=byId(edge.from),to=byId(edge.to);
  panel.innerHTML='<div class="flow-inspector-head"><div><span>剧情连线</span><h3>'+esc((from?from.title:"?")+" → "+(to?to.title:"?"))+'</h3></div><button class="ibtn-sm" data-close>×</button></div>'
    +'<div class="flow-form">'+fieldInput("连线说明","label",edge.label)+fieldSelect("关系类型","type",edge.type,EDGE_LABELS)
    +'<label class="flow-field"><span>连线颜色</span><div class="flow-color-options">'+colorButtons(edge.color,"edge-color")+'</div></label>'
    +'<div class="flow-relation-summary"><span>'+esc(from?from.title:"未知节点")+'</span><b>→</b><span>'+esc(to?to.title:"未知节点")+'</span></div>'
    +'<div class="flow-inspector-actions"><button class="danger" data-delete>删除连线</button></div></div>';
  panel.querySelector("[data-close]").onclick=function(){selected=null;renderSelection();renderInspector();};
  panel.querySelectorAll("[data-field]").forEach(function(input){input.oninput=function(){edge[input.dataset.field]=input.value;renderEdges();changed();};input.onchange=commitHistory;});
  panel.querySelectorAll("[data-edge-color]").forEach(function(btn){btn.onclick=function(){edge.color=btn.dataset.edgeColor;commitHistory();changed();renderEdges();renderInspector();};});
  panel.querySelector("[data-delete]").onclick=function(){deleteEdge(edge.id);};
}

function renderLaneManager(panel){
  panel.innerHTML='<div class="flow-inspector-head"><div><span>画布结构</span><h3>剧情分轨</h3></div><button class="ibtn-sm" data-close>×</button></div>'
    +'<p class="flow-inspector-note">分轨用于并行展示主线、人物线和谜题线。拖动节点跨越轨道时，所属分轨会自动更新。</p>'
    +'<div class="flow-lane-editor">'+flow.lanes.map(function(lane,idx){return '<div class="flow-lane-edit" data-lane-id="'+esc(lane.id)+'"><div class="flow-lane-main"><i class="flow-color '+esc(lane.color)+'"></i><input value="'+esc(lane.name)+'" aria-label="分轨名称"><button class="ibtn-sm" data-lane-up title="上移">↑</button><button class="ibtn-sm" data-lane-down title="下移">↓</button><button class="ibtn-sm danger-text" data-lane-delete title="删除">×</button></div><div class="flow-lane-palette"><span>分轨颜色</span><div class="flow-color-options">'+laneColorButtons(lane.color)+'</div></div><div class="flow-lane-size"><span>分轨高度</span><button class="ibtn-sm" data-lane-shrink title="缩小分轨高度">−</button><output>'+laneHeight(lane)+' px</output><button class="ibtn-sm" data-lane-grow title="增加分轨高度">＋</button></div></div>';}).join("")+'</div>'
    +'<button class="flow-add-lane" data-add-lane>＋ 新增剧情分轨</button>';
  panel.querySelector("[data-close]").onclick=function(){selected=null;renderInspector();};
  panel.querySelectorAll(".flow-lane-edit").forEach(function(row,idx){
    var lane=laneById(row.dataset.laneId);
    row.querySelector("input").oninput=function(){lane.name=this.value||"未命名剧情线";renderLanes();renderNodes();changed();};
    row.querySelector("input").onchange=commitHistory;
    row.querySelector("[data-lane-up]").onclick=function(){moveLane(idx,-1);};
    row.querySelector("[data-lane-down]").onclick=function(){moveLane(idx,1);};
    row.querySelectorAll("[data-lane-color]").forEach(function(btn){btn.onclick=function(){lane.color=btn.dataset.laneColor;commitHistory();changed();renderAll();selected={kind:"lanes"};renderInspector();};});
    row.querySelector("[data-lane-shrink]").onclick=function(){resizeLane(lane.id,-120);};
    row.querySelector("[data-lane-grow]").onclick=function(){resizeLane(lane.id,120);};
    row.querySelector("[data-lane-delete]").disabled=flow.lanes.length<=1;
    row.querySelector("[data-lane-delete]").onclick=function(){deleteLane(lane.id);};
  });
  panel.querySelector("[data-add-lane]").onclick=addLane;
}

function addNode(){
  var board=boardEl(),zoom=currentZoom(),lane=flow.lanes[0];
  var node={id:uid("node"),title:"新节点",summary:"",details:"",type:"event",status:"idea",lane:lane.id,volume:"",color:"neutral",linked_section:"",tags:[],x:Math.round((board.scrollLeft+170)/zoom),y:64,width:220};
  flow.nodes.push(node);selected={kind:"node",id:node.id};commitHistory();changed();renderAll();
  setTimeout(function(){var input=root&&root.querySelector('[data-field="title"]');if(input){input.focus();input.select();}},0);
}

function duplicateNode(node){
  var copy=clone(node);copy.id=uid("node");copy.title=node.title+"（副本）";copy.x=Number(node.x)+36;copy.y=Number(node.y)+36;
  flow.nodes.push(copy);selected={kind:"node",id:copy.id};commitHistory();changed();renderAll();
}

function deleteNode(id){
  var node=byId(id);if(!node)return;
  if(!confirm("确定删除节点「"+node.title+"」及其相关连线？"))return;
  flow.nodes=flow.nodes.filter(function(n){return n.id!==id;});
  flow.edges=flow.edges.filter(function(e){return e.from!==id&&e.to!==id;});
  selected=null;commitHistory();changed();renderAll();
}

function deleteEdge(id){
  flow.edges=flow.edges.filter(function(e){return e.id!==id;});selected=null;commitHistory();changed();renderAll();
}

function deleteSelected(){
  if(selected.kind==="node")deleteNode(selected.id);else if(selected.kind==="edge")deleteEdge(selected.id);
}

function toggleConnect(){connectMode=!connectMode;connectFrom=null;updateToolbar();}

function onNodeClick(id){
  if(connectMode){
    if(!connectFrom){connectFrom=id;updateConnectUI();return;}
    if(connectFrom===id){connectFrom=null;updateConnectUI();return;}
    var edge={id:uid("edge"),from:connectFrom,to:id,type:"advance",label:"",color:"neutral"};
    flow.edges.push(edge);selected={kind:"edge",id:edge.id};connectMode=false;connectFrom=null;commitHistory();changed();renderAll();return;
  }
  selected={kind:"node",id:id};renderSelection();renderInspector();
}

function startNodeDrag(e,id,el){
  if(e.button!==0)return;
  e.stopPropagation();
  var node=byId(id),zoom=currentZoom(),sx=e.clientX,sy=e.clientY,ox=Number(node.x),oy=Number(node.y),moved=false;
  function move(ev){
    var dx=(ev.clientX-sx)/zoom,dy=(ev.clientY-sy)/zoom;
    if(Math.abs(dx)+Math.abs(dy)>3)moved=true;
    node.x=Math.round(clamp(ox+dx,0,stageWidth()-Number(node.width||220)-20));
    node.y=Math.round(clamp(oy+dy,0,stageHeight()-NODE_HEIGHT-20));
    el.style.left=node.x+"px";el.style.top=node.y+"px";renderStageSize();renderEdges();
  }
  function up(){
    document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);
    if(moved){
      var laneIndex=clamp(laneIndexAt(node.y+NODE_HEIGHT/2),0,flow.lanes.length-1);
      node.lane=flow.lanes[laneIndex].id;commitHistory();changed();renderNodes();renderEdges();renderInspector();
    }
  }
  document.addEventListener("pointermove",move);document.addEventListener("pointerup",up);
}

function startPan(e){
  if(e.button!==0 || e.target.closest(".flow-node") || e.target.closest(".flow-edge-hit") || e.target.closest("button"))return;
  var board=boardEl(),sx=e.clientX,sy=e.clientY,sl=board.scrollLeft,st=board.scrollTop,moved=false;
  board.classList.add("panning");
  function move(ev){var dx=ev.clientX-sx,dy=ev.clientY-sy;if(Math.abs(dx)+Math.abs(dy)>3)moved=true;board.scrollLeft=sl-dx;board.scrollTop=st-dy;}
  function up(){document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);board.classList.remove("panning");if(moved)captureViewport();}
  document.addEventListener("pointermove",move);document.addEventListener("pointerup",up);
}

function addLane(){
  var lane={id:uid("lane"),name:"新剧情线",color:COLORS[(flow.lanes.length%5)+1],height:DEFAULT_LANE_HEIGHT};flow.lanes.push(lane);commitHistory();changed();renderAll();selected={kind:"lanes"};renderInspector();
}

function deleteLane(id){
  if(flow.lanes.length<=1)return;
  var lane=laneById(id);if(!confirm("确定删除剧情分轨「"+lane.name+"」？其中节点将移入第一条分轨。"))return;
  flow.lanes=flow.lanes.filter(function(l){return l.id!==id;});
  flow.nodes.forEach(function(n){if(n.lane===id)n.lane=flow.lanes[0].id;});
  autoLayout(false);commitHistory();changed();renderAll();selected={kind:"lanes"};renderInspector();
}

function moveLane(index,delta){
  var next=index+delta;if(next<0||next>=flow.lanes.length)return;
  var oldTops={};flow.lanes.forEach(function(l,i){oldTops[l.id]=laneTopByIndex(i);});
  var tmp=flow.lanes[index];flow.lanes[index]=flow.lanes[next];flow.lanes[next]=tmp;
  flow.nodes.forEach(function(n){var offset=Number(n.y)-oldTops[n.lane];n.y=laneTop(n.lane)+clamp(offset,36,laneHeight(laneById(n.lane))-NODE_HEIGHT-24);});
  commitHistory();changed();renderAll();selected={kind:"lanes"};renderInspector();
}

function resizeLane(id,delta){
  var lane=laneById(id),oldHeight=laneHeight(lane),next=clamp(oldHeight+delta,MIN_LANE_HEIGHT,MAX_LANE_HEIGHT);
  if(next===oldHeight)return;
  var geometry=captureLaneGeometry();
  applyLaneHeight(id,next,geometry);
  commitHistory();changed();renderAll();selected={kind:"lanes"};renderInspector();
}

function captureLaneGeometry(){
  var tops={},offsets={};
  flow.lanes.forEach(function(l,i){tops[l.id]=laneTopByIndex(i);});
  flow.nodes.forEach(function(n){offsets[n.id]=Number(n.y)-tops[n.lane];});
  return {tops:tops,offsets:offsets};
}

function applyLaneHeight(id,height,geometry){
  var lane=laneById(id);if(!lane)return;
  lane.height=clamp(Math.round(height/10)*10,MIN_LANE_HEIGHT,MAX_LANE_HEIGHT);
  flow.nodes.forEach(function(n){
    var offset=geometry.offsets[n.id];
    n.y=laneTop(n.lane)+clamp(offset,36,laneHeight(laneById(n.lane))-NODE_HEIGHT-24);
  });
}

function startLaneResize(e,id){
  if(e.button!==0)return;
  e.preventDefault();e.stopPropagation();
  var lane=laneById(id),startY=e.clientY,startHeight=laneHeight(lane),zoom=currentZoom(),geometry=captureLaneGeometry(),moved=false;
  document.body.classList.add("flow-resizing");
  function move(ev){
    var next=clamp(startHeight+(ev.clientY-startY)/zoom,MIN_LANE_HEIGHT,MAX_LANE_HEIGHT);
    if(Math.abs(next-startHeight)>2)moved=true;
    applyLaneHeight(id,next,geometry);renderStageSize();renderLanes();renderNodes();renderEdges();
  }
  function up(){
    document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);document.body.classList.remove("flow-resizing");
    if(moved){commitHistory();changed();renderAll();}
  }
  document.addEventListener("pointermove",move);document.addEventListener("pointerup",up);
}

function autoLayout(record){
  if(record!==false && flow.nodes.length && !confirm("自动排列会重置所有节点位置，确定继续？"))return;
  flow.lanes.forEach(function(lane,laneIdx){
    flow.nodes.filter(function(n){return n.lane===lane.id;}).sort(function(a,b){return Number(a.x)-Number(b.x);}).forEach(function(node,idx){node.x=170+idx*285;node.y=laneTopByIndex(laneIdx)+64;});
  });
  if(record!==false){commitHistory();changed();renderAll();}
}

function setZoom(value){
  var old=currentZoom(),next=Math.round(clamp(value,0.2,2.5)*10)/10;if(old===next)return;
  var board=boardEl(),centerX=(board.scrollLeft+board.clientWidth/2)/old,centerY=(board.scrollTop+board.clientHeight/2)/old;
  flow.viewport.zoom=next;renderStageSize();board.scrollLeft=centerX*next-board.clientWidth/2;board.scrollTop=centerY*next-board.clientHeight/2;
  captureViewport();commitHistory();changed();
}

function fitContent(){
  var board=boardEl();if(!board||!flow)return;
  if(!flow.nodes.length){
    flow.viewport.zoom=clamp(Math.min(board.clientWidth/1500,board.clientHeight/900),0.35,1);
    renderStageSize();board.scrollLeft=0;board.scrollTop=0;captureViewport();commitHistory();changed();return;
  }
  var minX=Infinity,minY=Infinity,maxX=0,maxY=0;
  flow.nodes.forEach(function(node){minX=Math.min(minX,Number(node.x));minY=Math.min(minY,Number(node.y));maxX=Math.max(maxX,Number(node.x)+Number(node.width||220));maxY=Math.max(maxY,Number(node.y)+NODE_HEIGHT);});
  var contentW=Math.max(300,maxX-minX),contentH=Math.max(200,maxY-minY);
  var next=clamp(Math.min((board.clientWidth-120)/contentW,(board.clientHeight-120)/contentH),0.2,1.35);
  flow.viewport.zoom=Math.round(next*100)/100;renderStageSize();
  board.scrollLeft=Math.max(0,(minX-60)*flow.viewport.zoom);board.scrollTop=Math.max(0,(minY-60)*flow.viewport.zoom);
  captureViewport();commitHistory();changed();
}

function captureViewport(saveChange){
  var board=boardEl();if(!board||!flow)return;
  var x=Math.round(board.scrollLeft),y=Math.round(board.scrollTop);
  if(x===flow.viewport.x&&y===flow.viewport.y)return;
  flow.viewport.x=x;flow.viewport.y=y;
  if(saveChange)changed();
}

function changed(){
  revision++;dirty=true;externalChanged=false;updateSaveState();
  if(saveTimer)clearTimeout(saveTimer);
  saveTimer=setTimeout(saveNow,800);
}

function commitHistory(){
  var snapshot=JSON.stringify(flow);
  if(history[historyIndex]===snapshot){updateToolbar();return;}
  history=history.slice(0,historyIndex+1);history.push(snapshot);
  if(history.length>50)history.shift();
  historyIndex=history.length-1;
  updateToolbar();
}

function undo(){
  if(historyIndex<=0)return;historyIndex--;flow=JSON.parse(history[historyIndex]);selected=null;connectMode=false;connectFrom=null;changed();renderAll();
}
function redo(){
  if(historyIndex>=history.length-1)return;historyIndex++;flow=JSON.parse(history[historyIndex]);selected=null;connectMode=false;connectFrom=null;changed();renderAll();
}

function saveNow(){
  if(!flow||!projectName)return Promise.resolve();
  if(saving)return savePromise||Promise.resolve();
  savePromise=performSave();
  return savePromise;
}

async function performSave(){
  if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}
  captureViewport();saving=true;var sentRevision=revision;updateSaveState();
  try{
    var response=await api().postJson("/api/flow/save",{project:projectName,flow:flow,mtime:mtime});
    if(response.status===409){externalChanged=true;dirty=true;updateSaveState();api().toast("走向图存在外部更新",true);return;}
    var result=await response.json();
    if(!result.ok)throw new Error(result.error||"保存失败");
    mtime=result.mtime||mtime;
    if(sentRevision===revision)dirty=false;else saveAgain=true;
    updateSaveState(result.saved_at?("已保存 "+result.saved_at.slice(11,16)):"已保存");
  }catch(e){dirty=true;updateSaveState("保存失败","error");api().toast("走向图保存失败",true);}
  finally{
    saving=false;
    savePromise=null;
    if(saveAgain||dirty&&sentRevision!==revision){saveAgain=false;saveTimer=setTimeout(saveNow,300);}else updateSaveState();
  }
}

async function flush(){
  if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}
  if(saving&&savePromise)await savePromise;
  if(dirty)await saveNow();
}

function startPoll(){
  pollTimer=setInterval(function(){
    if(!root||dirty||saving||!projectName)return;
    api().getJson("/api/flow/mtime?project="+encodeURIComponent(projectName)).then(function(result){
      if(result.mtime&&result.mtime>mtime+0.001){externalChanged=true;updateSaveState();}
    }).catch(function(){});
  },3000);
}

window.FlowBoard={mount:mount,unmount:unmount,reset:reset,reload:reload,flush:flush};
})();
