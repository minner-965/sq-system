const form = document.getElementById('login-form');
const errorLine = document.getElementById('login-error');
const submit = document.getElementById('login-submit');

form.addEventListener('submit', async event => {
  event.preventDefault();
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!username || !password) { errorLine.textContent = '请输入账号和密码'; return; }
  errorLine.textContent = '';
  submit.disabled = true;
  submit.textContent = '正在登录';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (response.ok) { location.replace('/'); return; }
    const body = await response.json().catch(() => ({}));
    errorLine.textContent = body.error || '登录没有成功，请稍后再试';
    form.password.select();
  } catch {
    errorLine.textContent = '连接不上系统，请检查网络后再试';
  } finally {
    submit.disabled = false;
    submit.textContent = '登录';
  }
});
