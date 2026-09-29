/* The inspection report's own page: fits the paper to the screen, paginates, prints and saves the
   PDF. The app writes the report into /report and passes its settings in #doc-config. */
var DOC=JSON.parse(document.getElementById('doc-config').textContent);
// Safari on iPhone ignores window.print() when the site runs from the Home Screen, and
// there is no share menu there either — so the page builds the PDF itself and hands the
// file to the system share sheet, which can save it to Files, send it, or print it.
function reportFileName(){ return DOC.fileName; }
var SRI={'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js':'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H','https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js':'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk'};
function loadOnce(src){
  return new Promise(function(res,rej){
    var s=document.createElement('script');
    s.src=src; s.crossOrigin='anonymous'; if(SRI[src]) s.integrity=SRI[src]; s.onload=res; s.onerror=function(){ rej(new Error('Could not load '+src)); };
    document.head.appendChild(s);
  });
}
/** html2canvas draws an <img> of an SVG badly; the browser itself draws it correctly. */
async function flattenLogo(){
  var img=document.querySelector('.brand img');
  if(!img) return function(){};
  var src=img.getAttribute('src');
  try{
    var im=new Image(); im.decoding='sync'; im.src=src; await im.decode();
    var w=im.naturalWidth||300, h=im.naturalHeight||106, c=document.createElement('canvas');
    c.width=w*3; c.height=h*3;
    c.getContext('2d').drawImage(im,0,0,c.width,c.height);
    img.setAttribute('src',c.toDataURL('image/png'));
  }catch(err){ return function(){}; }
  return function(){ img.setAttribute('src',src); };
}
var readyFile=null;
function saveFile(blob,name){
  var url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); },60000);
}
async function savePdf(){
  var btn=document.getElementById('save-pdf'), note=document.getElementById('bar-note'), label=btn.textContent;
  if(readyFile){                                                   // second tap: the share sheet, on a fresh gesture
    try{ await navigator.share({files:[readyFile],title:readyFile.name}); }
    catch(err){ if(err&&err.name!=='AbortError') saveFile(readyFile,readyFile.name); }
    return;
  }
  btn.disabled=true; btn.textContent='Preparing…';
  var doc=document.getElementById('doc'), wrap=document.getElementById('docwrap');
  var tf=doc.style.transform, ml=doc.style.marginLeft, wh=wrap.style.height, restoreLogo=null;
  try{
    if(!window.html2canvas) await loadOnce('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
    if(!window.jspdf) await loadOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    doc.style.transform=''; doc.style.marginLeft=''; wrap.style.height='';   // capture the paper at full size
    var restoreLogo=await flattenLogo();
    var sheets=[].slice.call(document.querySelectorAll('.sheet'));
    var pdf=new window.jspdf.jsPDF({unit:'mm',format:'a4',orientation:'portrait',compress:true});
    for(var i=0;i<sheets.length;i++){
      btn.textContent='Page '+(i+1)+' of '+sheets.length+'…';
      var canvas=await window.html2canvas(sheets[i],{scale:2,backgroundColor:'#ffffff',useCORS:true,logging:false,
        width:sheets[i].offsetWidth,height:sheets[i].offsetHeight,windowWidth:sheets[i].offsetWidth});
      if(i) pdf.addPage();
      pdf.addImage(canvas.toDataURL('image/jpeg',0.9),'JPEG',0,0,210,297,undefined,'FAST');
      canvas.width=canvas.height=0;                                          // let the phone reclaim it
    }
    var name=reportFileName(), blob=pdf.output('blob');
    var file=new File([blob],name,{type:'application/pdf'});
    // iOS only opens the share sheet from a fresh tap, and building the file takes a few
    // seconds — so the finished file waits behind a second tap instead of being refused.
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      readyFile=file;
      label='Share / save file · '+Math.max(1,Math.round(blob.size/104857.6)/10)+' MB';
      note.textContent='The report is ready. Tap “Share / save file” to save it to Files, send it, or print it.';
    }else{
      saveFile(blob,name);
    }
  }catch(err){
    if(!err||err.name!=='AbortError') note.textContent='Could not build the PDF: '+((err&&err.message)||'unknown error')+'. Try Print instead.';
  }finally{
    if(typeof restoreLogo==='function') restoreLogo();
    doc.style.transform=tf; doc.style.marginLeft=ml; wrap.style.height=wh;
    btn.disabled=false; btn.textContent=label;
  }
}
(function(){
  var flow=document.getElementById('flow'), holder=document.getElementById('sheets');
  var sheets=[];
  function sheet(){
    var s=document.createElement('section');
    s.className='sheet';
    s.innerHTML='<div class="body"></div><div class="foot"><span>Facility Experience Quality Assurance</span><span class="pno"></span></div>';
    holder.appendChild(s); sheets.push(s);
    return s;
  }
  /** One touchpoint, one sheet: a section is never split, so it is fitted to the page instead. */
  function used(body){
    var box=body.getBoundingClientRect(), last=body.lastElementChild;
    return last?last.getBoundingClientRect().bottom-box.top:0;
  }
  function free(body){ return body.getBoundingClientRect().height-used(body); }
  // Every touchpoint page uses the same row height and type; only the photo gallery under
  // the table changes size, taking the paper that is left.
  var MM=3.78, GAP=8, CAP=16;                                     // gap between tiles, caption height (px)
  function sizeGallery(body,gal){
    var grid=gal.querySelector('.gal-grid'), n=grid.children.length;
    if(!n) return true;
    var W=grid.getBoundingClientRect().width;
    gal.style.setProperty('--gcols','1'); gal.style.setProperty('--gw','20mm');
    var room=free(body)+grid.getBoundingClientRect().height;        // what the grid may occupy
    var best=null;
    for(var cols=1;cols<=8;cols++){
      var w=Math.min(58*MM,(W-GAP*(cols-1))/cols);                  // a lone photo stays a sensible size
      if(w<18*MM) break;
      var rows=Math.ceil(n/cols), h=rows*(w*0.75+CAP)+(rows-1)*GAP;
      if(h<=room-6&&(!best||w>best.w)) best={cols:cols,w:w};
    }
    if(!best){ var c=Math.max(1,Math.floor((W+GAP)/(18*MM+GAP))); best={cols:c,w:18*MM}; }
    gal.style.setProperty('--gcols',String(best.cols));
    gal.style.setProperty('--gw',best.w+'px');
    for(var k=0;k<12&&free(body)<4;k++){                          // measured, not assumed
      best.w-=3; if(best.w<14*MM) break;
      gal.style.setProperty('--gw',best.w+'px');
    }
    return free(body)>=4;
  }
  function fitToPage(sh){
    var body=sh.querySelector('.body'), card=body.firstElementChild;
    var gal=body.querySelector('.gallery');
    if(gal) gal.style.setProperty('--gw','20mm');
    for(var mm=15;mm>=11;mm--){                                   // rows give way only if the page is truly full
      sh.style.setProperty('--rowh',mm+'mm');
      if(gal?sizeGallery(body,gal):free(body)>=4){ sh.classList.add('settled'); return true; }
    }
    if(!card) return false;
    // Nothing split and nothing lost: an over-full page is scaled to the paper as a whole.
    card.style.transformOrigin='top left'; card.style.transform='';
    var k=1;
    for(var p=0;p<5;p++){
      card.style.width=(100/k)+'%';
      var nk=Math.min(1,(body.getBoundingClientRect().height-4)/used(body));
      if(Math.abs(nk-k)<0.004){ k=nk; break; }
      k=nk;
    }
    card.style.width=(100/k)+'%';
    card.style.transform='scale('+k+')';
    return false;
  }
  function start(){
    var blocks=[].slice.call(flow.children).filter(function(b){ return !b.hasAttribute('data-sign'); });
    var sign=flow.querySelector('[data-sign]');
    blocks.forEach(function(b,idx){
      var sh=sheet(), body=sh.querySelector('.body');
      body.appendChild(b);
      var last=idx===blocks.length-1;
      if(last&&sign) body.appendChild(sign);                        // the signatures share the last page
      if(!fitToPage(sh)&&last&&sign){                               // unless that page is already full
        body.removeChild(sign);
        fitToPage(sh);
        sheet().querySelector('.body').appendChild(sign);
      }
    });
    if(sign&&!sign.parentNode) sheet().querySelector('.body').appendChild(sign);
    if(!blocks.length&&sign) sheet().querySelector('.body').appendChild(sign);
    flow.parentNode.removeChild(flow);
    var total=sheets.length+1;                                     // the cover counts too
    [].forEach.call(document.querySelectorAll('.pno'),function(el,i){ el.textContent='Page '+(i+1)+' of '+total; });
    fit();
    if(DOC.autoPrint) setTimeout(function(){ window.print(); },250);
  }
  // A phone cannot show 210mm at full size: the paper is scaled to the screen, not reflowed.
  var doc=document.getElementById('doc'), wrap=document.getElementById('docwrap');
  function fit(){
    var avail=document.documentElement.clientWidth-10, w=doc.offsetWidth;
    var z=Math.min(1,avail/w);
    if(z<1){
      doc.style.transform='scale('+z+')';
      doc.style.marginLeft=Math.max(0,(avail-w*z)/2)+'px';
      wrap.style.height=Math.ceil(doc.offsetHeight*z)+'px';
    }else{
      doc.style.transform=''; doc.style.marginLeft=''; wrap.style.height='';
    }
  }
  window.addEventListener('resize',fit);
  window.addEventListener('beforeprint',function(){ doc.style.transform=''; doc.style.marginLeft=''; wrap.style.height=''; });
  window.addEventListener('afterprint',fit);
  // Pages are measured only once the web font and the photos are in — measuring before
  // that is what used to push a row over the footer.
  document.getElementById('save-pdf').addEventListener('click',savePdf);
  function ready(){ (document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){ setTimeout(start,30); }); }
  if(document.readyState==='complete') ready(); else window.addEventListener('load',ready);
})();
// Print, and Close (or Back to the app, when the document took over the app's own tab)
[].forEach.call(document.querySelectorAll('[data-doc]'),function(b){
  b.addEventListener('click',function(){
    var a=b.getAttribute('data-doc');
    if(a==='print') window.print(); else if(a==='back') location.reload(); else if(a==='close') window.close();
  });
});
