/* Isolated app-level checks for asynchronous scans and image boundaries. */
(async () => {
  const checks = [], assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const detector = window.QRDetection;
  const props = ['setPointerCapture','releasePointerCapture','hasPointerCapture'].map(k=>[k,Object.getOwnPropertyDescriptor(viewport,k)]);
  const img = new Image(), qr = qrcode(3,'M'); qr.addData('scan fixture'); qr.make();
  await new Promise(resolve=>{img.onload=resolve;img.src=qr.createDataURL(8,32);});
  const c=document.createElement('canvas');c.width=800;c.height=800;
  const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,800,800);ctx.drawImage(img,80,80);
  const source=new Image();await new Promise(resolve=>{source.onload=resolve;source.src=c.toDataURL();});
  await loadImage(source,'scan-fixture.png');
  viewport.setPointerCapture=()=>{};viewport.releasePointerCapture=()=>{};viewport.hasPointerCapture=()=>false;
  const pointer=(type,x,y)=>{const r=viewport.getBoundingClientRect();viewport.dispatchEvent(new PointerEvent(type,{pointerId:1,pointerType:'mouse',button:0,clientX:r.left+camera.x+x*camera.scale,clientY:r.top+camera.y+y*camera.scale,bubbles:true}));};
  try {
    const known=JSON.parse(JSON.stringify(state.detections[0]));
    let finish;
    window.QRDetection={detectCanvas:()=>new Promise(resolve=>{finish=resolve;})};
    const scanning=runDetection();
    const p=state.detections[0].loc.tl;
    pointer('pointerdown',p.x,p.y);pointer('pointermove',p.x-10,p.y-10);
    finish([known,{data:'new target',version:3,loc:{tl:{x:450,y:450},tr:{x:682,y:450},br:{x:682,y:682},bl:{x:450,y:682}}}]);
    await new Promise(resolve=>setTimeout(resolve,30));
    assert(state.detections.length===1,'scan merge waits for active geometry edit');
    pointer('pointercancel',p.x,p.y);await scanning;
    assert(state.detections.length===2 && state.detections[0].loc.tl.x===known.loc.tl.x,'cancel restores drag while preserving later scan results');
    const before=JSON.stringify(captureEdit());
    const canceled=runDetection();stopScan();finish([]);await canceled;
    assert(JSON.stringify(captureEdit())===before&&!scanRun,'canceled scan does not overwrite edits');
    const oldName=state.srcName, oldImage=state.img;
    try {await loadImage({naturalWidth:40000,naturalHeight:2000},'rejected.png');} catch (_) {}
    assert(state.srcName===oldName&&state.img===oldImage,'rejected import preserves old image and export filename');
    const discarded=runDetection();const finishOld=finish;
    window.QRDetection=detector;
    await loadImage(source,'new-document.png');finishOld([{data:'stale result',version:1,loc:known.loc}]);await discarded;
    assert(state.srcName==='new-document.png'&&!state.detections.some(d=>d.data==='stale result'),'new import rejects older scan completion');
    return {passed:checks.length,checks};
  } finally {
    window.QRDetection=detector;cancelInteraction();
    for(const [key,desc] of props){if(desc)Object.defineProperty(viewport,key,desc);else delete viewport[key];}
  }
})()
