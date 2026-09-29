lucide.createIcons();
/* The password rule — the same one the server enforces. */
const PW_RULES = { len: (p) => p.length >= 8, upper: (p) => /[A-Z]/.test(p), lower: (p) => /[a-z]/.test(p), symbol: (p) => /[^A-Za-z0-9]/.test(p) };
function pwOk(p) { return Object.values(PW_RULES).every((t) => t(p)); }
document.querySelectorAll('.pw-rules').forEach((list) => {
  const input = document.getElementById(list.dataset.for);
  const paint = () => list.querySelectorAll('[data-rule]').forEach((li) => li.classList.toggle('ok', PW_RULES[li.dataset.rule](input.value)));
  input.addEventListener('input', paint); paint();
});
const PW_HELP = 'The password needs 8 or more characters, an uppercase letter, a lowercase letter and a symbol.';

const bootstrapView = document.getElementById('bootstrap-view');
const loginView = document.getElementById('login-view');
const forceChangeView = document.getElementById('force-change-view');
let pendingSetup = null; // { username, currentPassword } while forcing a password change

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.innerHTML = busy
    ? '<span class="spin"></span> Please wait…'
    : label;
}

function showMsg(el, text, ok) {
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

(async () => {
  try {
    const me = await fetch('/api/auth/me');
    if (me.ok) { window.location.replace('/'); return; }
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    if (data.hasUsers) {
      loginView.hidden = false;
    } else {
      bootstrapView.hidden = false;
    }
  } catch {
    loginView.hidden = false;
  } finally {
    document.body.classList.remove('loading');
  }
})();

document.getElementById('bootstrap-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = document.getElementById('bs-submit');
  const msg = document.getElementById('bs-msg');
  msg.className = 'msg';
  if (!pwOk(document.getElementById('bs-password').value)) { showMsg(msg, PW_HELP, false); return; }
  setBusy(submit, true);
  try {
    const res = await fetch('/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('bs-name').value.trim(),
        username: document.getElementById('bs-username').value.trim(),
        password: document.getElementById('bs-password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create the administrator account.');
    window.location.href = '/';
  } catch (err) {
    showMsg(msg, err.message, false);
    setBusy(submit, false, '<svg data-lucide="user-plus" width="16" height="16"></svg> Create Administrator');
    lucide.createIcons();
  }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = document.getElementById('lg-submit');
  const msg = document.getElementById('lg-msg');
  msg.className = 'msg';
  setBusy(submit, true);
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('lg-username').value.trim(),
        password: document.getElementById('lg-password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Invalid username or password.');
    if (data.mustChangePassword) {
      pendingSetup = {
        username: document.getElementById('lg-username').value.trim(),
        currentPassword: document.getElementById('lg-password').value,
      };
      loginView.hidden = true;
      forceChangeView.hidden = false;
      return;
    }
    window.location.href = '/';
  } catch (err) {
    showMsg(msg, err.message, false);
    setBusy(submit, false, '<svg data-lucide="log-in" width="16" height="16"></svg> Sign In');
    lucide.createIcons();
  }
});

document.getElementById('force-change-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = document.getElementById('fc-submit');
  const msg = document.getElementById('fc-msg');
  msg.className = 'msg';
  const newPassword = document.getElementById('fc-password').value;
  const confirm = document.getElementById('fc-confirm').value;
  if (!pwOk(newPassword)) { showMsg(msg, PW_HELP, false); return; }
  if (newPassword !== confirm) { showMsg(msg, 'Passwords do not match.', false); return; }
  setBusy(submit, true);
  try {
    const res = await fetch('/api/auth/complete-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...pendingSetup, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not set your new password.');
    window.location.href = '/';
  } catch (err) {
    showMsg(msg, err.message, false);
    setBusy(submit, false, '<svg data-lucide="check" width="16" height="16"></svg> Set password and sign in');
    lucide.createIcons();
  }
});
