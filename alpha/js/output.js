var Output={
  win:null,
  ready:false,
  queue:[],
  currentKind:"idle",

  doc:function(){
    return "<!DOCTYPE html><html><head><meta charset='utf-8'><title>AMC Preso · Output</title><style>"+
    "html,body{margin:0;height:100%;background:#07090e;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}"+
    "#stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}"+
    ".slide{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:6% 8%}"+
    ".verse{background:radial-gradient(120% 95% at 50% 0%,#24314e 0%,#101827 55%,#090d14 100%)}"+
    ".lyrics{background:linear-gradient(180deg,#182236,#0b0f17)}"+
    ".splash{background:radial-gradient(100% 120% at 50% 100%,#3a2f10 0%,#161207 60%,#0a0805 100%)}"+
    ".logo{background:radial-gradient(120% 95% at 50% 0%,#1c2333,#0a0d14)}"+
    ".idle{background:#07090e}"+
    ".vlogo{position:absolute;top:2.2%;right:2.8%;font-size:1.1vmin;letter-spacing:.32em;color:#5c6b8a;text-transform:uppercase}"+
    ".vtxt{font-family:Georgia,'Times New Roman',serif;color:#f3ecdc;max-width:78%;text-shadow:0 2px 24px rgba(0,0,0,.6);line-height:1.55;animation:fadein 1.1s ease}"+
    ".vtxt.xl{font-size:4.6vmin}.vtxt.lg{font-size:3.6vmin}.vtxt.md{font-size:2.7vmin}"+
    ".vref{font-family:Georgia,serif;font-size:1.7vmin;letter-spacing:.34em;color:#e9c465;margin-top:3.4vmin;text-transform:uppercase}"+
    ".ltitle{position:absolute;top:2.4%;left:3%;font-size:1.2vmin;letter-spacing:.3em;color:#7e8aa5;text-transform:uppercase}"+
    ".ltxt{font-family:Georgia,serif;font-size:4.2vmin;color:#f3ecdc;line-height:1.7;animation:fadein .8s ease}"+
    ".dots{display:flex;gap:1vmin;margin-top:3.4vmin}"+
    ".dots i{width:.55vmin;height:.55vmin;border-radius:50%;background:#3a4560}"+
    ".dots i.on{background:#e9c465}"+
    ".sp-title{font-size:3.4vmin;letter-spacing:.5em;color:#e9c465;margin-top:3vmin;font-weight:700;text-transform:uppercase}"+
    ".sp-sub{font-size:1.6vmin;color:#8b93a7;margin-top:1.6vmin}"+
    ".ringwrap{display:flex;align-items:center;justify-content:center}"+
    ".ring{width:14vmin;height:14vmin;transform:rotate(-90deg)}"+
    ".ring .bg{fill:none;stroke:#2a3350;stroke-width:1vmin}"+
    ".ring .fg{fill:none;stroke:#e9c465;stroke-width:1vmin;stroke-linecap:round}"+
    ".ringtxt{position:absolute;font-size:4.4vmin;font-weight:800;color:#e9c465;font-family:Georgia,serif}"+
    ".cd-time{font-family:Georgia,serif;font-size:9vmin;color:#f3ecdc}"+
    ".cd-label{font-size:1.8vmin;letter-spacing:.4em;color:#8b93a7;text-transform:uppercase;margin-top:1vmin}"+
    "#alertlayer{position:absolute;left:0;right:0;bottom:8%;display:flex;justify-content:center;pointer-events:none;z-index:50}"+
    "#alertlayer div{background:rgba(9,12,20,.88);border:1px solid #6b541f;border-left:.5vmin solid #e9c465;border-radius:.6vmin;padding:1.2vmin 3vmin;font-size:1.9vmin;color:#f3ecdc;letter-spacing:.04em}"+
    "#black{position:absolute;inset:0;background:#000;opacity:0;transition:opacity .4s;z-index:100}"+
    "#hint{position:absolute;bottom:1.5%;left:2%;font-size:1vmin;color:#3d4658;z-index:200}"+
    "#fsbtn{position:absolute;top:2%;right:2%;z-index:200;font-size:1.2vmin;letter-spacing:.28em;color:#8b93a7;background:rgba(10,13,20,.65);border:1px solid #2a3350;border-radius:.4vmin;padding:.7vmin 1.6vmin;cursor:pointer}"+
    "#fsbtn:hover{color:#e9c465;border-color:#6b541f}"+
    "@keyframes fadein{from{opacity:0;transform:translateY(1.5vmin)}to{opacity:1;transform:none}}"+
    "</style></head><body><div id='stage'><div class='slide idle'><div class='sp-sub'>AMC Preso</div></div></div></div>"+
    "<div id='alertlayer'></div><div id='black'></div><div id='hint'>AMC Preso output</div><div id='fsbtn'>FULLSCREEN</div>"+
    "<script>"+
    "var ringTimer=null,cdTimer=null,alertTimer=null;"+
    "function el(i){return document.getElementById(i);}"+
    "function sizeClass(t){return t.length<90?'xl':(t.length<200?'lg':'md');}"+
    "function stage(html){clearRing();el('stage').innerHTML=html;}"+
    "function clearRing(){if(ringTimer){clearInterval(ringTimer);ringTimer=null;}if(cdTimer){clearInterval(cdTimer);cdTimer=null;}}"+
    "function verse(m){stage(\"<div class='slide verse'><div class='vlogo'>AMC CHURCH</div><div class='vtxt \"+sizeClass(m.text)+\"'>\"+m.text+\"</div><div class='vref'>\"+m.ref+\" &middot; KJV</div></div>\");}"+
    "function lyrics(m){var dots='';for(var i=0;i<m.total;i++){dots+=\"<i class='\"+(i===m.idx?\"on\":\"\")+\"'></i>\";}stage(\"<div class='slide lyrics'><div class='ltitle'>\"+m.title+\"</div><div class='ltxt'>\"+m.line+\"</div><div class='dots'>\"+dots+\"</div></div>\");}"+
    "function splash(m){stage(\"<div class='slide splash'><div class='ringwrap'><svg class='ring' viewBox='0 0 100 100'><circle class='bg' cx='50' cy='50' r='45'/><circle class='fg' id='ringfg' cx='50' cy='50' r='45' stroke-dasharray='283' stroke-dashoffset='0'/></svg><div class='ringtxt' id='ringnum'>\"+m.seconds+\"</div></div><div class='sp-title'>\"+m.title+\"</div><div class='sp-sub'>\"+m.subtitle+\"</div></div>\");"+
    "var total=m.seconds*1000,t0=Date.now(),C=283;"+
    "ringTimer=setInterval(function(){var p=Math.min(1,(Date.now()-t0)/total);el('ringfg').setAttribute('stroke-dashoffset',String(C*p));el('ringnum').textContent=String(Math.max(0,Math.ceil(m.seconds*(1-p))));if(p>=1)clearRing();},100);}"+
    "function countdown(m){var end=Date.now()+m.seconds*1000;function draw(){var s=Math.max(0,Math.round((end-Date.now())/1000));var mm=String(Math.floor(s/60)),ss=String(s%60);stage(\"<div class='slide verse'><div class='cd-time'>\"+mm+\":\"+(ss.length<2?'0':'')+ss+\"</div><div class='cd-label'>\"+(m.label||'Service begins soon')+\"</div></div>\");if(s<=0){clearRing();return;}}"+
    "draw();cdTimer=setInterval(draw,250);}"+
    "function alertMsg(m){if(alertTimer)clearTimeout(alertTimer);var d=document.createElement('div');d.innerHTML='<b style=\"color:#e9c465;letter-spacing:.2em;font-size:1.6vmin;margin-right:1.4vmin\">ALERT</b>'+m.text;var layer=el('alertlayer');layer.innerHTML='';layer.appendChild(d);alertTimer=setTimeout(function(){layer.innerHTML='';},(m.seconds||20)*1000);}"+
    "function blackout(on){el('black').style.opacity=on?1:0;}"+
    "function logo(){stage(\"<div class='slide logo'><div class='sp-title' style='font-size:2.6vmin;letter-spacing:.7em'>AMC CHURCH</div></div>\");}"+
    "function clearOut(){stage(\"<div class='slide idle'><div class='sp-sub'>AMC Preso</div></div>\");}"+
    "window.addEventListener('message',function(e){var m=e.data;if(!m||!m.cmd)return;"+
    "if(m.cmd==='verse')verse(m);else if(m.cmd==='lyrics')lyrics(m);else if(m.cmd==='splash')splash(m);else if(m.cmd==='countdown')countdown(m);else if(m.cmd==='alert')alertMsg(m);else if(m.cmd==='blackout')blackout(true);else if(m.cmd==='unblackout')blackout(false);else if(m.cmd==='logo')logo();else if(m.cmd==='clear')clearOut();});"+
    "document.addEventListener('dblclick',function(){if(document.documentElement.requestFullscreen)document.documentElement.requestFullscreen();});"+
    "document.getElementById('fsbtn').addEventListener('click',function(){if(document.documentElement.requestFullscreen)document.documentElement.requestFullscreen();});"+
    "try{if(window.opener)window.opener.postMessage({cmd:'ready'},'*');}catch(e){}"+
    "<\/script></body></html>";
  },

  open:function(){
    if(this.win&&!this.win.closed){this.win.focus();return true;}
    this.win=window.open("","preso_output","width=1120,height=640");
    if(!this.win)return false;
    this.ready=false;
    this.queue=[];
    this.win.document.open();
    this.win.document.write(this.doc());
    this.win.document.close();
    return true;
  },

  onReady:function(){
    this.ready=true;
    var q=this.queue;
    this.queue=[];
    for(var i=0;i<q.length;i++)this.send(q[i]);
  },

  send:function(cmd){
    cmd._k=cmd.cmd;
    this.currentKind=cmd.cmd;
    if(!this.win||this.win.closed)return;
    if(!this.ready){this.queue.push(cmd);return;}
    try{this.win.postMessage(cmd,"*");}catch(e){}
  },

  isOpen:function(){
    return !!(this.win&&!this.win.closed);
  }
};

window.addEventListener("message",function(e){
  if(e.data&&e.data.cmd==="ready"&&e.source===Output.win)Output.onReady();
});
