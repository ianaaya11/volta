// @ts-nocheck — ported UI glue; fuller typing tracked as a follow-up.
import { Circuit } from './engine';
import { fmt, parseVal } from './format';
import './style.css';

//  PART 2 — SCHEMATIC MODEL + EDITOR
// ===========================================================================
const GRID=26;               // pixels per grid unit
const cv=document.getElementById('cv');
const ctx=cv.getContext('2d');
const stage=document.getElementById('stage');

// The document: a list of components and a list of wires.
// Component: {id,type,x,y,rot,value}. (x,y)=grid coords of pin A (anchor).
// A 2-terminal part spans 2 grid units; pinB is 2 units along `rot`.
// Ground is 1-terminal (pin at x,y ties that point to node 0).
let comps=[];
let wires=[];                // {x1,y1,x2,y2}
let uid=1;
let tool='select';
let selected=null;
let running=false;
let lastResult=null;
let view={ox:0,oy:0};        // pan offset (grid-aligned drawing origin)

const DIR={0:[1,0],90:[0,1],180:[-1,0],270:[0,-1]};
// rotate an integer grid offset by the component's rotation (screen y-down)
function rotOff(dx,dy,rot){
  if(rot===90) return [-dy,dx];
  if(rot===180) return [-dx,-dy];
  if(rot===270) return [dy,-dx];
  return [dx,dy];
}
function pinsOf(c){
  if(c.type==='GND') return [{x:c.x,y:c.y}];
  if(c.type==='QN'||c.type==='QP'||c.type==='MN'||c.type==='MP'){
    // 3 pins, engine order [collector/drain, base/gate, emitter/source].
    const offs=[[2,-2],[0,0],[2,2]]; // C/D, B/G (at anchor), E/S
    return offs.map(([ox,oy])=>{ const [rx,ry]=rotOff(ox,oy,c.rot); return {x:c.x+rx,y:c.y+ry}; });
  }
  if(c.type==='OA'){
    // 3 pins, engine order [out, in+, in-]. Inputs on the left, output on right.
    const offs=[[4,0],[0,-1],[0,1]]; // out, in+, in-
    return offs.map(([ox,oy])=>{ const [rx,ry]=rotOff(ox,oy,c.rot); return {x:c.x+rx,y:c.y+ry}; });
  }
  const [dx,dy]=DIR[c.rot];
  return [{x:c.x,y:c.y},{x:c.x+dx*2,y:c.y+dy*2}];
}
const TYPES={
  R:{name:'Resistor',unit:'Ω',def:1000},
  V:{name:'Voltage',unit:'V',def:5},
  I:{name:'Current',unit:'A',def:0.01},
  C:{name:'Capacitor',unit:'F',def:1e-6},
  L:{name:'Inductor',unit:'H',def:1e-3},
  VS:{name:'Sine source',unit:'V',def:5},
  D:{name:'Diode',unit:'',def:0},
  QN:{name:'NPN transistor',unit:'',def:0},
  MN:{name:'NMOS transistor',unit:'',def:0},
  OA:{name:'Op-amp (ideal)',unit:'',def:0},
  GND:{name:'Ground',unit:'',def:0},
};


// ===========================================================================
//  PART 3 — NETLIST: turn geometry into electrical nodes (union-find)
// ===========================================================================
function buildNetlist(){
  const parent=new Map();
  const key=(x,y)=>x+','+y;
  const find=(k)=>{ if(!parent.has(k)) parent.set(k,k);
    while(parent.get(k)!==k){ parent.set(k,parent.get(parent.get(k))); k=parent.get(k);} return k; };
  const union=(a,b)=>{ parent.set(find(a),find(b)); };
  // Register every pin and wire endpoint.
  for(const c of comps) for(const p of pinsOf(c)) find(key(p.x,p.y));
  for(const w of wires){ find(key(w.x1,w.y1)); find(key(w.x2,w.y2)); }
  // Wires merge their endpoints into one node.
  for(const w of wires) union(key(w.x1,w.y1),key(w.x2,w.y2));
  // Assign integer node ids; grounded roots become node 0.
  const grounded=new Set();
  for(const c of comps) if(c.type==='GND') grounded.add(find(key(c.x,c.y)));
  const rootToNode=new Map(); let next=1;
  const nodeOf=(x,y)=>{ const r=find(key(x,y));
    if(grounded.has(r)) return 0;
    if(!rootToNode.has(r)) rootToNode.set(r,next++); return rootToNode.get(r); };
  // Emit engine components (skip GND — it only defines the reference).
  const netComps=[];
  for(const c of comps){
    if(c.type==='GND') continue;
    const ps=pinsOf(c);
    netComps.push({id:c.id,type:c.type,value:c.value,
      nodes:ps.map(p=>nodeOf(p.x,p.y)),
      ...(c.type==='VS'?{wave:'SIN',amp:c.amp,freq:c.freq,off:c.off}:{})});
  }
  const nodeCount=next-1+(grounded.size?1:0);
  return {netComps,nodeOf,nodeCount,grounded:grounded.size>0};
}

// ---- Wire-current resolver (for animation) --------------------------------
// Within an equipotential node, wires still carry physical current. We solve
// the flow on the wire graph by KCL leaf-pruning (unique for tree wiring).
function solveWireCurrents(result){
  const wc=new Map();               // wire index -> signed current (x1y1 -> x2y2)
  if(!result) return wc;
  const key=(x,y)=>x+','+y;
  // Injection at each grid point from attached component pins.
  const inject=new Map();
  const add=(k,val)=>inject.set(k,(inject.get(k)||0)+val);
  for(const c of comps){
    if(c.type==='GND') continue;
    const ps=pinsOf(c);
    if(c.type==='QN'||c.type==='QP'||c.type==='MN'||c.type==='MP'||c.type==='OA'){
      const t=result.terminals&&result.terminals[c.id]; if(!t) continue;
      // injection into node = -(current flowing into that terminal of the device)
      add(key(ps[0].x,ps[0].y), -t.Ic);
      add(key(ps[1].x,ps[1].y), -t.Ib);
      add(key(ps[2].x,ps[2].y), -t.Ie);
    } else {
      const i=result.current[c.id]||0; // flows pinA -> pinB through the device
      add(key(ps[0].x,ps[0].y), -i);
      add(key(ps[1].x,ps[1].y), +i);
    }
  }
  // Adjacency of wires at each point.
  const adj=new Map();               // point key -> [{wi, other, sign}]
  wires.forEach((w,wi)=>{
    const ka=key(w.x1,w.y1), kb=key(w.x2,w.y2);
    if(!adj.has(ka)) adj.set(ka,[]); if(!adj.has(kb)) adj.set(kb,[]);
    adj.get(ka).push({wi,other:kb,sign:+1}); // +current means flow ka->kb
    adj.get(kb).push({wi,other:ka,sign:-1});
    wc.set(wi,0);
  });
  const known=new Set();
  const netAt=(k)=> (inject.get(k)||0);
  // Iteratively resolve points that have exactly one unknown incident wire.
  for(let pass=0; pass<wires.length+2; pass++){
    let changed=false;
    for(const [k,list] of adj){
      const unknown=list.filter(e=>!known.has(e.wi));
      if(unknown.length===1){
        // KCL: sum of currents leaving k = injection at k.
        let flowOut=netAt(k);
        for(const e of list){ if(known.has(e.wi)){ flowOut += e.sign*wc.get(e.wi); } }
        // remaining wire must carry -flowOut in its sign convention... define:
        const e=unknown[0];
        // currents leaving via known wires already counted with e.sign*wc.
        // Set unknown so that total leaving == 0 given injection is a source:
        // net leaving through wires = injection(k) ... we treat injection as current entering node.
        // Balance: sum(sign*wc) over all incident = inject(k)
        let sumKnown=0;
        for(const g of list){ if(known.has(g.wi)) sumKnown += g.sign*wc.get(g.wi); }
        const val=(netAt(k)-sumKnown)/e.sign;
        wc.set(e.wi,val); known.add(e.wi); changed=true;
      }
    }
    if(!changed) break;
  }
  return wc;
}

// ===========================================================================
//  PART 4 — RENDERING
// ===========================================================================
function resize(){
  const r=stage.getBoundingClientRect();
  cv.width=r.width*devicePixelRatio; cv.height=r.height*devicePixelRatio;
  cv.style.width=r.width+'px'; cv.style.height=r.height+'px';
  ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  draw();
}
window.addEventListener('resize',resize);

function gx(x){ return view.ox + x*GRID; }
function gy(y){ return view.oy + y*GRID; }
function toGrid(px,py){ return {x:Math.round((px-view.ox)/GRID), y:Math.round((py-view.oy)/GRID)}; }

// Voltage -> color (blue low, grey mid, red high) scaled to present range.
let vRange={min:-1,max:1};
function voltColor(v){
  const {min,max}=vRange; const mid=(min+max)/2; const half=Math.max(1e-6,(max-min)/2);
  const t=Math.max(-1,Math.min(1,(v-mid)/half));
  if(t>=0){ const r=Math.round(90+165*t), g=Math.round(120-40*t), b=Math.round(130-90*t); return `rgb(${r},${g},${b})`; }
  const r=Math.round(90+90*t), g=Math.round(120+30*t), b=Math.round(130+120*(-t)); return `rgb(${Math.max(40,r)},${g},${Math.min(255,b)})`;
}

let animPhase=0;
function draw(){
  const W=cv.width/devicePixelRatio, H=cv.height/devicePixelRatio;
  ctx.clearRect(0,0,W,H);
  // grid dots
  ctx.fillStyle='#20293a';
  const startX=((view.ox%GRID)+GRID)%GRID, startY=((view.oy%GRID)+GRID)%GRID;
  for(let x=startX;x<W;x+=GRID) for(let y=startY;y<H;y+=GRID){ ctx.fillRect(x-0.5,y-0.5,1,1); }

  // node color lookup if running
  let net=null;
  if(lastResult){ net=buildNetlist(); }
  const nodeColor=(x,y)=>{
    if(!net||!lastResult) return null;
    const nd=net.nodeOf(x,y); const v=lastResult.nodeVoltage[nd]??0; return voltColor(v);
  };

  // wires
  const wc = running? solveWireCurrents(lastResult) : new Map();
  wires.forEach((w,wi)=>{
    const col = lastResult? nodeColor(w.x1,w.y1) : '#6b7c96';
    ctx.strokeStyle=col||'#6b7c96'; ctx.lineWidth=3; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(gx(w.x1),gy(w.y1)); ctx.lineTo(gx(w.x2),gy(w.y2)); ctx.stroke();
    if(running){ drawFlow(gx(w.x1),gy(w.y1),gx(w.x2),gy(w.y2), wc.get(wi)||0); }
  });

  // components
  for(const c of comps) drawComponent(c, nodeColor);

  // scope probe markers
  if(scopeProbes.length){
    scopeProbes.forEach((p,i)=>{ const X=gx(p.x),Y=gy(p.y);
      ctx.strokeStyle=p.color; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(X,Y,6,0,7); ctx.stroke();
      ctx.fillStyle=p.color; ctx.font='9px ui-monospace,monospace'; ctx.textAlign='center';
      ctx.fillText(String(i+1),X,Y-9); });
    ctx.textAlign='left';
  }

  // pin junction dots
  ctx.fillStyle='#9fb0c8';
  const pinCount=new Map();
  const addPin=(x,y)=>pinCount.set(x+','+y,(pinCount.get(x+','+y)||0)+1);
  for(const c of comps) for(const p of pinsOf(c)) addPin(p.x,p.y);
  for(const w of wires){ addPin(w.x1,w.y1); addPin(w.x2,w.y2); }
  for(const [k,n] of pinCount){ if(n>=3){ const [x,y]=k.split(',').map(Number);
    ctx.beginPath(); ctx.arc(gx(x),gy(y),3.5,0,7); ctx.fill(); } }

  // wire drawing preview
  if(tool==='wire'&&wireStart){ ctx.strokeStyle='#4dabf7'; ctx.setLineDash([5,4]); ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(gx(wireStart.x),gy(wireStart.y)); ctx.lineTo(mouse.px,mouse.py); ctx.stroke(); ctx.setLineDash([]); }
  // ghost for placing
  if(PLACE_TYPES.includes(tool)&&mouse.gx!=null){ drawGhost(tool,mouse.gx,mouse.gy); }

  // selection halo
  if(selected){ const ps=pinsOf(selected);
    ctx.strokeStyle='#4dabf7'; ctx.setLineDash([4,3]); ctx.lineWidth=1.5;
    const xs=ps.map(p=>gx(p.x)), ys=ps.map(p=>gy(p.y));
    const minx=Math.min(...xs)-14,maxx=Math.max(...xs)+14,miny=Math.min(...ys)-14,maxy=Math.max(...ys)+14;
    ctx.strokeRect(minx,miny,maxx-minx,maxy-miny); ctx.setLineDash([]); }

  if(panelMode==='bode') drawBode(); else drawScope();
}

// ---- Oscilloscope panel ----------------------------------------------------
function drawScope(){
  if(!scopeProbes.length) return;
  const W=cv.width/devicePixelRatio, H=cv.height/devicePixelRatio;
  const pad=10, ph=170; const px=pad, py=H-ph-pad, pw=W-2*pad;
  ctx.fillStyle='rgba(12,17,26,0.93)'; ctx.strokeStyle='#2a3547'; ctx.lineWidth=1;
  ctx.fillRect(px,py,pw,ph); ctx.strokeRect(px,py,pw,ph);
  ctx.fillStyle='#c7d3e3'; ctx.font='11px ui-monospace,monospace'; ctx.textAlign='left';
  ctx.fillText('OSCILLOSCOPE', px+12, py+16);
  const plotX=px+58, plotY=py+26, plotW=pw-200, plotH=ph-46;
  // legend (always shown)
  const lx=plotX+plotW+18; let ly=plotY+8;
  scopeProbes.forEach((p,i)=>{ ctx.fillStyle=p.color; ctx.fillRect(lx,ly-8,11,11);
    ctx.fillStyle='#c7d3e3'; ctx.font='10px ui-monospace,monospace'; ctx.textAlign='left';
    const s=scopeBuf&&scopeBuf.series[i]; const last=s&&s.length?s[s.length-1]:null;
    ctx.fillText(`probe ${i+1}`+(last!=null?`  ${fmt(last,'V')}`:''), lx+17, ly+1); ly+=19; });
  if(!scopeBuf||scopeBuf.t.length<2){
    ctx.fillStyle='#6b7c96'; ctx.font='11px ui-monospace,monospace'; ctx.textAlign='center';
    ctx.fillText(running?'sampling…':'press Run to capture waveforms', plotX+plotW/2, plotY+plotH/2);
    ctx.textAlign='left'; return;
  }
  // vertical autoscale across every series
  let mn=Infinity,mx=-Infinity;
  for(const s of scopeBuf.series) for(const v of s){ if(v<mn)mn=v; if(v>mx)mx=v; }
  if(mn===mx){ mn-=1; mx+=1; } const vp=(mx-mn)*0.1; mn-=vp; mx+=vp;
  const t0=scopeBuf.t[0], t1=scopeBuf.t[scopeBuf.t.length-1], dt=(t1-t0)||1;
  const X=t=>plotX+(t-t0)/dt*plotW, Y=v=>plotY+plotH-(v-mn)/(mx-mn)*plotH;
  // horizontal gridlines
  ctx.strokeStyle='#1c2636'; ctx.lineWidth=1;
  for(let i=0;i<=4;i++){ const yy=plotY+plotH*i/4; ctx.beginPath(); ctx.moveTo(plotX,yy); ctx.lineTo(plotX+plotW,yy); ctx.stroke(); }
  if(mn<0&&mx>0){ ctx.strokeStyle='#3a4a63'; ctx.beginPath(); ctx.moveTo(plotX,Y(0)); ctx.lineTo(plotX+plotW,Y(0)); ctx.stroke(); }
  // axis labels
  ctx.fillStyle='#6b7c96'; ctx.font='9px ui-monospace,monospace';
  ctx.textAlign='right'; ctx.fillText(fmt(mx,'V'), plotX-5, plotY+8); ctx.fillText(fmt(mn,'V'), plotX-5, plotY+plotH);
  ctx.textAlign='center'; ctx.fillText(fmt(dt,'s')+' window', plotX+plotW/2, plotY+plotH+15);
  // traces
  scopeBuf.series.forEach((s,i)=>{ ctx.strokeStyle=scopeProbes[i].color; ctx.lineWidth=1.5; ctx.beginPath();
    for(let k=0;k<s.length;k++){ const xx=X(scopeBuf.t[k]), yy=Y(s[k]); k===0?ctx.moveTo(xx,yy):ctx.lineTo(xx,yy); } ctx.stroke(); });
  ctx.textAlign='left';
}

// ---- Bode plot panel (AC frequency response) -------------------------------
function drawBode(){
  const W=cv.width/devicePixelRatio, H=cv.height/devicePixelRatio;
  const pad=10, ph=200; const px=pad, py=H-ph-pad, pw=W-2*pad;
  ctx.fillStyle='rgba(12,17,26,0.94)'; ctx.strokeStyle='#2a3547'; ctx.lineWidth=1;
  ctx.fillRect(px,py,pw,ph); ctx.strokeRect(px,py,pw,ph);
  ctx.fillStyle='#c7d3e3'; ctx.font='11px ui-monospace,monospace'; ctx.textAlign='left';
  ctx.fillText('BODE · frequency response', px+12, py+16);
  if(!bodeData){ ctx.fillStyle='#6b7c96'; ctx.fillText('place a probe on the output, then press Bode', px+180, py+16); return; }
  const f=bodeData.freqs, f0=f[0], f1=f[f.length-1], lg=Math.log10;
  const plotX=px+54, plotW=pw-210;
  const magY=py+28, magH=(ph-52)*0.55, phY=magY+magH+16, phH=(ph-52)*0.45;
  const Xf=fr=>plotX+(lg(fr)-lg(f0))/(lg(f1)-lg(f0))*plotW;
  let mn=Infinity,mx=-Infinity;
  for(const c of bodeData.curves) for(const v of c.mag){ if(isFinite(v)){ if(v<mn)mn=v; if(v>mx)mx=v; } }
  if(!isFinite(mn)){ mn=-40; mx=0; } if(mx-mn<6){ mx+=3; mn-=3; } const mp=(mx-mn)*0.08; mn-=mp; mx+=mp;
  const Ym=db=>magY+magH-(db-mn)/(mx-mn)*magH;
  let pmn=Infinity,pmx=-Infinity; for(const c of bodeData.curves) for(const v of c.phase){ if(v<pmn)pmn=v; if(v>pmx)pmx=v; }
  if(pmx-pmn<10){ pmx+=5; pmn-=5; }
  const Yp=d=>phY+phH-(d-pmn)/(pmx-pmn)*phH;
  // decade gridlines + labels
  ctx.strokeStyle='#1c2636'; ctx.fillStyle='#6b7c96'; ctx.font='9px ui-monospace,monospace'; ctx.textAlign='center';
  for(let d=Math.ceil(lg(f0)); d<=Math.floor(lg(f1)); d++){ const fx=Xf(Math.pow(10,d));
    ctx.beginPath(); ctx.moveTo(fx,magY); ctx.lineTo(fx,phY+phH); ctx.stroke();
    ctx.fillText(fmt(Math.pow(10,d),'Hz'), fx, phY+phH+12); }
  if(mn<0&&mx>0){ ctx.strokeStyle='#3a4a63'; ctx.beginPath(); ctx.moveTo(plotX,Ym(0)); ctx.lineTo(plotX+plotW,Ym(0)); ctx.stroke(); }
  ctx.strokeStyle='#26324a'; ctx.beginPath(); ctx.moveTo(plotX,phY); ctx.lineTo(plotX+plotW,phY); ctx.stroke(); // phase panel top divider
  ctx.fillStyle='#6b7c96'; ctx.textAlign='right';
  ctx.fillText(mx.toFixed(0)+'dB', plotX-4, magY+8); ctx.fillText(mn.toFixed(0)+'dB', plotX-4, magY+magH);
  ctx.fillText(pmx.toFixed(0)+'°', plotX-4, phY+8); ctx.fillText(pmn.toFixed(0)+'°', plotX-4, phY+phH);
  bodeData.curves.forEach(c=>{
    ctx.strokeStyle=c.color; ctx.lineWidth=1.6;
    ctx.beginPath(); f.forEach((fr,i)=>{ const xx=Xf(fr),yy=Ym(c.mag[i]); i===0?ctx.moveTo(xx,yy):ctx.lineTo(xx,yy); }); ctx.stroke();
    ctx.setLineDash([3,3]); ctx.lineWidth=1.2;
    ctx.beginPath(); f.forEach((fr,i)=>{ const xx=Xf(fr),yy=Yp(c.phase[i]); i===0?ctx.moveTo(xx,yy):ctx.lineTo(xx,yy); }); ctx.stroke(); ctx.setLineDash([]);
  });
  const lx=plotX+plotW+18; let ly=magY+8;
  bodeData.curves.forEach(c=>{ ctx.fillStyle=c.color; ctx.fillRect(lx,ly-8,11,11);
    ctx.fillStyle='#c7d3e3'; ctx.textAlign='left'; ctx.font='10px ui-monospace,monospace'; ctx.fillText(c.label,lx+17,ly+1); ly+=18; });
  ctx.fillStyle='#6b7c96'; ctx.font='9px ui-monospace,monospace'; ctx.textAlign='left';
  ctx.fillText('solid = gain (dB)', lx, ly+8); ctx.fillText('dashed = phase (°)', lx, ly+20);
}

// moving dots to show current (EveryCircuit-style)
function drawFlow(x1,y1,x2,y2,cur){
  if(Math.abs(cur)<1e-12) return;
  const len=Math.hypot(x2-x1,y2-y1); if(len<1) return;
  const ux=(x2-x1)/len, uy=(y2-y1)/len;
  const dir=Math.sign(cur);
  const speed=Math.min(1, 0.15+Math.log10(1+Math.abs(cur)*1000)/4); // visual only
  const spacing=16; const n=Math.max(1,Math.floor(len/spacing));
  ctx.fillStyle='#ffd86b';
  for(let i=0;i<n;i++){
    let f=((i/n)+ (animPhase*speed*dir))%1; if(f<0) f+=1;
    const px=x1+ux*len*f, py=y1+uy*len*f;
    ctx.beginPath(); ctx.arc(px,py,2.2,0,7); ctx.fill();
  }
}

function drawComponent(c,nodeColor){
  const ps=pinsOf(c);
  ctx.lineWidth=2.4; ctx.lineJoin='round'; ctx.lineCap='round';
  const col=(x,y)=> (lastResult&&nodeColor)? nodeColor(x,y):'#c7d3e3';
  if(c.type==='GND'){
    const x=gx(c.x),y=gy(c.y);
    ctx.strokeStyle=col(c.x,c.y); ctx.beginPath();
    ctx.moveTo(x,y); ctx.lineTo(x,y+8);
    ctx.moveTo(x-10,y+8); ctx.lineTo(x+10,y+8);
    ctx.moveTo(x-6,y+13); ctx.lineTo(x+6,y+13);
    ctx.moveTo(x-2,y+18); ctx.lineTo(x+2,y+18); ctx.stroke(); return;
  }
  if(c.type==='QN'||c.type==='QP'){
    const Cp={x:gx(ps[0].x),y:gy(ps[0].y)}, Bp={x:gx(ps[1].x),y:gy(ps[1].y)}, Ep={x:gx(ps[2].x),y:gy(ps[2].y)};
    const mid={x:(Cp.x+Ep.x)/2,y:(Cp.y+Ep.y)/2};
    let ax=mid.x-Bp.x, ay=mid.y-Bp.y; const al=Math.hypot(ax,ay)||1; ax/=al; ay/=al; // base->CE axis
    let px=Cp.x-Ep.x, py=Cp.y-Ep.y; const pl=Math.hypot(px,py)||1; px/=pl; py/=pl;     // E->C along bar
    const barC={x:Bp.x+ax*al*0.5, y:Bp.y+ay*al*0.5};
    const barTop={x:barC.x+px*10,y:barC.y+py*10}, barBot={x:barC.x-px*10,y:barC.y-py*10};
    const cJoin={x:barC.x+px*5,y:barC.y+py*5}, eJoin={x:barC.x-px*5,y:barC.y-py*5};
    ctx.strokeStyle=col(ps[1].x,ps[1].y); // base lead
    ctx.beginPath(); ctx.moveTo(Bp.x,Bp.y); ctx.lineTo(barC.x-ax*0,barC.y-ay*0); ctx.stroke();
    ctx.strokeStyle='#c7d3e3'; ctx.beginPath(); ctx.moveTo(barTop.x,barTop.y); ctx.lineTo(barBot.x,barBot.y); ctx.stroke(); // bar
    ctx.strokeStyle=col(ps[0].x,ps[0].y); ctx.beginPath(); ctx.moveTo(cJoin.x,cJoin.y); ctx.lineTo(Cp.x,Cp.y); ctx.stroke(); // collector
    ctx.strokeStyle=col(ps[2].x,ps[2].y); ctx.beginPath(); ctx.moveTo(eJoin.x,eJoin.y); ctx.lineTo(Ep.x,Ep.y); ctx.stroke(); // emitter
    // emitter arrow (NPN points toward emitter pin; PNP toward the bar)
    let ex=Ep.x-eJoin.x, ey=Ep.y-eJoin.y; const el=Math.hypot(ex,ey)||1; ex/=el; ey/=el;
    const npn=(c.type==='QN'); const tip=npn?{x:Ep.x*0.45+eJoin.x*0.55,y:Ep.y*0.45+eJoin.y*0.55}:eJoin;
    const adir=npn?1:-1; ctx.fillStyle='#c7d3e3';
    ctx.beginPath(); ctx.moveTo(tip.x+ex*adir*4,tip.y+ey*adir*4);
    ctx.lineTo(tip.x-ex*adir*4+px*3,tip.y-ey*adir*4+py*3);
    ctx.lineTo(tip.x-ex*adir*4-px*3,tip.y-ey*adir*4-py*3); ctx.closePath(); ctx.fill();
    if(running&&lastResult&&lastResult.terminals&&lastResult.terminals[c.id]){
      const t=lastResult.terminals[c.id];
      drawFlow(Cp.x,Cp.y,barC.x,barC.y,-t.Ic);
      drawFlow(barC.x,barC.y,Ep.x,Ep.y,-t.Ie); }
    ctx.fillStyle='#8b98a9'; ctx.font='10px ui-monospace,monospace'; ctx.textAlign='center';
    ctx.fillText(npn?'NPN':'PNP', barC.x, barC.y-14); ctx.textAlign='left';
    return;
  }
  if(c.type==='MN'||c.type==='MP'){
    const Dp={x:gx(ps[0].x),y:gy(ps[0].y)}, Gp={x:gx(ps[1].x),y:gy(ps[1].y)}, Sp={x:gx(ps[2].x),y:gy(ps[2].y)};
    const mid={x:(Dp.x+Sp.x)/2,y:(Dp.y+Sp.y)/2};
    let ax=mid.x-Gp.x, ay=mid.y-Gp.y; const al=Math.hypot(ax,ay)||1; ax/=al; ay/=al; // gate->channel
    let px=Dp.x-Sp.x, py=Dp.y-Sp.y; const pl=Math.hypot(px,py)||1; px/=pl; py/=pl;     // S->D along bars
    const gateC={x:Gp.x+ax*al*0.45, y:Gp.y+ay*al*0.45};          // gate plate center
    const chanC={x:gateC.x+ax*4, y:gateC.y+ay*4};                 // channel bar center (past a gap)
    ctx.strokeStyle=col(ps[1].x,ps[1].y);                         // gate lead (no channel contact)
    ctx.beginPath(); ctx.moveTo(Gp.x,Gp.y); ctx.lineTo(gateC.x,gateC.y); ctx.stroke();
    ctx.strokeStyle='#c7d3e3';
    ctx.beginPath(); ctx.moveTo(gateC.x+px*9,gateC.y+py*9); ctx.lineTo(gateC.x-px*9,gateC.y-py*9); ctx.stroke(); // gate plate
    ctx.beginPath(); ctx.moveTo(chanC.x+px*9,chanC.y+py*9); ctx.lineTo(chanC.x-px*9,chanC.y-py*9); ctx.stroke(); // channel
    ctx.strokeStyle=col(ps[0].x,ps[0].y); ctx.beginPath(); ctx.moveTo(chanC.x+px*9,chanC.y+py*9); ctx.lineTo(Dp.x,Dp.y); ctx.stroke(); // drain
    ctx.strokeStyle=col(ps[2].x,ps[2].y); ctx.beginPath(); ctx.moveTo(chanC.x-px*9,chanC.y-py*9); ctx.lineTo(Sp.x,Sp.y); ctx.stroke(); // source
    // bulk/source arrow (NMOS points toward channel, PMOS away)
    const nmos=(c.type==='MN'); const dir=nmos?1:-1; const abase={x:chanC.x-px*9,y:chanC.y-py*9};
    ctx.fillStyle='#c7d3e3'; ctx.beginPath();
    ctx.moveTo(abase.x+ax*dir*4, abase.y+ay*dir*4);
    ctx.lineTo(abase.x-ax*dir*4+px*3, abase.y-ay*dir*4+py*3);
    ctx.lineTo(abase.x-ax*dir*4-px*3, abase.y-ay*dir*4-py*3); ctx.closePath(); ctx.fill();
    if(running&&lastResult&&lastResult.terminals&&lastResult.terminals[c.id]){
      const t=lastResult.terminals[c.id]; drawFlow(Dp.x,Dp.y,chanC.x,chanC.y,-t.Ic); drawFlow(chanC.x,chanC.y,Sp.x,Sp.y,-t.Ie); }
    ctx.fillStyle='#8b98a9'; ctx.font='10px ui-monospace,monospace'; ctx.textAlign='center';
    ctx.fillText(nmos?'NMOS':'PMOS', chanC.x, chanC.y-14); ctx.textAlign='left';
    return;
  }
  if(c.type==='OA'){
    const Op={x:gx(ps[0].x),y:gy(ps[0].y)}, Pp={x:gx(ps[1].x),y:gy(ps[1].y)}, Mp={x:gx(ps[2].x),y:gy(ps[2].y)};
    const inMid={x:(Pp.x+Mp.x)/2,y:(Pp.y+Mp.y)/2};
    let ax=Op.x-inMid.x, ay=Op.y-inMid.y; const al=Math.hypot(ax,ay)||1; ax/=al; ay/=al; // input->output
    let px=Pp.x-Mp.x, py=Pp.y-Mp.y; const pl=Math.hypot(px,py)||1; px/=pl; py/=pl;         // in- -> in+
    const backC={x:inMid.x+ax*al*0.28, y:inMid.y+ay*al*0.28};   // triangle back edge center
    const tip={x:inMid.x+ax*al*0.82, y:inMid.y+ay*al*0.82};     // triangle tip
    const bTop={x:backC.x+px*11,y:backC.y+py*11}, bBot={x:backC.x-px*11,y:backC.y-py*11};
    ctx.strokeStyle=col(ps[1].x,ps[1].y); ctx.beginPath(); ctx.moveTo(Pp.x,Pp.y); ctx.lineTo(backC.x+px*7,backC.y+py*7); ctx.stroke();
    ctx.strokeStyle=col(ps[2].x,ps[2].y); ctx.beginPath(); ctx.moveTo(Mp.x,Mp.y); ctx.lineTo(backC.x-px*7,backC.y-py*7); ctx.stroke();
    ctx.strokeStyle=col(ps[0].x,ps[0].y); ctx.beginPath(); ctx.moveTo(tip.x,tip.y); ctx.lineTo(Op.x,Op.y); ctx.stroke();
    ctx.strokeStyle='#c7d3e3'; ctx.beginPath(); ctx.moveTo(bTop.x,bTop.y); ctx.lineTo(bBot.x,bBot.y);
    ctx.lineTo(tip.x,tip.y); ctx.closePath(); ctx.stroke(); // triangle body
    // +/- markers near the two inputs
    ctx.fillStyle='#8b98a9'; ctx.font='9px ui-monospace,monospace'; ctx.textAlign='center';
    ctx.fillText('+', backC.x+px*7+ax*6, backC.y+py*7+ay*6+3);
    ctx.fillText('−', backC.x-px*7+ax*6, backC.y-py*7+ay*6+3);
    if(running&&lastResult&&lastResult.terminals&&lastResult.terminals[c.id]){
      const t=lastResult.terminals[c.id]; drawFlow(tip.x,tip.y,Op.x,Op.y,-t.Ic); }
    ctx.textAlign='left';
    return;
  }
  const A=ps[0],B=ps[1];
  const ax=gx(A.x),ay=gy(A.y),bx=gx(B.x),by=gy(B.y);
  const mx=(ax+bx)/2,my=(ay+by)/2;
  const len=Math.hypot(bx-ax,by-ay); const ux=(bx-ax)/len,uy=(by-ay)/len; // along
  const nx=-uy,ny=ux;                                                     // normal
  // leads
  ctx.strokeStyle=col(A.x,A.y);
  ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(mx-ux*13,my-uy*13); ctx.stroke();
  ctx.strokeStyle=col(B.x,B.y);
  ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(mx+ux*13,my+uy*13); ctx.stroke();
  ctx.strokeStyle='#c7d3e3'; ctx.fillStyle='#c7d3e3';
  const P=(d,o)=>({x:mx+ux*d+nx*o, y:my+uy*d+ny*o});
  if(c.type==='R'){
    ctx.beginPath(); let first=true;
    for(let i=0;i<=6;i++){ const d=-13+ (26*i/6); const o=(i%2? 6:-6)*(i===0||i===6?0:1);
      const p=P(d,o); first?(ctx.moveTo(p.x,p.y),first=false):ctx.lineTo(p.x,p.y);} ctx.stroke();
  } else if(c.type==='V'){
    // long line (+) and short line (-): plates perpendicular to axis
    const pL1=P(-4,9),pL2=P(-4,-9),pS1=P(4,5),pS2=P(4,-5);
    ctx.beginPath(); ctx.moveTo(pL1.x,pL1.y); ctx.lineTo(pL2.x,pL2.y);
    ctx.moveTo(pS1.x,pS1.y); ctx.lineTo(pS2.x,pS2.y); ctx.stroke();
    ctx.font='11px sans-serif'; const pp=P(-9,-13); ctx.fillText('+',pp.x-3,pp.y+4);
  } else if(c.type==='VS'){
    ctx.beginPath(); ctx.arc(mx,my,12,0,7); ctx.stroke();
    ctx.beginPath();
    for(let i=0;i<=20;i++){ const d=-8+16*i/20; const o=5*Math.sin(i/20*Math.PI*2); const p=P(d,o);
      i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y); } ctx.stroke();
  } else if(c.type==='I'){
    ctx.beginPath(); ctx.arc(mx,my,12,0,7); ctx.stroke();
    const a1=P(-6,0),a2=P(6,0); ctx.beginPath(); ctx.moveTo(a1.x,a1.y); ctx.lineTo(a2.x,a2.y);
    const h1=P(2,3),h2=P(2,-3); ctx.moveTo(h1.x,h1.y); ctx.lineTo(a2.x,a2.y); ctx.lineTo(h2.x,h2.y); ctx.stroke();
  } else if(c.type==='C'){
    const p1=P(-3,9),p2=P(-3,-9),p3=P(3,9),p4=P(3,-9);
    ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y);
    ctx.moveTo(p3.x,p3.y); ctx.lineTo(p4.x,p4.y); ctx.stroke();
    // redraw inner leads to plates
    ctx.strokeStyle=col(A.x,A.y); ctx.beginPath(); ctx.moveTo(mx-ux*13,my-uy*13); ctx.lineTo(mx-ux*3,my-uy*3); ctx.stroke();
    ctx.strokeStyle=col(B.x,B.y); ctx.beginPath(); ctx.moveTo(mx+ux*13,my+uy*13); ctx.lineTo(mx+ux*3,my+uy*3); ctx.stroke();
  } else if(c.type==='L'){
    ctx.strokeStyle='#c7d3e3'; ctx.beginPath();
    for(let i=0;i<4;i++){ const d=-12+i*8; const c0=P(d+4,0);
      ctx.moveTo(P(d,0).x,P(d,0).y);
      ctx.arc(c0.x,c0.y,4,Math.atan2(uy,ux)+Math.PI,Math.atan2(uy,ux),false); } ctx.stroke();
  } else if(c.type==='D'){
    const t1=P(-6,7),t2=P(-6,-7),tip=P(6,0);
    ctx.beginPath(); ctx.moveTo(t1.x,t1.y); ctx.lineTo(t2.x,t2.y); ctx.lineTo(tip.x,tip.y); ctx.closePath(); ctx.fill();
    const b1=P(6,7),b2=P(6,-7); ctx.beginPath(); ctx.moveTo(b1.x,b1.y); ctx.lineTo(b2.x,b2.y); ctx.stroke();
  }
  // moving current dots through the body
  if(running&&lastResult){ drawFlow(ax,ay,bx,by, lastResult.current[c.id]||0); }
  // label
  ctx.fillStyle='#8b98a9'; ctx.font='10px ui-monospace,monospace'; ctx.textAlign='center';
  const lp=P(0,-16);
  let valTxt = c.type==='D'?'':fmt(c.value,TYPES[c.type].unit);
  if(c.type==='VS') valTxt = fmt(c.amp,'V')+' '+fmt(c.freq,'Hz');
  ctx.fillText(valTxt, lp.x, lp.y);
  ctx.textAlign='left';
}

function drawGhost(type,x,y){
  ctx.globalAlpha=0.4;
  drawComponent({id:'ghost',type,x,y,rot:ghostRot,value:TYPES[type].def},null);
  ctx.globalAlpha=1;
}

// ===========================================================================
//  PART 5 — INTERACTION
// ===========================================================================
const PLACE_TYPES=['R','V','VS','I','C','L','D','QN','MN','OA','GND'];
let mouse={px:0,py:0,gx:null,gy:null};
let wireStart=null;
let ghostRot=0;
let dragging=null;

function hitComponent(gxu,gyu){
  // nearest component whose centroid is close
  let best=null,bd=1e9;
  for(const c of comps){ const ps=pinsOf(c);
    const cxu=ps.reduce((s,p)=>s+p.x,0)/ps.length, cyu=ps.reduce((s,p)=>s+p.y,0)/ps.length;
    const d=Math.hypot(cxu-gxu,cyu-gyu); if(d<bd&&d<1.4){bd=d;best=c;} }
  return best;
}

stage.addEventListener('mousemove',e=>{
  const r=cv.getBoundingClientRect(); mouse.px=e.clientX-r.left; mouse.py=e.clientY-r.top;
  const g=toGrid(mouse.px,mouse.py); mouse.gx=g.x; mouse.gy=g.y;
  if(dragging){ dragging.c.x=g.x-dragging.dx; dragging.c.y=g.y-dragging.dy; }
  draw();
});
stage.addEventListener('mousedown',e=>{
  const r=cv.getBoundingClientRect(); const px=e.clientX-r.left, py=e.clientY-r.top;
  const g=toGrid(px,py);
  if(PLACE_TYPES.includes(tool)){
    const nc={id:tool+(uid++),type:tool,x:g.x,y:g.y,rot:ghostRot,value:TYPES[tool].def};
    if(tool==='VS'){ nc.amp=5; nc.freq=1000; nc.off=0; }
    comps.push(nc);
    refreshMeta(); draw(); return;
  }
  if(tool==='wire'){
    if(!wireStart){ wireStart={x:g.x,y:g.y}; }
    else { if(g.x!==wireStart.x||g.y!==wireStart.y){ wires.push({x1:wireStart.x,y1:wireStart.y,x2:g.x,y2:g.y}); }
      wireStart={x:g.x,y:g.y}; refreshMeta(); }
    draw(); return;
  }
  if(tool==='probe'){
    const ex=scopeProbes.findIndex(p=>p.x===g.x&&p.y===g.y);
    if(ex>=0) scopeProbes.splice(ex,1);
    else scopeProbes.push({x:g.x,y:g.y,color:SCOPE_COLORS[scopeProbes.length%SCOPE_COLORS.length]});
    resetScope(); draw(); return;
  }
  if(tool==='delete'){
    const c=hitComponent(g.x,g.y); if(c){ comps=comps.filter(k=>k!==c); if(selected===c)selected=null; }
    else { // delete nearest wire
      let bi=-1,bd=0.5; wires.forEach((w,i)=>{ const d=distToSeg(g.x,g.y,w); if(d<bd){bd=d;bi=i;} });
      if(bi>=0) wires.splice(bi,1);
    }
    refreshMeta(); renderInspector(); draw(); return;
  }
  // select tool
  const c=hitComponent(g.x,g.y);
  selected=c; renderInspector();
  if(c){ dragging={c,dx:g.x-c.x,dy:g.y-c.y}; }
  draw();
});
window.addEventListener('mouseup',()=>{ if(dragging){ refreshMeta(); dragging=null; } });
stage.addEventListener('dblclick',e=>{ if(wireStart){ wireStart=null; draw(); } });
window.addEventListener('keydown',e=>{
  if(e.key==='r'||e.key==='R'){ ghostRot=(ghostRot+90)%360; if(selected){ selected.rot=(selected.rot+90)%360; refreshMeta(); } draw(); }
  if(e.key==='Escape'){ wireStart=null; selected=null; setTool('select'); renderInspector(); draw(); }
  if((e.key==='Delete'||e.key==='Backspace')&&selected){ comps=comps.filter(k=>k!==selected); selected=null; refreshMeta(); renderInspector(); draw(); }
});
function distToSeg(x,y,w){
  const x1=w.x1,y1=w.y1,x2=w.x2,y2=w.y2; const dx=x2-x1,dy=y2-y1;
  const t=Math.max(0,Math.min(1,((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy||1)));
  return Math.hypot(x-(x1+t*dx),y-(y1+t*dy));
}

// ===========================================================================
//  PART 6 — SIMULATION LOOP
// ===========================================================================
let circuit=null, simTime=0, simH=1e-5, rafId=null;
// ---- Oscilloscope state ----
let scopeProbes=[];         // {x,y,color} grid points to plot
let scopeBuf=null;          // {t:[], series:[[]...]}
let simNet=null;            // fixed netlist captured at Run (for probe node lookup)
const SCOPE_COLORS=['#4dabf7','#ffd43b','#ff8787','#69db7c','#da77f2','#ffa94d'];
const SCOPE_MAX=1400;
function resetScope(){ scopeBuf={t:[],series:scopeProbes.map(()=>[])}; }
let panelMode='scope';   // 'scope' (transient) or 'bode' (AC sweep)
let bodeData=null;       // {freqs, curves:[{color,label,mag:[dB],phase:[deg]}]}
function refreshMeta(){
  const net=buildNetlist();
  document.getElementById('nodeCount').textContent=(net.nodeCount||0)+' nodes';
}
function startSim(){
  const net=buildNetlist();
  if(!net.grounded){ flashHint('Add a Ground symbol — the simulator needs a 0V reference.'); return; }
  if(net.netComps.length===0){ flashHint('Place some components first.'); return; }
  // choose timestep from smallest reactive time constant present
  simH=chooseTimestep(net.netComps);
  circuit=new Circuit(net.netComps.map(c=>({...c})));
  simNet=net; resetScope(); panelMode='scope';
  simTime=0; running=true;
  document.getElementById('runBtn').textContent='◼ Stop';
  document.getElementById('runBtn').classList.add('stop');
  loop();
}
function stopSim(){
  running=false; if(rafId) cancelAnimationFrame(rafId); rafId=null;
  document.getElementById('runBtn').textContent='▶ Run';
  document.getElementById('runBtn').classList.remove('stop');
  draw();
}
function runBode(){
  const net=buildNetlist();
  if(!net.grounded){ flashHint('Add a Ground — AC analysis needs a 0V reference.'); return; }
  if(!net.netComps.some(c=>c.type==='V'||c.type==='VS')){ flashHint('Add a voltage source — it becomes the AC input for the sweep.'); return; }
  if(!scopeProbes.length){ flashHint('Place a Probe on the output node, then press Bode.'); return; }
  stopSim();
  const c2=new Circuit(net.netComps.map(c=>({...c})));
  const stim=net.netComps.find(c=>c.type==='V'||c.type==='VS').id;
  const res=c2.ac(1,1e6,240,stim);
  const curves=scopeProbes.map((p,i)=>{
    const nd=net.nodeOf(p.x,p.y); const mag=[],phase=[];
    res.phasors.forEach(ph=>{ const Hc=ph[nd]||{re:0,im:0}; const m=Math.hypot(Hc.re,Hc.im);
      mag.push(20*Math.log10(Math.max(m,1e-9))); phase.push(Math.atan2(Hc.im,Hc.re)*180/Math.PI); });
    return {color:p.color,label:'probe '+(i+1),mag,phase};
  });
  bodeData={freqs:res.freqs,curves}; panelMode='bode';
  lastResult=c2.dc();
  flashHint('AC sweep 1 Hz–1 MHz. Solid = gain (dB), dashed = phase (°), per probe.');
  draw();
}
function chooseTimestep(nc){
  let tau=1e-3;
  for(const c of nc){ if(c.type==='C') tau=Math.min(tau, Math.max(1e-7,c.value*1000));
    if(c.type==='L') tau=Math.min(tau, Math.max(1e-7,c.value/1000)); }
  let h=tau/50;
  // ensure at least ~200 steps per sine period for smooth waveforms
  for(const c of nc){ if(c.type==='VS'&&c.freq>0) h=Math.min(h, 1/(c.freq*200)); }
  return h;
}
function loop(){
  if(!running) return;
  // advance a few timesteps per frame for smooth transient evolution
  for(let k=0;k<8;k++){ lastResult=circuit.step(simH); simTime+=simH; }
  // sample the scope once per frame
  if(scopeProbes.length&&simNet&&scopeBuf){
    scopeBuf.t.push(simTime);
    scopeProbes.forEach((p,i)=>{ const nd=simNet.nodeOf(p.x,p.y);
      scopeBuf.series[i].push(lastResult.nodeVoltage[nd]??0); });
    if(scopeBuf.t.length>SCOPE_MAX){ scopeBuf.t.shift(); scopeBuf.series.forEach(s=>s.shift()); }
  }
  updateVRange(); animPhase=(animPhase+0.02)%1;
  draw(); renderReadout();
  rafId=requestAnimationFrame(loop);
}
function updateVRange(){
  if(!lastResult) return;
  let mn=Infinity,mx=-Infinity;
  for(const k in lastResult.nodeVoltage){ const v=lastResult.nodeVoltage[k]; mn=Math.min(mn,v); mx=Math.max(mx,v); }
  if(mn===mx){ mn-=1; mx+=1; }
  vRange.min=vRange.min*0.8+mn*0.2; vRange.max=vRange.max*0.8+mx*0.2;
}

// ===========================================================================
//  PART 7 — INSPECTOR / UI CHROME
// ===========================================================================
function renderInspector(){
  const el=document.getElementById('inspectorBody');
  if(!selected){
    el.innerHTML=`<h3>Inspector</h3><div class="empty">
      Select a component to edit its value.<br><br>
      <b>Shortcuts</b><br>
      <span class="kbd">R</span> rotate · <span class="kbd">Del</span> remove · <span class="kbd">Esc</span> deselect
      </div><hr>
      <h3>Legend</h3>
      <div class="swatch-row"><span class="swatch" style="background:#4dabf7"></span> low voltage</div>
      <div class="swatch-row"><span class="swatch" style="background:#e05a4d"></span> high voltage</div>
      <div class="swatch-row"><span class="swatch" style="background:#ffd86b"></span> current flow (moving dots)</div>`;
    renderReadout(); return;
  }
  const t=TYPES[selected.type];
  let html=`<h3>${t.name}</h3>`;
  const noValue=['GND','D','QN','QP','MN','MP','OA','VS'];
  if(!noValue.includes(selected.type)){
    html+=`<div class="field"><label>Value (${t.unit}) — e.g. 4.7k, 100n, 12</label>
      <input id="valInput" value="${fmt(selected.value,'').trim()}"/></div>`;
  }
  if(selected.type==='VS'){
    html+=`<div class="field"><label>Amplitude (V)</label><input id="ampInput" value="${fmt(selected.amp,'').trim()}"/></div>
      <div class="field"><label>Frequency (Hz)</label><input id="freqInput" value="${fmt(selected.freq,'').trim()}"/></div>
      <div class="field"><label>DC offset (V)</label><input id="offInput" value="${fmt(selected.off||0,'').trim()}"/></div>`;
  }
  if(selected.type==='QN'||selected.type==='QP'){
    html+=`<div class="field"><label>Terminals</label><div class="empty">Base = single-pin side; collector = upper pin, emitter = lower pin (arrow). β≈100.</div></div>`;
  }
  if(selected.type==='MN'||selected.type==='MP'){
    html+=`<div class="field"><label>Terminals</label><div class="empty">Gate = single-pin side; drain = upper pin, source = lower pin (arrow). Vth=1V, k=2mA/V².</div></div>`;
  }
  if(selected.type==='OA'){
    html+=`<div class="field"><label>Terminals</label><div class="empty">Two input pins on the left (+ upper, − lower); output on the right. Ideal gain. Needs feedback.</div></div>`;
  }
  html+=`<div class="field"><label>Orientation</label>
    <button class="btn" onclick="rotateSel()">⟳ Rotate 90°</button></div>`;
  html+=`<button class="btn" onclick="deleteSel()">🗑 Delete</button>`;
  el.innerHTML=html;
  const vi=document.getElementById('valInput');
  if(vi){ vi.addEventListener('change',()=>{ const v=parseVal(vi.value); if(!isNaN(v)&&v>0){ selected.value=v; if(circuit&&running){ syncValues(); } draw(); } });
    vi.addEventListener('keydown',e=>{ if(e.key==='Enter') vi.blur(); }); }
  const bindNum=(id,set)=>{ const e=document.getElementById(id); if(!e) return;
    e.addEventListener('change',()=>{ const v=parseVal(e.value); if(!isNaN(v)){ set(v); if(circuit&&running) syncSine(); draw(); } });
    e.addEventListener('keydown',ev=>{ if(ev.key==='Enter') e.blur(); }); };
  bindNum('ampInput',v=>selected.amp=v);
  bindNum('freqInput',v=>selected.freq=v);
  bindNum('offInput',v=>selected.off=v);
  renderReadout();
}
function syncValues(){ // push edited values into live sim without restarting
  const net=buildNetlist(); const map=new Map(net.netComps.map(c=>[c.id,c]));
  for(const c of circuit.components){ const n=map.get(c.id); if(n) c.value=n.value; }
}
function syncSine(){ // push edited sine params into the live sim
  for(const c of circuit.components){ const s=comps.find(k=>k.id===c.id);
    if(s&&s.type==='VS'){ c.amp=s.amp; c.freq=s.freq; c.off=s.off; } }
}
function renderReadout(){
  const el=document.getElementById('inspectorBody');
  let host=document.getElementById('readoutHost');
  if(!host){ host=document.createElement('div'); host.id='readoutHost'; el.appendChild(host); }
  if(!lastResult){ host.innerHTML=''; return; }
  let rows='';
  if(selected&&selected.type!=='GND'){
    const v=lastResult.voltageAcross[selected.id], i=lastResult.current[selected.id];
    rows+=`<hr><h3>Live — ${selected.id}</h3><div class="readout">
      <div><span class="k">Voltage across</span><span class="v">${fmt(v,'V')}</span></div>
      <div><span class="k">Current</span><span class="v">${fmt(i,'A')}</span></div>
      <div><span class="k">Power</span><span class="v">${fmt(Math.abs(v*i),'W')}</span></div></div>`;
  }
  // node table
  rows+=`<hr><h3>Node voltages</h3><table class="probes">`;
  const seen=new Set();
  for(const k in lastResult.nodeVoltage){ if(seen.has(k))continue; seen.add(k);
    rows+=`<tr><td>node ${k===''?0:k}</td><td>${fmt(lastResult.nodeVoltage[k],'V')}</td></tr>`; }
  rows+=`</table>`;
  host.innerHTML=rows;
}
window.rotateSel=()=>{ if(selected){ selected.rot=(selected.rot+90)%360; refreshMeta(); draw(); } };
window.deleteSel=()=>{ if(selected){ comps=comps.filter(k=>k!==selected); selected=null; refreshMeta(); renderInspector(); draw(); } };

function flashHint(msg){ const h=document.getElementById('hint'); h.innerHTML=msg; h.style.borderColor='var(--accent2)';
  setTimeout(()=>{h.style.borderColor='';},2500); }

// ---- Tool rail buttons ----
const RAIL=[
  {t:'select',label:'Select',icon:'M4 3l7 17 2-7 7-2z'},
  {t:'wire',label:'Wire',icon:'M3 12h6a3 3 0 003-3V6M21 12h-6a3 3 0 00-3 3v3'},
  {t:'probe',label:'Probe'},
  {t:'R',label:'Resistor'},
  {t:'V',label:'Source'},
  {t:'VS',label:'Sine'},
  {t:'I',label:'Current'},
  {t:'C',label:'Cap'},
  {t:'L',label:'Inductor'},
  {t:'D',label:'Diode'},
  {t:'QN',label:'NPN'},
  {t:'MN',label:'NMOS'},
  {t:'OA',label:'Op-amp'},
  {t:'GND',label:'Ground'},
  {t:'delete',label:'Delete',icon:'M6 7h12l-1 13H7zM9 7V4h6v3'},
];
function buildRail(){
  const rail=document.getElementById('rail');
  rail.innerHTML='';
  for(const item of RAIL){
    const b=document.createElement('button'); b.className='tool'; b.dataset.t=item.t;
    b.innerHTML=miniSymbol(item.t)+`<span>${item.label}</span>`;
    b.onclick=()=>setTool(item.t);
    rail.appendChild(b);
  }
  updateRail();
}
function miniSymbol(t){
  const s=(inner)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${inner}</svg>`;
  switch(t){
    case 'select': return s('<path d="M5 3l6 15 2-6 6-2z"/>');
    case 'wire': return s('<path d="M3 16h6a3 3 0 003-3 3 3 0 013-3h6"/>');
    case 'R': return s('<path d="M2 12h3l1.5-4 3 8 3-8 3 8 1.5-4H21"/>');
    case 'V': return s('<circle cx="12" cy="12" r="7"/><path d="M12 8v8M9 12h6"/>');
    case 'VS': return s('<circle cx="12" cy="12" r="7"/><path d="M8 12a2 2 0 014 0 2 2 0 004 0"/>');
    case 'probe': return s('<path d="M3 21l7-7M9 11l4 4M11 9l6-6 3 3-6 6z"/>');
    case 'I': return s('<circle cx="12" cy="12" r="7"/><path d="M12 8v8M9 11l3-3 3 3"/>');
    case 'C': return s('<path d="M2 12h8M14 12h8M10 6v12M14 6v12"/>');
    case 'L': return s('<path d="M2 14h3a3 3 0 016 0 3 3 0 016 0h3"/>');
    case 'D': return s('<path d="M2 12h6M16 12h6M8 6l8 6-8 6zM16 6v12"/>');
    case 'QN': return s('<path d="M3 12h6M9 5v14M9 9l9-5M9 15l9 5"/>');
    case 'MN': return s('<path d="M3 12h4M7 6v12M10 6v12M10 8h8M10 16h8M18 4v6M18 14v6"/>');
    case 'OA': return s('<path d="M4 5v14l14-7zM2 9h2M2 15h2"/>');
    case 'GND': return s('<path d="M12 4v8M6 12h12M8 16h8M10 20h4"/>');
    case 'delete': return s('<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13"/>');
  }
  return '';
}
function setTool(t){ tool=t; wireStart=null; if(!PLACE_TYPES.includes(t)) ghostRot=ghostRot; updateRail();
  const hints={select:'Click a part to select & drag. Edit its value on the right.',
    wire:'Click pin to pin to lay wire. Double-click to finish a run.',
    probe:'Click a node/wire to scope its voltage. Click again to remove. Then press Run.',
    delete:'Click a component or wire to remove it.'};
  document.getElementById('hint').innerHTML=hints[t]||`Click the grid to place a <b>${TYPES[t]?TYPES[t].name:t}</b>. Press <span class="kbd">R</span> to rotate.`;
  draw();
}
function updateRail(){ document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active',b.dataset.t===tool)); }

// ---- Example circuits -----------------------------------------------------
const GALLERY=[
  {name:'RC low-pass (transient)', fn:loadRC},
  {name:'Sine → RC low-pass (scope)', fn:loadSine},
  {name:'RLC bandpass (Bode)', fn:loadRLC},
  {name:'BJT common-emitter amp', fn:loadAmp},
  {name:'NMOS common-source amp', fn:loadMos},
  {name:'Non-inverting op-amp', fn:loadOpamp},
];
function buildGallery(){
  const sel=document.getElementById('gallery');
  sel.innerHTML='<option value="">Examples ▾</option>'+GALLERY.map((g,i)=>`<option value="${i}">${g.name}</option>`).join('');
  sel.onchange=()=>{ const i=sel.value; if(i!==''){ GALLERY[+i].fn(); } sel.value=''; };
}

// ===========================================================================
//  PART 8 — PERSISTENCE  (save / open / share)
// ===========================================================================
// A circuit is fully described by its parts, wires and probes — nothing else
// needs to be stored. Runtime state (the solver, animation) is rebuilt on load.
function serializeModel(){
  return { v:1,
    comps: comps.map(c=>({...c})),
    wires: wires.map(w=>({...w})),
    probes: scopeProbes.map(p=>({x:p.x,y:p.y,color:p.color})) };
}
function applyModel(m){
  if(!m||!Array.isArray(m.comps)||!Array.isArray(m.wires)) throw new Error('not a Spark circuit');
  stopSim();
  comps=m.comps.map(c=>({...c}));
  wires=m.wires.map(w=>({...w}));
  scopeProbes=(m.probes||[]).map((p,i)=>({x:p.x,y:p.y,color:p.color||SCOPE_COLORS[i%SCOPE_COLORS.length]}));
  // rebuild the id counter so new parts never collide with loaded ones
  let mx=0; for(const c of comps){ const n=parseInt(String(c.id).replace(/\D/g,''),10); if(n>mx) mx=n; }
  uid=mx+1;
  lastResult=null; selected=null; bodeData=null; panelMode='scope'; resetScope();
  refreshMeta(); renderInspector(); draw();
}
function saveFile(){
  const blob=new Blob([JSON.stringify(serializeModel(),null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='spark-circuit.json';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  flashHint('Saved <b>spark-circuit.json</b> to your downloads.');
}
function openFile(){
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
  inp.onchange=()=>{ const f=inp.files[0]; if(!f) return; const r=new FileReader();
    r.onload=()=>{ try{ applyModel(JSON.parse(r.result)); flashHint('Loaded <b>'+f.name+'</b>.'); }
      catch(e){ flashHint('Could not open that file — '+e.message); } };
    r.readAsText(f); };
  inp.click();
}
// Circuit <-> URL hash: JSON, then UTF-8-safe base64. Small circuits fit easily.
function encodeModel(m){ return btoa(unescape(encodeURIComponent(JSON.stringify(m)))); }
function decodeModel(s){ return JSON.parse(decodeURIComponent(escape(atob(s)))); }
function shareURL(){
  const code=encodeModel(serializeModel());
  const url=location.origin+location.pathname+'#c='+code;
  try{ history.replaceState(null,'','#c='+code); }catch(e){}
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(()=>flashHint('Shareable link copied to your clipboard.'),
      ()=>flashHint('Link is in the address bar — copy it to share.'));
  } else flashHint('Link is in the address bar — copy it to share.');
}
function loadFromHash(){
  const h=location.hash||''; const m=h.match(/#c=(.+)$/);
  if(!m) return false;
  try{ applyModel(decodeModel(m[1])); return true; }
  catch(e){ return false; }
}

// Series RLC bandpass (L=10mH, C=1µF -> f0≈1.6kHz), output across R. A probe
// on the output is pre-placed — press Bode to see the resonant peak.
function loadRLC(){
  comps=[]; wires=[]; uid=1; scopeProbes=[];
  comps.push({id:'VS'+(uid++),type:'VS',x:4,y:6,rot:90,value:1,amp:1,freq:1600,off:0});
  wires.push({x1:4,y1:8,x2:4,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:4,y:10});
  wires.push({x1:4,y1:6,x2:6,y2:6});
  comps.push({id:'L'+(uid++),type:'L',x:6,y:6,rot:0,value:0.01});   // (6,6)-(8,6)
  comps.push({id:'C'+(uid++),type:'C',x:8,y:6,rot:0,value:1e-6});   // (8,6)-(10,6)
  comps.push({id:'R'+(uid++),type:'R',x:10,y:6,rot:90,value:50});   // output (10,6)-(10,8)
  wires.push({x1:10,y1:8,x2:10,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:10,y:10});
  scopeProbes.push({x:10,y:6,color:SCOPE_COLORS[0]}); // output across R
  scopeProbes.push({x:4,y:6,color:SCOPE_COLORS[1]});  // input
  resetScope();
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('Series RLC bandpass. Press <b>Bode</b> for the resonant peak near 1.6kHz — or <b>Run</b> to see it in time.');
}

// Sine source into an RC low-pass (fc≈800Hz), driven at the cutoff. Two scope
// probes are pre-placed on the input and output so the roll-off is visible.
function loadSine(){
  comps=[]; wires=[]; uid=1; scopeProbes=[];
  comps.push({id:'VS'+(uid++),type:'VS',x:4,y:6,rot:90,value:3,amp:3,freq:800,off:0});
  wires.push({x1:4,y1:8,x2:4,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:4,y:10});
  wires.push({x1:4,y1:6,x2:6,y2:6});
  comps.push({id:'R'+(uid++),type:'R',x:6,y:6,rot:0,value:2000});   // input(6,6)->output(8,6)
  comps.push({id:'C'+(uid++),type:'C',x:8,y:6,rot:90,value:1e-7});  // output->(8,8)
  wires.push({x1:8,y1:8,x2:8,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:8,y:10});
  scopeProbes.push({x:4,y:6,color:SCOPE_COLORS[0]});  // input
  scopeProbes.push({x:8,y:6,color:SCOPE_COLORS[1]});  // output
  resetScope();
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('Sine → RC low-pass at cutoff. Press <b>Run</b> — scope shows input (blue) vs the attenuated, lagging output (yellow).');
}

// NMOS common-source amplifier: Vdd=5, Rd=2k, gate divider 150k/100k -> Vg=2V.
// Verified: Vg=2V, Vd=3V, Id=1mA (Vth=1V, k=2mA/V²).
function loadMos(){
  comps=[]; wires=[]; uid=1;
  comps.push({id:'V'+(uid++),type:'V',x:4,y:4,rot:90,value:5});
  wires.push({x1:4,y1:6,x2:4,y2:8}); comps.push({id:'GND'+(uid++),type:'GND',x:4,y:8});
  wires.push({x1:4,y1:4,x2:8,y2:4}); wires.push({x1:8,y1:4,x2:12,y2:4});
  comps.push({id:'R'+(uid++),type:'R',x:8,y:4,rot:90,value:150000});  // R1: Vdd->gate
  wires.push({x1:8,y1:6,x2:8,y2:8});                                  // gate node
  comps.push({id:'R'+(uid++),type:'R',x:6,y:8,rot:0,value:100000});   // R2: gate->(6,8)
  wires.push({x1:6,y1:8,x2:6,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:6,y:10});
  comps.push({id:'R'+(uid++),type:'R',x:12,y:4,rot:90,value:2000});   // Rd: Vdd->drain
  comps.push({id:'M'+(uid++),type:'MN',x:8,y:8,rot:0});               // gate(8,8) drain(10,6) source(10,10)
  wires.push({x1:12,y1:6,x2:10,y2:6});                               // Rd -> drain
  wires.push({x1:10,y1:10,x2:10,y2:12}); comps.push({id:'GND'+(uid++),type:'GND',x:10,y:12});
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('NMOS common-source amp — press <b>Run</b>. Gate ≈ 2V, drain ≈ 3V.');
}

// Non-inverting op-amp, gain = 1 + Rf/Rg = 2, Vin=1V -> Vout=2V.
function loadOpamp(){
  comps=[]; wires=[]; uid=1;
  comps.push({id:'V'+(uid++),type:'V',x:6,y:5,rot:90,value:1});       // Vin: (6,5)+ (6,7)-
  wires.push({x1:6,y1:7,x2:6,y2:9}); comps.push({id:'GND'+(uid++),type:'GND',x:6,y:9});
  wires.push({x1:6,y1:5,x2:10,y2:5});                                 // Vin -> in+
  comps.push({id:'OA'+(uid++),type:'OA',x:10,y:6,rot:0});             // out(14,6) in+(10,5) in-(10,7)
  wires.push({x1:10,y1:7,x2:10,y2:8});                               // in- -> feedback node
  comps.push({id:'R'+(uid++),type:'R',x:12,y:8,rot:0,value:10000});   // Rf: (12,8)-(14,8)
  wires.push({x1:10,y1:8,x2:12,y2:8});                               // fb node -> Rf
  wires.push({x1:14,y1:8,x2:14,y2:6});                               // Rf -> out
  comps.push({id:'R'+(uid++),type:'R',x:10,y:8,rot:90,value:10000});  // Rg: (10,8)-(10,10)
  wires.push({x1:10,y1:10,x2:10,y2:12}); comps.push({id:'GND'+(uid++),type:'GND',x:10,y:12});
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('Non-inverting op-amp, gain 2 — press <b>Run</b>. Output ≈ 2V from a 1V input.');
}

// A common-emitter NPN amplifier bias: Vcc=5V, Rc=1k, Rb=470k, emitter grounded.
// Verified operating point: Vc ≈ 4.09V, Ic ≈ 0.91mA, β = 100.
function loadAmp(){
  comps=[]; wires=[]; uid=1;
  comps.push({id:'V'+(uid++),type:'V',x:4,y:4,rot:90,value:5});   // Vcc source
  wires.push({x1:4,y1:6,x2:4,y2:8}); comps.push({id:'GND'+(uid++),type:'GND',x:4,y:8});
  wires.push({x1:4,y1:4,x2:8,y2:4}); wires.push({x1:8,y1:4,x2:12,y2:4}); // Vcc rail
  comps.push({id:'R'+(uid++),type:'R',x:8,y:4,rot:90,value:470000}); // Rb: Vcc->base
  comps.push({id:'R'+(uid++),type:'R',x:12,y:4,rot:90,value:1000});  // Rc: Vcc->collector
  wires.push({x1:8,y1:6,x2:8,y2:8});                                 // Rb bottom -> base
  comps.push({id:'Q'+(uid++),type:'QN',x:8,y:8,rot:0});             // base(8,8) C(10,6) E(10,10)
  wires.push({x1:12,y1:6,x2:10,y2:6});                               // Rc bottom -> collector
  wires.push({x1:10,y1:10,x2:10,y2:12}); comps.push({id:'GND'+(uid++),type:'GND',x:10,y:12}); // emitter->gnd
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('NPN common-emitter amplifier — press <b>Run</b>. Collector should sit near 4.1V.');
}

// A 5V source drives R1 into node B, where a capacitor (RC low-pass), a 2k
// load resistor, and a diode-to-ground all sit. Every 2-terminal part spans
// exactly 2 grid units, so pins meet cleanly. Top rail = y4, ground rail = y8.
function loadRC(){
  comps=[]; wires=[]; uid=1;
  // Source (vertical): + at top (4,4), - at (4,6).
  comps.push({id:'V'+(uid++),type:'V',x:4,y:4,rot:90,value:5});
  wires.push({x1:4,y1:6,x2:4,y2:8});                 // source - down to ground rail
  comps.push({id:'GND'+(uid++),type:'GND',x:4,y:8}); // 0V reference
  // Top rail: source+ -> R1 -> node B
  wires.push({x1:4,y1:4,x2:6,y2:4});
  comps.push({id:'R'+(uid++),type:'R',x:6,y:4,rot:0,value:1000});  // R1 (6,4)-(8,4)
  // Node B fans out along the top rail to C, R2, D
  wires.push({x1:8,y1:4,x2:10,y2:4});
  wires.push({x1:10,y1:4,x2:12,y2:4});
  comps.push({id:'C'+(uid++),type:'C',x:8,y:4,rot:90,value:1e-6}); // C  (8,4)-(8,6)
  comps.push({id:'R'+(uid++),type:'R',x:10,y:4,rot:90,value:2000});// R2 (10,4)-(10,6)
  comps.push({id:'D'+(uid++),type:'D',x:12,y:4,rot:90,value:0});   // D  (12,4)-(12,6)
  // Bottoms down to the ground rail at y8
  wires.push({x1:8,y1:6,x2:8,y2:8});
  wires.push({x1:10,y1:6,x2:10,y2:8});
  wires.push({x1:12,y1:6,x2:12,y2:8});
  wires.push({x1:4,y1:8,x2:8,y2:8});
  wires.push({x1:8,y1:8,x2:10,y2:8});
  wires.push({x1:10,y1:8,x2:12,y2:8});
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('Example loaded — press <b>Run</b> to watch it come alive.');
}

document.getElementById('runBtn').onclick=()=>{ running?stopSim():startSim(); };
document.getElementById('clearBtn').onclick=()=>{ stopSim(); comps=[];wires=[];lastResult=null;selected=null; scopeProbes=[]; scopeBuf=null; bodeData=null; panelMode='scope'; refreshMeta(); renderInspector(); draw(); };
document.getElementById('bodeBtn').onclick=runBode;
document.getElementById('rotateBtn').onclick=()=>{ ghostRot=(ghostRot+90)%360; if(selected){selected.rot=(selected.rot+90)%360; refreshMeta();} draw(); };
document.getElementById('saveBtn').onclick=saveFile;
document.getElementById('openBtn').onclick=openFile;
document.getElementById('shareBtn').onclick=shareURL;

// ---- boot ----
buildRail(); buildGallery(); setTool('select'); renderInspector();
view.ox=40; view.oy=40;
resize();
if(!loadFromHash()) loadRC();   // restore a shared circuit, else the default example
