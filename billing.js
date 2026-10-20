(function () {
  'use strict';
  const el = id => document.getElementById(id);
  const offline = location.protocol === 'file:';
  let status = { enabled: false, paid: false, plans: [] }, failure = '', busy = false, refreshing = null;
  const dialog = el('billingDialog');
  const money = plan => {
    const format = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: plan.currency.toUpperCase() });
    // ISK/UGX retain two-decimal API representation for Stripe compatibility.
    const digits = ['isk', 'ugx'].includes(plan.currency) ? 2 : format.resolvedOptions().maximumFractionDigits;
    return format.format(plan.amount / 10 ** digits);
  };

  async function api(path, body) {
    const response = await fetch(path.startsWith('auth/') ? `/api/${path}` : `/api/billing/${path}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    // A plain static server has no billing API; local HTML remains fully usable.
    if (path === 'status' && response.status === 404 && !status.enabled) return { enabled: false, paid: false, plans: [] };
    const data = await response.json();
    if (!response.ok) {
      if (data.enabled) status = { ...status, ...data, paid: false };
      throw new Error(data.error || '无法读取支付状态');
    }
    return data;
  }
  function render() {
    const user = status.auth?.user, legacy = status.auth?.legacyAvailable;
    const visible = status.enabled || !!failure;
    el('billingPanel').classList.toggle('hidden', !visible);
    el('billingAd').classList.toggle('hidden', !status.enabled || status.experiment !== 'adfree' || status.paid);
    el('billingSummary').textContent = failure || (status.paid ? `已解锁 · ${status.plan === 'monthly' ? '测试月订阅' : '测试买断'}${status.cancelAtPeriodEnd ? '（到期取消）' : ''}`
      : status.experiment === 'adfree' ? '免费编辑与导出；付费后隐藏广告占位区。' : '免费导入、编辑与验证；测试购买后可下载、复制和分享。');
    el('billingOpen').textContent = status.paid ? '查看购买状态' : '查看测试方案';
    el('billingMessage').textContent = failure || (status.paid ? '测试权益已生效。请回到原来的编辑标签页继续导出。'
      : status.state === 'pending' ? '已打开测试结账页。付款后点击“刷新购买状态”，不必重新导入图片。'
      : status.state === 'processing' ? '付款已完成，正在等待支付通知。请稍后刷新购买状态。'
      : user ? '这是 Stripe 沙盒测试，不会收取真实费用。请选择测试方案。' : '请先使用 Google 登录，购买权益将绑定到账号。');
    el('billingBenefit').textContent = status.experiment === 'adfree' ? '解锁效果：隐藏广告占位区，编辑和导出始终免费。' : '解锁效果：下载 PNG、复制结果和分享图片。';
    const accountText = user ? `已登录：${user.email}` : legacy ? '本浏览器有旧购买记录，请登录并绑定账号。' : '尚未登录 · 同一账号可跨设备恢复权益';
    el('accountSummary').textContent = accountText;
    el('billingIdentity').textContent = accountText;
    for (const id of ['accountLogin', 'billingLogin']) {
      el(id).textContent = legacy ? 'Google 登录并绑定本浏览器购买' : '使用 Google 账号登录';
      el(id).classList.toggle('hidden', !!user && !legacy);
      el(id).disabled = busy || !status.auth?.configured;
    }
    el('accountLogout').classList.toggle('hidden', !user);
    el('accountLogout').disabled = busy;
    el('billingAuthHint').textContent = !status.auth?.configured ? 'Google 登录尚未配置完成，请稍后重试。'
      : legacy ? '请确认选择正确的 Google 账号；旧购买绑定后不能转移到另一个账号。'
      : '仅获取 Google 账号标识、姓名和邮箱，用于登录、账号显示及购买关联。图片和二维码内容始终在本机处理。';
    const accountSelect = el('billingAccountSelect'), selectedAccount = accountSelect.value;
    accountSelect.replaceChildren();
    for (const account of status.accounts || []) {
      const option = document.createElement('option'); option.value = account.id; option.textContent = account.label; accountSelect.appendChild(option);
    }
    if ((status.accounts || []).some(account => account.id === selectedAccount)) accountSelect.value = selectedAccount;
    el('billingAccountSelectLabel').classList.toggle('hidden', (status.accounts?.length || 0) < 2);
    const container = el('billingPlans'); container.replaceChildren();
    for (const plan of status.plans || []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'billing-plan';
      button.dataset.plan = plan.id; button.disabled = busy || status.paid || status.state === 'processing' || !!failure || !user || !status.auth?.configured;
      const title = document.createElement('strong'); title.textContent = plan.id === 'monthly' ? '按月订阅' : '一次性买断';
      const amount = document.createElement('span'); amount.textContent = `${money(plan)}${plan.interval ? ' / 月' : ' / 次'}`;
      const note = document.createElement('small'); note.textContent = plan.id === 'monthly' ? '沙盒内自动续费，可在订阅管理中取消' : '一次测试付款，同一账号跨设备使用';
      button.append(title, amount, note); button.addEventListener('click', () => openStripe('checkout', plan.id)); container.appendChild(button);
    }
    el('billingPortal').classList.toggle('hidden', !status.canManage);
    el('billingPortal').disabled = busy || !!failure;
    el('billingRefresh').disabled = busy;
  }
  async function refresh() {
    if (offline) return status;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try { status = await api('status'); failure = ''; }
      catch (error) { failure = `购买状态暂不可用：${error.message}。请重试。`; status.paid = false; }
      finally { refreshing = null; render(); }
      return status;
    })();
    return refreshing;
  }
  function open() { render(); if (!dialog.open) dialog.showModal(); }
  async function openStripe(kind, plan) {
    if (busy) return;
    // Open synchronously to avoid popup blockers. Keep the original image in memory.
    const tab = window.open('about:blank', '_blank');
    if (!tab) { failure = '请允许本站打开新标签页，然后重试。'; render(); return; }
    tab.opener = null;
    busy = true; failure = ''; render();
    try {
      const data = await api(kind, kind === 'checkout' ? { plan, requestId: crypto.randomUUID() } : { customer: el('billingAccountSelect').value || undefined });
      const target = new URL(data.url);
      if (target.protocol !== 'https:' || target.hostname !== (kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com')) throw new Error('支付链接无效');
      tab.location.replace(target.href);
      if (kind === 'checkout') status.state = 'pending';
    } catch (error) { tab.close(); failure = error.message; }
    finally { busy = false; render(); }
  }
  async function login() {
    if (busy) return;
    const tab = window.open('about:blank', '_blank');
    if (!tab) { failure = '请允许本站打开新标签页，然后重试。'; render(); return; }
    tab.opener = null; busy = true; failure = ''; render();
    try {
      const data = await api('auth/google', { bindLegacy: status.auth?.legacyAvailable === true });
      const target = new URL(data.url);
      if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth') throw new Error('Google 登录链接无效');
      tab.location.replace(target.href);
    } catch (error) { tab.close(); failure = error.message; }
    finally { busy = false; render(); }
  }
  async function logout() {
    if (busy) return;
    busy = true; render();
    try { await refreshing; await api('auth/logout', {}); await refresh(); }
    catch (error) { failure = error.message; }
    finally { busy = false; render(); }
  }
  el('accountLogin').addEventListener('click', login);
  el('billingLogin').addEventListener('click', login);
  el('accountLogout').addEventListener('click', logout);
  el('billingOpen').addEventListener('click', open);
  el('billingClose').addEventListener('click', () => dialog.close());
  el('billingRefresh').addEventListener('click', refresh);
  el('billingPortal').addEventListener('click', () => openStripe('portal'));
  window.addEventListener('focus', () => { if (status.enabled && !busy) void refresh(); });
  window.QRBilling = {
    ready: refresh(),
    async requireExport() {
      if (offline) return true;
      await refresh();
      if (failure || (status.enabled && status.experiment === 'exports' && !status.paid)) { open(); return false; }
      return true;
    },
  };
  const authResult = new URLSearchParams(location.search).get('auth');
  if (authResult) {
    void window.QRBilling.ready.then(() => {
      const messages = { success: 'Google 登录成功。请回到原编辑标签页继续操作。', linked: '登录成功，本浏览器的购买已绑定账号。换设备登录同一账号即可恢复。',
        linked_elsewhere: '登录成功，但此旧购买已绑定其他 Google 账号，请使用原账号登录。', cancel: '已取消 Google 登录，图片与编辑仍保留在原标签页。',
        expired: '登录请求已过期，请重新发起 Google 登录。', invalid: '无法验证登录请求，请从应用重新登录。', failed: 'Google 登录未完成，请重试或检查 OAuth 配置。' };
      open();
      el('billingMessage').textContent = messages[authResult] || '请刷新登录状态后继续。';
      const url = new URL(location.href); url.searchParams.delete('auth'); history.replaceState(null, '', url);
    });
  }
  const result = new URLSearchParams(location.search).get('billing');
  if (['success', 'cancel', 'portal'].includes(result)) {
    void window.QRBilling.ready.then(() => {
      open();
      if (result === 'cancel' && !status.paid && !failure) el('billingMessage').textContent = '已返回应用。未完成付款不会解锁；可关闭此页，回原标签页继续编辑。';
      const url = new URL(location.href); url.searchParams.delete('billing'); history.replaceState(null, '', url);
    });
  }
})();
