const $ = (id) => document.getElementById(id);

function fmtInt(n) {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return '0';
  return new Intl.NumberFormat().format(Math.round(num));
}

function fmtPct(n) {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return '—';
  return `${num.toFixed(1)}%`;
}

function setStatus(msg) {
  $('status').textContent = msg;
}

async function api(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch { body = { error: res.statusText }; }
    throw new Error(body?.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function pillClassForHealth(s) {
  const st = String(s || '').toLowerCase();
  if (st === 'good') return 'pill pill--good';
  if (st === 'review') return 'pill pill--review';
  if (st === 'at_risk' || st === 'at risk') return 'pill pill--risk';
  return 'pill pill--subtle';
}

function labelForHealth(s) {
  const st = String(s || '').toLowerCase();
  if (st === 'at_risk') return 'At Risk';
  if (st === 'review') return 'Review';
  if (st === 'good') return 'Good';
  return 'N/A';
}

function labelForClientStatus(s) {
  const st = String(s || '').toLowerCase();
  if (st === 'active') return 'Active';
  if (st === 'paused') return 'Paused';
  if (st === 'stopped') return 'Stopped';
  return '—';
}

function pillClassForClientStatus(s) {
  const st = String(s || '').toLowerCase();
  if (st === 'active') return 'pill pill--active';
  if (st === 'paused') return 'pill pill--review';
  if (st === 'stopped') return 'pill pill--subtle';
  return 'pill pill--subtle';
}

function renderRows(items) {
  const root = $('clientRows');
  root.innerHTML = '';

  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    root.innerHTML = `<div style="opacity:0.7; padding: 10px 4px;">No active clients found (check .env keys).</div>`;
    return;
  }

  for (const c of rows) {
    const leads = c?.kpis?.leadsRemaining != null
      ? `${fmtInt(c.kpis.leadsRemaining)}/${fmtInt(c.kpis.leadsTotal)}`
      : '—';

    const seq = Number.isFinite(Number(c?.kpis?.sequenceEndingDays))
      ? String(Math.round(Number(c.kpis.sequenceEndingDays)))
      : '—';

    const el = document.createElement('div');
    el.className = 'monitorRow';
    el.innerHTML = `
      <div class="monitorRow__left">
        <div class="monitorRow__name">${String(c.clientName || c.clientId || '—')}</div>
        <div class="monitorRow__meta">
          <span class="${pillClassForClientStatus(c.clientStatus)}">${labelForClientStatus(c.clientStatus)}</span>
          <div class="monitorRow__health">
            <div class="monitorRow__healthLine">
              <span class="monitorRow__healthLabel">Campaign Health</span>
              <span class="${pillClassForHealth(c.campaignHealth)}">${labelForHealth(c.campaignHealth)}</span>
            </div>
            <div class="monitorRow__healthLine">
              <span class="monitorRow__healthLabel">Account Health</span>
              <span class="${pillClassForHealth(c.accountHealth)}">${labelForHealth(c.accountHealth)}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="monitorRow__kpis">
        <div class="kpi">
          <div class="kpi__value">${leads}</div>
          <div class="kpi__label">Leads Remaining</div>
        </div>
        <div class="kpi">
          <div class="kpi__value">${fmtPct(c?.kpis?.replyRate)}</div>
          <div class="kpi__label">Reply Rate</div>
        </div>
        <div class="kpi">
          <div class="kpi__value">${fmtPct(c?.kpis?.positiveReplyRate)}</div>
          <div class="kpi__label">Positive Reply Rate</div>
        </div>
        <div class="kpi">
          <div class="kpi__value">${fmtPct(c?.kpis?.bounceRate)}</div>
          <div class="kpi__label">Bounce Rate</div>
        </div>
        <div class="kpi">
          <div class="kpi__value">${seq}</div>
          <div class="kpi__label">Sequence Ending (days)</div>
        </div>
      </div>
    `;

    root.appendChild(el);
  }
}

let refreshSeq = 0;

async function refresh() {
  const days = $('daysSelect').value;
  const seq = ++refreshSeq;
  const btn = $('refreshBtn');
  btn.disabled = true;
  setStatus('Loading…');

  try {
    const data = await api(`/api/monitor?days=${encodeURIComponent(days)}`);
    if (seq !== refreshSeq) return;
    $('rangeHint').textContent = `${data?.window?.startDate || '—'} → ${data?.window?.endDate || '—'}`;
    renderRows(data.clients);
    setStatus(`Updated at ${new Date().toLocaleString()}`);
  } catch (e) {
    if (seq !== refreshSeq) return;
    console.error(e);
    setStatus(`Error: ${e.message}`);
  } finally {
    if (seq !== refreshSeq) return;
    btn.disabled = false;
  }
}

async function main() {
  $('refreshBtn').addEventListener('click', refresh);
  $('daysSelect').addEventListener('change', refresh);
  await refresh();

  // Optional auto-refresh (1 min). Set to 0 to disable.
  const intervalSec = Number(window.MONITOR_AUTO_REFRESH_SECONDS || 60);
  if (Number.isFinite(intervalSec) && intervalSec > 0) {
    setInterval(() => refresh(), intervalSec * 1000);
  }
}

main().catch((e) => {
  console.error(e);
  setStatus(`Error: ${e.message}`);
});
