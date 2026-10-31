'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KeurigApi, UnauthorizedError, parseProperties, describeStatus, INTENSITIES } = require('../lib/keurig-api');
const { createMockKeurig } = require('./mock-server');
const fx = require('./fixtures');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function setup(opts) {
  const mock = createMockKeurig(opts);
  const port = await mock.listen();
  const api = new KeurigApi({
    email: 'test@example.com', password: 'secret', log: quiet,
    apiUrl: `http://127.0.0.1:${port}/connected-platform/`, ...(opts && opts.api),
  });
  return { mock, api };
}

test('login, profile, device list', async () => {
  const { mock, api } = await setup();
  try {
    const devs = await api.getDevices();
    assert.deepEqual(devs, [{ id: 'dev-abc', serial: 'K29SN0001', model: 'K29', name: 'Kitchen Keurig' }]);
    assert.equal(api.customerId, 'cust-123');
    const tokenReq = mock.state.requests[0];
    assert.equal(tokenReq.body.grant_type, 'password');
    assert.equal(tokenReq.headers.authorization, undefined, 'no bearer on token endpoint');
    assert.ok(tokenReq.headers['ocp-apim-subscription-key']);
  } finally { await mock.close(); }
});

test('bad password -> UnauthorizedError and backoff (no hammering)', async () => {
  const { mock, api } = await setup({ api: { password: 'wrong' } });
  try {
    await assert.rejects(api.getDevices(), UnauthorizedError);
    await assert.rejects(api.getDevices(), /backing off/);
    assert.equal(mock.state.requests.filter((r) => r.url.includes('oauth')).length, 1);
  } finally { await mock.close(); }
});

test('401 mid-session triggers refresh_token grant and retries', async () => {
  const { mock, api } = await setup({ expireFirstToken: true });
  try {
    const devs = await api.getDevices();
    assert.equal(devs.length, 1);
    const grants = mock.state.requests.filter((r) => r.url.includes('oauth')).map((r) => r.body.grant_type);
    assert.deepEqual(grants, ['password', 'refresh_token']);
  } finally { await mock.close(); }
});

test('expired token is refreshed proactively', async () => {
  let now = 1_000_000;
  const { mock, api } = await setup({ api: { now: () => now } });
  try {
    await api.getDevices();
    now += 3600 * 1000; // past expiry
    await api.getProperties('dev-abc');
    const grants = mock.state.requests.filter((r) => r.url.includes('oauth')).map((r) => r.body.grant_type);
    assert.deepEqual(grants, ['password', 'refresh_token']);
  } finally { await mock.close(); }
});

test('commands use pykeurig payloads', async () => {
  const { mock, api } = await setup();
  try {
    await api.powerOn('dev-abc');
    await api.brewCustom('dev-abc', { size: 8, temp: 194, flowRate: INTENSITIES.Balanced });
    await api.cancelBrew('dev-abc');
    await api.powerOff('dev-abc');
    assert.deepEqual(mock.state.commands, [
      { command_name: 'idle' },
      { command_name: 'brew', params: { size: 8, brew_type: 'NORMAL', flow_rate: 4435, temp: 194, enhanced: true, category: 'CUSTOM' } },
      { command_name: 'cancel_brew' },
      { command_name: 'standby' },
    ]);
  } finally { await mock.close(); }
});

test('parseProperties: ready with pod', () => {
  const s = parseProperties(fx.properties());
  assert.equal(s.isOn, true);
  assert.equal(s.isReady, true);
  assert.equal(s.podLoaded, true);
  assert.equal(s.podBrand, 'Green Mountain');
  assert.equal(s.podVariety, 'Breakfast Blend');
  assert.equal(s.recipes.length, 2);
  assert.equal(describeStatus(s), 'ready');
});

test('parseProperties: locked, no water and lid open (comma list)', () => {
  const s = parseProperties(fx.properties({ brew: 'BREW_LOCKED', lock: 'ADD_WATER, PM_NOT_READY', pod: 'EMPTY' }));
  assert.equal(s.needsWater, true);
  assert.equal(s.lidOpen, true);
  assert.equal(s.podLoaded, false);
  assert.deepEqual(s.errors, ['ADD_WATER', 'PM_NOT_READY']);
  assert.equal(describeStatus(s), 'needs water');
});

test('parseProperties: off, used pod, and tolerant of missing nodes', () => {
  const s = parseProperties(fx.properties({ appl: 'STANDBY', pod: 'PUNCHED', details: false }));
  assert.equal(s.isOn, false);
  assert.equal(s.podUsed, true);
  assert.equal(describeStatus(s), 'off');
  const empty = parseProperties([]);
  assert.equal(empty.isOn, false);
  assert.equal(describeStatus(empty), 'unknown');
  assert.throws(() => parseProperties({}), /not an array/);
});

test('constructor requires credentials', () => {
  assert.throws(() => new KeurigApi({}), /required/);
});
