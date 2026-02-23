// Gateway WebSocket Client for OpenClaw
// Protocol v3 compliant with proper challenge handling

class GatewayClient {
  constructor() {
    this.ws = null;
    this.config = { host: '', port: 18789, token: '' };
    this.connected = false;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.eventHandlers = new Map();
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.lastPong = null;
    this.connectionAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.challengeNonce = null;
    this.deviceId = null;
    this.connectPromise = null;
  }

  configure(config) {
    this.config = { ...this.config, ...config };
  }

  getWsUrl() {
    const protocol = this.config.useTls ? 'wss' : 'ws';
    return `${protocol}://${this.config.host}:${this.config.port}/ws`;
  }

  // Generate or retrieve stable device ID
  getDeviceId() {
    if (this.deviceId) return this.deviceId;
    
    let stored = localStorage.getItem('ether-portal-device-id');
    if (!stored) {
      // Generate a stable fingerprint from browser info
      const ua = navigator.userAgent;
      const lang = navigator.language;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillText('OpenClaw', 0, 0);
      const canvasFingerprint = canvas.toDataURL().slice(-50);
      
      const fingerprint = `${ua}|${lang}|${tz}|${canvasFingerprint}`;
      stored = 'ether-portal-' + this.hashCode(fingerprint).toString(36);
      localStorage.setItem('ether-portal-device-id', stored);
    }
    this.deviceId = stored;
    return stored;
  }

  hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  connect() {
    // Return existing promise if already connecting
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      this.connectionAttempts++;
      
      try {
        const url = this.getWsUrl();
        console.log(`[Gateway] Connecting to ${url} (attempt ${this.connectionAttempts})...`);
        this.emit('connecting', { attempt: this.connectionAttempts, url });
        
        this.ws = new WebSocket(url);
        
        // Connection timeout
        const timeout = setTimeout(() => {
          if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
            console.error('[Gateway] Connection timeout');
            this.ws.close();
            this.connectPromise = null;
            reject(new Error('Connection timeout'));
          }
        }, 10000);

        this.ws.onopen = () => {
          console.log('[Gateway] WebSocket opened, waiting for challenge...');
          clearTimeout(timeout);
          this.emit('socket_open');
        };

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            this.handleMessage(data, resolve, reject);
          } catch (e) {
            console.error('[Gateway] Failed to parse message:', e, event.data);
          }
        };

        this.ws.onclose = (event) => {
          clearTimeout(timeout);
          console.log('[Gateway] WebSocket closed:', event.code, event.reason);
          this.connected = false;
          this.connectPromise = null;
          this.challengeNonce = null;
          this.emit('disconnected', { code: event.code, reason: event.reason });
          this.stopPing();
          
          // Only reject if we haven't resolved yet
          if (!this.connected) {
            reject(new Error(event.reason || `Connection closed (${event.code})`));
          }
        };

        this.ws.onerror = (error) => {
          clearTimeout(timeout);
          console.error('[Gateway] WebSocket error:', error);
          this.emit('error', { error: 'WebSocket connection failed' });
        };

      } catch (error) {
        this.connectPromise = null;
        reject(error);
      }
    });

    return this.connectPromise;
  }

  handleMessage(data, connectResolve, connectReject) {
    // Handle connect challenge (sent by gateway before connect request)
    if (data.type === 'event' && data.event === 'connect.challenge') {
      console.log('[Gateway] Received challenge, nonce:', data.payload?.nonce?.slice(0, 16) + '...');
      this.challengeNonce = data.payload?.nonce;
      this.emit('challenge_received', { nonce: this.challengeNonce });
      this.sendConnectRequest();
      return;
    }

    // Handle connect response (hello-ok)
    if (data.type === 'res') {
      // Check if this is a response to our connect request
      const pending = this.pendingRequests.get(data.id);
      
      if (data.payload?.type === 'hello-ok') {
        console.log('[Gateway] Connected successfully! Protocol:', data.payload.protocol);
        this.connected = true;
        this.connectionAttempts = 0;
        
        // Store device token if provided
        if (data.payload.auth?.deviceToken) {
          localStorage.setItem('ether-portal-device-token', data.payload.auth.deviceToken);
          console.log('[Gateway] Device token received and stored');
        }
        
        this.startPing();
        this.emit('connected', { protocol: data.payload.protocol });
        
        if (pending) {
          this.pendingRequests.delete(data.id);
          pending.resolve(data.payload);
        }
        if (connectResolve) connectResolve(data.payload);
        return;
      }

      // Handle connect error
      if (!data.ok && data.error) {
        const errorMsg = data.error.message || data.error.code || 'Authentication failed';
        console.error('[Gateway] Connect error:', errorMsg);
        
        if (pending) {
          this.pendingRequests.delete(data.id);
          pending.reject(new Error(errorMsg));
        }
        if (connectReject) connectReject(new Error(errorMsg));
        return;
      }

      // Handle regular response
      if (data.id && pending) {
        this.pendingRequests.delete(data.id);
        if (data.ok) {
          pending.resolve(data.payload);
        } else {
          const error = new Error(data.error?.message || 'Request failed');
          error.code = data.error?.code;
          pending.reject(error);
        }
        return;
      }
    }

    // Handle events
    if (data.type === 'event') {
      console.log('[Gateway] Event:', data.event);
      this.emit(data.event, data.payload);
      
      // Special handling for specific events
      if (data.event === 'cron.job.started') {
        this.emit('job_started', data.payload);
      } else if (data.event === 'cron.job.completed') {
        this.emit('job_completed', data.payload);
      } else if (data.event === 'session.message') {
        this.emit('session_message', data.payload);
      }
      return;
    }

    // Handle pong
    if (data.type === 'pong') {
      this.lastPong = Date.now();
      return;
    }

    console.log('[Gateway] Unhandled message:', data);
  }

  sendConnectRequest() {
    const deviceId = this.getDeviceId();
    const storedToken = localStorage.getItem('ether-portal-device-token');
    
    // Build auth object
    const auth = {};
    if (this.config.token) {
      auth.token = this.config.token;
    } else if (storedToken) {
      auth.deviceToken = storedToken;
    }

    const requestId = this.nextId();
    const request = {
      type: 'req',
      id: requestId,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'ether-portal-web',
          version: '1.1.0',
          platform: this.detectPlatform(),
          mode: 'ui'
        },
        device: {
          id: deviceId,
          displayName: 'Ether Portal Web'
        },
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
        caps: [],
        commands: [],
        permissions: {},
        auth,
        locale: navigator.language || 'en-US',
        userAgent: `EtherPortal/1.1.0 (${navigator.userAgent.slice(0, 100)})`
      }
    };

    // Create a pending request entry for the connect
    this.pendingRequests.set(requestId, {
      resolve: () => {},
      reject: () => {}
    });

    console.log('[Gateway] Sending connect request, deviceId:', deviceId);
    this.ws.send(JSON.stringify(request));
  }

  detectPlatform() {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('android')) return 'android';
    if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
    if (ua.includes('mac')) return 'macos';
    if (ua.includes('win')) return 'windows';
    if (ua.includes('linux')) return 'linux';
    return 'web';
  }

  nextId() {
    return `req_${++this.requestId}_${Date.now()}`;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to gateway'));
        return;
      }

      const id = this.nextId();
      const request = {
        type: 'req',
        id,
        method,
        params
      };

      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(request));

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  startPing() {
    this.stopPing();
    this.lastPong = Date.now();
    
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Check if we haven't received a pong in a while
        if (this.lastPong && Date.now() - this.lastPong > 60000) {
          console.warn('[Gateway] No pong received in 60s, reconnecting...');
          this.ws.close(4000, 'Ping timeout');
          return;
        }
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  disconnect() {
    this.stopPing();
    this.connectionAttempts = 0;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      this.ws.close(1000, 'User disconnect');
      this.ws = null;
    }
    
    this.connected = false;
    this.connectPromise = null;
    this.pendingRequests.clear();
  }

  // Reconnect with exponential backoff
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.connectionAttempts >= this.maxReconnectAttempts) {
      console.error('[Gateway] Max reconnection attempts reached');
      this.emit('max_reconnects');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.connectionAttempts), 30000);
    console.log(`[Gateway] Reconnecting in ${delay}ms...`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(err => {
        console.error('[Gateway] Reconnect failed:', err.message);
        this.scheduleReconnect();
      });
    }, delay);
  }

  // Event handling
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  emit(event, data) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (e) {
          console.error('[Gateway] Event handler error:', e);
        }
      });
    }
    // Also emit to wildcard handlers
    const wildcardHandlers = this.eventHandlers.get('*');
    if (wildcardHandlers) {
      wildcardHandlers.forEach(handler => {
        try {
          handler({ event, data });
        } catch (e) {
          console.error('[Gateway] Wildcard handler error:', e);
        }
      });
    }
  }

  // API Methods
  async getStatus() {
    return this.send('gateway.status');
  }

  async getHealth() {
    return this.send('health');
  }

  async getSessions(options = {}) {
    return this.send('sessions.list', { 
      messageLimit: options.messageLimit ?? 0,
      activeMinutes: options.activeMinutes ?? 60 * 24 // Last 24 hours
    });
  }

  async getCronJobs() {
    return this.send('cron.list');
  }

  async runCronJob(jobId) {
    return this.send('cron.run', { jobId, runMode: 'force' });
  }

  async toggleCronJob(jobId, enabled) {
    return this.send('cron.update', { jobId, patch: { enabled } });
  }

  async sendMessage(sessionKey, message) {
    return this.send('sessions.send', { sessionKey, message });
  }

  async getSessionHistory(sessionKey, limit = 50) {
    return this.send('sessions.history', { sessionKey, limit, includeTools: false });
  }

  async getPresence() {
    return this.send('system-presence');
  }

  async getModels() {
    return this.send('models.list');
  }

  // Check connection state
  isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  getConnectionState() {
    if (!this.ws) return 'disconnected';
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING: return 'connecting';
      case WebSocket.OPEN: return this.connected ? 'connected' : 'authenticating';
      case WebSocket.CLOSING: return 'closing';
      case WebSocket.CLOSED: return 'disconnected';
      default: return 'unknown';
    }
  }
}

// Export singleton
window.gateway = new GatewayClient();
