(function(){
"use strict";

var DEFAULT_LANE_HEIGHT = 520;
var MIN_LANE_HEIGHT = 280;
var MAX_LANE_HEIGHT = 1200;
var COLLAPSED_LANE_HEIGHT = 64;
var NODE_HEIGHT = 118;
var GRID_SIZE = 22;
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
var selectedIds = [];
var selectMode = false;
var suppressClick = false;
var pointerSelectedId = null;
var filterSearch = "";
var filterStatus = "";
var filterTag = "";

function api(){ return window.SnowflakeAPI; }
function esc(s){ return api() ? api().escapeHtml(s == null ? "" : String(s)) : String(s || ""); }
function clone(value){ return JSON.parse(JSON.stringify(value)); }
function uid(prefix){ return prefix+"-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8); }
function byId(id){ return flow && flow.nodes.find(function(n){return n.id===id;}); }
function edgeById(id){ return flow && flow.edges.find(function(e){return e.id===id;}); }
function laneById(id){ return flow && flow.lanes.find(function(l){return l.id===id;}); }
function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function laneHeight(lane){ return lane&&lane.collapsed?COLLAPSED_LANE_HEIGHT:clamp(Number(lane&&lane.height)||DEFAULT_LANE_HEIGHT,MIN_LANE_HEIGHT,MAX_LANE_HEIGHT); }
function fullLaneHeight(lane){ return clamp(Number(lane&&lane.height)||DEFAULT_LANE_HEIGHT,MIN_LANE_HEIGHT,MAX_LANE_HEIGHT); }
function snapValue(value){return flow&&flow.viewport&&flow.viewport.snap_grid?Math.round(value/GRID_SIZE)*GRID_SIZE:Math.round(value);}
function isSelectedId(id){return selectedIds.indexOf(id)>=0;}
function selectedNodes(){return selectedIds.map(byId).filter(Boolean);}
function setSelected(ids,focusId){
  selectedIds=Array.from(new Set((ids||[]).filter(function(id){return !!byId(id);})));
  if(selectedIds.length===1)selected={kind:"node",id:selectedIds[0]};
  else if(selectedIds.length>1)selected={kind:"nodes",id:focusId||selectedIds[selectedIds.length-1]};
  else selected=null;
}
function nodeMatches(node){
  var lane=laneById(node.lane);if(lane&&lane.collapsed)return false;
  if(filterStatus&&node.status!==filterStatus)return false;
  if(filterTag&&(node.tags||[]).indexOf(filterTag)<0)return false;
  if(filterSearch){
    var hay=[node.title,node.summary,node.details,node.volume,node.chapter,(node.tags||[]).join(" ")].join(" ").toLowerCase();
    if(hay.indexOf(filterSearch)<0)return false;
  }
  return true;
}
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
  selectedIds = [];
  pointerSelectedId = null;
  connectFrom = null;
  connectMode = false;
  dirty = false;
  externalChanged = false;
  filterSearch="";filterStatus="";filterTag="";selectMode=false;
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
  selectedIds = [];
  pointerSelectedId = null;
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
          '<button data-action="select" title="框选节点（也可按住 Shift 拖动空白处）">▣ 框选</button>'+
          '<button data-action="lanes">☷ 分轨</button>'+
        '</div>'+
        '<div class="flow-toolbar-group">'+
          '<button class="ibtn-sm" data-action="undo" title="撤销 Ctrl+Z">↶</button>'+
          '<button class="ibtn-sm" data-action="redo" title="重做 Ctrl+Y">↷</button>'+
          '<button data-action="layout" title="按分轨和当前先后顺序排列">排列</button>'+
        '</div>'+
        '<div class="flow-toolbar-group zoom-tools">'+
          '<button class="ibtn-sm" data-action="zoom-out" title="缩小">−</button>'+
          '<span id="flow-zoom">100%</span>'+
          '<button class="ibtn-sm" data-action="zoom-in" title="放大">＋</button>'+
          '<button data-action="fit" title="缩放并居中显示全部节点（Ctrl+0）">适应</button>'+
        '</div>'+
        '<button data-action="snap" class="flow-snap ibtn-sm" title="网格吸附" aria-label="网格吸附">⌗</button>'+
        '<button class="flow-save-state" id="flow-save-state" data-action="reload-external">已保存</button>'+
      '</div>'+
      '<div class="flow-filterbar">'+
        '<label class="flow-search"><span>⌕</span><input id="flow-search" type="search" placeholder="搜索标题、摘要、卷章或详情…"></label>'+
        '<select id="flow-status-filter" aria-label="按状态筛选"><option value="">全部状态</option><option value="idea">设想</option><option value="draft">草案</option><option value="fixed">确定</option></select>'+
        '<select id="flow-tag-filter" aria-label="按标签筛选"><option value="">全部标签</option></select>'+
        '<label class="flow-group-control"><span>分组</span><select id="flow-group-mode"><option value="">不分组</option><option value="volume">按卷</option><option value="chapter">按章节</option></select></label>'+
        '<button class="ghost" data-action="clear-filter">清除筛选</button>'+
        '<span id="flow-filter-count"></span>'+
      '</div>'+
      '<div class="flow-mode-tip" id="flow-mode-tip"></div>'+
      '<div class="flow-workspace">'+
        '<div class="flow-board-wrap"><div class="flow-board" id="flow-board" tabindex="0" aria-label="故事走向图画布">'+
          '<div class="flow-stage-space" id="flow-stage-space">'+
            '<div class="flow-stage" id="flow-stage">'+
              '<div class="flow-lane-layer" id="flow-lanes"></div>'+
              '<div class="flow-group-layer" id="flow-groups"></div>'+
              '<svg class="flow-edge-layer" id="flow-edges" aria-label="节点连线"></svg>'+
              '<div class="flow-node-layer" id="flow-nodes"></div>'+
            '</div>'+
          '</div>'+
          '<div class="flow-marquee" id="flow-marquee"></div>'+
          '<div class="flow-empty" id="flow-empty"><strong>从第一个关键节点开始</strong><span>新增节点后拖动排列，再用“连线”建立剧情走向。</span><button class="primary" data-action="empty-add">＋ 新建节点</button></div>'+
        '</div><div class="flow-minimap" id="flow-minimap" title="点击小地图快速定位"><svg viewBox="0 0 190 116" aria-label="走向图小地图"></svg></div></div>'+
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
    renderMinimap();
  }
}

function bindToolbar(){
  root.querySelector('[data-action="add-node"]').onclick = addNode;
  root.querySelector('[data-action="empty-add"]').onclick = addNode;
  root.querySelector('[data-action="connect"]').onclick = toggleConnect;
  root.querySelector('[data-action="select"]').onclick = function(){selectMode=!selectMode;updateToolbar();};
  root.querySelector('[data-action="lanes"]').onclick = function(){setSelected([]);selected={kind:"lanes"};renderSelection();renderInspector();};
  root.querySelector('[data-action="undo"]').onclick = undo;
  root.querySelector('[data-action="redo"]').onclick = redo;
  root.querySelector('[data-action="layout"]').onclick = autoLayout;
  root.querySelector('[data-action="zoom-out"]').onclick = function(){setZoom(currentZoom()-0.1);};
  root.querySelector('[data-action="zoom-in"]').onclick = function(){setZoom(currentZoom()+0.1);};
  root.querySelector('[data-action="fit"]').onclick = fitContent;
  root.querySelector('[data-action="snap"]').onclick = function(){flow.viewport.snap_grid=!flow.viewport.snap_grid;commitHistory();changed();updateToolbar();};
  root.querySelector('[data-action="reload-external"]').onclick = function(){if(externalChanged) reload();};
  var search=root.querySelector("#flow-search"),status=root.querySelector("#flow-status-filter"),tag=root.querySelector("#flow-tag-filter"),group=root.querySelector("#flow-group-mode");
  search.value=filterSearch;status.value=filterStatus;group.value=(flow.viewport&&flow.viewport.group_mode)||"";
  search.oninput=function(){filterSearch=this.value.trim().toLowerCase();renderFiltered();};
  status.onchange=function(){filterStatus=this.value;renderFiltered();};
  tag.onchange=function(){filterTag=this.value;renderFiltered();};
  group.onchange=function(){flow.viewport.group_mode=this.value;commitHistory();changed();renderGroups();};
  root.querySelector('[data-action="clear-filter"]').onclick=function(){filterSearch="";filterStatus="";filterTag="";search.value="";status.value="";tag.value="";renderFiltered();};
  refreshTagFilter();
  var minimap=root.querySelector("#flow-minimap");
  minimap.onclick=function(e){
    var rect=minimap.getBoundingClientRect(),board=boardEl(),zoom=currentZoom();
    var x=(e.clientX-rect.left)/rect.width*stageWidth(),y=(e.clientY-rect.top)/rect.height*stageHeight();
    board.scrollLeft=Math.max(0,x*zoom-board.clientWidth/2);board.scrollTop=Math.max(0,y*zoom-board.clientHeight/2);
    captureViewport(true);renderMinimap();
  };
}

function refreshTagFilter(){
  var select=root&&root.querySelector("#flow-tag-filter");if(!select)return;
  var tags=[];flow.nodes.forEach(function(node){(node.tags||[]).forEach(function(tag){if(tags.indexOf(tag)<0)tags.push(tag);});});tags.sort();
  select.innerHTML='<option value="">全部标签</option>'+tags.map(function(tag){return '<option value="'+esc(tag)+'">'+esc(tag)+'</option>';}).join("");
  select.value=filterTag;
}

function renderFiltered(){renderNodes();renderEdges();renderGroups();renderMinimap();updateEmpty();}

function bindBoard(){
  var board = boardEl();
  board.addEventListener("click", function(e){
    if(suppressClick){suppressClick=false;return;}
    if(e.target.closest(".flow-node") || e.target.closest(".flow-edge-hit")) return;
    if(connectMode){connectFrom=null;updateConnectUI();return;}
    setSelected([]);renderSelection();renderInspector();
  });
  board.addEventListener("scroll", function(){
    if(viewportTimer) clearTimeout(viewportTimer);
    viewportTimer=setTimeout(function(){captureViewport(true);renderMinimap();},180);
  });
  board.addEventListener("wheel", function(e){
    if(!e.ctrlKey) return;
    e.preventDefault();
    setZoom(currentZoom()+(e.deltaY<0?0.1:-0.1));
  },{passive:false});
  board.addEventListener("keydown", function(e){
    if(e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
    if(e.key === "Escape" && (connectMode||selectMode)){connectMode=false;connectFrom=null;selectMode=false;updateToolbar();e.preventDefault();return;}
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
  flow.nodes.filter(nodeMatches).forEach(function(node){max=Math.max(max,Number(node.y)+NODE_HEIGHT+STAGE_PADDING_Y);});
  return Math.ceil(max);
}

function renderAll(){
  if(!root || !flow) return;
  renderStageSize();
  renderLanes();
  renderGroups();
  renderNodes();
  renderEdges();
  renderInspector();
  refreshTagFilter();
  renderMinimap();
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
    return '<div class="flow-lane color-'+esc(lane.color)+(lane.collapsed?' collapsed':'')+'" style="top:'+top+'px;height:'+height+'px">'
      +'<button type="button" class="flow-lane-collapse" data-collapse-lane="'+esc(lane.id)+'" title="'+(lane.collapsed?'展开':'折叠')+'分轨">'+(lane.collapsed?'▸':'▾')+'</button>'
      +'<span class="flow-lane-name">'+esc(lane.name)+'</span><span class="flow-lane-hint">'+(lane.collapsed?'已折叠':('可放置多层分支 · '+height+'px'))+'</span>'
      +(lane.collapsed?'':'<button type="button" class="flow-lane-resize" data-resize-lane="'+esc(lane.id)+'" title="上下拖动调整「'+esc(lane.name)+'」高度" aria-label="调整'+esc(lane.name)+'高度"><i></i></button>')+'</div>';
  }).join("");
  layer.querySelectorAll("[data-resize-lane]").forEach(function(handle){
    handle.onpointerdown=function(e){startLaneResize(e,handle.dataset.resizeLane);};
  });
  layer.querySelectorAll("[data-collapse-lane]").forEach(function(button){button.onclick=function(e){e.stopPropagation();toggleLaneCollapsed(button.dataset.collapseLane);};});
}

function renderGroups(){
  var layer=root&&root.querySelector("#flow-groups");if(!layer)return;
  var mode=flow.viewport&&flow.viewport.group_mode;if(!mode){layer.innerHTML="";return;}
  var groups={};flow.nodes.filter(nodeMatches).forEach(function(node){var key=String(node[mode]||"").trim();if(!key)return;(groups[key]||(groups[key]=[])).push(node);});
  layer.innerHTML=Object.keys(groups).map(function(key){
    var nodes=groups[key],minX=Math.min.apply(null,nodes.map(function(n){return Number(n.x);})),maxX=Math.max.apply(null,nodes.map(function(n){return Number(n.x)+Number(n.width||220);}));
    var minY=Math.min.apply(null,nodes.map(function(n){return Number(n.y);})),maxY=Math.max.apply(null,nodes.map(function(n){return Number(n.y)+NODE_HEIGHT;}));
    return '<div class="flow-group-box" style="left:'+(minX-26)+'px;top:'+(minY-34)+'px;width:'+(maxX-minX+52)+'px;height:'+(maxY-minY+60)+'px"><span>'+esc(key)+'</span></div>';
  }).join("");
}

function renderNodes(){
  var layer=root.querySelector("#flow-nodes");
  layer.innerHTML=flow.nodes.filter(nodeMatches).map(function(node){
    var lane=laneById(node.lane);
    var effectiveColor=node.color&&node.color!=="neutral"?node.color:(lane&&lane.color!=="neutral"?lane.color:"blue");
    var isSelected=isSelectedId(node.id);
    var isSource=connectMode&&connectFrom===node.id;
    var tags=(node.tags||[]).slice(0,2).map(function(t){return '<span>'+esc(t)+'</span>';}).join("");
    return '<article class="flow-node color-'+esc(effectiveColor)+(node.color==="neutral"?' inherits-lane':'')+' '+(isSelected?'selected ':'')+(isSource?'connect-source':'')+'" data-node-id="'+esc(node.id)+'" tabindex="0" title="'+(node.color==="neutral"?'跟随分轨颜色：'+esc(COLOR_LABELS[effectiveColor]||effectiveColor):'节点独立颜色：'+esc(COLOR_LABELS[effectiveColor]||effectiveColor))+'" '
      +'style="left:'+Number(node.x)+'px;top:'+Number(node.y)+'px;width:'+Number(node.width||220)+'px">'
      +'<div class="flow-node-top"><span class="flow-node-type">'+esc(TYPE_LABELS[node.type]||"事件")+'</span><span class="flow-node-status status-'+esc(node.status)+'">'+esc(STATUS_LABELS[node.status]||"设想")+'</span></div>'
      +'<h3>'+esc(node.title)+'</h3><p>'+esc(node.summary||"（暂无摘要）")+'</p>'
      +'<div class="flow-node-meta"><span>'+esc(lane?lane.name:"未分轨")+'</span>'+(node.volume?'<span>'+esc(node.volume)+'</span>':'')+(node.chapter?'<span>'+esc(node.chapter)+'</span>':'')+tags+'</div>'
      +'<span class="flow-node-port in"></span><span class="flow-node-port out"></span><span class="flow-node-width-handle" title="拖动调整节点宽度"></span></article>';
  }).join("");
  layer.querySelectorAll(".flow-node").forEach(function(el){
    el.onclick=function(e){e.stopPropagation();if(suppressClick){suppressClick=false;return;}onNodeClick(el.dataset.nodeId,e);};
    el.ondblclick=function(e){e.stopPropagation();setSelected([el.dataset.nodeId]);renderSelection();renderInspector();var input=root.querySelector('[data-field="title"]');if(input){input.focus();input.select();}};
    el.onpointerdown=function(e){startNodeDrag(e,el.dataset.nodeId,el);};
    el.onkeydown=function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();onNodeClick(el.dataset.nodeId,e);}};
    var handle=el.querySelector(".flow-node-width-handle");handle.onpointerdown=function(e){startNodeResize(e,el.dataset.nodeId);};
  });
}

function segmentBlocked(a,b,obstacles){
  return obstacles.some(function(r){
    if(a.y===b.y){var lo=Math.min(a.x,b.x),hi=Math.max(a.x,b.x);return a.y>r.y&&a.y<r.b&&hi>r.x&&lo<r.r;}
    if(a.x===b.x){var top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);return a.x>r.x&&a.x<r.r&&bottom>r.y&&top<r.b;}
    return false;
  });
}

function routeClear(points,obstacles){for(var i=1;i<points.length;i++)if(segmentBlocked(points[i-1],points[i],obstacles))return false;return true;}

function edgePath(edge){
  var from=byId(edge.from),to=byId(edge.to);
  if(!from||!to||!nodeMatches(from)||!nodeMatches(to))return "";
  var sx=Number(from.x)+Number(from.width||220),sy=Number(from.y)+58,tx=Number(to.x),ty=Number(to.y)+58;
  var obstacles=flow.nodes.filter(function(n){return n.id!==from.id&&n.id!==to.id&&nodeMatches(n);}).map(function(n){return {x:Number(n.x)-16,y:Number(n.y)-16,r:Number(n.x)+Number(n.width||220)+16,b:Number(n.y)+NODE_HEIGHT+16};});
  var mid=(sx+tx)/2,allVisible=flow.nodes.filter(nodeMatches),top=Math.max(18,Math.min.apply(null,allVisible.map(function(n){return Number(n.y);}).concat([sy,ty]))-42);
  var bottom=Math.max.apply(null,allVisible.map(function(n){return Number(n.y)+NODE_HEIGHT;}).concat([sy,ty]))+42;
  var right=Math.max.apply(null,allVisible.map(function(n){return Number(n.x)+Number(n.width||220);}).concat([sx,tx]))+52;
  var candidates=[];
  if(tx>=sx+36){
    [mid,sx+42,tx-42].forEach(function(x){candidates.push([{x:sx,y:sy},{x:x,y:sy},{x:x,y:ty},{x:tx,y:ty}]);});
  }
  candidates.push([{x:sx,y:sy},{x:sx+34,y:sy},{x:sx+34,y:top},{x:tx-34,y:top},{x:tx-34,y:ty},{x:tx,y:ty}]);
  candidates.push([{x:sx,y:sy},{x:sx+34,y:sy},{x:sx+34,y:bottom},{x:tx-34,y:bottom},{x:tx-34,y:ty},{x:tx,y:ty}]);
  candidates.push([{x:sx,y:sy},{x:right,y:sy},{x:right,y:ty},{x:tx,y:ty}]);
  var points=candidates.find(function(value){return routeClear(value,obstacles);})||candidates[candidates.length-1];
  return points.map(function(p,index){return (index?"L ":"M ")+Math.round(p.x)+" "+Math.round(p.y);}).join(" ");
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
    path.onclick=function(e){e.stopPropagation();setSelected([]);selected={kind:"edge",id:path.dataset.edgeId};renderSelection();renderInspector();};
  });
}

function renderSelection(){
  if(!root)return;
  root.querySelectorAll(".flow-node").forEach(function(el){el.classList.toggle("selected",isSelectedId(el.dataset.nodeId));});
  root.querySelectorAll(".flow-edge-group").forEach(function(el){el.classList.toggle("selected",selected&&selected.kind==="edge"&&selected.id===el.dataset.edgeId);});
}

function updateEmpty(){
  root.querySelector("#flow-empty").classList.toggle("show",flow.nodes.length===0);
  var visible=flow.nodes.filter(nodeMatches).length;
  root.querySelector("#flow-count").textContent=flow.nodes.length+" 个节点 · "+flow.edges.length+" 条连线";
  root.querySelector("#flow-filter-count").textContent=visible===flow.nodes.length?"":("显示 "+visible+" / "+flow.nodes.length);
}

function updateToolbar(){
  var connect=root.querySelector('[data-action="connect"]');
  connect.classList.toggle("active",connectMode);
  root.querySelector('[data-action="select"]').classList.toggle("active",selectMode);
  root.querySelector('[data-action="snap"]').classList.toggle("active",!!flow.viewport.snap_grid);
  boardEl().classList.toggle("selecting",selectMode);
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
  if(selected.kind==="nodes"){renderMultiInspector(panel);return;}
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
    +fieldInput("所属章节","chapter",node.chapter||"")
    +fieldSelect("关联设计步骤","linked_section",node.linked_section,SECTION_LABELS)
    +fieldInput("标签（用逗号分隔）","tags",(node.tags||[]).join(", "))
    +'<label class="flow-field"><span>节点宽度 <output id="flow-node-width-output">'+Math.round(Number(node.width||220))+' px</output></span><input data-field="width" type="range" min="180" max="420" step="10" value="'+Math.round(Number(node.width||220))+'"></label>'
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

function renderMultiInspector(panel){
  var count=selectedNodes().length;
  panel.innerHTML='<div class="flow-inspector-head"><div><span>批量操作</span><h3>已选择 '+count+' 个节点</h3></div><button class="ibtn-sm" data-close>×</button></div>'
    +'<div class="flow-form"><p class="flow-inspector-note inline-note">可整体拖动所选节点，或使用下列工具精确排列。</p>'
    +'<div class="flow-batch-grid"><button data-align="left">左对齐</button><button data-align="center">水平居中</button><button data-align="right">右对齐</button><button data-align="top">顶对齐</button><button data-align="middle">垂直居中</button><button data-align="bottom">底对齐</button></div>'
    +'<div class="flow-batch-grid two"><button data-distribute="horizontal" '+(count<3?'disabled':'')+'>横向等距</button><button data-distribute="vertical" '+(count<3?'disabled':'')+'>纵向等距</button></div>'
    +'<div class="flow-inspector-actions"><button data-clear>取消选择</button><button class="danger" data-delete>删除所选</button></div></div>';
  panel.querySelector("[data-close]").onclick=panel.querySelector("[data-clear]").onclick=function(){setSelected([]);renderSelection();renderInspector();};
  panel.querySelectorAll("[data-align]").forEach(function(button){button.onclick=function(){alignSelected(button.dataset.align);};});
  panel.querySelectorAll("[data-distribute]").forEach(function(button){button.onclick=function(){distributeSelected(button.dataset.distribute);};});
  panel.querySelector("[data-delete]").onclick=deleteSelected;
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
      else if(key==="width"){
        node.width=clamp(Number(input.value)||220,180,420);
        var output=panel.querySelector("#flow-node-width-output");if(output)output.textContent=Math.round(node.width)+" px";
      }
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
  if(!card){renderNodes();renderGroups();renderEdges();renderMinimap();return;}
  card.querySelector("h3").textContent=node.title||"未命名节点";
  card.querySelector("p").textContent=node.summary||"（暂无摘要）";
  card.style.left=Number(node.x)+"px";card.style.top=Number(node.y)+"px";
  if(root.querySelector(".flow-inspector-head h3")) root.querySelector(".flow-inspector-head h3").textContent=node.title||"未命名节点";
  renderNodes();renderGroups();renderEdges();renderMinimap();refreshTagFilter();
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
    +'<div class="flow-lane-editor">'+flow.lanes.map(function(lane,idx){return '<div class="flow-lane-edit" data-lane-id="'+esc(lane.id)+'"><div class="flow-lane-main"><i class="flow-color '+esc(lane.color)+'"></i><input value="'+esc(lane.name)+'" aria-label="分轨名称"><button class="ibtn-sm" data-lane-up title="上移">↑</button><button class="ibtn-sm" data-lane-down title="下移">↓</button><button class="ibtn-sm danger-text" data-lane-delete title="删除">×</button></div><div class="flow-lane-palette"><span>分轨颜色</span><div class="flow-color-options">'+laneColorButtons(lane.color)+'</div></div><div class="flow-lane-size"><button class="flow-collapse-toggle" data-lane-collapse>'+(lane.collapsed?'▸ 展开分轨':'▾ 折叠分轨')+'</button><span>分轨高度</span><button class="ibtn-sm" data-lane-shrink title="缩小分轨高度" '+(lane.collapsed?'disabled':'')+'>−</button><output>'+fullLaneHeight(lane)+' px</output><button class="ibtn-sm" data-lane-grow title="增加分轨高度" '+(lane.collapsed?'disabled':'')+'>＋</button></div></div>';}).join("")+'</div>'
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
    row.querySelector("[data-lane-collapse]").onclick=function(){toggleLaneCollapsed(lane.id);};
    row.querySelector("[data-lane-delete]").disabled=flow.lanes.length<=1;
    row.querySelector("[data-lane-delete]").onclick=function(){deleteLane(lane.id);};
  });
  panel.querySelector("[data-add-lane]").onclick=addLane;
}

function addNode(){
  var board=boardEl(),zoom=currentZoom(),lane=flow.lanes[0];
  var node={id:uid("node"),title:"新节点",summary:"",details:"",type:"event",status:"idea",lane:lane.id,volume:"",chapter:"",color:"neutral",linked_section:"",tags:[],x:snapValue((board.scrollLeft+170)/zoom),y:snapValue(laneTop(lane.id)+64),width:220};
  flow.nodes.push(node);setSelected([node.id]);commitHistory();changed();renderAll();
  setTimeout(function(){var input=root&&root.querySelector('[data-field="title"]');if(input){input.focus();input.select();}},0);
}

function duplicateNode(node){
  var copy=clone(node);copy.id=uid("node");copy.title=node.title+"（副本）";copy.x=Number(node.x)+36;copy.y=Number(node.y)+36;
  flow.nodes.push(copy);setSelected([copy.id]);commitHistory();changed();renderAll();
}

function deleteNode(id){
  var node=byId(id);if(!node)return;
  if(!confirm("确定删除节点「"+node.title+"」及其相关连线？"))return;
  flow.nodes=flow.nodes.filter(function(n){return n.id!==id;});
  flow.edges=flow.edges.filter(function(e){return e.from!==id&&e.to!==id;});
  setSelected([]);commitHistory();changed();renderAll();
}

function deleteEdge(id){
  flow.edges=flow.edges.filter(function(e){return e.id!==id;});setSelected([]);selected=null;commitHistory();changed();renderAll();
}

function deleteSelected(){
  if(!selected)return;
  if(selected.kind==="edge"){deleteEdge(selected.id);return;}
  var ids=selectedIds.slice();if(!ids.length)return;
  if(ids.length===1){deleteNode(ids[0]);return;}
  if(!confirm("确定删除所选的 "+ids.length+" 个节点及其相关连线？"))return;
  flow.nodes=flow.nodes.filter(function(node){return ids.indexOf(node.id)<0;});
  flow.edges=flow.edges.filter(function(edge){return ids.indexOf(edge.from)<0&&ids.indexOf(edge.to)<0;});
  setSelected([]);commitHistory();changed();renderAll();
}

function toggleConnect(){connectMode=!connectMode;connectFrom=null;updateToolbar();}

function onNodeClick(id,event){
  if(connectMode){
    if(!connectFrom){connectFrom=id;updateConnectUI();return;}
    if(connectFrom===id){connectFrom=null;updateConnectUI();return;}
    var edge={id:uid("edge"),from:connectFrom,to:id,type:"advance",label:"",color:"neutral"};
    flow.edges.push(edge);setSelected([]);selected={kind:"edge",id:edge.id};connectMode=false;connectFrom=null;commitHistory();changed();renderAll();return;
  }
  if(pointerSelectedId===id){pointerSelectedId=null;renderSelection();renderInspector();return;}
  if(event&&(event.ctrlKey||event.metaKey||event.shiftKey)){
    var next=selectedIds.slice(),index=next.indexOf(id);if(index>=0)next.splice(index,1);else next.push(id);setSelected(next,id);
  }else setSelected([id]);
  renderSelection();renderInspector();
}

function startNodeDrag(e,id,el){
  if(e.button!==0||e.target.closest(".flow-node-width-handle"))return;
  e.stopPropagation();
  if(!isSelectedId(id)){if(e.ctrlKey||e.metaKey||e.shiftKey){setSelected(selectedIds.concat([id]),id);pointerSelectedId=id;}else setSelected([id]);renderSelection();renderInspector();}
  var node=byId(id),zoom=currentZoom(),sx=e.clientX,sy=e.clientY,moved=false;
  var starts={};selectedNodes().forEach(function(value){starts[value.id]={x:Number(value.x),y:Number(value.y)};});
  function move(ev){
    var dx=(ev.clientX-sx)/zoom,dy=(ev.clientY-sy)/zoom;
    if(Math.abs(dx)+Math.abs(dy)>3)moved=true;
    if(!moved)return;
    if(flow.viewport.snap_grid){dx=snapValue(starts[id].x+dx)-starts[id].x;dy=snapValue(starts[id].y+dy)-starts[id].y;}
    selectedNodes().forEach(function(value){
      value.x=Math.round(clamp(starts[value.id].x+dx,0,stageWidth()-Number(value.width||220)-20));
      value.y=Math.round(clamp(starts[value.id].y+dy,0,stageHeight()-NODE_HEIGHT-20));
      var target=root.querySelector('[data-node-id="'+cssEscape(value.id)+'"]');if(target){target.style.left=value.x+"px";target.style.top=value.y+"px";}
    });
    renderStageSize();renderGroups();renderEdges();renderMinimap();
  }
  function up(){
    document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);
    if(moved){
      selectedNodes().forEach(function(value){
        var laneIndex=clamp(laneIndexAt(value.y+NODE_HEIGHT/2),0,flow.lanes.length-1);
        if(flow.lanes[laneIndex].collapsed){laneIndex=flow.lanes.findIndex(function(lane){return !lane.collapsed;});}
        if(laneIndex>=0)value.lane=flow.lanes[laneIndex].id;
      });
      suppressClick=true;pointerSelectedId=null;commitHistory();changed();renderAll();
    }
  }
  document.addEventListener("pointermove",move);document.addEventListener("pointerup",up);
}

function startPan(e){
  if(e.button!==0 || e.target.closest(".flow-node") || e.target.closest(".flow-edge-hit") || e.target.closest("button"))return;
  if(selectMode||e.shiftKey){startMarquee(e);return;}
  var board=boardEl(),sx=e.clientX,sy=e.clientY,sl=board.scrollLeft,st=board.scrollTop,moved=false;
  board.classList.add("panning");
  function move(ev){var dx=ev.clientX-sx,dy=ev.clientY-sy;if(Math.abs(dx)+Math.abs(dy)>3)moved=true;board.scrollLeft=sl-dx;board.scrollTop=st-dy;}
  function up(){document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);board.classList.remove("panning");if(moved){suppressClick=true;captureViewport();renderMinimap();}}
  document.addEventListener("pointermove",move);document.addEventListener("pointerup",up);
}

function startMarquee(e){
  e.preventDefault();var board=boardEl(),rect=board.getBoundingClientRect(),zoom=currentZoom(),box=root.querySelector("#flow-marquee");
  var sx=e.clientX-rect.left+board.scrollLeft,sy=e.clientY-rect.top+board.scrollTop,moved=false,base=(e.ctrlKey||e.metaKey)?selectedIds.slice():[];
  box.style.display="block";box.style.left=sx+"px";box.style.top=sy+"px";box.style.width="0";box.style.height="0";
  function move(ev){
    var ex=ev.clientX-rect.left+board.scrollLeft,ey=ev.clientY-rect.top+board.scrollTop;moved=Math.abs(ex-sx)+Math.abs(ey-sy)>4;
    var left=Math.min(sx,ex),top=Math.min(sy,ey),right=Math.max(sx,ex),bottom=Math.max(sy,ey);
    box.style.left=left+"px";box.style.top=top+"px";box.style.width=(right-left)+"px";box.style.height=(bottom-top)+"px";
    var stageLeft=left/zoom,stageTop=top/zoom,stageRight=right/zoom,stageBottom=bottom/zoom;
    var hits=flow.nodes.filter(nodeMatches).filter(function(node){return Number(node.x)<stageRight&&Number(node.x)+Number(node.width||220)>stageLeft&&Number(node.y)<stageBottom&&Number(node.y)+NODE_HEIGHT>stageTop;}).map(function(node){return node.id;});
    setSelected(base.concat(hits));renderSelection();
  }
  function up(){document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);box.style.display="none";if(moved){suppressClick=true;renderInspector();}}
  document.addEventListener("pointermove",move);document.addEventListener("pointerup",up);
}

function startNodeResize(e,id){
  if(e.button!==0)return;e.preventDefault();e.stopPropagation();setSelected([id]);renderSelection();renderInspector();
  var node=byId(id),startX=e.clientX,startWidth=Number(node.width||220),zoom=currentZoom(),moved=false;
  function move(ev){var width=clamp(startWidth+(ev.clientX-startX)/zoom,180,420);if(Math.abs(width-startWidth)>2)moved=true;node.width=snapValue(width);renderNodes();renderGroups();renderEdges();renderMinimap();}
  function up(){document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);if(moved){suppressClick=true;commitHistory();changed();renderAll();}}
  document.addEventListener("pointermove",move);document.addEventListener("pointerup",up);
}

function alignSelected(mode){
  var nodes=selectedNodes();if(nodes.length<2)return;
  var left=Math.min.apply(null,nodes.map(function(n){return Number(n.x);})),right=Math.max.apply(null,nodes.map(function(n){return Number(n.x)+Number(n.width||220);}));
  var top=Math.min.apply(null,nodes.map(function(n){return Number(n.y);})),bottom=Math.max.apply(null,nodes.map(function(n){return Number(n.y)+NODE_HEIGHT;}));
  nodes.forEach(function(node){if(mode==="left")node.x=left;if(mode==="center")node.x=(left+right-Number(node.width||220))/2;if(mode==="right")node.x=right-Number(node.width||220);if(mode==="top")node.y=top;if(mode==="middle")node.y=(top+bottom-NODE_HEIGHT)/2;if(mode==="bottom")node.y=bottom-NODE_HEIGHT;node.x=Math.round(node.x);node.y=Math.round(node.y);});
  commitHistory();changed();renderAll();
}

function distributeSelected(axis){
  var nodes=selectedNodes();if(nodes.length<3)return;
  if(axis==="horizontal"){
    nodes.sort(function(a,b){return Number(a.x)-Number(b.x);});var first=Number(nodes[0].x),lastRight=Number(nodes[nodes.length-1].x)+Number(nodes[nodes.length-1].width||220),total=nodes.reduce(function(sum,node){return sum+Number(node.width||220);},0),space=(lastRight-first-total)/(nodes.length-1),cursor=first;nodes.forEach(function(node){node.x=Math.round(cursor);cursor+=Number(node.width||220)+space;});
  }else{
    nodes.sort(function(a,b){return Number(a.y)-Number(b.y);});var top=Number(nodes[0].y),bottomEdge=Number(nodes[nodes.length-1].y)+NODE_HEIGHT,gap=(bottomEdge-top-NODE_HEIGHT*nodes.length)/(nodes.length-1),y=top;nodes.forEach(function(node){node.y=Math.round(y);y+=NODE_HEIGHT+gap;});
  }
  commitHistory();changed();renderAll();
}

function addLane(){
  var lane={id:uid("lane"),name:"新剧情线",color:COLORS[(flow.lanes.length%5)+1],height:DEFAULT_LANE_HEIGHT,collapsed:false};flow.lanes.push(lane);commitHistory();changed();renderAll();selected={kind:"lanes"};renderInspector();
}

function toggleLaneCollapsed(id){
  var lane=laneById(id);if(!lane)return;var geometry=captureLaneGeometry();lane.collapsed=!lane.collapsed;
  flow.nodes.forEach(function(node){var target=laneById(node.lane),offset=geometry.offsets[node.id];node.y=laneTop(node.lane)+(target&&target.collapsed?offset:clamp(offset,36,laneHeight(target)-NODE_HEIGHT-24));});
  selectedIds=selectedIds.filter(function(nodeId){var node=byId(nodeId);return node&&node.lane!==id;});if(selected&&selected.kind!=="lanes")setSelected(selectedIds);
  commitHistory();changed();renderAll();if(selected&&selected.kind==="lanes")renderInspector();
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
  flow.nodes.forEach(function(n){var offset=Number(n.y)-oldTops[n.lane],target=laneById(n.lane);n.y=laneTop(n.lane)+(target.collapsed?offset:clamp(offset,36,laneHeight(target)-NODE_HEIGHT-24));});
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
    var target=laneById(n.lane);n.y=laneTop(n.lane)+(target.collapsed?offset:clamp(offset,36,laneHeight(target)-NODE_HEIGHT-24));
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

function renderMinimap(){
  var mini=root&&root.querySelector("#flow-minimap svg"),board=boardEl();if(!mini||!board||!flow)return;
  var w=stageWidth(),h=stageHeight(),mw=190,mh=116,sx=mw/w,sy=mh/h;
  var html='<rect class="mini-bg" width="190" height="116"></rect>';
  var top=0;flow.lanes.forEach(function(lane){top+=laneHeight(lane);html+='<line class="mini-lane" x1="0" y1="'+(top*sy)+'" x2="190" y2="'+(top*sy)+'"></line>';});
  flow.nodes.filter(nodeMatches).forEach(function(node){var lane=laneById(node.lane),color=node.color&&node.color!=="neutral"?node.color:(lane?lane.color:"blue");html+='<rect class="mini-node color-'+esc(color)+'" x="'+(Number(node.x)*sx)+'" y="'+(Number(node.y)*sy)+'" width="'+Math.max(2,Number(node.width||220)*sx)+'" height="'+Math.max(2,NODE_HEIGHT*sy)+'"></rect>';});
  var zoom=currentZoom(),vx=board.scrollLeft/zoom*sx,vy=board.scrollTop/zoom*sy,vw=board.clientWidth/zoom*sx,vh=board.clientHeight/zoom*sy;
  html+='<rect class="mini-viewport" x="'+vx+'" y="'+vy+'" width="'+Math.min(mw,vw)+'" height="'+Math.min(mh,vh)+'"></rect>';mini.innerHTML=html;
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
  if(historyIndex<=0)return;historyIndex--;flow=JSON.parse(history[historyIndex]);setSelected([]);connectMode=false;connectFrom=null;changed();renderAll();
}
function redo(){
  if(historyIndex>=history.length-1)return;historyIndex++;flow=JSON.parse(history[historyIndex]);setSelected([]);connectMode=false;connectFrom=null;changed();renderAll();
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
