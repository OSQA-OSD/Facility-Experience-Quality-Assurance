/* Two libraries come from a CDN. If one cannot be reached — a weak signal in a plant room, a blocked
   domain — the app must still open and work: icons simply stay blank and charts stay empty. */
window.__cdnMissing=[];
if(!window.lucide){ window.__cdnMissing.push('icons'); window.lucide={createIcons:function(){}}; }
if(!window.Chart){
  window.__cdnMissing.push('charts');
  window.Chart=function(){ this.canvas=null; this.destroy=this.update=this.resize=function(){}; };
}

// ═══════════════════════════════════════════════════════════
// API CONFIG  (Cloudflare D1 via same-origin Worker)
// ═══════════════════════════════════════════════════════════
const API_BASE = '/api';

async function apiFetch(method, path, body){
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if(body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  if(!res.ok){
    const raw = await res.text();
    let data = null;
    try{ data = JSON.parse(raw); }catch(_){}
    const err = new Error((data && data.error) || raw || ('HTTP ' + res.status));
    err.status = res.status; err.data = data;
    throw err;
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

// ═══════════════════════════════════════════════════════════
// SECTION DEFINITIONS
// scoringMode: '01' = 0/1  |  '02' = 0/2
// ═══════════════════════════════════════════════════════════
const SECTIONS=[
  {id:'s0',lucide:'car',title:'Arrival & Parking',max:10,scoringMode:'01',
   items:['Directional signage (availability & condition)','Parking surface condition (no cracks, potholes, or oil spills)','Availability of handicap parking','Availability of accessibility ramps','Parking bumpers condition','Parking shade condition','Street/parking paint condition','Curbs, pathways & pavements condition','Clear crossways','Garbage cans (availability & condition)']},
  {id:'s1',lucide:'tree-deciduous',title:'Landscape',max:10,scoringMode:'01',
   items:['Availability','Landscape design & visual quality','Plant health and condition','Accessibility & user experience','Safety & risk management','Maintenance','General cleanliness','Curbs, pathways & pavements condition','Odor-free environment','No water pooling or runoff']},
  {id:'s2',lucide:'door-open',title:'Entrance & Lobby',max:10,scoringMode:'01',
   items:['Cleanliness of floors, walls, and glass','Accessible entry points','Comfortable temperature and ventilation','Clear internal wayfinding signage','Lighting condition','General interior condition','Available seating area','Seating area condition','Skylight or ceiling condition','Building Services contact number displayed']},
  {id:'s3',lucide:'utensils',title:'Food & Concession',max:10,scoringMode:'02',
   items:['Availability of food and beverages at all times','Food quality, safety, and hygiene','Equipment safety and compliance','Payment systems are operational','Accessibility of the location']},
  {id:'s4',lucide:'arrow-up-down',title:'Elevators & Corridors',max:10,scoringMode:'01',
   items:['Elevators are operational and reliable','Elevator interiors are clean','Corridors are unobstructed','Adequate corridor lighting','Clear directional and floor signage','Functional emergency lighting','Emergency evacuation plan displayed','Ceiling, window, and glass panel condition','Indoor plants availability & condition','Staircase condition']},
  {id:'s5',lucide:'briefcase',title:'Workspaces',max:10,scoringMode:'01',
   items:['General office condition','Work areas are clean and organized','Waste bins and recycling stations are available','Lighting suitable for work tasks','Indoor air quality & temperature are acceptable','Electrical equipment safety & cable management','Floor & carpet condition','Emergency exit accessibility','Fire extinguishers & safety signs present','Meeting room AV equipment is functional with adequate seating']},
  {id:'s6',lucide:'shield-check',title:'Health, Safety & Emergency Readiness',max:10,scoringMode:'01',
   items:['Fire extinguishers available & inspected','First aid kits stocked','Electrical equipment safety','Power outlets are covered and secure','List of floor wardens displayed','AED machine available, visible, and functional','Emergency exits are visible & unobstructed','Emergency contact numbers are visible and displayed','Evacuation plans displayed','Caution signs present where needed']},
  {id:'s7',lucide:'droplets',title:'Washrooms / Bathrooms',max:10,scoringMode:'01',
   items:['General cleanliness maintained','Cleaning schedule/log available and up to date','No unpleasant odors','Soap, tissue, and sanitizer available','Hand dryers / paper towels available and working','Floors are dry and non-slip','Plumbing is in good condition (no leaks or corrosion)','Color-coding protocol followed','Cleaning procedure followed','Ventilation is functional']},
  {id:'s8',lucide:'wrench',title:'Maintenance',max:10,scoringMode:'01',
   items:['Building façade condition (no cracks, holes, or fading)','Wall condition (no cracks, fading, or stains)','Floor condition (tiles, carpet, or ceramic)','Ceiling condition (no cracks or damaged tiles)','Lighting condition (bulbs, spotlights, and emergency lights)','Electrical outlets & switches condition','Door condition (hinges, locks, and alignment)','Window condition','Glass panel condition','Fire control panel in normal operating state']},
  {id:'s9',lucide:'clipboard-list',title:'Miscellaneous',max:10,scoringMode:'02',
   items:['Janitorial staff appearance & hygiene','Building Services staff helpfulness','Musalla availability and condition','Break room / coffee area condition','Storage areas are organized and in good condition']},
];

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
// Inspections are recorded under the signed-in account's name (or, while editing, the name the report was saved under).
let inspectors = [];

let activeInspector = '';
let history = []; // loaded from the database
let allState = {};
let currentReportSaved = false;
let lastSubmitted = null, saveBusy = false; // the report this form was submitted as (later saves update it); a save in progress
let notifCursor = null, notifTimer = null, notifBusy = false; // live notifications
let editingRecordId = null;
// Declared up here (not next to the /api/auth/me call) because pageAllowed() reads it during
// the initial deep-link routing, which runs before the end of the script.
let currentUser = null;
const ASSIGNEE_ROLES = ['quality_auditor','quality_officer','quality_admin']; // roles that can hold buildings
let ovData = null, ovChart = null, ovReady = false; // Team Overview state
let auData = null, auReady = false, auReq = 0, auId = null, auCharts = {}, auFilter = {status:'todo', type:'all'}; // Auditor profile state
let inBuildings = null, inReady = false, inAssignCache = {}; // Inspection details state
let adUsers = [], adReady = false, adTab = 'users', adRoleDefaults = null, adBuildings = null, adEditingBuilding = null, adAudit = [], adAuditMore = false, adOpenUserId = null, adUserFilter = 'all', adAuditFilter = 'all', lastSection = 'pg-s0'; // Admin Control state; last opened inspection section
let schData = null, schReady = false, schReq = 0, schView = null;   // Quarter schedule state
let ofQuick = '';                                                   // quick assign: the auditor a tap gives a building to
let ofData = null, ofView = null, ofReady = false, ofReq = 0, ofPrevDone = null, ofPrevKey = '', ofSelected = new Set(), ofRowsStale = false; // Assign & Track state
let libReady = false, libReq = 0, libRows = [], libData = null, libStatus = '', libPending = {}, libTimer = null, rvId = null, rvData = null; // Inspection Reports
let cxReady = false, cx = null, cxView = null, cxChart = null; // Custom Report
let rpTab = 'insights', insReady = false, insSavedQuarter = null, insSavedDivision = '', insHeatData = null, cmpReady = false, cmpDim = 'division', cmpMode = 'quarter', cmpRows = null, cmpView = null, insView = null, rpView = null, dqReady = false, dqIssues = null, dqView = null, rpSavedList = [], rpSavedReady = false; // Reports tabs
let exCtx = null, exModel = null, exFmt = 'pdf', exPicks = {}; // Export dialog
let rpData = null, rpReady = false, rpCharts = {}, rpShown = 100, rpGroup = 'division', rpMetric = 'avg', rpTrend = 'quarter'; // Reports state
const RP_FILTER_IDS = ['rp-year','rp-month','rp-quarter','rp-type','rp-division','rp-area','rp-building','rp-inspector','rp-rating','rp-from','rp-to','rp-search'];
// The five rating bands, in the brand's colours — one definition behind every dot,
// pill, bar and cell in the system. `fill` is the brand colour; `ink` is that same hue
// darkened until it reads as text on white (≥4.5:1); `on` is what reads on top of the
// fill; `soft` is the tint a score pill sits on.
const BANDS = {
  Excellent:  {range:'91–100', fill:'#00843D', ink:'#007A38', on:'#FFFFFF', soft:'#DBEEE4', note:'Exceeds international best practices'},
  Good:       {range:'81–90',  fill:'#84BD00', ink:'#557A00', on:'#1C2433', soft:'#EEF6DB', note:'Fully compliant, minor optimization possible'},
  Acceptable: {range:'71–80',  fill:'#0033A0', ink:'#0033A0', on:'#FFFFFF', soft:'#DBE2F2', note:'Minimum compliance met'},
  Poor:       {range:'51–70',  fill:'#FFC846', ink:'#966900', on:'#1C2433', soft:'#FFF7E5', note:'Partial compliance, corrective action needed'},
  Critical:   {range:'0–50',   fill:'#F05F41', ink:'#CB3010', on:'#1C2433', soft:'#FDE9E4', note:'Non-compliant, immediate action required'},
};
const RP_BANDS = Object.keys(BANDS);
const BAND_KEY = {Excellent:'exc',Good:'good',Acceptable:'acc',Poor:'poor',Critical:'crit'};
const RP_BAND_COLOR = Object.fromEntries(RP_BANDS.map(b=>[b,BANDS[b].fill]));
const RP_GROUPS = {
  division: {label:'Division', key:x=>x.division||'Unknown division',
    drill:k=>{ document.getElementById('rp-division').value=k; rpGroup='area'; }},
  area:     {label:'Area', key:x=>x.area||'Unknown area', sub:x=>x.division||'',
    drill:k=>{ document.getElementById('rp-area').value=k; rpGroup='building'; }},
  building: {label:'Building', key:x=>x.building||'Unknown building', sub:x=>[x.division,x.area].filter(Boolean).join(' · '),
    drill:k=>{ document.getElementById('rp-building').value=k; }},
  quarter:  {label:'Quarter', time:true, key:x=>x.quarter||'No date'},
  month:    {label:'Month', time:true, key:x=>(x.date||'').slice(0,7)||'No date'},
  inspector:{label:'Auditor', key:x=>x.inspector||'Unknown',
    drill:k=>{ document.getElementById('rp-inspector').value=k; }},
  type:     {label:'Type', key:x=>x.type||'Unknown',
    drill:k=>{ document.getElementById('rp-type').value=k; }},
};
let currentAssignmentId = null; // set when an inspection is started from "My Assignments"
let saveChoiceMode = 'update';
let dbOnline = false;

function getState(insp){
  if(!allState[insp]) allState[insp]={
    scores:  SECTIONS.map(s=>s.items.map(()=>null)),
    comments:SECTIONS.map(s=>s.items.map(()=>'')),
    photos:  SECTIONS.map(s=>s.items.map(()=>[])),
    notes:   SECTIONS.map(()=>''),
  };
  return allState[insp];
}
function curState(){ return getState(activeInspector); }

// ═══════════════════════════════════════════════════════════
// LOADING OVERLAY
// ═══════════════════════════════════════════════════════════
function showOverlay(msg){ 
  document.getElementById('co-msg').textContent=msg||'Loading…';
  document.getElementById('cloud-overlay').classList.add('show');
}
function hideOverlay(){ document.getElementById('cloud-overlay').classList.remove('show'); }

function setSyncChip(state, msg){
  const chip=document.getElementById('sync-chip');
  const dot=document.getElementById('conn-dot');
  chip.className='';chip.id='sync-chip';
  const both=(icon,full,short)=>`<span class="sc-full">${icon} ${ovEsc(full)}</span><span class="sc-short">${icon} ${ovEsc(short)}</span>`;
  chip.title=msg;
  if(state==='ok'){    chip.classList.add('ok');   chip.innerHTML=both('&#10003;',msg,'Online'); dot.className='online'; dbOnline=true; }
  if(state==='sync'){  chip.classList.add('syncing'); chip.innerHTML=both('&#8635;',msg,String(msg).split(/[ …]/)[0]+'…'); dot.className=''; dbOnline=true; }
  if(state==='err'){   chip.classList.add('err');  chip.innerHTML=both('&#9888;',msg,'Offline'); dot.className='offline'; dbOnline=false; }
}

// ═══════════════════════════════════════════════════════════
// DATABASE CRUD
// ═══════════════════════════════════════════════════════════
async function dbInsert(record){
  return apiFetch('POST', '/inspections', record);
}

async function dbUpdate(record){
  await apiFetch('PATCH', '/inspections/' + record.id, record);
}

async function dbDelete(id){
  await apiFetch('DELETE', '/inspections/' + id, null);
}


// ═══════════════════════════════════════════════════════════
// SPELL CHECK
// ═══════════════════════════════════════════════════════════
const DOMAIN_WORDS=new Set(['aed','hvac','cctv','wifi','wi-fi','av','osd','boqi','eoqi','caosd','nposd','oosd','saosd','naosd','ryosd','musalla','janitorial','wayfinding','signage','anti-slip','non-slip','extinguisher','extinguishers','warden','wardens','accessibility','concession','facade','corrosion','evacuation','sanitizer','duct','conduit']);
const spellIssues={};
function checkSpell(val,si,ii,el){
  const key=`${si}-${ii}`;
  const words=val.trim().split(/\s+/);
  let bad=false;
  words.forEach(raw=>{
    const w=raw.replace(/[^a-zA-Z'-]/g,'').toLowerCase();
    if(w.length<3||DOMAIN_WORDS.has(w)) return;
    if(/(.)\1{2,}/.test(w)){bad=true;spellIssues[key]={word:raw,si,ii,el};}
  });
  if(!bad) delete spellIssues[key];
  el.classList.toggle('has-error',bad);
  renderSpellBanner();
}
function renderSpellBanner(){
  const issues=Object.values(spellIssues);
  const banner=document.getElementById('spell-banner');
  const cont=document.getElementById('spell-issues');
  if(!issues.length){banner.classList.remove('show');return;}
  banner.classList.add('show');cont.innerHTML='';
  issues.slice(0,6).forEach(issue=>{
    const chip=document.createElement('span');chip.className='spell-issue';
    chip.textContent='"'+issue.word+'" (S'+(issue.si+1)+' #'+(issue.ii+1)+')';
    chip.onclick=()=>{nav('pg-s'+issue.si);setTimeout(()=>{const e=document.getElementById('cmt-'+issue.si+'-'+issue.ii);if(e){e.focus();e.select();}},300);};
    cont.appendChild(chip);
  });
}
function dismissSpell(){
  Object.keys(spellIssues).forEach(k=>delete spellIssues[k]);
  document.querySelectorAll('.has-error').forEach(e=>e.classList.remove('has-error'));
  document.getElementById('spell-banner').classList.remove('show');
}

// ═══════════════════════════════════════════════════════════
// BUILD SECTIONS
// ═══════════════════════════════════════════════════════════
/** EOQI is a compliance check, so its two answers read as words; every other type just scores. */
function applyScoreWording(){
  const eoqi=document.getElementById('meta-type').value==='EOQI';
  document.documentElement.dataset.itype=eoqi?'EOQI':'score';
  document.querySelectorAll('#insp-layout .sb[data-val]').forEach(b=>{
    const v=b.dataset.val;
    b.title=eoqi?(v==='0'?'Not compliant (0)':`Compliant (${v})`):`Score ${v}`;
  });
  document.querySelectorAll('.cmt-wrap input').forEach(i=>{
    i.placeholder=eoqi?'Comment — required if not compliant':'Comment — required if scored 0';
  });
  document.querySelectorAll('.cmt-required-hint').forEach(h=>{
    h.textContent=eoqi?'A comment is required when an item is not compliant.':'A comment is required when an item scores 0.';
  });
}
function buildSections(){
  const cont=document.getElementById('secs-container');
  document.getElementById('ss-list').innerHTML=SECTIONS.map((sec,si)=>`
    <button class="ss-item" data-sec="${si}" data-click="nav" data-to="pg-s${si}">
      <span class="ss-dot" id="ssd-${si}"></span>
      <div><b>${sec.title}</b><small id="ns-${si}">0/${sec.items.length} answered</small></div>
      <em id="nss-${si}">–</em>
    </button>`).join('');
  SECTIONS.forEach((sec,si)=>{
    const hi=sec.scoringMode==='02'?2:1, last=si===SECTIONS.length-1;
    const pg=document.createElement('div');
    pg.className='page sp';pg.id='pg-s'+si;
    pg.innerHTML=`
      <div class="sp-head">
        <div class="si-icon"><svg data-lucide="${sec.lucide}" width="22" height="22"></svg></div>
        <div class="sp-title"><small>Section ${si+1} of ${SECTIONS.length}</small><h2>${sec.title}</h2>
          <div class="sdesc">${sec.items.length} items · each scored 0 or ${hi} · a 0 needs a comment</div></div>
        <div class="sp-score"><b id="badge-${si}">–</b><span> / ${sec.max}</span>
          <div class="ov-bar"><i id="sbar-${si}" style="width:0%"></i></div><small id="scount-${si}">0 of ${sec.items.length} answered</small></div>
      </div>
      <div class="val-alert" id="val-${si}"></div>
      <div class="cl" id="cl-${si}"></div>
      <div class="sn"><label for="snote-${si}"><svg data-lucide="notebook-pen" width="13" height="13"></svg> Section notes <small>optional</small></label>
        <textarea id="snote-${si}" placeholder="Anything worth noting about this section as a whole…" data-input="sectionNote" data-si="${si}"></textarea>
      </div>
      <div class="sp-foot">
        ${si>0?`<button class="btn bo" data-click="nav" data-to="pg-s${si-1}"><svg data-lucide="arrow-left" width="14" height="14"></svg><span>Previous</span></button>`
          :`<button class="btn bo" data-click="nav" data-to="pg-new"><svg data-lucide="arrow-left" width="14" height="14"></svg><span>Details</span></button>`}
        <span class="sp-foot-count" id="fcount-${si}">0 of ${sec.items.length} answered</span>
        <button class="btn bt" id="next-btn-${si}" data-click="tryNext" data-si="${si}"><span>${last?'Review score card':'Next: '+SECTIONS[si+1].title}</span><svg data-lucide="arrow-right" width="14" height="14"></svg></button>
      </div>`;
    const cl=pg.querySelector(`#cl-${si}`);
    sec.items.forEach((item,ii)=>{
      const card=document.createElement('div');
      card.className='ci';card.id=`ci-${si}-${ii}`;
      card.innerHTML=`
        <div class="ci-head">
          <div class="in">${ii+1}</div><div class="il">${item}</div>
          <div class="ss" role="group" aria-label="Score for item ${ii+1}">
            <button class="sb" id="sb-${si}-${ii}-0" data-val="0" data-click="setScore" data-si="${si}" data-ii="${ii}"><svg data-lucide="x" width="15" height="15"></svg><span class="sb-w">Not compliant</span><em>0</em></button>
            <button class="sb" id="sb-${si}-${ii}-${hi}" data-val="${hi}" data-click="setScore" data-si="${si}" data-ii="${ii}"><svg data-lucide="check" width="15" height="15"></svg><span class="sb-w">Compliant</span><em>${hi}</em></button>
          </div>
        </div>
        <div class="ci-body">
          <div class="cmt-wrap">
            <input type="text" id="cmt-${si}-${ii}" placeholder="Comment — required if not compliant" spellcheck="true"
              data-input="itemComment" data-si="${si}" data-ii="${ii}">
            <div class="cmt-required-hint" id="hint-${si}-${ii}">A comment is required when an item is not compliant.</div>
          </div>
          <div class="photo-btns">
            <label class="ph-btn" title="Add photos from the library">
              <svg data-lucide="image-plus" width="14" height="14"></svg> Photo
              <input type="file" accept="image/*,.heic,.heif" multiple data-change="addPhotos" data-si="${si}" data-ii="${ii}">
            </label>
            <label class="ph-btn ph-cam" title="Take a photo with the camera">
              <svg data-lucide="camera" width="14" height="14"></svg> Camera
              <input type="file" accept="image/*,.heic,.heif" capture="environment" data-change="addPhotos" data-si="${si}" data-ii="${ii}">
            </label>
          </div>
        </div>
        <div class="ph-thumbs" id="ph-${si}-${ii}"></div>`;
      cl.appendChild(card);
    });
    cont.appendChild(pg);
  });
}

// ═══════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════
function validateSection(si){
  const sec=SECTIONS[si];const st=curState();const errors=[];
  sec.items.forEach((item,ii)=>{
    const score=st.scores[si][ii];
    if(score===null) errors.push({ii,type:'missing',label:item});
    else if(score===0&&!st.comments[si][ii].trim()) errors.push({ii,type:'comment',label:item});
  });
  return errors;
}
function tryNext(si){
  const errors=validateSection(si);
  const alert=document.getElementById(`val-${si}`);
  if(errors.length===0){ alert.classList.remove('show'); nav(si<SECTIONS.length-1?'pg-s'+(si+1):'pg-scorecard'); return; }
  let html='<strong>Please complete the following before proceeding:</strong><ul>';
  errors.forEach(e=>{
    html+=`<li data-click="focusItem" data-si="${si}" data-ii="${e.ii}">${e.type==='missing'?'Score not selected':'Comment required for score 0'} — Item ${e.ii+1}: "${e.label}"</li>`;
  });
  html+='</ul>';
  alert.innerHTML=html.replace('Please complete the following before proceeding:',`${errors.length} item${errors.length===1?' needs':'s need'} attention before you continue:`);alert.classList.add('show');
  alert.scrollIntoView({behavior:'smooth',block:'nearest'});
  SECTIONS[si].items.forEach((_,ii)=>{
    const ciEl=document.getElementById(`ci-${si}-${ii}`);if(!ciEl) return;
    const score=curState().scores[si][ii];
    ciEl.classList.toggle('needs-comment',(score===null)||(score===0&&!curState().comments[si][ii].trim()));
  });
}
function focusItem(si,ii){
  const el=document.getElementById(`cmt-${si}-${ii}`);
  if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.focus();}
}
function updateCommentHint(si,ii){
  const score=curState().scores[si][ii];
  const comment=curState().comments[si][ii]||'';
  const hint=document.getElementById(`hint-${si}-${ii}`);
  const ciEl=document.getElementById(`ci-${si}-${ii}`);
  const need=(score===0&&!comment.trim());
  if(hint) hint.classList.toggle('show',need);
  if(ciEl) ciEl.classList.toggle('needs-comment',need);
}

// ═══════════════════════════════════════════════════════════
// NAVIGATION
// Each section has its own URL (#pg-home, #pg-s0, #pg-scorecard...)
// so a page can be bookmarked, shared, or restored with the browser's
// back/forward buttons.
// ═══════════════════════════════════════════════════════════
const VALID_PAGES=new Set(['pg-home','pg-new','pg-s0','pg-s1','pg-s2','pg-s3','pg-s4','pg-s5','pg-s6','pg-s7','pg-s8','pg-s9','pg-scorecard','pg-auditor','pg-overview','pg-reports','pg-officer','pg-admin','pg-library','pg-schedule']);
function hashToPage(hash){
  const id=(hash||'').replace(/^#/,'').split('/')[0];
  if(id==='pg-assignments') return 'pg-auditor';   // older notification links
  return VALID_PAGES.has(id)?id:'pg-home';
}
/** "#pg-auditor/<id>" → "<id>" (which auditor's profile is open). */
function hashParam(hash){ return (hash||'').replace(/^#/,'').split('/')[1]||null; }
/** The scoring pages: Inspection (pg-new), the ten sections and the score card. Not pg-schedule, which only shares the prefix. */
function isInspectionPage(pageId){ return pageId==='pg-new'||pageId==='pg-scorecard'||/^pg-s\d$/.test(pageId); }
/** Pages this account may not open, so a hand-typed hash can't reach them either. */
function pageAllowed(pageId){
  if(!currentUser) return true;              // permissions not loaded yet
  if(isInspectionPage(pageId)) return hasPerm('inspect');
  if(pageId==='pg-auditor') return !auId||auId===currentUser.id?ASSIGNEE_ROLES.includes(currentUser.role)||hasPerm('profiles'):hasPerm('profiles');
  if(pageId==='pg-overview') return hasPerm('team');
  if(pageId==='pg-officer') return hasPerm('assign');
  if(pageId==='pg-reports') return hasPerm('reports');
  if(pageId==='pg-admin') return currentUser.role==='quality_admin';
  return true;
}

function nav(pageId){
  if(!pageAllowed(pageId)) pageId='pg-home';
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');
  const isSection=/^pg-s\d$/.test(pageId);
  // Grouped entries (Inspection, Team) reopen whichever of their pages was open last.
  const group=navGroupOf(pageId);
  if(group) document.getElementById(group+'-link').dataset.page=pageId;
  if(isSection) lastSection=pageId;
  highlightNav(pageId);
  document.querySelectorAll('.ss-item').forEach(b=>b.classList.toggle('active','pg-s'+b.dataset.sec===pageId));
  document.getElementById('insp-layout').classList.toggle('on',isSection);
  if(pageId==='pg-scorecard') updateScoreCard();
  if(pageId==='pg-home'){loadHome();}
  if(pageId==='pg-new'){renderSpellBanner();inRenderDetails();}
  if(pageId==='pg-auditor') loadAuditorProfile();
  if(pageId==='pg-overview') loadOverview();
  if(pageId==='pg-reports') loadReports();
  if(pageId==='pg-library'){ loadLibrary(); const rid=Number(hashParam(location.hash)); if(rid&&rid!==rvId) openReport(rid,{fromHash:true}); }
  if(pageId==='pg-officer') loadOfficer();
  if(pageId==='pg-schedule') loadSchedule();
  if(pageId==='pg-admin') loadAdmin();
  updateTopBar(pageId);
  if(/^pg-s\d$/.test(pageId)) syncFormToState();
  // pushState rather than location.hash: pages carry the same id as their hash, and assigning the
  // hash would make the browser jump to that element (under the sticky top bar).
  const wanted=pageId==='pg-auditor'&&auId?`pg-auditor/${auId}`:pageId==='pg-admin'&&adTab!=='users'?`pg-admin/${adTab}`:pageId==='pg-reports'&&rpTab!=='insights'?`pg-reports/${rpTab}`:pageId==='pg-library'&&rvId?`pg-library/${rvId}`:pageId;
  if(location.hash!=='#'+wanted) window.history.pushState(null,'','#'+wanted);
  document.getElementById('main').scrollTo(0,0);
}
// On arrival the browser scrolls to the element named in the address — the page itself — and
// WebKit (iPhone, iPad, Safari) does it late, after load, sliding the banner under the top bar.
// Until the person scrolls, taps or types, a freshly opened page stays at its top.
if('scrollRestoration' in history) history.scrollRestoration='manual';
(function holdTopOnArrival(){
  const main=document.getElementById('main'), until=Date.now()+5000;
  let touched=false;
  ['wheel','touchstart','pointerdown','keydown'].forEach(t=>window.addEventListener(t,()=>{ touched=true; },{once:true,passive:true,capture:true}));
  const hold=()=>{
    if(touched||Date.now()>until){ main.removeEventListener('scroll',hold); return; }
    if(main.scrollTop) main.scrollTop=0;
  };
  main.addEventListener('scroll',hold,{passive:true});
  hold();
})();
window.addEventListener('popstate',()=>window.dispatchEvent(new HashChangeEvent('hashchange')));
window.addEventListener('hashchange',()=>{
  const pid=hashToPage(location.hash);
  if(pid==='pg-auditor'&&hashParam(location.hash)!==auId){ auId=hashParam(location.hash); nav(pid); return; }
  if(pid==='pg-admin'&&(hashParam(location.hash)||'users')!==adTab){ adTab=hashParam(location.hash)||'users'; nav(pid); return; }
  if(pid==='pg-library'&&document.getElementById(pid).classList.contains('active')){
    const rid=Number(hashParam(location.hash));
    if(rid&&rid!==rvId) openReport(rid,{fromHash:true}); else if(!rid&&rvId){ document.getElementById('rv-drawer').hidden=true; rvId=null; rvData=null; }
    return;
  }
  if(pid==='pg-reports'&&(hashParam(location.hash)||'insights')!==rpTab){ rpTab=rpTabValid(hashParam(location.hash))?hashParam(location.hash):'insights'; if(document.getElementById(pid).classList.contains('active')){ rpShowTab(); return; } nav(pid); return; }
  if(!document.getElementById(pid).classList.contains('active')) nav(pid);
});

// ── Responsive navigation ─────────────────────────────────
// ≥1200px: full menu (or the icon rail if the person collapsed it). 901–1199px: icon rail unless expanded.
// ≤900px: slide-in panel. The larger-screen choice is remembered in this browser only.
// ═══ Device awareness ═══
// The same app on a phone, a tablet and a desktop: the layout, the menu and the
// controls follow the device in use, and are re-checked when it rotates or resizes.
function deviceProfile(){
  const ua=navigator.userAgent||'';
  const touch=window.matchMedia('(pointer:coarse)').matches||navigator.maxTouchPoints>1;
  const ios=/iPad|iPhone|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1); // an iPad calls itself a Mac
  const shortest=Math.min(screen.width||innerWidth,screen.height||innerHeight);
  return {
    kind:!touch?'desktop':shortest<600?'phone':'tablet',
    touch, ios, android:/Android/i.test(ua),
    standalone:window.matchMedia('(display-mode:standalone)').matches||navigator.standalone===true,
  };
}
let device=deviceProfile();
function applyDevice(){
  device=deviceProfile();
  const r=document.documentElement;
  r.dataset.device=device.kind;
  r.dataset.pointer=device.touch?'touch':'mouse';
  r.dataset.os=device.ios?'ios':device.android?'android':'other';
  r.dataset.display=device.standalone?'standalone':'browser';
  r.dataset.orientation=innerWidth>=innerHeight?'landscape':'portrait';
}
applyDevice();
try{ if(localStorage.getItem('qa-a2hs')==='off') document.documentElement.dataset.a2hs='dismissed'; }catch{}
const drawerQuery=window.matchMedia('(max-width:900px)');
const railQuery=window.matchMedia('(max-width:1199px)');
let navPref=null;
try{ navPref=localStorage.getItem('qa-nav'); }catch{}
function navIcon(name){
  const btn=document.getElementById('nav-btn');
  btn.innerHTML=`<svg data-lucide="${name}" width="18" height="18"></svg>`;
  lucide.createIcons({nodes:[btn]});
}
function applyNavMode(){
  const btn=document.getElementById('nav-btn');
  const sidebar=document.getElementById('sidebar');
  if(drawerQuery.matches){
    document.body.classList.remove('nav-rail');
    const open=document.body.classList.contains('nav-open');
    sidebar.inert=!open;   // a closed panel is off-screen, so keep it out of keyboard and screen-reader reach
    btn.setAttribute('aria-expanded',String(open));
    btn.setAttribute('aria-label',open?'Close menu':'Open menu'); btn.title=btn.getAttribute('aria-label');
    navIcon('menu');
    return;
  }
  document.body.classList.remove('nav-open');
  sidebar.inert=false;
  const rail=navPref?navPref==='rail':(railQuery.matches||device.kind==='tablet');
  document.body.classList.toggle('nav-rail',rail);
  btn.setAttribute('aria-expanded',String(!rail));
  btn.setAttribute('aria-label',rail?'Expand menu':'Collapse menu'); btn.title=btn.getAttribute('aria-label');
  navIcon(rail?'panel-left-open':'panel-left-close');
}
function setDrawer(open){
  document.body.classList.toggle('nav-open',open);
  applyNavMode();
  if(open) document.querySelector('#sb-nav .ni.active,#sb-nav .ni:not([hidden])')?.focus({preventScroll:true});
}
document.getElementById('nav-btn').addEventListener('click',()=>{
  if(drawerQuery.matches){ setDrawer(!document.body.classList.contains('nav-open')); return; }
  navPref=document.body.classList.contains('nav-rail')?'full':'rail';
  try{ localStorage.setItem('qa-nav',navPref); }catch{}
  applyNavMode();
});
document.getElementById('nav-close').addEventListener('click',()=>{ setDrawer(false); document.getElementById('nav-btn').focus(); });
document.getElementById('nav-scrim').addEventListener('click',()=>setDrawer(false));
document.querySelectorAll('#sb-nav .ni').forEach(link=>{
  const label=link.querySelector('.ni-txt')?.textContent.trim();
  if(label){ link.title=label; link.setAttribute('aria-label',label); }
  link.setAttribute('tabindex','0'); link.setAttribute('role','link');
  link.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); link.click(); } });
  link.addEventListener('click',()=>{ if(drawerQuery.matches) setDrawer(false); });
});
window.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&document.body.classList.contains('nav-open')){ setDrawer(false); document.getElementById('nav-btn').focus(); }
});
[drawerQuery,railQuery].forEach(q=>q.addEventListener?q.addEventListener('change',applyNavMode):q.addListener(applyNavMode));
window.addEventListener('orientationchange',()=>{ applyDevice(); applyNavMode(); });
window.addEventListener('resize',()=>{ clearTimeout(window.__devTimer); window.__devTimer=setTimeout(()=>{ applyDevice(); applyNavMode(); },200); });
document.getElementById('dev-tip-x').addEventListener('click',()=>{
  document.documentElement.dataset.a2hs='dismissed';
  try{ localStorage.setItem('qa-a2hs','off'); }catch{}
});
applyNavMode();

// ═══════════════════════════════════════════════════════════
// SYNC FORM ↔ STATE
// ═══════════════════════════════════════════════════════════
function syncFormToState(){
  const st=curState();
  SECTIONS.forEach((sec,si)=>{
    const mode=sec.scoringMode;
    const vals=mode==='02'?[0,2]:[0,1];
    sec.items.forEach((_,ii)=>{
      vals.forEach(v=>{
        const b=document.getElementById(`sb-${si}-${ii}-${v}`);
        if(b){b.classList.remove('s0','s1','s2');if(st.scores[si][ii]===v)b.classList.add('s'+v);}
      });
      const cmt=document.getElementById(`cmt-${si}-${ii}`);
      if(cmt) cmt.value=st.comments[si][ii]||'';
      renderPhotos(si,ii);updateCommentHint(si,ii);
    });
    const nt=document.getElementById(`snote-${si}`);
    if(nt) nt.value=st.notes[si]||'';
    updateSectionBadge(si);
    const va=document.getElementById(`val-${si}`);
    if(va) va.classList.remove('show');
  });
  applyScoreWording();
  updateProgress();updateSidebar();
}

// ═══════════════════════════════════════════════════════════
// SCORING
// ═══════════════════════════════════════════════════════════
function setScore(si,ii,val){
  curState().scores[si][ii]=val;
  currentReportSaved=false;updatePDFButton();
  const mode=SECTIONS[si].scoringMode;
  const vals=mode==='02'?[0,2]:[0,1];
  vals.forEach(v=>{
    const b=document.getElementById(`sb-${si}-${ii}-${v}`);
    if(b){b.classList.remove('s0','s1','s2');if(v===val)b.classList.add('s'+v);}
  });
  updateSectionBadge(si);updateProgress();updateSidebar();updateCommentHint(si,ii);
  if(val!==0){const ci=document.getElementById(`ci-${si}-${ii}`);if(ci)ci.classList.remove('needs-comment');}
}
function getSecScore(si,insp){
  const st=insp?getState(insp):curState();
  const mode=SECTIONS[si].scoringMode;
  const maxPerItem=mode==='02'?2:1;
  let sum=0,answered=0;
  st.scores[si].forEach(v=>{if(v!==null){sum+=v;answered++;}});
  const rawMax=SECTIONS[si].items.length*maxPerItem;
  const normalised=rawMax>0?Math.round((sum/rawMax)*SECTIONS[si].max*10)/10:0;
  return{total:normalised,answered,max:SECTIONS[si].max};
}
function updateSectionBadge(si){
  const{total,answered}=getSecScore(si), n=SECTIONS[si].items.length, full=answered===n;
  const set=(id,fn)=>{ const el=document.getElementById(id); if(el) fn(el); };
  set(`badge-${si}`,el=>el.textContent=answered?total:'–');
  set(`sbar-${si}`,el=>el.style.width=Math.round(answered/n*100)+'%');
  set(`scount-${si}`,el=>el.textContent=`${answered} of ${n} answered`);
  set(`fcount-${si}`,el=>{ el.textContent=full?'Section complete':`${answered} of ${n} answered`; el.classList.toggle('done',full); });
  set(`ns-${si}`,el=>el.textContent=`${answered}/${n} answered`);
  set(`nss-${si}`,el=>el.textContent=answered?total:'–');
  set(`ssd-${si}`,el=>el.className='ss-dot'+(full?' full':answered?' part':''));
  curState().scores[si].forEach((v,ii)=>set(`ci-${si}-${ii}`,el=>{ el.classList.toggle('done-yes',v!==null&&v>0); el.classList.toggle('done-no',v===0); }));
}
function updateProgress(){
  let total=0,answered=0;
  SECTIONS.forEach((_,si)=>{total+=SECTIONS[si].items.length;curState().scores[si].forEach(v=>{if(v!==null)answered++;});});
  const pct=Math.round(answered/total*100);
  document.getElementById('pf').style.width=pct+'%';
  document.getElementById('pp').textContent=pct+'%';
  document.getElementById('ns-progress').textContent=pct+'%';
  updateSteps();
}
/** Hides a sidebar group's label when none of its entries apply to this account. */
function refreshNav(){
  document.querySelectorAll('#sb-nav .nav-group').forEach(g=>{
    g.hidden=false;
    g.hidden=![...g.querySelectorAll('.ni')].some(n=>getComputedStyle(n).display!=='none');
  });
}
/** Sidebar entry for a page. A manager looking at an auditor's profile is still in Team. */
function navLinkFor(pageId){
  if(pageId==='pg-auditor'&&currentUser&&((auId&&auId!==currentUser.id)||document.getElementById('my-assignments-link').hidden)) return document.getElementById('team-link');
  return [...document.querySelectorAll('#sb-nav .ni')].find(n=>n.dataset.page===pageId)||null;
}
function highlightNav(pageId){
  const link=navLinkFor(pageId);
  document.querySelectorAll('#sb-nav .ni').forEach(n=>n.classList.toggle('active',n===link));
}
/** Pages that share one sidebar entry. */
function navGroupOf(pageId){
  if(pageId==='pg-new'||pageId==='pg-scorecard'||/^pg-s\d$/.test(pageId)) return 'inspection';
  if(pageId==='pg-overview'||pageId==='pg-officer') return 'team';
  return null;
}
/** Top bar: where you are (icon, page, sub-page) plus, while inspecting, the three steps. */
function updateTopBar(pageId){
  const group=navGroupOf(pageId);
  const link=navLinkFor(pageId);
  document.getElementById('pb-ic').innerHTML=link?.querySelector('svg')?.outerHTML||'';
  document.getElementById('pb-name').textContent=link?link.querySelector('.ni-txt').textContent:'';
  const sec=/^pg-s(\d)$/.exec(pageId);
  document.getElementById('pb-sub').textContent=
    pageId==='pg-overview'?'Overview':pageId==='pg-officer'?'Assign & Track':pageId==='pg-schedule'?(schData?`${schData.quarter} · ${schData.type}`:''):sec?SECTIONS[+sec[1]].title:
    pageId==='pg-auditor'&&auData&&!auData.isSelf?auData.auditor.name:pageId==='pg-admin'?adTabLabel(adTab):pageId==='pg-reports'?rpTabLabel(rpTab):'';
  const inspecting=group==='inspection';
  document.getElementById('pb-steps').hidden=!inspecting;
  document.getElementById('pb-progress').hidden=!inspecting;
  if(!inspecting) return;
  const stepOf=el=>el.dataset.step==='sections'?!!sec:el.dataset.step===pageId;
  document.querySelectorAll('.pb-step').forEach(el=>el.classList.toggle('active',stepOf(el)));
  updateSteps();
}
function updateSteps(){
  const filled=['meta-facility','meta-type','meta-division'].every(id=>document.getElementById(id).value.trim());
  const st=curState();
  const doneSecs=SECTIONS.filter((_,si)=>st.scores[si].every(v=>v!==null)).length;
  document.getElementById('pb-sec-count').textContent=`${doneSecs}/${SECTIONS.length}`;
  const [details,sections]=document.querySelectorAll('.pb-step');
  details.classList.toggle('done',filled&&!details.classList.contains('active'));
  sections.classList.toggle('done',doneSecs===SECTIONS.length&&!sections.classList.contains('active'));
}
/** Running score at the top of the section list. */
function updateSidebar(){
  let t=0, complete=0, any=false;
  SECTIONS.forEach((sec,si)=>{ const s=getSecScore(si); t+=s.total; if(s.answered) any=true; if(s.answered===sec.items.length) complete++; });
  const o=Math.round(t), g=grade(o), badge=document.getElementById('ss-grade');
  document.getElementById('ss-overall').textContent=any?o:'–';
  // A grade only means something once every section is scored.
  const doneAll=complete===SECTIONS.length;
  badge.textContent=doneAll?g.label:any?'In progress':'Not started';
  badge.style.background=doneAll?g.color:any?'var(--teal)':'';
  document.getElementById('ss-bar').style.width=Math.round(complete/SECTIONS.length*100)+'%';
  document.getElementById('ss-summary').textContent=`${complete} of ${SECTIONS.length} sections complete`;
}
function grade(s){
  const label=s>=91?'Excellent':s>=81?'Good':s>=71?'Acceptable':s>=51?'Poor':'Critical';
  const b=BANDS[label], k=BAND_KEY[label];
  // ink and soft follow the theme (CSS variables with the light colour as fallback, so printed and
  // exported documents, which do not define them, keep the exact band colours)
  return {label,color:b.fill,ink:`var(--band-${k}-ink, ${b.ink})`,on:b.on,soft:`var(--band-${k}-soft, ${b.soft})`,range:b.range,note:b.note};
}

// ═══════════════════════════════════════════════════════════
// SCORECARD
// ═══════════════════════════════════════════════════════════
function updateScoreCard(){
  const st=curState();
  const bands=RP_BANDS.map(l=>[l,BANDS[l].range,BANDS[l].fill,BANDS[l].note,BANDS[l].ink]);
  let grand=0, itemsTotal=0, itemsDone=0, complete=0;
  const secs=SECTIONS.map((sec,si)=>{
    const{total,answered,max}=getSecScore(si);
    grand+=total; itemsTotal+=sec.items.length; itemsDone+=answered;
    if(answered===sec.items.length) complete++;
    return {si,title:sec.title,total,answered,items:sec.items.length,max,pct:Math.round(total/max*100)};
  });
  const overall=Math.round(grand), og=grade(overall), started=itemsDone>0;

  // Header: score ring and the inspection's details
  const ring=document.getElementById('sc-ring');
  ring.style.setProperty('--p',started?overall:0);
  ring.style.setProperty('--c',og.color);
  ring.style.setProperty('--on',og.on);
  document.getElementById('sc-total').textContent=started?overall:'–';
  document.getElementById('sc-grade').textContent=started?og.label:'Not started';
  const tv=document.getElementById('meta-type').value;
  const fields=[['Auditor',activeInspector],['Building',document.getElementById('meta-facility').value],['Division',document.getElementById('meta-division').value],
    ['Date',document.getElementById('meta-date').value],['Type',tv==='Follow-up'?'Follow-up':tv]];
  document.getElementById('sc-header-grid').innerHTML=fields
    .map(([l,v])=>`<div class="sc-hf"><span class="sc-hl">${l}</span><span class="sc-hv">${ovEsc(v||'—')}</span></div>`).join('');
  document.getElementById('sc-meta-sub').textContent=complete===SECTIONS.length
    ?'All sections scored — submit the report, then download the PDF.'
    :`${SECTIONS.length-complete} of ${SECTIONS.length} sections still have unanswered items.`;

  // Tiles
  const scored=secs.filter(x=>x.answered);
  const best=scored.length?scored.reduce((a,b)=>b.pct>a.pct?b:a):null;
  const worst=scored.length?scored.reduce((a,b)=>b.pct<a.pct?b:a):null;
  const bar=p=>`<div class="ov-bar" style="margin-top:10px"><i style="width:${p}%"></i></div>`;
  const note=t=>`<small style="display:block;color:var(--muted);font-size:.7rem;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t}</small>`;
  const tile=(icon,value,label,extra,color)=>`<div class="hs-card"><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div><b${color?` style="color:${color}"`:''}>${value}</b><span>${label}</span>${extra}</div>`;
  document.getElementById('sc-stats').innerHTML=
    tile('layers',`${complete}/${SECTIONS.length}`,'Sections complete',bar(Math.round(complete/SECTIONS.length*100)))+
    tile('list-checks',`${itemsDone}/${itemsTotal}`,'Items answered',bar(Math.round(itemsDone/itemsTotal*100)))+
    tile('thumbs-up',best?`${best.total}/${best.max}`:'–','Strongest section',best?note(ovEsc(best.title)):note('Nothing scored yet'),best?grade(best.pct).ink:'')+
    tile('triangle-alert',worst?`${worst.total}/${worst.max}`:'–','Needs attention',worst?note(ovEsc(worst.title)):note('Nothing scored yet'),worst?grade(worst.pct).ink:'');

  // Rating scale with this inspection's band highlighted
  document.getElementById('sc-scale').innerHTML=bands.map(([label,range,color,,ink])=>
    `<div class="sc-band${started&&og.label===label?' active':''}" style="--c:${color};--ink:${ink}"><i style="background:${color}"></i>${label} <small>${range}</small></div>`).join('');
  const band=bands.find(b=>b[0]===og.label);
  document.getElementById('sc-scale-note').innerHTML=started?`<b>${band[0]}</b> — ${band[3]}.`:'Score the sections to see where this inspection lands.';

  // Section table
  const rows=document.getElementById('sc-rows');
  rows.innerHTML=secs.map(x=>{
    const g=grade(x.pct);
    return `<tr class="clickable" data-sec="${x.si}" title="Open ${ovEsc(x.title)}">
      <td><b>${ovEsc(x.title)}</b></td>
      <td>${x.answered}/${x.items}</td>
      <td><b>${x.total}</b>/${x.max}</td>
      <td><div class="ov-bar"><i style="width:${x.pct}%;background:${g.color}"></i></div></td>
      <td>${x.answered?`<span class="ov-pill" style="background:${g.soft};color:${g.ink}">${g.label}</span>`:'<span class="ov-pill unassigned">Not started</span>'}</td>
    </tr>`;
  }).join('');
  rows.onclick=e=>{ const tr=e.target.closest('tr[data-sec]'); if(tr) nav('pg-s'+tr.dataset.sec); };
  updatePDFButton();updateScoreCardActionBar();
}
function updatePDFButton(){
  const enabled=currentReportSaved;
  ['btn-pdf','btn-pdf-edit','btn-print','btn-print-edit'].forEach(id=>{
    const btn=document.getElementById(id);
    if(btn){btn.disabled=!enabled;btn.title=enabled?'':(editingRecordId!==null?'Save your changes first':'Submit the report first');}
  });
  updateSubmitState();
}
function updateScoreCardActionBar(){
  const isEdit=editingRecordId!==null;
  const normal=document.getElementById('abar-normal');
  const edit=document.getElementById('abar-edit');
  if(normal) normal.style.display=isEdit?'none':'flex';
  if(edit)   edit.style.display=isEdit?'flex':'none';
  lucide.createIcons({nodes:[document.getElementById('pg-scorecard')]});
}

// ═══════════════════════════════════════════════════════════
// PHOTOS
// ═══════════════════════════════════════════════════════════
// iPhone photos arrive as HEIC. Safari reads them itself; other browsers cannot, so for them the
// photo is converted to JPEG first. Everything is then downscaled: a straight-from-camera photo
// is several MB, and these are stored inside the inspection record itself.
const PHOTO_MAX_EDGE=1600;
const PHOTO_QUALITY=0.82;
let heicFrame=null;

function isHeicFile(f){ return /\.hei[cf]$/i.test(f.name||'') || /image\/hei[cf]/i.test(f.type||''); }

/** The converter needs eval, which this page does not allow, so it runs in a sandboxed frame with
 *  an origin of its own (no access to this page, its session or the API). Started on first use. */
function heicConverter(){
  if(!heicFrame){
    heicFrame=new Promise((resolve,reject)=>{
      const f=document.createElement('iframe');
      f.sandbox='allow-scripts'; f.src='/heic'; f.hidden=true; f.tabIndex=-1; f.title='Photo converter'; f.setAttribute('aria-hidden','true');
      const onMessage=e=>{ if(e.source===f.contentWindow&&e.data&&e.data.type==='heic-ready'){ done(); resolve(f); } };
      const t=setTimeout(()=>{ done(); f.remove(); reject(new Error('converter could not be started')); },20000);
      const done=()=>{ clearTimeout(t); window.removeEventListener('message',onMessage); };
      window.addEventListener('message',onMessage);
      document.body.appendChild(f);
    }).catch(err=>{ heicFrame=null; throw err; });
  }
  return heicFrame;
}

async function heicToJpegBlob(file){
  const f=await heicConverter(), bytes=await file.arrayBuffer();
  return new Promise((resolve,reject)=>{
    const ch=new MessageChannel();                      // the reply comes on this channel and no other
    const t=setTimeout(()=>{ ch.port1.close(); reject(new Error('the conversion took too long')); },120000);
    ch.port1.onmessage=e=>{
      clearTimeout(t); ch.port1.close();
      const d=e.data||{};
      if(d.ok&&d.bytes instanceof ArrayBuffer) resolve(new Blob([d.bytes],{type:'image/jpeg'}));
      else reject(new Error(typeof d.error==='string'?d.error:'the conversion failed'));
    };
    f.contentWindow.postMessage({type:'heic',bytes},'*',[ch.port2,bytes]);
  });
}

/** Returns a downscaled JPEG data URL, converting HEIC on the way in when the browser cannot read it. */
async function preparePhoto(file){
  if(!isHeicFile(file)) return downscalePhoto(file);
  try{ return await downscalePhoto(file); }             // Safari: read directly
  catch{ /* this browser cannot read HEIC: convert it */ }
  try{ return await downscalePhoto(await heicToJpegBlob(file)); }
  catch(err){ throw new Error(`this iPhone (HEIC) photo could not be converted (${err.message}). Open OSQA in Safari, or save the photo as a JPEG first.`); }
}
async function downscalePhoto(source){
  const url=URL.createObjectURL(source);
  try{
    const img=await new Promise((resolve,reject)=>{
      const im=new Image();
      const t=setTimeout(()=>reject(new Error('Image took too long to load.')),20000);
      im.onload=()=>{clearTimeout(t);resolve(im);};
      im.onerror=()=>{clearTimeout(t);reject(new Error('This image could not be read.'));};
      im.src=url;
    });
    const scale=Math.min(1,PHOTO_MAX_EDGE/Math.max(img.naturalWidth,img.naturalHeight));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));
    canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/jpeg',PHOTO_QUALITY);
  }finally{
    URL.revokeObjectURL(url);
  }
}

async function addPhotos(e,si,ii){
  const files=Array.from(e.target.files);
  e.target.value='';
  if(!files.length)return;
  const many=files.length>1;
  showOverlay(many?`Processing ${files.length} photos…`:'Processing photo…');
  const failed=[];
  for(const f of files){
    try{
      const dataUrl=await preparePhoto(f);
      curState().photos[si][ii].push(dataUrl);
      renderPhotos(si,ii);
    }catch(err){
      failed.push(`${f.name||'photo'}: ${err.message}`);
    }
  }
  currentReportSaved=false;updatePDFButton();
  hideOverlay();
  if(failed.length) alert('Some photos could not be added:\n\n'+failed.join('\n'));
}
function renderPhotos(si,ii){
  const row=document.getElementById(`ph-${si}-${ii}`);if(!row)return;row.innerHTML='';
  (curState().photos[si][ii]||[]).forEach((src,pi)=>{
    const w=document.createElement('div');w.className='ptw';
    w.innerHTML=`<img class="pt-img" src="${src}" data-click="openLB" alt=""><button class="pt-rm" data-click="rmPhoto" data-si="${si}" data-ii="${ii}" data-pi="${pi}" title="Remove">×</button>`;
    row.appendChild(w);
  });
}
function rmPhoto(si,ii,pi){curState().photos[si][ii].splice(pi,1);renderPhotos(si,ii);}
function openLB(src){document.getElementById('lb-img').src=src;document.getElementById('lb').classList.add('open');}
function closeLB(){document.getElementById('lb').classList.remove('open');}

// ═══════════════════════════════════════════════════════════
// AUDITORS (the stored field remains `inspector` for backwards compatibility)
// ═══════════════════════════════════════════════════════════
function rebuildInspectorDropdown(){
  const sel=document.getElementById('meta-inspector');
  sel.innerHTML=`<option value="${ovEsc(activeInspector)}">${ovEsc(activeInspector)}</option>`;
  sel.value=activeInspector;
}
/** Shows who the inspection is recorded under. */
function renderInspectorChips(){
  const el=document.getElementById('in-inspector');
  if(el) el.innerHTML=activeInspector
    ?`<i>${ovEsc(ofInitials(activeInspector))}</i>${ovEsc(activeInspector)}${currentUser&&activeInspector===currentUser.name?' <small>you</small>':''}`
    :'Signing in…';
}
function useAccountInspector(){
  if(editingRecordId!==null||!currentUser?.name) return;
  activeInspector=currentUser.name;
  rebuildInspectorDropdown(); renderInspectorChips(); syncFormToState();
}
function closeModal(id){document.getElementById(id).classList.remove('open');}
// Escape closes the dialog on top, the same as its Cancel button (keyboard users are never stuck).
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape'||e.defaultPrevented) return;
  const open=[...document.querySelectorAll('.modal-bg.open')].pop();
  if(open){ e.preventDefault(); closeModal(open.id); }
},true);                                                     // first, so one press closes only the top dialog

// ═══════════════════════════════════════════════════════════
// PICK-OR-TYPE LISTS
// ═══════════════════════════════════════════════════════════
// A native <datalist> shows only as keyboard suggestions on iPhone and iPad, so these lists are
// drawn by the page: tap the field or its arrow to see every option, type to narrow it down.
// options() returns [{value, sub?, group?}]; picking fills the field and fires input + change.
let cbOpenNow=null;                                    // only one list is open at a time
function makeCombo(input,{options}){
  const wrap=document.createElement('div');
  wrap.className='cb';
  input.parentNode.insertBefore(wrap,input); wrap.appendChild(input);
  const id=input.id+'-cb';
  input.removeAttribute('list');
  Object.entries({role:'combobox','aria-autocomplete':'list','aria-expanded':'false','aria-controls':id,autocomplete:'off'}).forEach(([k,v])=>input.setAttribute(k,v));
  const btn=document.createElement('button');
  btn.type='button'; btn.className='cb-btn'; btn.tabIndex=-1; btn.setAttribute('aria-label','Show the list');
  btn.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const list=document.createElement('ul');
  list.className='cb-list'; list.id=id; list.setAttribute('role','listbox'); list.hidden=true;
  wrap.append(btn,list);
  let shown=[], active=-1, filtering=false;
  const mark=(text,q)=>{ const t=String(text), i=q?t.toLowerCase().indexOf(q):-1;
    return i<0?ovEsc(t):ovEsc(t.slice(0,i))+'<mark>'+ovEsc(t.slice(i,i+q.length))+'</mark>'+ovEsc(t.slice(i+q.length)); };
  function render(){
    const all=options()||[], q=filtering?input.value.trim().toLowerCase():'', cur=input.value.trim().toLowerCase();
    shown=q?all.filter(o=>`${o.value} ${o.sub||''} ${o.group||''}`.toLowerCase().includes(q)):all;
    if(active>=shown.length) active=shown.length-1;
    let group=null, html='';
    shown.forEach((o,i)=>{
      if(o.group&&o.group!==group){ group=o.group; html+=`<li class="cb-group" role="presentation">${ovEsc(group)}</li>`; }
      const sel=String(o.value).toLowerCase()===cur;
      html+=`<li role="option" id="${id}-${i}" data-i="${i}" class="cb-opt${i===active?' on':''}${sel?' sel':''}" aria-selected="${sel}"><b>${mark(o.value,q)}</b>${o.sub?`<small>${mark(o.sub,q)}</small>`:''}</li>`;
    });
    list.innerHTML=html||`<li class="cb-empty" role="presentation">${all.length?`Nothing matches “${ovEsc(input.value.trim())}”`:'Loading the list…'}</li>`;
    if(active>=0) input.setAttribute('aria-activedescendant',`${id}-${active}`); else input.removeAttribute('aria-activedescendant');
  }
  // Room below the field, above the on-screen keyboard. On a phone with too little of it the
  // field is scrolled up under the top bar first, so the list is never hidden behind the keys.
  function fit(){
    const vv=window.visualViewport, bottom=vv?vv.offsetTop+vv.height:innerHeight;
    let r=input.getBoundingClientRect();
    if(bottom-r.bottom<230&&innerWidth<=780){
      const scroller=input.closest('#main');
      const top=(document.getElementById('pbar')?.getBoundingClientRect().bottom||0)+34;
      if(scroller&&r.top>top){ scroller.scrollTop+=r.top-top; r=input.getBoundingClientRect(); }
    }
    list.style.maxHeight=Math.round(Math.max(170,Math.min(340,bottom-r.bottom-16)))+'px';
  }
  function open(){
    render();
    if(!list.hidden) return;
    if(cbOpenNow&&cbOpenNow!==api) cbOpenNow.close();
    cbOpenNow=api;
    list.hidden=false; wrap.classList.add('open'); input.setAttribute('aria-expanded','true');
    fit();
    list.querySelector('.cb-opt.sel')?.scrollIntoView({block:'center'});
  }
  function close(){
    if(list.hidden) return;
    list.hidden=true; wrap.classList.remove('open'); input.setAttribute('aria-expanded','false');
    input.removeAttribute('aria-activedescendant'); active=-1; filtering=false;
  }
  function pick(i){
    const o=shown[i];
    if(!o) return;
    input.value=o.value;
    close();
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function move(step){
    if(list.hidden){ open(); return; }
    if(!shown.length) return;
    active=(active+step+shown.length)%shown.length;
    render();
    document.getElementById(`${id}-${active}`)?.scrollIntoView({block:'nearest'});
  }
  input.addEventListener('focus',()=>{ filtering=false; open(); });
  input.addEventListener('click',()=>{ if(list.hidden){ filtering=false; open(); } });
  input.addEventListener('input',e=>{ if(!e.isTrusted) return; filtering=true; active=-1; open(); });
  input.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'){ e.preventDefault(); move(1); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); move(-1); }
    else if(e.key==='Enter'&&!list.hidden&&active>=0){ e.preventDefault(); pick(active); }
    else if(e.key==='Escape'&&!list.hidden){ e.preventDefault(); close(); }
    else if(e.key==='Tab') close();
  });
  input.addEventListener('blur',()=>setTimeout(()=>{ if(!wrap.contains(document.activeElement)) close(); },150));
  // Taps on the arrow or the list keep the field's focus (and the keyboard) where they are.
  btn.addEventListener('mousedown',e=>e.preventDefault());
  btn.addEventListener('click',e=>{ e.preventDefault(); if(list.hidden){ filtering=false; open(); } else close(); });
  list.addEventListener('mousedown',e=>e.preventDefault());
  // preventDefault also stops the surrounding <label> from passing the tap on to the field
  list.addEventListener('click',e=>{ e.preventDefault(); const li=e.target.closest('[data-i]'); if(li) pick(Number(li.dataset.i)); });
  document.addEventListener('pointerdown',e=>{ if(!wrap.contains(e.target)) close(); });
  window.visualViewport?.addEventListener('resize',()=>{ if(!list.hidden) fit(); });
  const api={open,close,refresh:()=>{ if(!list.hidden) render(); }};
  return api;
}

// ═══════════════════════════════════════════════════════════
// INSPECTION DETAILS (step 1)
// ═══════════════════════════════════════════════════════════
function inVal(id){ return document.getElementById(id).value.trim(); }
function inQuarterOf(date){ const m=/^(\d{4})-(\d{2})/.exec(date||''); return m?`${m[1]}-Q${Math.floor((+m[2]-1)/3)+1}`:null; }
function inMarkChanged(){ currentReportSaved=false; updatePDFButton(); updateSteps(); }
async function inLoadBuildings(){
  if(inBuildings) return inBuildings;
  try{
    const res=await fetch('/api/buildings');
    if(res.ok){
      inBuildings=(await res.json()).buildings||[];
      inCombo?.refresh();
    }
  }catch{}
  return inBuildings||[];
}
/** The buildings list for the Building field: grouped by division — the chosen division first —
 *  with each building's area and location underneath. */
let inCombo=null;
const IN_DIVISION_ORDER=['CAOSD','NPOSD','OOSD','SAOSD','NAOSD','RYOSD'];
function inBuildingOptions(){
  if(!inBuildings){ inLoadBuildings(); return []; }
  const chosen=document.getElementById('meta-division').value;
  const rank=d=>d===chosen?-1:(IN_DIVISION_ORDER.indexOf(d)+1||99);
  return inBuildings.slice()
    .sort((a,b)=>rank(a.division)-rank(b.division)||String(a.division).localeCompare(b.division)||a.name.localeCompare(b.name,undefined,{numeric:true}))
    .map(b=>({value:b.name,sub:[b.area,b.location].filter(Boolean).join(' · '),group:b.division}));
}
function inMatchBuilding(){
  const v=inVal('meta-facility').toLowerCase();
  return v&&inBuildings?inBuildings.find(b=>b.name.toLowerCase()===v)||null:null;
}
function initInspectionDetails(){
  if(inReady) return;
  inReady=true;
  const fac=document.getElementById('meta-facility');
  inCombo=makeCombo(fac,{options:inBuildingOptions});
  fac.addEventListener('input',()=>{ inOnBuilding({final:false}); inMarkChanged(); });
  fac.addEventListener('change',()=>inOnBuilding({final:true}));
  document.getElementById('meta-division').addEventListener('change',e=>{ e.target.classList.remove('invalid'); inMarkChanged(); });
  document.getElementById('meta-date').addEventListener('change',e=>{ e.target.classList.remove('invalid'); inCheckAssignment(); inMarkChanged(); });
  document.getElementById('in-types').addEventListener('click',e=>{
    const b=e.target.closest('[data-type]');
    if(!b) return;
    document.getElementById('meta-type').value=b.dataset.type;
    document.getElementById('in-types').classList.remove('invalid');
    inRenderTypes(); inCheckAssignment(); inMarkChanged();
  });
  document.getElementById('in-resume').addEventListener('click',e=>{
    const b=e.target.closest('[data-in]');
    if(!b) return;
    if(b.dataset.in==='continue') nav(lastSection); else inStartOver();
  });
}
function inOnBuilding({final}){
  const b=inMatchBuilding(), hint=document.getElementById('in-bld-hint'), typed=inVal('meta-facility');
  document.getElementById('meta-facility').classList.remove('invalid');
  if(b){
    const div=document.getElementById('meta-division');
    if(![...div.options].some(o=>o.value===b.division)) div.add(new Option(b.division,b.division));
    if(div.value!==b.division){ div.value=b.division; div.classList.remove('invalid'); }
    document.getElementById('in-area').textContent=`${b.area} · ${b.location}`;
    hint.textContent='From the buildings list'; hint.className='in-hint ok';
  }else{
    document.getElementById('in-area').textContent='–';
    if(typed&&final&&inBuildings){ hint.textContent='Not in the buildings list — reports will not link it to a division or area.'; hint.className='in-hint warn'; }
    else{ hint.textContent='Pick from the list so reports can link it to its division and area.'; hint.className='in-hint'; }
  }
  inCheckAssignment();
}
function inRenderTypes(){
  const t=document.getElementById('meta-type').value;
  document.querySelectorAll('#in-types .in-type').forEach(b=>b.classList.toggle('active',b.dataset.type===t));
  applyScoreWording();
}
/** Links the inspection to the person's own pending assignment for this building, type and quarter. */
async function inCheckAssignment(){
  const box=document.getElementById('in-assign');
  if(editingRecordId!==null||!currentUser||!ASSIGNEE_ROLES.includes(currentUser.role)){ box.hidden=true; return; }
  const b=inMatchBuilding(), type=document.getElementById('meta-type').value, q=inQuarterOf(document.getElementById('meta-date').value);
  let match=null;
  if(b&&q&&(type==='BOQI'||type==='EOQI')){
    if(!inAssignCache[q]){
      try{
        const res=await fetch('/api/auditor/profile?quarter='+q);
        const d=res.ok?await res.json():null;
        inAssignCache[q]=d?[...d.assignments,...d.carriedOver].filter(a=>a.status==='pending'):[];
      }catch{ inAssignCache[q]=[]; }
    }
    match=inAssignCache[q].find(a=>a.buildingId===b.id&&a.type===type)||null;
  }
  const had=currentAssignmentId;
  currentAssignmentId=match?match.id:null;
  document.getElementById('in-mode').textContent=match?'Assigned inspection':'New inspection';
  box.hidden=!match&&!had;
  box.innerHTML=match
    ?`<div class="sc-callout info"><svg data-lucide="link" width="17" height="17"></svg><div><strong>Linked to your assignment</strong>${ovEsc(match.buildingName)} · ${match.quarter} ${match.type} — saving this inspection completes it.</div></div>`
    :`<div class="sc-callout warn"><svg data-lucide="unlink" width="17" height="17"></svg><div><strong>No longer linked to an assignment</strong>The building, type or date no longer matches one of your assignments.</div></div>`;
  lucide.createIcons();
}
function inRenderDetails(){
  initInspectionDetails();
  renderInspectorChips();
  inRenderTypes();
  document.getElementById('in-mode').textContent=editingRecordId!==null?'Editing a saved report':currentAssignmentId?'Assigned inspection':'New inspection';
  const answered=auAnsweredPct(), resume=document.getElementById('in-resume');
  resume.hidden=!(answered>0&&!currentReportSaved&&editingRecordId===null);
  if(!resume.hidden){
    resume.innerHTML=`<svg data-lucide="history" width="17" height="17"></svg><div style="flex:1"><strong>Inspection in progress</strong>${ovEsc(inVal('meta-facility')||'Untitled building')} · ${answered}% answered</div>
      <button class="btn bt" style="padding:6px 14px;font-size:.76rem" data-in="continue">Continue scoring</button>
      <button class="btn bo" style="padding:6px 14px;font-size:.76rem" data-in="over">Start over</button>`;
    resume.style.alignItems='center';
  }
  inLoadBuildings().then(()=>inOnBuilding({final:!!inVal('meta-facility')}));
  lucide.createIcons();
}
function inStartOver(){
  if(!confirm('Clear the answers, comments and photos of the inspection in progress?')) return;
  clearInspectionState();
  currentAssignmentId=null; currentReportSaved=false; lastSection='pg-s0';
  ['meta-facility','meta-type','meta-division'].forEach(id=>{ document.getElementById(id).value=''; });
  document.getElementById('meta-date').valueAsDate=new Date();
  syncFormToState(); updatePDFButton(); dismissSpell();
  inRenderDetails();
}

// ═══════════════════════════════════════════════════════════
// FILENAME
// ═══════════════════════════════════════════════════════════
function buildFilenameFrom(typeVal, date, facility, division, inspector){
  const month=(date||new Date().toISOString()).slice(0,7);
  const tl=typeVal==='BOQI'?'BOQI':typeVal==='EOQI'?'EOQI':typeVal==='Follow-up'?'Follow-up':'Inspection';
  const b=(facility||'Building').replace(/\s+/g,'-');
  const d=(division||'').replace(/\s+/g,'-');
  const i=(inspector||'Auditor').replace(/\s+/g,'-');
  return [month,tl,b,d,i].filter(Boolean).join('_')+'.pdf';
}

// ═══════════════════════════════════════════════════════════
// SAVE CHOICE MODAL (edit mode)
// ═══════════════════════════════════════════════════════════
function openSaveChoice(){
  saveChoiceMode='update';selectSaveChoice('update');
  document.getElementById('modal-save-choice').classList.add('open');
  lucide.createIcons({nodes:[document.getElementById('modal-save-choice')]});
}
function selectSaveChoice(mode){
  saveChoiceMode=mode;
  document.getElementById('choice-update').classList.toggle('selected',mode==='update');
  document.getElementById('choice-eoqi').classList.toggle('selected',mode==='eoqi');
  const btn=document.getElementById('btn-confirm-save');
  if(btn)btn.textContent=mode==='eoqi'?'Save as New EOQI Report':'Update Existing Report';
}
function confirmSaveChoice(){
  closeModal('modal-save-choice');
  if(saveChoiceMode==='eoqi') saveAsEOQI();
  else saveInspection(true);
}

// ═══════════════════════════════════════════════════════════
// BUILD RECORD OBJECT
// ═══════════════════════════════════════════════════════════
function buildRecord(overrideType){
  let grand=0;SECTIONS.forEach((_,si)=>grand+=getSecScore(si).total);
  const overall=Math.round(grand);
  const typeVal=overrideType||document.getElementById('meta-type').value;
  const typeLabel=typeVal==='BOQI'?'Beginning of Quarter Inspection (BOQI)':typeVal==='EOQI'?'End of Quarter Inspection (EOQI)':typeVal==='Follow-up'?'Follow-up and Edit':typeVal;
  const date=overrideType?new Date().toISOString().slice(0,10):document.getElementById('meta-date').value||new Date().toISOString().slice(0,10);
  const facility=document.getElementById('meta-facility').value||'Unknown';
  const division=document.getElementById('meta-division').value||'';
  const filename=buildFilenameFrom(typeVal,date,facility,division,activeInspector);
  return{
    id:Date.now(),inspector:activeInspector,facility,division,date,
    type:typeVal,typeLabel,overall,filename,assignmentId:currentAssignmentId,
    sections:SECTIONS.map((sec,si)=>({
      title:sec.title,lucide:sec.lucide,score:getSecScore(si).total,max:sec.max,mode:sec.scoringMode,
      items:sec.items.map((item,ii)=>({
        label:item,score:curState().scores[si][ii],
        comment:curState().comments[si][ii],
        photos:curState().photos[si][ii].slice(),
      })),
      notes:curState().notes[si],
    })),
  };
}

// ═══════════════════════════════════════════════════════════
// SAVE / UPDATE / EOQI  (cloud)
// ═══════════════════════════════════════════════════════════
// Photos travel with the report and the server files each one separately, so the saved report
// stays small. The upload itself still has a sensible ceiling -- a clear message beats a failed
// save after a long inspection.
const RECORD_SIZE_LIMIT=12*1024*1024;
function recordSize(record){ return JSON.stringify(record).length; }
function countPhotos(record){
  return (record.sections||[]).reduce((n,sec)=>n+(sec.items||[]).reduce((m,it)=>m+((it.photos||[]).length),0),0);
}
function tooLargeMessage(record){
  const mb=(recordSize(record)/1024/1024).toFixed(1);
  return `This report is ${mb} MB — too large to save (limit is 12 MB).\n\n`+
    `It currently holds ${countPhotos(record)} photos. Remove a few of the largest ones and save again.`;
}

// ── Submit once ──
// A report is submitted a single time. Saving again from the same form updates that report, and the
// server refuses a second report for the same assignment or the same building, type and quarter.
function submitKeyOf(facility,type,assignmentId,date){ return [String(facility||'').trim().toLowerCase(),type||'',assignmentId||'',inQuarterOf(date)||''].join('|'); }
function submitKey(){ return submitKeyOf(inVal('meta-facility'),document.getElementById('meta-type').value,currentAssignmentId,document.getElementById('meta-date').value); }
function submittedReport(){ return lastSubmitted&&lastSubmitted.key===submitKey()?lastSubmitted:null; }
function updateSubmitState(){
  const editing=editingRecordId!==null, sub=editing?null:submittedReport();
  const btn=document.getElementById('btn-save');
  if(btn){
    btn.disabled=saveBusy||!!(sub&&currentReportSaved);
    btn.textContent=saveBusy?(sub?'Saving…':'Submitting…'):sub?(currentReportSaved?'Submitted ✓':'Save changes'):'Submit report';
  }
  const editBtn=document.getElementById('btn-save-edit');
  if(editBtn) editBtn.disabled=saveBusy;
  const notice=document.getElementById('save-notice'), done=document.getElementById('submitted-notice');
  if(notice){
    notice.style.display=!currentReportSaved&&!sub?'flex':'none';
    document.getElementById('save-notice-title').textContent=editing?'Save your changes':'Submit to complete this report';
    document.getElementById('save-notice-text').textContent=editing
      ?'You are editing a report that is already on file. Saving updates it — it is not submitted again.'
      :'Submitting sends the report for review and notifies the reviewers. A report is submitted once — later changes update the same report.';
  }
  if(done){
    done.style.display=sub?'flex':'none';
    if(sub){
      document.getElementById('submitted-title').textContent=currentReportSaved?'Report submitted':'Changes not saved yet';
      const what=[document.getElementById('meta-type').value,inVal('meta-facility')].filter(Boolean).join(' report for ');
      document.getElementById('submitted-text').textContent=currentReportSaved
        ?`The ${what} was sent for review and the reviewers were notified.`
        :`Saving updates the report you already submitted; it will not be submitted a second time.`;
    }
  }
}
function submitDialog({title,sub,facts,warn,go,onGo}){
  document.getElementById('sm-title').textContent=title;
  document.getElementById('sm-sub').textContent=sub;
  document.getElementById('sm-facts').innerHTML=facts.map(([k,v])=>`<dt>${ovEsc(k)}</dt><dd>${ovEsc(v)}</dd>`).join('');
  const w=document.getElementById('sm-warn');
  w.style.display=warn?'flex':'none';
  document.getElementById('sm-warn-text').textContent=warn||'';
  const btn=document.getElementById('sm-go');
  btn.textContent=go; btn.onclick=()=>{ closeModal('modal-submit'); onGo(); };
  document.getElementById('modal-submit').classList.add('open');
  lucide.createIcons({nodes:[document.getElementById('modal-submit')]});
  setTimeout(()=>btn.focus(),50);
}
function submitReport(){
  if(saveBusy) return;
  if(!inVal('meta-facility')||!document.getElementById('meta-type').value){
    showToast('Add the building and inspection type in Details before submitting.',true); nav('pg-new'); return;
  }
  const sub=submittedReport();
  if(sub){ if(!currentReportSaved) saveInspection(); return; }
  const all=curState().scores.flat(), answered=all.filter(v=>v!==null).length, missing=all.length-answered;
  let grand=0; SECTIONS.forEach((_,si)=>grand+=getSecScore(si).total);
  const overall=Math.round(grand), date=document.getElementById('meta-date').value, type=document.getElementById('meta-type').value;
  submitDialog({
    title:'Submit report',
    sub:'Check the details. The reviewers are notified as soon as the report is submitted.',
    facts:[['Building',inVal('meta-facility')],['Inspection',[type,inQuarterOf(date)].filter(Boolean).join(' · ')],['Date',date||'—'],['Auditor',activeInspector||'—'],
      ['Score',`${overall}/100 · ${grade(overall).label}`],['Answered',`${answered} of ${all.length} items`]],
    warn:missing?`${missing} item${missing===1?' has':'s have'} no answer yet. Go back to complete ${missing===1?'it':'them'}, or submit the report as it is.`:'',
    go:'Submit report', onGo:()=>saveInspection(),
  });
}
function showAlreadySubmitted(err){
  const x=err?.data?.existing;
  if(!x) return false;
  submitDialog({
    title:'Already submitted', sub:err.message,
    facts:[['Building',x.building||'—'],['Inspection',[x.type,x.quarter].filter(Boolean).join(' · ')],['Submitted by',x.auditor||'—'],['Date',x.date||'—']],
    warn:'', go:'Open that report', onGo:()=>openReport(x.id),
  });
  return true;
}
document.getElementById('submitted-open').addEventListener('click',()=>{ const sub=submittedReport(); if(sub) openReport(sub.id); });

async function saveInspection(updateExisting){
  if(saveBusy) return;
  if(!inVal('meta-facility')||!document.getElementById('meta-type').value){
    showToast('Add the building and inspection type in Details before saving.',true); nav('pg-new'); return;
  }
  const record=buildRecord(null);
  if(recordSize(record)>RECORD_SIZE_LIMIT){ setSyncChip('err','Report too large'); alert(tooLargeMessage(record)); return; }
  const editing=editingRecordId!==null&&updateExisting, sub=editing?null:submittedReport();
  saveBusy=true; updateSubmitState();
  setSyncChip('sync','Saving…'); showOverlay(editing||sub?'Saving changes…':'Submitting report…');
  try{
    if(editing||sub){
      record.id=editing?editingRecordId:sub.id;
      await dbUpdate(record);
      const idx=history.findIndex(r=>r.id===record.id);
      if(idx>=0) history[idx]=record; else history.unshift(record);
      if(editing){
        editingRecordId=null;
        document.getElementById('edit-banner').classList.remove('show');
        updateScoreCardActionBar();
      }
      showToast('Changes saved to the submitted report');
    } else {
      const res=await dbInsert(record);
      history.unshift(record);
      showToast(res?.alreadySaved?'This report was already submitted — nothing was sent twice.':'Report submitted — the reviewers have been notified.');
    }
    lastSubmitted={id:record.id,key:submitKeyOf(record.facility,record.type,record.assignmentId,record.date)};
    currentReportSaved=true;
    loadHome();
    if(record.assignmentId){ inAssignCache={}; loadAuditorProfile({quiet:true}); }
    setSyncChip('ok','Saved');
  }catch(e){
    if(e.status===409&&showAlreadySubmitted(e)) setSyncChip('err','Already submitted');
    else{ setSyncChip('err','Save failed'); alert('Could not save the report: '+e.message+(e.status?'':'\n\nCheck your internet connection and try again.')); }
  }finally{ saveBusy=false; hideOverlay(); updatePDFButton(); }
}

async function saveAsEOQI(){
  if(saveBusy) return;
  const record=buildRecord('EOQI');
  if(recordSize(record)>RECORD_SIZE_LIMIT){ setSyncChip('err','Report too large'); alert(tooLargeMessage(record)); return; }
  saveBusy=true; updateSubmitState();
  setSyncChip('sync','Submitting EOQI…'); showOverlay('Submitting the EOQI report…');
  try{
    const res=await dbInsert(record);
    document.getElementById('meta-type').value='EOQI';
    document.getElementById('meta-date').value=record.date;
    history.unshift(record);
    editingRecordId=null;
    document.getElementById('edit-banner').classList.remove('show');
    updateScoreCardActionBar();
    lastSubmitted={id:record.id,key:submitKeyOf(record.facility,record.type,record.assignmentId,record.date)};
    currentReportSaved=true;
    loadHome();
    setSyncChip('ok','Saved as EOQI');
    showToast(res?.alreadySaved?'This EOQI was already submitted — nothing was sent twice.':'EOQI submitted — the reviewers have been notified.');
  }catch(e){
    if(e.status===409&&showAlreadySubmitted(e)) setSyncChip('err','Already submitted');
    else{ setSyncChip('err','Save failed'); alert('Could not save the report: '+e.message); }
  }finally{ saveBusy=false; hideOverlay(); updatePDFButton(); }
}

// ═══════════════════════════════════════════════════════════
// HISTORY — filters & render
// ═══════════════════════════════════════════════════════════
// Home overview cards — derived from the same history the archive renders,
// so the numbers can never disagree with the list below them.

/** Home: whole-archive figures and the latest reports, from the same source as Inspection Reports. */
/** Highest / lowest score, with the building, division and area it was given to. */
function homeExtreme(key,r,fallback){
  const card=document.getElementById(`hs-${key}-card`), num=document.getElementById(`hs-${key}`), where=document.getElementById(`hs-${key}-where`);
  const score=r?r.score:fallback;
  num.textContent=score??'–';
  num.style.color=score!=null?grade(score).ink:'';
  where.innerHTML=r?`<b>${ovEsc(r.building||'—')}</b><small>${ovEsc([r.division,r.area].filter(Boolean).join(' · ')||'Division not set')}</small>`:'';
  if(r){ card.dataset.report=r.id; card.title='Open this report'; } else { delete card.dataset.report; card.removeAttribute('title'); }
}
document.addEventListener('click',e=>{
  const c=e.target.closest('#home-stats [data-report]');
  if(c) openReport(Number(c.dataset.report));
});
document.addEventListener('keydown',e=>{
  if((e.key==='Enter'||e.key===' ')&&e.target.matches&&e.target.matches('#home-stats [data-report]')){ e.preventDefault(); openReport(Number(e.target.dataset.report)); }
});
async function loadHome(){
  try{
    const res=await fetch('/api/reports/library?limit=6&sort=newest');
    if(!res.ok) throw new Error('Could not load reports');
    const d=await res.json(), o=d.overview;
    setSyncChip('ok','Online · '+o.count+' reports');
    document.getElementById('hs-total').textContent=o.count;
    document.getElementById('hs-avg').textContent=o.avg??'–';
    homeExtreme('best',o.best,o.max);
    homeExtreme('worst',o.worst,null);
    document.getElementById('hs-quarter').textContent=o.currentQuarterCount;
    document.getElementById('hs-quarter-label').textContent=`Reports in ${o.currentQuarter}`;
    const list=document.getElementById('hist-list');
    list.innerHTML=d.rows.length?d.rows.map(r=>{
      const g=r.overall!=null?grade(r.overall):null;
      const ds=r.date?new Date(r.date+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'–';
      return `<div class="hist-card" data-report="${r.id}" tabindex="0" role="button" title="Open this report">
        <div class="hc-score" style="background:${g?g.color:'#9fb3c8'};color:${g?g.on:'#102040'}">${r.overall??'–'}</div>
        <div class="hc-info"><div class="hc-title">${ovEsc(r.building)}${r.division?' — '+ovEsc(r.division):''}</div>
          <div class="hc-meta">${ovEsc(r.auditor||'—')} · ${ds}${r.type?' · '+ovEsc(r.type):''}</div></div>
        ${libStatusPill(r.status)}
        <svg data-lucide="chevron-right" width="16" height="16" style="color:var(--muted);flex-shrink:0"></svg>
      </div>`;
    }).join(''):'<div class="no-hist">No reports saved yet. Complete an inspection and save it from the Score Card.</div>';
    list.onclick=e=>{ const c=e.target.closest('[data-report]'); if(c) openReport(Number(c.dataset.report)); };
    list.onkeydown=e=>{ if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-report]')){ e.preventDefault(); openReport(Number(e.target.dataset.report)); } };
    lucide.createIcons();
  }catch(err){
    setSyncChip('err','Offline — check connection');
    document.getElementById('hist-list').innerHTML=`<div class="no-hist">${ovEsc(err.message)} — check your connection and reload.</div>`;
  }
}
function reportPrintEsc(value){
  return String(value??'—').replace(/[&<>"']/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[char]);
}

function reportPrintTone(score){
  const g=grade(Number(score)||0);
  return {label:g.label,color:g.ink,soft:g.soft};
}

/** The journey map artwork with this inspection's own scores written into it. */
function journeyScoreCard(svg,sections,overall){
  const order=['Arrival & Parking','Landscape','Entrance & Lobby','Workspaces','Elevators & Corridors','Food & Concession',
    'Washrooms / Bathrooms','Health, Safety & Emergency Readiness','Maintenance','Miscellaneous'];
  const by=new Map(sections.map(s=>[s.title,s]));
  const vals=order.map(t=>{
    const s=by.get(t), v=s==null?null:Number(s.score);
    return v==null||Number.isNaN(v)?'–':String(Math.round(v)).padStart(2,'0');
  });
  vals.push(String(Math.round(Number(overall)||0)));
  let i=0;
  return svg
    .replace(/<\?xml[^>]*\?>/,'')
    .replace(/<!--[\s\S]*?-->/g,'')
    .replace(/(<text\b[^>]*>)([\s\S]*?)(<\/text>)/g,(whole,open,inner,close)=>{
      if(!/^\d{2}$/.test(inner.replace(/<[^>]+>/g,'').trim())) return whole;      // labels and the title stay
      const v=vals[i++];
      return open+inner.replace(/>[^<]*</,'>'+v+'<')+close;
    });
}

/**
 * The inspection report as a standalone A4 document.
 * Page 1 is the overview (details and the journey score card); after it comes one page per
 * journey touchpoint, never split and never repeated. The document paginates itself, so
 * nothing is left to the browser except the paper — which is why @page has no margin and no
 * browser header or footer can appear.
 */
async function buildInspectionReportHtml(report,{autoPrint=false,sameTab=false}={}){
  const sections=Array.isArray(report.sections)?report.sections:[];
  const overall=Math.round(Number(report.overall)||0);
  const tone=reportPrintTone(overall);
  const value=v=>reportPrintEsc(v||'—');
  const words=report.type==='EOQI';                 // only the end-of-quarter check is worded as compliance
  const logoUrl=new URL('/osqa-logo.svg',location.origin).href;
  const quarter=report.quarter||(report.date?`${report.date.slice(0,4)}-Q${Math.floor((Number(report.date.slice(5,7))-1)/3)+1}`:'');

  let journey='';
  try{
    const res=await fetch('/journey-map-QA-2026-Q3-EOQ-009.svg',{cache:'force-cache'});
    if(res.ok) journey=journeyScoreCard(await res.text(),sections,overall);
  }catch{ journey=''; }

  const totalMax=sections.reduce((a,s)=>a+(Number(s.max)||0),0);
  const coverFacts=[
    ['Building',report.facility],['Division',report.division],['Inspection type',report.typeLabel],
    ['Quarter',quarter],['Inspection date',report.date],['Auditor',report.inspector],
  ].map(([l,v])=>`<tr><th>${l}</th><td>${value(v)}</td></tr>`).join('');

  const detailSections=sections.map(sec=>{
    const max=Number(sec.max)||10, score=Number(sec.score)||0, pct=max?Math.round(score/max*100):0;
    const t=reportPrintTone(pct);
    const shots=[];
    const rows=(sec.items||[]).map((item,index)=>{
      const label=typeof item==='string'?item:item.label;
      const sc=typeof item==='string'?null:item.score;
      const comment=typeof item==='string'?'':item.comment;
      const photos=typeof item==='string'?[]:(item.photos||[]);
      const state=sc==null?'na':sc===0?'no':'yes';
      const result=sc==null?'<span class="res na">Not scored</span>'
        :words?`<span class="res ${state}">${sc===0?'✗ Not compliant':'✓ Compliant'}</span>`
          :`<span class="res ${state}">${sc}</span>`;
      photos.forEach(src=>shots.push({src,n:index+1,label}));
      const ref=photos.length?`<span class="ph-ref">${photos.length} photo${photos.length===1?'':'s'} below</span>`:'';
      return `<tr><td class="n">${index+1}</td><td class="item-label">${value(label)}</td>
        <td class="item-res">${result}</td>
        <td class="comments">${comment?value(comment):(photos.length?'':'<span class="empty">—</span>')}${ref}</td></tr>`;
    }).join('');
    // Every photo of the touchpoint, captioned with the item it belongs to.
    const gallery=shots.length?`<div class="gallery"><div class="gal-head">Evidence photos <small>${shots.length}</small></div>
      <div class="gal-grid">${shots.map(p=>`<figure><div class="gal-img"><img src="${reportPrintEsc(p.src)}" alt="Evidence for item ${p.n}"></div>
        <figcaption><b>Item ${p.n}</b> ${value(p.label)}</figcaption></figure>`).join('')}</div></div>`:'';
    return `<div class="blk"><section class="report-section">
      <div class="section-head"><div><span class="kicker">Journey touchpoint</span><h2>${value(sec.title)}</h2></div>
        <div class="section-total"><b style="color:${t.color}">${score}<small>/${max}</small></b><span class="chip" style="--tone:${t.color};--soft:${t.soft}">${t.label}</span></div></div>
      <table class="detail-table"><thead><tr><th class="n">#</th><th class="item-col">Inspection item</th><th class="item-res">Result</th><th>Observations &amp; evidence</th></tr></thead>
        <tbody>${rows}</tbody>
        ${sec.notes?`<tfoot><tr><td colspan="4"><b>Auditor note</b><span>${value(sec.notes)}</span></td></tr></tfoot>`:''}</table>
    </section>${gallery}</div>`;
  }).join('');

  const filename=value(report.filename||'inspection-report.pdf');
  return `<!DOCTYPE html><html lang="en" dir="ltr"><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${filename}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap" rel="stylesheet">
    <style>
      :root{--ink:#002070;--deep:#102040;--royal:#0033A0;--teal:#26A8AB;--paper:#F4F7FA;--line:#D9DEE3;--muted:#5F6369;
        --pad-x:12mm;--pad-t:11mm;--pad-b:10mm}
      *{box-sizing:border-box;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
      /* The document owns the paper: no page margin means no browser header, footer or URL. */
      @page{size:A4 portrait;margin:0}
      html,body{margin:0;padding:0;background:#fff;color:var(--deep);font-family:Cairo,Arial,sans-serif;line-height:1.42}
      .sheet{width:210mm;height:297mm;padding:var(--pad-t) var(--pad-x) var(--pad-b);overflow:hidden;display:flex;flex-direction:column;background:#fff;break-after:page;page-break-after:always}
      .sheet:last-child{break-after:auto;page-break-after:auto}
      #flow{position:absolute;left:-9999px;top:0;width:186mm}

      /* Screen: the sheets sit on a desk, with the toolbar above them. Print: only the sheets. */
      .bar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 14px;background:#0A1B3D;color:#fff;font-size:13px}
      .bar b{font-weight:800;margin-right:auto;font-size:13px}
      .bar button{font:inherit;font-weight:800;border:0;border-radius:8px;padding:8px 14px;min-height:40px;cursor:pointer;background:#26A8AB;color:#04263A}
      .bar button[disabled]{opacity:.6;cursor:default}
      .bar button.ghost{background:rgba(255,255,255,.14);color:#fff}
      .bar small{opacity:.7;width:100%;font-size:11px}
      @media(max-width:600px){.bar b{flex:0 0 100%;margin:0}.bar button{flex:1 1 auto}}
      @media screen{body{background:#E9EDF1}.sheet{margin:0 auto 10px;box-shadow:0 1px 5px rgba(16,32,64,.2)}
        body{padding-bottom:10px}}
      @media print{.bar{display:none!important}body{background:#fff}.sheet{margin:0;box-shadow:none}}
      #doc{width:210mm;margin:0 auto;transform-origin:top left}
      @media print{#doc{transform:none!important;width:auto}#docwrap{height:auto!important}}

      .rule{height:5px;border-radius:99px;background:linear-gradient(90deg,var(--royal),var(--teal));flex:none}
      .brand{display:flex;align-items:center;gap:12px;margin-top:14px;color:var(--royal);font-weight:900;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;flex:none}
      .brand img{display:block;height:32px;width:auto}.brand i{width:1px;height:22px;background:var(--line);display:block}

      /* Page 1 — overview */
      .cover h1{font-size:36px;line-height:1.08;letter-spacing:-.035em;color:var(--ink);margin:11mm 0 6px}
      .cover h1 span{color:var(--royal)}
      .cover-score{display:inline-flex;align-items:center;gap:9px;margin-top:14px;font-size:12.5px;font-weight:900;color:var(--muted)}
      .cover-score b{font-size:23px;color:var(--ink);letter-spacing:-.03em}
      .fact-table{border-collapse:collapse;width:100%;margin-top:7mm}
      .fact-table th{text-align:left;width:34mm;padding:8px 0;border-top:1px solid var(--line);color:var(--muted);font-size:9px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}
      .fact-table td{padding:8px 0;border-top:1px solid var(--line);font-size:13px;font-weight:700;color:var(--deep);overflow-wrap:anywhere}
      .journey-card{padding-top:6mm}
      .journey-card svg{display:block;width:100%;height:auto}
      .cover-foot{display:flex;justify-content:space-between;border-top:1px solid var(--line);padding-top:9px;margin-top:auto;font-size:9px;color:var(--muted);flex:none}

      /* Page furniture */
      .foot{margin-top:auto;padding-top:9px;border-top:1px solid var(--line);display:flex;justify-content:space-between;font-size:8.5px;color:var(--muted);flex:none}
      .body{flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-direction:column}
      .body>.blk{flex:0 0 auto;margin-bottom:0}
      .sheet.settled .body>.blk:not([data-sign]){flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
      .sheet.settled .gallery{margin-top:auto}
      .sheet .body>.blk[data-sign]{flex:0 0 auto;display:block}          /* the signatures never grow; the section takes the room */
      .page-title{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;border-bottom:2px solid var(--royal);padding-bottom:7px;margin:0 0 12px}
      .page-title p{margin:0;color:var(--royal);font-size:9px;font-weight:900;letter-spacing:.13em;text-transform:uppercase}
      .page-title h2{font-size:22px;color:var(--ink);letter-spacing:-.025em;margin:3px 0 0}
      .page-title em{font-style:normal;font-size:11px;color:var(--muted);white-space:nowrap}
      .blk{margin-bottom:12px}.blk:last-child{margin-bottom:0}

      table{border-collapse:collapse;width:100%}
      .chip{display:inline-block;padding:3px 9px;border-radius:999px;background:var(--soft);color:var(--tone);font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.05em}

      .empty{color:#9AA2A9;font-style:italic}

      /* Detail */
      .report-section{border:1px solid var(--line);border-radius:9px;overflow:hidden;break-inside:avoid;page-break-inside:avoid}
      .section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;background:var(--paper)}
      .section-head .kicker{display:block;color:var(--muted);font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:.12em}
      .section-head h2{font-size:15px;color:var(--ink);margin:2px 0 0}
      .section-head .cont{font-size:10px;font-weight:700;color:var(--muted)}
      .section-total{text-align:right;white-space:nowrap}
      .section-total b{font-size:21px;line-height:1;letter-spacing:-.05em;display:block}.section-total b small{font-size:11px;color:var(--muted)}
      .section-total .chip{margin-top:4px}
      .detail-table{table-layout:fixed}
      .detail-table th{padding:9px 12px;background:var(--ink);color:#fff;text-align:left;font-size:9px;letter-spacing:.07em;text-transform:uppercase}
      .detail-table th.n{width:10mm}
      .detail-table th.item-col{width:43%}
      .detail-table th.item-res{width:28mm;text-align:center}
      .detail-table td{padding:5px 12px;border-top:1px solid var(--line);vertical-align:middle;font-size:11.5px;line-height:1.35}
      .detail-table td.item-label{font-size:12px}
      .detail-table tbody tr{height:var(--rowh,15mm)}
      .detail-table tbody tr:nth-child(even) td{background:#FAFBFC}
      .item-label{color:var(--deep);font-weight:600;overflow-wrap:anywhere}
      td.item-res{text-align:center}
      .res{display:inline-block;font-size:9.5px;font-weight:900;padding:3px 9px;border-radius:999px;white-space:nowrap}
      .res.yes{background:#DBEEE4;color:#007A38}.res.no{background:#FDE9E4;color:#CB3010}.res.na{background:var(--paper);color:var(--muted)}
      td.item-res .res{min-width:11mm;text-align:center}
      .comments{color:#43536B;overflow-wrap:anywhere}
      .comments .empty{display:block;text-align:left}
      .ph-ref{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#E7EEF7;color:var(--royal);font-size:9px;font-weight:800;white-space:nowrap}
      .comments .ph-ref:first-child{margin-left:0}

      /* Evidence photos: one gallery under the table, sized to the paper that is left */
      .gallery{margin-top:10px;border:1px solid var(--line);border-radius:9px;padding:10px 12px 12px;break-inside:avoid}
      .gal-head{font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:var(--royal);margin-bottom:8px}
      .gal-head small{margin-left:6px;color:var(--muted);font-size:9px;letter-spacing:0}
      .gal-grid{display:grid;grid-template-columns:repeat(var(--gcols,4),var(--gw,40mm));gap:8px;justify-content:start}
      .gal-grid figure{margin:0;min-width:0}
      .gal-img{width:100%;aspect-ratio:4/3;background:var(--paper);border:1px solid var(--line);border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center}
      .gal-img img{width:100%;height:100%;object-fit:contain;display:block}
      .gal-grid figcaption{margin-top:3px;font-size:8.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .gal-grid figcaption b{color:var(--deep)}
      .detail-table tfoot td{background:var(--paper);color:var(--deep);font-size:11.5px;padding:8px 12px}
      .detail-table tfoot b{display:block;color:var(--royal);font-size:9px;text-transform:uppercase;letter-spacing:.07em}
      .detail-table tfoot span{display:block;margin-top:3px}
      .sign{display:grid;grid-template-columns:repeat(2,minmax(0,62mm));gap:28px;margin-top:10mm}
      .sign div span{font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
      .sign div b{display:block;border-bottom:1px solid var(--ink);padding-top:26px}
      .sign div em{display:block;margin-top:6px;font-style:normal;font-size:11px;font-weight:700;color:var(--deep)}
      .sign div i{display:block;margin-top:4px;font-style:normal;font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
    </style></head><body>
    <div class="bar">
      <b>${filename}</b>
      <button type="button" id="save-pdf">Save as PDF</button>
      <button type="button" class="ghost" data-doc="print">Print</button>
      <button type="button" class="ghost" data-doc="${sameTab?'back':'close'}">${sameTab?'Back to the app':'Close'}</button>
      <small id="bar-note">On iPhone or iPad, use <b>Save as PDF</b> — the file opens in the share sheet, where you can save it to Files, send it, or print it.</small>
    </div>
    <div id="docwrap"><div id="doc">
    <section class="sheet cover">
      <div class="rule"></div>
      <div class="brand"><img src="${reportPrintEsc(logoUrl)}" alt="OSQA"><i></i>OSD · Facility Experience Quality Assurance</div>
      <h1>Inspection <span>report.</span></h1>
      <div class="cover-score"><b>${overall}</b> / ${totalMax||100}<span class="chip" style="--tone:${tone.color};--soft:${tone.soft}">${tone.label}</span></div>
      <table class="fact-table"><tbody>${coverFacts}</tbody></table>
      ${journey?`<div class="journey-card">${journey}</div>`:''}
      <div class="cover-foot"><span>Facility Experience Quality Assurance</span><span class="pno"></span></div>
    </section>
    <div id="sheets"></div>
    </div></div>
    <div id="flow">
      ${detailSections}
      <div class="blk" data-sign><div class="sign"><div><span>Auditor signature</span><b>&nbsp;</b><em>${value(report.inspector)}</em></div><div><span>Reviewed by</span><b>&nbsp;</b>${report.approvedBy?`<em>${value(report.approvedBy)}</em>`:''}<i>Quality Officer</i></div></div></div>
    </div>
    <script type="application/json" id="doc-config">${jsonInScript({fileName:String(report.filename||'inspection-report.pdf').replace(/\.pdf$/i,'')+'.pdf',autoPrint:!!autoPrint})}</script>
    <script src="/js/doc-report.js"></script>
    </body></html>`;
}

/**
 * Opens the report in its own window. The window is opened on the click itself — Safari on
 * iPhone and iPad only allows that from a user gesture, and the document is written into it
 * once the artwork has loaded.
 */
/**
 * The report has to be a page of its own: a phone can only print or share the page it is on,
 * never a frame inside it. The window is opened on the click (Safari allows that only from a
 * gesture) and then pointed at the finished document.
 */
async function openInspectionReport(report,{autoPrint=false}={}){
  return openDocPage(()=>buildInspectionReportHtml(report,{autoPrint}),
    {sameTab:()=>buildInspectionReportHtml(report,{autoPrint,sameTab:true}),what:'report'});
}

/**
 * Every printable document in the app — the inspection report and the exports — opens the
 * same way: a window opened on the click itself (Safari on iPhone and iPad allows nothing
 * else), pointed at /report so it has a real address of its own, and handed the finished
 * document by message. about:blank cannot be printed on iOS, which is why this detour exists.
 */
async function openDocPage(build,{sameTab,what='document'}={}){
  const pw=window.open('/report','_blank');
  if(!pw){                                                // pop-ups blocked — Safari does this by default
    let html;
    try{ html=await (sameTab||build)(); }
    catch(err){ showToast(`Could not build the ${what}. `+(err&&err.message||''),true); return false; }
    return askToOpenDoc(html,what);
  }
  let html=null, ready=false, sent=false;
  const send=()=>{
    if(sent||!ready||html==null) return;
    sent=true;
    try{ pw.postMessage({type:'qa-report',html},location.origin); }catch(err){}
    window.removeEventListener('message',onMessage);
  };
  const onMessage=e=>{
    if(e.origin!==location.origin||!e.data||e.data.type!=='qa-report-ready') return;
    ready=true; send();
  };
  window.addEventListener('message',onMessage);
  setTimeout(()=>window.removeEventListener('message',onMessage),60000);
  try{
    html=await build();
    send();
    return true;
  }catch(err){
    window.removeEventListener('message',onMessage);
    try{ pw.close(); }catch{}
    showToast(`Could not build the ${what}. `+(err&&err.message||''),true);
    return false;
  }
}

/**
 * With pop-ups blocked there is no second window to print, so the report takes over this tab:
 * one tap opens it as its own page, where Print and Share work the way the phone expects.
 * Back returns to the app.
 */
function askToOpenDoc(html,what='document'){
  const wrap=document.createElement('div');
  wrap.className='rpt-ask';
  wrap.innerHTML=`<div class="rpt-ask-box">
      <b>Open the ${ovEsc(what)}</b>
      <p>Your browser blocked the new window, so the ${ovEsc(what)} opens in this tab. Print or share it from there, then tap <b>Back to the app</b>.</p>
      <div class="rpt-ask-row"><button type="button" class="btn bt" data-a="go"><svg data-lucide="external-link" width="15" height="15"></svg> Open ${ovEsc(what)}</button>
      <button type="button" class="btn bo" data-a="cancel">Cancel</button></div>
    </div>`;
  document.body.appendChild(wrap);
  lucide.createIcons({nodes:[wrap]});
  wrap.addEventListener('click',e=>{
    const b=e.target.closest('[data-a]');
    if(!b&&e.target!==wrap) return;
    if(b&&b.dataset.a==='go'){ document.open(); document.write(html); document.close(); return; }
    wrap.remove();
  });
  return true;
}

/** Export: opens the report so it can be saved as a PDF (or printed from its own toolbar). */
function printInspectionReport(report){ return openInspectionReport(report,{autoPrint:false}); }
/** Print: opens the report and goes straight to the system print sheet. */
function printInspectionReportNow(report){ return openInspectionReport(report,{autoPrint:true}); }




// ═══════════════════════════════════════════════════════════
// EDIT FROM HISTORY
// ═══════════════════════════════════════════════════════════
/** "Start scoring": the details must be complete before the sections. */
function startNewInspection(){
  const missing=[];
  if(!inVal('meta-facility')) missing.push('meta-facility');
  if(!inVal('meta-division')) missing.push('meta-division');
  if(!inVal('meta-date')) missing.push('meta-date');
  if(!document.getElementById('meta-type').value) missing.push('in-types');
  missing.forEach(id=>document.getElementById(id).classList.add('invalid'));
  if(missing.length){ showToast('Add the building, division, date and inspection type first.',true); return; }
  nav(lastSection);
}

function editInspection(e,id,fallback){
  e.stopPropagation();
  const record=history.find(r=>r.id===id)||fallback;
  if(!record){alert('Record not found.');return;}
  if(!confirm(`Load "${record.facility}${record.division?' — '+record.division:''}" (${record.date}) for editing?\n\nUnsaved current data for ${record.inspector} will be replaced.`))return;
  currentAssignmentId=record.assignmentId||null;
  rebuildInspectorDropdown();
  activeInspector=record.inspector;
  document.getElementById('meta-inspector').value=record.inspector;
  renderInspectorChips();
  document.getElementById('meta-facility').value=record.facility||'';
  document.getElementById('meta-date').value=record.date||'';
  document.getElementById('meta-type').value=record.type||'';
  document.getElementById('meta-division').value=record.division||'';
  const st=getState(record.inspector);
  (record.sections||[]).forEach((sec,si)=>{
    if(si>=SECTIONS.length)return;
    (sec.items||[]).forEach((item,ii)=>{
      if(ii>=st.scores[si].length)return;
      st.scores[si][ii]=item.score;
      st.comments[si][ii]=item.comment||'';
      st.photos[si][ii]=item.photos?item.photos.slice():[];
    });
    st.notes[si]=sec.notes||'';
  });
  editingRecordId=id;lastSubmitted=null;currentReportSaved=false;updatePDFButton();syncFormToState();
  document.getElementById('edit-banner').classList.add('show');
  lucide.createIcons({nodes:[document.getElementById('edit-banner')]});
  updateScoreCardActionBar();
  nav('pg-s0');
}

function cancelEdit(){
  editingRecordId=null;currentAssignmentId=null;currentReportSaved=false;
  clearInspectionState();useAccountInspector();
  document.getElementById('edit-banner').classList.remove('show');
  updateScoreCardActionBar();syncFormToState();nav('pg-home');
}

// ═══════════════════════════════════════════════════════════
// PDF EXPORT
// ═══════════════════════════════════════════════════════════
function exportPDF(){ const r=currentReportForPrint(); if(r) printInspectionReport(r); }
function printPDF(){ const r=currentReportForPrint(); if(r) printInspectionReportNow(r); }
function currentReportForPrint(){
  if(!currentReportSaved){alert(editingRecordId!==null?'Save your changes before printing or downloading the PDF.':'Submit the report before printing or downloading the PDF.');return null;}
  const reportType=document.getElementById('meta-type').value;
  const reportState=curState();
  const reportSections=SECTIONS.map((section,sectionIndex)=>{
    const sectionScore=getSecScore(sectionIndex);
    return {
      title:section.title,score:sectionScore.total,max:sectionScore.max,notes:reportState.notes[sectionIndex],
      items:section.items.map((label,itemIndex)=>({label,score:reportState.scores[sectionIndex][itemIndex],comment:reportState.comments[sectionIndex][itemIndex],photos:reportState.photos[sectionIndex][itemIndex]}))
    };
  });
  return {
    inspector:activeInspector,
    facility:document.getElementById('meta-facility').value,
    division:document.getElementById('meta-division').value,
    date:document.getElementById('meta-date').value,
    type:reportType,
    typeLabel:reportType==='BOQI'?'Beginning of Quarter Inspection (BOQI)':reportType==='EOQI'?'End of Quarter Inspection (EOQI)':reportType==='Follow-up'?'Follow-up and Edit':'—',
    overall:reportSections.reduce((sum,section)=>sum+section.score,0),
    filename:buildFilenameFrom(reportType,document.getElementById('meta-date').value,document.getElementById('meta-facility').value,document.getElementById('meta-division').value,activeInspector),
    sections:reportSections
  };
}

function resetForm(){
  if(!confirm('Start a new inspection for '+activeInspector+'? All unsaved data will be cleared.'))return;
  clearInspectionState();currentAssignmentId=null;useAccountInspector();
  currentReportSaved=false;updatePDFButton();syncFormToState();nav('pg-home');
}


// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
document.querySelectorAll('.ni[data-page]').forEach(n=>n.addEventListener('click',()=>nav(n.dataset.page)));
document.getElementById('app-refresh').addEventListener('click',refreshApp);
document.getElementById('pb-steps').addEventListener('click',e=>{
  const step=e.target.closest('.pb-step');
  if(step) nav(step.dataset.step==='sections'?lastSection:step.dataset.step); // Sections reopens the last one you had open
});
document.getElementById('lb').addEventListener('click',e=>{if(e.target===e.currentTarget)closeLB();});
document.getElementById('meta-date').valueAsDate=new Date();

buildSections();
refreshNav();
lucide.createIcons();
rebuildInspectorDropdown();
renderInspectorChips();
updateProgress();
updatePDFButton();
updateScoreCardActionBar();

// Deep-link support: land directly on the section named in the URL hash.
{
  const initialPageId=hashToPage(location.hash);
  if(initialPageId==='pg-auditor') auId=hashParam(location.hash);
  if(initialPageId==='pg-admin') adTab=['buildings','audit','backup'].includes(hashParam(location.hash))?hashParam(location.hash):'users';
  if(initialPageId==='pg-reports') rpTab=rpTabValid(hashParam(location.hash))?hashParam(location.hash):'insights';
  if(initialPageId!=='pg-home') nav(initialPageId);
  else updateTopBar('pg-home');
}

// ── Boot: Home figures and latest reports (full records load only when a report is opened) ──
(async()=>{
  showOverlay('Connecting to database…');
  try{ await loadHome(); }finally{ hideOverlay(); }
})();

// ═══════════════════════════════════════════════════════════
// AUDITOR PROFILE — an auditor's own "My Assignments", and the profile
// officers, leaders and admins open for any auditor from Team. One page,
// one API call (/api/auditor/profile); actions only appear for the auditor.
// ═══════════════════════════════════════════════════════════
function auVal(id){ return document.getElementById(id).value; }
function auIsManagerView(){ return !!(auData&&!auData.isSelf); }
function openAuditorProfile(id){
  if(!hasPerm('profiles')&&!(currentUser&&id===currentUser.id)){ showToast('Your account does not have access to auditor profiles.',true); return; }
  auId=currentUser&&id===currentUser.id?null:id;
  auData=null;
  nav('pg-auditor');
}
function auNextQuarter(q){ let y=+q.slice(0,4), n=+q.slice(-1)+1; if(n>4){n=1;y++;} return `${y}-Q${n}`; }
function auFmt(d){ return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'}); }
function auDays(a,b){ return Math.round((b-a)/86400000); }

function initAuditorProfile(){
  if(auReady) return;
  auReady=true;
  const sel=document.getElementById('assign-quarter'), cur=ofCurrentQuarter();
  sel.innerHTML=ofQuarterOptions().map(q=>`<option value="${q}">${q}</option>`).join('');
  sel.value=cur;
  sel.addEventListener('change',()=>loadAuditorProfile());
  document.getElementById('au-switch').addEventListener('change',e=>openAuditorProfile(e.target.value));
  document.getElementById('au-back').addEventListener('click',()=>nav(document.getElementById('team-link').dataset.page));
  document.getElementById('au-reports').addEventListener('click',()=>auData&&openReportsForInspector(auData.auditor.name));
  document.getElementById('au-manage').addEventListener('click',()=>{
    if(!auData) return;
    const q=document.getElementById('of-quarter'), f=document.getElementById('of-auditor-filter');
    if(![...q.options].some(o=>o.value===auData.quarter)) q.add(new Option(auData.quarter,auData.quarter));
    if(q.value!==auData.quarter){ q.value=auData.quarter; ofData=null; ofPrevDone=null; ofSelected.clear(); }
    if(![...f.options].some(o=>o.value===auData.auditor.id)) f.add(new Option(auData.auditor.name,auData.auditor.id));
    f.value=auData.auditor.id;
    nav('pg-officer');
  });
  document.getElementById('au-mark-all').addEventListener('click',async()=>{
    try{ await fetch('/api/notifications/read-all',{method:'POST'}); }catch{}
    loadNotifications(); auLoadNotifications();
  });
  const chips=(id,key)=>document.getElementById(id).addEventListener('click',e=>{
    const c=e.target.closest('.rp-chip');
    if(!c) return;
    auFilter[key]=c.dataset.v;
    auRenderBuildings();
  });
  chips('au-status','status'); chips('au-type','type');
  document.getElementById('au-search').addEventListener('input',auRenderBuildings);
  document.getElementById('pg-auditor').addEventListener('click',e=>{
    const t=e.target.closest('[data-start],[data-view],[data-notif],[data-jump]');
    if(!t) return;
    if(t.dataset.start) startAssignedInspection(Number(t.dataset.start));
    else if(t.dataset.view) auViewReport(Number(t.dataset.view));
    else if(t.dataset.notif) auReadNotification(Number(t.dataset.notif));
    else if(t.dataset.jump==='todo'){ auFilter.status='todo'; auRenderBuildings(); document.getElementById('au-buildings').scrollIntoView({behavior:'smooth'}); }
    else if(t.dataset.jump==='next'){ const s=document.getElementById('assign-quarter'); s.value=auNextQuarter(auData.quarter); loadAuditorProfile(); }
  });
  setInterval(()=>{
    if(!appIsOpen()) return;
    if(document.getElementById('pg-auditor').classList.contains('active')&&document.visibilityState==='visible') loadAuditorProfile({quiet:true});
  },60000);
}

async function loadAuditorProfile({quiet=false}={}){
  initAuditorProfile();
  const req=++auReq, params=new URLSearchParams({quarter:auVal('assign-quarter')});
  if(auId) params.set('auditorId',auId);
  const updated=document.getElementById('au-updated');
  if(!quiet) updated.textContent='Loading…';
  try{
    const res=await fetch('/api/auditor/profile?'+params);
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||'Could not load this profile.');
    if(req!==auReq) return;
    // A manager who opens the page without choosing someone sees the first auditor.
    if(data.isSelf&&!data.assignable&&data.auditors.length){ auId=data.auditors[0].id; return loadAuditorProfile({quiet}); }
    const switched=!auData||auData.auditor.id!==data.auditor.id;
    auData=data;
    if(switched){ auFilter.status=data.isSelf?'todo':'all'; auFilter.type='all'; document.getElementById('au-search').value=''; }
    renderAuditorProfile();
    if(document.getElementById('pg-auditor').classList.contains('active')) updateTopBar('pg-auditor');
    if(location.hash.slice(1).split('/')[0]==='pg-auditor'){
      const wanted=auId?`pg-auditor/${auId}`:'pg-auditor';
      if(location.hash!=='#'+wanted) history_replaceHash(wanted);
    }
    updated.textContent='Updated '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  }catch(err){
    if(req!==auReq) return;
    updated.textContent=err.message;
  }
}
function history_replaceHash(h){ window.history.replaceState(null,'','#'+h); }

function renderAuditorProfile(){
  const d=auData, q=d.quarter, list=d.assignments, a=d.auditor, self=d.isSelf;
  const cur=ofCurrentQuarter(), nxt=auNextQuarter(cur);
  const qSel=document.getElementById('assign-quarter');
  qSel.innerHTML=ofQuarterOptions([...d.quarters,q]).map(v=>`<option value="${v}">${v}${v===cur?' (current)':v===nxt?' (next)':''}</option>`).join('');
  qSel.value=q;

  // Header
  const first=a.name.split(/\s+/)[0];
  document.getElementById('au-avatar').textContent=ofInitials(a.name);
  document.getElementById('au-eyebrow').textContent=self?'My assignments':`${adRoleLabels()[a.role]||'Team member'} profile`;
  document.getElementById('au-title').innerHTML=self?'My <span>Assignments</span>':`${ovEsc(first)} <span>${ovEsc(a.name.split(/\s+/).slice(1).join(' '))}</span>`;
  document.getElementById('au-sub').textContent=self
    ?'Your buildings for the quarter, the inspection schedule and your results.'
    :`@${a.username}${a.status!=='active'?' · Suspended':''} · ${adRoleLabels()[a.role]||''} — assignments, completion and quality of work.`;
  document.getElementById('au-back').hidden=self;
  const sw=document.getElementById('au-switch');
  sw.hidden=self||!d.auditors.length;
  sw.innerHTML=d.auditors.map(x=>`<option value="${ovEsc(x.id)}">${ovEsc(assigneeLabel(x))}${x.status!=='active'?' (suspended)':''}</option>`).join('');
  sw.value=a.id;
  document.getElementById('au-reports').hidden=self||!hasPerm('reports');
  document.getElementById('au-manage').hidden=self||!d.canManage;
  document.getElementById('au-mark-all').hidden=!self;
  document.getElementById('au-feed-ic-inbox').hidden=!self;
  document.getElementById('au-feed-ic-activity').hidden=self;

  // Quarter tiles
  const done=list.filter(x=>x.status==='completed'), pending=list.filter(x=>x.status==='pending');
  const pct=list.length?Math.round(done.length/list.length*100):0;
  const scores=done.map(x=>x.score).filter(n=>typeof n==='number');
  const avg=scores.length?Math.round(scores.reduce((t,n)=>t+n,0)/scores.length):null;
  if(self&&q===cur) document.getElementById('ns-assign').textContent=pending.length+d.carriedOver.length;
  const bar=p=>`<div class="ov-bar" style="margin-top:10px"><i style="width:${p}%"></i></div>`;
  const note=t=>`<small style="display:block;color:var(--muted);font-size:.7rem;margin-top:4px">${t}</small>`;
  const tile=(icon,value,label,extra,{jump,color}={})=>`<div class="hs-card${jump?' clickable':''}"${jump?` data-jump="${jump}"`:''}><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div><b${color?` style="color:${color}"`:''}>${value}</b><span>${label}</span>${extra}</div>`;
  document.getElementById('au-stats').innerHTML=
    tile('circle-check',`${pct}%`,`Completed · ${q}`,note(`${done.length} of ${list.length} buildings`)+bar(pct))+
    tile('hourglass',pending.length,'Still to inspect',note(d.carriedOver.length?`+ ${d.carriedOver.length} carried over`:'This quarter'),{jump:'todo'})+
    tile('trending-up',avg??'–','Quarter average',note(avg!=null?grade(avg).label:'No results yet'),{color:avg!=null?grade(avg).ink:''})+
    tile('calendar-plus',d.upcoming.total,`Assigned for ${d.upcoming.quarter}`,note(d.upcoming.total?'Open the next quarter':'Nothing yet'),{jump:'next'});

  // Carried over
  document.getElementById('au-carried').hidden=!d.carriedOver.length;
  document.getElementById('au-carried-list').innerHTML=d.carriedOver.map(x=>auCard(x,{carried:true})).join('');

  auRenderSchedule();
  if(self) auLoadNotifications(); else auRenderActivity();
  auRenderBuildings();
  auRenderPerformance();
  lucide.createIcons();
}

function auRenderSchedule(){
  const q=auData.quarter, list=auData.assignments;
  const y=+q.slice(0,4), m0=(+q.slice(-1)-1)*3;
  const start=new Date(y,m0,1), end=new Date(y,m0+3,0), today=new Date(); today.setHours(12,0,0,0);
  const span=auDays(start,end)+1;
  const pos=today<start?0:today>end?100:Math.min(100,Math.round((auDays(start,today)+.5)/span*100));
  const left=auDays(today,end);
  const status=today<start?`Starts in ${auDays(today,start)} days`:today>end?'Quarter ended':left===0?'Last day of the quarter':`${left} days left in the quarter`;
  const phases=[['BOQI','Beginning of quarter',start,new Date(y,m0+1,0)],['EOQI','End of quarter',new Date(y,m0+2,1),end]];
  document.getElementById('au-schedule').innerHTML=`<div class="au-sched">
    <div class="au-months">${[0,1,2].map(i=>{
      const tag=i===0?'<em class="BOQI">BOQI</em>':i===2?'<em class="EOQI">EOQI</em>':'';
      return `<span>${new Date(y,m0+i,1).toLocaleDateString('en-GB',{month:'long'})}${tag}</span>`;}).join('')}</div>
    <div class="au-track"><i style="width:${pos}%"></i>${today>=start&&today<=end?`<b style="left:${pos}%">Today</b>`:''}</div>
    <div class="au-track-note"><span>${auFmt(start)}</span><strong>${status}</strong><span>${auFmt(end)}</span></div>
    <div class="au-phases">${phases.map(([type,label,ws,we])=>{
      const st=today<ws?['soon',`Opens in ${auDays(today,ws)} days`]:today>we?['closed','Window passed']:['open',auDays(today,we)?`Open · ${auDays(today,we)} days left`:'Open · last day'];
      const ofType=list.filter(x=>x.type===type), doneN=ofType.filter(x=>x.status==='completed').length;
      return `<div class="au-phase ${st[0]}">
        <div class="au-phase-hd"><span class="au-type ${type}">${type}</span><span class="au-state ${st[0]}">${st[1]}</span></div>
        <b>${label}</b><small>${auFmt(ws)} – ${auFmt(we)}</small>
        ${ofType.length?ovPct(doneN,ofType.length)+`<small>${doneN} of ${ofType.length} done</small>`:'<small>No buildings of this type</small>'}
      </div>`;}).join('')}</div>
  </div>`;
}

async function auLoadNotifications(){
  document.getElementById('au-feed-eyebrow').textContent='Inbox';
  document.getElementById('au-feed-title').textContent='Assignment Notifications';
  try{
    const res=await fetch('/api/notifications');
    if(!res.ok) return;
    const {notifications}=await res.json();
    const items=notifications.filter(n=>n.type==='assignment').slice(0,8);
    document.getElementById('au-feed').innerHTML=items.length?items.map(n=>`
      <li class="${n.read?'':'unread '}clickable" data-notif="${n.id}" title="${n.read?'':'Mark as read'}">
        <span class="dot" style="background:${n.read?'#9fb3c8':'var(--teal)'}"><svg data-lucide="bell" width="14" height="14"></svg></span>
        <div><b>${ovEsc(n.title)}</b><div>${ovEsc(n.body||'')}</div><small>${timeAgo(n.createdAt)}${n.read?'':' · New'}</small></div>
      </li>`).join(''):'<li class="ov-empty" style="display:block">No assignment notifications yet.</li>';
    lucide.createIcons();
  }catch{}
}
async function auReadNotification(id){
  try{ await fetch(`/api/notifications/${id}/read`,{method:'POST'}); }catch{}
  loadNotifications(); auLoadNotifications();
}
function auRenderActivity(){
  document.getElementById('au-feed-eyebrow').textContent='Activity';
  document.getElementById('au-feed-title').textContent='Recent Activity';
  const ev=auData.events;
  document.getElementById('au-feed').innerHTML=ev.length?ev.map(e=>e.kind==='completed'
    ?`<li><span class="dot" style="background:${e.score!=null?grade(e.score).color:'var(--teal)'};color:${e.score!=null?grade(e.score).on:'#fff'}"><svg data-lucide="check" width="14" height="14"></svg></span>
       <div>Completed <b>${ovEsc(e.building)}</b>${e.score!=null?` — ${e.score}/100`:''}<small>${e.quarter} ${e.type} · ${timeAgo(e.at)}</small></div></li>`
    :`<li><span class="dot" style="background:var(--royal)"><svg data-lucide="clipboard-list" width="14" height="14"></svg></span>
       <div>Assigned <b>${ovEsc(e.building)}</b>${e.actor?` by ${ovEsc(e.actor)}`:''}<small>${e.quarter} ${e.type} · ${timeAgo(e.at)}</small></div></li>`
  ).join(''):'<li class="ov-empty" style="display:block">No activity yet.</li>';
}

function auAnsweredPct(){
  const st=curState();
  const all=st.scores.flat();
  return all.length?Math.round(all.filter(v=>v!==null).length/all.length*100):0;
}
function auCard(x,{carried=false}={}){
  const self=auData.isSelf;
  const meta=[x.division,x.area,x.location].filter(Boolean).join(' · ');
  if(x.status==='completed'){
    const g=typeof x.score==='number'?grade(x.score):null;
    return `<div class="au-card done">
      <span class="au-type ${x.type}">${x.type}</span>
      <div class="au-main"><b>${ovEsc(x.buildingName)}</b><small>${ovEsc(meta)}</small>
        <small>Completed ${x.inspectionDate?ovEsc(x.inspectionDate):''}${x.completedAt?` · ${timeAgo(x.completedAt)}`:''}</small></div>
      ${g?`<span class="ov-pill" style="background:${g.soft};color:${g.ink}">${x.score} · ${g.label}</span>`:''}
      ${x.review?reviewMark(x.review):''}
      ${x.inspectionId?`<button class="ad-btn" data-view="${x.inspectionId}">View report</button>`:''}
    </div>`;
  }
  const resuming=self&&currentAssignmentId===x.id&&auAnsweredPct()>0&&!currentReportSaved;
  return `<div class="au-card${carried?' carried':''}${resuming?' current':''}">
    <span class="au-type ${x.type}">${x.type}</span>
    <div class="au-main"><b>${ovEsc(x.buildingName)}</b><small>${ovEsc(meta)}</small>
      <small>${carried?`${x.quarter} · `:''}${x.assignedBy?`Assigned by ${ovEsc(x.assignedBy)} · `:''}${x.assignedAt?timeAgo(x.assignedAt):''}</small></div>
    ${x.dueDate?`<span class="due ${dueState(x).cls}" title="Deadline ${ovEsc(dueFmt(x.dueDate))}">${ovEsc(dueFmt(x.dueDate))} · ${ovEsc(dueState(x).note)}</span>`:''}
    ${resuming?`<span class="au-progress">${auAnsweredPct()}% answered</span>`:''}
    ${self?`<button class="btn bt" data-start="${x.id}">${resuming?'Continue':'Start inspection'} <svg data-lucide="arrow-right" width="14" height="14"></svg></button>`
      :'<span class="ov-pill pending">Pending</span>'}
  </div>`;
}
function auRenderBuildings(){
  if(!auData) return;
  const list=auData.assignments, term=auVal('au-search').trim().toLowerCase();
  const counts={todo:list.filter(x=>x.status==='pending').length,done:list.filter(x=>x.status==='completed').length,all:list.length};
  const labels={todo:'To inspect',done:'Completed',all:'All'};
  document.getElementById('au-status').innerHTML=Object.keys(labels).map(k=>`<button class="rp-chip${auFilter.status===k?' active':''}" data-v="${k}">${labels[k]} ${counts[k]}</button>`).join('');
  document.getElementById('au-type').innerHTML=['all','BOQI','EOQI'].map(k=>`<button class="rp-chip${auFilter.type===k?' active':''}" data-v="${k}">${k==='all'?'Both types':k}</button>`).join('');
  const rows=list.filter(x=>
    (auFilter.status==='all'||(auFilter.status==='todo'?x.status==='pending':x.status==='completed')) &&
    (auFilter.type==='all'||x.type===auFilter.type) &&
    (!term||x.buildingName.toLowerCase().includes(term)||(x.area||'').toLowerCase().includes(term)||(x.location||'').toLowerCase().includes(term)));
  const box=document.getElementById('au-list');
  if(!list.length){
    box.innerHTML=`<div class="au-empty">${auData.isSelf?`No buildings are assigned to you for ${auData.quarter} yet — you'll get a notification when your officer assigns some.`:`No buildings assigned to ${ovEsc(auData.auditor.name)} for ${auData.quarter}.`}</div>`;
    return;
  }
  if(!rows.length){
    box.innerHTML=`<div class="au-empty">${auFilter.status==='todo'&&!term?'All caught up — every building for this quarter has been inspected.':'Nothing matches these filters.'}</div>`;
    return;
  }
  const html=[];
  ['BOQI','EOQI'].forEach(type=>{
    const group=rows.filter(x=>x.type===type);
    if(!group.length) return;
    html.push(`<div class="au-group"><span class="au-type ${type}">${type}</span>${type==='BOQI'?'Beginning of quarter':'End of quarter'} <small>${group.length} building${group.length===1?'':'s'}</small></div>`);
    group.forEach(x=>html.push(auCard(x)));
  });
  box.innerHTML=html.join('');
  lucide.createIcons();
}

function auRenderPerformance(){
  const p=auData.performance;
  const tile=(icon,value,label,extra='',color='')=>`<div class="hs-card"><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div><b${color?` style="color:${color}"`:''}>${value}</b><span>${label}</span>${extra}</div>`;
  const note=t=>`<small style="display:block;color:var(--muted);font-size:.7rem;margin-top:4px">${t}</small>`;
  const typeNote=['BOQI','EOQI'].map(t=>`${t} ${p.byType[t].avgScore??'–'}`).join(' · ');
  document.getElementById('au-perf').innerHTML=
    tile('clipboard-check',`${p.completed}/${p.assigned}`,'Inspections completed',note('All quarters'))+
    tile('award',p.avgScore??'–','All-time average',note(p.avgScore!=null?`${grade(p.avgScore).label} · ${typeNote}`:'No results yet'),p.avgScore!=null?grade(p.avgScore).ink:'')+
    tile('timer',p.avgTurnaroundDays!=null?`${p.avgTurnaroundDays}d`:'–','Average turnaround',note('From assignment to submission'));

  const ctx=document.getElementById('au-q-chart');
  if(auCharts.q) auCharts.q.destroy();
  auCharts.q=new Chart(ctx,{
    type:'line',
    data:{labels:p.byQuarter.map(x=>x.quarter),datasets:[
      {label:'Average score',data:p.byQuarter.map(x=>x.avgScore),borderColor:'#26A8AB',backgroundColor:'#26A8AB',borderWidth:2,pointRadius:4,pointBorderColor:'#fff',pointBorderWidth:2,tension:.25,spanGaps:true},
    ]},
    options:vizOptions({scales:{y:{beginAtZero:true,max:100}},
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>{ const x=p.byQuarter[c.dataIndex]; return `${c.raw??'–'} average · ${x.completed} of ${x.assigned} completed`; }}}}}),
  });

  const secs=[...p.sections].sort((a,b)=>b.avg-a.avg);
  if(auCharts.sec) auCharts.sec.destroy();
  document.getElementById('au-sec-empty').hidden=!!secs.length;
  document.getElementById('au-sec-chart').hidden=!secs.length;
  if(secs.length){
    auCharts.sec=new Chart(document.getElementById('au-sec-chart'),{
      type:'bar',
      data:{labels:secs.map(s=>s.title),datasets:[{label:'Average /10',data:secs.map(s=>s.avg),backgroundColor:secs.map(s=>grade(s.avg*10).color),borderRadius:5}]},
      options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
        scales:{x:{beginAtZero:true,max:10,ticks:{font:{family:'Cairo'}}},y:{ticks:{font:{family:'Cairo',weight:'700',size:11}}}},
        plugins:{legend:{display:false}}},
    });
  }

  document.getElementById('au-findings').innerHTML=p.findings.length?p.findings.map(f=>`<tr>
      <td><b style="white-space:normal">${ovEsc(f.item)}</b></td><td>${ovEsc(f.section)}</td>
      <td><span class="ov-pill pending">${f.count}×</span><small>of ${p.completed} inspection${p.completed===1?'':'s'}</small></td>
    </tr>`).join(''):`<tr><td colspan="3" class="ov-empty">${p.completed?'No items marked non-compliant — nothing to follow up.':'No completed inspections yet.'}</td></tr>`;
}

function auViewReport(id){ openReport(id); }
/** Opens Reports filtered to one auditor (everything else cleared). */
function openReportsForInspector(name){
  try{ localStorage.setItem('rp-state',JSON.stringify({filters:{'rp-inspector':name},group:'quarter',sort:'newest'})); }catch{}
  if(rpData){
    RP_FILTER_IDS.forEach(id=>document.getElementById(id).value='');
    const sel=document.getElementById('rp-inspector');
    if(![...sel.options].some(o=>o.value===name)) sel.add(new Option(name,name));
    sel.value=name; rpGroup='quarter'; rpCascade(); rpSave();
  }
  rpTab='builder';
  nav('pg-reports');
}

function clearInspectionState(){
  lastSubmitted=null;
  allState[activeInspector]={
    scores:SECTIONS.map(s=>s.items.map(()=>null)),
    comments:SECTIONS.map(s=>s.items.map(()=>'')),
    photos:SECTIONS.map(s=>s.items.map(()=>[])),
    notes:SECTIONS.map(()=>''),
  };
}
function startAssignedInspection(id){
  const x=[...(auData?.assignments||[]),...(auData?.carriedOver||[])].find(a=>a.id===id);
  if(!x) return;
  if(editingRecordId!==null){
    if(!confirm('You are editing a saved record. Start this assignment instead? Unsaved edits will be lost.'))return;
    cancelEdit();
  }
  // What an auditor submits carries their own account name.
  const me=currentUser?.name;
  if(me&&activeInspector!==me){
    rebuildInspectorDropdown();
    activeInspector=me;
    document.getElementById('meta-inspector').value=me;
    renderInspectorChips();
  }
  const answered=auAnsweredPct()>0&&!currentReportSaved;
  const resuming=currentAssignmentId===id&&answered;
  if(answered&&!resuming&&!confirm(`You have unsaved answers from another inspection. Start ${x.buildingName} with a clean form? Those answers will be cleared.`)) return;
  if(!resuming) clearInspectionState();
  currentAssignmentId=id;
  document.getElementById('meta-facility').value=x.buildingName;
  document.getElementById('meta-division').value=x.division;
  document.getElementById('meta-type').value=x.type;
  if(!resuming) document.getElementById('meta-date').valueAsDate=new Date();
  currentReportSaved=false; updatePDFButton();
  syncFormToState(); updateProgress();
  nav(resuming?lastSection:'pg-s0');
}

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════
function escapeHtmlAttr(s){ return String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function timeAgo(iso){
  const then=new Date(iso.replace(' ','T')+'Z').getTime();
  const mins=Math.max(0,Math.round((Date.now()-then)/60000));
  if(mins<1)return'just now';
  if(mins<60)return mins+'m ago';
  const hrs=Math.round(mins/60);
  if(hrs<24)return hrs+'h ago';
  return Math.round(hrs/24)+'d ago';
}
async function loadNotifications(){
  try{
    const res=await fetch('/api/notifications');
    if(!res.ok)return;
    const {notifications,unreadCount}=await res.json();
    setNotifBadge(unreadCount);
    const list=document.getElementById('notif-list');
    if(!notifications.length){ list.innerHTML='<div class="notif-empty">No notifications yet.</div>'; return; }
    list.innerHTML=notifications.map(n=>`
      <div class="notif-item ${n.read?'':'unread'}" data-id="${n.id}" data-link="${escapeHtmlAttr(n.link||'')}">
        <div class="n-title">${n.read?'':'<span class="n-dot"></span>'}${escapeHtmlAttr(n.title)}</div>
        ${n.body?`<div class="n-body">${escapeHtmlAttr(n.body)}</div>`:''}
        <div class="n-time">${timeAgo(n.createdAt)}</div>
      </div>`).join('');
  }catch{}
}
document.getElementById('notif-list').addEventListener('click',(e)=>{
  const item=e.target.closest('.notif-item');
  if(item) openNotification(Number(item.dataset.id),item.dataset.link);
});
async function openNotification(id,link){
  document.getElementById('notif-panel').hidden=true;
  try{ await fetch('/api/notifications/'+id+'/read',{method:'POST'}); }catch{}
  loadNotifications();
  if(link) location.hash=link.replace(/^#/,'');
}
document.getElementById('notif-bell').addEventListener('click',(e)=>{
  e.stopPropagation();
  const panel=document.getElementById('notif-panel');
  panel.hidden=!panel.hidden;
  if(!panel.hidden) loadNotifications();
});
document.getElementById('notif-mark-all').addEventListener('click',async(e)=>{
  e.stopPropagation();
  try{ await fetch('/api/notifications/read-all',{method:'POST'}); }catch{}
  loadNotifications();
});
document.addEventListener('click',(e)=>{
  const wrap=document.getElementById('notif-bell-wrap');
  if(!wrap.contains(e.target)) document.getElementById('notif-panel').hidden=true;
});
// ── Live notifications ──
// A light check every 15 seconds while the app is on screen (every minute in a background tab), and at
// once when the tab comes back into view. Anything new shows as a card, rings the bell, refreshes the
// lists it affects and — when allowed — raises a desktop alert while the tab is in the background.
function setNotifBadge(n){
  try{ if(navigator.setAppBadge){ n>0?navigator.setAppBadge(n).catch(()=>{}):navigator.clearAppBadge().catch(()=>{}); } }catch{}
  const badge=document.getElementById('notif-badge');
  badge.hidden=!(n>0); badge.textContent=n>9?'9+':String(n||0);
  document.title=(n>0?`(${n>9?'9+':n}) `:'')+document.title.replace(/^\(\d+\+?\) /,'');
}
function scheduleNotifPoll(){
  clearTimeout(notifTimer);
  notifTimer=setTimeout(pollNotifications,document.visibilityState==='visible'?30000:60000);
}
async function pollNotifications(){
  if(notifBusy) return;
  notifBusy=true;
  let stopped=false;
  try{
    const res=await fetch('/api/notifications/poll'+(notifCursor!=null?'?after='+notifCursor:''),{cache:'no-store'});
    if(res.status===401){ stopped=true; return; } // signed out elsewhere: stop asking
    if(!res.ok) return;
    const d=await res.json();
    setNotifBadge(d.unreadCount);
    if(notifCursor!=null&&d.fresh.length) announceNotifications(d.fresh);
    notifCursor=Math.max(notifCursor||0,d.latestId||0);
  }catch{ /* offline: try again on the next tick */ }
  finally{ notifBusy=false; if(stopped) clearTimeout(notifTimer); else scheduleNotifPoll(); }
}
function announceNotifications(list){
  const last=list[list.length-1];
  document.getElementById('nt-title').textContent=list.length>1?`${list.length} new notifications`:last.title;
  document.getElementById('nt-text').textContent=list.length>1?last.title:(last.body||'');
  const toast=document.getElementById('notif-toast');
  toast.dataset.id=last.id; toast.dataset.link=last.link||'';
  toast.hidden=false;
  clearTimeout(toast._timer); toast._timer=setTimeout(()=>{ toast.hidden=true; },10000);
  const bell=document.getElementById('notif-bell');
  bell.classList.remove('ring'); void bell.offsetWidth; bell.classList.add('ring');
  lucide.createIcons({nodes:[toast]});
  loadNotifications();
  const types=new Set(list.map(n=>n.type));
  if(types.has('submission')||types.has('resubmission')||types.has('review')){
    refreshReviewBadge();
    if(document.getElementById('pg-library').classList.contains('active')) loadLibrary();
  }
  if(types.has('assignment')&&document.getElementById('pg-auditor').classList.contains('active')){ loadAuditorProfile({quiet:true}); auLoadNotifications(); }
  if(types.has('submission')&&document.getElementById('pg-officer').classList.contains('active')) loadOfficer({quiet:true});
  if(!pushState.on&&document.visibilityState!=='visible'&&'Notification' in window&&Notification.permission==='granted'){
    list.slice(-3).forEach(n=>{
      try{
        const alert=new Notification(n.title,{body:n.body||'',tag:'qa-'+n.id});
        alert.onclick=()=>{ window.focus(); openNotification(n.id,n.link); alert.close(); };
      }catch{ /* some browsers only allow alerts from a service worker */ }
    });
  }
}
document.getElementById('nt-open').addEventListener('click',()=>{
  const t=document.getElementById('notif-toast'); t.hidden=true;
  openNotification(Number(t.dataset.id),t.dataset.link);
});
document.getElementById('nt-close').addEventListener('click',()=>{ document.getElementById('notif-toast').hidden=true; });
// ── Notifications on this device (Web Push) ──
// On an iPhone or iPad this works once OSQA is added to the Home Screen and opened from there
// (iOS 16.4 and later); computers and Android phones can turn it on straight away. A device gets
// notifications while it is signed in: signing out stops them, signing in again resumes them.
const pushState={on:false,reg:null,key:null};
const b64uBytes=t=>{ const s=t.replace(/-/g,'+').replace(/_/g,'/'), p=s+'='.repeat((4-s.length%4)%4), bin=atob(p); return Uint8Array.from(bin,c=>c.charCodeAt(0)); };
function pushIosBrowser(){ const d=document.documentElement.dataset; return d.os==='ios'&&d.display!=='standalone'; }
function pushRender(state){
  const box=document.getElementById('notif-push');
  box.className='notif-push'+(state==='on'?' on':state==='muted'?' muted':'');
  const icon=n=>`<svg data-lucide="${n}" width="18" height="18"></svg>`;
  const views={
    off:`${icon('bell-ring')}<div><b>Get notifications on this device</b>New assignments, reviews and reports show on the lock screen, even when OSQA is closed.<div class="np-btns"><button class="primary" data-push="on">Turn on</button></div></div>`,
    on:`${icon('bell-ring')}<div><b>Notifications are on for this device</b>They stop when you sign out, and start again when you sign in.<div class="np-btns"><button data-push="test">Send a test</button><button data-push="off">Turn off</button></div></div>`,
    ios:`${icon('smartphone')}<div><b>Notifications on this iPhone</b>Add OSQA to your Home Screen first: tap Share, then “Add to Home Screen”. Open OSQA from the Home Screen and turn notifications on here.</div>`,
    blocked:`${icon('bell-off')}<div><b>Notifications are blocked</b>Allow them for OSQA in this device’s settings, then come back here.</div>`,
    muted:`${icon('bell-off')}<div><b>Notifications are off</b>You chose not to receive them. Security alerts about your account still come through.<div class="np-btns"><button data-push="settings">Open settings</button></div></div>`,
  };
  box.hidden=!views[state];
  if(views[state]){ box.innerHTML=views[state]; lucide.createIcons({nodes:[box]}); }
}
async function pushInit(){
  if(currentUser&&currentUser.notificationsEnabled===false){ pushRender('muted'); return; }
  try{
    if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window)){ pushRender(pushIosBrowser()?'ios':'none'); return; }
    const [reg,cfg]=await Promise.all([
      navigator.serviceWorker.register('/sw.js').catch(()=>null),
      fetch('/api/push/key').then(r=>r.ok?r.json():null).catch(()=>null),
    ]);
    if(!reg||!cfg||!cfg.enabled){ pushRender('none'); return; }
    pushState.reg=reg; pushState.key=cfg.publicKey;
    if(Notification.permission==='denied'){ pushRender('blocked'); return; }
    const sub=await reg.pushManager.getSubscription();
    if(sub&&Notification.permission==='granted'){
      const st=await fetch('/api/push/status?endpoint='+encodeURIComponent(sub.endpoint)).then(r=>r.json()).catch(()=>({}));
      if(st.on){ pushState.on=true; pushRender('on'); return; }
      await pushSave(sub,true); return;                             // signed in again on this device: on again, quietly
    }
    pushRender('off');
  }catch{ pushRender('none'); }
}
async function pushSave(sub,quiet){
  const res=await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscription:sub.toJSON(),quiet})});
  const d=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(d.error||'The server did not accept it.');
  pushState.on=true; pushRender('on');
  if(!quiet) showToast(d.sent?'Notifications are on — the first one is on its way':'Notifications are on');
}
async function pushAction(what,btn){
  btn.disabled=true;
  try{
    if(what==='on'){
      const perm=await Notification.requestPermission();                 // must follow the tap directly (iPhone)
      if(perm!=='granted'){ pushRender(perm==='denied'?'blocked':'off'); return; }
      const reg=pushState.reg||await navigator.serviceWorker.ready;
      const sub=await reg.pushManager.getSubscription()||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64uBytes(pushState.key)});
      await pushSave(sub,false);
    }else if(what==='off'){
      const sub=await pushState.reg?.pushManager.getSubscription();
      if(sub){
        await fetch('/api/push/subscribe',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})}).catch(()=>{});
        await sub.unsubscribe().catch(()=>{});
      }
      pushState.on=false; pushRender('off'); showToast('Notifications are off for this device');
    }else if(what==='settings'){
      document.getElementById('notif-panel').hidden=true; openSettings(); return;
    }else if(what==='test'){
      const d=await fetch('/api/push/test',{method:'POST'}).then(r=>r.json()).catch(()=>({}));
      showToast(d.sent?'Test sent — it should appear in a moment':'No device received it — turn notifications off and on again',!d.sent);
    }
  }catch(err){ showToast('Notifications: '+(err&&err.message||err),true); }
  finally{ if(btn.isConnected) btn.disabled=false; }
}
document.getElementById('notif-push').addEventListener('click',e=>{
  e.stopPropagation();
  const b=e.target.closest('[data-push]'); if(b) pushAction(b.dataset.push,b);
});
// A tap on a notification while OSQA is already open: go to the page it is about.
navigator.serviceWorker?.addEventListener('message',e=>{
  if(e.data?.type!=='open'||!e.data.url) return;
  const u=new URL(e.data.url,location.origin);
  if(u.hash&&u.hash!==location.hash) location.hash=u.hash;
});
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'){ pollNotifications(); } else scheduleNotifPoll(); });
window.addEventListener('focus',()=>pollNotifications());
window.addEventListener('online',()=>pollNotifications());
setInterval(()=>{ if(appIsOpen()&&document.visibilityState==='visible') refreshReviewBadge(); },60000);
loadNotifications();
pollNotifications();

// ═══════════════════════════════════════════════════════════
// TEAM OVERVIEW (Quality Leader)
// ═══════════════════════════════════════════════════════════
/** A value written into a <script> block of a generated page: as JSON, with every "<" escaped so
 *  no text (a file name, a building) can close the script and run code of its own. */
function jsonInScript(v){ return JSON.stringify(v).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029'); }
function ovEsc(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function ovPct(done,total){
  const p=total?Math.round(done/total*100):0;
  return `<div class="ov-pct"><div class="ov-bar"><i style="width:${p}%"></i></div><span>${p}%</span></div>`;
}
function ovScore(v){ return v==null?'<span style="color:var(--muted)">–</span>':`<span class="ov-score" style="color:${grade(v).ink}">${v}</span>`; }

/* ── Deadlines ─────────────────────────────────────────────────
 * A deadline is a plain calendar date (YYYY-MM-DD) set by whoever assigns the quarter.
 * Everyone then reads the same chip: when it falls, how long is left, and — once the
 * inspection is in — whether it was met. Dates are compared as text, never in UTC, so a
 * deadline never shifts by a day because of the phone's time zone. */
/** Refresh: the whole app again, on the same page. Unsubmitted inspection work lives only in this tab, so ask first. */
function refreshApp(){
  const answered=typeof auAnsweredPct==='function'?auAnsweredPct():0;
  if(answered>0&&!currentReportSaved&&!confirm('You have an inspection in progress that has not been submitted. Refreshing will clear it.\n\nRefresh anyway?')) return;
  document.getElementById('app-refresh').classList.add('spin');
  location.reload();
}
/** The report or export can take over this tab when pop-ups are blocked; the app's pollers must then stand down. */
function appIsOpen(){ return !!document.getElementById('pbar'); }
function dueToday(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function dueDays(date,from){ return Math.round((Date.parse(date+'T12:00:00Z')-Date.parse((from||dueToday())+'T12:00:00Z'))/86400000); }
function dueFmt(date){
  const d=new Date(date+'T12:00:00'), o={day:'2-digit',month:'short'};
  if(d.getFullYear()!==new Date().getFullYear()) o.year='numeric';
  return d.toLocaleDateString('en-GB',o);
}
function dueDayWord(n){ return `${n} day${n===1?'':'s'}`; }
function dueState(row){
  const date=row&&row.dueDate;
  if(!date) return null;
  if(row.status==='completed'){
    const late=row.inspectionDate&&row.inspectionDate>date;
    return {date,cls:late?'late':'met',text:dueFmt(date),note:late?`${dueDayWord(dueDays(row.inspectionDate,date))} late`:'Met'};
  }
  const left=dueDays(date);
  if(left<0) return {date,cls:'over',text:dueFmt(date),note:`${dueDayWord(-left)} overdue`};
  if(left===0) return {date,cls:'soon',text:dueFmt(date),note:'Due today'};
  return {date,cls:left<=7?'soon':'',text:dueFmt(date),note:`${dueDayWord(left)} left`};
}
function dueChip(row){
  const s=dueState(row);
  return s?`<span class="due ${s.cls}">${ovEsc(s.text)}</span><small>${ovEsc(s.note)}</small>`
    :'<span style="color:var(--muted)">—</span>';
}
function dueOverdue(rows){ return rows.filter(b=>{ const s=dueState(b); return s&&(s.cls==='over'||s.cls==='late'); }).length; }
function ovSetOptions(sel,values,allLabel){
  const cur=sel.value;
  sel.innerHTML=`<option value="all">${allLabel}</option>`+values.map(v=>`<option value="${ovEsc(v)}">${ovEsc(v)}</option>`).join('');
  sel.value=values.includes(cur)?cur:'all';
}
function initOverview(){
  if(ovReady) return;
  ovReady=true;
  const cur=`${new Date().getFullYear()}-Q${Math.floor(new Date().getMonth()/3)+1}`;
  const q=document.getElementById('ov-quarter');
  q.innerHTML=`<option value="all">All quarters</option><option value="${cur}">${cur}</option>`;
  q.value=cur;
  ['ov-quarter','ov-type','ov-division'].forEach(id=>document.getElementById(id).addEventListener('change',loadOverview));
  document.getElementById('ov-b-search').addEventListener('input',renderOvBuildings);
  document.getElementById('ov-b-status').addEventListener('change',renderOvBuildings);
  document.getElementById('ov-aud-rows').addEventListener('click',e=>{
    const tr=e.target.closest('tr[data-auditor]');
    if(tr) openAuditorProfile(tr.dataset.auditor);
  });
  document.getElementById('ov-div-rows').addEventListener('click',e=>{
    const tr=e.target.closest('tr[data-division]');
    if(!tr) return;
    const sel=document.getElementById('ov-division');
    sel.value=sel.value===tr.dataset.division?'all':tr.dataset.division;
    loadOverview();
  });
}
async function loadOverview(){
  initOverview();
  const params=new URLSearchParams({
    quarter:document.getElementById('ov-quarter').value,
    type:document.getElementById('ov-type').value,
    division:document.getElementById('ov-division').value,
  });
  document.getElementById('ov-updated').textContent='Loading…';
  try{
    const res=await fetch('/api/leader/overview?'+params);
    if(!res.ok) throw new Error((await res.json()).error||'Could not load the overview.');
    ovData=await res.json();
    renderOverview();
    document.getElementById('ov-updated').textContent='Updated '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  }catch(err){
    document.getElementById('ov-updated').textContent=err.message;
  }
}
function renderOverview(){
  const d=ovData, s=d.summary;
  const q=document.getElementById('ov-quarter');
  const curQ=q.value;
  const quarters=[...new Set([curQ!=='all'?curQ:null,...d.quarters].filter(Boolean))].sort().reverse();
  q.innerHTML='<option value="all">All quarters</option>'+quarters.map(v=>`<option value="${ovEsc(v)}">${ovEsc(v)}</option>`).join('');
  q.value=curQ;
  ovSetOptions(document.getElementById('ov-division'),d.divisions,'All divisions');

  const tile=(icon,value,label,extra='')=>`<div class="hs-card"><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div><b>${value}</b><span>${label}</span>${extra}</div>`;
  document.getElementById('ov-stats').innerHTML=
    tile('clipboard-check',`${s.completed}/${s.assignments}`,'Assignments completed',
      `<div class="ov-bar" style="margin-top:10px"><i style="width:${s.completionPct}%"></i></div>`)+
    tile('building-2',`${s.buildingsCovered}/${s.buildings}`,'Buildings assigned')+
    tile('trending-up',s.avgScore??'–','Average score')+
    tile('file-text',s.inspections,'Inspections')+
    tile('users',s.activeAuditors,'Active auditors');

  const divRows=document.getElementById('ov-div-rows');
  const focused=document.getElementById('ov-division').value;
  divRows.innerHTML=d.byDivision.length?d.byDivision.map(x=>`
    <tr class="clickable" data-division="${ovEsc(x.division)}"${x.division===focused?' style="background:rgba(38,168,171,.08)"':''}>
      <td><b>${ovEsc(x.division)}</b><small>${x.buildings} buildings · ${x.inspections} inspections</small></td>
      <td>${ovPct(x.completed,x.assignments)}<small>${x.completed}/${x.assignments} assignments</small></td>
      <td>${ovScore(x.avgScore)}</td>
    </tr>`).join(''):'<tr><td colspan="3" class="ov-empty">No divisions match.</td></tr>';

  if(ovChart) ovChart.destroy();
  ovChart=new Chart(document.getElementById('ov-div-chart'),{
    type:'bar',
    data:{labels:d.byDivision.map(x=>x.division),datasets:[
      {label:'Average score',data:d.byDivision.map(x=>x.avgScore??0),backgroundColor:'#0033A0',borderRadius:6},
      {label:'Completion %',data:d.byDivision.map(x=>x.assignments?Math.round(x.completed/x.assignments*100):0),backgroundColor:'#26A8AB',borderRadius:6},
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      scales:{y:{beginAtZero:true,max:100,ticks:{font:{family:'Cairo'}}},x:{ticks:{font:{family:'Cairo',weight:'700'}}}},
      plugins:{legend:{position:'bottom',labels:{font:{family:'Cairo',weight:'700'}}}}},
  });

  document.getElementById('ov-aud-rows').innerHTML=d.auditors.length?d.auditors.map(x=>`
    <tr class="clickable" data-auditor="${ovEsc(x.id)}" title="Open ${ovEsc(x.name)}'s profile">
      <td><b>${ovEsc(x.name)}</b>${x.role&&x.role!=='quality_auditor'?`<small>Quality ${roleShort(x.role)}</small>`:''}${x.status!=='active'?'<small>Suspended</small>':''}</td>
      <td>${x.assigned}</td>
      <td>${ovPct(x.completed,x.assigned)}<small>${x.completed} done · ${x.assigned-x.completed} pending</small></td>
      <td>${ovScore(x.avgScore)}</td>
    </tr>`).join(''):'<tr><td colspan="4" class="ov-empty">No auditors yet.</td></tr>';

  document.getElementById('ov-off-rows').innerHTML=d.officers.length?d.officers.map(x=>`
    <tr>
      <td><b>${ovEsc(x.name)}</b>${x.role!=='quality_officer'?'<small>Quality Admin</small>':''}</td>
      <td>${x.assignmentsMade}</td>
      <td>${ovPct(x.completed,x.assignmentsMade)}</td>
    </tr>`).join(''):'<tr><td colspan="3" class="ov-empty">No officers yet.</td></tr>';

  document.getElementById('ov-feed').innerHTML=d.activity.length?d.activity.map(x=>{
    if(x.kind==='assignment') return `<li><span class="dot" style="background:var(--royal)"><svg data-lucide="clipboard-list" width="14" height="14"></svg></span>
      <div><b>${ovEsc(x.actor)}</b> assigned <b>${ovEsc(x.building)}</b> to ${ovEsc(x.target)}<small>${ovEsc(x.quarter)} ${ovEsc(x.type)} · ${timeAgo(x.at)}</small></div></li>`;
    const bg=x.score!=null?grade(x.score).color:'var(--teal)', fg=x.score!=null?grade(x.score).on:'#fff';
    return `<li><span class="dot" style="background:${bg};color:${fg}"><svg data-lucide="check" width="14" height="14"></svg></span>
      <div><b>${ovEsc(x.actor)}</b> submitted <b>${ovEsc(x.building)}</b>${x.score!=null?` — ${x.score}/100`:''}<small>${ovEsc(x.type||'')}${x.quarter?' · '+ovEsc(x.quarter):''}${x.linked?' · assigned':''} · ${timeAgo(x.at)}</small></div></li>`;
  }).join(''):'<li class="ov-empty" style="display:block">No activity for these filters yet.</li>';

  document.getElementById('ov-area-rows').innerHTML=d.byArea.length?d.byArea.map(x=>`
    <tr>
      <td><b>${ovEsc(x.area)}</b><small>${ovEsc(x.division)}</small></td>
      <td>${x.buildings}</td>
      <td>${x.assignments}</td>
      <td>${ovPct(x.completed,x.assignments)}</td>
      <td>${x.inspections}</td>
      <td>${ovScore(x.avgScore)}</td>
    </tr>`).join(''):'<tr><td colspan="6" class="ov-empty">No areas match.</td></tr>';

  renderOvBuildings();
  lucide.createIcons();
}
function ovFilteredBuildings(){
  if(!ovData) return [];
  const term=document.getElementById('ov-b-search').value.trim().toLowerCase();
  const status=document.getElementById('ov-b-status').value;
  return ovData.byBuilding.filter(x=>
    (status==='all'||x.status===status) &&
    (!term||x.name.toLowerCase().includes(term)||(x.auditorName||'').toLowerCase().includes(term)));
}
function renderOvBuildings(){
  if(!ovData) return;
  const rows=ovFilteredBuildings();
  document.getElementById('ov-b-count').textContent=`${rows.length} of ${ovData.byBuilding.length} buildings`;
  const label={completed:'Completed',pending:'Pending',unassigned:'Unassigned'};
  document.getElementById('ov-b-rows').innerHTML=rows.length?rows.map(x=>`
    <tr>
      <td><b>${ovEsc(x.name)}</b><small>${ovEsc(x.location||'')}</small></td>
      <td>${ovEsc(x.division)}<small>${ovEsc(x.area)}</small></td>
      <td>${x.auditorName?ovEsc(x.auditorName):'<span style="color:var(--muted)">—</span>'}</td>
      <td><span class="ov-pill ${x.status}">${label[x.status]}</span></td>
      <td>${x.inspections}</td>
      <td>${ovScore(x.lastScore)}${x.lastDate?`<small>${ovEsc(x.lastDate)}</small>`:''}</td>
    </tr>`).join(''):'<tr><td colspan="6" class="ov-empty">No buildings match.</td></tr>';
}

// ═══════════════════════════════════════════════════════════
// ASSIGN & TRACK (Quality Officer)
// ═══════════════════════════════════════════════════════════
// One request loads the whole quarter/type board; it refreshes every 30s
// (and when the tab regains focus) so auditor progress stays live.
function ofVal(id){ return document.getElementById(id).value; }
function ofCurrentQuarter(){ const d=new Date(); return `${d.getFullYear()}-Q${Math.floor(d.getMonth()/3)+1}`; }
function ofQuarterOptions(extra=[]){
  const d=new Date(), y=d.getFullYear(), q=Math.floor(d.getMonth()/3)+1, out=[];
  for(let i=-1;i<3;i++){
    let qq=q+i, yy=y;
    while(qq<1){qq+=4;yy--;}
    while(qq>4){qq-=4;yy++;}
    out.push(`${yy}-Q${qq}`);
  }
  return [...new Set([...out,...extra.filter(v=>/^\d{4}-Q[1-4]$/.test(v))])].sort().reverse();
}
/** A name short enough for a button: the whole name when it fits, otherwise the first part. */
function firstName(name){
  const full=String(name||'').trim();
  if(!full) return 'the auditor';
  return full.length<=16?full:full.split(/\s+/)[0];
}
function ofInitials(name){ return String(name||'?').split(/\s+/).filter(Boolean).map(p=>p[0]).slice(0,2).join('').toUpperCase(); }
function ofOnPage(){ return document.getElementById('pg-officer').classList.contains('active'); }
function showToast(msg,isErr){
  const t=document.getElementById('app-toast');
  t.textContent=msg; t.classList.toggle('err',!!isErr); t.hidden=false;
  clearTimeout(t._timer); t._timer=setTimeout(()=>{ t.hidden=true; },isErr?6000:3500);
}
function ofSave(){
  try{ localStorage.setItem('of-state',JSON.stringify({quarter:ofVal('of-quarter'),type:ofVal('of-type'),division:ofVal('of-division')})); }catch{}
}
/** Buildings each auditor holds for the loaded quarter + type (all divisions). */
function ofCounts(){
  const m=new Map();
  ofData.buildings.forEach(b=>{ if(b.auditorId) m.set(b.auditorId,(m.get(b.auditorId)||0)+1); });
  return m;
}
/** People this account may give buildings to (the server decides: admins → admins, officers, auditors; officers → admins, themselves, auditors). */
function ofActiveAuditors(){ return ofData.auditors.filter(a=>a.assignable); }
function roleShort(role){ return ({quality_admin:'Admin',quality_officer:'Officer',quality_leader:'Leader',data_analyst:'Analyst',quality_auditor:'Auditor'})[role]||''; }
/** "Name" for auditors, "Name · Admin" / "Name · you" for everyone else. */
function assigneeLabel(a){
  const tag=currentUser&&a.id===currentUser.id?'you':a.role&&a.role!=='quality_auditor'?roleShort(a.role):'';
  return tag?`${a.name} · ${tag}`:a.name;
}

function initOfficer(){
  if(ofReady) return;
  ofReady=true;
  let saved={};
  try{ saved=JSON.parse(localStorage.getItem('of-state')||'{}')||{}; }catch{}
  const qSel=document.getElementById('of-quarter');
  const startQ=/^\d{4}-Q[1-4]$/.test(saved.quarter)?saved.quarter:ofCurrentQuarter();
  qSel.innerHTML=ofQuarterOptions([startQ]).map(q=>`<option value="${q}">${q}</option>`).join('');
  qSel.value=startQ;
  if(['BOQI','EOQI'].includes(saved.type)) document.getElementById('of-type').value=saved.type;
  if(typeof saved.division==='string'&&saved.division){
    document.getElementById('of-division').add(new Option(saved.division,saved.division));
    document.getElementById('of-division').value=saved.division;
  }

  const period=()=>{ ofSelected.clear(); ofPrevDone=null; ofData=null; ofSave(); loadOfficer(); };
  document.getElementById('of-quarter').addEventListener('change',period);
  document.getElementById('of-type').addEventListener('change',period);
  document.getElementById('of-division').addEventListener('change',()=>{ document.getElementById('of-area').value=''; ofSave(); renderOfficer(); });
  document.getElementById('of-search').addEventListener('input',()=>renderOfRows());
  ['of-area','of-status','of-auditor-filter'].forEach(id=>document.getElementById(id).addEventListener('change',()=>renderOfficer()));

  const toTable=()=>document.getElementById('of-table-section').scrollIntoView({behavior:'smooth',block:'start'});
  document.getElementById('of-stats').addEventListener('click',e=>{
    const tile=e.target.closest('[data-status]');
    if(!tile) return;
    const sel=document.getElementById('of-status');
    sel.value=sel.value===tile.dataset.status?'':tile.dataset.status;
    renderOfficer(); toTable();
  });
  document.getElementById('of-cards').addEventListener('click',e=>{
    const card=e.target.closest('[data-auditor]');
    if(card) openAuditorProfile(card.dataset.auditor);
  });
  document.getElementById('of-area-rows').addEventListener('click',e=>{
    const tr=e.target.closest('tr[data-area]');
    if(!tr) return;
    document.getElementById('of-division').value=tr.dataset.division;
    renderOfficer();
    const sel=document.getElementById('of-area');
    sel.value=sel.value===tr.dataset.area?'':tr.dataset.area;
    ofSave(); renderOfficer(); toTable();
  });

  const rowsEl=document.getElementById('of-rows');
  rowsEl.addEventListener('change',e=>{
    const box=e.target.closest('[data-check]');
    if(box){
      const id=Number(box.dataset.check);
      box.checked?ofSelected.add(id):ofSelected.delete(id);
      box.closest('tr').classList.toggle('selected',box.checked);
      ofSyncCheckAll(); ofUpdateBulk();
      return;
    }
    const sel=e.target.closest('select[data-building]');
    if(sel){ ofAssignOne(Number(sel.dataset.building),sel.value,sel); return; }
    const day=e.target.closest('input[data-due]');
    if(day) ofSetDue([Number(day.dataset.due)],day.value,day).then(()=>loadOfficer({quiet:true}));
  });
  rowsEl.addEventListener('click',e=>{
    const tap=e.target.closest('[data-quick]');
    if(!tap||!ofData) return;
    const id=Number(tap.dataset.quick), b=ofData.buildings.find(x=>x.buildingId===id);
    tap.disabled=true;
    ofAssignOne(id,b&&b.auditorId===ofQuick?'':ofQuick);          // tapping the same auditor again takes it back
  });
  document.getElementById('of-quick').addEventListener('change',e=>{ ofQuick=e.target.value; renderOfRows(); });
  document.getElementById('of-copy-last').addEventListener('click',ofCopyLastQuarter);
  document.getElementById('of-repeat').addEventListener('click',ofOpenRepeat);
  const mirror=document.getElementById('of-mirror');
  try{ mirror.checked=localStorage.getItem('of-mirror')==='1'; }catch{}
  mirror.addEventListener('change',()=>{ try{ localStorage.setItem('of-mirror',mirror.checked?'1':'0'); }catch{} });
  document.getElementById('rep-list').addEventListener('change',ofRepeatTotal);
  document.getElementById('rep-replace').addEventListener('change',ofRepeatTotal);
  document.getElementById('rep-go').addEventListener('click',ofRunRepeat);
  // A refresh never re-draws the table under an open auditor picker; it catches up on blur.
  rowsEl.addEventListener('focusout',()=>setTimeout(()=>{ if(ofRowsStale&&!rowsEl.contains(document.activeElement)) renderOfRows(); },0));
  ['of-check-all','of-check-all-m'].forEach(id=>document.getElementById(id).addEventListener('change',e=>{
    ofFilteredRows().filter(b=>b.status!=='completed').forEach(b=>e.target.checked?ofSelected.add(b.buildingId):ofSelected.delete(b.buildingId));
    renderOfRows();
  }));
  document.getElementById('of-bulk-assign').addEventListener('click',()=>ofRunBulk('assign'));
  document.getElementById('of-bulk-distribute').addEventListener('click',()=>ofRunBulk('distribute'));
  document.getElementById('of-bulk-unassign').addEventListener('click',()=>ofRunBulk('unassign'));
  document.getElementById('of-bulk-clear').addEventListener('click',()=>{ ofSelected.clear(); renderOfRows(); });
  document.getElementById('of-bulk-due-set').addEventListener('click',()=>ofRunBulk('due'));

  setInterval(()=>{ if(appIsOpen()&&ofOnPage()&&document.visibilityState==='visible') loadOfficer({quiet:true}); },30000);
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&ofOnPage()) loadOfficer({quiet:true}); });
}

async function loadOfficer({quiet=false}={}){
  initOfficer();
  const req=++ofReq, quarter=ofVal('of-quarter'), type=ofVal('of-type'), key=`${quarter}|${type}`;
  const live=document.getElementById('of-live'), updated=document.getElementById('of-updated');
  if(!quiet) updated.textContent='Loading…';
  try{
    const res=await fetch(`/api/officer/board?quarter=${encodeURIComponent(quarter)}&type=${encodeURIComponent(type)}`);
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||'Could not load the board.');
    if(req!==ofReq) return;
    const doneNow=new Set(data.buildings.filter(b=>b.status==='completed').map(b=>b.buildingId));
    const fresh=ofPrevDone&&ofPrevKey===key?[...doneNow].filter(id=>!ofPrevDone.has(id)):[];
    ofPrevDone=doneNow; ofPrevKey=key; ofData=data;
    for(const id of [...ofSelected]) if(doneNow.has(id)||!data.buildings.some(b=>b.buildingId===id)) ofSelected.delete(id);
    renderOfficer(fresh);
    if(fresh.length){
      const b=data.buildings.find(x=>x.buildingId===fresh[0]);
      showToast(fresh.length===1?`${b.auditorName||'An auditor'} completed ${b.name}${b.score!=null?` — ${b.score}/100`:''}`:`${fresh.length} buildings were just completed`);
    }
    live.classList.remove('off');
    updated.textContent='Live · updated '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }catch(err){
    if(req!==ofReq) return;
    live.classList.add('off');
    updated.textContent=err.message;
  }
}

function renderOfficer(fresh=[]){
  if(!ofData) return;
  const d=ofData, curQ=ofVal('of-quarter');
  const begin=ofVal('of-type')==='BOQI';
  document.getElementById('of-mirror-wrap').hidden=!begin;
  document.getElementById('of-repeat-label').textContent=begin?'Repeat for End of Quarter':'Copy from Beginning of Quarter';
  const qSel=document.getElementById('of-quarter');
  qSel.innerHTML=ofQuarterOptions([...d.quarters,curQ]).map(q=>`<option value="${q}">${q}${q===ofCurrentQuarter()?' (current)':''}</option>`).join('');
  qSel.value=curQ;
  rpSelect('of-division',[...new Set(d.buildings.map(b=>b.division))].sort(),'All divisions');
  const div=ofVal('of-division');
  const scoped=d.buildings.filter(b=>!div||b.division===div);
  rpSelect('of-area',[...new Set(scoped.map(b=>b.area))].sort(),'All areas');
  const af=document.getElementById('of-auditor-filter'), curA=af.value;
  af.innerHTML='<option value="">All auditors</option>'+d.auditors.map(a=>`<option value="${ovEsc(a.id)}">${ovEsc(a.name)}</option>`).join('');
  af.value=d.auditors.some(a=>a.id===curA)?curA:'';

  // KPI tiles (respect the division filter); four of them double as status filters
  const total=scoped.length, assigned=scoped.filter(b=>b.assignmentId).length;
  const completed=scoped.filter(b=>b.status==='completed').length, pending=assigned-completed;
  const scores=scoped.map(b=>b.score).filter(v=>typeof v==='number');
  const avg=scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):null;
  const pct=(a,b)=>b?Math.round(a/b*100):0, status=ofVal('of-status');
  const bar=p=>`<div class="ov-bar" style="margin-top:10px"><i style="width:${p}%"></i></div>`;
  const note=t=>`<small style="display:block;color:var(--muted);font-size:.7rem;margin-top:4px">${t}</small>`;
  const tile=(icon,value,label,extra,filter,color)=>`<div class="hs-card${filter?' clickable':''}${filter&&status===filter?' active':''}"${filter?` data-status="${filter}" title="Show these buildings"`:''}>
    <div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div><b${color?` style="color:${color}"`:''}>${value}</b><span>${label}</span>${extra||''}</div>`;
  document.getElementById('of-stats').innerHTML=
    tile('building-2',total,'Buildings',note(ovEsc(div||'All divisions')))+
    tile('user-check',`${assigned}/${total}`,'Assigned',bar(pct(assigned,total)),'assigned')+
    tile('circle-check',`${pct(completed,assigned)}%`,'Completion',note(`${completed} of ${assigned} assigned done`)+bar(pct(completed,assigned)),'completed')+
    tile('hourglass',pending,'Pending',note('Assigned, not yet inspected'),'pending')+
    tile('circle-dashed',total-assigned,'Unassigned',note('Still need an auditor'),'unassigned')+
    tile('trending-up',avg??'–','Average score',avg!=null?note(grade(avg).label):note('No results yet'),null,avg!=null?grade(avg).ink:'');

  // Auditor progress: the whole quarter + type, so workloads compare fairly
  const byAud=new Map(d.auditors.map(a=>[a.id,{...a,assigned:0,completed:0,scores:[],last:null}]));
  d.buildings.forEach(b=>{
    const x=b.auditorId&&byAud.get(b.auditorId);
    if(!x) return;
    x.assigned++;
    if(b.status!=='completed') return;
    x.completed++;
    if(typeof b.score==='number') x.scores.push(b.score);
    if(!x.last||b.completedAt>x.last) x.last=b.completedAt;
  });
  const freshAud=new Set(fresh.map(id=>d.buildings.find(b=>b.buildingId===id)?.auditorId));
  const cards=[...byAud.values()].filter(a=>a.role==='quality_auditor'||a.assigned).sort((a,b)=>b.assigned-a.assigned||a.name.localeCompare(b.name));
  document.getElementById('of-team-note').textContent=div?'Whole quarter, all divisions':'';
  document.getElementById('of-cards').innerHTML=cards.length?cards.map(a=>{
    const p=pct(a.completed,a.assigned), av=a.scores.length?Math.round(a.scores.reduce((s,v)=>s+v,0)/a.scores.length):null;
    const sub=[a.role!=='quality_auditor'?(currentUser&&a.id===currentUser.id?'You':`Quality ${roleShort(a.role)}`):'',a.status!=='active'?'Suspended':'',a.openElsewhere?`${a.openElsewhere} open in other periods`:''].filter(Boolean).join(' · ')||(a.assigned?'':'No buildings yet');
    return `<div class="of-card${freshAud.has(a.id)?' flash':''}" data-auditor="${ovEsc(a.id)}" title="Open ${ovEsc(a.name)}'s profile">
      <div class="of-card-hd"><i class="of-av">${ovEsc(ofInitials(a.name))}</i><div><b>${ovEsc(a.name)}</b><small>${ovEsc(sub)}</small></div><span class="of-pct">${a.assigned?p+'%':'–'}</span></div>
      <div class="ov-bar"><i style="width:${p}%"></i></div>
      <div class="of-nums">
        <span><b>${a.assigned}</b>Assigned</span><span><b>${a.completed}</b>Done</span>
        <span><b>${a.assigned-a.completed}</b>Pending</span><span><b${av!=null?` style="color:${grade(av).ink}"`:''}>${av??'–'}</b>Avg</span>
      </div>
      <div class="of-card-ft"><span>${a.last?`Last submission ${timeAgo(a.last)}`:a.assigned?'No submissions yet':'Nothing assigned this period'}</span><b>Profile <svg data-lucide="chevron-right" width="13" height="13"></svg></b></div>
    </div>`;
  }).join(''):'<div class="ov-empty">No active auditors yet — an admin can create them in Admin Control.</div>';

  // Progress by area
  const areas=new Map();
  scoped.forEach(b=>{
    const k=b.division+'|'+b.area;
    if(!areas.has(k)) areas.set(k,{division:b.division,area:b.area,buildings:0,assigned:0,completed:0});
    const g=areas.get(k); g.buildings++;
    if(b.assignmentId) g.assigned++;
    if(b.status==='completed') g.completed++;
  });
  const curArea=ofVal('of-area');
  document.getElementById('of-area-rows').innerHTML=areas.size?[...areas.values()].map(g=>`
    <tr class="clickable" data-area="${ovEsc(g.area)}" data-division="${ovEsc(g.division)}"${g.area===curArea?' style="background:rgba(38,168,171,.08)"':''}>
      <td><b>${ovEsc(g.area)}</b><small>${ovEsc(g.division)}</small></td>
      <td>${g.buildings}</td>
      <td>${ovPct(g.assigned,g.buildings)}<small>${g.assigned}/${g.buildings} assigned</small></td>
      <td>${ovPct(g.completed,g.assigned)}<small>${g.completed}/${g.assigned} done</small></td>
    </tr>`).join(''):'<tr><td colspan="4" class="ov-empty">No buildings.</td></tr>';

  // Activity — assignments saved together (same person, auditor and second) collapse into one line
  const bById=new Map(d.buildings.map(b=>[b.buildingId,b]));
  const groups=new Map();
  d.events.forEach((e,i)=>{
    const b=bById.get(e.buildingId);
    if(!b||(div&&b.division!==div)) return;
    const key=e.kind==='assigned'?`a|${e.actor}|${e.auditor}|${e.at}`:`c|${i}`;
    if(groups.has(key)) groups.get(key).names.push(b.name);
    else groups.set(key,{...e,names:[b.name]});
  });
  const grouped=[...groups.values()];
  document.getElementById('of-feed').innerHTML=grouped.length?grouped.map(e=>e.kind==='completed'
    ?`<li><span class="dot" style="background:${e.score!=null?grade(e.score).color:'var(--teal)'};color:${e.score!=null?grade(e.score).on:'#fff'}"><svg data-lucide="check" width="14" height="14"></svg></span>
       <div><b>${ovEsc(e.auditor)}</b> completed <b>${ovEsc(e.names[0])}</b>${e.score!=null?` — ${e.score}/100`:''}<small>${timeAgo(e.at)}</small></div></li>`
    :`<li><span class="dot" style="background:var(--royal)"><svg data-lucide="clipboard-list" width="14" height="14"></svg></span>
       <div><b>${ovEsc(e.actor)}</b> assigned <b>${e.names.length===1?ovEsc(e.names[0]):e.names.length+' buildings'}</b> to ${ovEsc(e.auditor)}<small>${timeAgo(e.at)}</small></div></li>`
  ).join(''):'<li class="ov-empty" style="display:block">Nothing has happened for this quarter yet.</li>';

  ofView={kpis:{total,assigned,completed,pending,avg},team:cards,areas:[...areas.values()],activity:grouped};
  renderOfRows(fresh);
  lucide.createIcons();
}

function ofFilteredRows(){
  const div=ofVal('of-division'), area=ofVal('of-area'), st=ofVal('of-status'), aud=ofVal('of-auditor-filter');
  const term=ofVal('of-search').trim().toLowerCase();
  return ofData.buildings.filter(b=>
    (!div||b.division===div) && (!area||b.area===area) &&
    (!st||(st==='assigned'?b.status!=='unassigned':b.status===st)) &&
    (!aud||b.auditorId===aud) &&
    (!term||b.name.toLowerCase().includes(term)||(b.location||'').toLowerCase().includes(term)||(b.auditorName||'').toLowerCase().includes(term)));
}
function renderOfRows(fresh=[]){
  if(!ofData) return;
  const rowsEl=document.getElementById('of-rows');
  const focus=document.activeElement;
  if(rowsEl.contains(focus)&&(focus.tagName==='SELECT'||focus.type==='date')){ ofRowsStale=true; return; }
  ofRowsStale=false;
  const rows=ofFilteredRows(), counts=ofCounts(), active=ofActiveAuditors(), freshSet=new Set(fresh);
  const label={completed:'Completed',pending:'Pending',unassigned:'Unassigned'}, canSetDue=hasPerm('assign');
  rowsEl.innerHTML=rows.length?rows.map(b=>{
    const done=b.status==='completed', picked=ofSelected.has(b.buildingId);
    const held=b.auditorId&&!active.some(a=>a.id===b.auditorId)?`<option value="${ovEsc(b.auditorId)}" selected disabled>${ovEsc(b.auditorName||'Unknown')} (not available)</option>`:'';
    const quick=ofQuick&&active.some(a=>a.id===ofQuick)?active.find(a=>a.id===ofQuick):null;
    const auditorCell=done
      ?`<span class="of-lock"><svg data-lucide="lock" width="12" height="12"></svg> ${ovEsc(b.auditorName||'—')}</span><small>Locked — already inspected</small>`
      :quick
        ?(b.auditorId===quick.id
          ?`<button class="of-tap on" data-quick="${b.buildingId}" title="Tap to take it back"><svg data-lucide="check" width="13" height="13"></svg> ${ovEsc(firstName(quick.name))}</button><small>Tap to unassign</small>`
          :`<button class="of-tap" data-quick="${b.buildingId}"><svg data-lucide="plus" width="13" height="13"></svg> Give to ${ovEsc(firstName(quick.name))}</button>${b.auditorName?`<small>now ${ovEsc(b.auditorName)}</small>`:''}`)
        :`<select class="of-sel${b.auditorId?'':' unassigned'}" data-building="${b.buildingId}" aria-label="Auditor for ${ovEsc(b.name)}">
          <option value="">— Unassigned —</option>${held}
          ${active.map(a=>`<option value="${ovEsc(a.id)}"${a.id===b.auditorId?' selected':''}>${ovEsc(assigneeLabel(a))} (${counts.get(a.id)||0})</option>`).join('')}
        </select>${b.assignedBy?`<small>by ${ovEsc(b.assignedBy)} · ${timeAgo(b.assignedAt)}</small>`:''}`;
    const due=dueState(b);
    const dueCell=done||!canSetDue?dueChip(b)
      :!b.auditorId?'<span style="color:var(--muted)">—</span><small>Assign it first</small>'
      :`<input type="date" lang="en-GB" class="of-due${due&&due.cls?' '+due.cls:''}" data-due="${b.buildingId}" value="${ovEsc(b.dueDate||'')}" aria-label="Deadline for ${ovEsc(b.name)}">${due?`<small>${ovEsc(due.note)}</small>`:''}`;
    return `<tr class="${picked?'selected':''}${freshSet.has(b.buildingId)?' flash':''}">
      <td class="of-chk">${done?'':`<input type="checkbox" data-check="${b.buildingId}"${picked?' checked':''} aria-label="Select ${ovEsc(b.name)}">`}</td>
      <td class="bld"><b>${ovEsc(b.name)}</b><small>${ovEsc(b.location||'')}<span class="m-only"> · ${ovEsc(b.division)} · ${ovEsc(b.area)}</span></small></td>
      <td data-l="Division" class="col-div"><div class="of-v">${ovEsc(b.division)}<small>${ovEsc(b.area)}</small></div></td>
      <td data-l="Auditor"><div class="of-v">${auditorCell}</div></td>
      <td data-l="Deadline"><div class="of-v">${dueCell}</div></td>
      <td data-l="Status"><span class="ov-pill ${b.status}">${label[b.status]}</span></td>
      <td data-l="Result"${done?'':' class="no-res"'}><div class="of-v">${done?`${b.inspectionId?`<button class="rp-link" style="padding:0" data-click="openReport" data-id="${b.inspectionId}" title="Open the report">${ovScore(b.score)}</button>`:ovScore(b.score)}${b.review?`<small class="of-review">${reviewMark(b.review)}</small>`:''}<small>${ovEsc(b.inspectionDate||'')}${b.inspector?' · '+ovEsc(b.inspector):''}</small>`:'<span style="color:var(--muted)">–</span>'}</div></td>
    </tr>`;
  }).join(''):'<tr><td colspan="7" class="ov-empty">No buildings match these filters.</td></tr>';
  const scopedTotal=ofData.buildings.filter(b=>!ofVal('of-division')||b.division===ofVal('of-division')).length;
  document.getElementById('of-count').textContent=`${rows.length} of ${scopedTotal} buildings shown${ofSelected.size?` · ${ofSelected.size} selected`:''}`;
  ofSyncCheckAll(); ofUpdateQuick(); ofUpdateBulk();
  lucide.createIcons();
}
function ofSyncCheckAll(){
  const ids=ofFilteredRows().filter(b=>b.status!=='completed').map(b=>b.buildingId);
  const n=ids.filter(id=>ofSelected.has(id)).length;
  ['of-check-all','of-check-all-m'].forEach(id=>{
    const box=document.getElementById(id);
    box.checked=!!ids.length&&n===ids.length;
    box.indeterminate=n>0&&n<ids.length;
    box.disabled=!ids.length;
  });
}
function ofUpdateQuick(){
  const sel=document.getElementById('of-quick'), counts=ofCounts();
  const active=ofActiveAuditors();
  if(ofQuick&&!active.some(a=>a.id===ofQuick)) ofQuick='';
  sel.innerHTML='<option value="">Quick assign: off</option>'
    +active.map(a=>`<option value="${ovEsc(a.id)}"${a.id===ofQuick?' selected':''}>Quick assign: ${ovEsc(assigneeLabel(a))} (${counts.get(a.id)||0})</option>`).join('');
  sel.value=ofQuick;
  sel.classList.toggle('on',!!ofQuick);
}
function ofUpdateBulk(){
  const n=ofSelected.size;
  document.getElementById('of-bulk').hidden=!n;
  document.getElementById('of-sel-count').textContent=`${n} building${n===1?'':'s'} selected`;
  const sel=document.getElementById('of-bulk-auditor'), cur=sel.value, counts=ofCounts();
  sel.innerHTML='<option value="">Assign to…</option>'+ofActiveAuditors().map(a=>`<option value="${ovEsc(a.id)}">${ovEsc(assigneeLabel(a))} (${counts.get(a.id)||0})</option>`).join('');
  sel.value=[...sel.options].some(o=>o.value===cur)?cur:'';
  const box=document.getElementById('of-count');
  box.textContent=box.textContent.replace(/ · \d+ selected$/,'')+(n?` · ${n} selected`:'');
}

async function ofAssignOne(buildingId,auditorId,el){
  const b=ofData.buildings.find(x=>x.buildingId===buildingId);
  if(!b) return;
  const who=!auditorId?''
    :el?el.options[el.selectedIndex].text.replace(/ \(\d+\)$/,'').replace(/ · you$/,' (you)')
      :(ofData.auditors.find(a=>a.id===auditorId)?.name||'the auditor');
  if(el) el.disabled=true;
  try{
    let res=null;
    if(auditorId){
      res=await fetch('/api/assignments',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({buildingId,auditorId,quarter:ofVal('of-quarter'),type:ofVal('of-type')})});
    }else if(b.assignmentId){
      res=await fetch('/api/assignments/'+b.assignmentId,{method:'DELETE'});
    }
    if(res&&!res.ok) throw new Error((await res.json().catch(()=>({}))).error||'Could not save the change.');
    const also=auditorId?await ofMirror([buildingId]):'';
    showToast(auditorId?`${b.name} assigned to ${who}${also}`:`${b.name} unassigned`);
  }catch(err){
    showToast(err.message,true);
  }
  if(el) el.blur();
  await loadOfficer({quiet:true});
}

/** The deadline for one or more buildings. An empty date removes it. */
async function ofSetDue(buildingIds,dueDate,el){
  if(el) el.disabled=true;
  try{
    const res=await fetch('/api/assignments/due',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({quarter:ofVal('of-quarter'),type:ofVal('of-type'),buildingIds,dueDate:dueDate||null})});
    const d=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(d.error||'Could not save the deadline.');
    const many=buildingIds.length>1?`${d.updated} building${d.updated===1?'':'s'}`:'Deadline';
    showToast(dueDate?`${many} due ${dueFmt(dueDate)}`:`${buildingIds.length>1?many+' — d':'D'}eadline removed`);
    return d;
  }catch(err){ showToast(err.message,true); return null; }
  finally{ if(el) el.disabled=false; }
}

/** The quarter before this one, same type — the usual starting point for a new quarter. */
function ofPreviousQuarter(q){
  const m=/^(\d{4})-Q([1-4])$/.exec(q||'');
  if(!m) return '';
  const y=+m[1], n=+m[2];
  return n===1?`${y-1}-Q4`:`${y}-Q${n-1}`;
}
async function ofCopyLastQuarter(){
  const btn=document.getElementById('of-copy-last');
  const quarter=ofVal('of-quarter'), type=ofVal('of-type'), prev=ofPreviousQuarter(quarter);
  if(!prev||!ofData) return;
  btn.disabled=true;
  try{
    const res=await fetch(`/api/assignments/schedule?quarter=${encodeURIComponent(prev)}&type=${encodeURIComponent(type)}`,{cache:'no-store'});
    const d=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(d.error||'Could not read last quarter.');
    const free=new Set(ofData.buildings.filter(b=>b.status==='unassigned').map(b=>b.buildingId));
    const canTake=new Map(ofActiveAuditors().map(a=>[a.id,a.name]));
    const plan=new Map();                                          // auditor → buildings they had, still free now
    (d.buildings||[]).forEach(b=>{
      if(!b.auditorId||!free.has(b.buildingId)||!canTake.has(b.auditorId)) return;
      if(!plan.has(b.auditorId)) plan.set(b.auditorId,[]);
      plan.get(b.auditorId).push(b.buildingId);
    });
    const total=[...plan.values()].reduce((n,ids)=>n+ids.length,0);
    if(!total){ showToast(`Nothing to copy from ${prev} — those buildings are already assigned or their auditors are unavailable.`,true); return; }
    const who=[...plan.entries()].map(([id,ids])=>`${canTake.get(id)}: ${ids.length}`).join(' · ');
    if(!confirm(`Copy ${prev} into ${quarter} (${type})?\n\n${total} building${total===1?'':'s'} would be assigned as they were.\n${who}\n\nNothing already assigned or inspected is touched.`)) return;
    for(const [auditorId,ids] of plan) await ofBulk(auditorId,ids);
    const also=await ofMirror([...plan.values()].flat());
    showToast(`${total} building${total===1?'':'s'} copied from ${prev}${also}`);
    await loadOfficer();
  }catch(err){ showToast(err.message,true); }
  finally{ btn.disabled=false; }
}

/** With "Same auditor for End of Quarter" on (BOQI view), what was just assigned is given to the
 *  same auditors for the EOQI as well. Returns a few words for the toast. */
async function ofMirror(buildingIds){
  if(ofVal('of-type')!=='BOQI'||!document.getElementById('of-mirror').checked||!buildingIds.length) return '';
  try{
    const r=await ofRepeat({buildingIds,replace:true});
    return r.assigned?` · also for End of Quarter`:'';
  }catch(err){ return ` · End of Quarter not updated: ${err.message}`; }
}
async function ofRepeat(body){
  const res=await fetch('/api/assignments/repeat',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({quarter:ofVal('of-quarter'),...body})});
  const d=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(d.error||'Could not assign the end of the quarter.');
  return d;
}

/** Repeat for End of Quarter: each auditor's beginning-of-quarter buildings, and what would
 *  happen to them, so the officer can leave anyone out before anything changes. */
let ofRepeatPlan=null;
async function ofOpenRepeat(){
  const quarter=ofVal('of-quarter'), div=ofVal('of-division'), btn=document.getElementById('of-repeat');
  btn.disabled=true;
  try{
    const get=async type=>{
      const res=await fetch(`/api/assignments/schedule?quarter=${encodeURIComponent(quarter)}&type=${type}`,{cache:'no-store'});
      const d=await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(d.error||'Could not read the plan.');
      return d.buildings||[];
    };
    const [begin,end]=await Promise.all([get('BOQI'),get('EOQI')]);
    const endOf=new Map(end.map(b=>[b.buildingId,b]));
    const available=new Set(ofActiveAuditors().map(a=>a.id));
    const by=new Map();
    begin.filter(b=>b.auditorId&&(!div||b.division===div)).forEach(b=>{
      if(!by.has(b.auditorId)) by.set(b.auditorId,{id:b.auditorId,name:b.auditorName||'Unknown',ids:[],fresh:0,theirs:0,other:0,locked:0});
      const x=by.get(b.auditorId), e=endOf.get(b.buildingId);
      x.ids.push(b.buildingId);
      if(e&&e.status==='completed') x.locked++;
      else if(e&&e.auditorId===b.auditorId) x.theirs++;
      else if(e&&e.auditorId) x.other++;
      else x.fresh++;
    });
    const rows=[...by.values()].sort((a,b)=>a.name.localeCompare(b.name));
    if(!rows.length){ showToast(`Nothing to repeat — no buildings are assigned for ${quarter} BOQI${div?' in '+div:''} yet.`,true); return; }
    ofRepeatPlan={quarter,div,rows,buildingIds:div?rows.flatMap(r=>r.ids):null};
    document.getElementById('rep-sub').textContent=`Each auditor gets the same buildings for ${quarter} EOQI as for the BOQI${div?` (${div} only, as filtered)`:''}. You can still change any building afterwards — for an absence or an emergency, give it to someone else in the End of Quarter view.`;
    document.getElementById('rep-list').innerHTML=rows.map(r=>{
      const ok=available.has(r.id);
      const parts=[r.fresh?`${r.fresh} new`:'',r.theirs?`${r.theirs} already theirs`:'',r.other?`${r.other} given to someone else`:'',r.locked?`${r.locked} already inspected`:''].filter(Boolean).join(' · ');
      return `<label class="rep-row${ok?'':' off'}"><input type="checkbox" data-aud="${ovEsc(r.id)}"${ok?' checked':' disabled'}>
        <span><b>${ovEsc(r.name)}</b><small>${r.ids.length} building${r.ids.length===1?'':'s'} at the beginning of the quarter${parts?' — '+parts:''}${ok?'':' · not available now: give these out in the End of Quarter view'}</small></span></label>`;
    }).join('');
    document.getElementById('rep-replace').checked=false;
    // the end of the quarter is the natural deadline for the end-of-quarter visit
    const m=/^(\d{4})-Q([1-4])$/.exec(quarter);
    document.getElementById('rep-due').value=m?new Date(Date.UTC(+m[1],+m[2]*3,0)).toISOString().slice(0,10):'';
    ofRepeatTotal();
    document.getElementById('modal-repeat').classList.add('open');
  }catch(err){ showToast(err.message,true); }
  finally{ btn.disabled=false; }
}
function ofRepeatTotal(){
  if(!ofRepeatPlan) return;
  const replace=document.getElementById('rep-replace').checked;
  const picked=new Set([...document.querySelectorAll('#rep-list [data-aud]:checked')].map(x=>x.dataset.aud));
  const n=ofRepeatPlan.rows.filter(r=>picked.has(r.id)).reduce((t,r)=>t+r.fresh+(replace?r.other:0),0);
  document.getElementById('rep-total').textContent=n?`${n} building${n===1?'':'s'} will be assigned for the end of the quarter.`:'Nothing new to assign — choose auditors above, or tick “replace”.';
  document.getElementById('rep-go').textContent=n?`Assign ${n} building${n===1?'':'s'}`:'Assign';
}
async function ofRunRepeat(){
  const plan=ofRepeatPlan;
  if(!plan) return;
  const auditorIds=[...document.querySelectorAll('#rep-list [data-aud]:checked')].map(x=>x.dataset.aud);
  if(!auditorIds.length){ showToast('Choose at least one auditor.',true); return; }
  const go=document.getElementById('rep-go'), due=document.getElementById('rep-due').value;
  go.disabled=true;
  try{
    const body={auditorIds,replace:document.getElementById('rep-replace').checked};
    if(plan.buildingIds) body.buildingIds=plan.buildingIds;
    if(due) body.dueDate=due;
    const r=await ofRepeat(body);
    closeModal('modal-repeat');
    const bits=[r.alreadyTheirs?`${r.alreadyTheirs} already theirs`:'',r.keptOther?`${r.keptOther} kept with someone else`:'',r.locked?`${r.locked} already inspected`:'',r.unavailable?`${r.unavailable} with an auditor who is not available`:''].filter(Boolean).join(' · ');
    showToast(`${r.assigned} building${r.assigned===1?'':'s'} assigned for ${plan.quarter} EOQI${due?` · due ${dueFmt(due)}`:''}${bits?' · '+bits:''}`);
    // show the result, where any building can still be changed
    const type=document.getElementById('of-type');
    if(type.value!=='EOQI'){ type.value='EOQI'; type.dispatchEvent(new Event('change')); }
    else await loadOfficer();
  }catch(err){ showToast(err.message,true); }
  finally{ go.disabled=false; }
}

async function ofBulk(auditorId,buildingIds,dueDate){
  const body={quarter:ofVal('of-quarter'),type:ofVal('of-type'),auditorId:auditorId||null,buildingIds};
  if(dueDate) body.dueDate=dueDate;
  const res=await fetch('/api/assignments/bulk',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||'Could not save the change.');
  return data;
}
/** Even split that keeps neighbours together: each auditor gets a consecutive run of the
 *  selected buildings (sorted by division → area → name), sized to level everyone's load. */
function ofPlanDistribution(ids){
  const active=ofActiveAuditors().filter(a=>a.role==='quality_auditor');
  if(!active.length) return null;
  const idSet=new Set(ids);
  const blds=ofData.buildings.filter(b=>idSet.has(b.buildingId)&&b.status!=='completed')
    .sort((a,b)=>a.division.localeCompare(b.division)||a.area.localeCompare(b.area)||a.name.localeCompare(b.name));
  const slots=[...active].sort((a,b)=>a.name.localeCompare(b.name)).map(a=>({a,base:0,add:0}));
  const byId=new Map(slots.map(s=>[s.a.id,s]));
  ofData.buildings.forEach(b=>{ const s=b.auditorId&&!idSet.has(b.buildingId)&&byId.get(b.auditorId); if(s) s.base++; });
  blds.forEach(()=>{ slots.reduce((m,s)=>s.base+s.add<m.base+m.add?s:m).add++; });
  const plan=[]; let i=0;
  slots.filter(s=>s.add).forEach(s=>{ plan.push({id:s.a.id,name:s.a.name,total:s.base+s.add,ids:blds.slice(i,i+s.add).map(b=>b.buildingId)}); i+=s.add; });
  return plan;
}
async function ofRunBulk(action){
  const ids=[...ofSelected];
  if(!ids.length) return;
  const buttons=[...document.querySelectorAll('#of-bulk button')];
  const plural=n=>`${n} building${n===1?'':'s'}`;
  try{
    if(action==='assign'){
      const aud=ofVal('of-bulk-auditor'), due=ofVal('of-bulk-due');
      if(!aud){ showToast('Choose an auditor first.',true); return; }
      buttons.forEach(b=>b.disabled=true);
      const r=await ofBulk(aud,ids,due);
      const also=await ofMirror(ids);
      showToast(`Assigned ${plural(r.changed)}${due?` · due ${dueFmt(due)}`:''}${r.unchanged?` · ${r.unchanged} already theirs`:''}${r.skippedCompleted?` · ${r.skippedCompleted} locked`:''}${also}`);
    }else if(action==='unassign'){
      if(!confirm(`Unassign ${plural(ids.length)}? They go back to the unassigned list.`)) return;
      buttons.forEach(b=>b.disabled=true);
      const r=await ofBulk(null,ids);
      showToast(`Unassigned ${plural(r.changed)}${r.skippedCompleted?` · ${r.skippedCompleted} locked`:''}`);
    }else if(action==='due'){
      const due=ofVal('of-bulk-due');
      if(!due&&!confirm(`Remove the deadline from ${plural(ids.length)}?`)) return;
      buttons.forEach(b=>b.disabled=true);
      const r=await ofSetDue(ids,due);
      if(!r) return;
      if(r.skipped) showToast(`${plural(r.updated)} updated · ${r.skipped} not assigned yet`,!r.updated);
    }else if(action==='distribute'){
      const plan=ofPlanDistribution(ids);
      if(!plan){ showToast('There are no active auditors to distribute to.',true); return; }
      const lines=plan.map(p=>`• ${p.name}: +${p.ids.length} (total ${p.total})`).join('\n');
      if(!confirm(`Distribute ${plural(ids.length)} across your auditors, keeping each area together:\n\n${lines}`)) return;
      buttons.forEach(b=>b.disabled=true);
      let changed=0;
      for(const p of plan) changed+=(await ofBulk(p.id,p.ids)).changed;
      const also=await ofMirror(plan.flatMap(p=>p.ids));
      showToast(`Distributed ${plural(changed)} across ${plan.length} auditor${plan.length===1?'':'s'}${also}`);
    }
    ofSelected.clear();
  }catch(err){
    showToast(err.message,true);
  }finally{
    buttons.forEach(b=>b.disabled=false);
    await loadOfficer({quiet:true});
  }
}

// ═══════════════════════════════════════════════════════════
// REPORTS & ANALYTICS (every role; Data Analyst lands here)
// ═══════════════════════════════════════════════════════════
// All inspections arrive once from /api/reports/inspections; filtering,
// grouping and statistics run in the browser so every change is instant.
function rpVal(id){ return document.getElementById(id).value; }
function rpMonthLabel(ym){ return new Date(ym+'-01T12:00:00').toLocaleDateString('en-GB',{month:'long',year:'numeric'}); }
function rpRound(v){ return v==null?null:Math.round(v*10)/10; }
function minOf(vals){ return vals.reduce((a,v)=>v<a?v:a,Infinity); }
function maxOf(vals){ return vals.reduce((a,v)=>v>a?v:a,-Infinity); }
function rpStats(list){
  const vals=list.map(x=>x.overall).filter(v=>typeof v==='number');
  const n=vals.length;
  if(!n) return {count:list.length,n:0,avg:null,min:null,max:null,sd:null};
  const avg=vals.reduce((a,b)=>a+b,0)/n;
  const sd=n>1?Math.sqrt(vals.reduce((a,v)=>a+(v-avg)**2,0)/(n-1)):null;  // one score has no spread — “–”, not 0
  return {count:list.length,n,avg:rpRound(avg),min:minOf(vals),max:maxOf(vals),sd:rpRound(sd)};
}
function rpBandOf(x){ return typeof x.overall==='number'?grade(x.overall).label:null; }
function rpSelect(id,values,allLabel){
  const sel=document.getElementById(id), cur=sel.value;
  sel.innerHTML=`<option value="">${allLabel}</option>`+values.map(v=>`<option value="${ovEsc(v)}">${ovEsc(v)}</option>`).join('');
  sel.value=values.includes(cur)?cur:'';
}
function rpSave(){
  try{
    localStorage.setItem('rp-state',JSON.stringify({
      filters:Object.fromEntries(RP_FILTER_IDS.map(id=>[id,rpVal(id)])),group:rpGroup,sort:rpVal('rp-sort'),metric:rpMetric,trend:rpTrend,
    }));
  }catch{}
}
function rpRestore(){
  let saved=null;
  try{ saved=JSON.parse(localStorage.getItem('rp-state')||'null'); }catch{}
  if(!saved) return;
  if(RP_GROUPS[saved.group]) rpGroup=saved.group;
  if(['avg','sd'].includes(saved.metric)) rpMetric=saved.metric;
  if(['quarter','month','each'].includes(saved.trend)) rpTrend=saved.trend;
  if(['newest','oldest','high','low'].includes(saved.sort)) document.getElementById('rp-sort').value=saved.sort;
  // Values are applied after the option lists exist; rpCascade() drops any that no longer match.
  RP_FILTER_IDS.forEach(id=>{
    const el=document.getElementById(id), v=saved.filters?.[id];
    if(typeof v!=='string') return;
    if(el.tagName==='SELECT'&&![...el.options].some(o=>o.value===v)) return;
    el.value=v;
  });
}

// Division → area → building: each list only offers what fits the level above it.
function rpCascade(){
  const d=rpData;
  const uniq=xs=>[...new Set(xs.filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  rpSelect('rp-division',uniq([...d.buildings.map(b=>b.division),...d.inspections.map(x=>x.division)]),'All divisions');
  const inDiv=d.buildings.filter(b=>!rpVal('rp-division')||b.division===rpVal('rp-division'));
  rpSelect('rp-area',uniq(inDiv.map(b=>b.area)),'All areas');
  const inArea=inDiv.filter(b=>!rpVal('rp-area')||b.area===rpVal('rp-area'));
  const extra=(!rpVal('rp-area'))?d.inspections.filter(x=>!x.buildingId&&(!rpVal('rp-division')||x.division===rpVal('rp-division'))).map(x=>x.building):[];
  rpSelect('rp-building',uniq([...inArea.map(b=>b.name),...extra]),'All buildings');
}

function rpFilter({ignoreRating=false}={}){
  const year=rpVal('rp-year'), month=rpVal('rp-month'), q=rpVal('rp-quarter'), type=rpVal('rp-type'), div=rpVal('rp-division'), area=rpVal('rp-area'),
    bld=rpVal('rp-building'), insp=rpVal('rp-inspector'), rating=ignoreRating?'':rpVal('rp-rating'),
    from=rpVal('rp-from'), to=rpVal('rp-to'), term=rpVal('rp-search').trim().toLowerCase();
  return rpData.inspections.filter(x=>
    (!year||(x.quarter||'').startsWith(year+'-')) &&
    (!month||x.date.startsWith(month+'-')) &&
    (!q||(x.quarter||'').endsWith('-'+q)) &&
    (!type||x.type===type) &&
    (!div||x.division===div) &&
    (!area||x.area===area) &&
    (!bld||x.building===bld) &&
    (!insp||x.inspector===insp) &&
    (!rating||rpBandOf(x)===rating) &&
    (!from||x.date>=from) &&
    (!to||x.date<=to) &&
    (!term||x.building.toLowerCase().includes(term)||x.inspector.toLowerCase().includes(term)||(x.location||'').toLowerCase().includes(term)));
}

function rpGroupRows(list){
  const cfg=RP_GROUPS[rpGroup], map=new Map();
  list.forEach(x=>{
    const key=cfg.key(x);
    if(!map.has(key)) map.set(key,{key,sub:cfg.sub?cfg.sub(x):'',items:[]});
    map.get(key).items.push(x);
  });
  const rows=[...map.values()].map(g=>{
    const bands=Object.fromEntries(RP_BANDS.map(b=>[b,0]));
    g.items.forEach(x=>{ const b=rpBandOf(x); if(b) bands[b]++; });
    const boqi=rpStats(g.items.filter(x=>x.type==='BOQI')).avg, eoqi=rpStats(g.items.filter(x=>x.type==='EOQI')).avg;
    return {...g,...rpStats(g.items),bands,boqi,eoqi,delta:boqi!=null&&eoqi!=null?rpRound(eoqi-boqi):null};
  });
  if(cfg.time) rows.sort((a,b)=>a.key.localeCompare(b.key));
  else rows.sort((a,b)=>(b.avg??-1)-(a.avg??-1)||b.count-a.count||a.key.localeCompare(b.key));
  return rows;
}

function initReports(){
  if(rpReady) return;
  rpReady=true;
  document.getElementById('rp-tabs').addEventListener('click',e=>{ const b=e.target.closest('[data-tab]'); if(b&&b.dataset.tab!==rpTab) rpSetTab(b.dataset.tab); });
  initSavedReports();
  const onChange=()=>{ rpShown=100; rpCascade(); rpSave(); renderReports(); const sv=document.getElementById('rp-saved'); if(sv.value){ sv.value=''; rpRenderSaved(); } };
  RP_FILTER_IDS.forEach(id=>{
    const el=document.getElementById(id);
    el.addEventListener(el.tagName==='INPUT'&&el.type==='text'?'input':'change',onChange);
  });
  document.getElementById('rp-reset').addEventListener('click',()=>{
    RP_FILTER_IDS.forEach(id=>document.getElementById(id).value='');
    onChange();
  });
  document.getElementById('rp-group').addEventListener('click',e=>{
    const chip=e.target.closest('.rp-chip');
    if(!chip) return;
    rpGroup=chip.dataset.group;
    rpSave(); renderReports();
  });
  document.getElementById('rp-metric').addEventListener('click',e=>{
    const chip=e.target.closest('.rp-chip');
    if(!chip) return;
    rpMetric=chip.dataset.metric;
    rpSave(); renderReports();
  });
  document.getElementById('rp-trend').addEventListener('click',e=>{
    const chip=e.target.closest('.rp-chip');
    if(!chip) return;
    rpTrend=chip.dataset.trend;
    rpSave(); renderReports();
  });
  document.getElementById('rp-export').addEventListener('click',()=>openExport(rpTab));
  document.getElementById('rp-bands').addEventListener('click',e=>{
    const band=e.target.closest('.rp-band');
    if(!band) return;
    const sel=document.getElementById('rp-rating');
    sel.value=sel.value===band.dataset.band?'':band.dataset.band;
    onChange();
  });
  // Clicking a summary row drills in: division → its areas → its buildings.
  document.getElementById('rp-group-rows').addEventListener('click',e=>{
    const tr=e.target.closest('tr[data-key]');
    if(!tr) return;
    const drill=RP_GROUPS[rpGroup].drill;
    if(!drill) return;
    drill(tr.dataset.key);
    onChange();
  });
  document.getElementById('rp-sort').addEventListener('change',()=>{ rpShown=100; rpSave(); renderRpDetail(); });
  document.getElementById('rp-detail-rows').addEventListener('click',e=>{ const tr=e.target.closest('tr[data-report]'); if(tr) openReport(Number(tr.dataset.report)); });
  document.getElementById('rp-more').addEventListener('click',()=>{ rpShown+=100; renderRpDetail(); });
}

async function loadReports(){
  initReports();
  rpShowTab();
  const count=document.getElementById('rp-count');
  if(!rpData) count.textContent='Loading…';
  try{
    const res=await fetch('/api/reports/inspections');
    if(!res.ok) throw new Error((await res.json().catch(()=>({}))).error||'Could not load reports.');
    const first=!rpData;
    rpData=await res.json();
    const years=[...new Set(rpData.inspections.map(x=>(x.quarter||'').slice(0,4)).filter(Boolean))].sort().reverse();
    rpSelect('rp-year',years,'All years');
    const months=[...new Set(rpData.inspections.map(x=>x.date.slice(0,7)).filter(m=>/^\d{4}-\d{2}$/.test(m)))].sort().reverse();
    rpSelect('rp-month',months,'All months');
    [...document.getElementById('rp-month').options].forEach(o=>{ if(o.value) o.textContent=rpMonthLabel(o.value); });
    rpSelect('rp-inspector',[...new Set(rpData.inspections.map(x=>x.inspector).filter(Boolean))].sort((a,b)=>a.localeCompare(b)),'All auditors');
    rpCascade();
    if(first){ rpRestore(); rpCascade(); }
    rpShowTab();
  }catch(err){
    count.textContent=err.message;
    showToast(err.message,true);
  }
}

function renderReports(){
  if(!rpData) return;
  const cfg=RP_GROUPS[rpGroup];
  document.querySelectorAll('#rp-group .rp-chip').forEach(c=>c.classList.toggle('active',c.dataset.group===rpGroup));
  document.querySelectorAll('#rp-metric .rp-chip').forEach(c=>c.classList.toggle('active',c.dataset.metric===rpMetric));
  document.querySelectorAll('#rp-trend .rp-chip').forEach(c=>c.classList.toggle('active',c.dataset.trend===rpTrend));
  document.getElementById('rp-group-title').textContent='By '+cfg.label;
  document.getElementById('rp-group-col').textContent=cfg.label;

  const list=rpFilter(), st=rpStats(list);
  document.getElementById('rp-count').textContent=`${list.length} of ${rpData.inspections.length} inspections`;

  // KPI tiles
  const inScope=rpData.buildings.filter(b=>(!rpVal('rp-division')||b.division===rpVal('rp-division'))&&(!rpVal('rp-area')||b.area===rpVal('rp-area'))&&(!rpVal('rp-building')||b.name===rpVal('rp-building')));
  const covered=new Set(list.filter(x=>x.buildingId).map(x=>x.buildingId)).size;
  const best=list.filter(x=>x.overall===st.max)[0], worst=list.filter(x=>x.overall===st.min)[0];
  const tile=(icon,value,label,extra='',color='')=>`<div class="hs-card"><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div><b${color?` style="color:${color}"`:''}>${value}</b><span>${label}</span>${extra}</div>`;
  const note=t=>`<small style="display:block;color:var(--muted);font-size:.7rem;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t}</small>`;
  document.getElementById('rp-stats').innerHTML=
    tile('file-text',list.length,'Inspections',note(`${st.n} scored`))+
    tile('trending-up',st.avg??'–','Average score',st.avg!=null?note(grade(st.avg).label):'',st.avg!=null?grade(st.avg).ink:'')+
    tile('activity',st.sd??'–','Std deviation',note('σ — how spread out scores are'))+
    tile('arrow-up-circle',st.max??'–','Highest',best?note(ovEsc(best.building)):'')+
    tile('arrow-down-circle',st.min??'–','Lowest',worst?note(ovEsc(worst.building)):'')+
    tile('building-2',`${covered}/${inScope.length}`,'Buildings inspected',`<div class="ov-bar" style="margin-top:10px"><i style="width:${inScope.length?Math.round(covered/inScope.length*100):0}%"></i></div>`);

  // Rating bands (counts ignore the rating filter so every band stays clickable)
  const bandBase=rpFilter({ignoreRating:true}), rating=rpVal('rp-rating');
  document.getElementById('rp-bands').innerHTML=RP_BANDS.map(b=>{
    const n=bandBase.filter(x=>rpBandOf(x)===b).length;
    return `<button class="rp-band${rating===b?' active':''}" data-band="${b}"><i style="background:${RP_BAND_COLOR[b]}"></i>${b} <small>${n}</small></button>`;
  }).join('');

  // Summary table + chart
  const groups=rpGroupRows(list);
  const mix=g=>{
    const scored=RP_BANDS.reduce((a,b)=>a+g.bands[b],0);
    if(!scored) return '<span style="color:var(--muted)">–</span>';
    return `<div class="rp-mini" title="${RP_BANDS.map(b=>`${b}: ${g.bands[b]}`).join(' · ')}">${RP_BANDS.map(b=>g.bands[b]?`<i style="width:${g.bands[b]/scored*100}%;background:${RP_BAND_COLOR[b]}"></i>`:'').join('')}</div>`;
  };
  const delta=g=>g.delta==null?'<span style="color:var(--muted)">–</span>'
    :`${g.boqi} → ${g.eoqi} <b style="color:${g.delta>=0?'var(--good)':'#C0392B'}">${g.delta>0?'+':''}${g.delta}</b>`;
  document.getElementById('rp-group-rows').innerHTML=groups.length?groups.map(g=>`
    <tr${cfg.drill?` class="clickable" data-key="${ovEsc(g.key)}" title="Filter to ${ovEsc(g.key)}"`:''}>
      <td><b>${ovEsc(g.key)}</b>${g.sub?`<small>${ovEsc(g.sub)}</small>`:''}</td>
      <td>${g.count}</td>
      <td>${ovScore(g.avg)}</td>
      <td>${g.min??'–'}</td>
      <td>${g.max??'–'}</td>
      <td>${g.n>1?g.sd:'–'}</td>
      <td>${mix(g)}</td>
      <td style="white-space:nowrap">${delta(g)}</td>
    </tr>`).join(''):'<tr><td colspan="8" class="ov-empty">No inspections match these filters.</td></tr>';

  const chartGroups=cfg.time?groups.slice(-24):groups.slice(0,25);
  const withSd=rpMetric==='sd';
  const spread=groups.filter(g=>g.n>1);
  const groupNote=document.getElementById('rp-group-note');
  if(withSd&&spread.length){
    const most=spread.reduce((a,b)=>b.sd>a.sd?b:a), least=spread.reduce((a,b)=>b.sd<a.sd?b:a);
    groupNote.textContent=`Most consistent: ${least.key} (σ ${least.sd}) · Most variable: ${most.key} (σ ${most.sd})`;
  }else{
    groupNote.textContent=withSd?'Std dev needs at least 2 scored inspections in a group':'';
  }
  // One measure per chart (no second axis): average, or the spread of scores.
  const groupSets=withSd
    ?[{label:'Std deviation',data:chartGroups.map(g=>g.n>1?g.sd:null),backgroundColor:'#26A8AB',borderRadius:4,maxBarThickness:48}]
    :[{label:'Average score',data:chartGroups.map(g=>g.avg??0),backgroundColor:chartGroups.map(g=>g.avg!=null?grade(g.avg).color:'#cbd5e1'),borderRadius:4,maxBarThickness:48}];
  if(rpCharts.group) rpCharts.group.destroy();
  rpCharts.group=new Chart(document.getElementById('rp-group-chart'),{
    type:'bar',
    data:{labels:chartGroups.map(g=>g.key),datasets:groupSets},
    options:{responsive:true,maintainAspectRatio:false,
      scales:{y:{beginAtZero:true,max:withSd?undefined:100,ticks:{font:{family:'Cairo'}}},
        x:{ticks:{font:{family:'Cairo',weight:'700'},autoSkip:false,maxRotation:50}}},
      plugins:{legend:{display:false},
        tooltip:{callbacks:{afterBody:items=>{const g=chartGroups[items[0].dataIndex];return `${g.count} inspections · min ${g.min??'–'} · max ${g.max??'–'}`;}}},
        title:{display:groups.length>chartGroups.length,text:`Showing ${chartGroups.length} of ${groups.length} — see the table for all`,font:{family:'Cairo',weight:'600'},color:'#64748b'}}},
  });

  // Scores over time: averaged per quarter or month, or every inspection as its own point
  if(rpCharts.trend) rpCharts.trend.destroy();
  const trendNote=document.getElementById('rp-trend-note');
  let trendRows=[];
  if(rpTrend==='each'){
    const pts=list.filter(x=>typeof x.overall==='number'&&x.date).sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id);
    trendRows=pts.map(x=>[x.date,x.building,x.overall]);
    trendNote.textContent=`${pts.length} scored inspections`;
    rpCharts.trend=new Chart(document.getElementById('rp-trend-chart'),{
      type:'line',
      data:{labels:pts.map(x=>x.date),datasets:[{label:'Score',data:pts.map(x=>x.overall),borderColor:'#0033A0',backgroundColor:'rgba(0,51,160,.08)',
        fill:true,tension:.3,pointRadius:pts.length>80?2:4,pointBackgroundColor:pts.map(x=>grade(x.overall).color)}]},
      options:{responsive:true,maintainAspectRatio:false,
        scales:{y:{beginAtZero:true,max:100,ticks:{font:{family:'Cairo'}}},x:{ticks:{font:{family:'Cairo'},maxRotation:50,autoSkip:true,maxTicksLimit:14}}},
        plugins:{legend:{display:false},tooltip:{callbacks:{title:items=>{const x=pts[items[0].dataIndex];return `${x.building} — ${x.date}`;},
          label:c=>{const x=pts[c.dataIndex];return `${x.overall}/100 · ${x.type||'—'} · ${x.inspector||'—'}`;}}}}},
    });
  }else{
    const keyOf=rpTrend==='month'?(x=>/^\d{4}-\d{2}/.test(x.date)?x.date.slice(0,7):null):(x=>x.quarter);
    const buckets=new Map();
    list.forEach(x=>{ const k=keyOf(x); if(!k) return; if(!buckets.has(k)) buckets.set(k,[]); buckets.get(k).push(x); });
    const keys=[...buckets.keys()].sort();
    trendRows=keys.map(k=>[rpTrend==='month'?rpMonthLabel(k):k,buckets.get(k).length,rpStats(buckets.get(k)).avg]);
    trendNote.textContent='Hover a point for the number of inspections';
    rpCharts.trend=new Chart(document.getElementById('rp-trend-chart'),{
      type:'line',
      data:{labels:keys.map(k=>rpTrend==='month'?new Date(k+'-01T12:00:00').toLocaleDateString('en-GB',{month:'short',year:'numeric'}):k),datasets:[
        {label:'Average score',data:keys.map(k=>rpStats(buckets.get(k)).avg),borderColor:'#26A8AB',backgroundColor:'#26A8AB',borderWidth:2,pointRadius:4,pointBorderColor:'#fff',pointBorderWidth:2,tension:.25,spanGaps:true},
      ]},
      options:vizOptions({interaction:{mode:'index',intersect:false},scales:{y:{beginAtZero:true,max:100}},
        plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>{ const n=buckets.get(keys[c.dataIndex]).length; return `${c.raw??'–'} average · ${n} inspection${n===1?'':'s'}`; }}}}}),
    });
  }

  // Section breakdown (each section normalised to /10)
  const secTotals=new Map(SECTIONS.map(s=>[s.title,{sum:0,n:0}]));
  list.forEach(x=>x.sections.forEach(s=>{
    if(s.score==null||!s.title) return;
    if(!secTotals.has(s.title)) secTotals.set(s.title,{sum:0,n:0});
    const t=secTotals.get(s.title); t.sum+=s.score/s.max*10; t.n++;
  }));
  const secs=[...secTotals.entries()].filter(([,t])=>t.n);
  if(rpCharts.section) rpCharts.section.destroy();
  rpCharts.section=new Chart(document.getElementById('rp-section-chart'),{
    type:'bar',
    data:{labels:secs.map(([t])=>t),datasets:[{label:'Average /10',data:secs.map(([,t])=>rpRound(t.sum/t.n)),
      backgroundColor:secs.map(([,t])=>grade(t.sum/t.n*10).color),borderRadius:5}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      scales:{x:{beginAtZero:true,max:10,ticks:{font:{family:'Cairo'}}},y:{ticks:{font:{family:'Cairo',weight:'700',size:11}}}},
      plugins:{legend:{display:false}}},
  });

  rpView={list,st,covered,inScope,best,worst,groups,trendRows,secs:secs.map(([t,v])=>[t,rpRound(v.sum/v.n),v.n])};
  renderRpDetail(list);
  lucide.createIcons();
}

function rpSorted(list){
  const sort=rpVal('rp-sort'), byDate=(a,b)=>a.date.localeCompare(b.date)||a.id-b.id;
  return [...list].sort(
    sort==='oldest'?byDate:
    sort==='high'?(a,b)=>(b.overall??-1)-(a.overall??-1)||byDate(b,a):
    sort==='low'?(a,b)=>(a.overall??101)-(b.overall??101)||byDate(b,a):
    (a,b)=>byDate(b,a));
}
function renderRpDetail(list=rpFilter()){
  const rows=rpSorted(list), shown=rows.slice(0,rpShown);
  document.getElementById('rp-detail-rows').innerHTML=shown.length?shown.map(x=>{
    const g=typeof x.overall==='number'?grade(x.overall):null;
    return `<tr class="clickable" data-report="${x.id}" title="Open this report">
      <td style="white-space:nowrap">${ovEsc(x.date)}<small>${ovEsc(x.quarter||'')}</small></td>
      <td><b>${ovEsc(x.building)}</b>${x.location?`<small>${ovEsc(x.location)}</small>`:''}</td>
      <td>${ovEsc(x.division||'—')}<small>${ovEsc(x.area||'')}</small></td>
      <td>${ovEsc(x.type||'—')}</td>
      <td>${ovEsc(x.inspector||'—')}</td>
      <td>${ovScore(x.overall)}</td>
      <td>${g?`<span class="ov-pill" style="background:${g.soft};color:${g.ink}">${g.label}</span>`:'–'}</td>
    </tr>`;
  }).join(''):'<tr><td colspan="7" class="ov-empty">No inspections match these filters.</td></tr>';
  const more=document.getElementById('rp-more');
  more.hidden=rows.length<=rpShown;
  more.textContent=`Show more (${rows.length-shown.length} remaining)`;
}

// ═══════════════════════════════════════════════════════════
// ⓘ EXPLANATIONS — a short, plain description for each analysis tool, shown on demand
// ═══════════════════════════════════════════════════════════
const TIPS={
  'home-kpis':['What these numbers are',['Reports on file, average, highest and lowest score count every saved report in the system (not just the list below). Under the highest and lowest score is the building they were given to, with its division and area — tap the card to open that report.','“Reports in” counts reports dated in the current quarter. The list shows the six newest reports — open one to review it, or search them all in Inspection Reports.']],
  'cx-report':['Building your own report',['The four steps on the left decide everything: <b>1</b> which inspections are counted, <b>2</b> what one row stands for, <b>3</b> which columns are measured, <b>4</b> which parts appear.','The page you see <em>is</em> the report — Export gives you exactly these parts and columns as PDF, Excel or an image, nothing else.','<ul><li><b>Buildings in list</b>, <b>Coverage</b> — only for rows that are divisions, areas or buildings; they count the buildings on file, inspected or not.</li><li><b>BOQI / EOQI / Change</b> — averages of each type, and end minus beginning.</li><li><b>Sections</b> — the average of that section, out of 10.</li></ul>','“Save setup” keeps the whole arrangement under a name; share it and the rest of the team sees the same report.']],
  'lib-status':['Review status and search',['<b>Needs review</b>: saved and not yet reviewed. <b>Updated — review again</b>: edited after a decision. <b>Changes requested</b>: sent back to the auditor. <b>Approved</b>: accepted.','Search looks at the building, auditor, division, area and report number. Tick “Also search comments & notes” to look inside what auditors wrote.']],
  'ins-kpis':['Summary cards',['For the chosen period (a quarter or a whole year), type and division:','<ul><li><b>Inspections</b> — reports saved.</li><li><b>Average score</b> — mean overall score out of 100.</li><li><b>Buildings inspected</b> — buildings in the list with at least one inspection ÷ all buildings.</li><li><b>Good or Excellent</b> — share scoring 81 or more.</li><li><b>Poor or Critical</b> — reports scoring 70 or less.</li></ul>','Arrows compare with the period before — the previous quarter, or the previous year. While a year is still in progress it is compared with the same quarters of the year before. Green is better, red is worse.']],
  'ins-trend':['Average score by quarter',['The average overall score for each of the last 8 quarters — one line per division, or the selected division next to all divisions.','Hover a point to see how many inspections it is based on. “View as table” shows the same numbers.']],
  'ins-heat':['Section heatmap',['Each cell is the average score (out of 10) of one checklist section, for a division — or for an area once you pick a division — in the chosen quarter.','Colours follow the rating scale: red = poor or critical, grey = acceptable, blue = good or excellent. “All” is every division together; “Overall” is the full score ÷ 10.','Click a cell to open those inspections in Report Builder.']],
  'ins-board':['Ranking',['Divisions (or areas) sorted by this quarter’s average score.','<b>Change</b> — difference from last quarter’s average. <b>Coverage</b> — buildings inspected ÷ buildings in the list. <b>Weakest section</b> — the section with the lowest average.','Click a division to see its areas.']],
  'ins-fail':['Most often scored 0',['Checklist items that scored 0 most often this quarter. The % is 0-scores ÷ all answers for that item.','Only reports scored item by item count here — imported overall scores are left out.']],
  'ins-attention':['Lowest-scoring buildings',['The buildings with the lowest latest score this quarter — the ones to look at first, whatever their rating. <b>Change</b> compares with the same building’s latest score last quarter.','Click a building to see all its inspections.']],
  'ins-movers':['Biggest movers',['Buildings with both a BOQI and an EOQI this quarter, ranked by how much the score changed between the beginning and the end of the quarter.']],
  'rp-filters':['Filters, grouping and saved reports',['Every filter you set must match (for example CAOSD + EOQI + Q3). <b>Group by</b> decides how the summary, chart and table below are split.','<b>Save report</b> keeps this exact setup to reopen later; tick “share” to make it visible to everyone who can use Analytics.']],
  'rp-summary':['Summary table',['Each row is one group of the matching inspections.','<ul><li><b>Average / Min / Max</b> — of the overall score.</li><li><b>Std dev</b> — how spread out the scores are: small = consistent, large = uneven.</li><li><b>Rating mix</b> — share of each rating.</li><li><b>BOQI → EOQI</b> — the two averages inside the group and the change.</li></ul>','Click a row to drill down (division → area → building).']],
  'rp-chart':['Group chart',['<b>Average</b>: the average score of each group, coloured by rating. <b>Std deviation</b>: how uneven scores are inside each group — taller bars mean less consistent results.','Up to 25 groups are drawn; the table lists all of them.']],
  'rp-trends':['Over time and by section',['Left: the average score over time — per quarter, per month, or every single inspection. Right: the average of each checklist section, out of 10, for the matching inspections.']],
  'rp-detail':['Matching inspections',['Every inspection that matches the filters above. Click a row to open the full report.']],
  'cmp':['Compare two periods',['Choose <b>Quarters</b>, <b>Years</b> or <b>Custom dates</b>, then pick period A (the starting point) and period B. Each side can have its own inspection type. <b>Change = B − A</b>.','<b>Years</b>: if one year has fewer quarters with data (for example the current year), tick “Compare only …” to compare the same quarters of both years. The <b>Quick</b> buttons set common comparisons, such as last year against this year or year to date.','The chart and table split the result by division, area, building, section (out of 10), auditor — or quarter when comparing years.']],
  'cmp-table':['Changes table',['Sorted by the biggest drop first so declines stand out. The small number under each average is how many inspections (or scored sections) it is based on.']],
  'dq-unlinked':['Not linked to a building',['The building name on these reports doesn’t match any name in the buildings list, so Analytics can’t place them in a division or area. The suggestion is the closest name in the list.']],
  'dq-dups':['Possible duplicates',['The same building has more than one BOQI (or more than one EOQI) in the same quarter. Keep the right one, or confirm both are intended.']],
  'dq-incomplete':['Incomplete scoring',['Reports saved with unanswered checklist items. Imported overall scores (with no item detail) also appear here.']],
  'dq-missing':['Missing details',['Reports without a type, date, division or auditor — they drop out of any filter that uses the missing field.']],
  'dq-coverage':['Coverage',['For each division, how many buildings in the list have at least one inspection in the most recent quarter that has data.']],
  'ov-kpis':['Team overview cards',['For the chosen quarter, type and division:','<ul><li><b>Assignments completed</b> — assignments with a saved inspection ÷ all assignments.</li><li><b>Buildings assigned</b> — buildings that have an assignment ÷ buildings in the list.</li><li><b>Average score</b> — mean overall score of the inspections.</li><li><b>Inspections</b> — reports saved. <b>Active auditors</b> — auditor accounts in use.</li></ul>']],
  'ov-division':['By division',['Completion of assignments and the average score for each division. Click a division to focus the whole page on it.']],
  'ov-team':['Officers and auditors',['Auditors (and anyone holding buildings): buildings assigned, how many are done and their average score on completed work. Officers: assignments they made and how many are complete.','Click a person to open their profile.']],
  'ov-area':['By area',['Buildings, assignments, completion and average score for each area.']],
  'ov-building':['By building',['Every building with its status for the filters: <b>Unassigned</b>, <b>Pending</b> (assigned, not inspected yet) or <b>Completed</b>, plus its number of inspections and latest score.']],
  'sch-tables':['The quarter schedule',['Every building assigned for the chosen quarter and type. The first part gives each auditor a table of their own; the list underneath is the same buildings together, by division and area.','<b>Pending</b> means assigned but not inspected yet, <b>Completed</b> means the report is in — open it by tapping the score.','The <b>deadline</b> is set by whoever assigns the quarter. It turns amber in the last week and red once it passes; on a finished building it says whether it was met.','Export gives you the whole schedule or any single auditor\u2019s table, as PDF (one auditor per A4 page) or Excel.']],
  'of-kpis':['Assign & Track cards',['For the chosen quarter and type: <b>Assigned</b> = buildings with someone assigned; <b>Completion</b> = completed ÷ assigned; <b>Pending</b> = assigned but not inspected; <b>Unassigned</b> = still need someone.','Click a card to filter the buildings table. The page refreshes itself every 30 seconds.']],
  'of-team':['Team progress',['One card per person holding buildings this quarter: completion %, assigned / done / pending, average score of completed buildings and when they last submitted. Click a card to show only their buildings.']],
  'of-area':['Progress by area',['How many buildings in each area are assigned, and how many of those are completed.']],
  'of-activity':['Recent activity',['The latest assignments and completed inspections for this quarter.']],
  'of-buildings':['Assigning buildings',['Choose a person for each building, or tick several and use <b>Assign</b> or <b>Distribute evenly</b> (spreads them across auditors, lightest workload first, keeping each area together).','Set a <b>deadline</b> on any assigned building — one date at a time, or a date for everything you have ticked. Leave the date empty and press <b>Set deadline</b> to remove it.','Buildings that were already inspected are locked. Click a score to open that report.']],
  'au-carried':['Still open from earlier quarters',['Buildings assigned in a previous quarter that were never inspected. They still count as open work.']],
  'au-schedule':['Quarter timeline',['Key dates for the quarter and how much of this person’s work is done against them.']],
  'au-quality':['Quality of work',['Across all quarters: inspections completed out of those assigned, the average score of completed work, and the average time from assignment to submission.','The chart shows the average score per quarter (hover for assigned and completed counts); the section chart shows their average per section out of 10.']],
  'sc-scale':['Rating scale',['The five rating bands used everywhere in the system. The highlighted band is where this inspection’s overall score falls.']],
  'sc-sections':['Results by section',['Each section’s score out of 10, how many of its items are answered, and its grade. Click a section to go back and change it.']],
};
function toggleTip(btn){
  const key=btn.dataset.tip, tip=TIPS[key];
  if(!tip) return;
  const host=btn.closest('.hist-hdr,.ov-panel-hd,.hist-filters,.lib-bar')||btn.parentElement;
  let box=host.nextElementSibling;
  if(!box||!box.classList.contains('tip-box')||box.dataset.tip!==key){
    box=document.createElement('div');
    box.className='tip-box'; box.dataset.tip=key; box.hidden=true; box.setAttribute('role','note');
    box.innerHTML=`<i aria-hidden="true">i</i><div><b>${tip[0]}</b>${tip[1].map(t=>t.startsWith('<ul>')?t:`<p>${t}</p>`).join('')}</div><button type="button" class="tip-close" aria-label="Hide explanation">×</button>`;
    host.after(box);
  }
  const open=box.hidden;
  box.hidden=!open;
  btn.classList.toggle('on',open);
  btn.setAttribute('aria-expanded',String(open));
}
document.addEventListener('click',e=>{
  const btn=e.target.closest('.info-tip');
  if(btn){ e.preventDefault(); e.stopPropagation(); toggleTip(btn); return; }
  const close=e.target.closest('.tip-close');
  const box=close&&close.closest('.tip-box');                 // (the Export window's × is a .tip-close too)
  if(box){
    box.hidden=true;
    const b=box.previousElementSibling?.querySelector?.(`.info-tip[data-tip="${box.dataset.tip}"]`)||document.querySelector(`.info-tip[data-tip="${box.dataset.tip}"]`);
    if(b){ b.classList.remove('on'); b.setAttribute('aria-expanded','false'); b.focus(); }
  }
},true);

// ═══════════════════════════════════════════════════════════
// INSPECTION REPORTS — search, open, review
// ═══════════════════════════════════════════════════════════
// The list comes from /api/reports/library (no photos); opening a report loads the full
// record and its review history. Reviewing needs the "review" permission and is never
// allowed on your own report; downloading needs "export".
/** Short review mark for boards and cards: green when approved, amber when changes are due. */
function reviewMark(review){
  if(!review) return '';
  const [label,cls]=LIB_STATUS[review.status]||LIB_STATUS.pending;
  const short={pending:'Needs review',resubmitted:'Review again',changes:'Changes requested',approved:'Approved'}[review.status]||label;
  const title=review.by?`${short} · ${review.by}${review.at?' · '+timeAgo(review.at):''}`:short;
  return `<span class="ov-pill ${cls} rv-mark-pill" title="${ovEsc(title)}">${review.status==='approved'?'✓ ':''}${short}</span>`;
}
const LIB_STATUS={pending:['Needs review','setup'],resubmitted:['Updated — review again','setup'],changes:['Changes requested','suspended'],approved:['Approved','active']};
function libStatusPill(s){ const [l,c]=LIB_STATUS[s]||LIB_STATUS.pending; return `<span class="ov-pill ${c}">${l}</span>`; }
function libFilterIds(){ return ['lib-quarter','lib-type','lib-division','lib-area','lib-auditor','lib-rating','lib-from','lib-to','lib-sort']; }
function libSave(){ stateSave('lib-state',{q:ofVal('lib-q'),comments:document.getElementById('lib-comments').checked,status:libStatus,...Object.fromEntries(libFilterIds().map(id=>[id,ofVal(id)]))}); }
function initLibrary(){
  if(libReady) return;
  libReady=true;
  const saved=stateLoad('lib-state');
  document.getElementById('lib-q').value=saved.q||'';
  document.getElementById('lib-comments').checked=!!saved.comments;
  libStatus=typeof saved.status==='string'?saved.status:null;   // null: pick a default once we know whether this account reviews
  libPending=Object.fromEntries(libFilterIds().map(id=>[id,saved[id]||'']));
  const reload=()=>{ libSave(); loadLibrary(); };
  document.getElementById('lib-q').addEventListener('input',()=>{ clearTimeout(libTimer); libTimer=setTimeout(reload,280); });
  document.getElementById('lib-comments').addEventListener('change',reload);
  libFilterIds().forEach(id=>document.getElementById(id).addEventListener('change',()=>{ if(id==='lib-division') document.getElementById('lib-area').value=''; reload(); }));
  document.getElementById('lib-status').addEventListener('click',e=>{ const c=e.target.closest('[data-status]'); if(!c) return; libStatus=c.dataset.status; reload(); });
  document.getElementById('lib-clear').addEventListener('click',()=>{
    document.getElementById('lib-q').value=''; document.getElementById('lib-comments').checked=false;
    libFilterIds().forEach(id=>{ document.getElementById(id).value=id==='lib-sort'?'newest':''; });
    reload();
  });
  document.getElementById('lib-toggle').addEventListener('click',()=>document.getElementById('lib-filters').classList.toggle('open'));
  document.getElementById('lib-rows').addEventListener('click',e=>{ const tr=e.target.closest('[data-report]'); if(tr) openReport(Number(tr.dataset.report)); });
  document.getElementById('lib-rows').addEventListener('keydown',e=>{ if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-report]')){ e.preventDefault(); openReport(Number(e.target.dataset.report)); } });
  document.getElementById('lib-more').addEventListener('click',()=>loadLibrary({more:true}));
  document.getElementById('lib-export').addEventListener('click',()=>openExport('library'));
  // Report panel
  document.getElementById('rv-drawer').addEventListener('click',e=>{ if(e.target.id==='rv-drawer') closeReport(); });
  document.getElementById('rv-close').addEventListener('click',()=>closeReport());
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&!document.getElementById('rv-drawer').hidden&&!document.getElementById('lb').classList.contains('open')) closeReport(); });
  document.getElementById('rv-body').addEventListener('click',e=>{
    if(e.target.closest('#rv-change')){
      const form=document.getElementById('rv-form');
      if(form){ form.hidden=false; document.getElementById('rv-comment')?.focus(); e.target.closest('#rv-change').hidden=true; }
      return;
    }
    const ver=e.target.closest('[data-ver]');
    if(ver&&rvId){ openReportVersion(rvId,Number(ver.dataset.ver)); return; }
    const b=e.target.closest('[data-rv]');
    if(b) rvAction(b.dataset.rv);
    const img=e.target.closest('img[data-photo]');
    if(img) openLB(img.src);
  });
}
function libParams(){
  const p=new URLSearchParams();
  const q=ofVal('lib-q').trim();
  if(q) p.set('q',q);
  if(q&&document.getElementById('lib-comments').checked) p.set('comments','1');
  libFilterIds().forEach(id=>{ const v=ofVal(id); if(v) p.set(id.replace('lib-',''),v); });
  if(libStatus==='mine') p.set('mine','1'); else if(libStatus) p.set('status',libStatus);
  return p;
}
async function loadLibrary({more=false}={}){
  initLibrary();
  const req=++libReq, p=libParams();
  p.set('limit','50'); p.set('offset',more?String(libRows.length):'0');
  const panel=document.getElementById('lib-panel');
  panel.classList.add('loading');
  try{
    const res=await fetch('/api/reports/library?'+p,{cache:'no-store'});
    const d=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(d.error||'Could not load reports.');
    if(req!==libReq) return;
    if(libStatus===null){ libStatus=d.canReview&&(d.counts.pending+d.counts.resubmitted)?'review':''; if(libStatus) return loadLibrary(); }
    libRows=more?libRows.concat(d.rows):d.rows;
    libData=d;
    renderLibrary();
    // Counts ignore the status tab but respect search and filters, so only an unfiltered view can refresh the menu badge.
    const unfiltered=!ofVal('lib-q').trim()&&libFilterIds().every(id=>id==='lib-sort'||!ofVal(id))&&libStatus!=='mine';
    if(d.canReview&&unfiltered) libSetBadge(d.counts.pending+d.counts.resubmitted);
  }catch(err){
    if(req!==libReq) return;
    document.getElementById('lib-rows').innerHTML=`<tr><td colspan="7" class="ov-empty">${ovEsc(err.message)}</td></tr>`;
  }finally{ if(req===libReq) panel.classList.remove('loading'); }
}
function libSelectValues(id,values,allLabel,{keep=true}={}){
  const el=document.getElementById(id), want=el.value||libPending[id]||'';
  el.innerHTML=`<option value="">${allLabel}</option>`+values.map(v=>`<option value="${ovEsc(v)}">${ovEsc(v)}</option>`).join('');
  el.value=values.includes(want)?want:'';
  if(keep) delete libPending[id];
}
function renderLibrary(){
  const d=libData, c=d.counts;
  ['lib-type','lib-rating','lib-from','lib-to','lib-sort'].forEach(id=>{ if(libPending[id]){ document.getElementById(id).value=libPending[id]; delete libPending[id]; } });
  libSelectValues('lib-quarter',d.facets.quarters,'All quarters');
  libSelectValues('lib-division',d.facets.divisions,'All divisions');
  libSelectValues('lib-area',d.facets.areas,'All areas');
  libSelectValues('lib-auditor',d.facets.auditors,'All auditors');
  const chips=[['','All',c.all],...(d.canReview?[['review','Needs review',c.pending+c.resubmitted]]:[]),['changes','Changes requested',c.changes],['approved','Approved',c.approved],
    ...(hasPerm('inspect')?[['mine','My reports',null]]:[])];
  if(!d.canReview&&libStatus==='review') libStatus='';
  document.getElementById('lib-status').innerHTML=chips.map(([k,l,n])=>`<button class="rp-chip${libStatus===k?' active':''}" data-status="${k}">${l}${n!=null?` <b>${n}</b>`:''}</button>`).join('');
  const active=libFilterIds().filter(id=>id!=='lib-sort'&&ofVal(id)).length+(ofVal('lib-q')?1:0);
  document.getElementById('lib-toggle-n').textContent=active?`(${active})`:'';
  document.getElementById('lib-clear').hidden=!active;
  const q=ofVal('lib-q').trim();
  const mark=t=>{ const safe=ovEsc(t||''); if(!q) return safe; const i=String(t||'').toLowerCase().indexOf(q.toLowerCase()); return i<0?safe:ovEsc(t.slice(0,i))+'<mark>'+ovEsc(t.slice(i,i+q.length))+'</mark>'+ovEsc(t.slice(i+q.length)); };
  document.getElementById('lib-rows').innerHTML=libRows.length?libRows.map(r=>{
    const g=r.overall!=null?grade(r.overall):null;
    return `<tr class="clickable" data-report="${r.id}" tabindex="0" title="Open this report">
      <td class="lib-date">${ovEsc(r.date||'—')}<small>${ovEsc(r.quarter||'')}</small></td>
      <td><b>${mark(r.building)}</b><small>${mark([r.division,r.area].filter(Boolean).join(' · ')||'Not linked to a building')}</small>
        ${r.snippet?`<small class="lib-snip"><svg data-lucide="message-square-quote" width="12" height="12"></svg> ${ovEsc(r.snippet.section||'')}: “${mark(String(r.snippet.text||'').slice(0,140))}”</small>`:''}</td>
      <td>${ovEsc(r.type||'—')}</td>
      <td>${mark(r.auditor||'—')}${r.own?'<small>You</small>':''}</td>
      <td>${g?`<span class="lib-score" style="--c:${g.ink};--soft:${g.soft}">${r.overall}</span><small>${g.label}</small>`:'–'}</td>
      <td>${libStatusPill(r.status)}${r.lastDecision?`<small>${ovEsc(r.lastDecision.by)} · ${timeAgo(r.lastDecision.at)}</small>`:''}</td>
      <td class="lib-open"><svg data-lucide="chevron-right" width="16" height="16"></svg></td>
    </tr>`;
  }).join(''):`<tr><td colspan="7" class="ov-empty">${active||libStatus?'No reports match — try fewer filters or a shorter search.':'No saved reports yet.'}</td></tr>`;
  document.getElementById('lib-count').textContent=`${d.total} report${d.total===1?'':'s'}${q?` for “${q}”`:''}`;
  document.getElementById('lib-more').hidden=libRows.length>=d.total;
  document.getElementById('lib-more').textContent=`Show more (${d.total-libRows.length} more)`;
  lucide.createIcons();
}
function libSetBadge(n){
  if(n==null) return;
  const el=document.getElementById('ns-review');
  el.textContent=n?String(n):'';
}
async function refreshReviewBadge(){
  if(!hasPerm('review')) return;
  try{ const res=await fetch('/api/reports/library?limit=0'); if(res.ok){ const d=await res.json(); libSetBadge(d.counts.pending+d.counts.resubmitted); } }catch{}
}
// ── Report panel ──
async function openReport(id,{fromHash=false}={}){
  initLibrary();
  rvId=id;
  const dr=document.getElementById('rv-drawer');
  dr.hidden=false;
  document.getElementById('rv-title').textContent='Loading report…';
  document.getElementById('rv-meta').textContent='';
  document.getElementById('rv-body').innerHTML='<div class="ov-empty">Loading…</div>';
  if(!fromHash&&document.getElementById('pg-library').classList.contains('active')) window.history.pushState(null,'','#pg-library/'+id);
  try{
    const res=await fetch('/api/inspections/'+id,{cache:'no-store'});
    const d=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(d.error||'Could not open the report.');
    if(rvId!==id) return;
    rvData=d; renderReportPanel();
  }catch(err){
    document.getElementById('rv-title').textContent='Report unavailable';
    document.getElementById('rv-body').innerHTML=`<div class="ov-empty">${ovEsc(err.message)}</div>`;
  }
}
function closeReport(){
  document.getElementById('rv-drawer').hidden=true;
  rvId=null; rvData=null;
  if(document.getElementById('pg-library').classList.contains('active')&&hashParam(location.hash)) window.history.pushState(null,'','#pg-library');
}
function renderReportPanel(){
  const {record:r,summary:s,reviews,canReview,reviewBlockedReason}=rvData;
  const g=s.overall!=null?grade(s.overall):null;
  document.getElementById('rv-title').textContent=s.building||r.facility||'Inspection report';
  document.getElementById('rv-meta').textContent=[s.date,s.typeLabel||s.type,[s.division,s.area].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
  const ring=document.getElementById('rv-ring');
  ring.style.setProperty('--p',s.overall??0); ring.style.setProperty('--c',g?g.color:'#9fb3c8');
  document.getElementById('rv-score').textContent=s.overall??'–';
  document.getElementById('rv-grade').textContent=g?g.label:'—';
  const isAdmin=currentUser?.role==='quality_admin';
  // An approved report is locked: only an administrator changes or removes it.
  const locked=s.status==='approved'&&!isAdmin;
  const canEdit=hasPerm('inspect')&&(s.own||isAdmin)&&!locked;
  const canDelete=isAdmin||(hasPerm('delete')&&s.own&&!locked);
  // A decision is the report's state, not a button waiting to be pressed again. A plain comment never changes it.
  const decided=reviews.find(v=>v.decision!=='comment')||null;
  const mine=!!(decided&&currentUser&&decided.byId===currentUser.id);
  const who=decided?ovEsc(decided.by||'someone'):'';
  const settled=!!decided&&s.status!=='pending';
  const decidedCard=settled?`
    <div class="rv-decided ${s.status}">
      <span class="rv-decided-ic"><svg data-lucide="${s.status==='approved'?'circle-check':s.status==='changes'?'undo-2':'refresh-cw'}" width="17" height="17"></svg></span>
      <div class="rv-decided-txt">
        <b>${s.status==='approved'?(mine?'You approved this report':`Approved by ${who}`)
          :s.status==='changes'?(mine?'You asked for changes':`Changes requested by ${who}`)
          :(mine?'You reviewed this — the auditor has updated it since':`Reviewed by ${who} — the auditor has updated it since`)}</b>
        <small>${timeAgo(decided.at)}${decided.comment?` · “${ovEsc(decided.comment)}”`:''}</small>
      </div>
      ${canReview?`<button type="button" class="btn bo rv-change" id="rv-change">${s.status==='resubmitted'?'Review again':'Change decision'}</button>`:''}
    </div>`:'';
  const formOpen=canReview&&(!settled||s.status==='resubmitted');
  const reviewBox=canReview?`${decidedCard}
    <div class="rv-form" id="rv-form"${formOpen?'':' hidden'}>
      <label for="rv-comment">Review note <small>${settled?'say what changed your mind':'required when requesting changes'}</small></label>
      <textarea id="rv-comment" rows="3" maxlength="2000" placeholder="What looks good, what needs to change…"></textarea>
      <div class="rv-btns">
        <button class="btn bt" data-rv="approved"><svg data-lucide="circle-check" width="15" height="15"></svg> ${s.status==='approved'?'Keep approved':'Approve'}</button>
        <button class="btn bo rv-warn" data-rv="changes_requested"><svg data-lucide="undo-2" width="15" height="15"></svg> Request changes</button>
        <button class="rp-link" data-rv="comment">Comment only</button>
      </div>
    </div>`
    :decidedCard+`<p class="ad-note"><svg data-lucide="info" width="14" height="14"></svg>${reviewBlockedReason==='own'?'This is your report, so someone else reviews it.':'Your account can read reports but not review them — an admin can grant “Review reports” in Admin Control.'}</p>`;
  const words=r.type==='EOQI';   // only the end-of-quarter check is worded as compliance
  const sections=(r.sections||[]).map((sec,si)=>{
    const pct=sec.max?Math.round((sec.score||0)/sec.max*100):0, sg=grade(pct);
    const items=(sec.items||[]).map((it,ii)=>{
      const v=it.score, cls=v==null?'na':v===0?'no':'yes';
      const label=it.label||SECTIONS[si]?.items?.[ii]||`Item ${ii+1}`;
      return `<li class="rv-item ${cls}">
        <span class="rv-mark">${v==null?'–':v===0?'✗':'✓'}</span>
        <div><b>${ovEsc(label)}</b>${it.comment?`<p>${ovEsc(it.comment)}</p>`:''}
          ${(it.photos||[]).length?`<div class="rv-photos">${it.photos.map(src=>`<img src="${ovEsc(src)}" data-photo alt="Photo for ${ovEsc(label)}" loading="lazy">`).join('')}</div>`:''}</div>
        <em>${v==null?'Not scored':words?(v===0?'Not compliant':'Compliant'):v}</em>
      </li>`;
    }).join('');
    const fails=(sec.items||[]).filter(it=>it.score===0).length;
    return `<details class="rv-sec"${fails?' open':''}>
      <summary><span class="rv-sec-t">${ovEsc(sec.title)}</span>${fails?`<span class="rv-fails">${fails} ${words?'not compliant':'scored 0'}</span>`:''}
        <span class="rv-sec-s"><b style="color:${sg.color}">${sec.score??'–'}</b>/${sec.max}</span></summary>
      <ul>${items}</ul>${sec.notes?`<div class="rv-notes"><b>Section notes</b>${ovEsc(sec.notes)}</div>`:''}
    </details>`;
  }).join('');
  const history=reviews.length?reviews.map(v=>`<li><span class="dot" style="background:${v.decision==='approved'?'var(--good)':v.decision==='changes_requested'?'var(--warn)':'var(--royal)'}"><svg data-lucide="${v.decision==='approved'?'check':v.decision==='changes_requested'?'undo-2':'message-square'}" width="14" height="14"></svg></span>
      <div><b>${ovEsc(v.by)}</b> ${v.decision==='approved'?'approved the report':v.decision==='changes_requested'?'requested changes':'commented'}${v.comment?`<div class="ad-log-details">${ovEsc(v.comment)}</div>`:''}<small>${timeAgo(v.at)}</small></div></li>`).join('')
    :'<li class="ov-empty" style="display:block">No reviews yet.</li>';
  document.getElementById('rv-body').innerHTML=`
    <section class="rv-status">
      <div class="rv-status-top">${libStatusPill(s.status)}<span class="rv-auditor">Auditor: <b>${ovEsc(s.auditor||'—')}</b>${s.assigned?' · assigned':''}</span></div>
      ${reviewBox}
    </section>
    <div class="rv-actions">
      ${hasPerm('export')?'<button class="btn br" data-rv="pdf"><svg data-lucide="file-down" width="15" height="15"></svg> Download PDF</button>':''}
      ${hasPerm('export')?'<button class="btn bo" data-rv="print"><svg data-lucide="printer" width="15" height="15"></svg> Print report</button>':''}
      ${canEdit?'<button class="btn bo" data-rv="edit"><svg data-lucide="pencil" width="15" height="15"></svg> Edit report</button>':''}
      <button class="rp-link" data-rv="link"><svg data-lucide="link" width="14" height="14" style="vertical-align:-3px"></svg> Copy link</button>
      ${canDelete?'<button class="rp-link" data-rv="delete" style="color:var(--danger);margin-left:auto"><svg data-lucide="archive" width="14" height="14" style="vertical-align:-3px"></svg> Delete report</button>':''}
    </div>
    ${locked&&s.own?'<p class="ad-note"><svg data-lucide="lock" width="14" height="14"></svg>Approved and locked. If something needs to change, ask an administrator.</p>':''}
    <section><h4>Checklist</h4>${sections||'<p class="ad-note">This report has no section scores (for example, imported trial data).</p>'}</section>
    <section><h4>Review history</h4><ul class="ov-feed ad-log">${history}</ul></section>
    <section><h4>Version history <small class="rv-h4-note">every saved state is kept</small></h4><ul class="ov-feed ad-log" id="rv-versions"><li class="ov-empty" style="display:block">Loading…</li></ul></section>`;
  lucide.createIcons();
  loadReportVersions(r.id);
}
const VERSION_WORDS={submitted:'submitted the report','before-history':'saved the report (before history was kept)',edited:'saved changes',deleted:'deleted the report — moved to the archive',restored:'restored it from the archive'};
async function loadReportVersions(id){
  const box=document.getElementById('rv-versions');
  try{
    const res=await fetch(`/api/inspections/${id}/versions`,{cache:'no-store'});
    const d=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(d.error||'Could not load the history.');
    if(rvId!==id||!box.isConnected) return;
    const list=d.versions||[];
    box.innerHTML=list.length?list.map((v,i)=>{
      const c=v.changes||{}, bits=[c.scores?`${c.scores} score${c.scores===1?'':'s'}`:'',c.comments?`${c.comments} comment${c.comments===1?'':'s'}`:'',c.photos?`photos on ${c.photos} item${c.photos===1?'':'s'}`:''].filter(Boolean);
      const at=v.at?new Date(v.at.replace(' ','T')+'Z'):null;
      return `<li><span class="dot" style="background:${v.reason==='deleted'?'var(--danger)':v.reason==='edited'?'var(--royal)':'var(--good)'}"><svg data-lucide="${v.reason==='edited'?'pencil':v.reason==='deleted'?'archive':v.reason==='restored'?'rotate-ccw':'file-check'}" width="12" height="12"></svg></span>
        <div><b>Version ${v.version}${i===0?' · current':''}</b> — ${ovEsc(v.by||'Unknown')} ${VERSION_WORDS[v.reason]||v.reason}
          <div class="ad-log-details">Score ${v.overall??'–'}${bits.length?' · changed '+bits.join(', '):''}</div>
          <small>${at&&!isNaN(at)?at.toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):''}${hasPerm('export')?` · <button class="rp-link" style="padding:0;min-height:0" data-ver="${v.version}">Open this version</button>`:''}</small></div></li>`;
    }).join(''):'<li class="ov-empty" style="display:block">This report was saved before history was kept; its next change starts the record.</li>';
    lucide.createIcons({nodes:[box]});
  }catch(err){ if(box.isConnected) box.innerHTML=`<li class="ov-empty" style="display:block">${ovEsc(err.message)}</li>`; }
}
async function openReportVersion(id,version){
  try{
    const res=await fetch(`/api/inspections/${id}/versions/${version}`,{cache:'no-store'});
    const d=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(d.error||'Could not open that version.');
    const r=d.record;
    printInspectionReport({inspector:r.inspector,facility:r.facility,division:r.division,date:r.date,type:r.type,typeLabel:r.typeLabel||r.type,overall:r.overall,approvedBy:'',
      filename:`${(r.filename||`${r.date||'inspection'}_${r.type||'Inspection'}_${r.facility||'facility'}.pdf`).replace(/\.pdf$/i,'')}_v${version}.pdf`,sections:r.sections||[]});
  }catch(err){ showToast(err.message,true); }
}
/**
 * A decision changes the report's status everywhere it is shown. The row in view takes the
 * status the server saved straight away, then every list that shows a status reloads from
 * the database — so nothing waits for the user to leave the page and come back.
 */
function afterReview(id,act,status){
  const row=libRows.find(x=>x.id===id);
  if(row&&act!=='comment'&&status){
    row.status=status;
    row.lastDecision={by:currentUser?.name||'You',at:new Date().toISOString().slice(0,19).replace('T',' ')};
    if(libData) renderLibrary();
  }
  const on=p=>document.getElementById(p).classList.contains('active');
  if(on('pg-library')) loadLibrary(); else refreshReviewBadge();   // the library answer carries the badge count
  if(on('pg-home')) loadHome();
  ofData=null; if(on('pg-officer')) loadOfficer();                   // boards and profiles show review marks too
  auData=null; if(on('pg-auditor')) loadAuditorProfile();
}
async function rvAction(act){
  const {record:r,summary:s}=rvData||{};
  if(!r) return;
  if(act==='pdf'||act==='print'){
    const decided=(rvData.reviews||[]).find(v=>v.decision!=='comment');
    const doc={inspector:r.inspector,facility:r.facility,division:r.division,date:r.date,type:r.type,typeLabel:r.typeLabel||r.type,overall:r.overall,
      approvedBy:s&&s.status==='approved'&&decided?decided.by:'',
      filename:r.filename||`${r.date||'inspection'}_${r.type||'Inspection'}_${r.facility||'facility'}.pdf`,sections:r.sections||[]};
    return act==='print'?printInspectionReportNow(doc):printInspectionReport(doc);
  }
  if(act==='edit'){ closeReport(); return editInspection({stopPropagation(){}},r.id,r); }
  if(act==='delete'){
    if(!confirm(`Delete the report for ${s.building} (${s.date})?\n\nIt moves to the archive with all its versions and photos, and an administrator can restore it.`)) return;
    try{
      await dbDelete(r.id);
      showToast('Report moved to the archive'); closeReport();
      if(document.getElementById('pg-library').classList.contains('active')) loadLibrary();
      if(document.getElementById('pg-home').classList.contains('active')) loadHome();
      refreshReviewBadge(); rpData=null;
    }catch(err){ showToast('Could not delete: '+err.message,true); }
    return;
  }
  if(act==='link'){
    const url=`${location.origin}/app#pg-library/${r.id}`;
    try{ await navigator.clipboard.writeText(url); showToast('Link copied'); }catch{ prompt('Copy this link:',url); }
    return;
  }
  const comment=(document.getElementById('rv-comment')?.value||'').trim();
  if(act!=='approved'&&!comment){ document.getElementById('rv-comment').focus(); showToast(act==='comment'?'Write a comment first.':'Explain what needs to change.',true); return; }
  const btns=[...document.querySelectorAll('#rv-body [data-rv]')]; btns.forEach(b=>b.disabled=true);
  try{
    const res=await fetch(`/api/inspections/${r.id}/reviews`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:act,comment})});
    const d=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(d.error||'Could not save the review.');
    showToast(act==='approved'?'Report approved':act==='changes_requested'?'Changes requested — the auditor has been notified':'Comment added');
    afterReview(r.id,act,d.status);
    await openReport(r.id,{fromHash:true});
  }catch(err){ showToast(err.message,true); btns.forEach(b=>b.disabled=false); }
}

// ═══════════════════════════════════════════════════════════
// QUARTER SCHEDULE — the plan everyone can see
// ═══════════════════════════════════════════════════════════
// One table per auditor and one table of the whole list, from the same board the
// officer assigns on, so the plan and the work never disagree.
function schInit(){
  if(schReady) return;
  schReady=true;
  document.getElementById('sch-quarter').innerHTML=ofQuarterOptions().map(q=>`<option value="${q}">${q}${q===ofCurrentQuarter()?' (current)':''}</option>`).join('');
  document.getElementById('sch-quarter').value=ofCurrentQuarter();
  ['sch-quarter','sch-type','sch-auditor'].forEach(id=>document.getElementById(id).addEventListener('change',()=>{
    if(id==='sch-auditor') renderSchedule(); else loadSchedule();
  }));
}
async function loadSchedule(){
  schInit();
  const req=++schReq, q=ofVal('sch-quarter'), t=ofVal('sch-type');
  document.getElementById('sch-note').textContent='Loading…';
  try{
    const res=await fetch(`/api/assignments/schedule?quarter=${encodeURIComponent(q)}&type=${encodeURIComponent(t)}`,{cache:'no-store'});
    const d=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(d.error||'Could not load the schedule.');
    if(req!==schReq) return;
    schData=d;
    const sel=document.getElementById('sch-auditor'), cur=sel.value;
    sel.innerHTML='<option value="">All auditors</option>'+d.auditors.map(a=>`<option value="${ovEsc(a.id)}">${ovEsc(a.name)} (${a.count})</option>`).join('');
    sel.value=d.auditors.some(a=>a.id===cur)?cur:'';
    renderSchedule();
    updateTopBar('pg-schedule');
  }catch(err){
    if(req!==schReq) return;
    document.getElementById('sch-note').textContent='';
    document.getElementById('sch-by-auditor').innerHTML=`<div class="ov-empty">${ovEsc(err.message)}</div>`;
    document.getElementById('sch-all-rows').innerHTML=`<tr><td colspan="7" class="ov-empty">${ovEsc(err.message)}</td></tr>`;
  }
}
const SCH_STATUS={completed:'Completed',pending:'Pending',unassigned:'Unassigned'};
function schResult(b){
  if(b.status!=='completed') return '<span style="color:var(--muted)">–</span>';
  const score=b.inspectionId?`<button class="rp-link" style="padding:0" data-click="openReport" data-id="${b.inspectionId}" title="Open the report">${ovScore(b.score)}</button>`:ovScore(b.score);
  return `${score}<small>${ovEsc(b.inspectionDate||'')}</small>`;
}
function renderSchedule(){
  if(!schData) return;
  const only=ofVal('sch-auditor');
  const assigned=schData.buildings.filter(b=>b.auditorId);
  const shown=only?assigned.filter(b=>b.auditorId===only):assigned;
  const t=schData.totals;
  const tile=(icon,value,label,note)=>`<div class="hs-card"><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div><b>${value}</b><span>${label}</span>${note?`<small style="display:block;color:var(--muted);font-size:.7rem;margin-top:4px">${note}</small>`:''}</div>`;
  const dated=assigned.filter(b=>b.dueDate), overdue=dueOverdue(assigned);
  const nextDue=assigned.filter(b=>b.dueDate&&b.status!=='completed').map(b=>b.dueDate).sort()[0];
  document.getElementById('sch-stats').innerHTML=
    tile('building-2',`${t.assigned}/${t.buildings}`,'Buildings assigned',`${t.unassigned} still unassigned`)+
    tile('users',t.auditors,'Auditors','with buildings this quarter')+
    tile('circle-check',t.completed,'Completed',`${t.assigned-t.completed} still to inspect`)+
    tile('calendar-clock',overdue||(nextDue?dueFmt(nextDue):'—'),overdue?'Past deadline':'Next deadline',
      overdue?`of ${dated.length} with a deadline`:dated.length?`${dated.length} of ${t.assigned} have a deadline`:'No deadline set yet');

  // A table of its own for every auditor.
  const auditors=schData.auditors.filter(a=>!only||a.id===only);
  document.getElementById('sch-by-auditor').innerHTML=auditors.length?auditors.map(a=>{
    const rows=assigned.filter(b=>b.auditorId===a.id).sort((x,y)=>(x.division||'').localeCompare(y.division||'')||(x.area||'').localeCompare(y.area||'')||x.name.localeCompare(y.name));
    return `<div class="ov-panel sch-aud">
      <div class="sch-aud-hd"><i class="of-av">${ovEsc(ofInitials(a.name))}</i>
        <div><b>${ovEsc(a.name)}</b><small>${a.count} building${a.count===1?'':'s'} · ${a.completed} completed · ${a.count-a.completed} to go</small></div>
        <button class="tool-x rp-export" data-ex-ctx="schedule" data-ex-block="aud-${ovEsc(a.id)}" title="Export this auditor's table"><svg data-lucide="download" width="14" height="14"></svg></button></div>
      <div class="ov-scroll"><table class="ov-table sch-t"><thead><tr><th>#</th><th>Building</th><th>Division / Area</th><th>Deadline</th><th>Status</th><th>Result</th></tr></thead>
        <tbody>${rows.length?rows.map((b,i)=>`<tr><td class="num">${i+1}</td>
          <td class="bld" data-l="Building"><b>${ovEsc(b.name)}</b><small>${ovEsc(b.location||'')}</small></td>
          <td data-l="Division">${ovEsc(b.division||'—')}<small>${ovEsc(b.area||'')}</small></td>
          <td data-l="Deadline">${dueChip(b)}</td>
          <td data-l="Status"><span class="ov-pill ${b.status}">${SCH_STATUS[b.status]}</span></td>
          <td data-l="Result">${schResult(b)}</td></tr>`).join('')
          :'<tr><td colspan="6" class="ov-empty">Nothing assigned yet.</td></tr>'}</tbody></table></div></div>`;
  }).join(''):'<div class="ov-panel"><div class="ov-empty">No buildings assigned for this quarter and type yet.</div></div>';

  // And one list of the same buildings together.
  const all=[...shown].sort((x,y)=>(x.division||'').localeCompare(y.division||'')||(x.area||'').localeCompare(y.area||'')||x.name.localeCompare(y.name));
  document.getElementById('sch-all-rows').innerHTML=all.length?all.map((b,i)=>`<tr>
    <td class="num">${i+1}</td>
    <td class="bld" data-l="Building"><b>${ovEsc(b.name)}</b><small>${ovEsc(b.location||'')}</small></td>
    <td data-l="Division">${ovEsc(b.division||'—')}<small>${ovEsc(b.area||'')}</small></td>
    <td data-l="Auditor">${ovEsc(b.auditorName||'—')}</td>
    <td data-l="Deadline">${dueChip(b)}</td>
    <td data-l="Status"><span class="ov-pill ${b.status}">${SCH_STATUS[b.status]}</span></td>
    <td data-l="Result">${schResult(b)}</td></tr>`).join(''):'<tr><td colspan="7" class="ov-empty">Nothing assigned yet.</td></tr>';
  document.getElementById('sch-all-note').textContent=`${all.length} building${all.length===1?'':'s'}${only?' · filtered to one auditor':''}`;
  document.getElementById('sch-note').textContent=`${schData.quarter} · ${schData.type}`;
  schView={assigned,auditors:schData.auditors,totals:t,only};
  lucide.createIcons({nodes:[document.getElementById('pg-schedule')]});
}
/** The schedule exports as it reads: a sheet per auditor, then the whole list. */
function exModelSchedule(){
  if(!schView||!schData) return null;
  const head=['#','Building','Location','Division','Area','Deadline','Status','Score','Inspected on','Auditor'];
  const row=(b,i)=>[i+1,b.name,b.location,b.division,b.area,b.dueDate||null,SCH_STATUS[b.status],b.score,b.inspectionDate,b.auditorName];
  const sheetName=n=>String(n||'Auditor').replace(/[\\/?*\[\]:]/g,' ').slice(0,28);
  const blocks=[{id:'summary',label:'Summary',sheet:'Summary',pdfTable:true,
    kpis:[{label:'Quarter',value:`${schData.quarter} · ${schData.type}`},{label:'Buildings assigned',value:`${schView.totals.assigned} of ${schView.totals.buildings}`},
      {label:'Auditors',value:schView.totals.auditors},{label:'Completed',value:schView.totals.completed},
      {label:'Past deadline',value:dueOverdue(schView.assigned)}],
    table:{head:['Auditor','Buildings','Completed','Still to inspect','Past deadline','Next deadline'],
      rows:schView.auditors.map(a=>{
        const mine=schView.assigned.filter(b=>b.auditorId===a.id);
        const next=mine.filter(b=>b.dueDate&&b.status!=='completed').map(b=>b.dueDate).sort()[0]||null;
        return [a.name,a.count,a.completed,a.count-a.completed,dueOverdue(mine),next];
      })}}];
  schView.auditors.forEach(a=>{
    const rows=schView.assigned.filter(b=>b.auditorId===a.id)
      .sort((x,y)=>(x.division||'').localeCompare(y.division||'')||(x.area||'').localeCompare(y.area||'')||x.name.localeCompare(y.name));
    const next=rows.filter(b=>b.dueDate&&b.status!=='completed').map(b=>b.dueDate).sort()[0];
    blocks.push({id:`aud-${a.id}`,label:`${a.name} · ${rows.length} building${rows.length===1?'':'s'}`,sheet:sheetName(a.name),
      pdfBreak:true,
      // Exported on its own it is that auditor's schedule for this quarter — nothing else.
      docTitle:'Quarter schedule',docNote:a.name,file:`quarter-schedule-${schData.quarter}-${schData.type}-${a.name}`,
      docContext:[['Auditor',a.name],['Quarter',schData.quarter],['Type',schData.type],
        ['Buildings',String(rows.length)],...(next?[['Next deadline',dueFmt(next)]]:[])],
      table:{head:head.slice(0,9),bands:{7:100},rows:rows.map((b,i)=>row(b,i).slice(0,9)),
        // On paper: the columns that fit an A4 page without shrinking the type.
        pdfCols:[0,1,3,4,5,6,7,8],pdfHead:head,resultCols:[7,8]}});
  });
  blocks.push({id:'all',label:'All assigned buildings',sheet:'All buildings',pdfBreak:true,
    table:{head,bands:{7:100},rows:[...schView.assigned].sort((x,y)=>(x.division||'').localeCompare(y.division||'')||(x.area||'').localeCompare(y.area||'')||x.name.localeCompare(y.name)).map(row),
      pdfCols:[0,1,3,5,6,7,9],pdfHead:head,resultCols:[7,8]}});
  const withDue=schView.assigned.filter(b=>b.dueDate).length;
  return {title:'Quarter schedule',file:`schedule-${schData.quarter}-${schData.type}`,
    note:`${schData.quarter} · ${schData.type}`,pdfPage:'portrait',
    context:[['Quarter',schData.quarter],['Type',schData.type],['Buildings assigned',`${schView.totals.assigned} of ${schView.totals.buildings}`],
      ['Auditors',String(schView.totals.auditors)],['With a deadline',`${withDue} of ${schView.totals.assigned}`]],
    blocks};
}

// ═══════════════════════════════════════════════════════════
// REPORTS: INSIGHTS · COMPARE · DATA QUALITY · SAVED REPORTS
// ═══════════════════════════════════════════════════════════
// Everything is computed in the browser from /api/reports/inspections, so switching
// tabs or filters never waits on the server. Chart colours: divisions keep a fixed,
// colour-blind-checked hue (by alphabetical division), Compare uses blue (A) / orange (B),
// and the heatmap diverges around "Acceptable" (red below, grey on it, blue above).
function rpTabLabel(t){ return ({insights:'Insights',builder:'Report Builder',compare:'Compare',custom:'Custom Report',quality:'Data Quality'})[t]||''; }
function rpTabValid(t){ return ['insights','builder','compare','custom','quality'].includes(t); }
function rpShowTab(){
  document.querySelectorAll('#rp-tabs [data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===rpTab));
  ['insights','builder','compare','custom','quality'].forEach(t=>{ document.getElementById('rp-'+t).hidden=t!==rpTab; });
  updateTopBar('pg-reports');
  if(!rpData) return;
  if(rpTab==='insights') renderInsights();
  else if(rpTab==='compare') renderCompare();
  else if(rpTab==='custom'){ renderCustom(); rpLoadSaved(); }
  else if(rpTab==='quality') renderQuality();
  else { renderReports(); rpLoadSaved(); }
}
function rpSetTab(tab){
  if(!rpTabValid(tab)) tab='insights';
  rpTab=tab;
  window.history.pushState(null,'','#'+(tab==='insights'?'pg-reports':`pg-reports/${tab}`));
  rpShowTab();
  document.getElementById('main').scrollTo(0,0);
}
/** Opens Report Builder with a given setup (used by heatmap cells, leaderboard rows and saved reports). */
function rpOpenBuilder(cfg){
  rpApplyConfig({filters:{},group:'building',sort:'low',...cfg});
  rpSetTab('builder');
}

// ── shared helpers ──
// Brand-led series, checked for colour blindness: the closest pair still reads 8.3 apart in OKLab.
const VIZ_SERIES=['#0033A0','#26A8AB','#84BD00','#B4436C','#7A5C00','#2E2E2E'];
const VIZ_INK={primary:'#102040',secondary:'#5F6369',muted:'#6B7178',grid:'#E3E6E9',axis:'#C0C0C0',good:'#00843D',bad:'#B42318'};
/* Charts are drawn on a canvas, which cannot read CSS variables. They are written with the light
   colours; in dark mode this hook draws them with the matching dark ones. */
const DARK_CHART={'#0033a0':'#6E90F2','rgba(0,51,160,.08)':'rgba(110,144,242,.16)','#ffffff':'#162131','#fff':'#162131','#cbd5e1':'#3A4A5E',
  '#102040':'#E3E9F1','#5f6369':'#9CA8B6','#6b7178':'#95A1AE','#e3e6e9':'#26374A','#c0c0c0':'#3A4D63','#b42318':'#FF9B8F','rgba(11,11,11,.12)':'rgba(255,255,255,.14)','#9fb3c8':'#51657D'};
function themeIsDark(){ if(window.__lightCharts) return false; const t=document.documentElement.dataset.theme; return t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches); }
function chartColour(c){ if(!themeIsDark()) return c; if(Array.isArray(c)) return c.map(chartColour); return typeof c==='string'?(DARK_CHART[c.toLowerCase()]||c):c; }
const CHART_KEYS=['backgroundColor','borderColor','pointBackgroundColor','pointBorderColor','color'];
function recolour(obj,memo){
  if(!obj||typeof obj!=='object') return;
  for(const k of CHART_KEYS) if(k in obj){ if(!(k in memo)) memo[k]=obj[k]; obj[k]=chartColour(memo[k]); }
}
const DS_MEMO=new WeakMap();                                  // each dataset's own light colours
if(window.Chart&&Chart.register) Chart.register({id:'osqaTheme',beforeUpdate(chart){
  const o=chart.options||{}, m=chart.$themeMemo||(chart.$themeMemo={scales:{},tip:{}});
  (chart.data.datasets||[]).forEach(ds=>{ let mm=DS_MEMO.get(ds); if(!mm){ mm={}; DS_MEMO.set(ds,mm); } recolour(ds,mm); });
  for(const [id,sc] of Object.entries(o.scales||{})){
    const mm=m.scales[id]||(m.scales[id]={ticks:{},grid:{},border:{},title:{}});
    recolour(sc.ticks,mm.ticks); recolour(sc.grid,mm.grid); recolour(sc.border,mm.border); recolour(sc.title,mm.title);
  }
  const tip=o.plugins&&o.plugins.tooltip; if(tip){ for(const k of ['backgroundColor','titleColor','bodyColor','borderColor']){ if(k in tip){ if(!(k in m.tip)) m.tip[k]=tip[k]; tip[k]=chartColour(m.tip[k]); } } }
  const lg=o.plugins&&o.plugins.legend&&o.plugins.legend.labels; if(lg){ m.lg=m.lg||{}; recolour(lg,m.lg); }
}});
function chartDefaults(){ if(window.Chart&&Chart.defaults){ const d=themeIsDark(); Chart.defaults.color=d?'#9CA8B6':'#666'; Chart.defaults.borderColor=d?'rgba(255,255,255,.10)':'rgba(0,0,0,0.1)'; } }
chartDefaults();
function rpDivisionList(){ return [...new Set((rpData?.buildings||[]).map(b=>b.division).filter(Boolean))].sort((a,b)=>a.localeCompare(b)); }
function divisionColor(div){ const i=rpDivisionList().indexOf(div); return i>=0&&i<VIZ_SERIES.length?VIZ_SERIES[i]:VIZ_INK.muted; }
function prevQuarter(q){ const m=/^(\d{4})-Q([1-4])$/.exec(q||''); if(!m) return null; let y=+m[1], n=+m[2]-1; if(!n){ n=4; y--; } return `${y}-Q${n}`; }
function quarterRange(end,count){ const out=[end]; while(out.length<count) out.unshift(prevQuarter(out[0])); return out; }
function rpQuarters(){ return [...new Set((rpData?.inspections||[]).map(x=>x.quarter).filter(Boolean))].sort().reverse(); }
function rpYears(){ return [...new Set(rpQuarters().map(q=>q.slice(0,4)))]; }
function yearQuarterNums(y){ return new Set(rpQuarters().filter(q=>q.startsWith(y+'-')).map(q=>q.slice(-1))); } // quarters of a year that have data
function fmtQuarterNums(set){ const n=[...set].map(Number).sort(); if(!n.length) return ''; return n.length>1&&n[n.length-1]-n[0]===n.length-1?`Q${n[0]}–Q${n[n.length-1]}`:n.map(v=>'Q'+v).join(', '); }
function yearLabel(y){ const n=yearQuarterNums(y); return n.size&&n.size<4?`${y} · ${fmtQuarterNums(n)}${y===ofCurrentQuarter().slice(0,4)?' so far':''}`:y; }
// A period is "2026-Q3" or "2026"; limit (a set of quarter numbers) keeps only those quarters of a year.
function periodTest(period,limit){ return /^\d{4}$/.test(period||'')?(x=>(x.quarter||'').startsWith(period+'-')&&(!limit||limit.has(x.quarter.slice(-1)))):(x=>x.quarter===period); }
function rpMean(vals){ const v=vals.filter(x=>typeof x==='number'); return v.length?v.reduce((a,b)=>a+b,0)/v.length:null; }
function r1(v){ return v==null?null:Math.round(v*10)/10; }
function sectionShort(title){
  return ({'Arrival & Parking':'Arrival','Entrance & Lobby':'Entrance','Food & Concession':'Food','Elevators & Corridors':'Elevators',
    'Health, Safety & Emergency Readiness':'Safety','Washrooms / Bathrooms':'Washrooms','Miscellaneous':'Misc.'})[title]||title;
}
function sectionScores(x){ // → Map(title → score out of 10)
  const m=new Map();
  (x.sections||[]).forEach(s=>{ if(s.title&&typeof s.score==='number') m.set(s.title,s.score/(s.max||10)*10); });
  return m;
}
function bandFor100(v){ return v==null?null:grade(v).label; }
function heatColor(v10){
  if(v10==null) return ['#ffffff',VIZ_INK.muted];
  const b=grade(v10*10);
  return [b.color,b.on];
}
function heatLegend(){
  return RP_BANDS.map(l=>`<span class="ins-key"><i style="background:${BANDS[l].fill}"></i>${l}</span>`).join('');
}
function vizOptions(extra={}){
  const base={
    responsive:true,maintainAspectRatio:false,animation:{duration:220},
    interaction:{mode:'index',intersect:false},
    scales:{
      x:{grid:{display:false},border:{color:VIZ_INK.axis},ticks:{color:VIZ_INK.secondary,font:{family:'Cairo',size:11,weight:'600'}}},
      y:{grid:{color:VIZ_INK.grid},border:{display:false},ticks:{color:VIZ_INK.muted,font:{family:'Cairo',size:11}}},
    },
    plugins:{
      legend:{position:'bottom',labels:{usePointStyle:true,boxWidth:18,boxHeight:8,color:VIZ_INK.secondary,font:{family:'Cairo',weight:'700'}}},
      tooltip:{backgroundColor:'#ffffff',titleColor:VIZ_INK.secondary,bodyColor:VIZ_INK.primary,borderColor:'rgba(11,11,11,.12)',borderWidth:1,
        padding:10,usePointStyle:true,boxPadding:5,titleFont:{family:'Cairo',weight:'600'},bodyFont:{family:'Cairo',weight:'700'}},
    },
  };
  return deepMerge(base,extra);
}
function deepMerge(a,b){
  const out={...a};
  Object.entries(b||{}).forEach(([k,v])=>{ out[k]=v&&typeof v==='object'&&!Array.isArray(v)&&a[k]&&typeof a[k]==='object'?deepMerge(a[k],v):v; });
  return out;
}
function insDelta(diff,{vs,unit='',inverse=false,neutral=false,digits=1}={}){
  if(diff==null||Number.isNaN(diff)) return `<small class="ins-delta flat">No ${ovEsc(vs||'earlier')} data</small>`;
  const r=Math.round(diff*10**digits)/10**digits;
  if(r===0) return `<small class="ins-delta flat"><svg data-lucide="minus" width="13" height="13"></svg>No change vs ${ovEsc(vs)}</small>`;
  const cls=neutral?'flat':(inverse?r<0:r>0)?'up':'down';
  return `<small class="ins-delta ${cls}"><svg data-lucide="${r>0?'arrow-up-right':'arrow-down-right'}" width="13" height="13"></svg>${r>0?'+':''}${r}${unit} vs ${ovEsc(vs)}</small>`;
}
function deltaCell(diff,{inverse=false}={}){
  if(diff==null) return '<span style="color:var(--muted)">–</span>';
  const r=r1(diff);
  if(!r) return '<span class="ins-dc flat">0</span>';
  const good=inverse?r<0:r>0;
  return `<span class="ins-dc ${good?'up':'down'}">${r>0?'▲ +':'▼ '}${r}</span>`;
}
function stateLoad(key){ try{ return JSON.parse(localStorage.getItem(key)||'{}')||{}; }catch{ return {}; } }
function stateSave(key,v){ try{ localStorage.setItem(key,JSON.stringify(v)); }catch{} }

// ═══ INSIGHTS ═══
function initInsights(){
  if(insReady) return;
  insReady=true;
  const saved=stateLoad('ins-state');
  if(typeof saved.type==='string') document.getElementById('ins-type').value=saved.type;
  insSavedQuarter=saved.quarter||null; insSavedDivision=saved.division||'';
  ['ins-quarter','ins-type','ins-division'].forEach(id=>document.getElementById(id).addEventListener('change',()=>{
    stateSave('ins-state',{quarter:ofVal('ins-quarter'),type:ofVal('ins-type'),division:ofVal('ins-division')});
    renderInsights();
  }));
  document.getElementById('ins-heat').addEventListener('click',e=>{
    const td=e.target.closest('td[data-row]');
    if(td) insOpenCell(td.dataset.row,td.dataset.sec);
  });
  document.getElementById('ins-heat').addEventListener('keydown',e=>{
    if((e.key==='Enter'||e.key===' ')&&e.target.matches('td[data-row]')){ e.preventDefault(); insOpenCell(e.target.dataset.row,e.target.dataset.sec); }
  });
  document.getElementById('ins-board').addEventListener('click',e=>{
    const tr=e.target.closest('tr[data-key]');
    if(!tr) return;
    if(!ofVal('ins-division')&&tr.dataset.key!=='Unknown'){ document.getElementById('ins-division').value=tr.dataset.key; document.getElementById('ins-division').dispatchEvent(new Event('change')); }
    else insOpenCell(tr.dataset.key,'');
  });
  document.getElementById('ins-attention').addEventListener('click',e=>{
    const tr=e.target.closest('tr[data-building]');
    if(tr) rpOpenBuilder({filters:{'rp-building':tr.dataset.building},group:'quarter',sort:'newest'});
  });
}
function insOpenCell(row,sec){
  const Q=ofVal('ins-quarter'), div=ofVal('ins-division'), [y,q]=/^\d{4}$/.test(Q)?[Q,'']:(Q||'').split('-');
  const filters={'rp-year':y||'','rp-quarter':q||'','rp-type':ofVal('ins-type')};
  if(div){ filters['rp-division']=div; filters['rp-area']=row; } else filters['rp-division']=row;
  rpOpenBuilder({filters,group:'building',sort:'low'});
  if(sec) showToast(`Showing ${row} · ${Q} — sort is lowest score first`);
}
function renderInsights(){
  initInsights();
  const qs=rpQuarters(), ys=rpYears(), curQ=ofCurrentQuarter();
  const qSel=document.getElementById('ins-quarter'), wantQ=qSel.value||insSavedQuarter;
  qSel.innerHTML=qs.length?`<optgroup label="Quarter">${qs.map(q=>`<option value="${q}">${q}${q===curQ?' (current)':''}</option>`).join('')}</optgroup>`+
    `<optgroup label="Whole year">${ys.map(y=>`<option value="${y}">${yearLabel(y)}</option>`).join('')}</optgroup>`:'<option value="">No inspections yet</option>';
  qSel.value=[...qs,...ys].includes(wantQ)?wantQ:(qs[0]||'');
  const divSel=document.getElementById('ins-division'), wantD=divSel.value||insSavedDivision;
  rpSelect('ins-division',rpDivisionList(),'All divisions');
  if(!divSel.value&&wantD&&rpDivisionList().includes(wantD)) divSel.value=wantD;
  insSavedQuarter=null; insSavedDivision='';

  // A period is a quarter ("2026-Q3") or a whole year ("2026"). A year is compared with the year before;
  // while a year is still in progress, only the same quarters of the year before are used (like for like).
  const Q=qSel.value, isYear=/^\d{4}$/.test(Q), type=ofVal('ins-type'), div=divSel.value;
  const qnums=isYear?yearQuarterNums(Q):null, likeForLike=!!(qnums&&qnums.size&&qnums.size<4);
  const P=isYear?String(+Q-1):prevQuarter(Q), pLabel=likeForLike?`${P} ${fmtQuarterNums(qnums)}`:P;
  const inScope=(period,limit)=>{ const f=periodTest(period,limit); return x=>f(x)&&(!type||x.type===type)&&(!div||x.division===div); };
  const cur=rpData.inspections.filter(inScope(Q)), prev=rpData.inspections.filter(inScope(P,likeForLike?qnums:null));
  const dimOf=div?(x=>x.area||'Not linked to a building'):(x=>x.division||'Unknown');
  const scopeBuildings=rpData.buildings.filter(b=>!div||b.division===div);
  document.getElementById('ins-compare-note').textContent=!Q?'':likeForLike?`Changes compare ${Q} with the same quarters of ${P} (${fmtQuarterNums(qnums)})`:`Changes compare ${Q} with ${P}`;
  document.getElementById('ins-dim').textContent=div?'Area':'Division';
  document.getElementById('ins-heat-dim').textContent=div?`Area in ${div}`:'Division';
  document.getElementById('ins-board-title').textContent=div?`Areas in ${div}`:'Divisions';

  // KPI tiles
  const kpi=list=>{
    const scored=list.filter(x=>typeof x.overall==='number');
    const covered=new Set(list.filter(x=>x.buildingId).map(x=>x.buildingId)).size;
    return {n:list.length,avg:rpMean(scored.map(x=>x.overall)),covered,
      coverage:scopeBuildings.length?covered/scopeBuildings.length*100:null,
      goodShare:scored.length?scored.filter(x=>x.overall>=81).length/scored.length*100:null,
      low:scored.filter(x=>x.overall<71).length};
  };
  const A=kpi(cur), B=kpi(prev), hasPrev=prev.length>0;
  const tile=(icon,value,label,extra,color)=>`<div class="hs-card"><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div><b${color?` style="color:${color}"`:''}>${value}</b><span>${label}</span>${extra}</div>`;
  document.getElementById('ins-stats').innerHTML=!cur.length
    ?`<div class="ov-empty" style="grid-column:1/-1">No inspections in ${ovEsc(Q||'this period')} for these filters.</div>`
    :tile('file-text',A.n,'Inspections',insDelta(hasPrev?A.n-B.n:null,{vs:pLabel,neutral:true,digits:0}))+
     tile('trending-up',A.avg==null?'–':r1(A.avg),'Average score',insDelta(hasPrev&&A.avg!=null&&B.avg!=null?r1(A.avg)-r1(B.avg):null,{vs:pLabel}),A.avg!=null?grade(A.avg).ink:'')+
     tile('building-2',A.coverage==null?'–':`${Math.round(A.coverage)}%`,'Buildings inspected',insDelta(hasPrev&&A.coverage!=null&&B.coverage!=null?Math.round(A.coverage)-Math.round(B.coverage):null,{vs:pLabel,unit:' pts',digits:0})+`<div class="ov-bar" style="margin-top:8px"><i style="width:${Math.round(A.coverage||0)}%"></i></div>`)+
     tile('award',A.goodShare==null?'–':`${Math.round(A.goodShare)}%`,'Good or Excellent',insDelta(hasPrev&&A.goodShare!=null&&B.goodShare!=null?Math.round(A.goodShare)-Math.round(B.goodShare):null,{vs:pLabel,unit:' pts',digits:0}))+
     tile('triangle-alert',A.low,'Poor or Critical',insDelta(hasPrev?A.low-B.low:null,{vs:pLabel,inverse:true,digits:0}),A.low?'var(--c-b42318)':'');

  // Trend: average per quarter, one line per division (or the chosen division against all divisions)
  const endQ=isYear?(qs.find(q=>q.startsWith(Q+'-'))||`${Q}-Q4`):Q;
  const quarters=quarterRange(endQ||curQ,8).filter(q=>!qs.length||q>=qs[qs.length-1]);
  const all=rpData.inspections.filter(x=>!type||x.type===type);
  const seriesDefs=div
    ?[{label:div,color:divisionColor(div),pick:x=>x.division===div},{label:'All divisions',color:VIZ_INK.muted,pick:()=>true}]
    :rpDivisionList().map(d=>({label:d,color:divisionColor(d),pick:x=>x.division===d}));
  const series=seriesDefs.map(sd=>({...sd,points:quarters.map(q=>{ const l=all.filter(x=>x.quarter===q&&sd.pick(x)); return {avg:r1(rpMean(l.map(x=>x.overall))),n:l.length}; })}))
    .filter(sd=>sd.points.some(p=>p.avg!=null));
  const vals=series.flatMap(s=>s.points.map(p=>p.avg)).filter(v=>v!=null);
  if(rpCharts.insTrend) rpCharts.insTrend.destroy();
  rpCharts.insTrend=new Chart(document.getElementById('ins-trend-chart'),{
    type:'line',
    data:{labels:quarters,datasets:series.map(s=>({label:s.label,data:s.points.map(p=>p.avg),borderColor:s.color,backgroundColor:s.color,
      borderWidth:2,pointRadius:4,pointHoverRadius:6,pointBorderColor:'#ffffff',pointBorderWidth:2,tension:.25,spanGaps:true}))},
    options:vizOptions({
      scales:{y:{min:vals.length?Math.max(0,Math.floor((Math.min(...vals)-5)/10)*10):0,max:100}},
      plugins:{tooltip:{itemSort:(a,b)=>(b.raw??-1)-(a.raw??-1),callbacks:{
        label:c=>{ const p=series[c.datasetIndex].points[c.dataIndex]; return p.avg==null?null:`${p.avg}  ${c.dataset.label} · ${p.n} inspection${p.n===1?'':'s'}`; }}}},
    }),
  });
  document.getElementById('ins-trend-note').textContent=series.length?`${quarters[0]} – ${quarters[quarters.length-1]}${type?' · '+type:''}`:'No data yet';
  document.getElementById('ins-trend-table').innerHTML=`<thead><tr><th>Quarter</th>${series.map(s=>`<th>${ovEsc(s.label)}</th>`).join('')}</tr></thead><tbody>${
    quarters.map((q,i)=>`<tr><td><b>${q}</b></td>${series.map(s=>`<td>${s.points[i].avg??'–'}${s.points[i].n?`<small>${s.points[i].n} insp.</small>`:''}</td>`).join('')}</tr>`).join('')}</tbody>`;

  // Heatmap: section average (/10) for each division or area
  const rows=[...new Set(cur.map(dimOf))].sort((a,b)=>a.localeCompare(b));
  const cols=SECTIONS.map(s=>s.title);
  const acc=new Map();
  const add=(r,c,v)=>{ const k=r+'|'+c; if(!acc.has(k)) acc.set(k,[]); acc.get(k).push(v); };
  cur.forEach(x=>{
    const r=dimOf(x), sc=sectionScores(x);
    cols.forEach(c=>{ if(sc.has(c)){ add(r,c,sc.get(c)); add('__all',c,sc.get(c)); } });
    if(typeof x.overall==='number'){ add(r,'__overall',x.overall/10); add('__all','__overall',x.overall/10); }
  });
  const cell=(r,c)=>{ const v=acc.get(r+'|'+c); return v?r1(rpMean(v)):null; };
  const count=(r,c)=>(acc.get(r+'|'+c)||[]).length;
  insHeatData={rows,cols,cell,label:div?'Area':'Division'};
  const td=(r,c,label)=>{ const v=cell(r,c), [bg,fg]=heatColor(v);
    return `<td class="hm" style="background:${bg};color:${fg}" ${r==='__all'?'':`data-row="${ovEsc(r)}" data-sec="${ovEsc(c)}" tabindex="0"`}
      title="${ovEsc(label)} · ${ovEsc(c==='__overall'?'Overall':c)}: ${v??'no data'}${v!=null?'/10':''} (${count(r,c)} inspection${count(r,c)===1?'':'s'})">${v??'–'}</td>`; };
  document.getElementById('ins-heat').innerHTML=rows.length?`<thead><tr><th>${div?'Area':'Division'}</th>${cols.map(c=>`<th title="${ovEsc(c)}">${ovEsc(sectionShort(c))}</th>`).join('')}<th>Overall</th></tr></thead>
    <tbody>${rows.map(r=>`<tr><th scope="row">${ovEsc(r)}</th>${cols.map(c=>td(r,c,r)).join('')}${td(r,'__overall',r)}</tr>`).join('')}</tbody>
    <tfoot><tr><th scope="row">All</th>${cols.map(c=>td('__all',c,'All')).join('')}${td('__all','__overall','All')}</tr></tfoot>`
    :`<tbody><tr><td class="ov-empty">No inspections in ${ovEsc(Q||'this period')}.</td></tr></tbody>`;
  document.getElementById('ins-heat-legend').innerHTML=heatLegend();

  // Leaderboard
  const prevBy=new Map();
  prev.forEach(x=>{ const k=dimOf(x); if(!prevBy.has(k)) prevBy.set(k,[]); prevBy.get(k).push(x.overall); });
  const buildingsIn=k=>scopeBuildings.filter(b=>(div?b.area:b.division)===k);
  const board=rows.map(k=>{
    const l=cur.filter(x=>dimOf(x)===k), avg=rpMean(l.map(x=>x.overall)), pAvg=rpMean(prevBy.get(k)||[]);
    const total=buildingsIn(k).length, covered=new Set(l.filter(x=>x.buildingId).map(x=>x.buildingId)).size;
    const weakest=cols.map(c=>[c,cell(k,c)]).filter(([,v])=>v!=null).sort((a,b)=>a[1]-b[1])[0];
    return {k,n:l.length,avg:r1(avg),delta:avg!=null&&pAvg!=null?r1(r1(avg)-r1(pAvg)):null,total,covered,weakest};
  }).sort((a,b)=>(b.avg??-1)-(a.avg??-1));
  document.getElementById('ins-board').innerHTML=board.length?board.map(r=>`<tr class="clickable" data-key="${ovEsc(r.k)}" title="${div?'Open in Report Builder':'Show areas in '+ovEsc(r.k)}">
      <td><b>${ovEsc(r.k)}</b><small>${r.n} inspection${r.n===1?'':'s'}</small></td>
      <td>${ovScore(r.avg)}</td>
      <td>${deltaCell(r.delta)}</td>
      <td>${r.total?ovPct(r.covered,r.total):'<span style="color:var(--muted)">–</span>'}</td>
      <td>${r.weakest?`${ovEsc(sectionShort(r.weakest[0]))}<small>${r.weakest[1]}/10</small>`:'–'}</td>
    </tr>`).join(''):'<tr><td colspan="5" class="ov-empty">Nothing to rank yet.</td></tr>';

  // Most frequent non-compliant checklist items
  const items=new Map();
  cur.forEach(x=>(x.sections||[]).forEach(s=>{
    const si=SECTIONS.findIndex(d=>d.title===s.title);
    if(si<0) return;
    (s.items||[]).forEach((v,ii)=>{
      if(v==null||!SECTIONS[si].items[ii]) return;
      const key=si+'|'+ii; if(!items.has(key)) items.set(key,{si,ii,n:0,fails:0});
      const it=items.get(key); it.n++; if(v===0) it.fails++;
    });
  }));
  const minN=Math.min(3,Math.max(0,...[...items.values()].map(i=>i.n)));
  const failing=[...items.values()].filter(i=>i.fails&&i.n>=minN).map(i=>({...i,rate:i.fails/i.n}))
    .sort((a,b)=>b.rate-a.rate||b.fails-a.fails).slice(0,8);
  document.getElementById('ins-fail').innerHTML=failing.length?failing.map(i=>`<li>
      <div class="ins-fail-top"><b>${ovEsc(SECTIONS[i.si].items[i.ii])}</b><span>${Math.round(i.rate*100)}%</span></div>
      <div class="ins-fail-bar"><i style="width:${Math.max(3,Math.round(i.rate*100))}%"></i></div>
      <small>${ovEsc(SECTIONS[i.si].title)} · scored 0 in ${i.fails} of ${i.n} inspections</small>
    </li>`).join(''):'<li class="ov-empty" style="display:block">No non-compliant items recorded in this period.</li>';

  // Buildings needing attention (lowest latest score in the period) and biggest movers (BOQI → EOQI)
  const byBuilding=new Map();
  const bKey=x=>x.buildingId?'id'+x.buildingId:'n'+normNameClient(x.building);
  cur.forEach(x=>{ const k=bKey(x); if(!byBuilding.has(k)) byBuilding.set(k,[]); byBuilding.get(k).push(x); });
  const prevLatest=new Map();
  prev.forEach(x=>{ const k=bKey(x), c=prevLatest.get(k); if(!c||x.date>c.date) prevLatest.set(k,x); });
  const latest=[...byBuilding.entries()].map(([k,l])=>{ const x=l.slice().sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id)[0]; return {k,x,prev:prevLatest.get(k)}; })
    .filter(r=>typeof r.x.overall==='number').sort((a,b)=>a.x.overall-b.x.overall).slice(0,6);
  document.getElementById('ins-attention').innerHTML=latest.length?latest.map(({x,prev:p})=>{ const g=grade(x.overall); return `<tr class="clickable" data-building="${ovEsc(x.building)}" title="Open this building's inspections">
      <td><b>${ovEsc(x.building)}</b><small>${ovEsc([x.division,x.area].filter(Boolean).join(' · ')||'Not linked')}</small></td>
      <td>${ovScore(x.overall)}<small>${ovEsc(x.type||'')} · ${ovEsc(x.date)}</small></td>
      <td>${deltaCell(p&&typeof p.overall==='number'?x.overall-p.overall:null)}</td>
      <td><span class="ov-pill" style="background:${g.soft};color:${g.ink}">${g.label}</span></td>
    </tr>`; }).join(''):'<tr><td colspan="4" class="ov-empty">No scored inspections in this period.</td></tr>';

  const inQ=periodTest(Q), moversBase=rpData.inspections.filter(x=>inQ(x)&&(!div||x.division===div)&&typeof x.overall==='number');
  const pairs=new Map();
  // Pairs are always within one quarter, so a whole year lists each quarter's BOQI → EOQI separately.
  moversBase.forEach(x=>{ if(x.type!=='BOQI'&&x.type!=='EOQI') return; const k=bKey(x)+'|'+x.quarter; if(!pairs.has(k)) pairs.set(k,{}); const e=pairs.get(k); if(!e[x.type]||x.date>e[x.type].date) e[x.type]=x; });
  const movers=[...pairs.values()].filter(e=>e.BOQI&&e.EOQI).map(e=>({x:e.EOQI,from:e.BOQI.overall,to:e.EOQI.overall,d:e.EOQI.overall-e.BOQI.overall}))
    .filter(m=>m.d).sort((a,b)=>Math.abs(b.d)-Math.abs(a.d)).slice(0,6);
  document.getElementById('ins-movers').innerHTML=movers.length?movers.map(m=>`<tr>
      <td><b>${ovEsc(m.x.building)}</b><small>${ovEsc([m.x.division,m.x.area,isYear?m.x.quarter:''].filter(Boolean).join(' · '))}</small></td>
      <td>${m.from} → ${m.to}</td><td>${deltaCell(m.d)}</td></tr>`).join('')
    :`<tr><td colspan="3" class="ov-empty">No building has both a BOQI and an EOQI in ${ovEsc(Q||'this period')} yet.</td></tr>`;
  insView={Q,P:pLabel,type,div,A,B,hasPrev,quarters,series,heat:insHeatData,board,failing,latest,movers};
  lucide.createIcons();
}
function normNameClient(s){ return String(s||'').toLowerCase().replace(/\s+/g,' ').trim(); }

// ═══ COMPARE ═══
// Compare two periods: quarters, whole years (optionally like for like) or any date range.
function cmpDimLabel(d=cmpDim){ return ({division:'Division',area:'Area',building:'Building',section:'Section',inspector:'Auditor',quarter:'Quarter'})[d]||''; }
function cmpDims(){ return ['division','area','building','section','inspector',...(cmpMode==='year'?['quarter']:[])]; }
function cmpFmtDate(d){ return new Date(d+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); }
function cmpRangeLabel(f,t){ return f&&t?`${cmpFmtDate(f)} – ${cmpFmtDate(t)}`:f?`From ${cmpFmtDate(f)}`:t?`Until ${cmpFmtDate(t)}`:'All dates'; }
function initCompare(){
  if(cmpReady) return;
  cmpReady=true;
  const saved=stateLoad('cmp-state');
  cmpMode=['quarter','year','custom'].includes(saved.mode)?saved.mode:'quarter';
  cmpDim=['division','area','building','section','inspector','quarter'].includes(saved.dim)?saved.dim:'division';
  ['cmp-a','cmp-b','cmp-a-type','cmp-b-type','cmp-division'].forEach(id=>{ if(typeof saved[id]==='string') document.getElementById(id).dataset.want=saved[id]; });
  ['cmp-a-from','cmp-a-to','cmp-b-from','cmp-b-to'].forEach(id=>{ if(typeof saved[id]==='string') document.getElementById(id).value=saved[id]; });
  if(['drop','gain','name'].includes(saved['cmp-sort'])) document.getElementById('cmp-sort').value=saved['cmp-sort'];
  document.getElementById('cmp-sameq').checked=saved.sameq===true;
  const rerender=()=>{ cmpSave(); renderCompare(); };
  ['cmp-a','cmp-b','cmp-a-type','cmp-b-type','cmp-division','cmp-sort','cmp-a-from','cmp-a-to','cmp-b-from','cmp-b-to','cmp-sameq'].forEach(id=>document.getElementById(id).addEventListener('change',rerender));
  document.getElementById('cmp-dim').addEventListener('click',e=>{ const c=e.target.closest('[data-dim]'); if(!c) return; cmpDim=c.dataset.dim; rerender(); });
  document.getElementById('cmp-mode').addEventListener('click',e=>{
    const c=e.target.closest('[data-mode]');
    if(!c||c.dataset.mode===cmpMode) return;
    cmpMode=c.dataset.mode;
    ['cmp-a','cmp-b'].forEach(id=>{ const el=document.getElementById(id); el.value=''; el.dataset.want=''; });
    rerender();
  });
  document.getElementById('cmp-quick').addEventListener('click',e=>{ const b=e.target.closest('[data-quick]'); if(b){ cmpQuick(b.dataset.quick); rerender(); } });
  document.getElementById('cmp-swap').addEventListener('click',()=>{
    [['cmp-a','cmp-b'],['cmp-a-type','cmp-b-type'],['cmp-a-from','cmp-b-from'],['cmp-a-to','cmp-b-to']].forEach(([x,y])=>{
      const a=document.getElementById(x), b=document.getElementById(y), v=a.value; a.value=b.value; b.value=v;
    });
    rerender();
  });
}
// Ready-made comparisons, based on the latest quarter that has inspections.
function cmpQuick(kind){
  const latestQ=rpQuarters()[0];
  if(!latestQ){ showToast('There are no inspections to compare yet.',true); return; }
  const y=latestQ.slice(0,4), set=(id,v)=>{ document.getElementById(id).value=v; };
  const pick=(mode,a,b)=>{ cmpMode=mode; [['cmp-a',a],['cmp-b',b]].forEach(([id,v])=>{ const el=document.getElementById(id); el.value=''; el.dataset.want=v; }); };
  if(kind==='qoq') pick('quarter',prevQuarter(latestQ),latestQ);
  else if(kind==='yoyq') pick('quarter',`${+y-1}-${latestQ.slice(5)}`,latestQ);
  else if(kind==='yoy'){ pick('year',String(+y-1),y); document.getElementById('cmp-sameq').checked=false; }
  else if(kind==='ytd'){
    // 1 January up to today (or the last inspection of that year), against the same dates a year earlier.
    const today=new Date().toISOString().slice(0,10);
    const last=rpData.inspections.map(x=>x.date).filter(d=>d&&d.startsWith(y+'-')).sort().pop()||`${y}-12-31`;
    const end=y===today.slice(0,4)?today:last;
    const back=d=>{ const md=d.slice(4); return (+d.slice(0,4)-1)+(md==='-02-29'?'-02-28':md); };
    cmpMode='custom';
    set('cmp-a-from',`${+y-1}-01-01`); set('cmp-a-to',back(end)); set('cmp-b-from',`${y}-01-01`); set('cmp-b-to',end);
  }
}
function cmpSave(){ stateSave('cmp-state',{mode:cmpMode,dim:cmpDim,sameq:document.getElementById('cmp-sameq').checked,...Object.fromEntries(['cmp-a','cmp-b','cmp-a-type','cmp-b-type','cmp-division','cmp-sort','cmp-a-from','cmp-a-to','cmp-b-from','cmp-b-to'].map(id=>[id,ofVal(id)]))}); }
// Average per group for both periods. Sections are out of 10, everything else out of 100.
function cmpGroupRows(dim,LA,LB){
  const bySection=dim==='section';
  const keyOf=x=>dim==='division'?(x.division||'Unknown'):dim==='area'?(x.area||'Not linked to a building'):dim==='building'?(x.building||'Unknown')
    :dim==='quarter'?(x.quarter||'').slice(5)||'Unknown':(x.inspector||'Unknown');
  const groupsOf=l=>{
    const m=new Map(), push=(k,v)=>{ if(!m.has(k)) m.set(k,[]); if(typeof v==='number') m.get(k).push(v); };
    l.forEach(x=>{ if(bySection) sectionScores(x).forEach((v,t)=>push(t,v)); else push(keyOf(x),x.overall); });
    return m;
  };
  const ga=groupsOf(LA), gb=groupsOf(LB);
  const keys=bySection?SECTIONS.map(s=>s.title).filter(t=>ga.has(t)||gb.has(t)):[...new Set([...ga.keys(),...gb.keys()])];
  return keys.map(k=>{ const a=r1(rpMean(ga.get(k)||[])), b=r1(rpMean(gb.get(k)||[])); return {key:k,a,b,nA:(ga.get(k)||[]).length,nB:(gb.get(k)||[]).length,d:a!=null&&b!=null?r1(b-a):null}; });
}
function cmpSortRows(rows,dim){
  const sort=ofVal('cmp-sort'), natural=dim==='section'?()=>0:(x,y)=>x.key.localeCompare(y.key);
  return [...rows].sort(sort==='gain'?(x,y)=>(y.d??-999)-(x.d??-999):sort==='name'?natural:(x,y)=>(x.d??999)-(y.d??999));
}
function renderCompare(){
  initCompare();
  document.getElementById('rp-compare').dataset.mode=cmpMode;
  document.querySelectorAll('#cmp-mode [data-mode]').forEach(c=>c.classList.toggle('active',c.dataset.mode===cmpMode));

  // Period lists follow the mode; a period picked by a quick comparison stays listed even without data.
  const base=cmpMode==='year'?rpYears():rpQuarters(), valid=v=>cmpMode==='year'?/^\d{4}$/.test(v):/^\d{4}-Q[1-4]$/.test(v);
  ['cmp-a','cmp-b'].forEach((id,i)=>{
    const sel=document.getElementById(id), want=sel.dataset.want||sel.value;
    const vals=[...new Set([...base,...(want&&valid(want)?[want]:[])])].sort().reverse();
    sel.innerHTML=vals.map(v=>`<option value="${v}">${cmpMode==='year'?yearLabel(v):v}${base.includes(v)?'':' · no data'}</option>`).join('')||'<option value="">No data</option>';
    sel.value=vals.includes(want)?want:(base[i===0?1:0]||base[0]||'');
    sel.dataset.want='';
  });
  if(cmpMode==='custom'&&!['cmp-a-from','cmp-a-to','cmp-b-from','cmp-b-to'].some(id=>ofVal(id))) cmpQuick('ytd');
  ['cmp-a-type','cmp-b-type'].forEach(id=>{ const el=document.getElementById(id); if(el.dataset.want){ el.value=el.dataset.want; el.dataset.want=''; } });
  const divSel=document.getElementById('cmp-division'), wantD=divSel.value||divSel.dataset.want;
  rpSelect('cmp-division',rpDivisionList(),'All divisions');
  if(wantD&&rpDivisionList().includes(wantD)) divSel.value=wantD;
  divSel.dataset.want='';
  if(!cmpDims().includes(cmpDim)) cmpDim='division';
  document.querySelectorAll('#cmp-dim [data-dim]').forEach(c=>{ c.hidden=!cmpDims().includes(c.dataset.dim); c.classList.toggle('active',c.dataset.dim===cmpDim); });

  // Whole years: when one year has fewer quarters with data, offer to compare only the quarters both have.
  const note=document.getElementById('cmp-note'), sameq=document.getElementById('cmp-sameq');
  let limit=null;
  note.hidden=true;
  if(cmpMode==='year'){
    const ya=ofVal('cmp-a'), yb=ofVal('cmp-b'), qa=yearQuarterNums(ya), qb=yearQuarterNums(yb);
    const both=new Set([...qa].filter(q=>qb.has(q)));
    if(ya!==yb&&both.size&&(qa.size!==both.size||qb.size!==both.size)){
      note.hidden=false;
      document.getElementById('cmp-sameq-label').textContent=`Compare only ${fmtQuarterNums(both)} of each year`;
      document.getElementById('cmp-sameq-hint').textContent=sameq.checked
        ?`Like for like: ${ya} and ${yb} both use ${fmtQuarterNums(both)}.`
        :`Whole years as recorded: ${ya} has ${fmtQuarterNums(qa)}, ${yb} has ${fmtQuarterNums(qb)}.`;
      if(sameq.checked) limit=both;
    }
  }

  const div=ofVal('cmp-division');
  const side=s=>{
    const t=ofVal(`cmp-${s}-type`);
    let label, test;
    if(cmpMode==='custom'){
      let f=ofVal(`cmp-${s}-from`), to=ofVal(`cmp-${s}-to`);
      if(f&&to&&f>to) [f,to]=[to,f];
      label=cmpRangeLabel(f,to); test=x=>!!x.date&&(!f||x.date>=f)&&(!to||x.date<=to);
    }else{
      const v=ofVal(`cmp-${s}`);
      label=v+(limit?` ${fmtQuarterNums(limit)}`:''); test=periodTest(v,limit);
    }
    return {label:label+(t?` · ${t}`:''),list:rpData.inspections.filter(x=>test(x)&&(!t||x.type===t)&&(!div||x.division===div))};
  };
  const SA=side('a'), SB=side('b'), LA=SA.list, LB=SB.list, A=SA.label, B=SB.label, vs=cmpMode==='custom'?'A':A;
  const scopeBuildings=rpData.buildings.filter(b=>!div||b.division===div);
  const sum=l=>{ const s=l.filter(x=>typeof x.overall==='number'); return {n:l.length,avg:r1(rpMean(s.map(x=>x.overall))),
    cov:scopeBuildings.length?Math.round(new Set(l.filter(x=>x.buildingId).map(x=>x.buildingId)).size/scopeBuildings.length*100):null,
    good:s.length?Math.round(s.filter(x=>x.overall>=81).length/s.length*100):null,low:s.filter(x=>x.overall<71).length}; };
  const sa=sum(LA), sb=sum(LB);
  const tile=(icon,label,a,b,d,unit='')=>`<div class="hs-card"><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div>
    <b>${a??'–'}${unit} <span class="cmp-arrow">→</span> ${b??'–'}${unit}</b><span>${label}</span>${d}</div>`;
  document.getElementById('cmp-stats').innerHTML=
    tile('file-text','Inspections',sa.n,sb.n,insDelta(sb.n-sa.n,{vs,neutral:true,digits:0}))+
    tile('trending-up','Average score',sa.avg,sb.avg,insDelta(sa.avg!=null&&sb.avg!=null?sb.avg-sa.avg:null,{vs}))+
    tile('building-2','Buildings inspected',sa.cov,sb.cov,insDelta(sa.cov!=null&&sb.cov!=null?sb.cov-sa.cov:null,{vs,unit:' pts',digits:0}),'%')+
    tile('award','Good or Excellent',sa.good,sb.good,insDelta(sa.good!=null&&sb.good!=null?sb.good-sa.good:null,{vs,unit:' pts',digits:0}),'%')+
    tile('triangle-alert','Poor or Critical',sa.low,sb.low,insDelta(LA.length||LB.length?sb.low-sa.low:null,{vs,inverse:true,digits:0}));

  const bySection=cmpDim==='section';
  cmpRows=cmpSortRows(cmpGroupRows(cmpDim,LA,LB),cmpDim);
  document.getElementById('cmp-col').textContent=cmpDimLabel();
  document.getElementById('cmp-a-col').textContent=A; document.getElementById('cmp-b-col').textContent=B;
  document.getElementById('cmp-rows').innerHTML=cmpRows.length?cmpRows.map(r=>`<tr>
      <td><b>${ovEsc(r.key)}</b></td>
      <td>${r.a??'–'}<small>${r.nA} ${bySection?'scored':'inspection'+(r.nA===1?'':'s')}</small></td>
      <td>${r.b??'–'}<small>${r.nB} ${bySection?'scored':'inspection'+(r.nB===1?'':'s')}</small></td>
      <td>${deltaCell(r.d)}</td></tr>`).join('')
    :'<tr><td colspan="4" class="ov-empty">Nothing to compare for these periods.</td></tr>';

  const chartRows=(cmpDim==='quarter'?[...cmpRows].sort((x,y)=>x.key.localeCompare(y.key)):cmpRows).slice(0,20);
  if(rpCharts.cmp) rpCharts.cmp.destroy();
  rpCharts.cmp=new Chart(document.getElementById('cmp-chart'),{
    type:'bar',
    data:{labels:chartRows.map(r=>bySection?sectionShort(r.key):r.key),datasets:[
      {label:A,data:chartRows.map(r=>r.a),backgroundColor:'#0033A0',borderRadius:4,borderSkipped:'bottom',maxBarThickness:28,borderColor:'#ffffff',borderWidth:{right:2}},
      {label:B,data:chartRows.map(r=>r.b),backgroundColor:'#26A8AB',borderRadius:4,borderSkipped:'bottom',maxBarThickness:28,borderColor:'#ffffff',borderWidth:{right:2}},
    ]},
    options:vizOptions({scales:{y:{beginAtZero:true,max:bySection?10:100},x:{ticks:{autoSkip:false,maxRotation:45}}},
      plugins:{tooltip:{callbacks:{label:c=>{ const r=chartRows[c.dataIndex], v=c.raw; return v==null?null:`${v}  ${c.dataset.label} · ${c.datasetIndex?r.nB:r.nA} ${bySection?'scored':'inspections'}`; }}}}}),
  });
  document.getElementById('cmp-chart-note').textContent=cmpRows.length>chartRows.length?`First ${chartRows.length} of ${cmpRows.length} in the table order`:'';
  cmpView={A,B,vs,sa,sb,LA,LB,div,limit,chartCount:chartRows.length,nb:scopeBuildings.length};
  lucide.createIcons();
}

// ═══ DATA QUALITY ═══
function initQuality(){
  if(dqReady) return;
  dqReady=true;
  document.getElementById('dq-stats').addEventListener('click',e=>{ const t=e.target.closest('[data-jump]'); if(t) document.getElementById(t.dataset.jump)?.scrollIntoView({behavior:'smooth',block:'start'}); });
}
function buildingSuggestion(name){
  // Generic words ("BLDG", "building") say nothing about which building it is, and a one- or
  // two-digit number matches far too many names, so only distinctive words and 3+ digit numbers count.
  const generic=new Set(['bldg','building','blg','no','the']);
  const tokens=s=>new Set(String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(' ').filter(w=>w&&!generic.has(w)));
  const digits=s=>(String(s||'').match(/\d{3,}/g)||[]).join('-');
  const t=tokens(name), d=digits(name);
  let best=null;
  rpData.buildings.forEach(b=>{
    const bt=tokens(b.name), inter=[...t].filter(x=>bt.has(x)).length, union=new Set([...t,...bt]).size||1;
    const score=inter/union*0.6+(d&&d===digits(b.name)?0.4:0);
    if(!best||score>best.score) best={b,score};
  });
  return best&&best.score>=0.5?best:null;
}
function renderQuality(){
  initQuality();
  const ins=rpData.inspections, total=SECTIONS.reduce((n,s)=>n+s.items.length,0);
  const unlinked=ins.filter(x=>!x.buildingId);
  const missing=ins.filter(x=>!x.type||!x.date||!x.division||!x.inspector);
  const incomplete=ins.map(x=>{ const answered=(x.sections||[]).reduce((n,s)=>n+(s.items||[]).filter(v=>v!=null).length,0); return {x,answered}; })
    .filter(r=>r.answered<total);
  const dupMap=new Map();
  ins.forEach(x=>{ if(!x.quarter||(x.type!=='BOQI'&&x.type!=='EOQI')) return; const k=(x.buildingId?'id'+x.buildingId:'n'+normNameClient(x.building))+'|'+x.quarter+'|'+x.type; if(!dupMap.has(k)) dupMap.set(k,[]); dupMap.get(k).push(x); });
  const dups=[...dupMap.values()].filter(l=>l.length>1);
  const latestQ=rpQuarters()[0];
  const inspectedLatest=new Set(ins.filter(x=>x.quarter===latestQ&&x.buildingId).map(x=>x.buildingId));
  const notInspected=rpData.buildings.filter(b=>!inspectedLatest.has(b.id));
  dqIssues=[
    ...unlinked.map(x=>{ const sg=buildingSuggestion(x.building); return {issue:'Not linked to a building',x,detail:sg?`Closest match: ${sg.b.name}`:''}; }),
    ...missing.map(x=>({issue:'Missing details',x,detail:['type','date','division','inspector'].filter(k=>!x[k]).map(k=>k==='inspector'?'auditor':k).join(', ')})),
    ...incomplete.map(r=>({issue:'Incomplete scoring',x:r.x,detail:`${r.answered} of ${total} items answered`})),
    ...dups.flatMap(l=>l.map(x=>({issue:'Possible duplicate',x,detail:`${l.length} ${x.type} inspections in ${x.quarter}`}))),
  ];
  const tile=(icon,value,label,note,jump,bad)=>`<div class="hs-card clickable" data-jump="${jump}" title="Go to the list"><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div>
    <b style="color:${value&&bad?'var(--c-b42318)':value?'':'var(--good)'}">${value}</b><span>${label}</span><small style="display:block;color:var(--muted);font-size:.7rem;margin-top:4px">${note}</small></div>`;
  document.getElementById('dq-stats').innerHTML=
    tile('unlink',unlinked.length,'Not linked to a building','Reports can’t place them in a division or area','dq-unlinked',true)+
    tile('copy',dups.length,'Possible duplicates','Same building, quarter and type','dq-dups',true)+
    tile('list-checks',incomplete.length,'Incomplete scoring','Saved with unanswered items','dq-incomplete',true)+
    tile('file-question',missing.length,'Missing details','No type, date, division or auditor','dq-missing',true)+
    tile('building-2',notInspected.length,`Not inspected in ${latestQ||'—'}`,`${rpData.buildings.length-notInspected.length} of ${rpData.buildings.length} buildings covered`,'dq-coverage',false);
  document.getElementById('dq-ok').hidden=!!(unlinked.length||dups.length||incomplete.length||missing.length);

  const row=(x,extra)=>`<tr><td>${ovEsc(x.date||'—')}<small>${ovEsc(x.quarter||'')}</small></td><td><b>${ovEsc(x.building||'—')}</b><small>${ovEsc(x.type||'No type')}</small></td><td>${ovEsc(x.inspector||'—')}</td><td>${extra}</td></tr>`;
  const empty=(cols,msg)=>`<tr><td colspan="${cols}" class="ov-empty">${msg}</td></tr>`;
  document.getElementById('dq-unlinked-rows').innerHTML=unlinked.length?unlinked.map(x=>{ const s=buildingSuggestion(x.building);
    return row(x,s?`<span class="dq-sugg"><svg data-lucide="sparkles" width="13" height="13"></svg>${ovEsc(s.b.name)}</span><small>${ovEsc(s.b.division)} · ${ovEsc(s.b.area)} · ${Math.round(s.score*100)}% match</small>`:'<span style="color:var(--muted)">No close match — check the name</span>'); }).join('')
    :empty(4,'Every inspection is linked to a building.');
  document.getElementById('dq-dups-rows').innerHTML=dups.length?dups.map(l=>{ const x=l[0];
    return `<tr><td><b>${ovEsc(x.building)}</b><small>${ovEsc(x.division||'')}</small></td><td>${ovEsc(x.quarter)} · ${ovEsc(x.type)}</td><td>${l.length}</td>
      <td>${l.map(i=>`${ovEsc(i.date)} · ${ovEsc(i.inspector||'—')} · ${i.overall??'–'}`).join('<br>')}</td></tr>`; }).join('')
    :empty(4,'No duplicates found.');
  document.getElementById('dq-incomplete-rows').innerHTML=incomplete.length?incomplete.map(r=>row(r.x,`${ovPct(r.answered,total)}<small>${r.answered} of ${total} items</small>`)).join('')
    :empty(4,'All saved inspections are fully scored.');
  document.getElementById('dq-missing-rows').innerHTML=missing.length?missing.map(x=>row(x,ovEsc(['type','date','division','inspector'].filter(k=>!x[k]).map(k=>k==='inspector'?'auditor':k).join(', ')))).join('')
    :empty(4,'No inspections are missing details.');
  const byDiv=new Map();
  rpData.buildings.forEach(b=>{ if(!byDiv.has(b.division)) byDiv.set(b.division,{total:0,missing:[]}); const e=byDiv.get(b.division); e.total++; if(!inspectedLatest.has(b.id)) e.missing.push(b); });
  document.getElementById('dq-coverage-title').textContent=`Buildings without an inspection in ${latestQ||'the latest quarter'}`;
  document.getElementById('dq-coverage-rows').innerHTML=[...byDiv.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([d,e])=>`<tr>
      <td><b>${ovEsc(d)}</b></td><td>${ovPct(e.total-e.missing.length,e.total)}<small>${e.total-e.missing.length} of ${e.total} inspected</small></td>
      <td>${e.missing.length?`<details><summary>${e.missing.length} building${e.missing.length===1?'':'s'}</summary><div class="dq-list">${e.missing.map(b=>`${ovEsc(b.name)} <small>${ovEsc(b.area)}</small>`).join('<br>')}</div></details>`:'<span style="color:var(--good);font-weight:800">All inspected</span>'}</td>
    </tr>`).join('')||empty(3,'No buildings in the list.');
  dqView={latestQ,total:rpData.buildings.length,counts:{unlinked:unlinked.length,dups:dups.length,incomplete:incomplete.length,missing:missing.length,notInspected:notInspected.length},
    coverage:[...byDiv.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([d,e])=>({division:d,total:e.total,missing:e.missing}))};
  lucide.createIcons();
}

// ═══ SAVED REPORTS (Report Builder) ═══
function rpCurrentConfig(){
  return {filters:Object.fromEntries(RP_FILTER_IDS.map(id=>[id,rpVal(id)])),group:rpGroup,sort:rpVal('rp-sort'),metric:rpMetric,trend:rpTrend};
}
function rpApplyConfig(cfg){
  RP_FILTER_IDS.forEach(id=>{ document.getElementById(id).value=''; });
  rpCascade();
  if(RP_GROUPS[cfg.group]) rpGroup=cfg.group;
  if(['avg','sd'].includes(cfg.metric)) rpMetric=cfg.metric;
  if(['quarter','month','each'].includes(cfg.trend)) rpTrend=cfg.trend;
  if(['newest','oldest','high','low'].includes(cfg.sort)) document.getElementById('rp-sort').value=cfg.sort;
  // Division before area before building, re-cascading between each so the options exist.
  RP_FILTER_IDS.forEach(id=>{
    const el=document.getElementById(id), v=cfg.filters?.[id];
    if(typeof v!=='string'||!v) return;
    if(el.tagName==='SELECT'&&![...el.options].some(o=>o.value===v)) el.add(new Option(v,v));
    el.value=v;
    if(id==='rp-division'||id==='rp-area') rpCascade();
  });
  rpShown=100; rpSave();
}
async function rpLoadSaved(){
  try{
    const res=await fetch('/api/reports/saved');
    rpSavedList=res.ok?(await res.json()).reports||[]:[];
  }catch{ rpSavedList=[]; }
  rpRenderSaved();
}
function rpRenderSaved(){
  const sel=document.getElementById('rp-saved'), cur=sel.value;
  const list=rpSavedList.filter(r=>r.config?.kind!=='custom');
  const mine=list.filter(r=>r.mine), shared=list.filter(r=>!r.mine);
  const opt=r=>`<option value="${r.id}">${ovEsc(r.name)}${r.mine&&r.shared?' · shared':''}${!r.mine?' · '+ovEsc(r.owner):''}</option>`;
  sel.innerHTML=`<option value="">${list.length?'Saved reports…':'No saved reports yet'}</option>`+
    (mine.length?`<optgroup label="My reports">${mine.map(opt).join('')}</optgroup>`:'')+
    (shared.length?`<optgroup label="Shared with everyone">${shared.map(opt).join('')}</optgroup>`:'');
  sel.value=list.some(r=>String(r.id)===cur)?cur:'';
  const r=list.find(x=>String(x.id)===sel.value);
  document.getElementById('rp-saved-del').hidden=!(r&&r.canDelete);
  if(cxReady) cxRenderSaved();
}
function initSavedReports(){
  if(rpSavedReady) return;
  rpSavedReady=true;
  const sel=document.getElementById('rp-saved');
  sel.addEventListener('change',()=>{
    const r=rpSavedList.find(x=>String(x.id)===sel.value);
    document.getElementById('rp-saved-del').hidden=!(r&&r.canDelete);
    if(!r) return;
    rpApplyConfig(r.config); renderReports();
    showToast(`Loaded “${r.name}”`);
  });
  document.getElementById('rp-save').addEventListener('click',()=>{
    document.getElementById('sr-form').dataset.kind='builder';
    const r=rpSavedList.find(x=>String(x.id)===sel.value&&x.mine);
    document.getElementById('sr-name').value=r?r.name:'';
    document.getElementById('sr-shared').checked=r?r.shared:false;
    document.getElementById('sr-msg').style.display='none';
    document.getElementById('modal-save-report').classList.add('open');
    setTimeout(()=>document.getElementById('sr-name').focus(),50);
  });
  document.getElementById('sr-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const msg=document.getElementById('sr-msg');
    try{
      const res=await fetch('/api/reports/saved',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        name:document.getElementById('sr-name').value,shared:document.getElementById('sr-shared').checked,
        config:document.getElementById('sr-form').dataset.kind==='custom'?{kind:'custom',...cx}:rpCurrentConfig()})});
      const d=await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(d.error||'Could not save the report.');
      closeModal('modal-save-report');
      showToast(d.updated?'Saved report updated':'Report saved');
      await rpLoadSaved();
      const target=document.getElementById('sr-form').dataset.kind==='custom'?'cx-saved':'rp-saved';
      document.getElementById(target).value=String(d.id);
      rpRenderSaved(); if(cxReady) cxRenderSaved();
    }catch(err){ msg.textContent=err.message; msg.style.display='block'; }
  });
  document.getElementById('modal-save-report').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeModal('modal-save-report'); });
  document.getElementById('rp-saved-del').addEventListener('click',async()=>{
    const r=rpSavedList.find(x=>String(x.id)===sel.value);
    if(!r||!confirm(`Delete the saved report “${r.name}”?`)) return;
    try{
      const res=await fetch('/api/reports/saved/'+r.id,{method:'DELETE'});
      if(!res.ok) throw new Error((await res.json().catch(()=>({}))).error||'Could not delete it.');
      showToast('Saved report deleted'); sel.value='';
    }catch(err){ showToast(err.message,true); }
    rpLoadSaved();
  });
}

// ═══════════════════════════════════════════════════════════
// CUSTOM REPORT — choose what the report covers, what each row is, which columns
// it carries and which parts appear. The preview is the report, and the export
// (PDF, Excel or image) carries exactly what is on screen — nothing else.
// ═══════════════════════════════════════════════════════════
const CX_DIMS={
  division: {label:'Division', key:x=>x.division||'Unknown', bkey:b=>b.division},
  area:     {label:'Area', key:x=>x.area||'Not linked to a building', bkey:b=>b.area},
  building: {label:'Building', key:x=>x.building||'Unknown', bkey:b=>b.name},
  inspector:{label:'Auditor', key:x=>x.inspector||'Unknown'},
  quarter:  {label:'Quarter', key:x=>x.quarter||'No date', time:true},
  month:    {label:'Month', key:x=>(x.date||'').slice(0,7)||'No date', time:true},
  type:     {label:'Inspection type', key:x=>x.type||'Unknown'},
};
const cxAvg=list=>r1(rpMean(list.filter(v=>typeof v==='number')));
const cxTypeAvg=(g,t)=>cxAvg(g.list.filter(x=>x.type===t).map(x=>x.overall));
const cxShare=(g,test)=>g.scores.length?Math.round(g.scores.filter(test).length/g.scores.length*100):null;
// Every column the report can carry. `needsBuildings` marks the ones that only
// make sense when the rows are buildings, areas or divisions.
const CX_METRICS=[
  ['Coverage',[
    ['buildings','Buildings in list',g=>g.buildings?g.buildings.length:null,{needsBuildings:true}],
    ['inspected','Buildings inspected',g=>g.covered],
    ['coverage','Coverage (%)',g=>g.buildings&&g.buildings.length?Math.round(g.covered/g.buildings.length*100):null,{needsBuildings:true,unit:'%'}],
    ['areas','Areas',g=>new Set(g.list.map(x=>x.area).filter(Boolean)).size],
    ['auditors','Auditors',g=>new Set(g.list.map(x=>x.inspector).filter(Boolean)).size],
    ['inspections','Inspections',g=>g.list.length],
  ]],
  ['Scores',[
    ['avg','Average score',g=>cxAvg(g.scores)],
    ['min','Lowest',g=>g.scores.length?minOf(g.scores):null],
    ['max','Highest',g=>g.scores.length?maxOf(g.scores):null],
    ['sd','Std deviation',g=>g.scores.length>1?rpStats(g.list).sd:null],
  ]],
  ['Beginning and end of quarter',[
    ['boqi','BOQI average',g=>cxTypeAvg(g,'BOQI')],
    ['eoqi','EOQI average',g=>cxTypeAvg(g,'EOQI')],
    ['change','Change (EOQI − BOQI)',g=>{ const a=cxTypeAvg(g,'BOQI'), b=cxTypeAvg(g,'EOQI'); return a!=null&&b!=null?r1(b-a):null; }],
  ]],
  ['Ratings',[
    ['good','Good or Excellent (%)',g=>cxShare(g,v=>v>=81),{unit:'%'}],
    ['low','Poor or Critical (%)',g=>cxShare(g,v=>v<71),{unit:'%'}],
    ...RP_BANDS.map(b=>['band_'+b,b,g=>g.list.filter(x=>rpBandOf(x)===b).length]),
  ]],
  ['Sections (out of 10)',SECTIONS.map((sec,i)=>['sec_'+i,sec.title,g=>{
    const vals=[]; g.list.forEach(x=>{ const v=sectionScores(x).get(sec.title); if(typeof v==='number') vals.push(v); });
    return cxAvg(vals);
  }])],
];
const CX_PARTS=[['cards','Summary cards'],['chart','Chart'],['table','Table'],['list','Inspection list']];
const CX_METRIC=Object.fromEntries(CX_METRICS.flatMap(([,items])=>items.map(([id,label,calc,opt])=>[id,{label,calc,...(opt||{})}])));
const CX_DEFAULT={period:'',scores:'both',division:'',area:'',building:'',auditor:'',group:'division',
  metrics:['inspected','inspections','avg','boqi','eoqi','change'],parts:['cards','chart','table'],chartMetric:'avg',chartType:'bar'};

function cxLoad(){
  const saved=stateLoad('cx-state')||{};
  delete saved.kind;
  cx={...CX_DEFAULT,...saved};
  cx.metrics=(cx.metrics||[]).filter(id=>CX_METRIC[id]);
  cx.parts=(cx.parts||[]).filter(id=>CX_PARTS.some(([p])=>p===id));
  if(!CX_DIMS[cx.group]) cx.group='division';
}
function cxSave(){ stateSave('cx-state',cx); }

function initCustom(){
  if(cxReady) return;
  cxReady=true;
  cxLoad();
  document.getElementById('cx-group').innerHTML=Object.entries(CX_DIMS)
    .map(([id,d])=>`<button type="button" class="rp-chip" data-dim="${id}">${d.label}</button>`).join('');
  document.getElementById('cx-metrics').innerHTML=CX_METRICS.map(([title,items])=>
    `<div class="cx-group-t">${ovEsc(title)}</div>`+items.map(([id,label])=>
      `<label class="cx-opt"><input type="checkbox" data-metric="${id}"> ${ovEsc(label)}</label>`).join('')).join('');
  document.getElementById('cx-parts').innerHTML=CX_PARTS.map(([id,label])=>
    `<label class="cx-opt"><input type="checkbox" data-part="${id}"> ${ovEsc(label)}</label>`).join('');
  const onChange=()=>{ cxRead(); cxSave(); renderCustom(); const sel=document.getElementById('cx-saved'); if(sel.value){ sel.value=''; cxRenderSaved(); } };
  ['cx-period','cx-scores','cx-division','cx-area','cx-building','cx-auditor','cx-chart-metric','cx-chart-type']
    .forEach(id=>document.getElementById(id).addEventListener('change',onChange));
  document.getElementById('cx-group').addEventListener('click',e=>{
    const chip=e.target.closest('[data-dim]');
    if(chip){ cx.group=chip.dataset.dim; cxSave(); renderCustom(); }
  });
  document.getElementById('cx-metrics').addEventListener('change',onChange);
  document.getElementById('cx-parts').addEventListener('change',onChange);
  document.getElementById('cx-cols-none').addEventListener('click',()=>{
    document.querySelectorAll('#cx-metrics [data-metric]').forEach(b=>{ b.checked=false; });
    onChange();
  });
  document.getElementById('cx-reset').addEventListener('click',()=>{ cx={...CX_DEFAULT}; cxSave(); renderCustom(); });
  document.getElementById('cx-export').addEventListener('click',()=>openExport('custom'));
  document.getElementById('cx-save').addEventListener('click',()=>cxOpenSave());
  document.getElementById('cx-saved').addEventListener('change',()=>{
    const r=rpSavedList.find(x=>String(x.id)===document.getElementById('cx-saved').value);
    if(!r) { cxRenderSaved(); return; }
    const {kind,...conf}=r.config||{};
    cx={...CX_DEFAULT,...conf};
    cx.metrics=(cx.metrics||[]).filter(id=>CX_METRIC[id]);
    cx.parts=(cx.parts||[]).filter(id=>CX_PARTS.some(([p])=>p===id));
    if(!CX_DIMS[cx.group]) cx.group='division';
    cxSave(); renderCustom(); cxRenderSaved();
    showToast(`Loaded “${r.name}”`);
  });
  document.getElementById('cx-saved-del').addEventListener('click',async()=>{
    const sel=document.getElementById('cx-saved'), r=rpSavedList.find(x=>String(x.id)===sel.value);
    if(!r||!confirm(`Delete the saved report “${r.name}”?`)) return;
    try{
      const res=await fetch('/api/reports/saved/'+r.id,{method:'DELETE'});
      if(!res.ok) throw new Error((await res.json().catch(()=>({}))).error||'Could not delete it.');
      showToast('Saved report deleted'); sel.value='';
    }catch(err){ showToast(err.message,true); }
    rpLoadSaved();
  });
}
/** Reads the panel back into state. */
function cxRead(){
  cx.period=ofVal('cx-period'); cx.scores=ofVal('cx-scores');
  cx.division=ofVal('cx-division'); cx.area=ofVal('cx-area'); cx.building=ofVal('cx-building'); cx.auditor=ofVal('cx-auditor');
  cx.metrics=[...document.querySelectorAll('#cx-metrics [data-metric]')].filter(b=>b.checked).map(b=>b.dataset.metric);
  cx.parts=[...document.querySelectorAll('#cx-parts [data-part]')].filter(b=>b.checked).map(b=>b.dataset.part);
  cx.chartMetric=ofVal('cx-chart-metric')||'avg'; cx.chartType=ofVal('cx-chart-type')||'bar';
}
function cxFilter(){
  const inPeriod=cx.period?periodTest(cx.period):()=>true;
  const keepType=cx.scores==='all'?()=>true
    :cx.scores==='both'?(x=>x.type==='BOQI'||x.type==='EOQI')
      :(x=>x.type===cx.scores);
  return rpData.inspections.filter(x=>
    inPeriod(x) && keepType(x)
    && (!cx.division||x.division===cx.division)
    && (!cx.area||x.area===cx.area)
    && (!cx.building||x.building===cx.building)
    && (!cx.auditor||x.inspector===cx.auditor));
}
/** The buildings each row covers, so "buildings in list" and coverage mean something. */
function cxBuildingsFor(dim){
  if(!dim.bkey) return null;
  const scope=rpData.buildings.filter(b=>(!cx.division||b.division===cx.division)&&(!cx.area||b.area===cx.area)&&(!cx.building||b.name===cx.building));
  const map=new Map();
  scope.forEach(b=>{ const k=dim.bkey(b)||'—'; if(!map.has(k)) map.set(k,[]); map.get(k).push(b); });
  return map;
}
function cxRows(){
  const dim=CX_DIMS[cx.group], list=cxFilter(), byBuilding=cxBuildingsFor(dim);
  const map=new Map();
  list.forEach(x=>{ const k=dim.key(x)||'—'; if(!map.has(k)) map.set(k,[]); map.get(k).push(x); });
  if(byBuilding) byBuilding.forEach((_,k)=>{ if(!map.has(k)) map.set(k,[]); });  // a row with no inspections still belongs in a coverage report
  const rows=[...map.entries()].map(([key,items])=>cxGroup(key,items,byBuilding?byBuilding.get(key)||[]:null));
  rows.sort(dim.time?(a,b)=>String(a.key).localeCompare(String(b.key))
    :(a,b)=>(cxValue(b,'avg')??-1)-(cxValue(a,'avg')??-1)||b.list.length-a.list.length||String(a.key).localeCompare(String(b.key)));
  return {rows,list,total:cxGroup('All',list,byBuilding?[...new Set([...byBuilding.values()].flat())]:null)};
}
function cxGroup(key,items,buildings){
  return {key,list:items,buildings,scores:items.map(x=>x.overall).filter(v=>typeof v==='number'),
    covered:new Set(items.filter(x=>x.buildingId).map(x=>x.buildingId)).size};
}
const cxValue=(g,id)=>{ const m=CX_METRIC[id]; return m?m.calc(g):null; };
const cxCell=(g,id)=>{ const v=cxValue(g,id); return v==null?null:v; };
function cxTitle(){
  const dim=CX_DIMS[cx.group];
  return [cx.period||'All periods',`by ${dim.label.toLowerCase()}`].join(' · ');
}
function cxContext(){
  const scores={both:'BOQI and EOQI',BOQI:'Beginning of quarter (BOQI)',EOQI:'End of quarter (EOQI)',all:'Every inspection'}[cx.scores];
  return [['Period',cx.period||'All periods'],['Scores',scores],['Rows',CX_DIMS[cx.group].label],
    ...(cx.division?[['Division',cx.division]]:[]),...(cx.area?[['Area',cx.area]]:[]),
    ...(cx.building?[['Building',cx.building]]:[]),...(cx.auditor?[['Auditor',cx.auditor]]:[])];
}
function renderCustom(){
  initCustom();
  if(!rpData) return;
  // Period list: quarters and whole years, plus "all periods"
  const qs=rpQuarters(), ys=rpYears(), per=document.getElementById('cx-period');
  per.innerHTML='<option value="">All periods</option>'
    +`<optgroup label="Quarter">${qs.map(q=>`<option value="${q}">${q}</option>`).join('')}</optgroup>`
    +`<optgroup label="Whole year">${ys.map(y=>`<option value="${y}">${yearLabel(y)}</option>`).join('')}</optgroup>`;
  per.value=[...qs,...ys].includes(cx.period)?cx.period:'';
  cx.period=per.value;
  document.getElementById('cx-scores').value=cx.scores;
  rpSelect('cx-division',rpDivisionList(),'All divisions');
  document.getElementById('cx-division').value=rpDivisionList().includes(cx.division)?cx.division:'';
  cx.division=ofVal('cx-division');
  const areas=[...new Set(rpData.buildings.filter(b=>!cx.division||b.division===cx.division).map(b=>b.area).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  rpSelect('cx-area',areas,'All areas');
  document.getElementById('cx-area').value=areas.includes(cx.area)?cx.area:'';
  cx.area=ofVal('cx-area');
  const buildings=[...new Set(rpData.buildings.filter(b=>(!cx.division||b.division===cx.division)&&(!cx.area||b.area===cx.area)).map(b=>b.name))].sort((a,b)=>a.localeCompare(b));
  rpSelect('cx-building',buildings,'All buildings');
  document.getElementById('cx-building').value=buildings.includes(cx.building)?cx.building:'';
  cx.building=ofVal('cx-building');
  const auditors=[...new Set(rpData.inspections.map(x=>x.inspector).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  rpSelect('cx-auditor',auditors,'All auditors');
  document.getElementById('cx-auditor').value=auditors.includes(cx.auditor)?cx.auditor:'';
  cx.auditor=ofVal('cx-auditor');

  document.querySelectorAll('#cx-group [data-dim]').forEach(c=>c.classList.toggle('active',c.dataset.dim===cx.group));
  const rowsAreBuildings=!!CX_DIMS[cx.group].bkey;
  document.querySelectorAll('#cx-metrics [data-metric]').forEach(b=>{
    const m=CX_METRIC[b.dataset.metric];
    b.checked=cx.metrics.includes(b.dataset.metric);
    const off=m.needsBuildings&&!rowsAreBuildings;
    b.disabled=off; b.closest('.cx-opt').style.opacity=off?.45:1;
    b.closest('.cx-opt').title=off?'Available when each row is a division, area or building':'';
  });
  document.querySelectorAll('#cx-parts [data-part]').forEach(b=>{ b.checked=cx.parts.includes(b.dataset.part); });
  const chartable=cx.metrics.filter(id=>!CX_METRIC[id].needsBuildings||rowsAreBuildings);
  const cm=document.getElementById('cx-chart-metric');
  cm.innerHTML=chartable.length?chartable.map(id=>`<option value="${id}">${ovEsc(CX_METRIC[id].label)}</option>`).join(''):'<option value="">Pick a column first</option>';
  cm.value=chartable.includes(cx.chartMetric)?cx.chartMetric:(chartable[0]||'');
  cx.chartMetric=cm.value;
  document.getElementById('cx-chart-type').value=cx.chartType;

  const {rows,list,total}=cxRows();
  const cols=cx.metrics.filter(id=>!CX_METRIC[id].needsBuildings||rowsAreBuildings);
  document.getElementById('cx-count').textContent=`${list.length} inspection${list.length===1?'':'s'} · ${rows.length} row${rows.length===1?'':'s'}`;
  cxView={rows,list,total,cols,dim:CX_DIMS[cx.group]};

  const doc=document.getElementById('cx-doc');
  if(!cols.length&&cx.parts.includes('table')){
    doc.innerHTML=cxDocHead()+'<div class="cx-empty">Pick at least one column on the left, and the report builds itself here.</div>';
    if(cxChart){ cxChart.destroy(); cxChart=null; }
    lucide.createIcons(); return;
  }
  const fmt=(g,id)=>{ const v=cxCell(g,id); return v==null?'–':`${v}${CX_METRIC[id].unit||''}`; };
  const cards=cx.parts.includes('cards')?`<div class="cx-part"><h4>Summary</h4><div class="cx-cards">${
    cols.map(id=>`<div class="cx-card"><b>${fmt(total,id)}</b><span>${ovEsc(cxCardLabel(id))}</span></div>`).join('')}</div></div>`:'';
  const chart=cx.parts.includes('chart')&&cx.chartMetric?`<div class="cx-part"><h4>${ovEsc(CX_METRIC[cx.chartMetric].label)} by ${ovEsc(cxView.dim.label.toLowerCase())}</h4>
    <div class="ov-chart" style="height:300px"><canvas id="cx-chart"></canvas></div></div>`:'';
  const table=cx.parts.includes('table')?`<div class="cx-part"><h4>By ${ovEsc(cxView.dim.label.toLowerCase())}</h4>
    <div class="ov-scroll"><table class="ov-table"><thead><tr><th>${ovEsc(cxView.dim.label)}</th>${cols.map(id=>`<th>${ovEsc(CX_METRIC[id].label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(g=>`<tr><td><b>${ovEsc(g.key)}</b></td>${cols.map(id=>`<td>${fmt(g,id)}</td>`).join('')}</tr>`).join('')
      ||`<tr><td colspan="${cols.length+1}" class="ov-empty">Nothing matches this setup.</td></tr>`}</tbody>
    ${rows.length?`<tfoot><tr><td><b>All</b></td>${cols.map(id=>`<td><b>${fmt(total,id)}</b></td>`).join('')}</tr></tfoot>`:''}</table></div></div>`:'';
  const listRows=rpSorted(list).slice(0,200);
  const inspections=cx.parts.includes('list')?`<div class="cx-part"><h4>Inspections${list.length>listRows.length?` · first ${listRows.length} of ${list.length}`:''}</h4>
    <div class="ov-scroll"><table class="ov-table"><thead><tr><th>Date</th><th>Building</th><th>Type</th><th>Auditor</th><th>Score</th></tr></thead>
    <tbody>${listRows.map(x=>`<tr><td>${ovEsc(x.date)}<small>${ovEsc(x.quarter||'')}</small></td><td><b>${ovEsc(x.building)}</b><small>${ovEsc([x.division,x.area].filter(Boolean).join(' · '))}</small></td>
      <td>${ovEsc(x.type||'—')}</td><td>${ovEsc(x.inspector||'—')}</td><td>${ovScore(x.overall)}</td></tr>`).join('')
      ||'<tr><td colspan="5" class="ov-empty">No inspections match.</td></tr>'}</tbody></table></div></div>`:'';
  doc.innerHTML=cxDocHead()+cards+chart+table+inspections+(cx.parts.length?'':'<div class="cx-empty">Tick at least one part of the report on the left.</div>');

  if(cxChart){ cxChart.destroy(); cxChart=null; }
  if(cx.parts.includes('chart')&&cx.chartMetric&&rows.length){
    const top=rows.slice(0,cxView.dim.time?24:20);
    const metric=CX_METRIC[cx.chartMetric], scoreLike=['avg','min','max','boqi','eoqi'].includes(cx.chartMetric);
    cxChart=new Chart(document.getElementById('cx-chart'),{
      type:cx.chartType,
      data:{labels:top.map(g=>g.key),datasets:[{label:metric.label,data:top.map(g=>cxValue(g,cx.chartMetric)),
        backgroundColor:cx.chartType==='line'?'rgba(0,51,160,.08)':top.map(g=>scoreLike&&cxValue(g,cx.chartMetric)!=null?grade(cxValue(g,cx.chartMetric)).color:'#0033A0'),
        borderColor:'#0033A0',borderWidth:cx.chartType==='line'?2:0,fill:cx.chartType==='line',tension:.25,pointRadius:4,pointBackgroundColor:'#0033A0',borderRadius:5,maxBarThickness:48}]},
      options:vizOptions({scales:{y:{beginAtZero:true,...(scoreLike?{max:100}:{})},x:{ticks:{autoSkip:true,autoSkipPadding:6,maxRotation:50}}},plugins:{legend:{display:false}}}),
    });
  }
  lucide.createIcons();
}
/** On a card the value already carries the %, so the label does not repeat it. */
function cxCardLabel(id){ return CX_METRIC[id].label.replace(/\s*\(%\)$/,''); }
function cxDocHead(){
  return `<div class="cx-doc-hd"><h3>${ovEsc(cxTitle())}</h3>
    <div class="cx-chips">${cxContext().map(([k,v])=>`<span class="cx-chip">${ovEsc(k)}<b>${ovEsc(v)}</b></span>`).join('')}</div></div>`;
}
function cxRenderSaved(){
  const sel=document.getElementById('cx-saved'), cur=sel.value;
  const list=rpSavedList.filter(r=>r.config?.kind==='custom');
  const mine=list.filter(r=>r.mine), shared=list.filter(r=>!r.mine);
  const opt=r=>`<option value="${r.id}">${ovEsc(r.name)}${r.mine&&r.shared?' · shared':''}${!r.mine?' · '+ovEsc(r.owner):''}</option>`;
  sel.innerHTML=`<option value="">${list.length?'Saved custom reports…':'No saved custom reports yet'}</option>`
    +(mine.length?`<optgroup label="Mine">${mine.map(opt).join('')}</optgroup>`:'')
    +(shared.length?`<optgroup label="Shared with everyone">${shared.map(opt).join('')}</optgroup>`:'');
  sel.value=list.some(r=>String(r.id)===cur)?cur:'';
  const r=list.find(x=>String(x.id)===sel.value);
  document.getElementById('cx-saved-del').hidden=!(r&&r.canDelete);
}
function cxOpenSave(){
  const sel=document.getElementById('cx-saved');
  const current=rpSavedList.find(x=>String(x.id)===sel.value&&x.mine);
  document.getElementById('sr-name').value=current?current.name:cxTitle();
  document.getElementById('sr-shared').checked=current?current.shared:false;
  document.getElementById('sr-msg').style.display='none';
  document.getElementById('sr-form').dataset.kind='custom';
  document.getElementById('modal-save-report').classList.add('open');
  setTimeout(()=>document.getElementById('sr-name').focus(),50);
}
/** The export carries exactly the parts that are ticked — nothing more. */
function exModelCustom(){
  const v=cxView;
  if(!v||!v.cols.length) return null;
  const fmtRow=g=>[g.key,...v.cols.map(id=>cxCell(g,id))];
  const head=[v.dim.label,...v.cols.map(id=>CX_METRIC[id].label)];
  const blocks=[];
  if(cx.parts.includes('cards')) blocks.push({id:'cards',label:'Summary',sheet:'Summary',
    kpis:v.cols.map(id=>({label:cxCardLabel(id),value:cxCell(v.total,id)??'–'})),
    table:{head:['Measure','Value'],rows:v.cols.map(id=>[CX_METRIC[id].label,cxCell(v.total,id)])}});
  if(cx.parts.includes('chart')&&cx.chartMetric) blocks.push({id:'chart',label:`${CX_METRIC[cx.chartMetric].label} by ${v.dim.label.toLowerCase()}`,
    sheet:'Chart',chart:()=>cxChart,table:{head:[v.dim.label,CX_METRIC[cx.chartMetric].label],rows:v.rows.map(g=>[g.key,cxCell(g,cx.chartMetric)])}});
  if(cx.parts.includes('table')) blocks.push({id:'table',label:`By ${v.dim.label.toLowerCase()}`,sheet:`By ${v.dim.label.toLowerCase()}`,
    table:{head,rows:[...v.rows.map(fmtRow),fmtRow({...v.total,key:'All'})]}});
  if(cx.parts.includes('list')) blocks.push({id:'list',label:'Inspections',sheet:'Inspections',
    table:{head:['Report no.','Date','Quarter','Type','Building','Division','Area','Auditor','Score','Rating'],bands:{8:100},
      rows:rpSorted(v.list).map(x=>[x.id,x.date,x.quarter,x.type,x.building,x.division,x.area,x.inspector,x.overall,rpBandOf(x)])}});
  return {title:'Custom report',file:`custom-report-${exSlug(cxTitle())}`,note:cxTitle(),context:cxContext(),blocks};
}

// ═══════════════════════════════════════════════════════════
// EXPORT — one button per view: a PDF report, an Excel workbook (.xlsx) or a chart image (.png).
// Each view describes itself as blocks (key numbers, charts, tables); every format is built from
// those same blocks, so the numbers in a download always match the page.
// ═══════════════════════════════════════════════════════════
function exDate(){ return new Date().toISOString().slice(0,10); }
/** A server timestamp (UTC) as a day on this device's calendar. */
function exLocalDay(text){
  const u=exLocalStamp(text); if(!u) return text;
  const p=n=>String(n).padStart(2,'0');
  return `${u.getFullYear()}-${p(u.getMonth()+1)}-${p(u.getDate())}`;
}
/** "pending" → "Pending": statuses read the way they do on the screen. */
function exCap(s){ return s==null||s===''?s:String(s).charAt(0).toUpperCase()+String(s).slice(1); }
function exSlug(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'export'; }
function exSel(id){ const el=document.getElementById(id); return el&&el.value?(el.tagName==='SELECT'?el.options[el.selectedIndex].textContent.trim():el.value.trim()):''; }
function exDelta(diff,vs,unit='',digits=1){
  if(diff==null||Number.isNaN(diff)) return `No ${vs} data`;
  const r=Math.round(diff*10**digits)/10**digits;
  return r===0?`No change vs ${vs}`:`${r>0?'+':''}${r}${unit} vs ${vs}`;
}
function exDownload(name,blob){
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
}

// ── What each view exports ──
function exModelInsights(){
  const v=insView;
  if(!v||!v.Q) return null;
  const A=v.A, B=v.hasPrev?v.B:null, pct=x=>x==null?null:Math.round(x), both=(a,b)=>a!=null&&b!=null;
  // measure · what it counts · this period · the period before · change — each number in its own format
  const kpi=[
    ['Inspections','reports saved',A.n,B?B.n:null,B?A.n-B.n:null,'int','din'],
    ['Average score','points out of 100',r1(A.avg),B?r1(B.avg):null,B&&both(A.avg,B.avg)?r1(r1(A.avg)-r1(B.avg)):null,'n1','d1',100],
    ['Buildings inspected','% of the buildings in the list',pct(A.coverage),B?pct(B.coverage):null,B&&both(A.coverage,B.coverage)?pct(A.coverage)-pct(B.coverage):null,'pct','d1'],
    ['Good or Excellent','% of scored inspections (81–100)',pct(A.goodShare),B?pct(B.goodShare):null,B&&both(A.goodShare,B.goodShare)?pct(A.goodShare)-pct(B.goodShare):null,'pct','d1'],
    ['Poor or Critical','inspections scoring below 71',A.low,B?B.low:null,B?A.low-B.low:null,'int','dir'],
  ];
  const units=['','',' pts',' pts',''], digits=[0,1,0,0,0];
  const cards=kpi.map((r,i)=>({label:r[0],value:r[2]==null?'–':i===2||i===3?`${r[2]}%`:r[2],sub:exDelta(r[4],v.P,units[i],digits[i])}));
  const dim=v.div?'Area':'Division', h=v.heat, avgBand=100;
  const chg=`Change vs ${v.P} (points)`;
  return {title:'Insights',file:`insights-${v.Q}`,
    blurb:`How ${v.div?'the areas of '+v.div:'the divisions'} are performing in ${v.Q}, compared with ${v.P}.`,
    context:[['Period',v.Q],['Compared with',v.P],['Type',v.type||'All types'],['Division',v.div||'All divisions']],
    glossary:[['Buildings inspected','Buildings in the list that have at least one inspection in the period, as a share of all buildings.'],
      ['Good or Excellent','Inspections scoring 81 or more, as a share of the inspections that were scored.'],
      ['Poor or Critical','Inspections scoring below 71: rated Poor (51–70) or Critical (0–50).']],
    blocks:[
      {id:'kpis',label:'Key numbers',sheet:'Key numbers',desc:'The five headline numbers for the period, next to the period before.',note:'Change = this period minus the period before · ▲ up ▼ down',
        kpis:cards,
        table:{head:['Measure','What it counts',v.Q,v.P,'Change'],
          rows:kpi.map(r=>[r[0],r[1],{v:r[2],f:r[5],band:r[7]},{v:r[3],f:r[5],band:r[7]},{v:r[4],f:r[6]}])}},
      {id:'trend',label:`Average score by quarter · ${dim}`,sheet:'Trend by quarter',desc:`Average score of each ${dim.toLowerCase()}, quarter by quarter.`,note:'Average score out of 100',chart:'insTrend',
        table:{head:['Quarter',...v.series.map(s=>s.label)],rows:v.quarters.map((q,i)=>[q,...v.series.map(s=>s.points[i].avg)]),
          fmt:['t',...v.series.map(()=>'n1')],bands:Object.fromEntries(v.series.map((_,i)=>[i+1,avgBand]))}},
      {id:'heat',label:`Section scores by ${dim.toLowerCase()} (out of 10)`,sheet:'Section heatmap',desc:`Average score of each section, for each ${dim.toLowerCase()}.`,note:'Section scores out of 10',image:()=>exHeatCanvas(h),
        table:{head:[h.label,...h.cols,'Overall'],pdfHead:[h.label,...h.cols.map(sectionShort),'Overall'],heat:true,
          fmt:['t',...h.cols.map(()=>'n1'),'n1'],bands:Object.fromEntries([...h.cols.map((_,i)=>[i+1,10]),[h.cols.length+1,10]]),
          rows:[...h.rows,'__all'].map(r=>[r==='__all'?'All':r,...h.cols.map(c=>h.cell(r,c)),h.cell(r,'__overall')])}},
      {id:'board',label:v.div?`Areas in ${v.div}`:'Divisions ranked',sheet:'Ranking',desc:`${dim}s ranked by average score, with how many buildings they inspected and their weakest section.`,note:'Average score out of 100',
        table:{head:[dim,'Inspections','Average score',chg,'Buildings inspected','Total buildings','Coverage (%)','Weakest section','Weakest section score (out of 10)'],
          fmt:['t','int','n1','d1','int','int','pct','t','n1'],bands:{2:100,8:10},
          rows:v.board.map(r=>[r.k,r.n,r.avg,r.delta,r.covered,r.total,r.total?Math.round(r.covered/r.total*100):null,r.weakest?r.weakest[0]:null,r.weakest?r.weakest[1]:null])}},
      {id:'fail',label:'Most often scored 0',sheet:'Scored 0',desc:'The checklist items that scored 0 in the largest share of inspections.',
        table:{head:['Checklist item','Section','Times scored 0','Inspections','Share of inspections (%)'],fmt:['t','t','int','int','pct'],
          rows:v.failing.map(i=>[SECTIONS[i.si].items[i.ii],SECTIONS[i.si].title,i.fails,i.n,Math.round(i.rate*100)])}},
      {id:'attention',label:'Lowest-scoring buildings',sheet:'Lowest scores',desc:'The buildings with the lowest latest score in the period — the ones to look at first.',note:'Score out of 100',
        table:{head:['Building','Division','Area','Latest score','Rating','Type','Date',chg],fmt:['t','t','t','n1','t','t','date','d1'],bands:{3:100},
          rows:v.latest.map(({x,prev:p})=>[x.building,x.division,x.area,x.overall,grade(x.overall).label,x.type,x.date,p&&typeof p.overall==='number'?r1(x.overall-p.overall):null])}},
      {id:'movers',label:'Biggest movers · BOQI → EOQI',sheet:'Movers BOQI to EOQI',desc:'Buildings whose score moved most between their beginning-of-quarter and end-of-quarter inspection.',note:'Score out of 100',
        table:{head:['Building','Division','Area','Quarter','BOQI score','EOQI score','Change (points)'],fmt:['t','t','t','t','n1','n1','d1'],bands:{4:100,5:100},
          rows:v.movers.map(m=>[m.x.building,m.x.division,m.x.area,m.x.quarter,m.from,m.to,m.d])}},
    ]};
}
function exModelBuilder(){
  const v=rpView;
  if(!v) return null;
  const cfg=RP_GROUPS[rpGroup], st=v.st, titles=SECTIONS.map(s=>s.title), sorted=rpSorted(v.list);
  const names={'rp-year':'Year','rp-month':'Month','rp-quarter':'Quarter','rp-type':'Type','rp-division':'Division','rp-area':'Area','rp-building':'Building','rp-inspector':'Auditor','rp-rating':'Rating','rp-from':'From','rp-to':'To','rp-search':'Search'};
  const context=RP_FILTER_IDS.map(id=>[names[id],exSel(id)]).filter(([,t])=>t);
  if(!context.length) context.push(['Filters','All inspections']);
  if(rpVal('rp-saved')) context.unshift(['Saved report',exSel('rp-saved')]);
  context.push(['Grouped by',cfg.label]);
  const bands=RP_BANDS.map(b=>[b,v.list.filter(x=>rpBandOf(x)===b).length]), scored=bands.reduce((n,[,c])=>n+c,0);
  const subHead=cfg.sub?(rpGroup==='area'?'Division':'Division · Area'):null, sc=subHead?1:0;   // the extra column shifts the rest by one
  const groupHead=[cfg.label,...(subHead?[subHead]:[]),'Inspections','Scored inspections','Average score',...RP_BANDS,'BOQI average','EOQI average','EOQI − BOQI (points)'];
  const iAvg=2+sc+1, iBoqi=3+sc+RP_BANDS.length+1;
  return {title:'Report Builder',file:`report-builder-by-${rpGroup}`,context,
    blurb:`The inspections that match the filters, grouped by ${cfg.label.toLowerCase()}.`,
    glossary:[['Buildings inspected','Buildings in the filtered scope that have at least one inspection, out of all buildings in that scope.'],
      ['Scored inspections','Inspections that have an overall score (imported scores count; empty ones do not).'],
      ['Rating columns','The number of inspections that fall in each rating band.'],
      ['EOQI − BOQI','End-of-quarter average minus beginning-of-quarter average, for buildings where both exist.']],
    blocks:[
    {id:'kpis',label:'Key numbers',sheet:'Key numbers',desc:'The headline numbers for the filtered inspections.',
      kpis:[{label:'Inspections',value:v.list.length,sub:`${st.n} scored`},{label:'Average score',value:st.avg??'–',sub:st.avg!=null?grade(st.avg).label:''},
        {label:'Highest',value:st.max??'–',sub:v.best?.building||''},{label:'Lowest',value:st.min??'–',sub:v.worst?.building||''},
        {label:'Buildings inspected',value:`${v.covered}/${v.inScope.length}`,sub:v.inScope.length?`${Math.round(v.covered/v.inScope.length*100)}%`:''}],
      table:{head:['Measure','Value','Note'],rows:[
        ['Inspections',{v:v.list.length,f:'int'},`${st.n} scored`],
        ['Average score',{v:st.avg,f:'n1',band:100},st.avg!=null?grade(st.avg).label:null],
        ['Highest score',{v:st.max,f:'n1',band:100},v.best?.building],['Lowest score',{v:st.min,f:'n1',band:100},v.worst?.building],
        ['Buildings inspected',{v:v.covered,f:'int'},`of ${v.inScope.length} buildings`]]}},
    {id:'bands',label:'Rating mix',desc:'How many inspections fall in each rating band.',
      table:{head:['Rating','Inspections','Share of scored inspections (%)'],fmt:['t','int','pct'],rows:bands.map(([b,c])=>[b,c,scored?Math.round(c/scored*100):null])}},
    {id:'summary',label:`By ${cfg.label.toLowerCase()}`,sheet:`By ${cfg.label.toLowerCase()}`,desc:`One row per ${cfg.label.toLowerCase()}: how many inspections, the average score and the rating mix.`,note:'Score out of 100 · the rating columns count inspections',chart:'group',
      table:{head:groupHead,
        fmt:['t',...(subHead?['t']:[]),'int','int','n1',...RP_BANDS.map(()=>'int'),'n1','n1','d1'],bands:{[iAvg]:100,[iBoqi]:100,[iBoqi+1]:100},
        pdfCols:[0,1+sc,3+sc,iBoqi,iBoqi+1,iBoqi+2],
        rows:v.groups.map(g=>[g.key,...(subHead?[g.sub]:[]),g.count,g.n,g.avg,...RP_BANDS.map(b=>g.bands[b]),g.boqi,g.eoqi,g.delta])}},
    {id:'stats',label:'Score spread',sheet:'Statistics',desc:'The lowest score, highest score and spread (standard deviation) for each group.',defaults:{pdf:false,xlsx:false},
      table:{head:[cfg.label,'Lowest score','Highest score','Score spread (standard deviation)'],fmt:['t','n1','n1','n1'],bands:{1:100,2:100},
        rows:v.groups.map(g=>[g.key,g.min,g.max,g.n>1?g.sd:null])}},
    {id:'trend',label:rpTrend==='each'?'Every scored inspection over time':`Average score by ${rpTrend}`,sheet:'Over time',desc:'How the score moves over time.',chart:'trend',
      table:{head:rpTrend==='each'?['Date','Building','Score']:[rpTrend==='month'?'Month':'Quarter','Inspections','Average score'],
        fmt:rpTrend==='each'?['date','t','n1']:['t','int','n1'],bands:{2:100},rows:v.trendRows}},
    {id:'sections',label:'Average by section (out of 10)',sheet:'By section',desc:'The average score of each of the ten sections.',chart:'section',
      table:{head:['Section','Average score (out of 10)','Inspections scored'],fmt:['t','n1','int'],bands:{1:10},rows:v.secs}},
    {id:'detail',label:'Matching inspections',sheet:'Inspections',desc:'Every inspection that matches the filters, with its section scores.',note:'Scores out of 100 · section scores out of 10',defaults:{pdf:sorted.length<=150},
      table:{head:['Report no.','Date','Quarter','Type','Building','Location','Division','Area','Auditor','Score','Rating',...titles.map(t=>`${t} (out of 10)`)],
        fmt:['t','date','t','t','t','t','t','t','t','int','t',...titles.map(()=>'n1')],bands:{9:100,...Object.fromEntries(titles.map((_,i)=>[11+i,10]))},pdfCols:[1,4,6,3,8,9,10],
        rows:sorted.map(x=>{ const sec=new Map(x.sections.map(s=>[s.title,s.score==null?null:rpRound(s.score/s.max*10)]));
          return [x.id,x.date,x.quarter,x.type,x.building,x.location,x.division,x.area,x.inspector,x.overall,rpBandOf(x),...titles.map(t=>sec.get(t)??null)]; })}},
  ]};
}
function exModelCompare(){
  const v=cmpView;
  if(!v) return null;
  if(v.A===v.B) throw new Error('Period A and period B are the same, so nothing can change between them. Choose two different periods to compare.');
  const A=v.A, B=v.B, d=(a,b)=>a!=null&&b!=null?r1(b-a):null;
  const kpi=[
    ['Inspections','reports saved',v.sa.n,v.sb.n,v.sb.n-v.sa.n,'int','din'],
    ['Average score','points out of 100',v.sa.avg,v.sb.avg,d(v.sa.avg,v.sb.avg),'n1','d1',100],
    ['Buildings inspected',`% of the ${v.nb} buildings in scope`,v.sa.cov,v.sb.cov,d(v.sa.cov,v.sb.cov),'pct','d1'],
    ['Good or Excellent','% of scored inspections (81–100)',v.sa.good,v.sb.good,d(v.sa.good,v.sb.good),'pct','d1'],
    ['Poor or Critical','inspections scoring below 71',v.sa.low,v.sb.low,v.LA.length||v.LB.length?v.sb.low-v.sa.low:null,'int','dir'],
  ];
  const units=['','',' pts',' pts',''], digits=[0,1,0,0,0];
  const cards=kpi.map((r,i)=>{ const u=i===2||i===3?'%':''; return {label:r[0],value:`${r[2]??'–'}${r[2]!=null?u:''} → ${r[3]??'–'}${r[3]!=null?u:''}`,sub:exDelta(r[4],v.vs,units[i],digits[i])}; });
  const dims=cmpDims().sort((a,b)=>(b===cmpDim)-(a===cmpDim));
  const sortBy=exSel('cmp-sort')||'';
  return {title:'Compare periods',file:`compare-${A}-vs-${B}`,
    blurb:'How each group scored in period A compared with period B. Change = B minus A.',
    context:[['Period A',A],['Period B',B],['Division',v.div||'All divisions'],['Sorted by',sortBy]].filter(([,x])=>x!==''),
    glossary:[['Period A / B','A is the starting point and B is the period being compared with it.'],
      ['Buildings inspected','Buildings in scope that have at least one inspection in the period, as a share of all of them.'],
      ['Good or Excellent','Inspections scoring 81 or more, as a share of the inspections that were scored.'],
      ['Poor or Critical','Inspections scoring below 71: rated Poor (51–70) or Critical (0–50).'],
      ['Small sample','Fewer than 3 inspections in one of the periods — the average can move a lot on one report.']],
    blocks:[
      {id:'kpis',label:'Key numbers',sheet:'Key numbers',desc:'The five headline numbers, period A next to period B.',note:`Change = ${B} minus ${A} · ▲ up ▼ down`,
        kpis:cards,
        table:{head:['Measure','What it counts',A,B,'Change'],rows:kpi.map(r=>[r[0],r[1],{v:r[2],f:r[5],band:r[7]},{v:r[3],f:r[5],band:r[7]},{v:r[4],f:r[6]}])}},
      ...dims.map(dim=>{
        const rows=cmpSortRows(cmpGroupRows(dim,v.LA,v.LB),dim), sect=dim==='section', n=sect?'Inspections scored':'Inspections', scale=sect?10:100;
        const avg=sect?'Average (out of 10)':'Average score';
        // when every row is a small sample, saying so on each one tells nobody anything
        const allSmall=rows.length>0&&rows.every(r=>r.nA&&r.nB&&Math.min(r.nA,r.nB)<3);
        const note=r=>!r.nA&&r.nB?`Only in ${B}`:r.nA&&!r.nB?`Only in ${A}`:!allSmall&&Math.min(r.nA,r.nB)<3?'Small sample':null;
        const flagged=rows.some(r=>note(r));
        return {id:'dim-'+dim,label:`By ${cmpDimLabel(dim).toLowerCase()}${sect?' (out of 10)':''}`,sheet:`By ${cmpDimLabel(dim).toLowerCase()}`,
          desc:`${cmpDimLabel(dim)} by ${cmpDimLabel(dim).toLowerCase()}: ${A} next to ${B}, and the change.`,note:`Change = ${B} minus ${A} · ${sect?'section scores out of 10':'scores out of 100'}`,
          chart:dim===cmpDim?'cmp':null,defaults:{pdf:dim===cmpDim},
          table:{head:[cmpDimLabel(dim),`${A} · ${n}`,`${A} · ${avg}`,`${B} · ${n}`,`${B} · ${avg}`,sect?'Change (points out of 10)':'Change (points)',...(flagged?['Note']:[])],
            fmt:['t','int','n1','int','n1','d1',...(flagged?['t']:[])],bands:{2:scale,4:scale},
            rows:rows.map(r=>[r.key,r.nA,r.a,r.nB,r.b,r.d,...(flagged?[note(r)]:[])])}};
      }),
    ]};
}
function exModelQuality(){
  const v=dqView;
  if(!v||!dqIssues) return null;
  const c=v.counts, q=v.latestQ||'the latest quarter';
  const of=kind=>dqIssues.filter(i=>i.issue===kind).map(i=>[i.x?.date,i.x?.quarter,i.x?.type,i.x?.building,i.x?.division,i.x?.inspector,i.detail]);
  const head=['Date','Quarter','Type','Building name as entered','Division','Auditor','Detail'];
  return {title:'Data Quality',file:'data-quality',context:[['Latest quarter with data',v.latestQ||'—']],blocks:[
    {id:'kpis',label:'Checks',sheet:'Checks',
      kpis:[{label:'Not linked to a building',value:c.unlinked},{label:'Possible duplicates',value:c.dups},{label:'Incomplete scoring',value:c.incomplete},
        {label:'Missing details',value:c.missing},{label:`Not inspected in ${q}`,value:c.notInspected,sub:`${v.total-c.notInspected} of ${v.total} buildings covered`}],
      table:{head:['Check','Count'],rows:[['Not linked to a building',c.unlinked],['Possible duplicates (groups)',c.dups],['Incomplete scoring',c.incomplete],['Missing details',c.missing],[`Buildings not inspected in ${q}`,c.notInspected]]}},
    {id:'unlinked',label:'Not linked to a building',sheet:'Not linked',table:{head,rows:of('Not linked to a building')}},
    {id:'dups',label:'Possible duplicates',sheet:'Duplicates',table:{head,rows:of('Possible duplicate')}},
    {id:'incomplete',label:'Incomplete scoring',sheet:'Incomplete',table:{head,rows:of('Incomplete scoring')}},
    {id:'missing',label:'Missing details',sheet:'Missing details',table:{head,rows:of('Missing details')}},
    {id:'coverage',label:`Coverage by division · ${q}`,sheet:'Coverage',table:{head:['Division','Buildings','Inspected','Not inspected','Coverage (%)'],
      rows:v.coverage.map(r=>[r.division,r.total,r.total-r.missing.length,r.missing.length,r.total?Math.round((r.total-r.missing.length)/r.total*100):null])}},
    {id:'not-inspected',label:`Buildings not inspected · ${q}`,sheet:'Not inspected',defaults:{pdf:false},table:{head:['Division','Area','Building'],
      rows:v.coverage.flatMap(r=>r.missing.map(b=>[r.division,b.area,b.name]))}},
  ]};
}

/** Team Overview, Assign & Track and an auditor's profile export the same way as Analytics. */
function exModelOverview(){
  const d=ovData;
  if(!d) return null;
  const s=d.summary, quarter=ofVal('ov-quarter'), div=ofVal('ov-division');
  const pct=(a,b)=>b?Math.round(a/b*100):null;
  return {title:'Team Overview',file:`team-overview-${quarter==='all'?'all-quarters':quarter}`,
    context:[['Quarter',quarter==='all'?'All quarters':quarter],['Division',div||'All divisions']],
    blocks:[
      {id:'kpis',label:'Key numbers',sheet:'Key numbers',
        kpis:[{label:'Assignments completed',value:`${s.completed}/${s.assignments}`,sub:`${s.completionPct}%`},
          {label:'Buildings assigned',value:`${s.buildingsCovered}/${s.buildings}`},{label:'Average score',value:s.avgScore??'–'},
          {label:'Inspections',value:s.inspections},{label:'Active auditors',value:s.activeAuditors}],
        table:{head:['Measure','Value'],rows:[['Assignments',s.assignments],['Completed',s.completed],['Completion (%)',s.completionPct],
          ['Buildings assigned',s.buildingsCovered],['Buildings in list',s.buildings],['Average score',s.avgScore],['Inspections',s.inspections],['Active auditors',s.activeAuditors]]}},
      {id:'division',label:'By division',sheet:'By division',chart:()=>ovChart,
        table:{head:['Division','Buildings','Assignments','Completed','Completion (%)','Inspections','Average'],
          rows:d.byDivision.map(x=>[x.division,x.buildings,x.assignments,x.completed,pct(x.completed,x.assignments),x.inspections,x.avgScore])}},
      {id:'auditors',label:'Auditors',sheet:'Auditors',
        table:{head:['Auditor','Role','Status','Assigned','Completed','Pending','Completion (%)','Average'],
          rows:d.auditors.map(x=>[x.name,roleShort(x.role)||'Auditor',exCap(x.status),x.assigned,x.completed,x.assigned-x.completed,pct(x.completed,x.assigned),x.avgScore])}},
      {id:'officers',label:'Officers',sheet:'Officers',
        table:{head:['Officer','Role','Assignments made','Completed','Completion (%)'],
          rows:d.officers.map(x=>[x.name,roleShort(x.role)||'Officer',x.assignmentsMade,x.completed,pct(x.completed,x.assignmentsMade)])}},
      {id:'areas',label:'By area',sheet:'By area',
        table:{head:['Area','Division','Buildings','Assignments','Completed','Completion (%)','Inspections','Average'],
          rows:d.byArea.map(x=>[x.area,x.division,x.buildings,x.assignments,x.completed,pct(x.completed,x.assignments),x.inspections,x.avgScore])}},
      {id:'buildings',label:'Buildings',sheet:'Buildings',
        table:{head:['Building','Location','Division','Area','Auditor','Status','Inspections','Latest score','Latest date'],
          bands:{7:100},rows:ovFilteredBuildings().map(x=>[x.name,x.location,x.division,x.area,x.auditorName,exCap(x.status),x.inspections,x.lastScore,x.lastDate])}},
      {id:'activity',label:'Recent activity',sheet:'Activity',defaults:{pdf:false},
        table:{head:['When','Who','Action','Building','Target','Quarter','Type','Score'],
          rows:d.activity.map(x=>[x.at,x.actor,x.kind==='assignment'?'Assigned':'Submitted',x.building,x.target||'',x.quarter,x.type,x.score??null])}},
    ]};
}
function exModelOfficer(){
  const v=ofView, d=ofData;
  if(!v||!d) return null;
  const pct=(a,b)=>b?Math.round(a/b*100):null;
  const quarter=ofVal('of-quarter');
  const context=[['Quarter',quarter],['Type',exSel('of-type')||'All types'],['Division',ofVal('of-division')||'All divisions'],['Area',ofVal('of-area')||'All areas']];
  return {title:'Assign & Track',file:`assign-and-track-${quarter}`,context,blocks:[
    {id:'kpis',label:'Key numbers',sheet:'Key numbers',
      kpis:[{label:'Buildings',value:v.kpis.total},{label:'Assigned',value:v.kpis.assigned},{label:'Completed',value:v.kpis.completed},
        {label:'Pending',value:v.kpis.pending},{label:'Average score',value:v.kpis.avg??'–'}],
      table:{head:['Measure','Value'],rows:[['Buildings',v.kpis.total],['Assigned',v.kpis.assigned],['Completed',v.kpis.completed],
        ['Pending',v.kpis.pending],['Unassigned',v.kpis.total-v.kpis.assigned],['Average score',v.kpis.avg]]}},
    {id:'team',label:'Team progress',sheet:'Team progress',
      table:{head:['Auditor','Role','Status','Assigned','Completed','Pending','Completion (%)','Average','Last submitted'],
        rows:v.team.map(a=>[a.name,roleShort(a.role)||'Auditor',exCap(a.status),a.assigned,a.completed,a.assigned-a.completed,pct(a.completed,a.assigned),
          a.scores.length?Math.round(a.scores.reduce((t,n)=>t+n,0)/a.scores.length):null,a.last])}},
    {id:'areas',label:'Progress by area',sheet:'By area',
      table:{head:['Area','Division','Buildings','Assigned','Completed','Completion (%)'],
        rows:v.areas.map(g=>[g.area,g.division,g.buildings,g.assigned,g.completed,pct(g.completed,g.assigned)])}},
    {id:'buildings',label:'Buildings',sheet:'Buildings',
      table:{head:['Building','Location','Division','Area','Status','Auditor','Deadline','Score','Completed'],
        bands:{7:100},rows:ofFilteredRows().map(b=>[b.name,b.location,b.division,b.area,exCap(b.status),b.auditorName,b.dueDate||null,b.score??null,b.completedAt||null]),
        resultCols:[7,8]}},
    {id:'activity',label:'Recent activity',sheet:'Activity',defaults:{pdf:false},
      table:{head:['When','Who','Action','Building','Auditor','Score'],
        rows:v.activity.map(e=>[e.at,e.actor||'',e.kind==='completed'?'Submitted':'Assigned',e.building||'',e.auditor||e.auditorName||'',e.score??null])}},
  ]};
}
function exModelAuditor(){
  const d=auData;
  if(!d) return null;
  const p=d.performance, pct=(a,b)=>b?Math.round(a/b*100):null;
  const done=d.assignments.filter(x=>x.status==='completed');
  const row=x=>[x.buildingName,x.division,x.area,x.type,exCap(x.status),x.score??null,x.completedAt?exLocalDay(x.completedAt):(x.inspectionDate||null),x.quarter];
  const head=['Building','Division','Area','Type','Status','Score','Completed on','Quarter'];
  return {title:`Auditor · ${d.auditor.name}`,file:`auditor-${exSlug(d.auditor.name)}-${d.quarter}`,
    context:[['Auditor',d.auditor.name],['Quarter',d.quarter]],
    blocks:[
      {id:'kpis',label:'Key numbers',sheet:'Key numbers',
        kpis:[{label:'Assigned',value:d.assignments.length},{label:'Completed',value:done.length,sub:`${pct(done.length,d.assignments.length)??0}%`},
          {label:'Average score',value:p?.avgScore??'–'},{label:'Still open from earlier',value:d.carriedOver.length}],
        table:{head:['Measure','Value'],rows:[['Assigned',d.assignments.length],['Completed',done.length],
          ['Completion (%)',pct(done.length,d.assignments.length)],['Average score',p?.avgScore??null],['Carried over',d.carriedOver.length]]}},
      {id:'quarters',label:'Average score by quarter',sheet:'By quarter',chart:()=>auCharts.q,
        table:{head:['Quarter','Assigned','Completed','Average'],rows:(p?.byQuarter||[]).map(x=>[x.quarter,x.assigned,x.completed,x.avgScore])}},
      {id:'sections',label:'Average by section',sheet:'By section',chart:()=>auCharts.sec,
        table:{head:['Section','Average (/10)'],rows:(p?.sections||[]).map(x=>[x.title,x.avg])}},
      {id:'buildings',label:'Buildings this quarter',sheet:'Buildings',table:{head,bands:{5:100},rows:d.assignments.map(row)}},
      {id:'carried',label:'Still open from earlier quarters',sheet:'Carried over',table:{head,bands:{5:100},rows:d.carriedOver.map(row)}},
    ]};
}

async function exModelLibrary(){
  const p=libParams(); p.set('limit','200');
  const rows=[]; let offset=0, total=1;
  while(offset<total&&offset<5000){
    p.set('offset',String(offset));
    const res=await fetch('/api/reports/library?'+p,{cache:'no-store'});
    if(!res.ok) throw new Error((await res.json().catch(()=>({}))).error||'Could not load the reports.');
    const d=await res.json(); total=d.total; rows.push(...d.rows); offset+=200;
  }
  const context=[], q=ofVal('lib-q').trim();
  if(q) context.push(['Search',q+(document.getElementById('lib-comments').checked?' (including comments)':'')]);
  const chip=document.querySelector('#lib-status .rp-chip.active');
  if(chip) context.push(['Status',chip.childNodes[0].textContent.trim()]);
  const names={'lib-quarter':'Quarter','lib-type':'Type','lib-division':'Division','lib-area':'Area','lib-auditor':'Auditor','lib-rating':'Rating','lib-from':'From','lib-to':'To'};
  Object.entries(names).forEach(([id,l])=>{ const t=exSel(id); if(t) context.push([l,t]); });
  context.push(['Sorted by',exSel('lib-sort')]);
  const scored=rows.map(r=>r.overall).filter(x=>typeof x==='number'), count=s=>rows.filter(r=>s.includes(r.status)).length;
  const ids=rows.map(r=>r.id), byId=new Map(rows.map(r=>[r.id,r])), order=new Map(ids.map((id,i)=>[id,i]));
  return {title:'Inspection Reports',file:'inspection-reports',context,blocks:[
    {id:'kpis',label:'Summary',
      kpis:[{label:'Reports',value:rows.length,sub:total>rows.length?`First ${rows.length} of ${total}`:''},{label:'Average score',value:scored.length?r1(rpMean(scored)):'–'},
        {label:'Needs review',value:count(['pending','resubmitted'])},{label:'Changes requested',value:count(['changes'])},{label:'Approved',value:count(['approved'])}],
      table:{head:['Measure','Value'],rows:[['Reports',rows.length],['Average score',scored.length?r1(rpMean(scored)):null],['Needs review',count(['pending','resubmitted'])],['Changes requested',count(['changes'])],['Approved',count(['approved'])]]}},
    {id:'list',label:'Reports',
      table:{head:['Report no.','Date','Quarter','Type','Building','Division','Area','Location','Auditor','Score','Rating','Review status','Last decision by','Last decision at','Last comment'],bands:{9:100},pdfCols:[1,4,5,3,8,9,10,11],
        rows:rows.map(r=>[r.id,r.date,r.quarter,r.type,r.building,r.division,r.area,r.location,r.auditor,r.overall,r.overall!=null?grade(r.overall).label:null,(LIB_STATUS[r.status]||[])[0],r.lastDecision?.by,r.lastDecision?.at,r.lastDecision?.comment])}},
    {id:'items',label:'Every checklist item of these reports',sheet:'Checklist items',formats:['xlsx'],defaults:{xlsx:false},hint:'one row per item',
      load:async()=>{
        const res=await fetch('/api/export/items',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
        const d=await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(d.error||'Could not load the checklist items.');
        const items=(d.items||[]).sort((a,b)=>order.get(a.id)-order.get(b.id)||a.si-b.si||a.ii-b.ii);
        return {head:['Report no.','Date','Building','Division','Type','Auditor','Report score','Section','Item no.','Checklist item','Item score','Comment','Photos'],bands:{6:100},
          rows:items.map(i=>{ const r=byId.get(i.id)||{}, label=i.item||SECTIONS.find(x=>x.title===i.section)?.items[i.ii]||null; // older reports may not store the item text
            return [i.id,r.date,r.building,r.division,r.type,r.auditor,r.overall,i.section,i.ii+1,label,i.score,i.comment,i.photos||null]; })};
      }},
  ]};
}

// ── One export button per tool, placed beside its ⓘ ──
const EXPORT_TOOLS={
  'ins-kpis':['insights','kpis'],'ins-trend':['insights','trend'],'ins-heat':['insights','heat'],'ins-board':['insights','board'],
  'ins-fail':['insights','fail'],'ins-attention':['insights','attention'],'ins-movers':['insights','movers'],
  'rp-summary':['builder','summary'],'rp-detail':['builder','detail'],
  'cmp':['compare','cmp-dim'],
  'dq-unlinked':['quality','unlinked'],'dq-dups':['quality','dups'],'dq-incomplete':['quality','incomplete'],'dq-missing':['quality','missing'],'dq-coverage':['quality','coverage'],
  'ov-kpis':['overview','kpis'],'ov-division':['overview','division'],'ov-team':['overview','auditors'],'ov-area':['overview','areas'],'ov-building':['overview','buildings'],
  'of-kpis':['officer','kpis'],'of-team':['officer','team'],'of-area':['officer','areas'],'of-activity':['officer','activity'],'of-buildings':['officer','buildings'],
  'au-quality':['auditor','quarters'],'au-carried':['auditor','carried'],
  'lib-status':['library','list'],
};
function injectToolExports(){
  document.querySelectorAll('.info-tip[data-tip]').forEach(tip=>{
    const spot=EXPORT_TOOLS[tip.dataset.tip];
    if(!spot||tip.nextElementSibling?.classList.contains('tool-x')) return;
    const btn=document.createElement('button');
    btn.type='button'; btn.className='tool-x rp-export';
    btn.dataset.exCtx=spot[0]; btn.dataset.exBlock=spot[1];
    btn.title='Export this — PDF, Excel or image'; btn.setAttribute('aria-label','Export this');
    btn.innerHTML='<svg data-lucide="download" width="14" height="14"></svg>';
    tip.insertAdjacentElement('afterend',btn);
  });
  lucide.createIcons();
}
injectToolExports(); // EXPORT_TOOLS is declared just above, so this runs after it exists
document.addEventListener('click',e=>{
  const btn=e.target.closest('[data-ex-ctx]');
  if(!btn) return;
  const block=btn.dataset.exBlock==='cmp-dim'?'dim-'+cmpDim:btn.dataset.exBlock;
  openExport(btn.dataset.exCtx,block||undefined);
});

// ── Dialog ──
function initExport(){
  const modal=document.getElementById('modal-export');
  if(modal.dataset.ready) return;
  modal.dataset.ready='1';
  modal.addEventListener('click',e=>{ if(e.target===modal) closeModal('modal-export'); });
  modal.addEventListener('change',e=>{
    if(e.target.name==='ex-fmt'){ exFmt=e.target.value; exRender(); return; }
    if(e.target.closest('#ex-list')){ exRemember(); exSyncAll(); document.getElementById('ex-msg').hidden=true; }
  });
  document.getElementById('ex-all').addEventListener('click',()=>{
    const boxes=[...document.querySelectorAll('#ex-list input[type=checkbox]')], on=!boxes.every(b=>b.checked);
    boxes.forEach(b=>{ b.checked=on; }); exRemember(); exSyncAll();
  });
  document.getElementById('ex-go').addEventListener('click',exRun);
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&modal.classList.contains('open')) closeModal('modal-export'); });
}
async function openExport(ctx,only){
  if(!hasPerm('export')){ showToast('Your account cannot export data.',true); return; }
  initExport();
  exCtx=only?ctx+':'+only:ctx; exModel=null;
  document.getElementById('ex-title').textContent='Export';
  document.getElementById('ex-sub').textContent='';
  document.getElementById('ex-list').innerHTML='<div class="ex-wait">Preparing…</div>';
  document.getElementById('ex-msg').hidden=true;
  document.getElementById('ex-go').disabled=true;
  document.getElementById('modal-export').classList.add('open');
  const key=exCtx;
  let model=null;
  try{
    model=ctx==='insights'?exModelInsights():ctx==='builder'?exModelBuilder():ctx==='compare'?exModelCompare():ctx==='quality'?exModelQuality()
      :ctx==='custom'?exModelCustom():ctx==='overview'?exModelOverview():ctx==='officer'?exModelOfficer():ctx==='auditor'?exModelAuditor()
        :ctx==='library'?await exModelLibrary():ctx==='schedule'?exModelSchedule():null;
  }catch(err){
    if(exCtx===key){ closeModal('modal-export'); showToast(err.message||'Could not prepare the export.',true); }
    return;
  }
  if(exCtx!==key) return;
  if(model&&only){
    const block=model.blocks.find(b=>b.id===only);
    if(!block){ closeModal('modal-export'); showToast('Nothing to export here yet.',true); return; }
    model={...model,
      title:block.docTitle||`${model.title} · ${block.label}`,
      note:block.docNote!==undefined?block.docNote:model.note,
      context:block.docContext||model.context,
      file:block.file||`${model.file}-${only}`,
      blocks:[block]};
  }
  if(!model){ closeModal('modal-export'); showToast('Nothing to export yet — wait for the data to load.',true); return; }
  exModel=model;
  exRender();
  lucide.createIcons();
}
function exChart(b){ const c=typeof b.chart==='function'?b.chart():b.chart?rpCharts[b.chart]:null; return c&&c.canvas?c:null; }
/** Parts that can be exported with or without the inspection results. */
function exHasResults(m){ return !!m&&m.blocks.some(b=>b.table&&b.table.resultCols&&b.table.resultCols.length); }
/** The same export with the score and inspection-date columns taken out. */
function exStripResults(blocks){
  return blocks.map(b=>{
    const t=b.table;
    if(!t||!t.resultCols||!t.resultCols.length) return b;
    const drop=new Set(t.resultCols), keep=t.head.map((_,i)=>i).filter(i=>!drop.has(i));
    const table={...t,head:keep.map(i=>t.head[i]),rows:t.rows.map(r=>keep.map(i=>r[i]))};
    if(t.fmt) table.fmt=keep.map(i=>t.fmt[i]);
    if(t.bands){ table.bands={}; keep.forEach((old,k)=>{ if(t.bands[old]) table.bands[k]=t.bands[old]; }); }
    if(t.pdfHead) table.pdfHead=keep.map(i=>t.pdfHead[i]);
    if(t.pdfCols) table.pdfCols=t.pdfCols.filter(i=>!drop.has(i)).map(i=>keep.indexOf(i));
    delete table.resultCols;
    return {...b,table};
  });
}
function exWantsResults(){
  const box=document.getElementById('ex-results');
  return !box||document.getElementById('ex-results-row').hidden||box.checked;
}
function exVisual(){ return exModel.blocks.filter(b=>exChart(b)||b.image); }
function exRender(){
  const m=exModel, visual=exVisual(), list=document.getElementById('ex-list'), all=document.getElementById('ex-all');
  document.querySelector('#modal-export input[value="png"]').disabled=!visual.length;
  document.getElementById('ex-png-note').textContent=visual.length?'A chart as a picture for slides or email':'There are no charts on this page';
  if(exFmt==='png'&&!visual.length) exFmt='pdf';
  document.querySelectorAll('#modal-export input[name="ex-fmt"]').forEach(r=>{ r.checked=r.value===exFmt; });
  document.getElementById('ex-title').textContent=`Export ${m.title}`;
  document.getElementById('ex-sub').textContent=m.context.map(([k,v])=>`${k}: ${v}`).join(' · ');
  const picked=exPicks[exCtx+':'+exFmt];
  if(exFmt==='png'){
    const opts=[...visual.map(b=>[b.id,b.label]),...(visual.length>1?[['all','All charts in one image']]:[])];
    const cur=opts.some(o=>o[0]===picked)?picked:opts[0][0];
    list.innerHTML=opts.map(([id,l])=>`<label class="ex-row"><input type="radio" name="ex-pick" value="${id}"${id===cur?' checked':''}> ${ovEsc(l)}</label>`).join('');
    document.getElementById('ex-parts-title').textContent='Which chart';
    all.hidden=true;
  }else{
    const avail=m.blocks.filter(b=>!b.formats||b.formats.includes(exFmt));
    const chosen=Array.isArray(picked)?picked:avail.filter(b=>b.defaults?.[exFmt]??true).map(b=>b.id);
    list.innerHTML=avail.map(b=>{
      const n=b.table?b.table.rows.length:null;
      const meta=exFmt==='pdf'&&b.kpis?'cards':[exFmt==='pdf'&&exChart(b)?'chart':'',n!=null?`${n} row${n===1?'':'s'}`:'',b.hint||''].filter(Boolean).join(' + ');
      return `<label class="ex-row"><input type="checkbox" value="${b.id}"${chosen.includes(b.id)?' checked':''}> ${ovEsc(b.label)}<small>${ovEsc(meta)}</small></label>`;
    }).join('');
    document.getElementById('ex-parts-title').textContent=exFmt==='pdf'?'Include in the PDF':'One sheet each';
    all.hidden=false;
    exSyncAll();
  }
  document.getElementById('ex-results-row').hidden=exFmt==='png'||!exHasResults(m);
  document.getElementById('ex-go-label').textContent=exFmt==='pdf'?'Create PDF':exFmt==='xlsx'?'Download Excel':'Download image';
  document.getElementById('ex-go').disabled=false;
  document.getElementById('ex-msg').hidden=true;
}
function exSyncAll(){ const boxes=[...document.querySelectorAll('#ex-list input[type=checkbox]')]; document.getElementById('ex-all').textContent=boxes.length&&boxes.every(b=>b.checked)?'Clear all':'Select all'; }
function exRemember(){
  const list=document.getElementById('ex-list');
  exPicks[exCtx+':'+exFmt]=exFmt==='png'?list.querySelector('input:checked')?.value:[...list.querySelectorAll('input:checked')].map(i=>i.value);
}
async function exRun(){
  const m=exModel;
  if(!m) return;
  const list=document.getElementById('ex-list'), msg=document.getElementById('ex-msg'), go=document.getElementById('ex-go'), label=document.getElementById('ex-go-label');
  const fail=t=>{ msg.textContent=t; msg.hidden=false; };
  if(exFmt==='png'){
    const id=list.querySelector('input:checked')?.value, visual=exVisual(), blocks=id==='all'?visual:visual.filter(b=>b.id===id);
    if(!blocks.length) return fail('Choose a chart.');
    go.disabled=true;
    try{ await exPng(m,blocks); closeModal('modal-export'); showToast('Image downloaded'); }
    catch(err){ fail(err.message||'Could not create the image.'); }
    finally{ go.disabled=false; }
    return;
  }
  const ids=[...list.querySelectorAll('input:checked')].map(i=>i.value);
  if(!ids.length) return fail('Choose at least one part to include.');
  const chosen=m.blocks.filter(b=>ids.includes(b.id));
  const blocks=exWantsResults()?chosen:exStripResults(chosen);
  if(exFmt==='pdf'){
    if(exPdf(m,blocks)) closeModal('modal-export');
    else fail('Your browser blocked the new window. Allow pop-ups for this site, then try again.');
    return;
  }
  go.disabled=true; label.textContent='Preparing…';
  try{
    for(const b of blocks) if(!b.table&&b.load) b.table=await b.load();
    exDownload(`${exSlug(m.file)}-${exDate()}.xlsx`,await exXlsx(m,blocks));
    closeModal('modal-export'); showToast('Excel file downloaded');
  }catch(err){ fail(err.message||'Could not create the Excel file.'); }
  finally{ go.disabled=false; label.textContent='Download Excel'; }
}

// ── Images: charts are redrawn off screen at a fixed size, so every device exports the same sharp picture ──
function exChartCanvas(chart,{width=1100,height=460,scale=2}={}){
  const holder=document.createElement('div');
  holder.style.cssText=`position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;pointer-events:none`;
  const cv=document.createElement('canvas');
  cv.width=width; cv.height=height; cv.style.width=width+'px'; cv.style.height=height+'px';
  holder.appendChild(cv); document.body.appendChild(holder);
  const wasDark=themeIsDark();
  window.__lightCharts=true; if(wasDark) chart.update('none');   // documents are white: draw the light colours
  try{
    const src=chart.config;
    const tmp=new Chart(cv,{type:src.type,data:src.data,options:{...src.options,responsive:false,maintainAspectRatio:false,animation:false,devicePixelRatio:scale}});
    const out=document.createElement('canvas');
    out.width=cv.width; out.height=cv.height;
    const g=out.getContext('2d');
    g.fillStyle='#ffffff'; g.fillRect(0,0,out.width,out.height); g.drawImage(cv,0,0);
    tmp.destroy();
    return out;
  }finally{ holder.remove(); window.__lightCharts=false; if(wasDark) chart.update('none'); }
}
function exHeatCanvas(h,scale=2){
  const cols=[...h.cols,'__overall'], rows=[...h.rows,'__all'];
  const firstW=210, cellW=80, rowH=34, headH=54, W=firstW+cols.length*cellW+12, H=headH+rows.length*rowH+10;
  const cv=document.createElement('canvas');
  cv.width=W*scale; cv.height=H*scale;
  const g=cv.getContext('2d');
  g.scale(scale,scale);
  g.fillStyle='#ffffff'; g.fillRect(0,0,W,H);
  g.textBaseline='middle';
  const fit=(t,max)=>{ let s=String(t); while(s.length>1&&g.measureText(s).width>max) s=s.slice(0,-2)+'…'; return s; };
  g.font='700 11px Cairo, sans-serif'; g.fillStyle=VIZ_INK.secondary; g.textAlign='center';
  cols.forEach((c,i)=>{
    const words=(c==='__overall'?'Overall':sectionShort(c)).split(' '), x=firstW+i*cellW+cellW/2;
    const lines=words.length>1?[words.slice(0,Math.ceil(words.length/2)).join(' '),words.slice(Math.ceil(words.length/2)).join(' ')]:words;
    lines.forEach((l,li)=>g.fillText(fit(l,cellW-6),x,headH-8-(lines.length-1-li)*14));
  });
  rows.forEach((r,ri)=>{
    const y=headH+ri*rowH;
    g.textAlign='left'; g.font=`${r==='__all'?800:700} 13px Cairo, sans-serif`; g.fillStyle=r==='__all'?'#0033A0':VIZ_INK.primary;
    g.fillText(fit(r==='__all'?'All':r,firstW-18),8,y+rowH/2);
    cols.forEach((c,i)=>{
      const v=h.cell(r,c), [bg,fg]=heatColor(v), x=firstW+i*cellW+2;
      g.fillStyle=bg;
      if(g.roundRect){ g.beginPath(); g.roundRect(x,y+2,cellW-4,rowH-4,6); g.fill(); } else g.fillRect(x,y+2,cellW-4,rowH-4);
      if(bg==='#ffffff'){ g.strokeStyle='#e1e0d9'; g.lineWidth=1; g.strokeRect(x+.5,y+2.5,cellW-5,rowH-5); }
      g.fillStyle=fg; g.textAlign='center'; g.font='800 13px Cairo, sans-serif';
      g.fillText(v==null?'–':String(v),x+(cellW-4)/2,y+rowH/2);
    });
  });
  return cv;
}
async function exPng(m,blocks){
  const S=2, W=1100*S, pad=36*S, headH=112*S, titleH=40*S, gap=24*S, footH=44*S;
  const parts=blocks.map(b=>{ const cv=b.image?b.image():exChartCanvas(exChart(b)); const w=Math.min(W-2*pad,cv.width); return {b,cv,w,h:Math.round(cv.height*w/cv.width)}; });
  const H=headH+parts.reduce((n,p)=>n+titleH+p.h+gap,0)+footH;
  const out=document.createElement('canvas');
  out.width=W; out.height=H;
  const g=out.getContext('2d');
  g.fillStyle='#ffffff'; g.fillRect(0,0,W,H);
  g.fillStyle='#26A8AB'; g.fillRect(0,0,W,6*S);
  g.textAlign='left'; g.textBaseline='alphabetic';
  g.font=`800 ${11*S}px Cairo, sans-serif`; g.fillText('OSD FACILITY EXPERIENCE · QUALITY ASSURANCE',pad,36*S);
  g.fillStyle='#002070'; g.font=`800 ${24*S}px Cairo, sans-serif`; g.fillText(m.title,pad,68*S);
  g.fillStyle='#5F6369'; g.font=`600 ${12.5*S}px Cairo, sans-serif`; g.fillText(m.context.map(([k,v])=>`${k}: ${v}`).join('   ·   '),pad,94*S,W-2*pad-150*S);
  try{ // the OSQA logo, top right; the image is still created if it cannot load
    const logo=new Image(); logo.src='/osqa-logo.svg'; await logo.decode();
    const lh=38*S, lw=lh*(logo.naturalWidth/logo.naturalHeight||2.84);
    g.drawImage(logo,W-pad-lw,24*S,lw,lh);
  }catch{}
  let y=headH;
  parts.forEach(p=>{
    g.fillStyle='#002070'; g.font=`800 ${15*S}px Cairo, sans-serif`; g.fillText(p.b.label,pad,y+26*S,W-2*pad);
    y+=titleH; g.drawImage(p.cv,pad,y,p.w,p.h); y+=p.h+gap;
  });
  g.fillStyle='#D9DEE3'; g.fillRect(pad,H-footH,W-2*pad,S);
  g.fillStyle='#5F6369'; g.font=`600 ${11*S}px Cairo, sans-serif`;
  g.fillText('Facility Experience Quality Assurance',pad,H-16*S);
  g.textAlign='right'; g.fillText('Generated '+new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}),W-pad,H-16*S);
  const blob=await new Promise((resolve,reject)=>out.toBlob(b=>b?resolve(b):reject(new Error('Could not create the image.')),'image/png'));
  const file=exSlug(m.file), tag=blocks.length>1?'-charts':file.endsWith(exSlug(blocks[0].id))?'':'-'+exSlug(blocks[0].id);
  exDownload(`${file}${tag}-${exDate()}.png`,blob);
}

// ── PDF: a print-ready page (landscape A4) in a new window; "Save as PDF" keeps text sharp and searchable ──
/**
 * The export as a printable A4 document, in the same hand as the inspection report:
 * the document owns the paper (no page margin, so the browser prints no file name, date
 * or address of its own), paginates itself, repeats a table's heading on every page it
 * runs onto, and carries the same toolbar — Save as PDF works on iPhone and iPad, where
 * printing a page written into about:blank does nothing.
 */
function exDocHtml(m,blocks,{sameTab=false}={}){
  // A part exported on its own (an auditor's table, say) already speaks for itself: the
  // model carries its heading and its facts, so the part is not announced a second time.
  const solo=blocks.length===1&&!!(blocks[0].docTitle||blocks[0].docContext);
  const title=m.title, note=m.note||'', chips=m.context||[];
  const fileName=exSlug(m.file)+'-'+exDate()+'.pdf';
  const portrait=m.pdfPage==='portrait';
  const W=portrait?210:297, H=portrait?297:210;
  const logoUrl=new URL('/osqa-logo.svg',location.origin).href;
  const cell=v=>{
    if(v==null||v==='') return '–';
    const text=String(v);
    if(EX_STAMP.test(text)){ const u=exLocalStamp(text); if(u) return ovEsc(u.toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})); }
    return ovEsc(/^\d{4}-\d{2}-\d{2}$/.test(text)?new Date(text+'T12:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):text);
  };
  // a number as the sheet shows it: ▲ 3.5, 64%, 78.4 — with the colour of a change that is better or worse
  const shown=(raw,i,t)=>{
    const o=raw&&typeof raw==='object'&&!Array.isArray(raw)&&'v' in raw?raw:{v:raw}, v=o.v, f=o.f||(t.fmt&&t.fmt[i])||'';
    if(typeof v!=='number'||!Number.isFinite(v)) return {html:cell(v),cls:'',style:''};
    let html, cls='', style='';
    if(/^d/.test(f)){
      html=v===0?'–':`${v>0?'▲':'▼'} ${Math.abs(Math.round(v*10)/10)}`;
      if(v!==0&&!/n$/.test(f)){ const better=/r$/.test(f)?v<0:v>0; cls=better?' up':' down'; }
    }else if(f==='pct') html=v+'%';
    else if(f==='int') html=v.toLocaleString('en-GB');
    else if(f==='n1'||(!f&&!Number.isInteger(v))) html=(Math.round(v*10)/10).toFixed(1);
    else html=String(v);
    const scale=o.band||(t.bands&&t.bands[i]);
    if(scale){ const g=grade(scale===10?v*10:v); style=`background:${g.soft};color:${g.ink};font-weight:800`; }
    return {html,cls,style};
  };
  const table=t=>{
    const cols=t.pdfCols||t.head.map((_,i)=>i), head=t.pdfHead||t.head, numeric=i=>t.rows.some(r=>typeof exV(r[i])==='number');
    const body=t.rows.map(r=>`<tr>${cols.map(i=>{ const v=exV(r[i]), c=t.heat&&i>0&&typeof v==='number'?heatColor(v):null, x=c?null:shown(r[i],i,t);
      return `<td class="${numeric(i)?'n':''}${c?' hm':''}${x?x.cls:''}"${c?` style="background:${c[0]};color:${c[1]}"`:x&&x.style?` style="${x.style}"`:''}>${c?cell(v):x.html}</td>`; }).join('')}</tr>`).join('');
    return `<table${t.heat?' class="heat"':''}><thead><tr>${cols.map(i=>`<th${numeric(i)?' class="n"':''}>${ovEsc(head[i])}</th>`).join('')}</tr></thead>
      <tbody>${body||`<tr><td colspan="${cols.length}" class="empty">Nothing to show for these filters.</td></tr>`}</tbody></table>`;
  };
  // The foot explains only what this page contains: a scale when scores are printed, and what
  // a dash means when at least one cell is empty. The dash is always in brackets.
  const printed=blocks.filter(b=>b.table).map(b=>{ const t=b.table, cols=t.pdfCols||t.head.map((_,i)=>i); return {t,cols,head:t.pdfHead||t.head}; });
  const scored=printed.some(p=>p.cols.some(i=>/score|average/i.test(p.head[i]||'')));
  const sectioned=blocks.some(b=>/section/i.test(b.label||''));
  const anyBlank=printed.some(p=>p.t.rows.some(r=>p.cols.some(i=>r[i]==null||r[i]==='')));
  const legend=[scored?`Scores are out of 100${sectioned?' · section scores out of 10':''}`:'',anyBlank?'(– means no data)':''].filter(Boolean).join(' ');
  // Each part goes into the flow whole; the layout below cuts it into pages.
  const flow=blocks.map(b=>{
    const heading=solo?'':`<h2>${ovEsc(b.label)}</h2>`;
    const cards=b.kpis?`<div class="kpis">${b.kpis.map(k=>`<div class="kpi"><span>${ovEsc(k.label)}</span><b>${cell(k.value)}</b>${k.sub?`<small>${ovEsc(k.sub)}</small>`:''}</div>`).join('')}</div>`:'';
    const img=!b.kpis&&exChart(b)?exChartCanvas(exChart(b)).toDataURL('image/png'):'';
    // Cards already say what a "Measure / Value" table would repeat; a part asks for both.
    const rows=b.table&&(!b.kpis||b.pdfTable)?table(b.table):'';
    return `<section class="blk"${b.pdfBreak?' data-break="1"':''}>${heading}${cards}${img?`<figure><img src="${img}" alt="${ovEsc(b.label)}"></figure>`:''}${rows}</section>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ovEsc(fileName.replace(/\.pdf$/,''))}</title>
<link rel="icon" type="image/svg+xml" href="/osqa-icon.svg">
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
:root{--ink:#002070;--deep:#102040;--royal:#0033A0;--teal:#26A8AB;--paper:#F4F7FA;--line:#D9DEE3;--muted:#5F6369;
  --pad-x:12mm;--pad-t:11mm;--pad-b:9mm}
*{box-sizing:border-box;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
/* The document owns the paper: no page margin means no browser header, footer or URL. */
@page{size:A4 ${portrait?'portrait':'landscape'};margin:0}
html,body{margin:0;padding:0;background:#fff;color:var(--deep);font-family:Cairo,Arial,sans-serif;font-size:10pt;line-height:1.4}
.sheet{width:${W}mm;height:${H}mm;padding:var(--pad-t) var(--pad-x) var(--pad-b);overflow:hidden;display:flex;flex-direction:column;background:#fff;break-after:page;page-break-after:always}
.sheet:last-child{break-after:auto;page-break-after:auto}
.body{flex:1;min-height:0;overflow:hidden}
#flow{position:absolute;left:-9999px;top:0;width:${W-24}mm}

.bar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 14px;background:#0A1B3D;color:#fff;font-size:13px}
.bar b{font-weight:800;margin-right:auto;font-size:13px}
.bar button{font:inherit;font-weight:800;border:0;border-radius:8px;padding:8px 14px;min-height:40px;cursor:pointer;background:#26A8AB;color:#04263A}
.bar button[disabled]{opacity:.6;cursor:default}
.bar button.ghost{background:rgba(255,255,255,.14);color:#fff}
.bar small{opacity:.7;width:100%;font-size:11px}
      @media(max-width:600px){.bar b{flex:0 0 100%;margin:0}.bar button{flex:1 1 auto}}
@media screen{body{background:#E9EDF1;padding-bottom:10px}.sheet{margin:0 auto 10px;box-shadow:0 1px 5px rgba(16,32,64,.2)}}
@media print{.bar{display:none!important}body{background:#fff}.sheet{margin:0;box-shadow:none}}
#doc{width:${W}mm;margin:0 auto;transform-origin:top left}
@media print{#doc{transform:none!important;width:auto}#docwrap{height:auto!important}}

.rule{height:5px;border-radius:99px;background:linear-gradient(90deg,var(--royal),var(--teal));flex:none}
.brand{display:flex;align-items:center;gap:12px;margin-top:12px;color:var(--royal);font-weight:900;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;flex:none}
.brand img{display:block;height:30px;width:auto}.brand i{width:1px;height:20px;background:var(--line);display:block}
.head{flex:none;display:flex;justify-content:space-between;gap:20px;align-items:flex-end;margin:9px 0 12px}
h1{margin:0;color:var(--ink);font-size:26px;line-height:1.1;letter-spacing:-.03em}
h1 span{color:var(--royal)}
.lead{margin:6px 0 0;color:var(--muted);font-size:11px;font-weight:700}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}
.chip{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:9px;background:var(--paper);font-weight:700}
.chip b{color:var(--muted);font-weight:800;margin-right:5px;text-transform:uppercase;letter-spacing:.06em}
.foot{flex:none;display:flex;justify-content:space-between;align-items:baseline;gap:12px;color:var(--muted);font-size:8.5px;font-weight:700;border-top:1px solid var(--line);padding-top:5px;margin-top:8px}
.foot .legend{flex:1;text-align:center;font-weight:600}

.blk{margin:0 0 12px}
.blk:last-child{margin-bottom:0}
h2{font-size:13px;color:var(--ink);margin:0 0 7px;padding-bottom:4px;border-bottom:1.5px solid var(--line)}
h2 small{float:right;color:var(--muted);font-size:9px;font-weight:700}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(38mm,1fr));gap:7px}
.kpi{border:1px solid var(--line);border-left:4px solid var(--royal);border-radius:8px;padding:7px 10px;background:var(--paper)}
.kpi span{display:block;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.kpi b{display:block;font-size:17px;color:var(--ink);line-height:1.25}
.kpi small{font-size:8.5px;color:var(--muted)}
figure{margin:0 0 8px;border:1px solid var(--line);border-radius:8px;padding:8px}
figure img{display:block;width:100%;max-height:${portrait?'120mm':'105mm'};object-fit:contain}
table{width:100%;border-collapse:collapse;font-size:9px;table-layout:auto}
th{background:var(--ink);color:#fff;text-align:left;font-size:8px;font-weight:800;letter-spacing:.03em;padding:5px 7px;vertical-align:bottom}
th:first-child{border-radius:5px 0 0 0}th:last-child{border-radius:0 5px 0 0}
td{padding:4px 7px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:nth-child(even) td:not(.hm){background:var(--paper)}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
table.heat td.hm{text-align:center;font-weight:800;border:2px solid #fff}
.empty{color:var(--muted);font-style:italic;text-align:center}
td.up{color:#007A38;font-weight:800}td.down{color:#CB3010;font-weight:800}
</style></head><body>
<div class="bar">
  <b>${ovEsc(title)}${note?' · '+ovEsc(note):''}</b>
  <button type="button" id="save-pdf">Save as PDF</button>
  <button type="button" class="ghost" data-doc="print">Print</button>
  <button type="button" class="ghost" data-doc="${sameTab?'back':'close'}">${sameTab?'Back to the app':'Close'}</button>
  <small id="bar-note">On iPhone or iPad, use <b>Save as PDF</b> — the file opens in the share sheet, where you can save it to Files, send it, or print it.</small>
</div>
<div id="docwrap"><div id="doc"><div id="sheets"></div></div></div>
<div id="flow">${flow}</div>
<script type="application/json" id="doc-config">${jsonInScript({
  firstHead:`<div class="rule"></div>
  <div class="brand"><img src="${ovEsc(logoUrl)}" alt="OSQA"><i></i>OSD · Facility Experience Quality Assurance</div>
  <div class="head"><div><h1>${ovEsc(title)}</h1>${note?`<p class="lead">${ovEsc(note)}</p>`:''}
    <div class="chips">${chips.map(([k,v])=>`<span class="chip"><b>${ovEsc(k)}</b>${ovEsc(v)}</span>`).join('')}</div></div></div>`,
  docName:fileName, legend:legend?`<span class="legend">${ovEsc(legend)}</span>`:'<span></span>',
  orientation:portrait?'portrait':'landscape', pageW:W, pageH:H,
})}</script>
<script src="/js/doc-export.js"></script>
</body></html>`;
}

/** The PDF opens as its own page — the only way iPhone and iPad can print or save it. */
function exPdf(m,blocks){
  openDocPage(()=>Promise.resolve(exDocHtml(m,blocks)),
    {sameTab:()=>Promise.resolve(exDocHtml(m,blocks,{sameTab:true})),what:'export'});
  return true;
}

// ── Excel: a real .xlsx (Office Open XML) — numbers stay numbers, dates are dates, one sheet per table ──
const EX_CRC=(()=>{ const t=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=c&1?0xEDB88320^(c>>>1):c>>>1; t[n]=c>>>0; } return t; })();
function exCrc32(bytes){ let c=0xFFFFFFFF; for(let i=0;i<bytes.length;i++) c=EX_CRC[(c^bytes[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
// ZIP container for the workbook. Parts are deflate-compressed where the browser supports it
// (CompressionStream), otherwise stored as-is — both are valid .xlsx files.
async function exDeflate(data){
  if(typeof CompressionStream!=='function') return null;
  try{ return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); }
  catch{ return null; }
}
async function exZip(files){ // [{name, data: Uint8Array}] → Uint8Array
  const enc=new TextEncoder(), u16=v=>[v&255,(v>>>8)&255], u32=v=>[v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255];
  const chunks=[], central=[]; let offset=0;
  for(const f of files){
    const name=enc.encode(f.name), data=f.data, crc=exCrc32(data), packed=await exDeflate(data);
    const method=packed&&packed.length<data.length?8:0, body=method?packed:data;
    const local=new Uint8Array([...u32(0x04034b50),...u16(20),...u16(0),...u16(method),...u16(0),...u16(0x21),...u32(crc),...u32(body.length),...u32(data.length),...u16(name.length),...u16(0)]);
    chunks.push(local,name,body);
    central.push(new Uint8Array([...u32(0x02014b50),...u16(20),...u16(20),...u16(0),...u16(method),...u16(0),...u16(0x21),...u32(crc),...u32(body.length),...u32(data.length),...u16(name.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(offset)]),name);
    offset+=local.length+name.length+body.length;
  }
  const size=central.reduce((n,c)=>n+c.length,0);
  const end=new Uint8Array([...u32(0x06054b50),...u16(0),...u16(0),...u16(files.length),...u16(files.length),...u32(size),...u32(offset),...u16(0)]);
  const all=[...chunks,...central,end], out=new Uint8Array(all.reduce((n,c)=>n+c.length,0));
  let p=0; all.forEach(c=>{ out.set(c,p); p+=c.length; });
  return out;
}
// Characters XML 1.0 does not allow (control codes other than tab, newline and carriage return).
const EX_XML_BAD=new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]','g');
function exXmlEsc(v){ return String(v).replace(EX_XML_BAD,'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }
function exColName(i){ let s=''; for(i++;i>0;i=Math.floor((i-1)/26)) s=String.fromCharCode(65+(i-1)%26)+s; return s; }
/** The value inside a table cell, whether it is written plainly or as {v, f, band}. */
const exV=x=>x&&typeof x==='object'&&!Array.isArray(x)&&'v' in x?x.v:x;
const EX_DATE=/^(\d{4})-(\d{2})-(\d{2})$/, EX_STAMP=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
/** What the server stores as UTC, shown on this device's clock. */
function exLocalStamp(text){
  const m=EX_STAMP.exec(text); if(!m) return null;
  const u=new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0)));
  return Number.isNaN(u.getTime())?null:u;
}
/** Number formats for tables: what a column or cell may ask for with fmt / f. d* are changes: ▲ ▼ and a colour; n = no colour, r = up is bad. */
const EX_FMT={int:'#,##0',n1:'0.0',pct:'0"%"',date:'dd mmm yyyy',datetime:'dd mmm yyyy hh:mm',
  d1:'[Color10]"▲ "0.0;[Red]"▼ "0.0;"–"',d1n:'"▲ "0.0;"▼ "0.0;"–"',d1r:'[Red]"▲ "0.0;[Color10]"▼ "0.0;"–"',
  di:'[Color10]"▲ "#,##0;[Red]"▼ "#,##0;"–"',din:'"▲ "#,##0;"▼ "#,##0;"–"',dir:'[Red]"▲ "#,##0;[Color10]"▼ "#,##0;"–"'};
/** Which kind a column is: what it asked for, or what its values are. */
function exKind(t,ci){
  const asked=t.fmt&&t.fmt[ci];
  if(asked) return asked;                       // 't' means "leave it as it is" — a report number is not a quantity
  const vals=t.rows.slice(0,400).map(r=>exV(r[ci])).filter(v=>v!=null&&v!=='');
  if(!vals.length) return 't';
  if(vals.every(v=>typeof v==='number')) return /\(%\)|%$/.test(t.head[ci])?'pct':vals.every(Number.isInteger)?'int':'n1';
  if(vals.every(v=>typeof v==='string'&&EX_STAMP.test(v))) return 'datetime';
  if(vals.every(v=>typeof v==='string'&&EX_DATE.test(v))) return 'date';
  return 't';
}
async function exXlsx(m,blocks){
  const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main', REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships', XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const NAVY='172C67', INK='002070', ROYAL='0033A0', MUTED='5F6369', LINE='E3E6E9', WHITE='FFFFFF';
  const enc=new TextEncoder();

  // ── looks: a cell says what it looks like, and the workbook stores each look once ──
  const fonts=[], fills=[], borders=[], numFmts=[], xfs=[];
  const put=(list,xml)=>{ let i=list.indexOf(xml); if(i<0){ i=list.length; list.push(xml); } return i; };
  put(fonts,'<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>');
  put(fills,'<fill><patternFill patternType="none"/></fill>'); put(fills,'<fill><patternFill patternType="gray125"/></fill>');
  put(borders,'<border><left/><right/><top/><bottom/><diagonal/></border>');
  put(xfs,'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  const BUILTIN={'0':1,'#,##0':3};
  const fmtId=code=>code==null?0:(code in BUILTIN?BUILTIN[code]:164+put(numFmts,code));
  const looks=new Map();
  const look=o=>{
    const key=JSON.stringify(o); if(looks.has(key)) return looks.get(key);
    const f=put(fonts,`<font>${o.b?'<b/>':''}${o.i?'<i/>':''}<sz val="${o.sz||11}"/>${o.color?`<color rgb="FF${o.color}"/>`:''}<name val="Calibri"/><family val="2"/></font>`);
    const fl=o.fill?put(fills,`<fill><patternFill patternType="solid"><fgColor rgb="FF${o.fill}"/><bgColor indexed="64"/></patternFill></fill>`):0;
    const bd=o.line?put(borders,`<border><left/><right/><top/><bottom style="thin"><color rgb="FF${o.line}"/></bottom><diagonal/></border>`):0;
    const al=`<alignment${o.h?` horizontal="${o.h}"`:''} vertical="${o.v||'center'}"${o.wrap?' wrapText="1"':''}${o.indent?` indent="${o.indent}"`:''}/>`;
    const x=put(xfs,`<xf numFmtId="${fmtId(o.fmt)}" fontId="${f}" fillId="${fl}" borderId="${bd}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${al}</xf>`);
    looks.set(key,x); return x;
  };

  // ── cells ──
  const strings=[], stringIndex=new Map(); let stringRefs=0;
  const str=v=>{ const t=String(v).slice(0,32000); stringRefs++; if(!stringIndex.has(t)){ stringIndex.set(t,strings.length); strings.push(t); } return stringIndex.get(t); };
  const cellXml=(ref,c)=>{
    if(!c) return '';
    const v=c[0], x=c[1]||0, sa=x?` s="${x}"`:'';
    if(v==null||v===''||(typeof v==='number'&&!Number.isFinite(v))) return x?`<c r="${ref}"${sa}/>`:'';
    if(typeof v==='number') return `<c r="${ref}"${sa}><v>${v}</v></c>`;
    // Text is stored as text, never as a formula. Text that starts like one (= + - @) is also
    // marked "quoted", so it stays text even when someone edits the cell in Excel later.
    const q=/^[=+\-@\t\r]/.test(String(v))?asText(x):x;
    return `<c r="${ref}" t="s"${q?` s="${q}"`:''}><v>${str(v)}</v></c>`;
  };
  const textLooks=new Map();
  const asText=x=>{
    if(!textLooks.has(x)) textLooks.set(x,put(xfs,xfs[x].replace('<xf ','<xf quotePrefix="1" ')));
    return textLooks.get(x);
  };
  const serialOf=(text,kind)=>{
    if(kind==='datetime'){ const u=exLocalStamp(text); return u?Date.UTC(u.getFullYear(),u.getMonth(),u.getDate(),u.getHours(),u.getMinutes(),u.getSeconds())/86400000+25569:null; }
    const d=EX_DATE.exec(text); if(!d) return null;
    const day=new Date(Date.UTC(+d[1],+d[2]-1,+d[3]));
    return day.getUTCMonth()===+d[2]-1&&day.getUTCDate()===+d[3]?day.getTime()/86400000+25569:null;
  };

  const used=new Set(['read me']);
  const sheetName=l=>{
    const base=String(l).replace(/[\[\]:*?\/\\]/g,' ').replace(/^'+|'+$/g,'').replace(/\s+/g,' ').trim().slice(0,31)||'Sheet';
    let n=base, i=2;
    while(used.has(n.toLowerCase())){ const suffix=` (${i++})`; n=base.slice(0,31-suffix.length)+suffix; }
    used.add(n.toLowerCase());
    return n;
  };
  const localNow=new Date().toLocaleString('en-GB',{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'});

  // ── one sheet per table: a title, what it is filtered to, a line on how to read it, then the table ──
  const tableSheet=b=>{
    const t=b.table, ncol=t.head.length, kinds=t.head.map((_,ci)=>exKind(t,ci));
    const ctx=b.contextLine||(m.context||[]).map(([k,v])=>`${k}: ${v}`).join('  ·  ');
    const rows=[];
    rows.push({ht:26,cells:[[b.docTitle||b.label,look({b:true,sz:14,color:INK})]]});
    rows.push({ht:16,cells:[[ctx,look({sz:10,color:MUTED})]]});
    rows.push({ht:16,cells:[[b.note||'',look({sz:10,i:true,color:MUTED})]]});
    const widths=t.head.map((h,ci)=>{
      const k=kinds[ci]; let w=k==='date'?14:k==='datetime'?18:k==='t'?10:11;
      w=Math.max(w,Math.min(Math.ceil(String(h).length/2)+3,22));
      t.rows.slice(0,300).forEach(r=>{ const v=exV(r[ci]); if(v==null||v==='') return;
        const len=typeof v==='number'?String(Math.round(v*10)/10).length+(k[0]==='d'&&k!=='date'&&k!=='datetime'?3:0):String(v).length;
        w=Math.max(w,Math.min(len+2,k==='t'?58:24)); });
      return w;
    });
    const lines=Math.max(1,...t.head.map((h,ci)=>Math.ceil(String(h).length/Math.max(6,widths[ci]-1))));
    rows.push({ht:Math.max(30,15*Math.min(lines,3)+8),cells:t.head.map((h,ci)=>[h,look({b:true,color:WHITE,fill:NAVY,h:kinds[ci]==='t'?'left':'center',wrap:true})])});
    t.rows.forEach(r=>{
      rows.push({cells:t.head.map((_,ci)=>{
        const raw=r[ci], o=raw&&typeof raw==='object'&&!Array.isArray(raw)&&'v' in raw?raw:{v:raw};
        const kind=o.f||kinds[ci];
        let v=o.v;
        if(typeof v==='string'&&(kind==='date'||kind==='datetime')){ const s=serialOf(v,kind); if(s!=null) v=s; }
        const scale=o.band||(t.bands&&t.bands[ci]);
        const look_={line:LINE,h:kind==='t'?'left':'center',wrap:kind==='t',fmt:EX_FMT[kind]||null};
        if(scale&&typeof v==='number'){ const g=BANDS[grade(scale===10?v*10:v).label]; look_.fill=g.soft.slice(1); look_.color=g.ink.slice(1); look_.b=true; }
        return [v,look(look_)];
      })});
    });
    return {name:sheetName(b.sheet||b.label),rows,widths,header:4,dataRows:t.rows.length,table:true,tab:NAVY};
  };

  // ── "Read me": what the file is, what each sheet shows, and what the words mean ──
  const readMe=tables=>{
    const rows=[], A=look({b:true,color:MUTED,v:'top',sz:10}), V=look({wrap:true,v:'top'});
    const H=look({b:true,sz:12,color:ROYAL,line:ROYAL}), HT=look({b:true,color:WHITE,fill:NAVY,h:'left'});
    const P=(cells,ht)=>rows.push({ht,cells});
    P([[m.title,look({b:true,sz:18,color:INK})]],30);
    P([['OSD Facility Experience Quality Assurance',look({sz:10,color:MUTED})]],16);
    P([]);
    if(m.blurb||m.note){ P([['What this shows',A],[m.blurb||m.note,V]]); }
    (m.context||[]).forEach(([k,v])=>P([[k,A],[String(v),V]]));
    P([['Created',A],[localNow+(currentUser&&currentUser.name?' · by '+currentUser.name:''),V]]);
    P([]);
    P([['Sheets',H],['',H]],20);
    tables.forEach(sh=>P([[sh.name,look({b:true,color:INK,v:'top'})],[sh.desc||'',V]]));
    P([]);
    P([['How to read it',H],['',H]],20);
    const words=[...(m.glossary||[]),
      ['Score','Each report scores out of 100: its ten section scores (each out of 10) added together.'],
      ['Change','Later period minus earlier period. ▲ is up, ▼ is down, a dash means no change; green is better and red is worse where that is clear.'],
      ['BOQI / EOQI','Beginning of Quarter Inspection / End of Quarter Inspection.'],
      ['Empty cell','There is no data for it. It is not zero.']];
    words.forEach(([k,d])=>P([[k,look({b:true,color:INK,v:'top'})],[d,V]]));
    P([]);
    P([['Rating',H],['',H]],20);
    ['Excellent','Good','Acceptable','Poor','Critical'].forEach(name=>{
      const b=BANDS[name];
      P([[name,look({b:true,fill:b.fill.slice(1),color:b.on.slice(1),h:'left'})],[`${b.range} · ${b.note}`,V]]);
    });
    return {name:'Read me',rows,widths:[26,96],header:0,table:false,tab:'26A8AB'};
  };

  const tables=blocks.filter(b=>b.table).map(b=>{ const sh=tableSheet(b); sh.desc=b.desc||b.label; return sh; });
  const sheets=[readMe(tables),...tables];

  const sheetXml=(sh,idx)=>{
    const ncols=sh.widths.length;
    const width=Math.max(ncols,...sh.rows.map(r=>r.cells.length));
    const lastRow=sh.rows.length, lastCol=exColName(Math.max(ncols,1)-1);
    const rowsXml=sh.rows.map((r,ri)=>`<row r="${ri+1}"${r.ht?` ht="${r.ht}" customHeight="1"`:''}>${r.cells.map((c,ci)=>cellXml(exColName(ci)+(ri+1),c)).join('')}</row>`).join('');
    const pane=sh.table?`<pane ySplit="${sh.header}" topLeftCell="A${sh.header+1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sh.header+1}" sqref="A${sh.header+1}"/>`:'';
    return XML+`<worksheet xmlns="${NS}" xmlns:r="${REL}"><sheetPr><tabColor rgb="FF${sh.tab}"/><pageSetUpPr fitToPage="1"/></sheetPr>`+
      `<dimension ref="A1:${exColName(width-1)}${Math.max(1,lastRow)}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"${idx===0?' tabSelected="1"':''}>${pane}</sheetView></sheetViews>`+
      `<sheetFormatPr defaultRowHeight="15"/><cols>${sh.widths.map((wd,i)=>`<col min="${i+1}" max="${i+1}" width="${wd}" customWidth="1"/>`).join('')}</cols>`+
      `<sheetData>${rowsXml}</sheetData>${sh.table&&sh.dataRows>0?`<autoFilter ref="A${sh.header}:${lastCol}${lastRow}"/>`:''}`+
      `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  };
  const sheetFiles=sheets.map(sheetXml);
  const names=sheets.map((sh,i)=>{
    if(!sh.table) return '';
    const q=exXmlEsc(`'${sh.name.replace(/'/g,"''")}'`), lastCol=exColName(sh.widths.length-1), lastRow=sh.rows.length;
    return (sh.dataRows>0?`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${q}!$A$${sh.header}:$${lastCol}$${lastRow}</definedName>`:'')+
      `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${q}!$${sh.header}:$${sh.header}</definedName>`;
  }).join('');
  const n=sheets.length;
  const stylesXml=XML+`<styleSheet xmlns="${NS}">${numFmts.length?`<numFmts count="${numFmts.length}">${numFmts.map((c,i)=>`<numFmt numFmtId="${164+i}" formatCode="${exXmlEsc(c)}"/>`).join('')}</numFmts>`:''}`+
    `<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders>`+
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const files=[
    ['[Content_Types].xml',XML+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ['_rels/.rels',XML+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ['docProps/core.xml',XML+`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${exXmlEsc(m.title)}</dc:title><dc:creator>${exXmlEsc(currentUser?.name||'OSD Facility Experience QA')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/,'Z')}</dcterms:created></cp:coreProperties>`],
    ['xl/workbook.xml',XML+`<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets.map((sh,i)=>`<sheet name="${exXmlEsc(sh.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets>${names?`<definedNames>${names}</definedNames>`:''}</workbook>`],
    ['xl/_rels/workbook.xml.rels',XML+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${REL}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${n+1}" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId${n+2}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ['xl/styles.xml',stylesXml],
    ...sheetFiles.map((x,i)=>[`xl/worksheets/sheet${i+1}.xml`,x]),
    ['xl/sharedStrings.xml',XML+`<sst xmlns="${NS}" count="${stringRefs}" uniqueCount="${strings.length}">${strings.map(t=>`<si><t xml:space="preserve">${exXmlEsc(t)}</t></si>`).join('')}</sst>`],
  ];
  return new Blob([await exZip(files.map(([name,text])=>({name,data:enc.encode(text)})))],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}

// ═══════════════════════════════════════════════════════════
// NAVIGATION HELPERS: team tabs, home quick actions
// ═══════════════════════════════════════════════════════════
function renderTeamTabs(pages){
  const meta={'pg-overview':['layout-grid','Overview'],'pg-officer':['clipboard-list','Assign & Track']};
  document.querySelectorAll('.team-tabs').forEach(el=>{
    const here=el.closest('.page').id;
    el.hidden=pages.length<2;
    el.innerHTML=pages.map(pid=>`<button class="page-tab${pid===here?' active':''}" data-page="${pid}"><svg data-lucide="${meta[pid][0]}" width="14" height="14"></svg>${meta[pid][1]}</button>`).join('');
    el.onclick=e=>{ const b=e.target.closest('[data-page]'); if(b&&b.dataset.page!==here) nav(b.dataset.page); };
  });
  lucide.createIcons();
}
function renderHomeActions(user,teamPages){
  const actions=[];
  if(ASSIGNEE_ROLES.includes(user.role)&&hasPerm('inspect')) actions.push(['pg-auditor','calendar-check','My Assignments','Your buildings, schedule and results']);
  if(hasPerm('inspect')) actions.push(['pg-new','clipboard-check','Start an Inspection','Details → sections → score card']);
  if(teamPages.length) actions.push([teamPages[0],'users','Team',
    teamPages.length>1?'Team overview and building assignments':teamPages[0]==='pg-officer'?'Assign buildings and track auditors live':'Progress of officers and auditors']);
  actions.push(['pg-library','file-search',hasPerm('review')?'Review Reports':'Inspection Reports',hasPerm('review')?'Search reports and approve or return them':'Search and open any saved report']);
  if(hasPerm('reports')) actions.push(['pg-reports','bar-chart-3','Analytics','Insights, report builder, comparisons and data quality']);
  if(user.role==='quality_admin') actions.push(['pg-admin','shield-check','Admin Control','Accounts, permissions, buildings and audit log']);
  const box=document.getElementById('home-actions');
  box.innerHTML=actions.map(([pid,icon,title,sub])=>`<button class="qa-card" data-page="${pid}">
    <span class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></span>
    <div><b>${title}</b><small>${sub}</small></div>
    <svg class="qa-go" data-lucide="chevron-right" width="16" height="16"></svg></button>`).join('');
  box.onclick=e=>{ const b=e.target.closest('[data-page]'); if(b) nav(b.dataset.page); };
  lucide.createIcons();
}

// ═══════════════════════════════════════════════════════════
// ADMIN CONTROL (Quality Admin) — Users & Permissions · Buildings · Audit Log
// ═══════════════════════════════════════════════════════════
function hasPerm(key){ return !!currentUser&&(currentUser.permissions||[]).includes(key); }
function adRoleLabels(){
  return {quality_auditor:'Quality Auditor',quality_officer:'Quality Officer',quality_leader:'Quality Leader',data_analyst:'Data Analyst',quality_admin:'Quality Admin'};
}
function adPermCatalog(){
  return [
    ['Inspections',[
      ['inspect','Create & edit inspections','Start inspections, score sections and save reports'],
      ['delete','Delete inspections','Remove saved reports from the history'],
      ['export','Export data','Download PDF, Excel and image exports'],
      ['review','Review reports','Approve reports or send them back to the auditor with comments'],
    ]],
    ['Team',[
      ['assign','Assign buildings','Use Assign & Track to assign and move buildings between auditors'],
      ['team','View team overview','Progress across officers, auditors, divisions and buildings'],
      ['profiles','View auditor profiles','Any auditor’s assignments, schedule and quality of work'],
    ]],
    ['Insights',[
      ['reports','Reports & Analytics','Filter every inspection, charts and statistics'],
    ]],
  ];
}
function adPermLabel(key){ for(const [,items] of adPermCatalog()) for(const [k,l] of items) if(k===key) return l; return key; }
function adTabLabel(tab){ return {users:'Users & Permissions',buildings:'Buildings',audit:'Audit Log',backup:'Backup & Archive'}[tab]||''; }

function initAdmin(){
  if(adReady) return;
  adReady=true;
  const labels=adRoleLabels();
  document.getElementById('ad-role-filter').innerHTML='<option value="">All roles</option>'+Object.entries(labels).map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  document.getElementById('ad-role').innerHTML=Object.entries(labels).map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  document.getElementById('ad-tabs').addEventListener('click',e=>{
    const b=e.target.closest('[data-tab]');
    if(!b||b.dataset.tab===adTab) return;
    adTab=b.dataset.tab;
    window.history.pushState(null,'','#'+(adTab==='users'?'pg-admin':`pg-admin/${adTab}`));
    loadAdmin();
  });
  // Users
  document.getElementById('ad-search').addEventListener('input',adRenderUsers);
  document.getElementById('ad-role-filter').addEventListener('change',adRenderUsers);
  document.getElementById('ad-filter').addEventListener('click',e=>{ const c=e.target.closest('[data-v]'); if(c){ adUserFilter=c.dataset.v; adRenderUsers(); } });
  document.getElementById('ad-stats').addEventListener('click',e=>{ const t=e.target.closest('[data-filter]'); if(t){ adUserFilter=t.dataset.filter; adRenderUsers(); } });
  document.getElementById('ad-new-btn').addEventListener('click',()=>adToggleCreate(true));
  document.getElementById('ad-cancel').addEventListener('click',()=>adToggleCreate(false));
  document.getElementById('ad-role').addEventListener('change',()=>adRenderNewPerms());
  document.getElementById('ad-form').addEventListener('submit',adCreate);
  document.getElementById('ad-rows').addEventListener('click',e=>{ const tr=e.target.closest('tr[data-user]'); if(tr) adOpenDrawer(tr.dataset.user); });
  // Drawer
  document.getElementById('ad-drawer').addEventListener('click',e=>{ if(e.target.id==='ad-drawer') adCloseDrawer(); });
  document.getElementById('ad-d-close').addEventListener('click',adCloseDrawer);
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&!document.getElementById('ad-drawer').hidden) adCloseDrawer(); });
  const body=document.getElementById('ad-d-body');
  body.addEventListener('change',e=>{
    const u=adUsers.find(x=>x.id===adOpenUserId);
    if(!u) return;
    if(e.target.matches('input[data-perm]')){
      const next=[...body.querySelectorAll('input[data-perm]')].filter(i=>i.checked).map(i=>i.dataset.perm);
      adPatch(u.id,{permissions:next},`Permissions updated for ${u.name}`);
    }else if(e.target.id==='ad-d-role'){
      const role=e.target.value;
      if(!confirm(`Change ${u.name} to ${adRoleLabels()[role]}? Their permissions will reset to that role's defaults.`)){ e.target.value=u.role; return; }
      adPatch(u.id,{role},`${u.name} is now ${adRoleLabels()[role]}`);
    }
  });
  body.addEventListener('click',e=>{
    const b=e.target.closest('[data-act]');
    const u=b&&adUsers.find(x=>x.id===adOpenUserId);
    if(!u) return;
    const act=b.dataset.act;
    if(act==='defaults') adPatch(u.id,{permissions:null},`${u.name} is back on ${adRoleLabels()[u.role]} defaults`);
    else if(act==='status'){
      if(u.status==='active'&&!confirm(`Suspend ${u.name}? They are signed out and cannot sign in until reactivated.`)) return;
      adPatch(u.id,{status:u.status==='active'?'suspended':'active'},u.status==='active'?`${u.name} suspended`:`${u.name} reactivated`);
    }
    else if(act==='reset') adResetPassword(u);
    else if(act==='unlock') adPost(`/api/admin/users/${encodeURIComponent(u.id)}/unlock`,`${u.name} unlocked`);
    else if(act==='signout'){ if(confirm(`Sign ${u.name} out on every device?`)) adPost(`/api/admin/users/${encodeURIComponent(u.id)}/signout`,`${u.name} signed out everywhere`); }
    else if(act==='delete') adDelete(u);
    else if(act==='profile'){ adCloseDrawer(); openAuditorProfile(u.id); }
  });
  // Buildings
  document.getElementById('ad-b-search').addEventListener('input',adRenderBuildings);
  document.getElementById('ad-b-division').addEventListener('change',adRenderBuildings);
  document.getElementById('ad-b-new').addEventListener('click',()=>adOpenBuilding(null));
  document.getElementById('ad-b-rows').addEventListener('click',e=>{
    const b=e.target.closest('[data-b-act]');
    const row=b&&adBuildings.find(x=>x.id===Number(b.dataset.id));
    if(!row) return;
    if(b.dataset.bAct==='edit') adOpenBuilding(row); else adDeleteBuilding(row);
  });
  document.getElementById('mb-form').addEventListener('submit',adSaveBuilding);
  document.getElementById('modal-building').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeModal('modal-building'); });
  // Audit
  document.getElementById('ad-a-filter').addEventListener('click',e=>{ const c=e.target.closest('[data-v]'); if(c){ adAuditFilter=c.dataset.v; adRenderAudit(); } });
  document.getElementById('ad-a-search').addEventListener('input',adRenderAudit);
  document.getElementById('ad-a-more').addEventListener('click',()=>adLoadAudit({more:true}));
  document.getElementById('ad-bk-run').addEventListener('click',adRunBackup);
  document.getElementById('ad-backup').addEventListener('click',e=>{ const b=e.target.closest('[data-download]'); if(b) adDownloadBackup(b.dataset.download); });
  document.getElementById('ad-arch-rows').addEventListener('click',e=>{ const b=e.target.closest('[data-restore]'); if(b) adRestore(Number(b.dataset.restore),b); });
}

// ── Backup & archive ──
function adBytes(n){ return n>=1e9?(n/1e9).toFixed(1)+' GB':n>=1e6?(n/1e6).toFixed(1)+' MB':n>=1e3?Math.round(n/1e3)+' KB':(n||0)+' B'; }
async function adLoadBackup(){
  try{
    const [st,ar]=await Promise.all([adRequest('/api/admin/backup',{cache:'no-store'},'Could not read the backup status.'),adRequest('/api/admin/archive',{cache:'no-store'},'Could not read the archive.')]);
    const c=st.counts||{}, last=st.last, ok=st.lastOk;
    const tile=(icon,value,label,note)=>`<div class="hs-card"><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div><b>${value}</b><span>${label}</span>${note?`<small style="display:block;color:var(--muted);font-size:.72rem;margin-top:4px">${note}</small>`:''}</div>`;
    document.getElementById('ad-bk-stats').innerHTML=
      tile('file-text',c.reports??0,'Reports',`${c.archived??0} in the archive`)+
      tile('history',c.versions??0,'Saved versions','every change kept')+
      tile('image',c.photos??0,'Photos',adBytes(c.photoBytes))+
      tile('scroll-text',c.auditRows??0,'Audit entries','who did what, and when');
    const when=t=>new Date(t).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
    const cu=st.catchup, age=ok?(Date.now()-Date.parse(ok.finishedAt))/3600000:null;
    const recent=cu&&cu.ok&&(Date.now()-Date.parse(cu.finishedAt))<40*60000;     // a 10-minute run in the last 40 minutes
    const fresh=ok&&age<=30;
    const waiting=[c.versionsWaiting?`${c.versionsWaiting} version${c.versionsWaiting===1?'':'s'}`:'',c.photosWaiting?`${c.photosWaiting} photo${c.photosWaiting===1?'':'s'}`:''].filter(Boolean).join(' and ');
    const photoNote=st.storage.photos?'Photos are kept in photo storage (Cloudflare R2) and copied to the backup.'
      :`Photos are kept in the database (${adBytes(c.photoBytesInDb)} so far) and copied to the backup. To keep years of photos, switch on Cloudflare R2 photo storage for this account.`;
    const box=document.getElementById('ad-bk-status');
    box.innerHTML=!st.storage.backups
      ?`<div class="sc-callout warn"><svg data-lucide="triangle-alert" width="17" height="17"></svg><div><b>Backup storage is not connected.</b> The data is safe in the database; the automatic copies start once the storage is linked.</div></div>`
      :(ok||recent)?`<div class="sc-callout ${fresh||recent?'ok':'warn'}"><svg data-lucide="${fresh||recent?'circle-check':'triangle-alert'}" width="17" height="17"></svg><div>
          <b>${fresh||recent?'Backed up automatically':'The last nightly copy is more than a day old'}</b>
          ${recent?` — last copy ${timeAgo(cu.finishedAt.replace('T',' ').slice(0,19))}`:''}${ok?`${recent?'; ':' — '}last nightly copy ${when(ok.finishedAt)}`:''}.
          ${waiting?` ${waiting} still to copy — the next runs carry on.`:' Everything is copied.'}
          <br><small>${photoNote}</small></div></div>`
      :`<div class="sc-callout warn"><svg data-lucide="clock" width="17" height="17"></svg><div><b>The first automatic copy has not run yet.</b> It starts within 10 minutes of the update; you can also press “Back up now”.</div></div>`;
    // reports saved before history began are brought in by the automatic runs, a few at a time
    const older=Math.max(c.legacyReports||0,c.withoutHistory||0);
    if(older) box.innerHTML+=`<div class="sc-callout info" style="margin-top:8px"><svg data-lucide="history" width="17" height="17"></svg><div><b>${older} report${older===1?' was':'s were'} saved before history began.</b> They are safe in the database and are being added to the history and the backup automatically — a few every 10 minutes. Nothing to do.</div></div>`;
    const failed=[last,cu].find(x=>x&&!x.ok&&x.error);
    if(failed) box.innerHTML+=`<div class="sc-callout warn" style="margin-top:8px"><svg data-lucide="circle-x" width="17" height="17"></svg><div><b>The last ${failed===cu?'automatic':'nightly'} run failed</b> (${ovEsc(failed.finishedAt||'')}): ${ovEsc(failed.error||'unknown error')}. The next run tries again.</div></div>`;
    const rows=ar.reports||[];
    document.getElementById('ad-arch-note').textContent=`${rows.length} report${rows.length===1?'':'s'}`;
    document.getElementById('ad-arch-rows').innerHTML=rows.length?rows.map(x=>`<tr>
      <td><b>${ovEsc(x.building)}</b><small>${ovEsc(x.division||'')}</small></td>
      <td>${ovEsc(x.type||'—')}<small>${ovEsc(x.date||'')}</small></td>
      <td>${ovEsc(x.auditor||'—')}</td><td>${ovScore(x.overall)}</td>
      <td>${ovEsc(x.deletedBy||'—')}<small>${x.deletedAt?new Date(x.deletedAt.replace(' ','T')+'Z').toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):''}</small></td>
      <td><button class="ad-btn" data-restore="${x.id}"><svg data-lucide="rotate-ccw" width="13" height="13" style="vertical-align:-2px"></svg> Restore</button></td></tr>`).join('')
      :'<tr><td colspan="6" class="ov-empty">No deleted reports. Anything deleted appears here and can be restored.</td></tr>';
    lucide.createIcons({nodes:[document.getElementById('ad-backup')]});
  }catch(err){ showToast(err.message,true); }
}
async function adRunBackup(){
  const b=document.getElementById('ad-bk-run'); b.disabled=true;
  try{ const r=await adRequest('/api/admin/backup/run',{method:'POST'},'The backup did not finish.'); showToast(`Backed up in ${r.seconds}s`); }
  catch(err){ showToast(err.message,true); }
  finally{ b.disabled=false; adLoadBackup(); }
}
async function adRestore(id,btn){
  if(!confirm('Put this report back where it was? It returns with all its versions, reviews and photos.')) return;
  btn.disabled=true;
  try{ await adRequest(`/api/admin/archive/${id}/restore`,{method:'POST'},'Could not restore the report.'); showToast('Report restored'); rpData=null; }
  catch(err){ showToast(err.message,true); }
  adLoadBackup();
}
/** A copy on this device, as SQL that loads straight back into a database made from the same
 *  migrations (npx wrangler d1 execute <db> --file <file>): the data, or the photos, each its own file. */
async function adDownloadBackup(kind){
  const photos=kind==='photos';
  const btns=[...document.querySelectorAll('[data-download]')], box=document.getElementById('ad-bk-progress'), bar=document.getElementById('ad-bk-bar'), note=document.getElementById('ad-bk-note');
  const tables=photos?['photo_blobs']:['buildings','qa_users','assignments','inspections','inspection_versions','inspection_archive','inspection_reviews','notifications','saved_reports','audit_log','system_state'];
  const q=v=>v==null?'NULL':typeof v==='number'?String(v):`'${String(v).replace(/'/g,"''")}'`;
  const parts=[`-- Facility Experience QA — ${photos?'photos':'data'}, ${new Date().toISOString()}\n-- Load into a database built from the same migrations${photos?' (the data file too, in either order)':''}:\n--   npx wrangler d1 execute <database> --remote --file <this file>\nPRAGMA defer_foreign_keys = ON;\n`];
  btns.forEach(b=>b.disabled=true); box.hidden=false; bar.style.width='0%';
  try{
    for(let t=0;t<tables.length;t++){
      const table=tables[t]; let after='', done=0, total=null, first=true;
      parts.push(`\n-- ${table}\n`);
      for(;;){
        const d=await adRequest(`/api/admin/export?table=${table}&after=${encodeURIComponent(after)}${t===0&&first?`&start=1&kind=${photos?'photos':'data'}`:''}`,{cache:'no-store'},`Could not read ${table}.`);
        first=false; total=d.total;
        for(const row of d.rows){ const cols=Object.keys(row); parts.push(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(k=>q(row[k])).join(', ')});\n`); }
        done+=d.rows.length;
        note.textContent=photos?`Photos: ${done} of ${total}`:`${table}: ${done} of ${total}`;
        bar.style.width=Math.round(((t+(total?done/total:1))/tables.length)*100)+'%';
        if(d.next==null) break;
        after=d.next;
      }
    }
    const blob=new Blob(parts,{type:'application/sql'}), name=`facility-qa-${photos?'photos':'data'}-${new Date().toISOString().slice(0,10)}.sql`;
    bar.style.width='100%';
    // Building the file takes a while, and browsers drop a download that no longer follows a tap:
    // the file is saved from its own button.
    note.innerHTML=`Ready — ${adBytes(blob.size)}. <button class="ad-btn" type="button" id="ad-bk-save"><svg data-lucide="download" width="13" height="13" style="vertical-align:-2px"></svg> Save the file</button>`;
    lucide.createIcons({nodes:[note]});
    document.getElementById('ad-bk-save').onclick=()=>exDownload(name,blob);
  }catch(err){ note.textContent=err.message; showToast(err.message,true); }
  finally{ btns.forEach(b=>b.disabled=false); }
}

async function loadAdmin(){
  initAdmin();
  document.querySelectorAll('#ad-tabs [data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===adTab));
  ['users','buildings','audit','backup'].forEach(t=>{ document.getElementById('ad-'+t).hidden=t!==adTab; });
  updateTopBar('pg-admin');
  if(adTab==='backup') return adLoadBackup();
  if(adTab==='buildings') return adLoadBuildings();
  if(adTab==='audit') return adLoadAudit();
  return adLoadUsers();
}
async function adRequest(url,options,fallback){
  const res=await fetch(url,options);
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||fallback);
  return data;
}

// ── Users & Permissions ──
async function adLoadUsers(){
  try{
    const data=await adRequest('/api/admin/users',{},'Could not load accounts.');
    adUsers=data.users||[]; adRoleDefaults=data.roleDefaults||{};
    adRenderUsers();
    if(adOpenUserId) adRenderDrawer();
  }catch(err){
    document.getElementById('ad-rows').innerHTML=`<tr><td colspan="6" class="ov-empty">${ovEsc(err.message)}</td></tr>`;
  }
}
function adStatusOf(u){
  if(u.status!=='active') return ['suspended','Suspended'];
  if(u.lockedUntil) return ['suspended','Locked'];
  if(u.mustChangePassword) return ['setup','Pending setup'];
  return ['active','Active'];
}
const adNeedsAttention=u=>u.status!=='active'||!!u.lockedUntil||u.mustChangePassword;
function adRenderUsers(){
  const labels=adRoleLabels(), me=currentUser?.id;
  const admins=adUsers.filter(u=>u.role==='quality_admin'&&u.status==='active').length;
  const online=adUsers.filter(u=>u.activeSessions>0).length, attention=adUsers.filter(adNeedsAttention).length;
  const roleMix=Object.entries(labels).map(([r,l])=>[l,adUsers.filter(u=>u.role===r).length]).filter(([,n])=>n).map(([l,n])=>`${n} ${l.replace('Quality ','')}`).join(' · ');
  const tile=(icon,value,label,note,filter)=>`<div class="hs-card${filter?' clickable':''}"${filter?` data-filter="${filter}"`:''}><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div><b>${value}</b><span>${label}</span><small style="display:block;color:var(--muted);font-size:.7rem;margin-top:4px">${note}</small></div>`;
  document.getElementById('ad-stats').innerHTML=
    tile('users',adUsers.length,'Accounts',roleMix||'No accounts yet','all')+
    tile('radio',online,'Signed in now','Accounts with an active session','online')+
    tile('bell-ring',attention,'Needs attention','Suspended, locked or pending setup','attention')+
    tile('shield-check',admins,'Active admins',admins<2?'Consider a second admin as backup':'Backup access in place');
  document.getElementById('ad-single-admin').hidden=admins>=2;

  const counts={all:adUsers.length,attention,online,custom:adUsers.filter(u=>u.customPermissions).length};
  const chipLabels={all:'All',attention:'Needs attention',online:'Signed in',custom:'Custom permissions'};
  document.getElementById('ad-filter').innerHTML=Object.keys(chipLabels).map(k=>`<button class="rp-chip${adUserFilter===k?' active':''}" data-v="${k}">${chipLabels[k]} ${counts[k]}</button>`).join('');

  const term=document.getElementById('ad-search').value.trim().toLowerCase(), role=document.getElementById('ad-role-filter').value;
  const list=adUsers.filter(u=>
    (adUserFilter==='all'||(adUserFilter==='attention'?adNeedsAttention(u):adUserFilter==='online'?u.activeSessions>0:u.customPermissions)) &&
    (!role||u.role===role) && (!term||u.name.toLowerCase().includes(term)||u.username.toLowerCase().includes(term)));
  const total=adPermCatalog().reduce((n,[,items])=>n+items.length,0);
  document.getElementById('ad-rows').innerHTML=list.length?list.map(u=>{
    const [cls,label]=adStatusOf(u);
    return `<tr class="clickable" data-user="${ovEsc(u.id)}" title="Manage ${ovEsc(u.name)}">
      <td><div class="ad-who"><i>${ovEsc(ofInitials(u.name))}</i><div><b>${ovEsc(u.name)}</b><small>@${ovEsc(u.username)}${u.id===me?' · you':''}</small></div></div></td>
      <td>${labels[u.role]||ovEsc(u.role)}</td>
      <td><span class="ov-pill ${cls}">${label}</span></td>
      <td>${u.role==='quality_admin'?'<span class="ad-pcount all">All</span>':`<span class="ad-pcount">${u.permissions.length}/${total}</span>${u.customPermissions?'<span class="ad-custom">Custom</span>':''}`}</td>
      <td>${u.activeSessions?'<span class="ad-online">Online</span>':''}${u.lastLoginAt?`<small style="display:inline">${timeAgo(u.lastLoginAt)}</small>`:'<small style="display:inline">Never</small>'}</td>
      <td style="text-align:right"><svg data-lucide="chevron-right" width="16" height="16" style="color:var(--muted)"></svg></td>
    </tr>`;
  }).join(''):'<tr><td colspan="6" class="ov-empty">No accounts match.</td></tr>';
  lucide.createIcons();
}

function adPermMatrix(selected,{locked=false,defaults=[],prefix=''}={}){
  return adPermCatalog().map(([group,items])=>`<div class="ad-pgroup"><span>${group}</span>${items.map(([k,l,d])=>`
    <label class="ad-switch">
      <input type="checkbox" data-perm="${k}"${prefix?` data-new="1"`:''}${selected.includes(k)?' checked':''}${locked?' disabled':''}>
      <div><b>${l}${defaults.includes(k)?' <em>Role default</em>':''}</b><small>${d}</small></div>
    </label>`).join('')}</div>`).join('')+
    `<div class="ad-pgroup"><span>Administration</span><div class="ad-locked"><svg data-lucide="lock" width="13" height="13"></svg> Managing users, buildings and the audit log stays with the Quality Admin role.</div></div>`;
}
function adToggleCreate(open){
  document.getElementById('ad-create').hidden=!open;
  document.getElementById('ad-new-btn').hidden=open;
  if(open){
    document.getElementById('ad-form').reset();
    document.getElementById('ad-msg').hidden=true;
    adRenderNewPerms();
    const pw=document.getElementById('ad-password'); pw.value=makeTempPassword(); pw.dispatchEvent(new Event('input'));
    document.getElementById('ad-name').focus();
  }
}
function adRenderNewPerms(){
  const role=document.getElementById('ad-role').value, defaults=(adRoleDefaults||{})[role]||[];
  document.getElementById('ad-new-perms').innerHTML=adPermMatrix(defaults,{locked:role==='quality_admin',defaults,prefix:'new'});
  lucide.createIcons();
}
async function adCreate(e){
  e.preventDefault();
  const submit=document.getElementById('ad-submit'), msg=document.getElementById('ad-msg');
  msg.hidden=true;
  const weak=pwProblem(document.getElementById('ad-password').value);
  if(weak){ msg.textContent='Temporary password: '+weak; msg.className='ad-msg err'; msg.hidden=false; return; }
  submit.disabled=true;
  try{
    const name=document.getElementById('ad-name').value.trim();
    await adRequest('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      name, username:document.getElementById('ad-username').value.trim(),
      password:document.getElementById('ad-password').value, role:document.getElementById('ad-role').value,
      permissions:[...document.querySelectorAll('#ad-new-perms input[data-perm]')].filter(i=>i.checked).map(i=>i.dataset.perm),
    })},'Could not create the account.');
    adToggleCreate(false);
    showToast(`Account created for ${name} — share the temporary password with them`);
    await adLoadUsers();
  }catch(err){
    msg.textContent=err.message; msg.className='ad-msg err'; msg.hidden=false;
  }finally{ submit.disabled=false; }
}

function adOpenDrawer(id){
  adOpenUserId=id;
  document.getElementById('ad-drawer').hidden=false;
  adRenderDrawer();
}
function adCloseDrawer(){ adOpenUserId=null; document.getElementById('ad-drawer').hidden=true; }
async function adRenderDrawer(){
  const u=adUsers.find(x=>x.id===adOpenUserId);
  if(!u){ adCloseDrawer(); return; }
  const labels=adRoleLabels(), self=u.id===currentUser?.id, isAdmin=u.role==='quality_admin';
  const [cls,label]=adStatusOf(u), defaults=(adRoleDefaults||{})[u.role]||[];
  document.getElementById('ad-d-avatar').textContent=ofInitials(u.name);
  document.getElementById('ad-d-name').textContent=u.name;
  document.getElementById('ad-d-user').textContent=`@${u.username} · joined ${u.createdAt?new Date(u.createdAt.replace(' ','T')+'Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'—'}`;
  const row=(k,v,action='')=>`<div class="ad-kv"><span>${k}</span><div>${v}</div>${action}</div>`;
  const btn=(act,text,danger)=>`<button class="ad-btn${danger?' danger':''}" data-act="${act}">${text}</button>`;
  document.getElementById('ad-d-body').innerHTML=`
    <section><h4>Account</h4>
      ${row('Role',self?`<b>${labels[u.role]}</b>`:`<select class="ad-role" id="ad-d-role">${Object.entries(labels).map(([v,l])=>`<option value="${v}"${v===u.role?' selected':''}>${l}</option>`).join('')}</select>`)}
      ${row('Status',`<span class="ov-pill ${cls}">${label}</span>`,self?'':btn('status',u.status==='active'?'Suspend':'Reactivate',u.status==='active'))}
      ${u.role==='quality_auditor'?row('Work','Assignments, schedule and quality of work',btn('profile','Open auditor profile')):''}
    </section>
    <section><h4>Permissions ${u.customPermissions?'<span class="ad-custom">Custom</span>':''}</h4>
      ${isAdmin?'<p class="ad-note">Quality Admins always have every permission.</p>':self?'<p class="ad-note">You cannot change your own permissions.</p>':
        u.customPermissions?`<p class="ad-note">Tailored for this person. ${btn('defaults',`Reset to ${labels[u.role]} defaults`)}</p>`:`<p class="ad-note">Using the ${labels[u.role]} defaults — switch anything on or off to tailor it.</p>`}
      <div class="ad-matrix">${adPermMatrix(u.permissions,{locked:isAdmin||self,defaults})}</div>
    </section>
    <section><h4>Sign-in &amp; security</h4>
      ${row('Last sign-in',u.lastLoginAt?`${timeAgo(u.lastLoginAt)} <small>${new Date(u.lastLoginAt.replace(' ','T')+'Z').toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</small>`:'Never')}
      ${row('Active sessions',u.activeSessions?`<span class="ad-online">${u.activeSessions} active</span>${u.sessionDevices?.length?`<small style="display:block">${ovEsc(u.sessionDevices.join(' · '))}</small>`:''}`:'None',u.activeSessions&&!self?btn('signout','Sign out everywhere'):'')}
      ${row('Failed sign-ins',u.lockedUntil?`<span class="ov-pill suspended">Locked</span> until ${new Date(u.lockedUntil).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`:`${u.failedAttempts} since last success`,u.lockedUntil||u.failedAttempts?btn('unlock','Unlock'):'')}
      ${row('Password',u.mustChangePassword?'Temporary — must be changed at next sign-in':'Set by the user',self?'':btn('reset','Reset password'))}
    </section>
    ${self?'':`<section class="ad-danger"><h4>Delete account</h4><p class="ad-note">Only possible for accounts with no assignments — otherwise suspend them so the history stays intact.</p>${btn('delete','Delete account',true)}</section>`}
    <section><h4>History</h4><ul class="ov-feed ad-log" id="ad-d-log"><li class="ov-empty" style="display:block">Loading…</li></ul></section>`;
  lucide.createIcons();
  try{
    const {entries}=await adRequest(`/api/admin/audit?target=${encodeURIComponent(u.id)}&limit=20`,{},'Could not load history.');
    const log=document.getElementById('ad-d-log');
    if(log&&adOpenUserId===u.id){ log.innerHTML=entries.length?entries.map(adLogItem).join(''):'<li class="ov-empty" style="display:block">No recorded changes yet.</li>'; lucide.createIcons(); }
  }catch{}
}
async function adPatch(id,body,done){
  try{
    await adRequest('/api/admin/users/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},'Could not update the account.');
    showToast(done);
  }catch(err){ showToast(err.message,true); }
  await adLoadUsers();
}
async function adPost(url,done){
  try{ await adRequest(url,{method:'POST'},'Could not complete that action.'); showToast(done); }
  catch(err){ showToast(err.message,true); }
  await adLoadUsers();
}
async function adResetPassword(u){
  const pw=prompt(`New temporary password for ${u.name}. A strong one is filled in — keep it or type your own (8+ characters, uppercase, lowercase and a symbol). They will be signed out and must choose their own:`,makeTempPassword());
  if(!pw) return;
  const weak=pwProblem(pw);
  if(weak){ showToast(weak,true); return; }
  try{
    await adRequest(`/api/admin/users/${encodeURIComponent(u.id)}/reset-password`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})},'Could not reset the password.');
    showToast(`Temporary password set for ${u.name}`);
  }catch(err){ showToast(err.message,true); }
  await adLoadUsers();
}
async function adDelete(u){
  if(!confirm(`Delete ${u.name}? This cannot be undone.`)) return;
  try{
    await adRequest('/api/admin/users/'+encodeURIComponent(u.id),{method:'DELETE'},'Could not delete the account.');
    showToast(`${u.name} deleted`); adCloseDrawer();
  }catch(err){ showToast(err.message,true); }
  await adLoadUsers();
}

// ── Buildings ──
async function adLoadBuildings(){
  try{
    const data=await adRequest('/api/buildings?usage=1',{},'Could not load buildings.');
    adBuildings=data.buildings||[];
    adRenderBuildings();
  }catch(err){
    document.getElementById('ad-b-rows').innerHTML=`<tr><td colspan="5" class="ov-empty">${ovEsc(err.message)}</td></tr>`;
  }
}
function adRenderBuildings(){
  const list=adBuildings||[];
  const uniq=key=>[...new Set(list.map(b=>b[key]).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const tile=(icon,value,label)=>`<div class="hs-card"><div class="hs-ic"><svg data-lucide="${icon}" width="19" height="19"></svg></div><b>${value}</b><span>${label}</span></div>`;
  document.getElementById('ad-b-stats').innerHTML=
    tile('building-2',list.length,'Buildings')+tile('network',uniq('division').length,'Divisions')+
    tile('map-pin',uniq('area').length,'Areas')+tile('circle-dashed',list.filter(b=>!b.assignments).length,'Never assigned');
  rpSelect('ad-b-division',uniq('division'),'All divisions');
  const div=document.getElementById('ad-b-division').value, term=document.getElementById('ad-b-search').value.trim().toLowerCase();
  const rows=list.filter(b=>(!div||b.division===div)&&(!term||[b.name,b.area,b.location].some(v=>(v||'').toLowerCase().includes(term))));
  document.getElementById('ad-b-count').textContent=`${rows.length} of ${list.length} buildings`;
  document.getElementById('ad-b-rows').innerHTML=rows.length?rows.map(b=>`<tr>
      <td><b>${ovEsc(b.name)}</b></td>
      <td>${ovEsc(b.division)}<small>${ovEsc(b.area)}</small></td>
      <td>${ovEsc(b.location)}</td>
      <td>${b.assignments||'<span style="color:var(--muted)">—</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="ad-btn" data-b-act="edit" data-id="${b.id}">Edit</button>
        <button class="ad-btn danger" data-b-act="delete" data-id="${b.id}"${b.assignments?' disabled title="Has assignments — cannot be deleted"':''}>Delete</button>
      </td></tr>`).join(''):'<tr><td colspan="5" class="ov-empty">No buildings match.</td></tr>';
  lucide.createIcons();
}
let adBuildingCombos=null;
function adOpenBuilding(b){
  adEditingBuilding=b;
  const list=adBuildings||[];
  if(!adBuildingCombos){
    // each list offers what is already in use; areas and locations follow the division typed above
    const uniq=(key,keep=()=>true)=>[...new Set((adBuildings||[]).filter(keep).map(x=>x[key]).filter(Boolean))]
      .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).map(v=>({value:v}));
    const inDiv=x=>{ const d=document.getElementById('mb-division').value.trim().toLowerCase(); return !d||String(x.division).toLowerCase()===d; };
    adBuildingCombos=[
      makeCombo(document.getElementById('mb-division'),{options:()=>uniq('division')}),
      makeCombo(document.getElementById('mb-area'),{options:()=>{ const o=uniq('area',inDiv); return o.length?o:uniq('area'); }}),
      makeCombo(document.getElementById('mb-location'),{options:()=>{ const o=uniq('location',inDiv); return o.length?o:uniq('location'); }}),
    ];
  }
  document.getElementById('mb-title').textContent=b?'Edit building':'Add building';
  document.getElementById('mb-sub').textContent=b
    ?'Renaming a building also changes how older, unassigned inspections are matched to it in Reports.'
    :'New buildings can be assigned right away in Assign & Track.';
  ['name','division','area','location'].forEach(k=>{ document.getElementById('mb-'+k).value=b?b[k]:''; });
  document.getElementById('mb-msg').style.display='none';
  adBuildingCombos.forEach(c=>c.close());
  document.getElementById('modal-building').classList.add('open');
  document.getElementById('mb-name').focus();
}
async function adSaveBuilding(e){
  e.preventDefault();
  const body=Object.fromEntries(['name','division','area','location'].map(k=>[k,document.getElementById('mb-'+k).value.trim()]));
  const msg=document.getElementById('mb-msg');
  try{
    const b=adEditingBuilding;
    await adRequest(b?`/api/buildings/${b.id}`:'/api/buildings',{method:b?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},'Could not save the building.');
    closeModal('modal-building');
    showToast(b?`${body.name} updated`:`${body.name} added`);
    ofData=null; rpData=null;   // lists elsewhere reload with the change
    await adLoadBuildings();
  }catch(err){ msg.textContent=err.message; msg.style.display='block'; }
}
async function adDeleteBuilding(b){
  if(!confirm(`Delete ${b.name}? This cannot be undone.`)) return;
  try{
    await adRequest(`/api/buildings/${b.id}`,{method:'DELETE'},'Could not delete the building.');
    showToast(`${b.name} deleted`); ofData=null; rpData=null;
  }catch(err){ showToast(err.message,true); }
  await adLoadBuildings();
}

// ── Audit log ──
function adActionMeta(action){
  return ({
    'user.create':['user-plus','created the account for','accounts'],
    'user.update':['pencil','updated','accounts'],
    'user.status':['user-x','changed the status of','accounts'],
    'user.delete':['trash-2','deleted the account for','accounts'],
    'user.role':['user-cog','changed the role of','permissions'],
    'user.permissions':['key-round','changed permissions for','permissions'],
    'user.password_reset':['key-round','reset the password for','security'],
    'user.password_change':['key-round','changed the password of','security'],
    'user.password_set':['key-round','replaced the temporary password of','security'],
    'user.settings':['settings','changed the settings of','accounts'],
    'security.lockout':['lock','locked after failed sign-ins:','security'],
    'security.unlock':['lock-open','unlocked','security'],
    'security.signout':['log-out','signed out','security'],
    'security.throttle':['shield-alert','slowed down requests from','security'],
    'auth.login':['log-in','signed in:','signins'],
    'auth.failed':['shield-x','refused a wrong password for','signins'],
    'auth.blocked':['user-x','refused a sign-in to the suspended account','signins'],
    'push.on':['bell-ring','turned on phone notifications:','accounts'],
    'building.create':['building-2','added building','buildings'],
    'building.update':['building-2','edited building','buildings'],
    'building.delete':['trash-2','deleted building','buildings'],
    'inspection.create':['file-plus','submitted inspection','inspections'],
    'inspection.update':['file-pen','edited inspection','inspections'],
    'inspection.review':['file-check','reviewed inspection','inspections'],
    'inspection.delete':['file-x','deleted inspection','inspections'],
    'inspection.restore':['archive-restore','restored inspection','inspections'],
    'assignment.repeat':['repeat','repeated assignments for','inspections'],
    'assignment.due':['calendar-clock','changed the deadline for','inspections'],
    'backup.run':['database-backup','ran a backup:','security'],
    'backup.download':['download','downloaded a copy of the data:','security'],
  })[action]||['activity',action,'other'];
}
function adLogItem(e){
  const [icon,verb,cat]=adActionMeta(e.action);
  const color={accounts:'var(--royal)',permissions:'var(--teal)',security:'var(--warn)',signins:'var(--teal-deep)',buildings:'#5b6f8a',inspections:'var(--danger)'}[cat]||'var(--muted)';
  const at=new Date(e.at.replace(' ','T')+'Z');
  return `<li><span class="dot" style="background:${color}"><svg data-lucide="${icon}" width="14" height="14"></svg></span>
    <div><b>${ovEsc(e.actor||'System')}</b> ${verb} <b>${ovEsc(e.target||'')}</b>${e.details?`<div class="ad-log-details">${ovEsc(e.details)}</div>`:''}
    <small title="${at.toLocaleString('en-GB')}">${timeAgo(e.at)} · ${at.toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</small></div></li>`;
}
async function adLoadAudit({more=false}={}){
  try{
    const before=more&&adAudit.length?`&before=${adAudit[adAudit.length-1].id}`:'';
    const data=await adRequest(`/api/admin/audit?limit=100${before}`,{},'Could not load the audit log.');
    adAudit=more?adAudit.concat(data.entries):data.entries;
    adAuditMore=data.more;
    adRenderAudit();
  }catch(err){
    document.getElementById('ad-a-list').innerHTML=`<li class="ov-empty" style="display:block">${ovEsc(err.message)}</li>`;
  }
}
function adRenderAudit(){
  const cats={all:'All',signins:'Sign-ins',accounts:'Accounts',permissions:'Permissions',security:'Security',buildings:'Buildings',inspections:'Inspections'};
  const catOf=e=>adActionMeta(e.action)[2];
  document.getElementById('ad-a-filter').innerHTML=Object.entries(cats).map(([k,l])=>{
    const n=k==='all'?adAudit.length:adAudit.filter(e=>catOf(e)===k).length;
    return `<button class="rp-chip${adAuditFilter===k?' active':''}" data-v="${k}">${l} ${n}</button>`;
  }).join('');
  const term=document.getElementById('ad-a-search').value.trim().toLowerCase();
  const rows=adAudit.filter(e=>(adAuditFilter==='all'||catOf(e)===adAuditFilter)&&(!term||[e.actor,e.target,e.details].some(v=>(v||'').toLowerCase().includes(term))));
  document.getElementById('ad-a-list').innerHTML=rows.length?rows.map(adLogItem).join(''):'<li class="ov-empty" style="display:block">No entries match.</li>';
  document.getElementById('ad-a-more').hidden=!adAuditMore;
  lucide.createIcons();
}

// ── Account: show signed-in user, apply permissions, wire logout ──
(async()=>{
  try{
    const res=await fetch('/api/auth/me');
    if(!res.ok){ window.location.href='/login.html'; return; }
    const {user}=await res.json();
    currentUser=user;
    applyTheme(user.theme||'auto');                         // the account's choice, on every device
    pushInit();                                            // needs to know whether notifications are on
    const displayName=user.name||user.username;
    document.getElementById('acct-name').textContent=displayName;
    document.getElementById('acct-avatar').textContent=displayName.split(/\s+/).filter(Boolean).map(p=>p[0]).slice(0,2).join('').toUpperCase();
    document.getElementById('acct-role').textContent=({
      quality_admin:'Quality Admin',quality_leader:'Quality Leader',quality_officer:'Quality Officer',
      quality_auditor:'Quality Auditor',data_analyst:'Data Analyst',
    })[user.role]||user.role;
    const isAdmin=user.role==='quality_admin';
    const isOfficer=user.role==='quality_officer';
    document.getElementById('home-name').textContent=displayName.split(/\s+/)[0];
    if(isAdmin) document.getElementById('admin-link').hidden=false;
    document.getElementById('reports-link').hidden=!hasPerm('reports');
    if(ASSIGNEE_ROLES.includes(user.role)&&hasPerm('inspect')){ document.getElementById('my-assignments-link').hidden=false; if(!document.getElementById('pg-auditor').classList.contains('active')) loadAuditorProfile({quiet:true}); }
    if(hasPerm('inspect')) document.getElementById('inspection-link').hidden=false;
    // Team: Assign & Track and/or Overview, as the account's permissions allow (tabs when both).
    const teamPages=[...(hasPerm('assign')?['pg-officer']:[]),...(hasPerm('team')?['pg-overview']:[])];
    if(teamPages.length){
      const teamLink=document.getElementById('team-link');
      teamLink.hidden=false;
      teamLink.dataset.page=teamPages[0];                            // the first tab is where Team opens
      renderTeamTabs(teamPages);
    }
    renderHomeActions(user,teamPages);
    if(!user.canExport){ document.querySelectorAll('.rp-export').forEach(b=>b.remove()); document.body.classList.add('no-export'); }
    if(!user.canEdit) document.getElementById('start-insp-btn')?.remove();
    document.body.classList.toggle('no-delete',!user.canDelete);
    document.body.classList.toggle('view-only',!user.canEdit);
    if(window.__cdnMissing&&window.__cdnMissing.length&&!window.__cdnSaid){ window.__cdnSaid=true; showToast(`Some ${window.__cdnMissing.join(' and ')} could not load — check your connection and reload the page.`,true); }
    refreshNav();
    useAccountInspector();
    refreshReviewBadge();
    // Views drawn before the account loaded can now label "you" and apply permissions.
    if(ofData) renderOfficer();
    if(auData) renderAuditorProfile();
    if(rvData) renderReportPanel();   // a report opened straight from a link can now say "you", and show the buttons this account has
    // Permissions arrive after the initial hash routing, so re-check where we landed.
    const landed=hashToPage(location.hash);
    if(!pageAllowed(landed)) nav('pg-home');
    else if(user.role==='quality_leader'&&hasPerm('team')&&!location.hash) nav('pg-overview');
    else if(user.role==='data_analyst'&&hasPerm('reports')&&!location.hash) nav('pg-reports');
    else if(isOfficer&&hasPerm('assign')&&!location.hash) nav('pg-officer');
    else { highlightNav(document.querySelector('.page.active')?.id||landed); updateTopBar(document.querySelector('.page.active')?.id||landed); }
  }catch{
    document.getElementById('acct-name').textContent='';
  }
})();
document.getElementById('acct-logout').addEventListener('click',async()=>{
  try{ await fetch('/api/auth/logout',{method:'POST'}); }finally{ window.location.href='/'; }
});

// ── Appearance: Automatic (the device decides), Light or Dark ──
function applyTheme(t){
  const r=document.documentElement;
  if(t==='light'||t==='dark') r.dataset.theme=t; else delete r.dataset.theme;
  try{ localStorage.setItem('qa-theme',t==='light'||t==='dark'?t:'auto'); }catch{}
  // the phone's status bar: fixed when chosen, following the device when Automatic
  document.querySelectorAll('meta[name=theme-color]').forEach(m=>{
    const light=m.media.includes('light');
    m.content=t==='dark'?'#0B1320':t==='light'?'#0033A0':(light?'#0033A0':'#0B1320');
  });
  refreshThemeColours();
}
function refreshThemeColours(){
  chartDefaults();
  if(window.Chart&&Chart.instances) Object.values(Chart.instances).forEach(c=>{ try{ c.update('none'); }catch{} });
}
// the device switching between light and dark (sunset, Control Centre) while OSQA is open
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{ if(!document.documentElement.dataset.theme) refreshThemeColours(); });

// ── Account: settings (each person's own) ──
function openSettings(){
  const u=currentUser||{};
  document.getElementById('st-who').textContent=[u.name,u.username?'@'+u.username:''].filter(Boolean).join(' · ');
  stRender();
  document.getElementById('modal-settings').classList.add('open');
  document.getElementById('st-notif').focus();
}
function stRender(){
  const on=currentUser?.notificationsEnabled!==false;
  document.getElementById('st-notif').setAttribute('aria-checked',on?'true':'false');
  const t=currentUser?.theme||'auto';
  document.querySelectorAll('#st-theme [data-theme-choice]').forEach(b=>b.setAttribute('aria-checked',b.dataset.themeChoice===t?'true':'false'));
}
document.getElementById('st-theme').addEventListener('click',async e=>{
  const b=e.target.closest('[data-theme-choice]'); if(!b||!currentUser) return;
  const want=b.dataset.themeChoice, was=currentUser.theme||'auto';
  if(want===was) return;
  currentUser.theme=want; applyTheme(want); stRender();                    // show it at once
  const btns=[...document.querySelectorAll('#st-theme button')]; btns.forEach(x=>x.disabled=true);
  try{
    const res=await fetch('/api/account/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme:want})});
    const d=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(d.error||'Could not save the appearance.');
  }catch(err){ currentUser.theme=was; applyTheme(was); stRender(); showToast(err.message,true); }
  finally{ btns.forEach(x=>x.disabled=false); }
});
// arrow keys move between the three choices, as in any radio group
document.getElementById('st-theme').addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return;
  const btns=[...document.querySelectorAll('#st-theme button')], i=btns.indexOf(document.activeElement);
  if(i<0) return; e.preventDefault();
  const n=btns[(i+(e.key==='ArrowRight'||e.key==='ArrowDown'?1:btns.length-1))%btns.length]; n.focus(); n.click();
});
document.getElementById('acct-settings').addEventListener('click',openSettings);
document.getElementById('acct-avatar').addEventListener('click',openSettings);
document.getElementById('acct-avatar').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openSettings(); } });
document.getElementById('modal-settings').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeModal('modal-settings'); });
document.getElementById('st-pw').addEventListener('click',()=>{ closeModal('modal-settings'); openChangePassword(); });
document.getElementById('st-notif').addEventListener('click',async e=>{
  const sw=e.currentTarget, want=sw.getAttribute('aria-checked')!=='true';
  sw.disabled=true;
  try{
    const res=await fetch('/api/account/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({notifications:want})});
    const d=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(d.error||'Could not save the setting.');
    if(currentUser) currentUser.notificationsEnabled=d.notifications;
    stRender(); pushInit();
    showToast(d.notifications?'Notifications are on':'Notifications are off — security alerts about your account still come through');
  }catch(err){ showToast(err.message,true); }
  finally{ sw.disabled=false; }
});

// ── Account: change password ──
function openChangePassword(){
  document.getElementById('pw-current').value='';
  document.getElementById('pw-new').value='';
  document.getElementById('pw-confirm').value='';
  document.getElementById('pw-msg').style.display='none';
  document.getElementById('modal-change-pw').classList.add('open');
}
document.getElementById('modal-change-pw').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal('modal-change-pw');});
/* The password rule, the same one the server enforces: 8+ characters, an uppercase letter,
   a lowercase letter and a symbol. */
const PW_RULES={len:p=>p.length>=8,upper:p=>/[A-Z]/.test(p),lower:p=>/[a-z]/.test(p),symbol:p=>/[^A-Za-z0-9]/.test(p)};
function pwProblem(p){
  const miss=[]; if(!PW_RULES.len(p)) miss.push('at least 8 characters'); if(!PW_RULES.upper(p)) miss.push('an uppercase letter');
  if(!PW_RULES.lower(p)) miss.push('a lowercase letter'); if(!PW_RULES.symbol(p)) miss.push('a symbol');
  return miss.length?`Password needs ${miss.join(', ')}.`:null;
}
function makeTempPassword(){
  const sets=['ABCDEFGHJKLMNPQRSTUVWXYZ','abcdefghijkmnpqrstuvwxyz','23456789','!@#$%&*?'], all=sets.join(''), r=n=>crypto.getRandomValues(new Uint32Array(1))[0]%n;
  const chars=sets.map(set=>set[r(set.length)]); while(chars.length<12) chars.push(all[r(all.length)]);
  for(let i=chars.length-1;i>0;i--){ const j=r(i+1); [chars[i],chars[j]]=[chars[j],chars[i]]; }
  return chars.join('');
}
document.querySelectorAll('.pw-rules').forEach(list=>{
  const input=document.getElementById(list.dataset.for); if(!input) return;
  const paint=()=>list.querySelectorAll('[data-rule]').forEach(li=>li.classList.toggle('ok',PW_RULES[li.dataset.rule](input.value)));
  input.addEventListener('input',paint); input.addEventListener('change',paint); paint();
});
document.getElementById('ad-gen')?.addEventListener('click',()=>{ const i=document.getElementById('ad-password'); i.value=makeTempPassword(); i.dispatchEvent(new Event('input')); });

async function submitChangePassword(){
  const current=document.getElementById('pw-current').value;
  const next=document.getElementById('pw-new').value;
  const confirm=document.getElementById('pw-confirm').value;
  const msg=document.getElementById('pw-msg');
  msg.style.display='none';
  const weak=pwProblem(next);
  if(weak){ msg.textContent=weak; msg.style.display='block'; return; }
  if(next!==confirm){ msg.textContent='New passwords do not match.'; msg.style.display='block'; return; }
  try{
    const res=await fetch('/api/auth/change-password',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({currentPassword:current,newPassword:next}),
    });
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||'Could not update password.');
    closeModal('modal-change-pw');
    ['pw-current','pw-new','pw-confirm'].forEach(id=>{ document.getElementById(id).value=''; });
    showToast(data.signedOutElsewhere?`Password updated — ${data.signedOutElsewhere} other device${data.signedOutElsewhere===1?' was':'s were'} signed out`:'Password updated');
  }catch(err){
    msg.textContent=err.message;
    msg.style.display='block';
  }
}

// ═══════════════════════════════════════════════════════════
// BUTTONS AND FIELDS
// The security policy allows no script in the page's markup (no onclick="…"): the markup names an
// action in data-click, data-input or data-change, and these listeners run it. Only the actions
// listed here can be named.
// ═══════════════════════════════════════════════════════════
const dataNum=(el,key)=>Number(el.dataset[key]);
const CLICK_ACTIONS={
  nav:el=>nav(el.dataset.to),
  closeModal:el=>closeModal(el.dataset.modal),
  cancelEdit:()=>cancelEdit(),
  startNewInspection:()=>startNewInspection(),
  dismissSpell:()=>dismissSpell(),
  submitReport:()=>submitReport(),
  exportPDF:()=>exportPDF(),
  printPDF:()=>printPDF(),
  resetForm:()=>resetForm(),
  openSaveChoice:()=>openSaveChoice(),
  submitChangePassword:()=>submitChangePassword(),
  selectSaveChoice:el=>selectSaveChoice(el.dataset.choice),
  confirmSaveChoice:()=>confirmSaveChoice(),
  closeLB:()=>closeLB(),
  tryNext:el=>tryNext(dataNum(el,'si')),
  setScore:el=>setScore(dataNum(el,'si'),dataNum(el,'ii'),dataNum(el,'val')),
  focusItem:el=>focusItem(dataNum(el,'si'),dataNum(el,'ii')),
  openLB:el=>openLB(el.getAttribute('src')),
  rmPhoto:el=>rmPhoto(dataNum(el,'si'),dataNum(el,'ii'),dataNum(el,'pi')),
  openReport:el=>openReport(dataNum(el,'id')),
};
const INPUT_ACTIONS={
  sectionNote:el=>{ curState().notes[dataNum(el,'si')]=el.value; currentReportSaved=false; updatePDFButton(); },
  itemComment:el=>{
    const si=dataNum(el,'si'), ii=dataNum(el,'ii');
    curState().comments[si][ii]=el.value; currentReportSaved=false; updatePDFButton();
    checkSpell(el.value,si,ii,el); updateCommentHint(si,ii);
  },
};
const CHANGE_ACTIONS={
  addPhotos:(el,e)=>addPhotos(e,dataNum(el,'si'),dataNum(el,'ii')),
};
for(const [type,actions] of [['click',CLICK_ACTIONS],['input',INPUT_ACTIONS],['change',CHANGE_ACTIONS]]){
  document.addEventListener(type,e=>{
    const el=e.target.closest?.(`[data-${type}]`); if(!el) return;
    const name=el.dataset[type];
    if(Object.hasOwn(actions,name)) actions[name](el,e);
  });
}
document.getElementById('pw-confirm').addEventListener('keydown',e=>{ if(e.key==='Enter') submitChangePassword(); });
