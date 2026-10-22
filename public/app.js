'use strict';
(() => {
  const app = document.getElementById('app');
  const toasts = document.getElementById('toasts');
  let state = { user: null, licenses: [], search: '' };

  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    toasts.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || 'خطا در ارتباط با سرور');
    return data;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Login screen ----------
  function renderLogin(err) {
    app.innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <div class="login-brand"><span class="bat">🦇</span><h1>Batman License Control</h1></div>
          <p class="login-sub">پنل مدیریت لایسنس — ورود ادمین</p>
          ${err ? `<div class="login-err">${escapeHtml(err)}</div>` : ''}
          <form id="loginForm">
            <div class="field">
              <label>نام کاربری</label>
              <input type="text" name="username" autocomplete="username" required autofocus>
            </div>
            <div class="field">
              <label>رمز عبور</label>
              <input type="password" name="password" autocomplete="current-password" required>
            </div>
            <button class="btn btn-primary" type="submit">ورود</button>
          </form>
        </div>
      </div>`;
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector('button');
      btn.disabled = true; btn.textContent = 'در حال ورود...';
      try {
        const data = await api('POST', '/api/login', { username: fd.get('username'), password: fd.get('password') });
        state.user = data;
        await boot();
      } catch (err) {
        renderLogin(err.message);
      }
    });
  }

  // ---------- Dashboard shell ----------
  function daysBadge(lic) {
    if (lic.expiresAt === null) return `<span class="forever">دائمی</span>`;
    const d = lic.daysLeft;
    if (d === null) return '—';
    if (d < 0) return `<span class="days crit">منقضی</span>`;
    let cls = 'ok';
    if (d <= 3) cls = 'crit'; else if (d <= 10) cls = 'warn';
    return `<span class="days ${cls}">${d} روز</span>`;
  }

  function renderStats() {
    const total = state.licenses.length;
    const active = state.licenses.filter(l => l.active).length;
    const online = state.licenses.filter(l => l.online).length;
    return `
      <div class="rail-stat"><div class="num">${total}</div><div class="lbl">کل لایسنس‌ها</div></div>
      <div class="rail-stat ok"><div class="num">${active}</div><div class="lbl">فعال</div></div>
      <div class="rail-stat off"><div class="num">${total - active}</div><div class="lbl">غیرفعال</div></div>
      <div class="rail-stat ok"><div class="num">${online}</div><div class="lbl">آنلاین الان</div></div>
    `;
  }

  function renderRows() {
    const q = state.search.trim().toLowerCase();
    const list = state.licenses.filter(l =>
      !q || l.key.toLowerCase().includes(q) || l.ip.toLowerCase().includes(q) || (l.note || '').toLowerCase().includes(q)
    );
    if (list.length === 0) {
      return `<div class="empty-state"><span class="bat">🦇</span>${state.licenses.length === 0 ? 'هنوز لایسنسی صادر نشده' : 'نتیجه‌ای پیدا نشد'}</div>`;
    }
    return `<div class="lic-table">${list.map(rowHtml).join('')}</div>`;
  }

  function rowHtml(l) {
    const dotCls = l.active ? (l.online ? 'active live' : 'active') : 'off';
    const unread = l.unreadForAdmin || 0;
    // وقتی پیام خوانده‌نشده از مشتری هست، کل ردیف با یک قاب/هایلایت قرمز
    // مشخص می‌شود — یعنی بدون نیاز به باز کردن گفتگو، همون نگاه اول به
    // لیست، می‌فهمی کدام مشتری منتظر جواب است.
    const flagged = unread > 0 ? ' has-unread' : '';
    const ipOrFp = l.ip
      ? `<span class="ip">${escapeHtml(l.ip)}</span>`
      : (l.fingerprint ? `<span class="fp" title="این لایسنس بدون IP است و فقط با اثر انگشت سرور شناسایی می‌شود">🔗 ${escapeHtml(l.fingerprint)}</span>` : `<span class="pill">بدون IP / هنوز وصل نشده</span>`);
    return `
      <div class="lic-row ${l.active ? '' : 'is-off'}${flagged}" data-id="${l.id}">
        <span class="status-dot ${dotCls}" title="${l.online ? 'در حال اتصال زنده' : (l.active ? 'فعال' : 'غیرفعال')}"></span>
        <div class="lic-info">
          <div class="lic-key">${l.key}<span class="copy-ic" data-copy="${l.key}" title="کپی">⧉</span></div>
          <div class="lic-meta">${ipOrFp}<span>صدور: ${fmtDate(l.createdAt)}</span>${l.activatedAt ? `<span>آخرین اتصال: ${fmtDate(l.lastCheck)}</span>` : '<span class="pill">هنوز متصل نشده</span>'}</div>
          ${l.note ? `<div class="lic-note">${escapeHtml(l.note)}</div>` : ''}
          ${l.lastMessage ? `<div class="lic-note lic-last-msg">💬 ${l.lastMessage.from === 'admin' ? 'شما' : 'مشتری'}: ${escapeHtml(l.lastMessage.text.slice(0, 60))}${l.lastMessage.text.length > 60 ? '…' : ''}</div>` : ''}
        </div>
        <div class="lic-expiry">${daysBadge(l)}</div>
        <button class="toggle ${l.active ? 'on' : ''}" data-action="toggle" title="${l.active ? 'غیرفعال کردن فوری' : 'فعال کردن'}"></button>
        <div class="row-actions">
          <button class="icon-btn chat-btn${unread ? ' has-badge' : ''}" data-action="chat" title="گفتگو با این مشتری">💬${unread ? `<span class="chat-badge">${unread}</span>` : ''}</button>
          <button class="icon-btn" data-action="extend" title="تمدید">＋</button>
          <button class="icon-btn danger" data-action="delete" title="حذف">✕</button>
        </div>
      </div>`;
  }

  function renderShell() {
    app.innerHTML = `
      <div class="shell">
        <div class="rail">
          <div class="rail-brand"><span class="bat">🦇</span><span>Batman License</span></div>
          <div class="rail-stats">${renderStats()}</div>
          <div class="rail-spacer"></div>
          <div class="rail-user">
            <b>${escapeHtml(state.user.username)}</b>
            <div class="rail-actions">
              <button class="btn btn-ghost btn-small" id="btnPass">تغییر رمز</button>
              <button class="btn btn-ghost btn-small" id="btnLogout">خروج</button>
            </div>
          </div>
        </div>
        <div class="main">
          <div class="topbar">
            <div>
              <h2>لایسنس‌ها</h2>
              <div class="sub">غیرفعال‌کردن این‌جا بلافاصله به پنل مشتری اعلام می‌شود</div>
            </div>
            <div class="row">
              <input class="search" id="searchBox" placeholder="جستجو در کلید، IP یا یادداشت...">
              <button class="btn btn-primary" id="btnNew">+ لایسنس جدید</button>
            </div>
          </div>
          <div id="rows">${renderRows()}</div>
        </div>
      </div>`;

    document.getElementById('btnNew').addEventListener('click', openNewLicenseModal);
    document.getElementById('btnLogout').addEventListener('click', doLogout);
    document.getElementById('btnPass').addEventListener('click', openChangePasswordModal);
    const search = document.getElementById('searchBox');
    search.value = state.search;
    search.addEventListener('input', () => { state.search = search.value; document.getElementById('rows').innerHTML = renderRows(); bindRowEvents(); });

    bindRowEvents();
  }

  function bindRowEvents() {
    document.querySelectorAll('.copy-ic').forEach(el => {
      el.addEventListener('click', () => {
        navigator.clipboard.writeText(el.dataset.copy).then(() => toast('کلید کپی شد'));
      });
    });
    document.querySelectorAll('.lic-row').forEach(row => {
      const id = row.dataset.id;
      const lic = state.licenses.find(l => l.id === id);
      row.querySelector('[data-action="toggle"]').addEventListener('click', (e) => toggleLicense(id, lic, e.currentTarget));
      row.querySelector('[data-action="extend"]').addEventListener('click', () => openExtendModal(id, lic));
      row.querySelector('[data-action="delete"]').addEventListener('click', () => confirmDelete(id, lic));
      row.querySelector('[data-action="chat"]').addEventListener('click', () => openChatModal(id, lic));
    });
  }

  async function toggleLicense(id, lic, btn) {
    const next = !lic.active;
    btn.disabled = true;
    try {
      await api('PATCH', `/api/licenses/${id}`, { active: next });
      lic.active = next;
      toast(next ? 'لایسنس فعال شد — بلافاصله به کاربر اطلاع داده شد' : 'لایسنس غیرفعال شد — بلافاصله قفل شد', next ? 'success' : 'error');
      document.getElementById('rows').innerHTML = renderRows();
      bindRowEvents();
      refreshStats();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  }

  function refreshStats() {
    document.querySelector('.rail-stats').innerHTML = renderStats();
  }

  function confirmDelete(id, lic) {
    openModal(`
      <h3>حذف لایسنس</h3>
      <p class="muted">کلید <b style="color:var(--text)">${lic.key}</b> برای همیشه حذف می‌شود و دسترسی کاربر فوراً قطع خواهد شد.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>انصراف</button>
        <button class="btn btn-danger" id="confirmDel">حذف قطعی</button>
      </div>
    `);
    document.getElementById('confirmDel').addEventListener('click', async () => {
      try {
        await api('DELETE', `/api/licenses/${id}`);
        state.licenses = state.licenses.filter(l => l.id !== id);
        closeModal();
        toast('لایسنس حذف شد');
        document.getElementById('rows').innerHTML = renderRows();
        bindRowEvents();
        refreshStats();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  function openExtendModal(id, lic) {
    openModal(`
      <h3>تمدید / تنظیمات لایسنس</h3>
      <div class="field">
        <label>تعداد روز برای افزودن</label>
        <input type="number" id="extDays" min="1" value="30">
      </div>
      <div class="field">
        <label><input type="checkbox" id="extForever"> تبدیل به دائمی (بدون انقضا)</label>
      </div>
      ${lic.fingerprint ? `
      <div class="field">
        <label>اثر انگشت سرور فعلی</label>
        <div class="fp-box">🔗 ${escapeHtml(lic.fingerprint)}</div>
        <button type="button" class="btn btn-ghost btn-small" id="btnResetFp" style="margin-top:8px">
          بازنشانی (اگر مشتری سرورش را عوض کرده)
        </button>
      </div>` : ''}
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>انصراف</button>
        <button class="btn btn-primary" id="confirmExt">اعمال</button>
      </div>
    `);
    document.getElementById('confirmExt').addEventListener('click', async () => {
      try {
        const forever = document.getElementById('extForever').checked;
        const body = forever ? { makePermanent: true } : { extendDays: parseInt(document.getElementById('extDays').value, 10) };
        await api('PATCH', `/api/licenses/${id}`, body);
        await loadLicenses();
        closeModal();
        toast('لایسنس به‌روزرسانی شد');
      } catch (err) { toast(err.message, 'error'); }
    });
    const btnResetFp = document.getElementById('btnResetFp');
    if (btnResetFp) {
      btnResetFp.addEventListener('click', async () => {
        try {
          await api('PATCH', `/api/licenses/${id}`, { resetFingerprint: true });
          await loadLicenses();
          closeModal();
          toast('اثر انگشت بازنشانی شد؛ سرور بعدی که وصل شود قفل خواهد شد');
        } catch (err) { toast(err.message, 'error'); }
      });
    }
  }

  function openNewLicenseModal() {
    openModal(`
      <h3>صدور لایسنس جدید</h3>
      <div class="field">
        <label>آدرس IP یا دامنه سرور مشتری (اختیاری)</label>
        <input type="text" id="newIp" placeholder="مثلاً 185.23.45.12 — یا خالی بگذار">
        <div class="field-hint">اگر سرور مشتری پشت تانل/پراکسی است و IP واقعی‌اش با چیزی که می‌دهی فرق دارد،
          این فیلد را کاملاً خالی بگذار؛ لایسنس به‌جایش با یک «اثر انگشت» یکتای همان سرور
          (در اولین اتصال) قفل می‌شود و با عوض شدن IP از کار نمی‌افتد.</div>
      </div>
      <div class="field">
        <label>مدت اعتبار</label>
        <select id="newDays">
          <option value="30">۳۰ روز</option>
          <option value="90">۳ ماه</option>
          <option value="180">۶ ماه</option>
          <option value="365">۱ سال</option>
          <option value="">دائمی</option>
        </select>
      </div>
      <div class="field">
        <label>یادداشت (اختیاری)</label>
        <input type="text" id="newNote" placeholder="مثلاً نام مشتری">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>انصراف</button>
        <button class="btn btn-primary" id="confirmNew">صدور لایسنس</button>
      </div>
    `);
    document.getElementById('confirmNew').addEventListener('click', async () => {
      const ip = document.getElementById('newIp').value.trim();
      const days = document.getElementById('newDays').value;
      const note = document.getElementById('newNote').value.trim();
      try {
        const lic = await api('POST', '/api/licenses', { ip, days: days || null, note });
        await loadLicenses();
        showNewKey(lic.key);
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  function showNewKey(key) {
    openModal(`
      <h3>لایسنس صادر شد</h3>
      <div class="new-key-box">
        <div class="key">${key}</div>
        <div class="hint">این کلید را همین حالا کپی کنید و به مشتری بدهید</div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="copyKey">کپی کلید</button>
        <button class="btn btn-primary" data-close>بستن</button>
      </div>
    `);
    document.getElementById('copyKey').addEventListener('click', () => {
      navigator.clipboard.writeText(key).then(() => toast('کپی شد'));
    });
  }

  // ---------- گفتگوی اختصاصی هر لایسنس ----------
  // هر لایسنس یک گفتگوی کاملاً جدا دارد؛ این مودال فقط پیام‌های همین یک
  // لایسنس (data-id همان لایسنس) را می‌خواند و می‌فرستد.
  let activeChatId = null;
  function chatMsgHtml(m) {
    const mine = m.from === 'admin';
    return `<div class="chat-msg ${mine ? 'mine' : 'theirs'}${m._pending ? ' pending' : ''}">
      <div class="chat-bubble">${escapeHtml(m.text)}</div>
      <div class="chat-time">${m._pending ? 'در حال ارسال...' : fmtDate(m.at)}</div>
    </div>`;
  }

  async function openChatModal(id, lic) {
    activeChatId = id;
    // باز کردن گفتگو یعنی خوانده شد: بلافاصله در خودِ لیست هم هایلایت قرمز را بردار
    lic.unreadForAdmin = 0;
    const rowsEl = document.getElementById('rows');
    if (rowsEl) { rowsEl.innerHTML = renderRows(); bindRowEvents(); }

    openModal(`
      <h3>گفتگو — ${escapeHtml(lic.note || lic.ip || 'مشتری')}</h3>
      <div class="chat-sub">این گفتگو فقط مخصوص همین لایسنس است (${lic.key})</div>
      <div class="chat-box" id="chatBox"><div class="chat-loading">در حال بارگذاری...</div></div>
      <form id="chatForm" class="chat-form">
        <input type="text" id="chatInput" placeholder="پیام برای این مشتری..." autocomplete="off" maxlength="2000">
        <button class="btn btn-primary btn-small" type="submit">ارسال</button>
      </form>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>بستن</button>
      </div>
    `, { wide: true });
    await refreshChat(id);
    document.getElementById('chatForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('chatInput');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      input.disabled = true;
      // ارسال خوش‌بینانه (optimistic): پیام را همین الان نشان بده، بعد سرور
      // را صدا بزن — حس سریع‌تر و بی‌تاخیرتر به گفتگو می‌دهد
      const tempMsg = { id: 'temp-' + Date.now(), from: 'admin', text, at: Date.now(), _pending: true };
      appendLiveMessage(tempMsg);
      try {
        await api('POST', `/api/licenses/${id}/messages`, { text });
        await refreshChat(id);
      } catch (err) {
        toast(err.message, 'error');
        await refreshChat(id); // پیام موقت را با وضعیت واقعی جایگزین کن
      }
      input.disabled = false;
      input.focus();
    });
  }

  async function refreshChat(id) {
    try {
      const msgs = await api('GET', `/api/licenses/${id}/messages`);
      const box = document.getElementById('chatBox');
      if (!box) return;
      box.innerHTML = msgs.length
        ? msgs.map(chatMsgHtml).join('')
        : `<div class="chat-empty">هنوز پیامی رد و بدل نشده</div>`;
      box.scrollTop = box.scrollHeight;
      // شمارنده‌ی نخوانده را در لیست هم صفر کن (چون سرور با همین GET صفرش کرده)
      const row = state.licenses.find(l => l.id === id);
      if (row) row.unreadForAdmin = 0;
    } catch (err) { /* silent */ }
  }

  function openChangePasswordModal() {
    openModal(`
      <h3>تغییر رمز عبور</h3>
      <div class="field"><label>رمز فعلی</label><input type="password" id="oldPass"></div>
      <div class="field"><label>رمز جدید (حداقل ۸ کاراکتر)</label><input type="password" id="newPass"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>انصراف</button>
        <button class="btn btn-primary" id="confirmPass">ذخیره</button>
      </div>
    `);
    document.getElementById('confirmPass').addEventListener('click', async () => {
      try {
        await api('POST', '/api/change-password', {
          oldPassword: document.getElementById('oldPass').value,
          newPassword: document.getElementById('newPass').value,
        });
        closeModal();
        toast('رمز عبور تغییر کرد');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  function openModal(html, opts) {
    closeModal();
    const wide = opts && opts.wide;
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.id = 'modalBackdrop';
    bd.innerHTML = `<div class="modal${wide ? ' modal-wide' : ''}">${html}</div>`;
    bd.addEventListener('click', (e) => { if (e.target === bd) closeModal(); });
    bd.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
    document.body.appendChild(bd);
  }
  function closeModal() {
    const el = document.getElementById('modalBackdrop');
    if (el) { el.remove(); activeChatId = null; }
  }

  async function doLogout() {
    try { await api('POST', '/api/logout'); } catch (e) {}
    state.user = null;
    renderLogin();
  }

  async function loadLicenses() {
    state.licenses = await api('GET', '/api/licenses');
    const rowsEl = document.getElementById('rows');
    if (rowsEl) { rowsEl.innerHTML = renderRows(); bindRowEvents(); refreshStats(); }
  }

  // ---------- اتصال زنده برای اعلام فوری پیام‌های جدید ----------
  // چون هر لایسنس یک سوکت جدا به سرور دارد، اینجا برای همه‌ی لایسنس‌های
  // لیست‌شده یک اتصال سبک برقرار می‌کنیم تا وقتی مشتری جواب داد، بدون
  // صبر برای polling، هم شمارنده‌ی نخوانده و هم گفتگوی بازشده آپدیت شود.
  const adminSockets = new Map(); // key -> WebSocket
  function connectAdminSocketFor(lic) {
    if (adminSockets.has(lic.key)) return;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/license?key=${encodeURIComponent(lic.key)}&role=admin-watch`);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'new_message' && msg.message.from === 'customer') {
            const row = state.licenses.find(l => l.key === lic.key);
            if (row) {
              row.unreadForAdmin = (row.unreadForAdmin || 0) + 1;
              row.lastMessage = { from: msg.message.from, text: msg.message.text, at: msg.message.at };
              if (activeChatId === row.id) {
                // گفتگو همین الان باز است: پیام را فوری اضافه کن، شمارنده صفر بماند
                row.unreadForAdmin = 0;
                appendLiveMessage(msg.message);
              } else {
                // بسته است: ردیف را در لیست قرمز/هایلایت کن تا توجه جلب شود
                const rowsEl = document.getElementById('rows');
                if (rowsEl) { rowsEl.innerHTML = renderRows(); bindRowEvents(); }
                flashRow(row.id);
                toast(`پیام جدید از ${row.note || row.ip || 'مشتری'}`, 'success');
              }
            }
          } else if (msg.type === 'license_changed') {
            // اگر مثلاً از یک تب دیگر وضعیت لایسنس عوض شد، لیست را تازه کن
            loadLicenses().catch(() => {});
          }
        } catch (e) { /* ignore */ }
      };
      ws.onclose = () => { adminSockets.delete(lic.key); };
      adminSockets.set(lic.key, ws);
    } catch (e) { /* ignore */ }
  }

  // یک ضربان کوتاه قرمز روی ردیف، درست لحظه‌ی رسیدن پیام، تا چشم بلافاصله
  // متوجه شود این مشتری تازه چیزی فرستاده (جدا از هایلایت ثابت has-unread)
  function flashRow(id) {
    const row = document.querySelector(`.lic-row[data-id="${id}"]`);
    if (!row) return;
    row.classList.add('row-flash');
    setTimeout(() => row.classList.remove('row-flash'), 1200);
  }

  // وقتی گفتگوی یک لایسنس باز است و پیام جدید می‌رسد، به‌جای رفرش کامل لیست،
  // فقط همان حباب را با انیمیشن به چت اضافه می‌کنیم — سریع‌تر و طبیعی‌تر
  function appendLiveMessage(m) {
    const box = document.getElementById('chatBox');
    if (!box) return;
    const empty = box.querySelector('.chat-empty');
    if (empty) empty.remove();
    box.insertAdjacentHTML('beforeend', chatMsgHtml(m));
    box.scrollTop = box.scrollHeight;
  }

  async function boot() {
    try {
      const me = await api('GET', '/api/me');
      state.user = me;
      renderShell();
      await loadLicenses();
      state.licenses.forEach(connectAdminSocketFor);
      setInterval(async () => {
        await loadLicenses();
        state.licenses.forEach(connectAdminSocketFor); // لایسنس‌های جدید را هم وصل کن
      }, 15000); // به‌روزرسانی خودکار لیست هر ۱۵ ثانیه، به‌علاوه‌ی push آنی بالا
    } catch (err) {
      renderLogin();
    }
  }

  boot();
})();
