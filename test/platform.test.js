'use strict';
// Drives the platform through Homebridge 2's real API + HAP classes, against the mock Keurig cloud.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMockKeurig } = require('./mock-server');
const plugin = require('../index');
const { TIMING } = require('../lib/platform');

Object.assign(TIMING, { fastPollMs: 100, powerOnStepMs: 50, powerOnWaitMs: 2000, brewStartGraceMs: 1500, confirmMs: 100 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting for condition');
}

function makeLog() {
  const lines = [];
  const log = (...a) => lines.push(['info', a.join(' ')]);
  for (const l of ['debug', 'info', 'warn', 'error', 'success']) log[l] = (...a) => lines.push([l, a.join(' ')]);
  log.lines = lines;
  return log;
}

async function boot(mockOpts, extraConfig) {
  const { HomebridgeAPI } = await import(pathToFileURL(path.join(__dirname, '../node_modules/homebridge/dist/api.js')).href);
  const mock = createMockKeurig(mockOpts);
  mock.state.brewDurationMs = 400;
  const port = await mock.listen();
  const api = new HomebridgeAPI();
  const registered = [];
  api.on('registerPlatformAccessories', (accs) => registered.push(...accs));
  let Ctor;
  api.registerPlatform = (pluginName, name, C) => { Ctor = C; };
  plugin(api);
  const log = makeLog();
  const platform = new Ctor(log, {
    platform: 'KeurigSmart', email: 'test@example.com', password: 'secret',
    apiUrl: `http://127.0.0.1:${port}/connected-platform/`, showHotWaterSwitch: true, ...extraConfig,
  }, api);
  api.signalFinished();
  await waitFor(() => platform.brewers.size === 1 && platform.brewers.get('dev-abc').status);
  return { api, mock, platform, log, registered, brewer: platform.brewers.get('dev-abc') };
}

function svc(acc, hap, subtype, type = hap.Service.Switch) {
  return acc.getServiceById(type, subtype);
}

test('discovers brewer and exposes services', async () => {
  const { api, mock, platform, registered, brewer } = await boot();
  try {
    const { Service, Characteristic } = api.hap;
    assert.equal(registered.length, 1);
    const acc = registered[0];
    assert.equal(acc.displayName, 'Kitchen Keurig');
    const names = acc.services.map((s) => `${s.displayName}`);
    for (const n of ['Coffee Maker Power', 'Brew', 'Hot Water', 'Needs Water', 'Pod Loaded', 'Lid']) {
      assert.ok(names.includes(n), `missing ${n}: ${names}`);
    }
    assert.equal(svc(acc, api.hap, 'power').getCharacteristic(Characteristic.On).value, false);
    assert.equal(svc(acc, api.hap, 'pod', Service.OccupancySensor).getCharacteristic(Characteristic.OccupancyDetected).value, 1);
    assert.equal(acc.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.FirmwareRevision).value, '1.2.3');
  } finally { brewer.stop(); api.emit('shutdown'); await mock.close(); }
});

test('power switch sends idle/standby', async () => {
  const { api, mock, registered, brewer } = await boot();
  try {
    const on = svc(registered[0], api.hap, 'power').getCharacteristic(api.hap.Characteristic.On);
    await on.handleSetRequest(true);
    assert.deepEqual(mock.state.commands.at(-1), { command_name: 'idle' });
    await waitFor(() => brewer.status.isOn);
    await on.handleSetRequest(false);
    assert.deepEqual(mock.state.commands.at(-1), { command_name: 'standby' });
  } finally { brewer.stop(); api.emit('shutdown'); await mock.close(); }
});

test('Brew: auto power-on, recommended recipe, switch turns off when done', async () => {
  const { api, mock, registered, brewer, log } = await boot();
  try {
    const brew = svc(registered[0], api.hap, 'brew').getCharacteristic(api.hap.Characteristic.On);
    await brew.handleSetRequest(true);
    await waitFor(() => mock.state.commands.some((c) => c.command_name === 'brew'));
    assert.deepEqual(mock.state.commands.map((c) => c.command_name), ['idle', 'brew']);
    assert.deepEqual(mock.state.commands[1].params, { size: 8, brew_type: 'NORMAL', flow_rate: 3942, temp: 192, enhanced: true, category: 'MASTER' });
    await waitFor(() => brew.value === true);
    await waitFor(() => brew.value === false && !brewer.brewJob, 5000);
    assert.ok(log.lines.some(([, m]) => m.includes('brew finished')));
  } finally { brewer.stop(); api.emit('shutdown'); await mock.close(); }
});

test('Brew refused when out of water: switch reverts, no brew command', async () => {
  const { api, mock, registered, brewer, log } = await boot();
  try {
    mock.state.device.lock = 'ADD_WATER';
    const brew = svc(registered[0], api.hap, 'brew').getCharacteristic(api.hap.Characteristic.On);
    await brew.handleSetRequest(true);
    await waitFor(() => log.lines.some(([l, m]) => l === 'warn' && m.includes('needs water')));
    await waitFor(() => brew.value === false);
    assert.ok(!mock.state.commands.some((c) => c.command_name === 'brew'));
    await brewer.refresh();
    const water = svc(registered[0], api.hap, 'water', api.hap.Service.OccupancySensor).getCharacteristic(api.hap.Characteristic.OccupancyDetected);
    assert.equal(water.value, 1);
  } finally { brewer.stop(); api.emit('shutdown'); await mock.close(); }
});

test('Brew custom mode + cancel by turning switch off', async () => {
  const { api, mock, registered, brewer } = await boot(undefined, { brewMode: 'custom', brewSize: 10, brewTemperature: 'XHot', brewIntensity: 'Strong' });
  try {
    mock.state.brewDurationMs = 5000;
    const brew = svc(registered[0], api.hap, 'brew').getCharacteristic(api.hap.Characteristic.On);
    await brew.handleSetRequest(true);
    await waitFor(() => mock.state.commands.some((c) => c.command_name === 'brew'));
    assert.deepEqual(mock.state.commands.find((c) => c.command_name === 'brew').params,
      { size: 10, brew_type: 'NORMAL', flow_rate: 2957, temp: 200, enhanced: true, category: 'CUSTOM' });
    await brew.handleSetRequest(false);
    assert.equal(mock.state.commands.at(-1).command_name, 'cancel_brew');
  } finally { brewer.stop(); api.emit('shutdown'); await mock.close(); }
});

test('missing credentials: logs error and does nothing', async () => {
  const { HomebridgeAPI } = await import(pathToFileURL(path.join(__dirname, '../node_modules/homebridge/dist/api.js')).href);
  const api = new HomebridgeAPI();
  let Ctor;
  api.registerPlatform = (a, b, C) => { Ctor = C; };
  plugin(api);
  const log = makeLog();
  const p = new Ctor(log, { platform: 'KeurigSmart' }, api);
  assert.equal(p.disabled, true);
  assert.ok(log.lines.some(([l]) => l === 'error'));
});

test('one-button mode: power switch hidden, custom name, 10 oz brew with auto power-on', async () => {
  const { api, mock, registered, brewer } = await boot(undefined, { showPowerSwitch: false, brewSwitchName: 'Brew 10 oz', brewSize: 10, showSensors: false, showHotWaterSwitch: false });
  try {
    const { Service, Characteristic } = api.hap;
    const acc = registered[0];
    assert.equal(svc(acc, api.hap, 'power'), undefined);
    assert.equal(acc.services.filter((s) => s.UUID === Service.Switch.UUID).length, 1);
    const b = svc(acc, api.hap, 'brew');
    assert.equal(b.getCharacteristic(Characteristic.Name).value, 'Brew 10 oz');
    await b.getCharacteristic(Characteristic.On).handleSetRequest(true);
    await waitFor(() => mock.state.commands.some((c) => c.command_name === 'brew'));
    assert.deepEqual(mock.state.commands.map((c) => c.command_name), ['idle', 'brew']);
    assert.equal(mock.state.commands[1].params.size, 10);
    brewer.refresh && await brewer.refresh().catch(() => {});
  } finally { brewer.stop(); api.emit('shutdown'); await mock.close(); }
});
