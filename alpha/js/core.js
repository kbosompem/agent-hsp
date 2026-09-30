var BOOK_ALIASES=[
["genesis","gen","ge"],
["exodus","exo","ex"],
["leviticus","lev","lv"],
["numbers","num","nm"],
["deuteronomy","deut","dt"],
["joshua","josh","jos"],
["judges","judg"],
["ruth","rth"],
["1 samuel","first samuel","one samuel","1sam","i samuel","1sa","1 sm"],
["2 samuel","second samuel","two samuel","2sam","ii samuel","2sa","2 sm"],
["1 kings","first kings","one kings","1kings","i kings","1 kgs","1kg"],
["2 kings","second kings","two kings","2kings","ii kings","2 kgs","2kg"],
["1 chronicles","first chronicles","one chronicles","1chron","i chronicles","1 chron","1chr"],
["2 chronicles","second chronicles","two chronicles","2chron","ii chronicles","2 chron","2chr"],
["ezra","ezr"],
["nehemiah","neh"],
["esther","esth","est"],
["job"],
["psalms","psalm","ps","psa"],
["proverbs","prov","prv"],
["ecclesiastes","eccl","eccles","ec"],
["song of solomon","song of songs","songs","sos","canticles","song"],
["isaiah","isa"],
["jeremiah","jer"],
["lamentations","lam"],
["ezekiel","ezek","eze"],
["daniel","dan"],
["hosea","hos"],
["joel"],
["amos"],
["obadiah","obad","ob"],
["jonah","jon"],
["micah","mic"],
["nahum","nah"],
["habakkuk","hab"],
["zephaniah","zeph"],
["haggai","hag"],
["zechariah","zech","zec"],
["malachi","mal"],
["matthew","matt","mat","mt"],
["mark","mrk","mk"],
["luke","luk","lk"],
["john","jn","joh"],
["acts","act"],
["romans","rom","roms","rm"],
["1 corinthians","first corinthians","one corinthians","1cor","i corinthians","1 cor"],
["2 corinthians","second corinthians","two corinthians","2cor","ii corinthians","2 cor"],
["galatians","gal"],
["ephesians","eph"],
["philippians","phil","php"],
["colossians","col"],
["1 thessalonians","first thessalonians","one thessalonians","1thess","i thessalonians","1 thess"],
["2 thessalonians","second thessalonians","two thessalonians","2thess","ii thessalonians","2 thess"],
["1 timothy","first timothy","one timothy","1tim","i timothy","1 tim"],
["2 timothy","second timothy","two timothy","2tim","ii timothy","2 tim"],
["titus","tit"],
["philemon","philem","phlm"],
["hebrews","heb"],
["james","jas","jm"],
["1 peter","first peter","one peter","1pet","i peter","1 pet","1 pt"],
["2 peter","second peter","two peter","2pet","ii peter","2 pet","2 pt"],
["1 john","first john","one john","1john","i john","1 jn"],
["2 john","second john","two john","2john","ii john"],
["3 john","third john","three john","3john","iii john"],
["jude","jud"],
["revelation","rev","revelations"]
];

var ONES={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9};
var TEENS={ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19};
var TENS={twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
var SPECIAL_ORD={first:1,second:2,third:3,fourth:4,fifth:5,sixth:6,seventh:7,eighth:8,ninth:9,twelfth:12};
var VERSE_WORDS=["verse","verses","vs","v"];
var CHAPTER_WORDS=["chapter","chapters","chap","ch"];
var RANGE_WORDS=["to","two","too","thru","through","until","till","and"];

function wordToNumber(w){
  if(!w)return null;
  if(/^\d+$/.test(w))return parseInt(w,10);
  var m=w.match(/^(\d+)(st|nd|rd|th)$/);
  if(m)return parseInt(m[1],10);
  if(SPECIAL_ORD[w])return SPECIAL_ORD[w];
  if(ONES[w])return ONES[w];
  if(TEENS[w])return TEENS[w];
  if(TENS[w])return TENS[w];
  if(w==="hundred"||w==="hundreds")return 100;
  if(/ieth$/.test(w)){var t=w.replace(/ieth$/,"y");if(TENS[t])return TENS[t];}
  if(/th$/.test(w)){var b=w.slice(0,-2);if(TEENS[b])return TEENS[b];if(ONES[b])return ONES[b];if(TENS[b])return TENS[b];}
  return null;
}

function parseNumSeq(tokens,i){
  var cur=0,len=0,hadHundred=false;
  while(len<4&&i+len<tokens.length){
    var w=tokens[i+len];
    if(w==="and"){
      if(len===0)break;
      var nx=tokens[i+len+1];
      if(nx&&wordToNumber(nx)!==null){len++;continue;}
      break;
    }
    var n=wordToNumber(w);
    if(n===null)break;
    if(n===100){cur=(cur||1)*100;hadHundred=true;}
    else if(cur===0){cur=n;}
    else if(cur%10===0&&n<10){cur+=n;}
    else if(cur%100===0){cur+=n;}
    else break;
    len++;
    if(cur>999)break;
  }
  if(len===0||cur===0)return null;
  return {value:cur,len:len};
}

var BOOK_INDEX=null;

function buildBookIndex(books){
  var list=[];
  for(var b=0;b<books.length;b++){
    var names=(BOOK_ALIASES[b]||[]).slice();
    var full=books[b].n.toLowerCase();
    if(names.indexOf(full)<0)names.unshift(full);
    for(var k=0;k<names.length;k++)list.push({tokens:names[k].split(" "),book:b});
  }
  list.sort(function(a,b){return b.tokens.length-a.tokens.length;});
  return list;
}

function matchBook(tokens,i,idx){
  for(var e=0;e<idx.length;e++){
    var entry=idx[e];
    var L=entry.tokens.length;
    if(i+L>tokens.length)continue;
    var ok=true;
    for(var t=0;t<L;t++){if(tokens[i+t]!==entry.tokens[t]){ok=false;break;}}
    if(ok)return {book:entry.book,len:L};
  }
  return null;
}

function parseRefAfterBook(tokens,j){
  var k=j;
  if(CHAPTER_WORDS.indexOf(tokens[k])>=0)k++;
  var ch=parseNumSeq(tokens,k);
  if(!ch)return null;
  k+=ch.len;
  if(tokens[k]==="and"&&VERSE_WORDS.indexOf(tokens[k+1])>=0)k++;
  var verse=null,endV=null;
  if(VERSE_WORDS.indexOf(tokens[k])>=0){
    var vs=parseNumSeq(tokens,k+1);
    if(vs){verse=vs.value;k+=1+vs.len;}
  }else{
    var vs2=parseNumSeq(tokens,k);
    if(vs2){verse=vs2.value;k+=vs2.len;}
  }
  if(verse!==null){
    var lk=k;
    if(RANGE_WORDS.indexOf(tokens[lk])>=0&&VERSE_WORDS.indexOf(tokens[lk+1])>=0){lk+=1;}
    if(RANGE_WORDS.indexOf(tokens[lk])>=0&&VERSE_WORDS.indexOf(tokens[lk+1])<0){
      var ev=parseNumSeq(tokens,lk+1);
      if(ev&&ev.value>verse){endV=ev.value;k=lk+1+ev.len;}
    } else {
      var ev2=parseNumSeq(tokens,k);
      if(ev2&&ev2.value>verse){endV=ev2.value;k+=ev2.len;}
    }
  }
  return {chapter:ch.value,verse:verse,endVerse:endV,end:k};
}

function normalizeText(text){
  return String(text||"").toLowerCase().replace(/[\u2018\u2019\u02BC`]/g,"").replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}

function validRef(books,book,ch,v,endV){
  if(book<0||book>=books.length)return null;
  var chapters=books[book].c;
  if(ch<1||ch>chapters.length)return null;
  var vc=chapters[ch-1].length;
  if(v!==null&&v!==undefined){
    if(v<1||v>vc)return null;
    if(endV!==null&&endV!==undefined){if(endV<=v||endV>vc)endV=null;}
  }
  return {book:book,chapter:ch,verse:v===undefined?null:v,endVerse:endV===undefined?null:endV};
}

function parseRefs(text,books){
  books=books||(typeof KJV_DATA!=="undefined"?KJV_DATA.books:null);
  if(!books||!text)return [];
  var norm=normalizeText(text);
  if(!norm)return [];
  var tokens=norm.split(" ");
  if(!BOOK_INDEX)BOOK_INDEX=buildBookIndex(books);
  var idx=BOOK_INDEX;
  var refs=[];
  var seen={};
  function push(r,pos){
    if(!r)return;
    var key=r.book+":"+r.chapter+":"+r.verse+":"+r.endVerse;
    if(seen[key])return;
    seen[key]=1;
    r.pos=pos;
    refs.push(r);
  }
  var i=0;
  while(i<tokens.length){
    var m=matchBook(tokens,i,idx);
    if(m){
      var p=parseRefAfterBook(tokens,i+m.len);
      if(p){
        push(validRef(books,m.book,p.chapter,p.verse,p.endVerse),i);
        i=Math.max(p.end,i+m.len);
        continue;
      }
      if(books[m.book].c.length===1){
        var k2=i+m.len,vv=null,used=0;
        if(VERSE_WORDS.indexOf(tokens[k2])>=0){
          var q=parseNumSeq(tokens,k2+1);
          if(q){vv=q.value;used=1+q.len;}
        }else{
          var q2=parseNumSeq(tokens,k2);
          if(q2){vv=q2.value;used=q2.len;}
        }
        if(vv!==null){
          push(validRef(books,m.book,1,vv,null),i);
          i=k2+used;
          continue;
        }
      }
      i+=m.len;
      continue;
    }
    if(tokens[i]==="book"&&tokens[i+1]==="of"){
      var m2=matchBook(tokens,i+2,idx);
      if(m2){
        var p2=parseRefAfterBook(tokens,i+2+m2.len);
        if(p2){
          push(validRef(books,m2.book,p2.chapter,p2.verse,p2.endVerse),i);
          i=Math.max(p2.end,i+2+m2.len);
          continue;
        }
      }
    }
    i++;
  }
  for(var c=0;c<tokens.length;c++){
    if(tokens[c]!=="chapter"&&tokens[c]!=="chapters")continue;
    var chapNum=null,bookAt=null;
    var back=wordToNumber(tokens[c-1]);
    if(back!==null){chapNum=back;bookAt=c+1;}
    else{
      var fwd=parseNumSeq(tokens,c+1);
      if(fwd&&tokens[c+1+fwd.len]==="of"){chapNum=fwd.value;bookAt=c+2+fwd.len;}
      else continue;
    }
    if(tokens[bookAt]==="of")bookAt++;
    var mb=matchBook(tokens,bookAt,idx);
    if(!mb)continue;
    var after=bookAt+mb.len;
    var vv2=null,ee2=null;
    if(VERSE_WORDS.indexOf(tokens[after])>=0){
      var q3=parseNumSeq(tokens,after+1);
      if(q3)vv2=q3.value;
    }else{
      var q4=parseNumSeq(tokens,after);
      if(q4)vv2=q4.value;
    }
    push(validRef(books,mb.book,chapNum,vv2,ee2),Math.max(0,c-2));
  }
  refs.sort(function(a,b){return a.pos-b.pos;});
  return refs;
}

function refLabel(books,r){
  var name=books[r.book].n;
  if(name==="Psalms")name="Psalm";
  if(books[r.book].c.length===1){
    if(r.verse===null||r.verse===undefined)return name;
    var s1=name+" "+r.verse;
    if(r.endVerse)s1+="-"+r.endVerse;
    return s1;
  }
  if(r.verse===null||r.verse===undefined)return name+" "+r.chapter;
  var s=name+" "+r.chapter+":"+r.verse;
  if(r.endVerse)s+="-"+r.endVerse;
  return s;
}

function getVerse(books,r){
  var ch=books[r.book].c[r.chapter-1];
  if(r.verse===null||r.verse===undefined)return ch[0];
  var end=r.endVerse||r.verse;
  var parts=[];
  for(var v=r.verse;v<=Math.min(end,ch.length);v++)parts.push(ch[v-1]);
  return parts.join(" ");
}

function normalizeCue(text){
  return normalizeText(text).replace(/\s+/g," ");
}

function matchCue(text,cues){
  var t=normalizeCue(text);
  if(!t)return null;
  var tTokens=t.split(" ");
  var best=null;
  for(var i=0;i<cues.length;i++){
    var c=normalizeCue(cues[i].phrase);
    var score=0;
    if(c&&t.indexOf(c)>=0){score=1;}
    else if(c){
      var cTokens=c.split(" ");
      var windowTokens=tTokens.slice(Math.max(0,tTokens.length-Math.max(15,cTokens.length*2)));
      var setA={},setB={};
      cTokens.forEach(function(w){setA[w]=1;});
      windowTokens.forEach(function(w){setB[w]=1;});
      var inter=0,union=0;
      Object.keys(setA).forEach(function(w){if(setB[w])inter++;union++;});
      Object.keys(setB).forEach(function(w){if(!setA[w])union++;});
      if(union>0)score=inter/union;
    }
    if(score>=(cues[i].threshold||0.65)&&(!best||score>best.score)){
      best={cue:cues[i],score:score};
    }
  }
  return best;
}

var SNIPPET_INDEX=null;

function normalizeBounded(text){
  return String(text||"").toLowerCase()
    .replace(/[\u2018\u2019\u02BC`]/g,"")
    .replace(/[.,;:!?]/g," | ")
    .replace(/[^a-z0-9| ]/g," ")
    .replace(/\s+/g," ")
    .trim();
}

function boundedScore(nb,q){
  var idx=nb.indexOf(q);
  var best=0;
  while(idx>=0){
    var after=idx+q.length;
    var startOk=idx===0||(nb.charAt(idx-1)===" "&&nb.charAt(idx-2)==="|");
    var endOk=after>=nb.length||(nb.charAt(after)===" "&&nb.charAt(after+1)==="|");
    if(startOk&&endOk)return 3;
    if(startOk||endOk)best=2.5;
    idx=nb.indexOf(q,idx+1);
  }
  return best;
}

function getSnippetIndex(books){
  if(SNIPPET_INDEX)return SNIPPET_INDEX;
  var arr=[];
  for(var b=0;b<books.length;b++){
    var chapters=books[b].c;
    for(var c=0;c<chapters.length;c++){
      var vs=chapters[c];
      for(var v=0;v<vs.length;v++){
        arr.push({b:b,c:c+1,v:v+1,n:normalizeText(vs[v]),nb:normalizeBounded(vs[v])});
      }
    }
  }
  SNIPPET_INDEX=arr;
  return arr;
}

function searchSnippets(query,books,limit){
  books=books||(typeof KJV_DATA!=="undefined"?KJV_DATA.books:null);
  if(!books||!query)return [];
  var q=normalizeText(query);
  if(!q)return [];
  var qTokens=q.split(" ");
  var idx=getSnippetIndex(books);
  var out=[];
  for(var i=0;i<idx.length;i++){
    var verse=idx[i];
    var score=0;
    if(verse.n.indexOf(q)>=0){
      score=boundedScore(verse.nb,q)||2;
    }else if(qTokens.length>=3){
      var all=true;
      for(var t=0;t<qTokens.length;t++){
        if(verse.n.indexOf(qTokens[t])<0){all=false;break;}
      }
      if(all)score=1;
    }
    if(score>0)out.push({book:verse.b,chapter:verse.c,verse:verse.v,score:score});
  }
  out.sort(function(a,b){return b.score-a.score;});
  return out.slice(0,limit||5);
}

function escapeHtml(s){
  return String(s===null||s===undefined?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

var core={
  parseRefs:parseRefs,
  refLabel:refLabel,
  getVerse:getVerse,
  matchCue:matchCue,
  searchSnippets:searchSnippets,
  normalizeText:normalizeText,
  normalizeCue:normalizeCue,
  wordToNumber:wordToNumber,
  parseNumSeq:parseNumSeq,
  matchBook:matchBook,
  buildBookIndex:buildBookIndex,
  escapeHtml:escapeHtml
};

if(typeof module!=="undefined")module.exports=core;
