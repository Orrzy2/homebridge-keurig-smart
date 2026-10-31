'use strict';
// Tiny fake of the Keurig cloud for tests and local Homebridge runs.
const http = require('node:http');
const fx = require('./fixtures');

function createMockKeurig({ email = 'test@example.com', password = 'secret', expireFirstToken = false } = {}) {
  const state = {
    tokenCount: 0,
    validTokens: new Set(),
    requests: [],
    commands: [],
    device: { appl: 'STANDBY', brew: 'BREW_LOCKED', lock: null, pod: 'POD' },
    expireFirstToken,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url.replace(/^\/connected-platform\//, '/');
      state.requests.push({ method: req.method, url, body, headers: req.headers });
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };
      if (req.headers['ocp-apim-subscription-key'] == null) {
        return send(401, { message: 'missing subscription key' });
      }
      if (req.method === 'POST' && url === '/api/claa/v1/oauth/token') {
        if (body.client_id !== 'cbma-v1') {
          return send(400, { error: 'invalid_client' });
        }
        if (body.grant_type === 'password' && (body.username !== email || body.password !== password)) {
          return send(400, { error: 'invalid_grant' });
        }
        if (body.grant_type === 'refresh_token' && !String(body.refresh_token).startsWith('refresh-')) {
          return send(400, { error: 'invalid_grant' });
        }
        state.tokenCount += 1;
        const t = fx.tokenResponse(state.tokenCount);
        state.validTokens.add(t.access_token);
        return send(200, t);
      }
      const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!state.validTokens.has(auth)) {
        return send(401, { message: 'unauthorized' });
      }
      if (state.expireFirstToken && auth === 'access-1') {
        state.validTokens.delete(auth);
        state.expireFirstToken = false;
        return send(401, { message: 'token expired' });
      }
      if (req.method === 'GET' && url === '/api/usdm/v1/user/profile') {
        return send(200, fx.profile);
      }
      if (req.method === 'GET' && url === '/api/alcm/v1/devices?customerId=cust-123') {
        return send(200, fx.devices);
      }
      if (req.method === 'GET' && url === '/api/acsm/v1/devices/dev-abc/properties') {
        const d = state.device;
        return send(200, fx.properties({ appl: d.appl, brew: d.brew, lock: d.lock, pod: d.pod }));
      }
      if (req.method === 'POST' && url === '/api/acsm/v1/devices/dev-abc/commands') {
        state.commands.push(body);
        const d = state.device;
        switch (body.command_name) {
          case 'idle':
            d.appl = 'IDLE';
            d.brew = d.lock ? 'BREW_LOCKED' : 'BREW_READY';
            break;
          case 'standby':
            d.appl = 'STANDBY';
            d.brew = 'BREW_LOCKED';
            break;
          case 'brew':
            d.appl = 'BREW';
            d.brew = 'BREW_IN_PROGRESS';
            setTimeout(() => {
              d.appl = 'IDLE';
              d.brew = 'BREW_SUCCESSFUL';
              d.pod = 'PUNCHED';
            }, state.brewDurationMs || 1500);
            break;
          case 'cancel_brew':
            d.appl = 'IDLE';
            d.brew = 'BREW_READY';
            break;
          default:
            return send(400, { message: 'unknown command' });
        }
        return send(200, { id: 'cmd-1', status: 'accepted' });
      }
      return send(404, { message: 'not found ' + url });
    });
  });

  return {
    state,
    server,
    listen: (port = 0) => new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

module.exports = { createMockKeurig };

if (require.main === module) {
  const port = Number(process.argv[2]) || 18765;
  const m = createMockKeurig();
  m.state.brewDurationMs = 8000;
  m.listen(port).then((p) => console.log(`mock keurig on http://127.0.0.1:${p}/connected-platform/`));
  setInterval(() => {}, 1 << 30);
  process.on('SIGUSR2', () => console.log(JSON.stringify(m.state.commands)));
}
