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

let repliesFilter = 'replied';
let repliesPlatform = 'emailbison';
let repliesWarning = null;

// Chart animation state (for smooth transitions between refreshes)
let lastChartSeries = null;
let chartAnimRaf = null;

async function api(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch { body = { error: res.statusText }; }
    throw new Error(body?.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function shorten(text, n) {
  const s = String(text ?? '').trim();
  if (!s) return '—';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function setRepliesTab(filter) {
  repliesFilter = filter;
  const btnReplied = $('repliesTabReplied');
  const btnInterested = $('repliesTabInterested');
  if (!btnReplied || !btnInterested) return;

  const isReplied = filter === 'replied';
  btnReplied.classList.toggle('tab--active', isReplied);
  btnInterested.classList.toggle('tab--active', !isReplied);
  btnReplied.setAttribute('aria-selected', isReplied ? 'true' : 'false');
  btnInterested.setAttribute('aria-selected', !isReplied ? 'true' : 'false');
}

function setRepliesPlatform(platform) {
  repliesPlatform = String(platform || 'emailbison').toLowerCase();
  const hint = $('repliesHint');
  if (hint) {
    hint.textContent = repliesPlatform === 'instantly' ? 'Instantly (Unibox)' : 'EmailBison (Send)';
  }

  // UX: if user switches to Instantly while being on Interested tab (from EmailBison),
  // they end up seeing an empty state that looks like “All Replies missing”.
  // Default Instantly to All Replies.
  if (repliesPlatform === 'instantly' && repliesFilter === 'interested') {
    setRepliesTab('replied');
  }

  // Interested is supported for Instantly via:
  // - official opportunities (if scope exists)
  // - heuristic fallback (if scope missing)
  // so don't disable the tab.
  const btnInterested = $('repliesTabInterested');
  if (btnInterested) btnInterested.disabled = false;
}

function renderReplies(items) {
  const table = $('repliesTable');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';
  const rows = items || [];

  if (!rows.length) {
    const tr = document.createElement('tr');
    // Better UX: make Instantly limitations explicit.
    let msg = 'No replies found for this range/filter.';
    if (repliesWarning) msg = String(repliesWarning);
    tr.innerHTML = `<td colspan="6" style="opacity:0.75;">${msg}</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="pill pill--subtle">${String(r.category || 'replied')}</span></td>
      <td>${shorten(r.fullName || '—', 36)}</td>
      <td>${shorten(r.email || '—', 36)}</td>
      <td>${shorten(r.campaignName || r.campaignId || '—', 40)}</td>
      <td>${fmtDateTime(r.replyDate)}</td>
      <td title="${String(r.message || '').replace(/\"/g, '&quot;')}">${shorten(r.message || '—', 140)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(a, b, t) {
  const aa = Number(a ?? 0);
  const bb = Number(b ?? 0);
  return aa + (bb - aa) * t;
}

function lerpSeries(from, to, t) {
  const n = Math.min(from.length, to.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = from[i] || {};
    const b = to[i] || {};
    out[i] = {
      sent: lerp(a.sent, b.sent, t),
      replied: lerp(a.replied, b.replied, t),
      interested: lerp(a.interested, b.interested, t),
      bounced: lerp(a.bounced, b.bounced, t)
    };
  }
  return out;
}

function setChartSeries(next) {
  const series = Array.isArray(next) ? next : [];

  // First render or incompatible series length => jump (no animation)
  if (!lastChartSeries || !Array.isArray(lastChartSeries) || lastChartSeries.length !== series.length) {
    lastChartSeries = series;
    drawChart(series);
    return;
  }

  // Cancel any in-flight animation
  if (chartAnimRaf) cancelAnimationFrame(chartAnimRaf);

  const from = lastChartSeries;
  const to = series;
  const startedAt = performance.now();
  const durationMs = 520;

  const tick = (now) => {
    const p = Math.min(1, (now - startedAt) / durationMs);
    const t = easeInOutCubic(p);
    drawChart(lerpSeries(from, to, t), { maxFrom: from, maxTo: to });
    if (p < 1) chartAnimRaf = requestAnimationFrame(tick);
    else {
      chartAnimRaf = null;
      lastChartSeries = to;
      drawChart(to);
    }
  };

  chartAnimRaf = requestAnimationFrame(tick);
}

function drawChart(series, opts) {
  const canvas = $('chart');
  const ctx = canvas.getContext('2d');

  const css = getComputedStyle(document.documentElement);
  const BLUE = (css.getPropertyValue('--blue') || '#0BD3F2').trim();
  const GREEN = (css.getPropertyValue('--green') || '#42EEB7').trim();
  const TEXT = (css.getPropertyValue('--text') || 'rgba(255, 255, 255, 0.92)').trim();

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

  // Keep y-scale stable during animation by considering both series.
  const maxSeries = (s) => Math.max(1, ...s.map(d => Math.max(d.sent, d.replied, d.interested, d.bounced)));
  const maxVal = Math.max(
    1,
    maxSeries(series),
    opts?.maxFrom ? maxSeries(opts.maxFrom) : 1,
    opts?.maxTo ? maxSeries(opts.maxTo) : 1
  );

  // axes
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, padding);
  ctx.lineTo(padding, padding + h);
  ctx.lineTo(padding + w, padding + h);
  ctx.stroke();

  // subtle horizontal grid lines (adds depth like the reference)
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75]) {
    const gy = padding + h - h * frac;
    ctx.beginPath();
    ctx.moveTo(padding, gy);
    ctx.lineTo(padding + w, gy);
    ctx.stroke();
  }

  const x = (i) => padding + (i * w) / Math.max(1, series.length - 1);
  const y = (v) => padding + h - (v * h) / maxVal;

  function smoothPath(values) {
    const pts = (values || []).map((v, i) => ({ x: x(i), y: y(v) }));
    if (pts.length === 0) return;
    if (pts.length === 1) {
      ctx.moveTo(pts[0].x, pts[0].y);
      return;
    }

    // Smooth curves (Catmull–Rom -> Bezier).
    // Lower tension => softer, more fluid curves.
    const tension = 0.2;

    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;

      const cp1x = p1.x + ((p2.x - p0.x) / 6) * (1 - tension);
      const cp1y = p1.y + ((p2.y - p0.y) / 6) * (1 - tension);
      const cp2x = p2.x - ((p3.x - p1.x) / 6) * (1 - tension);
      const cp2y = p2.y - ((p3.y - p1.y) / 6) * (1 - tension);

      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  }

  function line(values, color) {
    // softer look like the reference screenshot
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.strokeStyle = color;
    ctx.lineWidth = 3;

    // subtle glow
    ctx.shadowColor = `${color}55`;
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    ctx.beginPath();
    smoothPath(values);
    ctx.stroke();

    // reset shadow so other elements (legend) stay crisp
    ctx.shadowBlur = 0;
  }

  function area(values, color) {
    const grad = ctx.createLinearGradient(0, padding, 0, padding + h);
    // Multi-stop gradient for a softer fill
    grad.addColorStop(0, `${color}40`);   // ~25% alpha
    grad.addColorStop(0.55, `${color}14`); // ~8% alpha
    grad.addColorStop(1, `${color}00`);

    ctx.fillStyle = grad;
    ctx.beginPath();
    smoothPath(values);
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
  line(series.map(d => d.interested), TEXT);  // interested
  line(series.map(d => d.bounced), '#ef4444');     // bounced (keep red for clarity)

  // point markers (soft + subtle)
  function points(values, color) {
    const pts = (values || []).map((v, i) => ({ x: x(i), y: y(v) }));
    // Make dots barely visible (or effectively off) to reduce noise.
    // If you want them fully removed, we can delete this call entirely.
    ctx.fillStyle = `${color}1f`; // ~12% alpha
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.25, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  points(sentVals, BLUE);
  points(series.map(d => d.replied), GREEN);
  points(series.map(d => d.interested), TEXT);
  points(series.map(d => d.bounced), '#ef4444');

  // legend
  ctx.font = '12px system-ui';
  const legend = [
    ['Sent', BLUE],
    ['Replied', GREEN],
    ['Interested', TEXT],
    ['Bounced', '#ef4444']
  ];
  let lx = padding;
  const ly = 16;
  legend.forEach(([label, color]) => {
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly - 9, 10, 10);
    ctx.fillStyle = TEXT;
    ctx.fillText(label, lx + 14, ly);
    lx += 90;
  });
}

function platformLabel(platform) {
  const p = String(platform || '').toLowerCase();
  if (p === 'emailbison') return 'EmailBison';
  if (p === 'instantly') return 'Instantly';
  if (p === 'heyreach') return 'HeyReach';
  return platform;
}

function renderEmailCampaigns(campaigns) {
  const tbody = $('emailCampaignTable').querySelector('tbody');
  tbody.innerHTML = '';
  const rows = (campaigns || []).filter(c => String(c.platform) !== 'heyreach');

  rows.sort((a, b) => (b.sent || 0) - (a.sent || 0));

  for (const c of rows) {
    const tr = document.createElement('tr');

    // EmailBison: positive reply % is Interested / Unique Replies (called “Interested %” in UI).
    // Our API exposes it as `interestedRate` (0-100). Other platforms may not have it.
    const positiveReplyPct =
      Number.isFinite(Number(c.interestedRate))
        ? fmtPct(Number(c.interestedRate))
        : '—';
    tr.innerHTML = `
      <td><span class="pill">${platformLabel(c.platform)}</span></td>
      <td>${(c.campaignName || c.campaignId || '').toString()}</td>
      <td>${fmtInt(c.sent)}</td>
      <td>${fmtInt(c.replies)}</td>
      <td>${fmtInt(c.interested)}</td>
      <td>${fmtPct(c.bounceRate)}</td>
      <td>${fmtPct(c.replyRate)}</td>
      <td>${positiveReplyPct}</td>
      <td>${fmtInt(c.leadsRemaining)} / ${fmtInt(c.leadsTotal)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderHeyReachCampaigns(campaigns) {
  const tbody = $('heyreachCampaignTable').querySelector('tbody');
  tbody.innerHTML = '';
  const rows = (campaigns || []).filter(c => String(c.platform) === 'heyreach');

  // Sort by connections sent primarily
  rows.sort((a, b) => (b.connectionsSent || 0) - (a.connectionsSent || 0));

  for (const c of rows) {
    const tr = document.createElement('tr');

    const hasEng = c.hasEngagementStats === true;
    tr.innerHTML = `
      <td><span class="pill">${platformLabel(c.platform)}</span></td>
      <td>${(c.campaignName || c.campaignId || '').toString()}</td>
      <td>${hasEng ? fmtInt(c.connectionsSent) : '—'}</td>
      <td>${hasEng ? fmtInt(c.connectionsAccepted) : '—'}</td>
      <td>${hasEng ? fmtPct(c.connectionAcceptanceRate) : '—'}</td>
      <td>${hasEng ? fmtInt(c.messagesSent) : '—'}</td>
      <td>${hasEng ? fmtInt(c.messageReplies) : '—'}</td>
      <td>${hasEng ? fmtPct(c.messageReplyRate) : '—'}</td>
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
}

async function refresh() {
  const clientId = $('clientSelect').value;
  const days = $('daysSelect').value;
  const status = $('statusSelect')?.value || 'active';
  if (!clientId) return;

  const seq = ++refreshSeq;

  applyClientTheme(clientId);

  const btn = $('refreshBtn');
  btn.disabled = true;
  setStatus('Loading…');

  try {
    const [summary, campaigns, series, replies] = await Promise.all([
      api(`/api/summary?clientId=${encodeURIComponent(clientId)}&days=${encodeURIComponent(days)}&status=${encodeURIComponent(status)}`),
      api(`/api/campaigns?clientId=${encodeURIComponent(clientId)}&days=${encodeURIComponent(days)}&status=${encodeURIComponent(status)}`),
      // timeseries remains EmailBison-focused; still filter by status for consistency
      api(`/api/timeseries?clientId=${encodeURIComponent(clientId)}&days=${encodeURIComponent(days)}&status=${encodeURIComponent(status)}`),
      api(`/api/replies?clientId=${encodeURIComponent(clientId)}&platform=${encodeURIComponent(repliesPlatform)}&filter=${encodeURIComponent(repliesFilter)}&days=${encodeURIComponent(days)}&status=${encodeURIComponent(status)}&limit=50`)
    ]);

    // If a newer refresh started after this one, ignore these results.
    if (seq !== refreshSeq) return;

    const s = summary.summary;
    $('sent').textContent = fmtInt(s.totals.sent);
    $('contacted').textContent = fmtInt(s.totals.contacted);
    $('replied').textContent = fmtInt(s.totals.replied);
    $('interested').textContent = fmtInt(s.totals.interested);
    $('replyRate').textContent = fmtPct(s.rates.replyRate);
    $('positiveReplyRate').textContent = fmtPct(s.rates.positiveReplyRate ?? 0);
    $('bounceRate').textContent = fmtPct(s.rates.bounceRate);

    // HeyReach summary (separate KPI block)
    const hr = summary.heyreach;
    if (hr && hr.totals) {
      $('hrConnectionsSent').textContent = fmtInt(hr.totals.connectionsSent);
      $('hrConnectionsAccepted').textContent = fmtInt(hr.totals.connectionsAccepted);
      $('hrAcceptanceRate').textContent = fmtPct(hr.rates?.acceptanceRate ?? 0);
      $('hrMessagesSent').textContent = fmtInt(hr.totals.messagesSent);
      $('hrMessageReplies').textContent = fmtInt(hr.totals.messageReplies);
      $('hrMessageReplyRate').textContent = fmtPct(hr.rates?.messageReplyRate ?? 0);
      // InMail KPIs intentionally omitted for now.
    } else {
      // If HeyReach not enabled for this client, keep placeholders.
      $('hrConnectionsSent').textContent = '—';
      $('hrConnectionsAccepted').textContent = '—';
      $('hrAcceptanceRate').textContent = '—';
      $('hrMessagesSent').textContent = '—';
      $('hrMessageReplies').textContent = '—';
      $('hrMessageReplyRate').textContent = '—';
      // InMail KPIs intentionally omitted for now.
    }

    renderEmailCampaigns(campaigns.campaigns);
    renderHeyReachCampaigns(campaigns.campaigns);

    $('rangeHint').textContent = `${series.startDate} → ${series.endDate}`;
    setChartSeries(series.series);

    repliesWarning = replies?.warning ?? null;
    renderReplies(replies.items);

    // Hint when HeyReach per-campaign stats are warming up.
    if (campaigns?.heyreachStatsCache?.status === 'warming') {
      setStatus(`HeyReach per-campaign stats warming… refresh in ~10–30s (${new Date().toLocaleString()})`);
    } else {
      setStatus(`Updated at ${new Date().toLocaleString()}`);
    }
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

  // Replies tabs
  const btnReplied = $('repliesTabReplied');
  const btnInterested = $('repliesTabInterested');
  if (btnReplied && btnInterested) {
    btnReplied.addEventListener('click', () => { setRepliesTab('replied'); refresh(); });
    btnInterested.addEventListener('click', () => { setRepliesTab('interested'); refresh(); });
  }

  // Replies platform selector
  const plat = $('repliesPlatformSelect');
  if (plat) {
    setRepliesPlatform(plat.value);
    plat.addEventListener('change', () => { setRepliesPlatform(plat.value); refresh(); });
  } else {
    setRepliesPlatform('emailbison');
  }

  setRepliesTab('replied');

  // auto-refresh once
  await refresh();
}

main().catch((e) => {
  console.error(e);
  setStatus(`Error: ${e.message}`);
});
