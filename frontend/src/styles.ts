/** Editor CSS — compact, professional dark/light themes via CSS variables. */
export const css = String.raw;
export const styles = `
:root { --bg:#15171c; --panel:#1e2128; --panel2:#262a33; --text:#e8eaf0; --muted:#9aa1b0;
  --accent:#4ea8de; --danger:#e5484d; --ok:#46a377; --border:#333844; }
[data-theme="light"] { --bg:#f2f3f7; --panel:#ffffff; --panel2:#eceef3; --text:#1c1f26; --muted:#5b6272;
  --accent:#1d7fb8; --border:#d6dae2; }
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
button, input, select, textarea { font: inherit; color: inherit; }
.app { display:flex; flex-direction:column; height:100vh; }
.toolbar { display:flex; align-items:center; gap:8px; padding:6px 10px; background:var(--panel); border-bottom:1px solid var(--border); flex-wrap:wrap; }
.toolbar .spacer { flex:1; }
.main { display:flex; flex:1; min-height:0; }
.toolrail { display:flex; flex-direction:column; gap:2px; padding:6px; background:var(--panel); border-right:1px solid var(--border); width:52px; overflow-y:auto; }
.toolrail button { height:38px; border-radius:8px; border:1px solid transparent; background:transparent; cursor:pointer; font-size:16px; position:relative; }
.toolrail button.active { background:var(--accent); color:#fff; }
.toolrail button:hover:not(.active) { background:var(--panel2); }
.stage { flex:1; min-width:0; position:relative; background:var(--bg); overflow:hidden; }
.stage canvas { position:absolute; inset:0; width:100%; height:100%; touch-action:none; }
.sidepanel { width:300px; background:var(--panel); border-left:1px solid var(--border); overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:12px; }
.bottom { background:var(--panel); border-top:1px solid var(--border); display:flex; flex-direction:column; }
.tabs { display:flex; gap:4px; padding:6px 10px 0; }
.tabs button { padding:6px 14px; border:1px solid var(--border); border-bottom:none; border-radius:8px 8px 0 0; background:var(--panel2); cursor:pointer; }
.tabs button.active { background:var(--bg); color:var(--text); font-weight:600; }
.panel-body { padding:10px; overflow:auto; max-height:280px; }
section.card { background:var(--panel2); border:1px solid var(--border); border-radius:10px; padding:10px; display:flex; flex-direction:column; gap:8px; }
section.card h3 { margin:0; font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
.row { display:flex; align-items:center; gap:8px; }
.row.wrap { flex-wrap:wrap; }
.grow { flex:1; min-width:0; }
input[type=text], input[type=number], input[type=search], select, textarea {
  background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:5px 8px; color:var(--text); }
input[type=color] { width:34px; height:28px; border:1px solid var(--border); border-radius:6px; background:var(--bg); padding:2px; }
input[type=range] { accent-color: var(--accent); }
.btn { padding:6px 12px; border-radius:8px; border:1px solid var(--border); background:var(--panel2); cursor:pointer; }
.btn:hover { border-color: var(--accent); }
.btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.btn.danger { color:var(--danger); }
.btn.small { padding:3px 8px; font-size:12px; }
.btn[disabled] { opacity:.45; cursor:not-allowed; }
.chip { display:inline-flex; align-items:center; gap:4px; padding:2px 9px; border-radius:999px; background:var(--panel2); border:1px solid var(--border); font-size:12px; }
.chip.ok { color:var(--ok); border-color:var(--ok); }
.chip.bad { color:var(--danger); border-color:var(--danger); }
.statusbar { padding:3px 12px; font-size:12px; color:var(--muted); background:var(--panel); border-top:1px solid var(--border); min-height:24px; }
.timeline-scroll { overflow-x:auto; }
.layers-list { display:flex; flex-direction:column; gap:4px; }
.layer-row { display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:8px; border:1px solid transparent; cursor:pointer; }
.layer-row.selected { background:var(--bg); border-color:var(--accent); }
.layer-row:hover { background:var(--bg); }
.modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; z-index:50; }
.modal { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px; width:min(680px, 92vw); max-height:86vh; overflow:auto; display:flex; flex-direction:column; gap:12px; }
.kf { position:absolute; top:50%; transform:translate(-50%,-50%) rotate(45deg); width:10px; height:10px; background:var(--accent); border-radius:2px; cursor:pointer; }
.kf.sel { background:#ffd166; }
.track-row { position:relative; height:26px; border-bottom:1px solid var(--border); }
.ruler { position:relative; height:24px; border-bottom:1px solid var(--border); cursor:ew-resize; }
.playhead { position:absolute; top:0; bottom:0; width:2px; background:var(--danger); pointer-events:none; z-index:5; }
.story-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; }
.story-card { border:1px solid var(--border); border-radius:10px; background:var(--panel2); padding:10px; display:flex; flex-direction:column; gap:6px; }
.thumb { background:#0008; border-radius:6px; aspect-ratio:16/9; display:flex; align-items:center; justify-content:center; color:var(--muted); overflow:hidden; }
.thumb img, .thumb canvas { max-width:100%; max-height:100%; }
.muted { color:var(--muted); font-size:12px; }
.empty-state { padding:24px; text-align:center; color:var(--muted); border:1px dashed var(--border); border-radius:10px; }
.progress { height:8px; border-radius:4px; background:var(--bg); overflow:hidden; }
.progress > div { height:100%; background:var(--accent); transition:width .1s linear; }
.sr-only { position:absolute; width:1px; height:1px; clip-path:inset(50%); overflow:hidden; white-space:nowrap; }
.toast { position:fixed; bottom:40px; left:50%; transform:translateX(-50%); background:var(--panel2); border:1px solid var(--accent); padding:8px 16px; border-radius:10px; z-index:60; }
`;
