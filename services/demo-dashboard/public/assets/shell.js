// 公共框架：侧边栏、顶栏、板块切换、当前账号。每个页面调用 initShell({ page })。

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  discovery: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  demand: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="4"/>',
  customers: '<path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 20v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  properties: '<path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  publishing: '<path d="M4 4h16v12H5.2L4 17.5z"/><path d="M8 9h8M8 12h5"/>',
  leads: '<path d="M4 4h16v16H4z"/><path d="M4 9h16M9 20V9"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5a4 4 0 0 0 8 0h5"/>',
  accounts: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5 17a4 4 0 0 1 8 0M15 9h4M15 13h4"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  more: '<path d="M4 6h16M4 12h16M4 18h16"/>'
};

// href 为空的页面还没有开通。
const NAV = [
  { key: 'overview', label: '工作台总览', short: '总览', href: '/' },
  { group: '招商' },
  { key: 'discovery', label: '企业发现', short: '发现', href: '/discovery.html' },
  { key: 'demand', label: '需求发现', href: '/demand.html' },
  { key: 'customers', label: '招商客户', short: '客户', href: '/customers.html' },
  { key: 'properties', label: '房源与服务' },
  { group: '内容' },
  { key: 'publishing', label: '内容发布', short: '发布', href: '/publishing.html' },
  { key: 'inbox', label: '互动收件箱', href: '/inbox.html', badge: true },
  { key: 'accounts', label: '发布账号', href: '/accounts.html' },
  { key: 'leads', label: '留资线索', href: '/leads.html' },
  { group: '管理' },
  { key: 'reports', label: '报表', href: '/reports.html' },
  { key: 'settings', label: '系统设置', href: '/settings.html' }
];

const SECTOR_NAME = { office_retail: '商铺写字楼', hotel_apartment: '酒店公寓', dining: '餐饮' };
const SECTOR_STORAGE_KEY = 'hz.sector';

const icon = key => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[key]}</svg>`;
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** fetch 的薄封装：没登录跳到登录页，出错时抛出带中文说明的错误。 */
export async function api(path, options) {
  let response;
  try { response = await fetch(path, { headers: { Accept: 'application/json' }, ...options }); }
  catch { throw new Error('连接不上系统，请检查网络'); }
  if (response.status === 401) { location.replace('/login.html'); return new Promise(() => {}); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(response.status >= 500 ? '系统暂时出了问题，请稍后再试' : body.error || '请求没有成功');
  }
  return response.status === 204 ? null : response.json();
}

function navItem(item, page) {
  if (item.group) return `<h6>${item.group}</h6>`;
  if (!item.href) return `<span class="off" aria-disabled="true">${icon(item.key)}${item.label}<small>未开通</small></span>`;
  return `<a href="${item.href}"${item.key === page ? ' class="on" aria-current="page"' : ''}>${icon(item.key)}${item.label}${item.badge ? `<span class="count" data-badge="${item.key}" hidden></span>` : ''}</a>`;
}

const INBOX_SEEN_KEY = 'hz.inbox-seen';
/** 侧边栏的未处理数量；页面开着时，有新的意向消息就弹桌面通知（要先在收件箱页点过“开启提醒”）。 */
async function watchInbox() {
  try {
    const since = localStorage.getItem(INBOX_SEEN_KEY);
    const data = await api(`/api/inbox/summary${since ? `?since=${encodeURIComponent(since)}` : ''}`);
    const badge = document.querySelector('[data-badge="inbox"]');
    if (badge) { badge.textContent = data.unhandled; badge.hidden = !data.unhandled; }
    if (since && 'Notification' in window && Notification.permission === 'granted') {
      for (const item of data.fresh) {
        const note = new Notification(`${item.platform_name}有新的意向消息`, { body: `${item.post_title ? `《${item.post_title.slice(0, 20)}》 ` : ''}${item.sender_name}：${item.content.slice(0, 30)}`, tag: item.id });
        note.onclick = () => { window.focus(); location.href = '/inbox.html'; };
      }
    }
    localStorage.setItem(INBOX_SEEN_KEY, data.server_time);
  } catch { /* 下一轮再试 */ }
}

function mobileItem(item, page) {
  if (!item.href) return `<span class="off" aria-disabled="true">${icon(item.key)}${item.short}</span>`;
  return `<a href="${item.href}"${item.key === page ? ' class="on" aria-current="page"' : ''}>${icon(item.key)}${item.short}</a>`;
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login.html');
}

/**
 * @returns {Promise<{ user: object, sector: string, onSectorChange: (fn: (sector: string) => void) => void }>}
 */
export async function initShell({ page }) {
  const user = await api('/api/auth/me');
  document.body.dataset.canWrite = String(user.can_write);
  // 只读账号不显示任何编辑入口。
  if (!user.can_write) document.querySelectorAll('[data-requires="write"]').forEach(element => element.remove());

  const scope = user.all_sectors ? '全部板块' : user.sectors.map(key => SECTOR_NAME[key]).join('、') || '未分配板块';
  document.getElementById('side').innerHTML = `
    <div class="brand"><div class="brand-mark">恒</div><b>恒兆广场招商系统</b></div>
    <nav class="nav" aria-label="主导航">${NAV.map(item => navItem(item, page)).join('')}</nav>
    <div class="me">
      <div class="avatar" aria-hidden="true">${escapeHtml(user.display_name.slice(0, 1))}</div>
      <div><p>${escapeHtml(user.display_name)}</p><small>${escapeHtml(user.role_name)} · ${escapeHtml(scope)}</small></div>
      <button type="button" data-action="logout">退出</button>
    </div>`;

  const choices = user.sectors.length > 1 ? ['all', ...user.sectors] : user.sectors;
  const stored = localStorage.getItem(SECTOR_STORAGE_KEY);
  let sector = choices.includes(stored) ? stored : choices[0] ?? 'all';
  const listeners = [];
  document.getElementById('top').innerHTML = `
    <label class="search" title="企业和客户模块开通后可用">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.discovery}</svg>
      <input type="search" placeholder="搜索企业、房源编号" aria-label="搜索" disabled>
    </label>
    <div class="seg" role="group" aria-label="板块">
      ${choices.map(key => `<button type="button" data-sector="${key}" aria-pressed="${key === sector}">${key === 'all' ? '全部' : SECTOR_NAME[key]}</button>`).join('')}
    </div>
    <div class="bell-wrap">
      <button type="button" class="bell" data-action="bell" aria-label="通知" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg><i hidden></i>
      </button>
      <div class="bell-panel card" id="bell-panel" hidden></div>
    </div>
    <button type="button" class="top-user" data-action="logout">退出</button>`;
  const bell = document.querySelector('[data-action="bell"]');
  const bellPanel = document.getElementById('bell-panel');
  const renderNotifications = data => {
    bell.querySelector('i').hidden = !data.unread;
    bellPanel.innerHTML = data.items.length
      ? data.items.map(item => `<a class="bell-item${item.read ? '' : ' unread'}" href="${escapeHtml(item.link || '#')}"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.body || '')}</span><small>${new Date(item.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</small></a>`).join('')
      : '<div class="state">没有通知</div>';
  };
  api('/api/notifications').then(renderNotifications).catch(() => {});
  watchInbox();
  setInterval(watchInbox, 60_000);
  document.getElementById('mbar').innerHTML = [
    ...NAV.filter(item => item.short).map(item => mobileItem(item, page)),
    `<span class="off" aria-disabled="true">${icon('more')}更多</span>`
  ].join('');

  document.addEventListener('click', event => {
    if (event.target.closest('[data-action="logout"]')) { logout(); return; }
    if (event.target.closest('[data-action="bell"]')) {
      bellPanel.hidden = !bellPanel.hidden;
      bell.setAttribute('aria-expanded', String(!bellPanel.hidden));
      // 打开即视为已读；本次仍按未读样式显示，下次打开时变淡。
      if (!bellPanel.hidden && !bell.querySelector('i').hidden) {
        bell.querySelector('i').hidden = true;
        fetch('/api/notifications/read', { method: 'POST' }).catch(() => {});
      }
      return;
    }
    if (!event.target.closest('.bell-wrap')) { bellPanel.hidden = true; bell.setAttribute('aria-expanded', 'false'); }
    const button = event.target.closest('[data-sector]');
    if (!button || button.dataset.sector === sector) return;
    sector = button.dataset.sector;
    localStorage.setItem(SECTOR_STORAGE_KEY, sector);
    document.querySelectorAll('[data-sector]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    listeners.forEach(listener => listener(sector));
  });

  return {
    user,
    get sector() { return sector; },
    sectorName: key => (key === 'all' ? '全部板块' : SECTOR_NAME[key]),
    onSectorChange: listener => listeners.push(listener)
  };
}
