'use strict';

const {
  KeurigApi, UnauthorizedError, RateLimitError, describeStatus,
  TEMPERATURES, INTENSITIES, SIZES,
} = require('./keurig-api');

const PLUGIN_NAME = 'homebridge-keurig-smart';
const PLATFORM_NAME = 'KeurigSmart';

const MIN_POLL_SEC = 30;
const DEFAULT_POLL_SEC = 60;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
// Mutable only so tests can speed things up.
const TIMING = {
  fastPollMs: 5000, // while brewing / starting
  powerOnStepMs: 3000,
  powerOnWaitMs: 45000,
  brewStartGraceMs: 30000,
  maxBrewMs: 10 * 60 * 1000,
  confirmMs: 4000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickEnum(value, map, fallback) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && map[value] !== undefined) {
    return map[value];
  }
  return fallback;
}

class KeurigSmartPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.hap = api.hap;
    this.accessories = new Map(); // uuid -> PlatformAccessory
    this.brewers = new Map(); // deviceId -> BrewerHandler

    const c = this.config;
    if (!c.email || !c.password) {
      this.log.error('Keurig email and password are not set. Open the plugin settings in the Homebridge UI and enter your Keurig app login.');
      this.disabled = true;
      return;
    }

    const pollSec = Math.max(MIN_POLL_SEC, Number(c.pollInterval) || DEFAULT_POLL_SEC);
    const size = SIZES.includes(Number(c.brewSize)) ? Number(c.brewSize) : 8;
    this.settings = {
      pollMs: pollSec * 1000,
      brewMode: c.brewMode === 'custom' ? 'custom' : 'recommended',
      size,
      temp: pickEnum(c.brewTemperature, TEMPERATURES, TEMPERATURES.Hot),
      flowRate: pickEnum(c.brewIntensity, INTENSITIES, INTENSITIES.Balanced),
      hotWaterSize: SIZES.includes(Number(c.hotWaterSize)) ? Number(c.hotWaterSize) : size,
      hotWaterTemp: pickEnum(c.hotWaterTemperature, TEMPERATURES, TEMPERATURES.MaxHot),
      autoPowerOn: c.autoPowerOn !== false,
      showHotWater: c.showHotWaterSwitch === true,
      showSensors: c.showSensors !== false,
      showPower: c.showPowerSwitch !== false,
      brewName: (typeof c.brewSwitchName === 'string' && c.brewSwitchName.trim()) ? c.brewSwitchName.trim() : 'Brew',
    };

    this.client = new KeurigApi({
      email: c.email,
      password: c.password,
      apiUrl: c.apiUrl || undefined,
      subscriptionKey: c.subscriptionKey || undefined,
      log: this.log,
    });

    this.discoveryAttempt = 0;
    this.api.on('didFinishLaunching', () => this.discover());
    this.api.on('shutdown', () => {
      this.stopped = true;
      for (const b of this.brewers.values()) {
        b.stop();
      }
    });
  }

  /** Called by Homebridge for each cached accessory at startup. */
  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  async discover() {
    if (this.disabled || this.stopped) {
      return;
    }
    let devices;
    try {
      devices = await this.client.getDevices();
    } catch (err) {
      this.discoveryAttempt += 1;
      const delay = Math.min(30000 * 2 ** (this.discoveryAttempt - 1), MAX_BACKOFF_MS);
      if (err instanceof UnauthorizedError) {
        this.log.error('Keurig login failed: check the email and password in the plugin settings (they must be your Keurig app login). Retrying in 1 hour.');
        setTimeout(() => this.discover(), 3600 * 1000).unref?.();
      } else {
        this.log.warn(`Could not load Keurig devices (${err.message}). Retrying in ${Math.round(delay / 1000)}s.`);
        setTimeout(() => this.discover(), delay).unref?.();
      }
      // keep cached accessories as-is while offline
      for (const acc of this.accessories.values()) {
        if (!this.brewers.has(acc.context.deviceId) && acc.context.deviceId) {
          const h = new BrewerHandler(this, acc, acc.context.device);
          this.brewers.set(acc.context.deviceId, h);
          h.start();
        }
      }
      return;
    }

    this.discoveryAttempt = 0;
    if (devices.length === 0) {
      this.log.warn('No Keurig brewers found on this account. Make sure the brewer shows up in the Keurig app on the same login.');
    }

    const seen = new Set();
    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.id}`);
      seen.add(uuid);
      let acc = this.accessories.get(uuid);
      if (!acc) {
        acc = new this.api.platformAccessory(device.name, uuid);
        acc.context.deviceId = device.id;
        acc.context.device = device;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.set(uuid, acc);
        this.log.info(`Added Keurig brewer "${device.name}" (${device.model})`);
      } else {
        acc.context.deviceId = device.id;
        acc.context.device = device;
        this.api.updatePlatformAccessories([acc]);
      }
      const existing = this.brewers.get(device.id);
      if (existing) {
        existing.device = device;
        existing.start();
      } else {
        const handler = new BrewerHandler(this, acc, device);
        this.brewers.set(device.id, handler);
        handler.start();
      }
    }

    for (const [uuid, acc] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.info(`Removing Keurig brewer no longer on the account: ${acc.displayName}`);
        const h = this.brewers.get(acc.context.deviceId);
        if (h) {
          h.stop();
          this.brewers.delete(acc.context.deviceId);
        }
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.delete(uuid);
      }
    }
  }
}

class BrewerHandler {
  constructor(platform, accessory, device) {
    this.platform = platform;
    this.log = platform.log;
    this.client = platform.client;
    this.settings = platform.settings;
    this.accessory = accessory;
    this.device = device || { id: accessory.context.deviceId, name: accessory.displayName };
    this.status = null;
    this.timer = null;
    this.errorCount = 0;
    this.brewJob = null; // { kind, startedAt, sawBrewing }
    this.setupServices();
  }

  get id() {
    return this.device.id;
  }

  setupServices() {
    const { Service, Characteristic } = this.platform.hap;
    const acc = this.accessory;
    const s = this.settings;

    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Keurig')
      .setCharacteristic(Characteristic.Model, String(this.device.model || 'K-Supreme Plus SMART'))
      .setCharacteristic(Characteristic.SerialNumber, String(this.device.serial || this.device.id || 'unknown'));

    const ensure = (type, name, subtype, enabled) => {
      let svc = acc.getServiceById(type, subtype);
      if (!enabled) {
        if (svc) {
          acc.removeService(svc);
        }
        return null;
      }
      if (!svc) {
        svc = acc.addService(type, name, subtype);
      }
      // Name shown in the Home app for multi-service accessories
      if (!svc.testCharacteristic(Characteristic.ConfiguredName)) {
        svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
        svc.setCharacteristic(Characteristic.ConfiguredName, name);
      }
      svc.setCharacteristic(Characteristic.Name, name);
      return svc;
    };

    this.powerSvc = ensure(Service.Switch, 'Coffee Maker Power', 'power', s.showPower);
    if (this.powerSvc) {
      this.powerSvc.getCharacteristic(Characteristic.On)
        .onGet(() => Boolean(this.status && this.status.isOn))
        .onSet((v) => this.setPower(Boolean(v)));
    }

    this.brewSvc = ensure(Service.Switch, s.brewName, 'brew', true);
    this.brewSvc.getCharacteristic(Characteristic.On)
      .onGet(() => Boolean(this.brewJob && this.brewJob.kind === 'coffee') || Boolean(this.status && this.status.isBrewing && !this.brewJob))
      .onSet((v) => this.setBrew('coffee', Boolean(v)));

    this.hotWaterSvc = ensure(Service.Switch, 'Hot Water', 'hotwater', s.showHotWater);
    if (this.hotWaterSvc) {
      this.hotWaterSvc.getCharacteristic(Characteristic.On)
        .onGet(() => Boolean(this.brewJob && this.brewJob.kind === 'water'))
        .onSet((v) => this.setBrew('water', Boolean(v)));
    }

    this.waterSvc = ensure(Service.OccupancySensor, 'Needs Water', 'water', s.showSensors);
    if (this.waterSvc) {
      this.waterSvc.getCharacteristic(Characteristic.OccupancyDetected)
        .onGet(() => (this.status && this.status.needsWater ? 1 : 0));
    }
    this.podSvc = ensure(Service.OccupancySensor, 'Pod Loaded', 'pod', s.showSensors);
    if (this.podSvc) {
      this.podSvc.getCharacteristic(Characteristic.OccupancyDetected)
        .onGet(() => (this.status && this.status.podLoaded ? 1 : 0));
    }
    this.lidSvc = ensure(Service.ContactSensor, 'Lid', 'lid', s.showSensors);
    if (this.lidSvc) {
      this.lidSvc.getCharacteristic(Characteristic.ContactSensorState)
        .onGet(() => (this.status && this.status.lidOpen ? 1 : 0));
    }
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => this.poll(), ms);
    this.timer.unref?.();
  }

  nextDelay() {
    if (this.brewJob || (this.status && this.status.isBrewing)) {
      return TIMING.fastPollMs;
    }
    return this.settings.pollMs;
  }

  async poll() {
    if (this.stopped) {
      return;
    }
    try {
      await this.refresh();
      this.errorCount = 0;
      this.schedule(this.nextDelay());
    } catch (err) {
      this.errorCount += 1;
      let delay = Math.min(this.settings.pollMs * 2 ** Math.min(this.errorCount - 1, 4), MAX_BACKOFF_MS);
      if (err instanceof RateLimitError) {
        delay = Math.max(delay, err.retryAfterSec * 1000);
      }
      if (err instanceof UnauthorizedError) {
        delay = Math.max(delay, 3600 * 1000);
        this.log.error(`[${this.device.name}] Keurig login rejected; check credentials. Next try in 1h.`);
      } else if (this.errorCount <= 3 || this.errorCount % 10 === 0) {
        this.log.warn(`[${this.device.name}] status update failed (${err.message}); retrying in ${Math.round(delay / 1000)}s`);
      }
      this.schedule(delay);
    }
  }

  async refresh() {
    const st = await this.client.getProperties(this.id);
    const prev = this.status ? describeStatus(this.status) : null;
    this.status = st;
    const now = describeStatus(st);
    if (prev !== now) {
      this.log.info(`[${this.device.name}] ${now}${st.podBrand ? ` (pod: ${[st.podBrand, st.podVariety].filter(Boolean).join(' ')})` : ''}`);
    }
    if (st.swVersion) {
      const { Service, Characteristic } = this.platform.hap;
      this.accessory.getService(Service.AccessoryInformation)
        .updateCharacteristic(Characteristic.FirmwareRevision, String(st.swVersion));
    }
    this.trackBrewJob();
    this.pushState();
    return st;
  }

  trackBrewJob() {
    const job = this.brewJob;
    if (!job || job.phase !== 'sent') {
      return;
    }
    const st = this.status;
    const elapsed = Date.now() - job.sentAt;
    if (st.isBrewing) {
      job.sawBrewing = true;
      if (elapsed > TIMING.maxBrewMs) {
        this.log.warn(`[${this.device.name}] brew still reported after 10 min; resetting switch`);
        this.brewJob = null;
      }
      return;
    }
    if (job.sawBrewing) {
      this.log.info(`[${this.device.name}] brew finished`);
      this.brewJob = null;
    } else if (elapsed > TIMING.brewStartGraceMs) {
      this.log.warn(`[${this.device.name}] brewer never started brewing (${describeStatus(st)})`);
      this.brewJob = null;
    }
  }

  pushState() {
    const { Characteristic } = this.platform.hap;
    const st = this.status || {};
    if (this.powerSvc) this.powerSvc.updateCharacteristic(Characteristic.On, Boolean(st.isOn));
    const brewingExternally = Boolean(st.isBrewing) && !this.brewJob;
    this.brewSvc.updateCharacteristic(Characteristic.On,
      Boolean(this.brewJob && this.brewJob.kind === 'coffee') || brewingExternally);
    if (this.hotWaterSvc) {
      this.hotWaterSvc.updateCharacteristic(Characteristic.On, Boolean(this.brewJob && this.brewJob.kind === 'water'));
    }
    if (this.waterSvc) {
      this.waterSvc.updateCharacteristic(Characteristic.OccupancyDetected, st.needsWater ? 1 : 0);
    }
    if (this.podSvc) {
      this.podSvc.updateCharacteristic(Characteristic.OccupancyDetected, st.podLoaded ? 1 : 0);
    }
    if (this.lidSvc) {
      this.lidSvc.updateCharacteristic(Characteristic.ContactSensorState, st.lidOpen ? 1 : 0);
    }
  }

  commError(err) {
    this.log.error(`[${this.device.name}] ${err.message}`);
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async setPower(on) {
    try {
      if (on) {
        await this.client.powerOn(this.id);
      } else {
        if (this.brewJob) {
          this.brewJob = null;
        }
        await this.client.powerOff(this.id);
      }
      this.log.info(`[${this.device.name}] power ${on ? 'on' : 'off'} sent`);
      if (this.status) {
        this.status.isOn = on;
      }
      // confirm shortly after
      this.schedule(TIMING.confirmMs);
    } catch (err) {
      throw this.commError(err);
    }
  }

  /** Revert a switch to off a moment after HomeKit set it on. */
  revert(kind, reason) {
    this.log.warn(`[${this.device.name}] can't ${kind === 'water' ? 'brew hot water' : 'brew'}: ${reason}`);
    this.brewJob = null;
    setTimeout(() => this.pushState(), 500);
  }

  async setBrew(kind, on) {
    if (!on) {
      if (this.brewJob || (this.status && this.status.isBrewing)) {
        this.brewJob = null;
        try {
          await this.client.cancelBrew(this.id);
          this.log.info(`[${this.device.name}] brew cancel sent`);
          this.schedule(TIMING.confirmMs);
        } catch (err) {
          throw this.commError(err);
        }
      }
      return;
    }
    if (this.brewJob) {
      return; // already brewing/starting
    }
    if (this.status && this.status.isBrewing) {
      return;
    }
    // Run the (possibly slow) start sequence in the background so HomeKit isn't kept waiting.
    this.brewJob = { kind, phase: 'starting', sawBrewing: false };
    this.startBrew(kind).catch((err) => this.revert(kind, err.message));
  }

  async startBrew(kind) {
    let st = await this.client.getProperties(this.id);
    this.status = st;

    if (!st.isOn) {
      if (!this.settings.autoPowerOn) {
        return this.revert(kind, 'coffee maker is off (turn it on first, or enable "Power on automatically")');
      }
      this.log.info(`[${this.device.name}] powering on before brewing`);
      await this.client.powerOn(this.id);
      const deadline = Date.now() + TIMING.powerOnWaitMs;
      let blockedCount = 0;
      while (Date.now() < deadline) {
        await sleep(TIMING.powerOnStepMs);
        if (!this.brewJob) {
          return; // cancelled meanwhile
        }
        st = await this.client.getProperties(this.id);
        this.status = st;
        if (st.isReady) {
          break;
        }
        // A real blocker (water / lid / old pod) seen twice in a row: stop waiting.
        const blocked = st.needsWater || st.lidOpen || st.podNotRemoved;
        blockedCount = blocked ? blockedCount + 1 : 0;
        if (blockedCount >= 2) {
          break;
        }
      }
    }

    if (!this.brewJob) {
      return;
    }
    if (!st.isReady) {
      return this.revert(kind, describeStatus(st));
    }
    if (kind === 'coffee' && !st.podLoaded) {
      return this.revert(kind, 'no pod detected');
    }
    if (kind === 'coffee' && st.podUsed) {
      return this.revert(kind, 'the pod in the brewer is already used');
    }
    if (kind === 'water' && st.podLoaded) {
      return this.revert(kind, 'remove the pod first');
    }

    const s = this.settings;
    if (kind === 'water') {
      await this.client.brewHotWater(this.id, { size: s.hotWaterSize, temp: s.hotWaterTemp });
      this.log.info(`[${this.device.name}] brewing ${s.hotWaterSize} oz hot water`);
    } else {
      const recipe = s.brewMode === 'recommended'
        ? (st.recipes || []).find((r) => Number(r.size) === s.size)
        : null;
      if (recipe && recipe.temp && recipe.flow_rate) {
        await this.client.brewRecommended(this.id, { size: s.size, temp: recipe.temp, flowRate: recipe.flow_rate });
        this.log.info(`[${this.device.name}] brewing ${s.size} oz using the pod's recommended recipe`);
      } else {
        await this.client.brewCustom(this.id, { size: s.size, temp: s.temp, flowRate: s.flowRate });
        this.log.info(`[${this.device.name}] brewing ${s.size} oz (custom: ${s.temp}°F, flow ${s.flowRate})`);
      }
    }
    if (this.brewJob) {
      this.brewJob.phase = 'sent';
      this.brewJob.sentAt = Date.now();
    }
    this.schedule(TIMING.fastPollMs);
  }
}

module.exports = { KeurigSmartPlatform, BrewerHandler, PLUGIN_NAME, PLATFORM_NAME, TIMING };
