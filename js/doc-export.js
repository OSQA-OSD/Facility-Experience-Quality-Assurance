/* An export's own page (the PDF of any view): paginates, repeats table headings, prints and saves the
   PDF. The app writes the document into /report and passes its settings in #doc-config. */
var DOC=JSON.parse(document.getElementById('doc-config').textContent);
var FIRST_HEAD=DOC.firstHead, DOC_NAME=DOC.docName, LEGEND=DOC.legend;
const SRI={'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js':'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H','https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js':'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk'};
function loadOnce(src){
  return new Promise(function(res,rej){
    var s=document.createElement('script');
    s.src=src; s.crossOrigin='anonymous'; if(SRI[src]) s.integrity=SRI[src]; s.onload=res; s.onerror=function(){ rej(new Error('Could not load '+src)); };
    document.head.appendChild(s);
  });
}
/** html2canvas draws an <img> of an SVG badly; the browser itself draws it correctly. */
async function flattenLogo(){
  var imgs=[].slice.call(document.querySelectorAll('.brand img'));
  if(!imgs.length) return function(){};
  var src=imgs[0].getAttribute('src');
  try{
    var im=new Image(); im.decoding='sync'; im.src=src; await im.decode();
    var w=im.naturalWidth||300, h=im.naturalHeight||106, c=document.createElement('canvas');
    c.width=w*3; c.height=h*3;
    c.getContext('2d').drawImage(im,0,0,c.width,c.height);
    var png=c.toDataURL('image/png');
    imgs.forEach(function(i){ i.setAttribute('src',png); });
  }catch(err){ return function(){}; }
  return function(){ imgs.forEach(function(i){ i.setAttribute('src',src); }); };
}
var readyFile=null;
function saveFile(blob,name){
  var url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); },60000);
}
// Safari on iPhone ignores window.print() when the site runs from the Home Screen, and there
// is no share menu there either — so the page builds the PDF itself and hands the file to the
// system share sheet, which can save it to Files, send it, or print it.
async function savePdf(){
  var btn=document.getElementById('save-pdf'), note=document.getElementById('bar-note'), label=btn.textContent;
  if(readyFile){                                                     // second tap: the share sheet, on a fresh gesture
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
    doc.style.transform=''; doc.style.marginLeft=''; wrap.style.height='';     // capture the paper at full size
    restoreLogo=await flattenLogo();
    var sheets=[].slice.call(document.querySelectorAll('.sheet'));
    var pdf=new window.jspdf.jsPDF({unit:'mm',format:'a4',orientation:DOC.orientation,compress:true});
    for(var i=0;i<sheets.length;i++){
      btn.textContent='Page '+(i+1)+' of '+sheets.length+'…';
      var canvas=await window.html2canvas(sheets[i],{scale:2,backgroundColor:'#ffffff',useCORS:true,logging:false,
        width:sheets[i].offsetWidth,height:sheets[i].offsetHeight,windowWidth:sheets[i].offsetWidth});
      if(i) pdf.addPage();
      pdf.addImage(canvas.toDataURL('image/jpeg',0.9),'JPEG',0,0,DOC.pageW,DOC.pageH,undefined,'FAST');
      canvas.width=canvas.height=0;                                            // let the phone reclaim it
    }
    var blob=pdf.output('blob'), file=new File([blob],DOC_NAME,{type:'application/pdf'});
    // iOS only opens the share sheet from a fresh tap, and building the file takes a few
    // seconds — so the finished file waits behind a second tap instead of being refused.
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      readyFile=file;
      label='Share / save file · '+Math.max(1,Math.round(blob.size/104857.6)/10)+' MB';
      note.textContent='The file is ready. Tap “Share / save file” to save it to Files, send it, or print it.';
    }else{
      saveFile(blob,DOC_NAME);
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
  var flow=document.getElementById('flow'), holder=document.getElementById('sheets'), sheets=[], body=null;
  function sheet(first){
    var s=document.createElement('section');
    s.className='sheet';
    s.innerHTML=(first?FIRST_HEAD:'')+'<div class="body"></div><div class="foot"><span>Facility Experience Quality Assurance</span>'+LEGEND+'<span class="pno"></span></div>';
    holder.appendChild(s); sheets.push(s);
    body=s.querySelector('.body');
    return s;
  }
  function used(){ var box=body.getBoundingClientRect(), last=body.lastElementChild; return last?last.getBoundingClientRect().bottom-box.top:0; }
  function over(){ return used()>body.getBoundingClientRect().height-1; }
  /** A table longer than the page runs on: the next page repeats its heading, nothing else. */
  function shell(sec){
    var c=sec.cloneNode(true), tb=c.querySelector('tbody');
    if(tb) tb.innerHTML='';
    return c;
  }
  function start(){
    sheet(true);
    [].slice.call(flow.children).forEach(function(sec){
      if(sec.getAttribute('data-break')==='1'&&body.children.length) sheet(false);
      var tb=sec.querySelector('tbody');
      var rows=tb?[].slice.call(tb.rows):[];
      if(tb) tb.innerHTML='';
      body.appendChild(sec);
      if(over()&&body.children.length>1){ body.removeChild(sec); sheet(false); body.appendChild(sec); }
      var cur=sec, curBody=tb;
      rows.forEach(function(r){
        curBody.appendChild(r);
        if(over()&&curBody.rows.length>1){                            // a row never straddles two pages
          curBody.removeChild(r);
          sheet(false);
          cur=shell(cur); body.appendChild(cur);
          curBody=cur.querySelector('tbody');
          curBody.appendChild(r);
        }
      });
    });
    flow.parentNode.removeChild(flow);
    [].forEach.call(document.querySelectorAll('.pno'),function(el,i){ el.textContent='Page '+(i+1)+' of '+sheets.length; });
    fit();
  }
  // A phone cannot show a whole sheet at full size: the paper is scaled to the screen, not reflowed.
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
  document.getElementById('save-pdf').addEventListener('click',savePdf);
  // Pages are measured only once the web font and the pictures are in.
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
