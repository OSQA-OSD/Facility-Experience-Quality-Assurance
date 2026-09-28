/* Inside the sandboxed converter frame (/heic.html): converts one HEIC photo at a time to JPEG.
   Requests arrive from the app (the parent window) with a private reply channel; nothing else is
   listened to. */
(function(){
  var SRC='https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
  var SRI='sha384-OTofQ0MEeiSgh62havBcemCIK0gqj809wX6UA0uPISNMRnR6NZyCdGzX3SbLrgwL';
  var loading=null;
  function converter(){
    if(window.heic2any) return Promise.resolve(window.heic2any);
    if(!loading){
      loading=new Promise(function(resolve,reject){
        var s=document.createElement('script');
        s.src=SRC; s.integrity=SRI; s.crossOrigin='anonymous';
        s.onload=function(){ window.heic2any?resolve(window.heic2any):reject(new Error('converter unavailable')); };
        s.onerror=function(){ reject(new Error('converter could not be downloaded')); };
        document.head.appendChild(s);
      }).catch(function(err){ loading=null; throw err; });
    }
    return loading;
  }
  window.addEventListener('message',function(e){
    if(e.source!==window.parent) return;
    var d=e.data||{}, port=e.ports&&e.ports[0];
    if(d.type!=='heic'||!port||!(d.bytes instanceof ArrayBuffer)) return;
    converter()
      .then(function(heic2any){ return heic2any({blob:new Blob([d.bytes],{type:'image/heic'}),toType:'image/jpeg',quality:0.9}); })
      .then(function(out){ return (Array.isArray(out)?out[0]:out).arrayBuffer(); })
      .then(function(bytes){ port.postMessage({ok:true,bytes:bytes},[bytes]); })
      .catch(function(err){ port.postMessage({ok:false,error:String((err&&err.message)||err||'conversion failed')}); })
      .then(function(){ port.close(); });
  });
  window.parent.postMessage({type:'heic-ready'},'*');     // carries nothing but "ready"
})();
