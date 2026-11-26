(function () {
  'use strict';

  const DATA_BASE = 'data';
  const VERSIONS_FILE = `${DATA_BASE}/versions.json`;
  const HISTORY_FILE = `${DATA_BASE}/history.json`;

  const state = {
    versionsData: null,
    currentVersion: 'overview',
    versionJobs: {},
    versionRuns: {},
    historyData: null,
    expandedJobId: null,
    filters: { status: 'ALL', trend: 'ALL', platform: 'ALL', search: '', sort: 'pass_rate_asc' }
  };

  let overviewBarChart = null;
  let failureCategoryChart = null;
  let trendChart = null;
  let searchTimeout = null;

  // --- Helpers ---

  function passRateClass(rate) {
    if (rate >= 90) return 'good';
    if (rate >= 70) return 'warn';
    return 'bad';
  }

  function statusBadgeClass(status) {
    switch (status) {
      case 'PASSING': return 'passing';
      case 'FAILING': return 'failing';
      case 'NEVER_PASSED': return 'never-passed';
      default: return 'no-runs';
    }
  }

  function trendArrow(trend) {
    switch (trend) {
      case 'IMPROVING': return { text: '▲', cls: 'improving' };
      case 'DEGRADING': return { text: '▼', cls: 'degrading' };
      default: return { text: '—', cls: 'stable' };
    }
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 86400000) return 'Today';
    if (diff < 172800000) return 'Yesterday';
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function deltaHtml(current, previous, suffix, invert) {
    if (previous === undefined || previous === null) return '';
    const diff = current - previous;
    if (Math.abs(diff) < 0.01) return '<span class="card-delta neutral">— no change</span>';
    const isPositive = invert ? diff < 0 : diff > 0;
    const arrow = isPositive ? '▲' : '▼';
    const cls = isPositive ? 'positive' : 'negative';
    return `<span class="card-delta ${cls}">${arrow} ${Math.abs(diff).toFixed(1)}${suffix || ''} vs prev</span>`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
  }

  // --- Data fetching ---

  async function fetchJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    return res.json();
  }

  async function loadVersionsData() {
    state.versionsData = await fetchJSON(VERSIONS_FILE);
  }

  async function loadVersionDetail(version) {
    if (state.versionJobs[version]) return;
    const [jobsData, runsData] = await Promise.all([
      fetchJSON(`${DATA_BASE}/${version}.json`),
      fetchJSON(`${DATA_BASE}/runs/${version}.json`).catch(() => null)
    ]);
    state.versionJobs[version] = jobsData;
    state.versionRuns[version] = runsData;
  }

  async function loadHistory() {
    try {
      state.historyData = await fetchJSON(HISTORY_FILE);
    } catch {
      state.historyData = null;
    }
  }

  // --- Hash navigation ---

  function readHash() {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    if (params.has('version')) state.currentVersion = params.get('version');
    if (params.has('status')) state.filters.status = params.get('status');
    if (params.has('trend')) state.filters.trend = params.get('trend');
    if (params.has('platform')) state.filters.platform = params.get('platform');
    if (params.has('search')) state.filters.search = params.get('search');
    if (params.has('sort')) state.filters.sort = params.get('sort');
  }

  function writeHash() {
    const params = new URLSearchParams();
    params.set('version', state.currentVersion);
    if (state.filters.status !== 'ALL') params.set('status', state.filters.status);
    if (state.filters.trend !== 'ALL') params.set('trend', state.filters.trend);
    if (state.filters.platform !== 'ALL') params.set('platform', state.filters.platform);
    if (state.filters.search) params.set('search', state.filters.search);
    if (state.filters.sort !== 'pass_rate_asc') params.set('sort', state.filters.sort);
    window.location.hash = params.toString();
  }

  // --- Rendering ---

  function renderVersionTabs() {
    const container = document.getElementById('version-tabs');
    const versions = state.versionsData.versions;
    const summary = state.versionsData.summary;

    let html = '<button class="version-tab' + (state.currentVersion === 'overview' ? ' active' : '') +
      '" data-version="overview">Overview</button>';

    for (const v of versions) {
      const s = summary[v];
      const rate = s ? s.pass_rate : 0;
      const cls = passRateClass(rate);
      const active = state.currentVersion === v ? ' active' : '';
      html += `<button class="version-tab${active}" data-version="${v}">
        ${v} <span class="badge ${cls}">${rate.toFixed(0)}%</span>
      </button>`;
    }

    container.innerHTML = html;

    container.querySelectorAll('.version-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        state.currentVersion = btn.dataset.version;
        state.expandedJobId = null;
        writeHash();
        renderAll();
      });
    });
  }

  function renderHealthIndicator() {
    const el = document.getElementById('health-indicator');
    const updated = document.getElementById('last-updated');

    if (!state.versionsData) return;

    updated.textContent = 'Updated: ' + formatDateTime(state.versionsData.last_updated);

    const versions = state.versionsData.versions;
    const summary = state.versionsData.summary;
    let total = 0, weighted = 0;
    for (const v of versions) {
      const s = summary[v];
      if (s) { total += s.total_jobs; weighted += s.pass_rate * s.total_jobs; }
    }
    const avg = total > 0 ? weighted / total : 0;
    el.className = 'health-indicator ' + passRateClass(avg);
    el.title = `Overall health: ${avg.toFixed(1)}%`;
  }

  function renderOverview() {
    const section = document.getElementById('overview-section');
    const versionSection = document.getElementById('version-section');

    if (state.currentVersion !== 'overview') {
      section.classList.add('hidden');
      versionSection.classList.remove('hidden');
      return;
    }

    section.classList.remove('hidden');
    versionSection.classList.add('hidden');

    const versions = state.versionsData.versions;
    const summary = state.versionsData.summary;

    // Bar chart
    const labels = versions.slice().reverse();
    const rates = labels.map(v => summary[v] ? summary[v].pass_rate : 0);
    const bgColors = rates.map(r => {
      if (r >= 90) return 'rgba(0,196,140,0.7)';
      if (r >= 70) return 'rgba(255,179,71,0.7)';
      return 'rgba(255,107,107,0.7)';
    });

    if (overviewBarChart) overviewBarChart.destroy();
    const ctx = document.getElementById('overview-bar-chart').getContext('2d');
    overviewBarChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Pass Rate %',
          data: rates,
          backgroundColor: bgColors,
          borderRadius: 4,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e1e36',
            titleColor: '#e8e8f0',
            bodyColor: '#a0a0b8',
            borderColor: '#2a2a4a',
            borderWidth: 1,
            callbacks: {
              label: ctx => `Pass Rate: ${ctx.parsed.y.toFixed(1)}%`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            grid: { color: 'rgba(42,42,74,0.5)' },
            ticks: { color: '#6a6a88', callback: v => v + '%' }
          },
          x: {
            grid: { display: false },
            ticks: { color: '#a0a0b8' }
          }
        }
      }
    });

    // Table
    const tbody = document.querySelector('#overview-table tbody');
    let tableHtml = '';
    for (const v of versions) {
      const s = summary[v] || {};
      const rate = s.pass_rate || 0;
      const cls = passRateClass(rate);
      tableHtml += `<tr data-version="${v}">
        <td><strong>${v}</strong></td>
        <td>${s.total_jobs || 0}</td>
        <td><span class="pass-rate-bar">
          <span class="bar-bg"><span class="bar-fill ${cls}" style="width:${rate}%"></span></span>
          ${rate.toFixed(1)}%
        </span></td>
        <td>${s.passing_jobs || 0}</td>
        <td style="color:var(--red)">${s.failing_jobs || 0}</td>
        <td>${s.infrastructure_failures || 0}</td>
      </tr>`;
    }
    tbody.innerHTML = tableHtml;

    tbody.querySelectorAll('tr').forEach(row => {
      row.addEventListener('click', () => {
        state.currentVersion = row.dataset.version;
        state.expandedJobId = null;
        writeHash();
        renderAll();
      });
    });
  }

  function renderSummaryCards() {
    if (state.currentVersion === 'overview') return;
    const summary = state.versionsData.summary[state.currentVersion];
    if (!summary) return;

    document.getElementById('card-total-jobs').textContent = summary.total_jobs;
    document.getElementById('card-total-jobs-delta').innerHTML =
      deltaHtml(summary.total_runs_current, summary.total_runs_previous, ' runs');

    const rateEl = document.getElementById('card-pass-rate');
    rateEl.textContent = summary.pass_rate.toFixed(1) + '%';
    rateEl.style.color = `var(--${passRateClass(summary.pass_rate)})`;
    document.getElementById('card-pass-rate-delta').innerHTML = '';

    document.getElementById('card-failing').textContent = summary.failing_jobs;
    document.getElementById('card-failing-delta').innerHTML = '';

    document.getElementById('card-infra').textContent = summary.infrastructure_failures || 0;
    document.getElementById('card-infra-delta').innerHTML = '';
  }

  function extractPlatforms(jobs) {
    const platforms = new Set();
    for (const job of jobs) {
      if (job.variants) {
        for (const v of job.variants) {
          if (v.startsWith('Platform:')) platforms.add(v.split(':')[1]);
        }
      }
    }
    return Array.from(platforms).sort();
  }

  function populatePlatformFilter(jobs) {
    const select = document.getElementById('filter-platform');
    const current = select.value;
    const platforms = extractPlatforms(jobs);
    let html = '<option value="ALL">All</option>';
    for (const p of platforms) {
      html += `<option value="${p}"${p === current ? ' selected' : ''}>${p}</option>`;
    }
    select.innerHTML = html;
  }

  function getFilteredJobs() {
    const data = state.versionJobs[state.currentVersion];
    if (!data) return [];

    let jobs = data.jobs.slice();
    const f = state.filters;

    if (f.status !== 'ALL') {
      jobs = jobs.filter(j => j.status === f.status);
    }

    if (f.trend !== 'ALL') {
      jobs = jobs.filter(j => j.trend === f.trend);
    }

    if (f.platform !== 'ALL') {
      jobs = jobs.filter(j =>
        j.variants && j.variants.some(v => v === `Platform:${f.platform}`)
      );
    }

    if (f.search) {
      const q = f.search.toLowerCase();
      jobs = jobs.filter(j =>
        j.brief_name.toLowerCase().includes(q) || j.name.toLowerCase().includes(q)
      );
    }

    switch (f.sort) {
      case 'pass_rate_asc':
        jobs.sort((a, b) => a.current_pass_percentage - b.current_pass_percentage);
        break;
      case 'pass_rate_desc':
        jobs.sort((a, b) => b.current_pass_percentage - a.current_pass_percentage);
        break;
      case 'name_asc':
        jobs.sort((a, b) => a.brief_name.localeCompare(b.brief_name));
        break;
      case 'name_desc':
        jobs.sort((a, b) => b.brief_name.localeCompare(a.brief_name));
        break;
      case 'duration_desc':
        jobs.sort((a, b) => (b.current_average_duration_minutes || 0) - (a.current_average_duration_minutes || 0));
        break;
      case 'runs_desc':
        jobs.sort((a, b) => (b.current_runs || 0) - (a.current_runs || 0));
        break;
      case 'net_improvement_asc':
        jobs.sort((a, b) => (a.net_improvement || 0) - (b.net_improvement || 0));
        break;
      case 'net_improvement_desc':
        jobs.sort((a, b) => (b.net_improvement || 0) - (a.net_improvement || 0));
        break;
    }

    return jobs;
  }

  function renderJobTable() {
    if (state.currentVersion === 'overview') return;

    const jobs = getFilteredJobs();
    const tbody = document.getElementById('job-table-body');
    const empty = document.getElementById('empty-state');
    const countEl = document.getElementById('job-count');
    const totalJobs = state.versionJobs[state.currentVersion]
      ? state.versionJobs[state.currentVersion].jobs.length : 0;

    countEl.textContent = `Showing ${jobs.length} of ${totalJobs} jobs`;

    if (jobs.length === 0) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    let html = '';

    for (const job of jobs) {
      const rate = job.current_pass_percentage || 0;
      const rateCls = passRateClass(rate);
      const statusCls = statusBadgeClass(job.status);
      const t = trendArrow(job.trend);
      const ni = job.net_improvement || 0;

      html += `<tr data-job-id="${job.id}">
        <td>${escapeHtml(job.brief_name)}</td>
        <td><span class="status-badge ${statusCls}">${job.status.replace('_', ' ')}</span></td>
        <td><span class="pass-rate-bar">
          <span class="bar-bg"><span class="bar-fill ${rateCls}" style="width:${rate}%"></span></span>
          ${rate.toFixed(1)}%
        </span></td>
        <td>${job.current_runs || 0}</td>
        <td>${job.current_average_duration_minutes || '—'}m</td>
        <td><span class="trend-indicator ${t.cls}">${t.text} ${ni >= 0 ? '+' : ''}${ni.toFixed(1)}%</span></td>
        <td>${formatDate(job.last_pass)}</td>
        <td>${job.open_bugs || 0}</td>
      </tr>`;

      if (state.expandedJobId === job.id) {
        html += renderJobDetailRow(job);
      }
    }

    tbody.innerHTML = html;

    tbody.querySelectorAll('tr[data-job-id]').forEach(row => {
      row.addEventListener('click', () => {
        const id = parseInt(row.dataset.jobId, 10);
        state.expandedJobId = state.expandedJobId === id ? null : id;
        renderJobTable();
      });
    });
  }

  function renderJobDetailRow(job) {
    const runsData = state.versionRuns[state.currentVersion];
    let jobRuns = [];
    if (runsData && runsData.runs) {
      jobRuns = runsData.runs.filter(r => r.job === job.name).slice(0, 20);
    }

    const sippyUrl = `https://sippy.dptools.openshift.org/sippy-ng/jobs/${state.currentVersion}/analysis?filters=%7B%22items%22%3A%5B%7B%22field%22%3A%22name%22%2C%22operator%22%3A%22equals%22%2C%22value%22%3A%22${encodeURIComponent(job.name)}%22%7D%5D%2C%22logicOperator%22%3A%22and%22%7D`;

    let variantsHtml = '';
    if (job.variants && job.variants.length) {
      variantsHtml = '<div class="variant-chips">' +
        job.variants.map(v => `<span class="variant-chip">${escapeHtml(v)}</span>`).join('') +
        '</div>';
    }

    let runsHtml = '';
    if (jobRuns.length > 0) {
      runsHtml = `<div class="detail-runs-title">Recent Failing Runs</div><div class="detail-run-list">`;
      for (const run of jobRuns) {
        const infraBadge = run.infrastructure_failure ? '<span class="run-infra">INFRA</span>' : '';
        runsHtml += `<div class="detail-run-item">
          <span class="run-time">${formatDateTime(run.timestamp)}</span>
          <span class="run-cluster">${escapeHtml(run.cluster || '')}</span>
          <span class="run-failures">${run.test_failures || 0} test failures</span>
          ${infraBadge}
          <a href="${escapeHtml(run.url || '#')}" target="_blank" rel="noopener">View in Prow</a>
        </div>`;
      }
      runsHtml += '</div>';

      const allFailedTests = [];
      for (const run of jobRuns) {
        if (run.failed_test_names) {
          for (const t of run.failed_test_names) {
            if (!allFailedTests.includes(t)) allFailedTests.push(t);
          }
        }
      }

      if (allFailedTests.length > 0) {
        runsHtml += `<div class="detail-failed-tests"><details>
          <summary>${allFailedTests.length} unique failing tests across recent runs</summary>
          <ul>${allFailedTests.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
        </details></div>`;
      }
    } else {
      runsHtml = '<div style="color:var(--text-muted);font-size:12px;margin-top:8px">No recent failing run data available.</div>';
    }

    return `<tr class="job-detail-row"><td colspan="8"><div class="job-detail-panel">
      <div class="detail-header">
        <div class="detail-job-name">${escapeHtml(job.name)}</div>
        <div class="detail-links">
          ${job.test_grid_url ? `<a href="${escapeHtml(job.test_grid_url)}" target="_blank" rel="noopener">TestGrid</a>` : ''}
          <a href="${sippyUrl}" target="_blank" rel="noopener">Sippy</a>
        </div>
      </div>
      ${variantsHtml}
      <div class="detail-stats">
        <div class="detail-stat">
          <div class="detail-stat-label">Pass Rate</div>
          <div class="detail-stat-row">
            <span class="current" style="color:var(--${passRateClass(job.current_pass_percentage || 0)})">${(job.current_pass_percentage || 0).toFixed(1)}%</span>
            <span class="previous">prev: ${(job.previous_pass_percentage || 0).toFixed(1)}%</span>
          </div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Runs</div>
          <div class="detail-stat-row">
            <span class="current">${job.current_runs || 0} (${job.current_passes || 0}P / ${job.current_fails || 0}F)</span>
            <span class="previous">prev: ${job.previous_runs || 0}</span>
          </div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Avg Duration</div>
          <div class="detail-stat-row">
            <span class="current">${job.current_average_duration_minutes || '—'}m</span>
            <span class="previous">prev: ${job.previous_average_duration_minutes || '—'}m</span>
          </div>
        </div>
      </div>
      ${runsHtml}
    </div></td></tr>`;
  }

  function renderFailureAnalysis() {
    if (state.currentVersion === 'overview') return;

    const runsData = state.versionRuns[state.currentVersion];

    // Category chart
    if (failureCategoryChart) failureCategoryChart.destroy();
    const ctx = document.getElementById('failure-category-chart').getContext('2d');

    if (runsData && runsData.failure_categories) {
      const cats = runsData.failure_categories;
      failureCategoryChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['Infrastructure', 'Test Failure', 'Unknown'],
          datasets: [{
            data: [cats.infrastructure || 0, cats.test_failure || 0, cats.unknown || 0],
            backgroundColor: ['rgba(255,159,67,0.8)', 'rgba(255,107,107,0.8)', 'rgba(99,110,136,0.8)'],
            borderColor: '#1e1e36',
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#a0a0b8', padding: 16, font: { size: 12 } } },
            tooltip: { backgroundColor: '#1e1e36', titleColor: '#e8e8f0', bodyColor: '#a0a0b8', borderColor: '#2a2a4a', borderWidth: 1 }
          }
        }
      });
    } else {
      failureCategoryChart = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: ['No data'], datasets: [{ data: [1], backgroundColor: ['rgba(42,42,74,0.5)'], borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
      });
    }

    // Top failing tests
    const container = document.getElementById('top-failing-tests');
    if (runsData && runsData.top_failing_tests && runsData.top_failing_tests.length > 0) {
      let html = '';
      for (const t of runsData.top_failing_tests.slice(0, 20)) {
        html += `<div class="failing-test-item">
          <span class="failing-test-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
          <span class="failing-test-count">${t.count}</span>
        </div>`;
      }
      container.innerHTML = html;
    } else {
      container.innerHTML = '<div class="empty-state-inline">No failing test data available.</div>';
    }
  }

  function renderTrendChart() {
    if (trendChart) trendChart.destroy();
    const ctx = document.getElementById('trend-chart').getContext('2d');

    if (!state.historyData || !state.historyData.snapshots || state.historyData.snapshots.length === 0) {
      trendChart = new Chart(ctx, {
        type: 'line',
        data: { labels: ['No data'], datasets: [{ data: [0], borderColor: '#2a2a4a' }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
      });
      return;
    }

    const snapshots = state.historyData.snapshots.slice().sort((a, b) => a.date.localeCompare(b.date));
    const dates = snapshots.map(s => s.date);
    const versions = state.versionsData.versions;

    const colors = [
      '#6c63ff', '#00c48c', '#ff6b6b', '#ffb347', '#54a0ff',
      '#ff9ff3', '#feca57', '#48dbfb', '#ff9f43', '#c8d6e5'
    ];

    const datasets = [];
    versions.forEach((v, i) => {
      const data = snapshots.map(s => (s.versions && s.versions[v]) ? s.versions[v].pass_rate : null);
      if (data.some(d => d !== null)) {
        datasets.push({
          label: v,
          data: data,
          borderColor: colors[i % colors.length],
          backgroundColor: 'transparent',
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          spanGaps: true
        });
      }
    });

    trendChart = new Chart(ctx, {
      type: 'line',
      data: { labels: dates, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { color: '#a0a0b8', padding: 12, font: { size: 11 }, usePointStyle: true } },
          tooltip: { backgroundColor: '#1e1e36', titleColor: '#e8e8f0', bodyColor: '#a0a0b8', borderColor: '#2a2a4a', borderWidth: 1 }
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            grid: { color: 'rgba(42,42,74,0.5)' },
            ticks: { color: '#6a6a88', callback: v => v + '%' }
          },
          x: {
            grid: { display: false },
            ticks: { color: '#6a6a88', maxRotation: 45 }
          }
        }
      }
    });
  }

  function syncFilterUI() {
    document.getElementById('filter-status').value = state.filters.status;
    document.getElementById('filter-trend').value = state.filters.trend;
    document.getElementById('filter-platform').value = state.filters.platform;
    document.getElementById('filter-search-input').value = state.filters.search;
    document.getElementById('filter-sort').value = state.filters.sort;
  }

  async function renderAll() {
    renderVersionTabs();
    renderHealthIndicator();

    if (state.currentVersion === 'overview') {
      renderOverview();
    } else {
      document.getElementById('overview-section').classList.add('hidden');
      document.getElementById('version-section').classList.remove('hidden');

      try {
        await loadVersionDetail(state.currentVersion);
      } catch (e) {
        showToast(`Failed to load data for ${state.currentVersion}: ${e.message}`);
        return;
      }

      const data = state.versionJobs[state.currentVersion];
      if (data) populatePlatformFilter(data.jobs);

      syncFilterUI();
      renderSummaryCards();
      renderJobTable();
      renderFailureAnalysis();
    }

    renderTrendChart();
  }

  // --- Event wiring ---

  function setupFilters() {
    document.getElementById('filter-status').addEventListener('change', e => {
      state.filters.status = e.target.value;
      state.expandedJobId = null;
      writeHash();
      renderJobTable();
    });

    document.getElementById('filter-trend').addEventListener('change', e => {
      state.filters.trend = e.target.value;
      state.expandedJobId = null;
      writeHash();
      renderJobTable();
    });

    document.getElementById('filter-platform').addEventListener('change', e => {
      state.filters.platform = e.target.value;
      state.expandedJobId = null;
      writeHash();
      renderJobTable();
    });

    document.getElementById('filter-search-input').addEventListener('input', e => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        state.filters.search = e.target.value;
        state.expandedJobId = null;
        writeHash();
        renderJobTable();
      }, 250);
    });

    document.getElementById('filter-sort').addEventListener('change', e => {
      state.filters.sort = e.target.value;
      state.expandedJobId = null;
      writeHash();
      renderJobTable();
    });

    document.querySelectorAll('#job-table thead th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const sort = th.dataset.sort;
        const sortSelect = document.getElementById('filter-sort');
        const current = sortSelect.value;
        if (current === sort + '_asc') {
          state.filters.sort = sort + '_desc';
        } else if (current === sort + '_desc') {
          state.filters.sort = sort + '_asc';
        } else {
          state.filters.sort = sort.includes('name') ? sort : sort;
        }
        sortSelect.value = state.filters.sort;
        writeHash();
        renderJobTable();
      });
    });
  }

  // --- Init ---

  async function init() {
    const overlay = document.getElementById('loading-overlay');

    try {
      readHash();
      await Promise.all([loadVersionsData(), loadHistory()]);
      setupFilters();
      await renderAll();
    } catch (e) {
      showToast('Failed to load dashboard data. Make sure data files exist. ' + e.message);
      console.error(e);
    } finally {
      overlay.classList.add('hidden');
    }

    window.addEventListener('hashchange', () => {
      readHash();
      renderAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
