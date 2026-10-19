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
    const response = await fetch(`/api/billing/${path}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
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
    const visible = status.enabled || !!failure;
    el('billingPanel').classList.toggle('hidden', !visible);
    el('billingAd').classList.toggle('hidden', !status.enabled || status.experiment !== 'adfree' || status.paid);
    el('billingSummary').textContent = failure || (status.paid ? `已解锁 · ${status.plan === 'monthly' ? '测试月订阅' : '测试买断'}${status.cancelAtPeriodEnd ? '（到期取消）' : ''}`
      : status.experiment === 'adfree' ? '免费编辑与导出；付费后隐藏广告占位区。' : '免费导入、编辑与验证；测试购买后可下载、复制和分享。');
    el('billingOpen').textContent = status.paid ? '查看购买状态' : '查看测试方案';
    el('billingMessage').textContent = failure || (status.paid ? '测试权益已生效。请回到原来的编辑标签页继续导出。'
      : status.state === 'pending' ? '已打开测试结账页。付款后点击“刷新购买状态”，不必重新导入图片。'
      : status.state === 'processing' ? '付款已完成，正在等待支付通知。请稍后刷新购买状态。'
      : '这是 Stripe 沙盒测试，不会收取真实费用。请选择测试方案。');
    el('billingBenefit').textContent = status.experiment === 'adfree' ? '解锁效果：隐藏广告占位区，编辑和导出始终免费。' : '解锁效果：下载 PNG、复制结果和分享图片。';
    const container = el('billingPlans'); container.replaceChildren();
    for (const plan of status.plans || []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'billing-plan';
      button.dataset.plan = plan.id; button.disabled = busy || status.paid || status.state === 'processing' || !!failure;
      const title = document.createElement('strong'); title.textContent = plan.id === 'monthly' ? '按月订阅' : '一次性买断';
      const amount = document.createElement('span'); amount.textContent = `${money(plan)}${plan.interval ? ' / 月' : ' / 次'}`;
      const note = document.createElement('small'); note.textContent = plan.id === 'monthly' ? '沙盒内自动续费，可在订阅管理中取消' : '一次测试付款，当前浏览器持续使用';
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
      const data = await api(kind, kind === 'checkout' ? { plan, requestId: crypto.randomUUID() } : {});
      const target = new URL(data.url);
      if (target.protocol !== 'https:' || target.hostname !== (kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com')) throw new Error('支付链接无效');
      tab.location.replace(target.href);
      if (kind === 'checkout') status.state = 'pending';
    } catch (error) { tab.close(); failure = error.message; }
    finally { busy = false; render(); }
  }
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
  const result = new URLSearchParams(location.search).get('billing');
  if (['success', 'cancel', 'portal'].includes(result)) {
    void window.QRBilling.ready.then(() => {
      open();
      if (result === 'cancel' && !status.paid && !failure) el('billingMessage').textContent = '已返回应用。未完成付款不会解锁；可关闭此页，回原标签页继续编辑。';
      const url = new URL(location.href); url.searchParams.delete('billing'); history.replaceState(null, '', url);
    });
  }
})();
