const $ = (id) => document.getElementById(id);

// Optional per-client theme overrides (feel free to adjust).
// Keys are client IDs (client1, client2, ...).
const CLIENT_THEMES = {
  client1: { blue: '#0BD3F2', green: '#42EEB7', headerBg: '#000000' },
  client2: { blue: '#0BD3F2', green: '#42EEB7', headerBg: '#000000' },
  client3: { blue: '#0BD3F2', green: '#42EEB7', headerBg: '#000000' },
  client4: { blue: '#0BD3F2', green: '#42EEB7', headerBg: '#000000' }
};

function applyClientTheme(clientId) {
  const theme = CLIENT_THEMES[clientId] || {};
  const root = document.documentElement;
  if (theme.blue) root.style.setProperty('--blue', theme.blue);
  if (theme.green) root.style.setProperty('--green', theme.green);
  if (theme.headerBg) root.style.setProperty('--header-bg', theme.headerBg);
}

function fmtInt(n) {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return '0';
  return new Intl.NumberFormat().format(Math.round(num));
}

function fmtPct(n) {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return '0%';
  return `${num.toFixed(1)}%`;
}

function setStatus(msg) {
  $('status').textContent = msg;
}

// Prevent stale responses from earlier refresh() calls from overwriting UI
// after a user has already switched clients.
let refreshSeq = 0;

async function api(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch { body = { error: res.statusText }; }
    throw new Error(body?.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function drawChart(series) {
  const canvas = $('chart');
  const ctx = canvas.getContext('2d');

  const css = getComputedStyle(document.documentElement);
  const BLUE = (css.getPropertyValue('--blue') || '#0BD3F2').trim();
  const GREEN = (css.getPropertyValue('--green') || '#42EEB7').trim();
  const BLACK = (css.getPropertyValue('--rudiment-black') || '#000000').trim();

  // clear
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!series || series.length === 0) {
    ctx.fillStyle = '#6b7280';
    ctx.font = '14px system-ui';
    ctx.fillText('No EmailBison time series available (missing API key or no campaigns).', 14, 30);
    return;
  }

  const padding = 30;
  const w = canvas.width - padding * 2;
  const h = canvas.height - padding * 2;

  const maxVal = Math.max(
    1,
    ...series.map(d => Math.max(d.sent, d.replied, d.interested, d.bounced))
  );

  // axes
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, padding);
  ctx.lineTo(padding, padding + h);
  ctx.lineTo(padding + w, padding + h);
  ctx.stroke();

  const x = (i) => padding + (i * w) / Math.max(1, series.length - 1);
  const y = (v) => padding + h - (v * h) / maxVal;

  function line(values, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const xi = x(i);
      const yi = y(v);
      if (i === 0) ctx.moveTo(xi, yi);
      else ctx.lineTo(xi, yi);
    });
    ctx.stroke();
  }

  function area(values, color) {
    const grad = ctx.createLinearGradient(0, padding, 0, padding + h);
    grad.addColorStop(0, `${color}33`); // ~20% alpha
    grad.addColorStop(1, `${color}00`);

    ctx.fillStyle = grad;
    ctx.beginPath();
    values.forEach((v, i) => {
      const xi = x(i);
      const yi = y(v);
      if (i === 0) ctx.moveTo(xi, yi);
      else ctx.lineTo(xi, yi);
    });
    // close shape to x-axis
    ctx.lineTo(x(values.length - 1), padding + h);
    ctx.lineTo(x(0), padding + h);
    ctx.closePath();
    ctx.fill();
  }
  // Palette (themeable via CSS variables)
  const sentVals = series.map(d => d.sent);
  area(sentVals, BLUE);
  line(sentVals, BLUE);        // sent
  line(series.map(d => d.replied), GREEN);     // replied
  line(series.map(d => d.interested), BLACK);  // interested
  line(series.map(d => d.bounced), '#ef4444');     // bounced (keep red for clarity)

  // legend
  ctx.font = '12px system-ui';
  const legend = [
    ['Sent', BLUE],
    ['Replied', GREEN],
    ['Interested', BLACK],
    ['Bounced', '#ef4444']
  ];
  let lx = padding;
  const ly = 16;
  legend.forEach(([label, color]) => {
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly - 9, 10, 10);
    ctx.fillStyle = '#000000';
    ctx.fillText(label, lx + 14, ly);
    lx += 90;
  });
}

function renderCampaigns(campaigns) {
  const tbody = $('campaignTable').querySelector('tbody');
  tbody.innerHTML = '';
  const rows = campaigns || [];

  rows.sort((a, b) => (b.sent || 0) - (a.sent || 0));

  for (const c of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="pill">${c.platform}</span></td>
      <td>${(c.campaignName || c.campaignId || '').toString()}</td>
      <td>${fmtInt(c.sent)}</td>
      <td>${fmtInt(c.replies)}</td>
      <td>${fmtInt(c.interested)}</td>
      <td>${fmtPct(c.bounceRate)}</td>
      <td>${fmtPct(c.replyRate)}</td>
      <td>${fmtInt(c.leadsRemaining)} / ${fmtInt(c.leadsTotal)}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadClients() {
  const data = await api('/api/clients');
  const select = $('clientSelect');
  select.innerHTML = '';
  const clients = data.clients || [];
  if (clients.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No active clients (check .env)';
    select.appendChild(opt);
    return;
  }

  for (const c of clients) {
    const opt = document.createElement('option');
    opt.value = c.id;
    // Hide internal client id (client1/client2/...) in the UI.
    opt.textContent = `${c.name}`;
    select.appendChild(opt);
  }

  // Apply theme for the default-selected client.
  applyClientTheme(select.value);

  // Set header/subtitle for default client.
  const active = clients.find(x => x.id === select.value);
  if (active) {
    $('pageTitle').textContent = 'Rudiment Campaign Overview';
    $('pageSubtitle').textContent = active?.name ? `for ${active.name}` : '—';
  }
}

async function refresh() {
  const clientId = $('clientSelect').value;
  const days = $('daysSelect').value;
  const status = $('statusSelect')?.value || 'active';
  if (!clientId) return;

  const seq = ++refreshSeq;

  // Update header immediately from selected option to avoid “wrong client” header.
  const selectedName = $('clientSelect')?.selectedOptions?.[0]?.textContent;
  $('pageTitle').textContent = 'Rudiment Campaign Overview';
  $('pageSubtitle').textContent = selectedName ? `for ${selectedName}` : '—';

  applyClientTheme(clientId);

  const btn = $('refreshBtn');
  btn.disabled = true;
  setStatus('Loading…');

  try {
    const [summary, campaigns, series] = await Promise.all([
      api(`/api/summary?clientId=${encodeURIComponent(clientId)}&days=${encodeURIComponent(days)}&status=${encodeURIComponent(status)}`),
      api(`/api/campaigns?clientId=${encodeURIComponent(clientId)}&days=${encodeURIComponent(days)}&status=${encodeURIComponent(status)}`),
      // timeseries remains EmailBison-focused; still filter by status for consistency
      api(`/api/timeseries?clientId=${encodeURIComponent(clientId)}&days=${encodeURIComponent(days)}&status=${encodeURIComponent(status)}`)
    ]);

    // If a newer refresh started after this one, ignore these results.
    if (seq !== refreshSeq) return;

    // Update header “for <Client Name>”
    $('pageTitle').textContent = 'Rudiment Campaign Overview';
    $('pageSubtitle').textContent = campaigns?.clientName ? `for ${campaigns.clientName}` : '—';

    const s = summary.summary;
    $('sent').textContent = fmtInt(s.totals.sent);
    $('contacted').textContent = fmtInt(s.totals.contacted);
    $('replied').textContent = fmtInt(s.totals.replied);
    $('interested').textContent = fmtInt(s.totals.interested);
    $('replyRate').textContent = fmtPct(s.rates.replyRate);
    $('bounceRate').textContent = fmtPct(s.rates.bounceRate);

    renderCampaigns(campaigns.campaigns);

    $('rangeHint').textContent = `${series.startDate} → ${series.endDate}`;
    drawChart(series.series);

    setStatus(`Updated at ${new Date().toLocaleString()}`);
  } catch (err) {
    if (seq !== refreshSeq) return;
    console.error(err);
    setStatus(`Error: ${err.message}`);
  } finally {
    if (seq !== refreshSeq) return;
    btn.disabled = false;
  }
}

async function main() {
  await loadClients();
  $('refreshBtn').addEventListener('click', refresh);
  $('clientSelect').addEventListener('change', refresh);
  $('daysSelect').addEventListener('change', refresh);
  $('statusSelect').addEventListener('change', refresh);

  // auto-refresh once
  await refresh();
}

main().catch((e) => {
  console.error(e);
  setStatus(`Error: ${e.message}`);
});
