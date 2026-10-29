const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://localhost:5180/shots/output.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const theme = { bgKind: 'image', gradient: '', overlay: 0.5, textColor: '#f3ecdc', accent: '#e9c465', font: 'serif', textScale: 1, churchName: 'Grace Chapel',
    image: 'https://images.pexels.com/photos/18797654/pexels-photo-18797654.jpeg?auto=compress&cs=tinysrgb&w=1920&h=1080&fit=crop' };
  await p.evaluate(async ([t]) => {
    await window.__hsp.emit('output-theme', t);
    const h = window.__hsp.hit(42, 3, 16);
    await window.__hsp.emit('slide', { kind: 'verse', title: h.label, body: h.text, sub: 'KJV' });
  }, [theme]);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: process.argv[2] || 'projector.png' });
  console.log('errors', errs);
  await b.close();
})();
