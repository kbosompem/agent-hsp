function rmsOf(buf){
  if(!buf||!buf.length)return 0;
  var s=0;
  for(var i=0;i<buf.length;i++)s+=buf[i]*buf[i];
  return Math.sqrt(s/buf.length);
}

function linearResample(data,srIn,srOut){
  var ratio=srOut/srIn;
  var n=Math.max(1,Math.floor(data.length*ratio));
  var out=new Float32Array(n);
  for(var i=0;i<n;i++){
    var x=i/ratio;
    var i0=Math.floor(x);
    var i1=Math.min(i0+1,data.length-1);
    var f=x-i0;
    out[i]=data[i0]*(1-f)+data[i1]*f;
  }
  return out;
}

function decodeAudioDataP(ctx,arrayBuffer){
  return new Promise(function(resolve,reject){
    var p=null;
    try{p=ctx.decodeAudioData(arrayBuffer,resolve,reject);}
    catch(e){reject(e);return;}
    if(p&&p.then)p.then(resolve).catch(reject);
  });
}

var AudioCapture={
  stream:null,rec:null,chunks:[],mime:"",genStart:0,running:false,
  ctx:null,sr:48000,noise:0.002,threshold:0.006,peak:0,level:0,processing:true,

  pickMime(){
    if(typeof MediaRecorder==="undefined")return null;
    var opts=["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/ogg;codecs=opus"];
    for(var i=0;i<opts.length;i++){
      try{if(MediaRecorder.isTypeSupported(opts[i]))return opts[i];}catch(e){}
    }
    return "";
  },

  async start(deviceId,processing){
    this.processing=!!processing;
    var constraints={audio:{echoCancellation:this.processing,noiseSuppression:this.processing,autoGainControl:this.processing,channelCount:1}};
    if(deviceId)constraints.audio.deviceId={exact:deviceId};
    this.stream=await navigator.mediaDevices.getUserMedia(constraints);
    this.mime=this.pickMime();
    if(this.mime===null)throw new Error("This browser cannot record audio. Use Chrome or Edge.");
    this.ctx=new (window.AudioContext||window.webkitAudioContext)();
    if(this.ctx.state==="suspended"){try{await this.ctx.resume();}catch(e){}}
    this.sr=this.ctx.sampleRate;
    this.chunks=[];
    this.noise=0.002;this.threshold=0.006;this.peak=0;this.level=0;
    this.startRecorder();
    this.genStart=Date.now();
    this.running=true;
  },

  startRecorder(){
    var self=this;
    this.rec=new MediaRecorder(this.stream,this.mime?{mimeType:this.mime}:undefined);
    this.rec.ondataavailable=function(e){
      if(e.data&&e.data.size)self.chunks.push(e.data);
    };
    this.rec.start(1000);
  },

  async restartRecorder(){
    var old=this.rec;
    this.chunks=[];
    this.genStart=Date.now();
    this.startRecorder();
    try{if(old){old.ondataavailable=null;old.stop();}}catch(e){}
  },

  updateLevels(rms){
    this.level=rms;
    if(rms>this.peak)this.peak=rms;
    if(rms<this.noise)this.noise=rms;
    else this.noise=this.noise*0.9995+rms*0.0005;
    this.threshold=Math.max(0.0035,this.noise*3);
  },

  async getRecentPCM(seconds){
    if(!this.running)return {data:new Float32Array(0),sr:this.sr};
    if(Date.now()-this.genStart>45000)await this.restartRecorder();
    if(!this.chunks.length)return {data:new Float32Array(0),sr:this.sr};
    var blob=new Blob(this.chunks,{type:this.mime||"audio/webm"});
    var buf;
    try{
      buf=await decodeAudioDataP(this.ctx,await blob.arrayBuffer());
    }catch(e){
      return {data:new Float32Array(0),sr:this.sr};
    }
    var data=buf.getChannelData(0);
    var sr=buf.sampleRate;
    var n=Math.min(data.length,Math.floor(seconds*sr));
    return {data:data.slice(data.length-n),sr:sr};
  },

  async to16k(data,srIn){
    if(!data.length)return data;
    if(srIn===16000)return data;
    try{
      var outLen=Math.max(1,Math.floor(data.length*16000/srIn));
      var off=new OfflineAudioContext(1,outLen,16000);
      var buf=off.createBuffer(1,data.length,srIn);
      buf.getChannelData(0).set(data);
      var src=off.createBufferSource();
      src.buffer=buf;
      src.connect(off.destination);
      src.start();
      var rendered=await off.startRendering();
      var out=rendered.getChannelData(0);
      if(out.length===outLen)return out;
      throw new Error("short render");
    }catch(e){
      return linearResample(data,srIn,16000);
    }
  },

  ctxState(){
    return this.ctx?this.ctx.state:"closed";
  },

  stop(){
    this.running=false;
    try{if(this.rec){this.rec.ondataavailable=null;this.rec.stop();}}catch(e){}
    try{if(this.stream)this.stream.getTracks().forEach(function(t){t.stop();});}catch(e){}
    try{if(this.ctx)this.ctx.close();}catch(e){}
    this.rec=null;this.stream=null;this.ctx=null;this.chunks=[];
  }
};

async function listAudioInputs(){
  try{
    var devs=await navigator.mediaDevices.enumerateDevices();
    return devs.filter(function(d){return d.kind==="audioinput";});
  }catch(e){return [];}
}
