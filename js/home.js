document.getElementById('year').textContent = new Date().getFullYear();

// Signed in: the sign-in buttons open the workspace and the header shows who is signed in.
(async () => {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!res.ok) return;
    const { user } = await res.json();
    if (!user) return;
    const name = String(user.name || user.username || '').trim();
    document.querySelectorAll('.js-enter').forEach((a) => { a.href = '/app'; });
    document.querySelectorAll('.js-enter-label').forEach((el) => { el.textContent = 'Open workspace'; });
    document.getElementById('who-initials').textContent = name.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
    document.getElementById('who-name').textContent = name;
    document.getElementById('who').hidden = false;
    document.getElementById('sign-out').hidden = false;
    document.getElementById('access-text').textContent = `You are signed in as ${name}.`;
  } catch { /* stay signed out */ }
})();

document.getElementById('sign-out').addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } finally { window.location.reload(); }
});
