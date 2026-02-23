// Ether Portal Web App
// Enhanced UI with sessions view, activity logs, and better UX

document.addEventListener('DOMContentLoaded', () => {
  const app = new EtherPortal();
  app.init();
});

class EtherPortal {
  constructor() {
    this.currentTab = 'dashboard';
    this.jobs = [];
    this.sessions = [];
    this.activityLog = [];
    this.sessionKey = null; // Will be auto-detected
    this.refreshInterval = null;
    this.clockInterval = null;
  }

  init() {
    this.bindEvents();
    this.loadSavedConfig();
    this.startClock();
    this.restoreActivity();
  }

  bindEvents() {
    // Connect button
    document.getElementById('connect-btn').addEventListener('click', () => this.connect());
    
    // Enter key on password field
    document.getElementById('token').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.connect();
    });
    
    // Disconnect button
    document.getElementById('disconnect-btn').addEventListener('click', () => this.disconnect());
    
    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
    });
    
    // Chat input
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    document.getElementById('chat-send').addEventListener('click', () => this.sendMessage());
    
    // Refresh buttons
    document.getElementById('refresh-jobs')?.addEventListener('click', () => this.loadJobs());
    document.getElementById('refresh-sessions')?.addEventListener('click', () => this.loadSessions());
    
    // Clear activity
    document.getElementById('clear-activity')?.addEventListener('click', () => this.clearActivity());
    
    // Gateway events
    gateway.on('connected', (data) => this.onConnected(data));
    gateway.on('disconnected', (data) => this.onDisconnected(data));
    gateway.on('connecting', (data) => this.onConnecting(data));
    gateway.on('error', (data) => this.onError(data));
    gateway.on('challenge_received', () => this.updateConnectionStatus('Authenticating...'));
    gateway.on('socket_open', () => this.updateConnectionStatus('Handshaking...'));
    
    // Real-time events
    gateway.on('job_started', (data) => this.onJobStarted(data));
    gateway.on('job_completed', (data) => this.onJobCompleted(data));
    gateway.on('session_message', (data) => this.onSessionMessage(data));
    
    // Auto-resize chat input
    const chatInput = document.getElementById('chat-input');
    chatInput?.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });
  }

  loadSavedConfig() {
    const saved = localStorage.getItem('ether-portal-config');
    if (saved) {
      try {
        const config = JSON.parse(saved);
        document.getElementById('host').value = config.host || '';
        document.getElementById('port').value = config.port || 18789;
        document.getElementById('token').value = config.token || '';
      } catch (e) {
        console.warn('Failed to load saved config:', e);
      }
    }
  }

  saveConfig() {
    const config = {
      host: document.getElementById('host').value,
      port: document.getElementById('port').value,
      token: document.getElementById('token').value
    };
    localStorage.setItem('ether-portal-config', JSON.stringify(config));
  }

  startClock() {
    const updateClock = () => {
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const dateStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      const clockEl = document.getElementById('header-clock');
      if (clockEl) {
        clockEl.innerHTML = `<span class="time">${timeStr}</span><span class="date">${dateStr}</span>`;
      }
    };
    updateClock();
    this.clockInterval = setInterval(updateClock, 1000);
  }

  updateConnectionStatus(status, className = '') {
    const statusEl = document.getElementById('connection-status');
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.className = `status-badge ${className}`;
    }
    
    // Also update connect screen if visible
    const connectStatus = document.getElementById('connect-status');
    if (connectStatus) {
      connectStatus.textContent = status;
      connectStatus.classList.remove('hidden');
    }
  }

  async connect() {
    const btn = document.getElementById('connect-btn');
    const error = document.getElementById('connect-error');
    const status = document.getElementById('connect-status');
    
    btn.disabled = true;
    btn.querySelector('.btn-text').classList.add('hidden');
    btn.querySelector('.btn-loading').classList.remove('hidden');
    error.classList.add('hidden');
    status?.classList.remove('hidden');

    const host = document.getElementById('host').value.trim();
    const port = parseInt(document.getElementById('port').value) || 18789;
    const token = document.getElementById('token').value.trim();

    if (!host) {
      this.showConnectError('Please enter a host address');
      return;
    }

    gateway.configure({ host, port, token });
    this.saveConfig();

    try {
      status.textContent = 'Connecting...';
      await gateway.connect();
    } catch (e) {
      this.showConnectError(e.message || 'Connection failed');
    }
  }

  showConnectError(message) {
    const btn = document.getElementById('connect-btn');
    const error = document.getElementById('connect-error');
    const status = document.getElementById('connect-status');
    
    btn.disabled = false;
    btn.querySelector('.btn-text').classList.remove('hidden');
    btn.querySelector('.btn-loading').classList.add('hidden');
    
    error.textContent = message;
    error.classList.remove('hidden');
    status?.classList.add('hidden');
  }

  onConnecting(data) {
    this.updateConnectionStatus(`Connecting (attempt ${data.attempt})...`, 'connecting');
  }

  onConnected(data) {
    document.getElementById('connect-screen').classList.remove('active');
    document.getElementById('main-screen').classList.add('active');
    this.updateConnectionStatus('Connected', 'connected');
    
    // Reset button state
    const btn = document.getElementById('connect-btn');
    btn.disabled = false;
    btn.querySelector('.btn-text').classList.remove('hidden');
    btn.querySelector('.btn-loading').classList.add('hidden');
    
    this.loadDashboard();
    this.loadJobs();
    this.loadSessions();
    this.addActivity('Connected to Ether Gateway', 'success');
    
    // Start periodic refresh
    this.startRefreshInterval();
  }

  onDisconnected(data) {
    this.updateConnectionStatus('Disconnected', 'disconnected');
    this.addActivity(`Disconnected: ${data?.reason || 'Connection lost'}`, 'error');
    this.stopRefreshInterval();
  }

  onError(data) {
    this.addActivity(`Error: ${data?.error || 'Unknown error'}`, 'error');
  }

  onJobStarted(data) {
    this.addActivity(`Job started: ${data?.name || data?.jobId || 'Unknown'}`, 'info');
  }

  onJobCompleted(data) {
    this.addActivity(`Job completed: ${data?.name || data?.jobId || 'Unknown'}`, 'success');
    // Refresh jobs to update next run time
    setTimeout(() => this.loadJobs(), 1000);
  }

  onSessionMessage(data) {
    if (data?.role === 'assistant') {
      this.addActivity(`New message in ${data?.sessionKey?.split(':').pop() || 'session'}`, 'info');
    }
  }

  startRefreshInterval() {
    this.stopRefreshInterval();
    this.refreshInterval = setInterval(() => {
      if (gateway.isConnected()) {
        this.loadDashboard();
        this.updateNextTask();
      }
    }, 30000);
  }

  stopRefreshInterval() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  disconnect() {
    gateway.disconnect();
    document.getElementById('main-screen').classList.remove('active');
    document.getElementById('connect-screen').classList.add('active');
    
    const btn = document.getElementById('connect-btn');
    btn.disabled = false;
    btn.querySelector('.btn-text').classList.remove('hidden');
    btn.querySelector('.btn-loading').classList.add('hidden');
    
    document.getElementById('connect-error').classList.add('hidden');
    document.getElementById('connect-status').classList.add('hidden');
    
    this.addActivity('Disconnected by user', 'warning');
    this.stopRefreshInterval();
  }

  switchTab(tab) {
    this.currentTab = tab;
    
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    
    document.querySelectorAll('.tab-content').forEach(content => {
      content.classList.toggle('active', content.id === `tab-${tab}`);
    });

    // Load tab-specific data
    if (tab === 'sessions' && this.sessions.length === 0) {
      this.loadSessions();
    }
  }

  async loadDashboard() {
    try {
      const [status, sessions] = await Promise.all([
        gateway.getStatus().catch(() => null),
        gateway.getSessions().catch(() => ({ sessions: [] }))
      ]);

      document.getElementById('stat-status').textContent = 'Online';
      document.getElementById('stat-status').className = 'stat-value online';
      
      const sessionCount = sessions?.sessions?.length || 0;
      document.getElementById('stat-sessions').textContent = sessionCount;
      
      const enabledJobs = this.jobs.filter(j => j.enabled).length;
      document.getElementById('stat-jobs').textContent = enabledJobs;
      
      if (status?.uptimeMs) {
        document.getElementById('stat-uptime').textContent = this.formatUptime(status.uptimeMs);
      }
    } catch (e) {
      console.error('Failed to load dashboard:', e);
      this.addActivity('Dashboard refresh failed', 'error');
    }
  }

  formatUptime(ms) {
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const h = hours % 24;
      return `${days}d ${h}h`;
    }
    return `${hours}h ${mins}m`;
  }

  async loadJobs() {
    const container = document.getElementById('jobs-list');
    const refreshBtn = document.getElementById('refresh-jobs');
    
    if (refreshBtn) refreshBtn.disabled = true;
    container.innerHTML = '<div class="loading"><span class="spinner"></span> Loading jobs...</div>';

    try {
      const result = await gateway.getCronJobs();
      this.jobs = result?.jobs || [];
      
      document.getElementById('stat-jobs').textContent = this.jobs.filter(j => j.enabled).length;
      
      if (this.jobs.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="icon">📭</span><p>No scheduled jobs configured</p></div>';
        return;
      }

      // Sort: enabled first, then by next run time
      const sortedJobs = [...this.jobs].sort((a, b) => {
        if (a.enabled !== b.enabled) return b.enabled - a.enabled;
        const aNext = a.state?.nextRunAtMs || Infinity;
        const bNext = b.state?.nextRunAtMs || Infinity;
        return aNext - bNext;
      });

      container.innerHTML = sortedJobs.map(job => this.renderJob(job)).join('');
      
      // Bind job actions
      container.querySelectorAll('.job-run').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.runJob(btn.dataset.id);
        });
      });
      
      container.querySelectorAll('.job-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleJob(btn.dataset.id, btn.dataset.enabled === 'true');
        });
      });

      this.updateNextTask();
    } catch (e) {
      container.innerHTML = `<div class="empty-state error"><span class="icon">⚠️</span><p>Error: ${e.message}</p></div>`;
      this.addActivity('Failed to load jobs', 'error');
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  renderJob(job) {
    const schedule = this.formatSchedule(job.schedule);
    const nextRun = job.state?.nextRunAtMs 
      ? this.formatRelativeTime(job.state.nextRunAtMs)
      : 'Not scheduled';
    const nextRunFull = job.state?.nextRunAtMs
      ? new Date(job.state.nextRunAtMs).toLocaleString()
      : '';

    return `
      <div class="job-card ${job.enabled ? '' : 'disabled'}">
        <div class="job-header">
          <span class="job-status ${job.enabled ? 'enabled' : ''}"></span>
          <span class="job-name">${this.escapeHtml(job.name || 'Unnamed Job')}</span>
          <span class="job-badge ${job.enabled ? 'active' : 'inactive'}">${job.enabled ? 'Active' : 'Disabled'}</span>
        </div>
        <div class="job-details">
          <div class="job-schedule">
            <span class="icon">🔁</span>
            <span>${schedule}</span>
          </div>
          <div class="job-next" title="${nextRunFull}">
            <span class="icon">⏭️</span>
            <span>${nextRun}</span>
          </div>
        </div>
        <div class="job-actions">
          <button class="btn-small primary job-run" data-id="${job.id}" title="Run this job now">
            ▶️ Run Now
          </button>
          <button class="btn-small job-toggle" data-id="${job.id}" data-enabled="${job.enabled}" title="${job.enabled ? 'Disable' : 'Enable'} this job">
            ${job.enabled ? '⏸️ Disable' : '▶️ Enable'}
          </button>
        </div>
      </div>
    `;
  }

  formatSchedule(schedule) {
    if (!schedule) return 'Unknown';
    if (schedule.kind === 'every') {
      const mins = Math.round(schedule.everyMs / 60000);
      if (mins >= 1440) return `Every ${Math.round(mins/1440)}d`;
      if (mins >= 60) return `Every ${Math.round(mins/60)}h`;
      return `Every ${mins}m`;
    }
    if (schedule.kind === 'cron') {
      return this.formatCronExpr(schedule.expr);
    }
    if (schedule.kind === 'at') {
      return 'One-time: ' + new Date(schedule.at).toLocaleString();
    }
    return schedule.kind;
  }

  formatCronExpr(expr) {
    // Simple cron expression humanization
    const parts = expr.split(' ');
    if (parts.length < 5) return expr;
    
    const [min, hour, dom, mon, dow] = parts;
    
    if (dom === '*' && mon === '*') {
      if (dow === '*') {
        if (hour === '*') return `Every hour at :${min.padStart(2, '0')}`;
        return `Daily at ${hour}:${min.padStart(2, '0')}`;
      }
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dayName = days[parseInt(dow)] || dow;
      return `${dayName} at ${hour}:${min.padStart(2, '0')}`;
    }
    
    return expr;
  }

  formatRelativeTime(timestamp) {
    const now = Date.now();
    const diff = timestamp - now;
    
    if (diff < 0) return 'Overdue';
    if (diff < 60000) return 'Less than 1 min';
    if (diff < 3600000) return `In ${Math.round(diff / 60000)} min`;
    if (diff < 86400000) return `In ${Math.round(diff / 3600000)} hours`;
    return `In ${Math.round(diff / 86400000)} days`;
  }

  updateNextTask() {
    const enabledJobs = this.jobs.filter(j => j.enabled && j.state?.nextRunAtMs);
    const container = document.getElementById('next-task');
    
    if (!container) return;
    
    if (enabledJobs.length === 0) {
      container.innerHTML = `
        <div class="task-time">--:--</div>
        <div class="task-info">
          <span class="task-name">No scheduled tasks</span>
        </div>
      `;
      return;
    }

    const nextJob = enabledJobs.sort((a, b) => a.state.nextRunAtMs - b.state.nextRunAtMs)[0];
    const nextTime = new Date(nextJob.state.nextRunAtMs);
    const timeStr = nextTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const countdown = this.formatRelativeTime(nextJob.state.nextRunAtMs);

    container.innerHTML = `
      <div class="task-time">${timeStr}</div>
      <div class="task-info">
        <span class="task-name">${this.escapeHtml(nextJob.name || 'Unnamed Job')}</span>
        <span class="task-countdown">${countdown}</span>
      </div>
    `;
  }

  async loadSessions() {
    const container = document.getElementById('sessions-list');
    const refreshBtn = document.getElementById('refresh-sessions');
    
    if (!container) return;
    
    if (refreshBtn) refreshBtn.disabled = true;
    container.innerHTML = '<div class="loading"><span class="spinner"></span> Loading sessions...</div>';

    try {
      const result = await gateway.getSessions({ activeMinutes: 60 * 24 * 7 });
      this.sessions = result?.sessions || [];
      
      if (this.sessions.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="icon">💬</span><p>No recent sessions</p></div>';
        return;
      }

      // Sort by most recent activity
      const sortedSessions = [...this.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      container.innerHTML = sortedSessions.slice(0, 20).map(session => this.renderSession(session)).join('');
      
      // Bind session click to select for chat
      container.querySelectorAll('.session-card').forEach(card => {
        card.addEventListener('click', () => {
          this.selectSession(card.dataset.key);
        });
      });
      
      // Auto-select main session if available
      if (!this.sessionKey) {
        const mainSession = this.sessions.find(s => s.key?.includes('whatsapp:direct'));
        if (mainSession) {
          this.sessionKey = mainSession.key;
        }
      }
    } catch (e) {
      container.innerHTML = `<div class="empty-state error"><span class="icon">⚠️</span><p>Error: ${e.message}</p></div>`;
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  renderSession(session) {
    const age = session.age ? this.formatDuration(session.age) : 'Unknown';
    const model = session.model || 'Unknown';
    const usage = session.percentUsed ? `${session.percentUsed}%` : '-';
    const kind = session.kind || 'direct';
    
    // Extract readable name from session key
    let name = session.key || 'Unknown Session';
    const parts = name.split(':');
    if (parts.length >= 4) {
      const channel = parts[2];
      const target = parts.slice(4).join(':') || parts[3];
      name = `${channel}/${target}`;
    }

    return `
      <div class="session-card" data-key="${this.escapeHtml(session.key || '')}">
        <div class="session-header">
          <span class="session-icon">${kind === 'cron' ? '⏰' : '💬'}</span>
          <span class="session-name">${this.escapeHtml(name)}</span>
        </div>
        <div class="session-meta">
          <span class="session-model" title="Model">${model}</span>
          <span class="session-usage" title="Context usage">${usage}</span>
          <span class="session-age" title="Last activity">${age} ago</span>
        </div>
      </div>
    `;
  }

  formatDuration(ms) {
    if (ms < 60000) return '<1m';
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
    return `${Math.round(ms / 86400000)}d`;
  }

  selectSession(sessionKey) {
    this.sessionKey = sessionKey;
    this.addActivity(`Selected session: ${sessionKey.split(':').slice(-2).join('/')}`, 'info');
    
    // Highlight selected session
    document.querySelectorAll('.session-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.key === sessionKey);
    });
    
    // Switch to chat tab
    this.switchTab('chat');
  }

  async runJob(jobId) {
    const job = this.jobs.find(j => j.id === jobId);
    const jobName = job?.name || jobId;
    
    this.addActivity(`Running job: ${jobName}...`, 'info');
    
    try {
      await gateway.runCronJob(jobId);
      this.addActivity(`Job triggered: ${jobName}`, 'success');
    } catch (e) {
      this.addActivity(`Failed to run job: ${e.message}`, 'error');
    }
  }

  async toggleJob(jobId, currentEnabled) {
    const job = this.jobs.find(j => j.id === jobId);
    const jobName = job?.name || jobId;
    
    try {
      await gateway.toggleCronJob(jobId, !currentEnabled);
      this.addActivity(`${currentEnabled ? 'Disabled' : 'Enabled'} job: ${jobName}`, 'success');
      await this.loadJobs();
    } catch (e) {
      this.addActivity(`Failed to toggle job: ${e.message}`, 'error');
    }
  }

  async sendMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    
    if (!message) return;
    if (!this.sessionKey) {
      this.addChatMessage('system', 'No session selected. Go to Sessions tab to select one.');
      return;
    }
    
    input.value = '';
    input.style.height = 'auto';
    
    this.addChatMessage('user', message);
    
    try {
      const result = await gateway.sendMessage(this.sessionKey, message);
      if (result?.reply) {
        this.addChatMessage('assistant', result.reply);
      } else {
        this.addChatMessage('system', 'Message sent. Response will appear in the chat channel.');
      }
    } catch (e) {
      this.addChatMessage('system', `Failed to send: ${e.message}`);
    }
  }

  addChatMessage(role, content) {
    const container = document.getElementById('chat-messages');
    const welcome = container.querySelector('.chat-welcome');
    if (welcome) welcome.remove();
    
    const div = document.createElement('div');
    div.className = `message ${role}`;
    
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      <div class="message-content">${this.escapeHtml(content)}</div>
      <div class="message-time">${time}</div>
    `;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // Activity log management
  addActivity(text, type = 'info') {
    const time = new Date();
    const entry = { text, type, time: time.getTime() };
    
    this.activityLog.unshift(entry);
    if (this.activityLog.length > 50) this.activityLog.pop();
    
    // Persist to localStorage
    localStorage.setItem('ether-portal-activity', JSON.stringify(this.activityLog.slice(0, 50)));
    
    this.renderActivity();
  }

  renderActivity() {
    const container = document.getElementById('activity-list');
    if (!container) return;
    
    if (this.activityLog.length === 0) {
      container.innerHTML = '<div class="empty-state small"><span class="icon">📋</span><p>No recent activity</p></div>';
      return;
    }
    
    container.innerHTML = this.activityLog.slice(0, 20).map(entry => {
      const time = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const icon = entry.type === 'success' ? '✅' : entry.type === 'error' ? '❌' : entry.type === 'warning' ? '⚠️' : 'ℹ️';
      
      return `
        <div class="activity-item ${entry.type}">
          <span class="activity-icon">${icon}</span>
          <span class="activity-text">${this.escapeHtml(entry.text)}</span>
          <span class="activity-time">${time}</span>
        </div>
      `;
    }).join('');
  }

  restoreActivity() {
    try {
      const saved = localStorage.getItem('ether-portal-activity');
      if (saved) {
        this.activityLog = JSON.parse(saved);
        this.renderActivity();
      }
    } catch (e) {
      console.warn('Failed to restore activity:', e);
    }
  }

  clearActivity() {
    this.activityLog = [];
    localStorage.removeItem('ether-portal-activity');
    this.renderActivity();
    this.addActivity('Activity log cleared', 'info');
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
