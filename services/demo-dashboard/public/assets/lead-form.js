// 留资页的脚本。不依赖登录后的那套外壳。
const byId = id => document.getElementById(id);
const code = location.pathname.split('/').filter(Boolean).pop();
const show = id => { for (const part of ['loading', 'gone', 'form', 'done']) byId(part).hidden = part !== id; };

async function load() {
  let response;
  try { response = await fetch(`/api/public/forms/${encodeURIComponent(code)}`, { headers: { Accept: 'application/json' } }); }
  catch { byId('loading').textContent = '网络不太好，请稍后再打开'; return; }
  if (!response.ok) { show('gone'); return; }
  const form = await response.json();
  byId('title').textContent = form.title;
  const select = byId('f-sector');
  for (const sector of form.sectors) select.add(new Option(sector.name, sector.key));
  select.value = form.sector_key;
  show('form');
  byId('f-name').focus();
}

byId('form').addEventListener('submit', async event => {
  event.preventDefault();
  const error = byId('error');
  error.textContent = '';
  const body = {
    contact_name: byId('f-name').value.trim(), phone: byId('f-phone').value.replace(/[\s-]/g, ''), sector_key: byId('f-sector').value,
    need: byId('f-need').value.trim(), consent: byId('f-consent').checked, website: byId('f-website').value
  };
  if (!body.contact_name) { error.textContent = '请填写称呼'; byId('f-name').focus(); return; }
  if (!/^1[3-9]\d{9}$/.test(body.phone)) { error.textContent = '请填写 11 位手机号'; byId('f-phone').focus(); return; }
  if (!body.consent) { error.textContent = '请先勾选同意我们联系您'; byId('f-consent').focus(); return; }
  byId('submit').disabled = true;
  try {
    const response = await fetch(`/api/public/forms/${encodeURIComponent(code)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body)
    });
    if (response.ok) { show('done'); return; }
    const result = await response.json().catch(() => ({}));
    if (response.status === 404) { show('gone'); return; }
    error.textContent = result.error || '没有提交成功，请稍后再试';
  } catch {
    error.textContent = '网络不太好，请稍后再试';
  } finally {
    byId('submit').disabled = false;
  }
});

load();
