(function(){
  var done=false, msg=document.getElementById('msg');
  window.addEventListener('message',function(e){
    if(done||e.origin!==location.origin) return;
    var d=e.data||{};
    if(d.type==='qa-report'&&typeof d.html==='string'){
      done=true;
      document.open(); document.write(d.html); document.close();
    }
  });
  function host(){ return window.opener||(window.parent!==window?window.parent:null); }
  function ask(){
    var h=host();
    if(done||!h) return;
    try{ h.postMessage({type:'qa-report-ready'},location.origin); }catch(err){}
  }
  ask();
  var poll=setInterval(function(){ done?clearInterval(poll):ask(); },250);
  setTimeout(function(){
    clearInterval(poll);
    if(!done){
      document.querySelector('.dot').style.display='none';
      msg.textContent=host()?'The document did not arrive. Close this tab and try again.'
        :'Open this page from the app — a report from Assessment Reports, or Export on any page.';
    }
  },30000);
})();
