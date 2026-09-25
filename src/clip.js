'use strict';
/**
 * agentbox — clip.js
 * Export a time range of a session as ONE self-contained HTML file —
 * a playable "clip" you can drop into a PR, an issue, or a group chat.
 * No server, no assets, no JS framework. Works offline forever.
 */
const fs = require('fs');
const path = require('path');
const { verifyChain } = require('./chain');

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clip(file, opts = {}) {
  const res = verifyChain(file);
  if (!res.ok && !opts.force) {
    process.stderr.write(`\x1b[31m⬢ agentbox: chain verification FAILED — ${res.reason}\x1b[0m\n`);
    process.exitCode = 1;
    return null;
  }
  const events = res.events;
  const meta = events.find((e) => e.type === 'meta') || { data: {} };
  const t0 = events[0].t;
  const tN = events[events.length - 1].t;
  const from = opts.from != null ? t0 + opts.from * 1000 : t0;
  const to = opts.to != null ? t0 + opts.to * 1000 : tN;

  const slim = [];
  for (const ev of events) {
    if (ev.t < from || ev.t > to) continue;
    const d = ev.data || {};
    let kind = ev.type;
    let text = '';
    if (ev.type === 'out') { kind = d.stream === 'stderr' ? 'stderr' : (d.kind || 'out'); text = d.text != null ? d.text : String(d.detail || ''); }
    else if (ev.type === 'in') { kind = 'in'; text = d.text || ''; }
    else if (ev.type === 'exit') { kind = 'exit'; text = `exit code ${d.code}`; }
    else if (ev.type === 'meta') { kind = 'meta'; text = d.cmd || ''; }
    else if (ev.type === 'signal') { kind = 'signal'; text = d.signal || ''; }
    slim.push({ rt: ev.t - t0, k: kind, x: String(text).slice(0, 2000) });
  }

  const outPath = opts.out || file.replace(/\.jsonl$/, '') + '.clip.html';
  const payload = esc(JSON.stringify(slim));

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⬢ agentbox clip — ${esc(meta.data.name || 'session')}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0a0e14; color:#c9d1d9; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 24px 16px 60px; }
  h1 { font-size: 16px; color:#5eead4; margin: 0 0 4px; }
  .sub { color:#56606c; font-size:12px; margin-bottom:16px; }
  .term { border:1px solid #1c2530; border-radius:10px; background:#0d1117; overflow:hidden; }
  .bar { display:flex; gap:6px; align-items:center; padding:8px 12px; background:#11161d; border-bottom:1px solid #1c2530; }
  .dot { width:10px; height:10px; border-radius:50%; }
  .r{background:#ff5f56}.y{background:#ffbd2e}.g{background:#27c93f}
  .bar .t { margin-left:8px; color:#56606c; font-size:12px; }
  #feed { height: 420px; overflow-y:auto; padding:12px 14px; }
  .ln { white-space:pre-wrap; word-break:break-word; padding:1px 0; }
  .ts { color:#3b4654; margin-right:10px; }
  .tag { display:inline-block; width:52px; font-weight:700; margin-right:8px; }
  .k-tool{color:#fb923c}.k-cmd{color:#4ade80}.k-file{color:#e879f9}.k-net{color:#22d3ee}
  .k-in{color:#67e8f9}.k-stderr{color:#f87171}.k-signal{color:#f87171;font-weight:700}
  .k-exit{color:#fff;font-weight:700}.k-meta{color:#56606c}.k-out{color:#c9d1d9}
  .ctl { display:flex; gap:10px; align-items:center; padding:10px 12px; border-top:1px solid #1c2530; background:#11161d; }
  button { background:#5eead4; color:#042f2e; border:0; font-weight:700; padding:6px 14px; border-radius:6px; cursor:pointer; font-family:inherit; }
  button:hover { filter:brightness(1.1); }
  input[type=range] { flex:1; accent-color:#5eead4; }
  .time { color:#56606c; min-width:110px; text-align:right; }
  .foot { color:#3b4654; font-size:11px; margin-top:14px; }
  .chip { border:1px solid #1c2530; color:#56606c; border-radius:99px; padding:2px 10px; font-size:11px; cursor:pointer; user-select:none; }
  .chip.on { color:#042f2e; background:#5eead4; border-color:#5eead4; }
</style>
</head>
<body>
<div class="wrap">
  <h1>⬢ agentbox clip</h1>
  <div class="sub">session <b>${esc(meta.data.name || 'session')}</b> · command <code>${esc(meta.data.cmd || '?')}</code> · ${slim.length} events · recorded ${new Date(t0).toISOString()}</div>
  <div class="term">
    <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="t">black box tape — tamper-evident chain ${res.ok ? 'intact ✓' : 'BROKEN ✗'}</span></div>
    <div id="feed"></div>
    <div class="ctl">
      <button id="play">▶ play</button>
      <input id="scrub" type="range" min="0" value="0">
      <span class="time" id="time">00:00.0</span>
    </div>
  </div>
  <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap" id="filters">
    <span class="chip on" data-k="all">all</span>
    <span class="chip" data-k="tool">▲ tool</span>
    <span class="chip" data-k="cmd">$ shell</span>
    <span class="chip" data-k="file">✎ file</span>
    <span class="chip" data-k="in">i human</span>
    <span class="chip" data-k="stderr">stderr</span>
  </div>
  <div class="foot">generated by agentbox — the flight recorder for AI agents · this file is self-contained; share it anywhere</div>
</div>
<script>
const EVENTS = JSON.parse(document.getElementById('payload-json').textContent);
var t0 = EVENTS.length ? EVENTS[0].rt : 0;
var tN = EVENTS.length ? EVENTS[EVENTS.length-1].rt : 1000;
var cursor = 0, playing = false, filter = 'all', raf = null, startedAt = 0, base = 0;
var feed = document.getElementById('feed'), scrub = document.getElementById('scrub'), time = document.getElementById('time');
document.getElementById('payload-json').remove();
scrub.max = tN - t0;
function mmss(ms){var s=Math.max(0,ms)/1000;var m=Math.floor(s/60);var r=s-m*60;return String(m).padStart(2,'0')+':'+r.toFixed(1).padStart(4,'0');}
function fmt(k,txt){var d=document.createElement('div');d.className='ln k-'+k;
  var ts='<span class="ts">'+mmss(EVENTS[cursor].rt)+'</span>';
  d.innerHTML=ts+'<span class="tag">'+k.toUpperCase()+'</span>'+escapeHtml(txt||'·');return d;}
function escapeHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function visible(i){var e=EVENTS[i];if(filter==='all')return true;var k=e.k==='in'?'in':e.k;return k===filter;}
function drawTo(idx){
  feed.innerHTML='';
  var count=0;
  for(var i=0;i<=idx;i++){
    if(!visible(i))continue;
    var e=EVENTS[i];
    var d=document.createElement('div');d.className='ln k-'+e.k;
    d.innerHTML='<span class="ts">'+mmss(e.rt)+'</span><span class="tag">'+e.k.toUpperCase()+'</span>'+escapeHtml(e.x||'·');
    feed.appendChild(d);count++;
  }
  if(count>400){while(feed.children.length>400)feed.removeChild(feed.firstChild);}
  feed.scrollTop=feed.scrollHeight;
}
function setCursor(i){cursor=Math.max(0,Math.min(EVENTS.length-1,i));scrub.value=EVENTS[cursor].rt-t0;time.textContent=mmss(EVENTS[cursor].rt-t0);drawTo(cursor);}
function tick(){var now=performance.now();var target=base+(now-startedAt);var idx=cursor;
  while(idx<EVENTS.length-1&&EVENTS[idx+1].rt-t0<=target)idx++;
  if(idx!==cursor||true){cursor=idx;scrub.value=EVENTS[cursor].rt-t0;time.textContent=mmss(EVENTS[cursor].rt-t0);drawTo(cursor);}
  if(cursor>=EVENTS.length-1){stop();return;}
  raf=requestAnimationFrame(tick);}
function play(){if(playing)return;playing=true;document.getElementById('play').textContent='⏸ pause';startedAt=performance.now();base=EVENTS[cursor].rt-t0;raf=requestAnimationFrame(tick);}
function stop(){playing=false;document.getElementById('play').textContent='▶ play';if(raf)cancelAnimationFrame(raf);}
document.getElementById('play').onclick=function(){playing?stop():play();};
scrub.oninput=function(){stop();var t=+scrub.value+t0;var i=0;while(i<EVENTS.length-1&&EVENTS[i+1].rt-t0<=t-t0+0)i++;var j=0;while(j<EVENTS.length-1&&EVENTS[j+1].rt<=t)j++;setCursor(j);};
document.getElementById('filters').onclick=function(e){var c=e.target.closest('.chip');if(!c)return;
  document.querySelectorAll('.chip').forEach(function(x){x.classList.remove('on')});c.classList.add('on');filter=c.dataset.k;setCursor(cursor);};
document.addEventListener('keydown',function(e){if(e.key===' '){e.preventDefault();playing?stop():play();}});
setCursor(0);
</script>
<script type="application/json" id="payload-json">${payload}</script>
</body>
</html>
`;

  fs.writeFileSync(outPath, html);
  return outPath;
}

module.exports = { clip };
