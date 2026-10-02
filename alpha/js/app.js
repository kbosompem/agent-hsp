var ALPHA_VERSION="0.4";
var BOOKS=KJV_DATA.books;

var AMAZING_GRACE={
  title:"Amazing Grace",
  lines:["Amazing grace, how sweet the sound","That saved a wretch like me","I once was lost, but now am found","Was blind, but now I see"],
  times:[0,6,12,18]
};

var DEMO_LINES=[
  {t:0,text:"Good morning church. Please open your Bibles with me."},
  {t:1800,text:"Turn to the book of Psalms, chapter twenty three."},
  {t:3600,text:"The Lord is my shepherd, I shall not want."},
  {t:6000,text:"And in John chapter three verse sixteen we see the heart of God for the world."},
  {t:8400,text:"For God so loved the world, that he gave his only begotten Son."},
  {t:10600,text:"Paul writes in Romans five verse eight, while we were yet sinners, Christ died for us."},
  {t:13200,text:"The fool hath said in his heart, there is no God."},
  {t:15600,text:"Turn to Philippians chapter one, verses one through four."},
  {t:18400,text:"Next verse, please."},
  {t:20200,text:"And now church, I believe it is time for praise and worship."}
];

var App={
  mode:"copilot",
  hold:false,
  holdStarted:0,
  listening:false,
  windowMs:2500,
  diagLast:"",
  diagFail:0,
  lastLiveText:"",
  lastConsumedAt:0,
  snippetOn:true,
  cmdCooldown:{},
  transcript:[],
  liveLine:"",
  cards:[],
  cardSeq:1,
  shownRefs:{},
  cueFired:{},
  sessionLog:[],
  verseSeq:null,
  song:null,
  songTimer:null,
  songActive:false,
  audioEl:null,
  blacked:false,
  demoRunning:false,
  demoTimers:[],
  currentScheduleItem:1,
  cues:[
    {id:"praise",item:"Praise & Worship",phrase:"it is time for praise and worship",threshold:0.65},
    {id:"praise2",item:"Praise & Worship",phrase:"let us enter into praise and worship",threshold:0.65},
    {id:"praise3",item:"Praise & Worship",phrase:"worship team come up",threshold:0.65}
  ],
  schedule:[
    {n:1,title:"Welcome & Prayer",kind:"manual"},
    {n:2,title:"Praise & Worship",kind:"ai"},
    {n:3,title:"Scripture Reading",kind:"manual"},
    {n:4,title:"Sermon · God So Loved",kind:"ai"},
    {n:5,title:"Offering",kind:"manual"},
    {n:6,title:"Announcements",kind:"manual"}
  ]
};

function log(kind,detail){
  App.sessionLog.push({t:new Date().toISOString(),kind:kind,detail:detail});
}

function $(id){return document.getElementById(id);}

function showError(msg){
  $("err").style.display="block";
  $("errText").textContent=msg;
  log("error",msg);
  setTimeout(function(){$("err").style.display="none";},8000);
}

function setMode(m){
  App.mode=m;
  $("btnModeManual").classList.toggle("on",m==="manual");
  $("btnModeCopilot").classList.toggle("on",m==="copilot");
  $("btnModeAutopilot").classList.toggle("on",m==="autopilot");
  $("statusMode").textContent=m.toUpperCase();
  log("mode",m);
  if(m==="manual"&&App.listening)toggleListen();
}

function setHold(v){
  if(v===App.hold)return;
  App.hold=v;
  if(v){App.holdStarted=Date.now();}
  else{
    var delta=Date.now()-App.holdStarted;
    App.cards.forEach(function(c){
      if(c.fireAt)c.fireAt+=delta;
      if(c.expiresAt)c.expiresAt+=delta;
    });
  }
  $("holdBadge").style.display=v?"inline-flex":"none";
  $("btnHold").classList.toggle("on",v);
  log("hold",v?"engaged":"released");
}

function commitLine(text){
  var refs=coreParseRefs(text);
  var cue=App.mode!=="manual"?coreMatchCue(text,App.cues):null;
  App.transcript.push({text:text,refs:refs,cue:cue});
  if(App.transcript.length>200)App.transcript.shift();
  renderTranscript();
  runDetection(text,true);
}

function commitLive(){
  if(!App.liveLine)return;
  var t=App.liveLine;
  App.liveLine="";
  App.lastLiveText="";
  var last=App.transcript[App.transcript.length-1];
  if(last&&last.text===t)return;
  commitLine(t);
}

var VOICE_COMMANDS=[
  {id:"next",phrases:["next verse","next slide","next line","go next"],fn:function(){nextSlide();}},
  {id:"prev",phrases:["previous verse","previous slide","go back","last verse"],fn:function(){prevSlide();}}
];

function matchVoiceCommand(text){
  var norm=core.normalizeText(text);
  if(!norm)return null;
  var now=Date.now();
  for(var i=0;i<VOICE_COMMANDS.length;i++){
    var cmd=VOICE_COMMANDS[i];
    for(var p=0;p<cmd.phrases.length;p++){
      if(norm.indexOf(cmd.phrases[p])>=0){
        if(App.cmdCooldown[cmd.id]&&now-App.cmdCooldown[cmd.id]<1500)return null;
        App.cmdCooldown[cmd.id]=now;
        cmd.phrase=cmd.phrases[p];
        return cmd;
      }
    }
  }
  return null;
}

function detectSnippet(text){
  var words=core.normalizeText(text).split(" ");
  if(words.length<4)return null;
  var max=Math.min(words.length,14);
  for(var len=max;len>=4;len--){
    var phrase=words.slice(words.length-len).join(" ");
    var hits=core.searchSnippets(phrase,BOOKS,1);
    if(hits.length&&hits[0].score>=2.5)return hits[0];
  }
  return null;
}

function runDetection(text,committed){
  if(App.mode==="manual")return;
  var cmd=matchVoiceCommand(text);
  if(cmd){cmd.fn();log("voice-command",cmd.phrase);return;}
  var refs=coreParseRefs(text);
  var now=Date.now();
  refs.forEach(function(r){
    var label=coreRefLabel(r);
    if(App.shownRefs[label]&&now-App.shownRefs[label]<180000)return;
    if(App.cards.some(function(c){return c.label===label&&c.status!=="done";}))return;
    App.shownRefs[label]=now;
    createVerseCard(r,label,false);
  });
  if(committed&&App.snippetOn){
    var sn=detectSnippet(text);
    if(sn){
      var sLabel=coreRefLabel(sn);
      if(!(App.shownRefs[sLabel]&&now-App.shownRefs[sLabel]<180000)&&
         !App.cards.some(function(c){return c.label===sLabel&&c.status!=="done";})){
        App.shownRefs[sLabel]=now;
        createVerseCard(sn,sLabel,true);
      }
    }
  }
  var cue=coreMatchCue(text,App.cues);
  if(cue){
    var id=cue.cue.id;
    if(App.cueFired[id]&&now-App.cueFired[id]<300000)return;
    if(App.cards.some(function(c){return c.type==="cue"&&c.status!=="done";}))return;
    App.cueFired[id]=now;
    createCueCard(cue);
  }
}

function createVerseCard(ref,label,isQuote){
  var now=Date.now();
  var card={
    id:App.cardSeq++,
    type:"verse",
    kind:isQuote?"quote":"ref",
    label:label,
    text:coreGetVerse(ref),
    ref:ref,
    created:now,
    fireAt:App.mode==="autopilot"?now+1500:now+3000,
    expiresAt:null,
    status:"pending"
  };
  App.cards.push(card);
  log("verse-detected",label);
  renderCards();
}

function createCueCard(cue){
  var now=Date.now();
  var card={
    id:App.cardSeq++,
    type:"cue",
    label:"Cue · "+cue.cue.item,
    sub:'"'+cue.cue.phrase+'"',
    score:cue.score,
    created:now,
    fireAt:App.mode==="autopilot"?now+6000:null,
    expiresAt:App.mode==="copilot"?now+8000:null,
    status:"pending",
    chain:null
  };
  App.cards.push(card);
  log("cue-detected",cue.cue.phrase+" ("+cue.score.toFixed(2)+")");
  renderCards();
}

function topPendingCard(){
  for(var i=0;i<App.cards.length;i++){
    if(App.cards[i].status==="pending")return App.cards[i];
  }
  return null;
}

function approveCard(id){
  var c=App.cards.find(function(x){return x.id===id;});
  if(c&&c.status==="pending")fireCard(c);
}

function dismissCard(id){
  var c=App.cards.find(function(x){return x.id===id;});
  if(!c)return;
  if(c.chain)clearTimeout(c.chain);
  c.status="dismissed";
  log("card-dismissed",c.label);
  App.cards=App.cards.filter(function(x){return x.id!==c.id;});
  renderCards();
}

function stopCard(id){
  var c=App.cards.find(function(x){return x.id===id;});
  if(!c)return;
  if(c.chain)clearTimeout(c.chain);
  c.chain=null;
  stopSong();
  Output.send({cmd:"clear"});
  previewClear();
  App.cards=App.cards.filter(function(x){return x.id!==c.id;});
  log("cue-stopped",c.label);
  renderCards();
}

function fireCard(c){
  if(c.type==="verse"){
    showVerseSlides(c.ref,c.label);
    c.status="done";
    log("verse-shown",c.label);
    App.cards=App.cards.filter(function(x){return x.id!==c.id;});
  }else if(c.type==="cue"){
    c.status="running";
    c.fireAt=null;
    App.currentScheduleItem=2;
    renderSchedule();
    Output.send({cmd:"splash",title:"PRAISE & WORSHIP",subtitle:"Worship team · get ready",seconds:12});
    previewSplash();
    log("cue-fired",c.label+" · splash 12s then track");
    c.chain=setTimeout(function(){
      startSong();
      c.chain=null;
    },12000);
  }
  renderCards();
}

function showVerseSlides(ref,label){
  var slides=[];
  var book=BOOKS[ref.book];
  var chapter=book.c[ref.chapter-1];
  if(ref.verse===null){
    var n=Math.min(chapter.length,6);
    for(var v=1;v<=n;v++)slides.push({ref:coreRefLabel(ref)+":"+v,text:chapter[v-1]});
    if(chapter.length>n)slides.push({ref:label,text:"…"});
  }else{
    var end=ref.endVerse||ref.verse;
    for(var v2=ref.verse;v2<=Math.min(end,ref.verse+7);v2++)slides.push({ref:labelForVerse(ref,v2),text:chapter[v2-1]});
  }
  App.verseSeq={label:label,slides:slides,idx:0};
  showSlideIdx(0);
}

function labelForVerse(ref,v){
  var name=BOOKS[ref.book].n==="Psalms"?"Psalm":BOOKS[ref.book].n;
  if(BOOKS[ref.book].c.length===1)return name+" "+v;
  return name+" "+ref.chapter+":"+v;
}

function showSlideIdx(i){
  var seq=App.verseSeq;
  if(!seq)return;
  seq.idx=Math.max(0,Math.min(i,seq.slides.length-1));
  var s=seq.slides[seq.idx];
  Output.send({cmd:"verse",ref:s.ref,text:s.text});
  previewVerse(s.ref,s.text);
  $("slideInfo").textContent=seq.label+" · slide "+(seq.idx+1)+"/"+seq.slides.length;
}

function nextSlide(){
  if(App.songActive&&App.song){sendLyrics(App.song.idx+1);return;}
  if(App.verseSeq)showSlideIdx(App.verseSeq.idx+1);
}

function prevSlide(){
  if(App.songActive&&App.song){sendLyrics(App.song.idx-1);return;}
  if(App.verseSeq)showSlideIdx(App.verseSeq.idx-1);
}

function startSong(){
  App.song={title:AMAZING_GRACE.title,lines:AMAZING_GRACE.lines,times:AMAZING_GRACE.times,idx:0};
  App.songActive=true;
  var usedAudio=false;
  if(App.audioEl&&App.audioEl.src){
    usedAudio=true;
    App.audioEl.currentTime=0;
    App.audioEl.ontimeupdate=function(){
      if(!App.songActive)return;
      var t=App.audioEl.currentTime;
      var idx=0;
      for(var i=0;i<App.song.times.length;i++){if(t>=App.song.times[i])idx=i;}
      if(idx!==App.song.idx)sendLyrics(idx);
    };
    App.audioEl.onended=function(){App.songActive=false;$("slideInfo").textContent=App.song.title+" · done";};
    var p=App.audioEl.play();
    if(p&&p.catch)p.catch(function(){usedAudio=false;startTimerLyrics();});
  }
  if(!usedAudio&&!App.songTimer)startTimerLyrics();
  sendLyrics(0);
  log("track-started",App.song.title+(usedAudio?" (audio file)":" (auto-advance)"));
}

function startTimerLyrics(){
  App.songTimer=setInterval(function(){
    if(!App.songActive){clearInterval(App.songTimer);App.songTimer=null;return;}
    if(App.song.idx<App.song.lines.length-1)sendLyrics(App.song.idx+1);
    else{clearInterval(App.songTimer);App.songTimer=null;App.songActive=false;$("slideInfo").textContent=App.song.title+" · done";}
  },6500);
}

function sendLyrics(i){
  var s=App.song;
  if(!s)return;
  s.idx=Math.max(0,Math.min(i,s.lines.length-1));
  Output.send({cmd:"lyrics",title:s.title,line:s.lines[s.idx],idx:s.idx,total:s.lines.length});
  previewLyrics(s.title,s.lines[s.idx],s.idx,s.lines.length);
  $("slideInfo").textContent=s.title+" · line "+(s.idx+1)+"/"+s.lines.length;
}

function stopSong(){
  App.songActive=false;
  if(App.songTimer){clearInterval(App.songTimer);App.songTimer=null;}
  if(App.audioEl){App.audioEl.pause();App.audioEl.ontimeupdate=null;}
}

function doBlackout(){
  App.blacked=!App.blacked;
  Output.send({cmd:App.blacked?"blackout":"unblackout"});
  if(App.blacked)previewBlack();else previewClear();
  $("btnBlack").classList.toggle("on",App.blacked);
  log("blackout",App.blacked?"on":"off");
}

function doLogo(){
  Output.send({cmd:"logo"});
  previewLogo();
  App.verseSeq=null;
  App.songActive=false;
  log("logo","shown");
}

function doCountdown(){
  Output.send({cmd:"countdown",seconds:300,label:"Service begins soon"});
  previewCountdown();
  log("countdown","5:00");
}

function doAlert(){
  var v=$("alertInput").value.trim();
  if(!v)return;
  Output.send({cmd:"alert",text:v});
  $("alertInput").value="";
  log("alert",v);
}

function coreParseRefs(text){return core.parseRefs(text,BOOKS);}
function coreRefLabel(r){return core.refLabel(BOOKS,r);}
function coreGetVerse(r){return core.getVerse(BOOKS,r);}
function coreMatchCue(text,cues){return core.matchCue(text,cues);}

function renderTranscript(){
  var h="";
  App.transcript.slice(-40).forEach(function(l){
    var badges="";
    if(l.refs&&l.refs.length){
      l.refs.forEach(function(r){badges+="<span class='chip gold'>"+coreRefLabel(r)+"</span>";});
    }
    if(l.cue)badges+="<span class='chip teal'>cue: "+l.cue.cue.item+"</span>";
    h+="<div class='tr"+(badges?" on":"")+"'>"+core.escapeHtml(l.text)+" "+badges+"</div>";
  });
  if(App.liveLine)h+="<div class='tr live'><span class='pulse'></span> "+core.escapeHtml(App.liveLine)+"</div>";
  var box=$("transcript");
  box.innerHTML=h;
  box.scrollTop=box.scrollHeight;
}

function renderCards(){
  var h="";
  var now=Date.now();
  App.cards.forEach(function(c){
    var pct=0,timeLeft="";
    if(c.status==="pending"&&c.fireAt){
      timeLeft="fires in "+Math.max(0,(c.fireAt-now)/1000).toFixed(1)+" s";
      pct=Math.max(0,Math.min(100,100*(now-c.created)/((c.fireAt-c.created)||1)));
    }else if(c.status==="pending"&&c.expiresAt){
      timeLeft="expires in "+Math.max(0,(c.expiresAt-now)/1000).toFixed(1)+" s";
      pct=100-100*Math.max(0,(c.expiresAt-now))/(c.expiresAt-c.created);
    }else if(c.status==="running"){
      timeLeft="running · splash then track";
      pct=100;
    }
    var btns="";
    if(c.status==="pending"){
      btns="<button class='btn ok' onclick='approveCard("+c.id+")'>Enter · Show</button>"+
           "<button class='btn ghost' onclick='dismissCard("+c.id+")'>Esc · Skip</button>";
    }else if(c.status==="running"){
      btns="<button class='btn danger' onclick='stopCard("+c.id+")'>Stop sequence</button>";
    }
    var scoreChip=c.score!==undefined?"<span class='chip teal'>"+c.score.toFixed(2)+"</span>":(c.kind==="quote"?"<span class='chip teal'>quote match</span>":"<span class='chip gold'>reference</span>");
    h+="<div class='evcard"+(c.status==="running"?" act":"")+"'>"+
       "<h5>"+core.escapeHtml(c.label)+" "+scoreChip+"</h5>"+
       "<div class='sub'>"+core.escapeHtml(((c.text||c.sub||"").slice(0,140)))+(((c.text||c.sub||"").length>140)?"…":"")+"</div>"+
       "<div class='bar'><i style='width:"+pct+"%'></i></div>"+
       "<div class='rowsp'><span class='sub'>"+timeLeft+"</span><span class='row'>"+btns+"</span></div></div>";
  });
  if(!h)h="<div class='sub' style='padding:8px 2px'>No pending decisions.</div>";
  $("cards").innerHTML=h;
}

function renderSchedule(){
  var h="";
  App.schedule.forEach(function(s){
    var cls=s.n===App.currentScheduleItem?"li on":"li";
    var badge=s.kind==="ai"?"<span class='chip gold'>AI</span>":"<span class='chip'>manual</span>";
    h+="<div class='"+cls+"'><span>"+s.n+" · "+s.title+"</span>"+badge+"</div>";
    if(s.n===2&&s.kind==="ai"){
      App.cues.forEach(function(c){
        h+="<div class='cuephrase'>"+core.escapeHtml('"'+c.phrase+'"')+"</div>";
      });
    }
  });
  $("schedule").innerHTML=h;
}

function previewVerse(ref,text){
  var cls=text.length<90?"xl":text.length<200?"lg":"md";
  $("preview").innerHTML="<div class='slide verse'><span class='vlogo'>AMC CHURCH</span><div class='vtxt "+cls+"'>"+core.escapeHtml(text)+"</div><div class='vref'>"+core.escapeHtml(ref)+" · KJV</div></div>";
  $("previewKind").textContent="verse";
}
function previewLyrics(title,line,idx,total){
  var dots="";
  for(var i=0;i<total;i++)dots+="<i class='"+(i===idx?"on":"")+"'></i>";
  $("preview").innerHTML="<div class='slide lyrics'><span class='ltitle'>"+core.escapeHtml(title)+"</span><div class='ltxt'>"+core.escapeHtml(line)+"</div><div class='dots'>"+dots+"</div></div>";
  $("previewKind").textContent="lyrics";
}
function previewSplash(){
  $("preview").innerHTML="<div class='slide splash'><div class='ring'><span>12</span></div><div class='sptitle'>PRAISE &amp; WORSHIP</div><div class='spsub'>Worship team · get ready</div></div>";
  $("previewKind").textContent="splash";
  $("slideInfo").textContent="Praise & Worship · splash 12 s";
}
function previewCountdown(){$("preview").innerHTML="<div class='slide verse'><div class='cdtime'>5:00</div><div class='cdlabel'>Service begins soon</div></div>";$("previewKind").textContent="countdown";}
function previewLogo(){$("preview").innerHTML="<div class='slide logo'><div class='sptitle sm'>AMC CHURCH</div></div>";$("previewKind").textContent="logo";}
function previewAlert(t){$("preview").innerHTML="<div class='slide video'><div class='banner'><div><b>ALERT</b> "+core.escapeHtml(t)+"</div></div></div>";$("previewKind").textContent="alert";}
function previewClear(){$("preview").innerHTML="<div class='slide idle'><div class='spsub'>Agent HSP</div></div>";$("previewKind").textContent="idle";}
function previewBlack(){$("preview").innerHTML="<div class='slide blacked'></div>";$("previewKind").textContent="blackout";}

function startDemo(){
  if(App.demoRunning){stopDemo();return;}
  ensureOutput();
  App.demoRunning=true;
  App.cards=[];
  App.shownRefs={};
  App.cueFired={};
  App.transcript=[];
  App.liveLine="";
  stopSong();
  $("btnDemo").classList.add("on");
  $("btnDemo").textContent="Stop scripted demo";
  log("demo","started");
  DEMO_LINES.forEach(function(l){
    App.demoTimers.push(setTimeout(function(){commitLine(l.text);},l.t));
  });
  var last=DEMO_LINES[DEMO_LINES.length-1].t+6000;
  App.demoTimers.push(setTimeout(function(){
    App.demoRunning=false;
    $("btnDemo").classList.remove("on");
    $("btnDemo").textContent="Run scripted demo";
    log("demo","finished");
  },last));
}

function stopDemo(){
  App.demoTimers.forEach(clearTimeout);
  App.demoTimers=[];
  if(App.demoRunning){
    App.demoRunning=false;
    $("btnDemo").classList.remove("on");
    $("btnDemo").textContent="Run scripted demo";
    log("demo","stopped");
  }
}

function panic(){
  stopDemo();
  stopSong();
  App.cards=[];
  App.blacked=true;
  Output.send({cmd:"blackout"});
  previewBlack();
  setHold(false);
  log("panic","all cleared, blackout");
  renderCards();
}

function micErrorMessage(e){
  if(e&&e.name==="NotAllowedError")return "Microphone blocked. Click the camera icon in the address bar, allow the microphone, then press Listen again.";
  if(e&&e.name==="NotFoundError")return "No microphone found. Connect one or pick another input, then Refresh.";
  return "Microphone error: "+(e&&e.message?e.message:String(e));
}

function updateListenStatus(snapRms,thr,extra){
  var el=$("listenStatus");
  if(!App.listening&&!extra){el.innerHTML="";return;}
  var hearing=snapRms>Math.max(thr,0.003);
  var head=hearing?"<span class='lst-ok'>hearing you</span>":"<span class='lst-quiet'>quiet</span>";
  el.innerHTML=head+" · level "+snapRms.toFixed(4)+" · floor "+AudioCapture.noise.toFixed(4)+" · threshold "+thr.toFixed(4)+(extra?" · "+extra:"");
}

function ensureOutput(){
  if(Output.isOpen())return true;
  if(Output.open())return true;
  showError("Popup blocked. Allow popups for this page (icon in the address bar), then click Open output window again.");
  return false;
}

async function toggleListen(){
  if(App.listening){
    App.listening=false;
    AudioCapture.stop();
    commitLive();
    $("btnListen").classList.remove("on");
    $("btnListen").textContent="Listen";
    updateListenStatus(0,AudioCapture.threshold,"stopped");
    log("listen","stopped");
    return;
  }
  if(STT.status!=="ready"){showError("Load the speech model first.");return;}
  if(!ensureOutput())return;
  try{
    App.processing=!$("rawInput").checked;
    await AudioCapture.start($("micSel").value||null,App.processing);
    App.listening=true;
    App.lastConsumedAt=Date.now();
    $("btnListen").classList.add("on");
    $("btnListen").textContent="Stop listening";
    log("listen","started · "+($("micSel").selectedOptions[0]?$("micSel").selectedOptions[0].textContent:"default mic")+" · processing "+(App.processing?"on":"off")+" · ctx "+AudioCapture.ctxState());
    refreshMics();
    listenLoop();
  }catch(e){
    showError(micErrorMessage(e));
  }
}

async function listenLoop(){
  if(!App.listening)return;
  try{
    var gap=(Date.now()-App.lastConsumedAt)/1000+0.5;
    var want=Math.min(Math.max(gap,4),28);
    var pcm=await AudioCapture.getRecentPCM(want);
    App.lastConsumedAt=Date.now();
    var snapRms=rmsOf(pcm.data);
    AudioCapture.updateLevels(snapRms);
    var thr=Math.max(AudioCapture.threshold,0.003);
    updateListenStatus(snapRms,thr,"span "+want.toFixed(1)+" s"+(STT.lastMs?" · "+STT.lastMs+" ms":""));
    if(pcm.data.length>pcm.sr&&snapRms>thr){
      var f16=await AudioCapture.to16k(pcm.data,pcm.sr);
      var text=await STT.transcribe(f16);
      App.diagFail=0;
      App.diagLast="span "+want.toFixed(1)+" s · "+STT.lastMs+" ms · "+(text?("\u201C"+text.slice(0,60)+(text.length>60?"\u2026":"")+"\u201D"):"(nothing usable)");
      if(text){
        if(text===App.lastLiveText){
          commitLive();
        }else{
          App.lastLiveText=text;
          App.liveLine=text;
          renderTranscript();
          if(App.mode!=="manual")runDetection(text);
        }
      }else{
        commitLive();
      }
    }else{
      App.diagLast="quiet · level "+snapRms.toFixed(4)+" \u2264 threshold "+thr.toFixed(4);
      commitLive();
    }
  }catch(e){
    App.diagFail+=1;
    App.diagLast="error: "+(e&&e.message?e.message:String(e));
    if(App.diagFail>=3){
      showError("Transcription keeps failing: "+App.diagLast+". Listening stopped.");
      App.listening=false;
      AudioCapture.stop();
      $("btnListen").classList.remove("on");
      $("btnListen").textContent="Listen";
      return;
    }
  }
  if(App.listening)setTimeout(listenLoop,App.windowMs);
}

async function testInput(){
  var wasListening=App.listening;
  if(!wasListening&&!AudioCapture.running){
    try{
      App.processing=!$("rawInput").checked;
      await AudioCapture.start($("micSel").value||null,App.processing);
      refreshMics();
    }catch(e){
      showError(micErrorMessage(e));
      return;
    }
  }
  $("btnTestMic").disabled=true;
  $("listenStatus").innerHTML="<span class='lst-ok'>test: speak for 10 seconds…</span>";
  await new Promise(function(r){setTimeout(r,10000);});
  var pcm=await AudioCapture.getRecentPCM(9);
  var snapRms=rmsOf(pcm.data);
  AudioCapture.updateLevels(snapRms);
  var thr=Math.max(AudioCapture.threshold,0.003);
  var peak=AudioCapture.peak;
  var heard="";
  if(STT.status==="ready"&&pcm.data.length>pcm.sr){
    try{
      var f16=await AudioCapture.to16k(pcm.data,pcm.sr);
      heard=await STT.transcribe(f16);
    }catch(e){
      heard="(transcribe failed: "+(e&&e.message?e.message:String(e))+")";
    }
  }else{
    heard="(model not loaded, level check only)";
  }
  var verdict;
  if(snapRms<0.003)verdict="levels VERY low: pick another input, or untick 'raw desk feed' so the browser boosts the mic";
  else if(snapRms<thr)verdict="levels low: untick 'raw desk feed' or raise the source volume";
  else if(!heard)verdict="levels good but nothing transcribed: speak closer to the mic, or reload the model";
  else verdict="levels good";
  App.transcript.push({text:"[input test] level "+snapRms.toFixed(4)+" (peak "+peak.toFixed(3)+") · "+verdict+(heard?" · heard: \u201C"+heard+"\u201D":""),refs:[],cue:null});
  renderTranscript();
  updateListenStatus(snapRms,thr,"tested");
  log("input-test",verdict+" · level "+snapRms.toFixed(4)+" · heard: "+heard);
  $("btnTestMic").disabled=false;
  if(!wasListening&&!App.listening)AudioCapture.stop();
}

function b64ToArrayBuffer(b64){
  var bin=atob(b64);
  var bytes=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  return bytes.buffer;
}

async function decodeFixture(b64){
  var ctx=new (window.AudioContext||window.webkitAudioContext)();
  try{
    var buf=await decodeAudioDataP(ctx,b64ToArrayBuffer(b64));
    return {data:buf.getChannelData(0),sr:buf.sampleRate};
  }finally{
    try{ctx.close();}catch(e){}
  }
}

async function selfTest(){
  if(STT.status!=="ready"){showError("Load the model first: Self test runs the real transcription.");return;}
  $("btnSelfTest").disabled=true;
  App.transcript.push({text:"[self test] decoding built-in voice fixture, transcribing locally…",refs:[],cue:null});
  renderTranscript();
  try{
    var pcm=await decodeFixture(FIXTURES.verse.b64);
    var f16=await AudioCapture.to16k(pcm.data,pcm.sr);
    var text=await STT.transcribe(f16);
    App.diagLast="self test · "+STT.lastMs+" ms · "+STT.device+" · heard "+(text?"\u201C"+text.slice(0,60)+"\u201D":"nothing");
    App.transcript.push({text:"[self test] heard \u201C"+(text||"(nothing)")+"\u201D in "+STT.lastMs+" ms · "+STT.device,refs:[],cue:null});
    renderTranscript();
    log("self-test","heard: "+text+" · "+STT.lastMs+" ms · "+STT.device);
    if(text){
      if(App.mode==="manual")setMode("copilot");
      runDetection(text);
    }else{
      showError("Self test heard nothing: the model is the problem, not your mic. Read me the Diagnostics lines.");
    }
  }catch(e){
    showError("Self test failed: "+(e&&e.message?e.message:String(e)));
    App.diagLast="self test error: "+(e&&e.message?e.message:String(e));
  }
  $("btnSelfTest").disabled=false;
}

async function refreshMics(){
  var devs=await listAudioInputs();
  var sel=$("micSel");
  var cur=sel.value;
  sel.innerHTML="";
  devs.forEach(function(d){
    var o=document.createElement("option");
    o.value=d.deviceId;
    o.textContent=d.label||("Input "+(sel.length+1));
    sel.appendChild(o);
  });
  var auto=null;
  for(var i=0;i<sel.options.length;i++){
    var t=sel.options[i].textContent.toLowerCase();
    if(t.indexOf("x-usb")>=0||t.indexOf("xr16")>=0||t.indexOf("xr18")>=0||t.indexOf("behringer")>=0||t.indexOf("usb audio")>=0){auto=sel.options[i].value;break;}
  }
  if(auto)sel.value=auto;
  else if(cur)sel.value=cur;
}

async function loadModel(){
  var id=$("modelSel").value;
  $("btnLoadModel").disabled=true;
  $("modelStatus").textContent="loading…";
  try{
    await STT.load(id,function(p){
      if(p&&p.status==="progress"&&p.total){
        $("modelStatus").textContent="downloading "+Math.round(p.loaded/1048576)+" / "+Math.round(p.total/1048576)+" MB";
      }else if(p&&p.status){
        $("modelStatus").textContent=p.status;
      }
    },$("useGpu").checked);
    $("modelStatus").textContent="ready · "+STT.device;
    $("btnListen").disabled=false;
    log("model",id+" · "+STT.device);
  }catch(e){
    $("modelStatus").textContent="load failed";
    showError("Model load failed (internet needed once). Scripted demo still works: press D.");
  }
  $("btnLoadModel").disabled=false;
}

function exportLog(){
  var blob=new Blob([JSON.stringify(App.sessionLog,null,2)],{type:"application/json"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="preso-session-"+new Date().toISOString().replace(/[:.]/g,"-")+".json";
  a.click();
}

function showSnippetHit(i){
  var r=App.lastSnippetHits&&App.lastSnippetHits[i];
  if(!r)return;
  var label=coreRefLabel(r);
  showVerseSlides(r,label);
  log("manual-verse",label+" (quote search)");
}

function init(){
  ["Manual","Copilot","Autopilot"].forEach(function(x){
    $("btnMode"+x).addEventListener("click",function(){setMode(x.toLowerCase());});
  });
  setMode("copilot");
  $("btnHold").addEventListener("click",function(){setHold(!App.hold);});
  $("btnPanic").addEventListener("click",panic);
  $("btnOutput").addEventListener("click",function(){if(ensureOutput())Output.send({cmd:"clear"});});
  $("btnDemo").addEventListener("click",startDemo);
  $("btnListen").addEventListener("click",toggleListen);
  $("btnListen").disabled=true;
  $("btnTestMic").addEventListener("click",testInput);
  $("btnSelfTest").addEventListener("click",selfTest);
  $("btnLoadModel").addEventListener("click",loadModel);
  $("btnRefreshMics").addEventListener("click",refreshMics);
  $("btnNext").addEventListener("click",nextSlide);
  $("btnPrev").addEventListener("click",prevSlide);
  $("btnBlack").addEventListener("click",doBlackout);
  $("btnLogo").addEventListener("click",doLogo);
  $("btnCountdown").addEventListener("click",doCountdown);
  $("btnAlert").addEventListener("click",doAlert);
  $("btnTyped").addEventListener("click",function(){
    var v=$("typedInput").value.trim();
    if(!v)return;
    commitLine(v);
    $("typedInput").value="";
  });
  $("typedInput").addEventListener("keydown",function(e){
    if(e.key==="Enter"){e.preventDefault();$("btnTyped").click();}
  });
  $("alertInput").addEventListener("keydown",function(e){
    if(e.key==="Enter"){e.preventDefault();doAlert();}
  });
  $("verseInput").addEventListener("input",function(){
    var v=$("verseInput").value.trim();
    var refs=coreParseRefs(v);
    if(refs.length){
      var r=refs[0];
      var label=coreRefLabel(r);
      var text=coreGetVerse(r);
      $("verseResult").innerHTML="<b>"+core.escapeHtml(label)+"</b><div class='sub'>"+core.escapeHtml(text.slice(0,120))+(text.length>120?"…":"")+"</div><span class='chip gold'>Enter to show</span>";
      $("verseResult").dataset.ready="1";
      $("verseResult").dataset.ref=JSON.stringify(r);
      return;
    }
    if(v.split(/\s+/).length>=2){
      var hits=core.searchSnippets(v,BOOKS,5);
      if(hits.length){
        App.lastSnippetHits=hits;
        var h="<span class='sub'>Quote matches (click or Enter for the first):</span>";
        hits.forEach(function(hit,i){
          var hl=coreRefLabel(hit);
          var ht=core.getVerse(BOOKS,hit);
          h+="<div class='snippetrow' onclick='showSnippetHit("+i+")'><b>"+core.escapeHtml(hl)+"</b> <span class='sub'>"+core.escapeHtml(ht.slice(0,90))+(ht.length>90?"…":"")+"</span></div>";
        });
        $("verseResult").innerHTML=h;
        $("verseResult").dataset.ready="1";
        $("verseResult").dataset.ref=JSON.stringify(hits[0]);
        return;
      }
    }
    $("verseResult").innerHTML="<span class='sub'>Type a reference (john 3 16) or a quote (“there is no god”)</span>";
    $("verseResult").dataset.ready="";
  });
  $("verseInput").addEventListener("keydown",function(e){
    if(e.key==="Enter"&&$("verseResult").dataset.ready==="1"){
      e.preventDefault();
      var r=JSON.parse($("verseResult").dataset.ref);
      var label=coreRefLabel(r);
      showVerseSlides(r,label);
      log("manual-verse",label);
    }
  });
  $("trackFile").addEventListener("change",function(e){
    var f=e.target.files[0];
    if(!f)return;
    var url=URL.createObjectURL(f);
    App.audioEl=new Audio(url);
    App.audioEl.preload="auto";
    $("trackName").textContent="Track: "+f.name;
    log("track-loaded",f.name);
  });
  App.snippetOn=$("snippetToggle").checked;
  $("snippetToggle").addEventListener("change",function(){
    App.snippetOn=$("snippetToggle").checked;
    log("quote-detection",App.snippetOn?"on":"off");
  });
  $("btnExport").addEventListener("click",exportLog);
  var ms=$("modelSel");
  STT.availableModels().forEach(function(m){
    var o=document.createElement("option");
    o.value=m.id;
    o.textContent=m.label;
    ms.appendChild(o);
  });
  refreshMics();
  var ua=navigator.userAgent||"";
  if(ua.indexOf("Chrome/")<0&&ua.indexOf("Edg/")<0){
    $("browserHint").style.display="flex";
  }
  renderSchedule();
  renderTranscript();
  renderCards();
  previewClear();
  document.addEventListener("pointerdown",function unlock(){
    try{
      var c=new (window.AudioContext||window.webkitAudioContext)();
      c.resume().then(function(){c.close();});
    }catch(e){}
  },{once:true});
  window.addEventListener("keydown",function(e){
    var tag=(e.target.tagName||"").toUpperCase();
    if(tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT")return;
    if(e.key===" "||e.key==="ArrowRight"){e.preventDefault();nextSlide();}
    else if(e.key==="ArrowLeft"){e.preventDefault();prevSlide();}
    else if(e.key==="Enter"){var c=topPendingCard();if(c)fireCard(c);}
    else if(e.key==="Backspace"){e.preventDefault();var c2=topPendingCard();if(c2)dismissCard(c2.id);}
    else if(e.key==="b"||e.key==="B"){doBlackout();}
    else if(e.key==="l"||e.key==="L"){doLogo();}
    else if(e.key==="h"||e.key==="H"){setHold(!App.hold);}
    else if(e.key==="a"||e.key==="A"){e.preventDefault();$("alertInput").focus();}
    else if(e.key==="v"||e.key==="V"){e.preventDefault();$("verseInput").focus();}
    else if(e.key==="d"||e.key==="D"){startDemo();}
    else if(e.key==="Escape"&&e.shiftKey){panic();}
  });
  setInterval(tick,200);
  log("session","started · alpha 0.1");
}

function renderDiag(){
  var ua=navigator.userAgent||"";
  var chrome=ua.indexOf("Chrome/")>=0||ua.indexOf("Edg/")>=0;
  var model=STT.status==="ready"?((STT.modelId||"").split("/").pop()+" · "+STT.device):STT.status;
  var mic=AudioCapture.running?("live · "+AudioCapture.ctxState()+" · "+(AudioCapture.processing?"boost":"raw")+" · "+(AudioCapture.mime||"").split(";")[0]):"off";
  var rows=[
    ["version","alpha "+ALPHA_VERSION,true],
    ["browser",chrome?"Chromium (ok)":"not Chrome/Edge",chrome],
    ["model",model,STT.status==="ready"],
    ["mic",mic,AudioCapture.running],
    ["last window",App.diagLast||"—",!!App.diagLast&&App.diagLast.indexOf("error")!==0],
    ["output window",Output.isOpen()?"open":"closed",Output.isOpen()]
  ];
  var h="";
  rows.forEach(function(r){
    h+="<div class='diagrow'><span class='dot "+(r[2]?"ok":"warn")+"'></span><span class='dl'>"+r[0]+"</span><span class='dv'>"+core.escapeHtml(r[1])+"</span></div>";
  });
  $("diag").innerHTML=h;
}

function tick(){
  var now=Date.now();
  var changed=false;
  if(!App.hold){
    App.cards.slice().forEach(function(c){
      if(c.status==="pending"&&c.fireAt&&now>=c.fireAt){fireCard(c);changed=true;}
      else if(c.status==="pending"&&c.expiresAt&&now>=c.expiresAt){
        App.cards=App.cards.filter(function(x){return x.id!==c.id;});
        log("cue-expired",c.label+" (no approval)");
        changed=true;
      }
    });
  }
  renderCards();
  if(AudioCapture.running){
    var lvl=Math.min(100,Math.round(AudioCapture.level*900));
    $("levelBar").style.width=lvl+"%";
    $("micLevel").style.display="flex";
  }else{$("micLevel").style.display="none";}
  if(STT.lastMs)$("sttMs").textContent=STT.lastMs+" ms transcribe";
  renderDiag();
}

document.addEventListener("DOMContentLoaded",init);
window.addEventListener("beforeunload",function(){
  stopSong();
  AudioCapture.stop();
});
