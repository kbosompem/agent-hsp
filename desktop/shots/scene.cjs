// usage: node hsp-scene.js <scene> <out.png>
const { chromium } = require('playwright');
const fs = require('fs');
const [scene, out] = process.argv.slice(2);
const lib = JSON.parse(fs.readFileSync(__dirname + '/library.json', 'utf8'));
(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((l) => {
    window.__hspLibrary = l;
    localStorage.setItem("preso-output-theme", JSON.stringify({
      bgKind: "image", gradient: "", overlay: 0.5, textColor: "#f3ecdc", accent: "#e9c465", font: "serif", textScale: 1,
      churchName: "Grace Chapel", bgId: "pexels-photo-18797654",
      image: "https://images.pexels.com/photos/18797654/pexels-photo-18797654.jpeg?auto=compress&cs=tinysrgb&w=1920&h=1080&fit=crop",
    }));
  }, lib);
  const p = await ctx.newPage();
  const logs = [];
  p.on('console', m => /error|unhandled/i.test(m.type() + m.text()) && logs.push(m.type() + ': ' + m.text()));
  p.on('pageerror', e => logs.push('PAGEERROR ' + e));
  await p.goto('http://localhost:5180/shots/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  const emit = (e, x) => p.evaluate(([e, x]) => window.__hsp.emit(e, x), [e, x]);
  const healthy = async () => { await emit('stt-alive', null); await emit('stt-health', { lag_s: 0.3, ms: 850, error: null }); await emit('level', 0.08); };
  if (scene === 'live') {
    await p.click('button:has-text("Listen")');
    await emit('listen-status', 'listening');
    const lines = [
      'Good morning church. The title of my message is Amazing Love.',
      'Point number one. God loved us first.',
      'Turn with me to John 3 16.',
      'For God so loved the world that he gave his only begotten Son.',
      'Point number two. He loved us while we were sinners. Look at Romans 5 verse 8.',
    ];
    let seg = 1;
    for (const t of lines) { await healthy(); await emit('transcript', { text: t, ms: 850, seg: seg++ }); await p.waitForTimeout(1500); }
    await healthy(); await p.waitForTimeout(400); await healthy();
  } else if (scene === "song") {
    await p.click('button:has-text("Service")');
    await p.waitForTimeout(800);
    const item = p.locator("text=Blessed Assurance").first();
    await item.dblclick();
    await p.waitForTimeout(800);
    await p.keyboard.press("ArrowRight");
    await p.waitForTimeout(1200);
  } else {
    await p.click(`button:has-text("${scene}")`);
    await p.waitForTimeout(1500);
  }
  await p.screenshot({ path: out });
  console.log((await p.innerText('body')).slice(0, 1500));
  console.log(logs.join('\n'));
  await b.close();
})();
