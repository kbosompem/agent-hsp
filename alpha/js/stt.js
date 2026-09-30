function withTimeout(p,ms,label){
  return Promise.race([
    p,
    new Promise(function(_,rej){
      setTimeout(function(){rej(new Error(label+" timed out after "+Math.round(ms/1000)+" s"));},ms);
    })
  ]);
}

var STT={
  asr:null,
  device:"none",
  modelId:null,
  status:"idle",
  lastMs:0,

  availableModels:function(){
    return [
      {id:"onnx-community/whisper-tiny.en",label:"Whisper tiny.en (40 MB, fast)"},
      {id:"onnx-community/whisper-base.en",label:"Whisper base.en (80 MB, better)"}
    ];
  },

  async load(modelId,onProgress,useWebgpu){
    this.status="loading";
    this.modelId=modelId;
    this.asr=null;
    this.device="none";
    var mod=await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3");
    var pipeline=mod.pipeline;
    mod.env.allowLocalModels=false;
    var attempts=(useWebgpu?[
      {device:"webgpu",dtype:"q8"},
      {device:"wasm",dtype:"q8"},
      {device:"wasm",dtype:"fp32"}
    ]:[
      {device:"wasm",dtype:"q8"},
      {device:"wasm",dtype:"fp32"}
    ]);
    var lastErr=null;
    for(var i=0;i<attempts.length;i++){
      var a=attempts[i];
      try{
        if(onProgress)onProgress({status:"init "+a.device+"/"+a.dtype});
        this.asr=await withTimeout(
          pipeline("automatic-speech-recognition",modelId,{device:a.device,dtype:a.dtype,progress_callback:onProgress}),
          180000,
          "model load ("+a.device+"/"+a.dtype+")"
        );
        this.device=a.device+"/"+a.dtype;
        this.status="ready";
        return;
      }catch(e){
        lastErr=e;
        this.asr=null;
      }
    }
    this.status="error";
    throw lastErr;
  },

  async transcribe(f32){
    if(!this.asr)throw new Error("model not loaded");
    var t0=performance.now();
    var out=await withTimeout(
      this.asr(f32,{chunk_length_s:30,stride_length_s:5}),
      60000,
      "transcription"
    );
    this.lastMs=Math.round(performance.now()-t0);
    var text=(out&&out.text?out.text:"").trim();
    var junk={"thank you.":1,"thanks for watching!":1,"you":1,"bye.":1,"thank you":1,"":1};
    if(junk[text.toLowerCase()])return "";
    return text;
  }
};
