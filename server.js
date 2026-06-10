'use strict';

const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { mkdtempSync, chmodSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const crypto = require('crypto');
const httpProxy = require('http-proxy');

const env = process.env;

const config = {
  port: Number(env.PORT || 3000),
  localTunnelHost: env.LOCAL_TUNNEL_HOST || '127.0.0.1',
  localTunnelPort: Number(env.LOCAL_TUNNEL_PORT || 9000),
  remoteDashboardHost: env.REMOTE_DASHBOARD_HOST || '127.0.0.1',
  remoteDashboardPort: Number(env.REMOTE_DASHBOARD_PORT || 8766),
  sshHost: required('SSH_HOST'),
  sshUser: required('SSH_USER'),
  sshPort: Number(env.SSH_PORT || 22),
  sshPrivateKey: required('SSH_PRIVATE_KEY'),
  sshKnownHosts: env.SSH_KNOWN_HOSTS || '',
  basicAuthUser: env.BASIC_AUTH_USER || '',
  basicAuthPassword: env.BASIC_AUTH_PASSWORD || '',
  reconnectMs: Number(env.SSH_RECONNECT_MS || 5000),
};

function required(name) {
  if (!env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return env[name];
}

function safeEqual(a, b) {
  const aa = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authOk(req) {
  if (!config.basicAuthUser && !config.basicAuthPassword) return true;

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;

  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }

  const idx = decoded.indexOf(':');
  if (idx === -1) return false;

  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return safeEqual(user, config.basicAuthUser) && safeEqual(pass, config.basicAuthPassword);
}

const workDir = mkdtempSync(join(tmpdir(), 'railway-ssh-proxy-'));
const keyPath = join(workDir, 'id_key');
const knownHostsPath = join(workDir, 'known_hosts');

writeFileSync(keyPath, normalizePrivateKey(config.sshPrivateKey), { mode: 0o600 });
chmodSync(keyPath, 0o600);

if (config.sshKnownHosts.trim()) {
  writeFileSync(knownHostsPath, config.sshKnownHosts.trim() + '\n', { mode: 0o644 });
} else {
  // Safer than StrictHostKeyChecking=no because the first host key is pinned for this container lifetime.
  writeFileSync(knownHostsPath, '', { mode: 0o644 });
}

function normalizePrivateKey(value) {
  // Railway env vars often store multiline secrets with literal \n escapes.
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

let sshProc = null;
let reconnectTimer = null;
let stopping = false;
let tunnelReady = false;

function startTunnel() {
  if (stopping || sshProc) return;

  tunnelReady = false;

  const strictMode = config.sshKnownHosts.trim() ? 'yes' : 'accept-new';
  const args = [
    '-N',
    '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'TCPKeepAlive=yes',
    '-o', `StrictHostKeyChecking=${strictMode}`,
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
    '-i', keyPath,
    '-p', String(config.sshPort),
    '-L', `${config.localTunnelHost}:${config.localTunnelPort}:${config.remoteDashboardHost}:${config.remoteDashboardPort}`,
    `${config.sshUser}@${config.sshHost}`,
  ];

  console.log(`[ssh] starting tunnel ${config.localTunnelHost}:${config.localTunnelPort} -> ${config.remoteDashboardHost}:${config.remoteDashboardPort} via ${config.sshUser}@${config.sshHost}:${config.sshPort}`);

  sshProc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  sshProc.stdout.on('data', (data) => console.log(`[ssh stdout] ${data.toString().trim()}`));
  sshProc.stderr.on('data', (data) => console.error(`[ssh stderr] ${data.toString().trim()}`));

  sshProc.on('exit', (code, signal) => {
    console.error(`[ssh] exited code=${code} signal=${signal}`);
    sshProc = null;
    tunnelReady = false;
    if (!stopping) scheduleReconnect();
  });

  waitForTunnel().then((ok) => {
    tunnelReady = ok;
    console.log(ok ? '[ssh] tunnel is ready' : '[ssh] tunnel readiness check failed; will keep retrying through requests/reconnects');
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startTunnel();
  }, config.reconnectMs);
}

function waitForTunnel(attempts = 20) {
  return new Promise((resolve) => {
    let tries = 0;
    const tick = () => {
      tries += 1;
      const socket = net.connect(config.localTunnelPort, config.localTunnelHost);
      socket.setTimeout(500);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', () => socket.destroy());
      socket.on('error', () => {});
      socket.on('close', () => {
        if (tries >= attempts) resolve(false);
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

const proxy = httpProxy.createProxyServer({
  target: `http://${config.localTunnelHost}:${config.localTunnelPort}`,
  ws: true,
  xfwd: true,
  changeOrigin: true,
  proxyTimeout: 120000,
  timeout: 120000,
});

proxy.on('error', (err, req, res) => {
  console.error(`[proxy] ${err.message}`);
  if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
  }
  res.end('Dashboard proxy is up, but the SSH tunnel/dashboard is not reachable. Try again in a few seconds.\n');
});

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(tunnelReady ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: tunnelReady, tunnelReady }));
    return;
  }

  if (!authOk(req)) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="Lightship Dashboard"',
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end('Authentication required\n');
    return;
  }

  proxy.web(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (!authOk(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Lightship Dashboard"\r\n\r\n');
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head);
});

function shutdown() {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  server.close(() => process.exit(0));
  if (sshProc) sshProc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startTunnel();
server.listen(config.port, '0.0.0.0', () => {
  console.log(`[server] listening on :${config.port}`);
});
