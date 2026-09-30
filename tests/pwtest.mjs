// Password rules, lockout and session revocation against the local server (test accounts only).
import { randomBytes } from 'node:crypto';
const B='http://localhost:8787'; let pass=0, bad=0;
const ok=(c,l,x='')=>{ c?pass++:bad++; console.log((c?'  ✓ ':'  ✗ ')+l+(x?'  '+x:'')); };
const call=async(cookie,method,path,body)=>{ const h={'Content-Type':'application/json'}; if(cookie) h.Cookie='qa_session='+cookie;
  const r=await fetch(B+path,{method,headers:h,body:body?JSON.stringify(body):undefined}); const t=await r.text(); let j=null; try{j=JSON.parse(t);}catch{}
  const sc=r.headers.get('set-cookie')||''; const m=/qa_session=([^;]+)/.exec(sc); return {s:r.status,j,cookie:m&&m[1]}; };
const gen=()=>'Tq'+randomBytes(6).toString('hex')+'!a';          // upper, lower, digit, symbol, 16 chars
const uname='pwtest'+randomBytes(3).toString('hex');
console.log('Admin creates an account');
for (const [pw,why] of [['short1!A','7 chars? (8 ok)'],['alllowercase1!','no upper'],['ALLUPPER1!','no lower'],['NoSymbol123','no symbol'],['Ab!','too short']]) {
  const r=await call('tst-adm-2026','POST','/api/admin/users',{name:'PW Test',username:uname,password:pw,role:'quality_auditor'});
  if (pw==='short1!A') { ok(r.s===201||r.s===200,'8 chars with upper+lower+symbol accepted', r.j?.error||''); if(r.s<300){ const u=(await call('tst-adm-2026','GET','/api/admin/users')).j.users.find(x=>x.username===uname); await call('tst-adm-2026','DELETE','/api/admin/users/'+u.id); } }
  else ok(r.s===400,`rejected: ${why}`, r.j?.error);
}
const temp=gen();
let r=await call('tst-adm-2026','POST','/api/admin/users',{name:'PW Test',username:uname,password:temp,role:'quality_auditor'});
ok(r.s<300,'account created with a strong temporary password', r.j?.error||'');
console.log('First sign-in must replace the temporary password');
r=await call(null,'POST','/api/auth/login',{username:uname,password:temp});
ok(r.j?.mustChangePassword===true && !r.cookie,'sign-in asks for a new password, no session yet');
r=await call(null,'POST','/api/auth/complete-setup',{username:uname,currentPassword:temp,newPassword:'weakpass'});
ok(r.s===400,'weak new password refused', r.j?.error);
r=await call(null,'POST','/api/auth/complete-setup',{username:uname,currentPassword:temp,newPassword:temp});
ok(r.s===400,'reusing the temporary password refused', r.j?.error);
for(let i=0;i<5;i++) r=await call(null,'POST','/api/auth/complete-setup',{username:uname,currentPassword:'Wrong!'+i+'Pass',newPassword:gen()});
r=await call(null,'POST','/api/auth/complete-setup',{username:uname,currentPassword:temp,newPassword:gen()});
ok(r.s===423,'5 wrong temporary passwords lock the account', r.j?.error);
const users=(await call('tst-adm-2026','GET','/api/admin/users')).j.users; const me=users.find(x=>x.username===uname);
await call('tst-adm-2026','POST',`/api/admin/users/${me.id}/unlock`);
const pw1=gen();
r=await call(null,'POST','/api/auth/complete-setup',{username:uname,currentPassword:temp,newPassword:pw1});
ok(r.s===200 && r.cookie,'after unlock: strong new password accepted, signed in');
const sessA=decodeURIComponent(r.cookie);
console.log('Sign-in lockout');
for(let i=0;i<5;i++) r=await call(null,'POST','/api/auth/login',{username:uname,password:'Nope!'+i+'Xx'});
r=await call(null,'POST','/api/auth/login',{username:uname,password:pw1});
ok(r.s===423,'5 wrong passwords lock sign-in, even the right one waits', r.j?.error);
await call('tst-adm-2026','POST',`/api/admin/users/${me.id}/unlock`);
r=await call(null,'POST','/api/auth/login',{username:uname,password:pw1}); const sessB=decodeURIComponent(r.cookie||'');
ok(r.s===200 && sessB,'unlocked: signs in on a second device');
console.log('Changing the password signs out the other devices');
r=await call(sessA,'POST','/api/auth/change-password',{currentPassword:pw1,newPassword:'lowercase!only1'});
ok(r.s===400,'weak password refused on change', r.j?.error);
r=await call(sessA,'POST','/api/auth/change-password',{currentPassword:pw1,newPassword:pw1});
ok(r.s===400,'same password refused', r.j?.error);
const pw2=gen();
r=await call(sessA,'POST','/api/auth/change-password',{currentPassword:pw1,newPassword:pw2});
ok(r.s===200 && r.j.signedOutElsewhere>=1,'changed; other devices signed out', JSON.stringify(r.j));
ok((await call(sessA,'GET','/api/auth/me')).s===200,'this device stays signed in');
ok((await call(sessB,'GET','/api/auth/me')).s===401,'the other device is signed out');
console.log('Admin reset');
r=await call('tst-adm-2026','POST',`/api/admin/users/${me.id}/reset-password`,{password:'short'});
ok(r.s===400,'weak reset refused', r.j?.error);
r=await call('tst-adm-2026','POST',`/api/admin/users/${me.id}/reset-password`,{password:gen()});
ok(r.s===200,'strong reset accepted');
ok((await call(sessA,'GET','/api/auth/me')).s===401,'reset signs the user out everywhere');
console.log('Suspension');
await call('tst-adm-2026','DELETE','/api/admin/users/'+me.id);
console.log(`\n${pass} passed, ${bad} failed`);
