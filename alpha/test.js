var KJV_DATA=require("./js/kjv.js");
global.KJV_DATA=KJV_DATA;
var core=require("./js/core.js");
var books=KJV_DATA.books;
var pass=0,fail=0;

function check(label,actual,expected){
  var a=JSON.stringify(actual),e=JSON.stringify(expected);
  if(a===e){pass++;console.log("PASS "+label);}
  else{fail++;console.log("FAIL "+label+"\n  expected: "+e+"\n  actual:   "+a);}
}

function refs(text){
  return core.parseRefs(text,books).map(function(r){return core.refLabel(books,r);});
}

check("john 3:16 digits",refs("Turn with me to John 3:16"),["John 3:16"]);
check("john chapter three verse sixteen",refs("in John chapter three verse sixteen we see"),["John 3:16"]);
check("third chapter of john",refs("as we read in the third chapter of John, verse sixteen"),["John 3:16"]);
check("romans five verse eight",refs("Paul writes in Romans five verse eight"),["Romans 5:8"]);
check("first corinthians thirteen four",refs("First Corinthians thirteen four tells us"),["1 Corinthians 13:4"]);
check("psalms twenty three chapter",refs("Turn to Psalms twenty three"),["Psalm 23"]);
check("revelation twenty one four",refs("Revelation twenty one four says"),["Revelation 21:4"]);
check("genesis one one",refs("look at Genesis one one"),["Genesis 1:1"]);
check("second timothy spoken",refs("in Second Timothy chapter one verse seven"),["2 Timothy 1:7"]);
check("jn abbreviation",refs("jn 3:16"),["John 3:16"]);
check("psalm 91 range",refs("Psalms ninety one verses one to five"),["Psalm 91:1-5"]);
check("range with to",refs("john 3 verse 1 to 5"),["John 3:1-5"]);
check("range homophone two",refs("john 3 verse 1 two 5"),["John 3:1-5"]);
check("range bare numbers",refs("psalm 91 1-2"),["Psalm 91:1-2"]);
check("book of james chapter",refs("the book of James chapter one"),["James 1"]);
check("jude verse only",refs("Jude verse three says"),["Jude 3"]);
check("john and verse form",refs("John chapter three and verse sixteen"),["John 3:16"]);
check("two refs one sentence",refs("compare John 3:16 with Romans 5:8"),["John 3:16","Romans 5:8"]);
check("no ref sixteen people",refs("we had about sixteen people and three cars"),[]);
check("no ref john the baptist",refs("John the Baptist was preaching"),[]);
check("no ref generic praise",refs("let us thank the Lord everybody"),[]);
check("number word",core.wordToNumber("sixteenth"),16);
check("ordinal compound",core.parseNumSeq(["twenty","third"],0),{value:23,len:2});
check("hundred nineteen",core.parseNumSeq(["one","hundred","nineteen"],0),{value:119,len:3});
check("hundred twenty three",core.parseNumSeq(["one","hundred","twenty","three"],0),{value:123,len:4});

var verse=core.getVerse(books,core.parseRefs("John 3:16",books)[0]);
check("john 3:16 text",verse.indexOf("For God so loved the world"),0);
var ps=core.getVerse(books,core.parseRefs("Psalms twenty three",books)[0]);
check("psalm 23:1 text",ps.indexOf("The LORD is my shepherd"),0);

var CUES=[
  {id:"praise",phrase:"it is time for praise and worship",threshold:0.65},
  {id:"praise2",phrase:"let us enter into praise and worship",threshold:0.65},
  {id:"team",phrase:"worship team come up",threshold:0.65}
];
var m1=core.matchCue("and now church I believe it is time for praise and worship",CUES);
check("cue exact",m1&&m1.cue.id==="praise"&&m1.score===1,true);
var m2=core.matchCue("praise the Lord everybody",CUES);
check("cue no false fire",m2===null,true);
var m3=core.matchCue("could the worship team come up to the stage please",CUES);
check("cue team",m3&&m3.cue.id==="team",true);

check("philippians range spoken",refs("Turn to Philippians chapter one, verses one through four"),["Philippians 1:1-4"]);
check("genesis 2 2",refs("genesis 2 2"),["Genesis 2:2"]);
var snips=core.searchSnippets("there is no god",books,5).map(function(h){return core.refLabel(books,h);});
check("snippet there is no god",snips[0]==="Psalm 14:1"&&snips[1]==="Psalm 53:1",true);
check("snippet shepherd",core.refLabel(books,core.searchSnippets("the lord is my shepherd",books,1)[0]),"Psalm 23:1");
var loveHit=core.refLabel(books,core.searchSnippets("god is love",books,1)[0]);
check("snippet god is love",loveHit==="1 John 4:8"||loveHit==="1 John 4:16",true);
check("snippet in his heart",core.refLabel(books,core.searchSnippets("the fool hath said in his heart",books,1)[0]),"Psalm 14:1");

console.log("\n"+pass+" passed, "+fail+" failed");
process.exit(fail?1:0);
