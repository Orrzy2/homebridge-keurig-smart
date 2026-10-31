'use strict';

/**
 * Minimal client for the (unofficial, undocumented) Keurig SMART cloud API.
 *
 * Ported from pykeurig (dcmeglio/pykeurig, maintained forks by @jspeckman,
 * @arketec, and bundled in AdamSand10/homeassistant-keurig, Oct 2026).
 * No runtime dependencies: uses Node's built-in fetch (Node 18+).
 */

const DEFAULT_API_URL = 'https://iot.keurig.com/connected-platform/';
// Public app subscription key shipped in pykeurig 1.4.4.x (Oct 2026). Not a user secret.
// Keurig has rotated it before, so it can be overridden from config.
const DEFAULT_SUBSCRIPTION_KEY = '7a278473f01745d99c1b1c2692c5a110';
const CLIENT_ID = 'cbma-v1';

const C = Object.freeze({
  // appl_state.current
  STATUS_OFF: 'STANDBY',
  STATUS_ON: 'IDLE',
  STATUS_BREWING: 'BREW',
  // brew_state.current
  BREWER_READY: 'BREW_READY',
  BREWER_LOCKED: 'BREW_LOCKED',
  BREWER_CANCELING: 'BREW_CANCELING',
  BREWER_BREWING: 'BREW_IN_PROGRESS',
  BREWER_COMPLETE: 'BREW_SUCCESSFUL',
  // lock causes / errors
  ERR_OUT_OF_WATER: 'BREW_INSUFFICIENT_WATER',
  ERR_ADD_WATER: 'ADD_WATER',
  ERR_POD_NOT_REMOVED: 'PM_NOT_CYCLED',
  ERR_LID_OPEN: 'PM_NOT_READY',
  // lid_recog_result.pm_content
  POD_EMPTY: 'EMPTY',
  POD_LOADED: 'POD',
  POD_PUNCHED: 'PUNCHED',
  POD_BAD_IMAGE: 'BAD_IMAGE',
  POD_UNKNOWN: 'UNKNOWN',
  // commands
  CMD_BREW: 'brew',
  CMD_ON: 'idle',
  CMD_OFF: 'standby',
  CMD_CANCEL: 'cancel_brew',
});

const TEMPERATURES = { Warm: 187, Warmer: 191, Hot: 194, Hotter: 197, XHot: 200, MaxHot: 204 };
const INTENSITIES = { Balanced: 4435, Rich: 3942, Robust: 3449, Strong: 2957, Intense: 2464 };
const SIZES = [4, 6, 8, 10, 12];

class KeurigError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'KeurigError';
    this.status = status;
    this.body = body;
  }
}
class UnauthorizedError extends KeurigError {
  constructor(message, status, body) {
    super(message || 'Keurig rejected the credentials', status, body);
    this.name = 'UnauthorizedError';
  }
}
class RateLimitError extends KeurigError {
  constructor(retryAfterSec, body) {
    super(`Keurig rate limited the request (retry after ${retryAfterSec}s)`, 429, body);
    this.name = 'RateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

class KeurigApi {
  /**
   * @param {object} opts
   * @param {string} opts.email
   * @param {string} opts.password
   * @param {object} [opts.log] logger with debug/info/warn/error
   * @param {string} [opts.apiUrl]
   * @param {string} [opts.subscriptionKey]
   * @param {number} [opts.timeoutMs]
   * @param {Function} [opts.fetch] injectable fetch (tests)
   * @param {Function} [opts.now] injectable clock in ms (tests)
   */
  constructor(opts) {
    if (!opts || !opts.email || !opts.password) {
      throw new Error('Keurig email and password are required');
    }
    this.email = opts.email;
    this.password = opts.password;
    this.log = opts.log || console;
    this.apiUrl = (opts.apiUrl || DEFAULT_API_URL).replace(/\/?$/, '/');
    this.subscriptionKey = opts.subscriptionKey || DEFAULT_SUBSCRIPTION_KEY;
    this.timeoutMs = opts.timeoutMs || 15000;
    this.fetch = opts.fetch || globalThis.fetch;
    this.now = opts.now || Date.now;

    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiresAt = 0;
    this.customerId = null;
    this._authPromise = null;
    this._authFailures = 0;
    this._authRetryAt = 0;
  }

  _headers(auth) {
    const h = {
      'Ocp-Apim-Subscription-Key': this.subscriptionKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (auth && this.accessToken) {
      h.Authorization = 'Bearer ' + this.accessToken;
    }
    return h;
  }

  async _rawFetch(method, path, body, auth) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetch(this.apiUrl + path, {
        method,
        headers: this._headers(auth),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new KeurigError(`Keurig ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new KeurigError(`Keurig ${method} ${path} network error: ${err && err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  static async _readBody(res) {
    const text = await res.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // ---------- auth ----------

  async _tokenRequest(data) {
    const res = await this._rawFetch('POST', 'api/claa/v1/oauth/token', data, false);
    const body = await KeurigApi._readBody(res);
    if ([400, 401, 403].includes(res.status)) {
      throw new UnauthorizedError(`Keurig ${data.grant_type} grant rejected (HTTP ${res.status})`, res.status, body);
    }
    if (res.status === 429) {
      throw new RateLimitError(Number(res.headers.get('retry-after')) || 60, body);
    }
    if (!res.ok || !body || typeof body !== 'object' || !body.access_token) {
      throw new KeurigError(`Keurig ${data.grant_type} grant failed (HTTP ${res.status})`, res.status, body);
    }
    this.accessToken = body.access_token;
    const expiresIn = Number(body.expires_in) || 3600;
    // refresh 2 minutes early, like pykeurig
    this.tokenExpiresAt = this.now() + Math.max(expiresIn - 120, 30) * 1000;
    if (body.refresh_token) {
      this.refreshToken = body.refresh_token;
    }
  }

  async login() {
    await this._tokenRequest({
      grant_type: 'password',
      client_id: CLIENT_ID,
      username: this.email,
      password: this.password,
    });
    this.log.debug('Keurig login OK');
  }

  /** Refresh with refresh_token, falling back to full login. Single-flight. */
  async reauthenticate() {
    if (this._authPromise) {
      return this._authPromise;
    }
    this._authPromise = (async () => {
      if (this.now() < this._authRetryAt) {
        throw new KeurigError(`Keurig auth backing off for ${Math.ceil((this._authRetryAt - this.now()) / 1000)}s`);
      }
      if (this.refreshToken) {
        try {
          await this._tokenRequest({
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            refresh_token: this.refreshToken,
          });
          this._authFailures = 0;
          this.log.debug('Keurig access token refreshed');
          return;
        } catch (err) {
          this.log.debug(`Keurig token refresh failed (${err.message}); doing full login`);
          this.refreshToken = null;
        }
      }
      try {
        await this.login();
        this._authFailures = 0;
      } catch (err) {
        this._authFailures += 1;
        // Bad password: back off hard (1h) so we never hammer Keurig / lock the account.
        const delaySec = err instanceof UnauthorizedError
          ? 3600
          : Math.min(60 * 2 ** (this._authFailures - 1), 3600);
        this._authRetryAt = this.now() + delaySec * 1000;
        throw err;
      }
    })();
    try {
      await this._authPromise;
    } finally {
      this._authPromise = null;
    }
  }

  async ensureToken() {
    if (!this.accessToken || this.now() >= this.tokenExpiresAt) {
      await this.reauthenticate();
    }
  }

  async request(method, path, body) {
    await this.ensureToken();
    let res = await this._rawFetch(method, path, body, true);
    // pykeurig also treats 400 on GET as an expired token
    if (res.status === 401 || (res.status === 400 && method === 'GET')) {
      await res.text().catch(() => undefined);
      this.accessToken = null;
      await this.reauthenticate();
      res = await this._rawFetch(method, path, body, true);
    }
    const data = await KeurigApi._readBody(res);
    if (res.status === 401) {
      throw new UnauthorizedError(`Keurig ${method} ${path} unauthorized after re-login`, 401, data);
    }
    if (res.status === 429) {
      throw new RateLimitError(Number(res.headers.get('retry-after')) || 60, data);
    }
    if (!res.ok) {
      throw new KeurigError(`Keurig ${method} ${path} failed (HTTP ${res.status})`, res.status, data);
    }
    return data;
  }

  // ---------- account / devices ----------

  async getCustomer() {
    const profile = await this.request('GET', 'api/usdm/v1/user/profile');
    if (!profile || !profile.customerID) {
      throw new KeurigError('Keurig profile response had no customerID', 200, profile);
    }
    this.customerId = String(profile.customerID);
    return profile;
  }

  /** @returns {Promise<Array<{id:string, serial:string, model:string, name:string}>>} */
  async getDevices() {
    if (!this.customerId) {
      await this.getCustomer();
    }
    const data = await this.request('GET', 'api/alcm/v1/devices?customerId=' + encodeURIComponent(this.customerId));
    const list = (data && Array.isArray(data.devices)) ? data.devices : [];
    return list.map((d) => ({
      id: String(d.id),
      serial: d.serialNumber || String(d.id),
      model: d.model || 'Keurig SMART',
      name: (d.registration && d.registration.name) || d.model || 'Keurig',
    }));
  }

  async getProperties(deviceId) {
    const props = await this.request('GET', `api/acsm/v1/devices/${encodeURIComponent(deviceId)}/properties`);
    return parseProperties(props);
  }

  async sendCommand(deviceId, commandName, params) {
    const body = { command_name: commandName };
    if (params) {
      body.params = params;
    }
    return this.request('POST', `api/acsm/v1/devices/${encodeURIComponent(deviceId)}/commands`, body);
  }

  powerOn(deviceId) {
    return this.sendCommand(deviceId, C.CMD_ON);
  }

  powerOff(deviceId) {
    return this.sendCommand(deviceId, C.CMD_OFF);
  }

  cancelBrew(deviceId) {
    return this.sendCommand(deviceId, C.CMD_CANCEL);
  }

  /** Brew the loaded pod with custom settings (pykeurig brew_hot). */
  brewCustom(deviceId, { size, temp, flowRate }) {
    return this.sendCommand(deviceId, C.CMD_BREW, {
      size,
      brew_type: 'NORMAL',
      flow_rate: flowRate,
      temp,
      enhanced: true,
      category: 'CUSTOM',
    });
  }

  /** Brew the loaded pod using Keurig's recipe for that pod (pykeurig brew_recommendation). */
  brewRecommended(deviceId, { size, temp, flowRate }) {
    return this.sendCommand(deviceId, C.CMD_BREW, {
      size,
      brew_type: 'NORMAL',
      flow_rate: flowRate,
      temp,
      enhanced: true,
      category: 'MASTER',
    });
  }

  /** Brew hot water, no pod (pykeurig hot_water). */
  brewHotWater(deviceId, { size, temp }) {
    return this.sendCommand(deviceId, C.CMD_BREW, {
      size,
      brew_type: 'HOT_WATER',
      flow_rate: INTENSITIES.Balanced,
      temp,
      enhanced: true,
      category: 'WATER',
    });
  }
}

function findNode(props, name) {
  const node = props.find((p) => p && p.name === name);
  return node ? node.value : undefined;
}

function splitErrors(str) {
  if (!str || typeof str !== 'string') {
    return [];
  }
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

function pickLocalized(obj, prefix) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  const preferred = [`${prefix}en_ca`, `${prefix}ca`, `${prefix}en_us`, `${prefix}us`];
  for (const k of preferred) {
    if (obj[k]) {
      return obj[k];
    }
  }
  const any = Object.keys(obj).find((k) => k.startsWith(prefix) && obj[k]);
  return any ? obj[any] : null;
}

/**
 * Turn the raw /properties array into a flat status object.
 * Tolerant of missing nodes (returns nulls) instead of throwing like pykeurig.
 */
function parseProperties(props) {
  if (!Array.isArray(props)) {
    throw new KeurigError('Keurig properties response was not an array', 200, props);
  }
  const appl = findNode(props, 'appl_state') || {};
  const brew = findNode(props, 'brew_state') || {};
  const pod = findNode(props, 'lid_recog_result') || {};
  const sw = findNode(props, 'sw_info') || {};

  const lockCause = brew.lock_cause != null ? brew.lock_cause : null;
  const errors = splitErrors(lockCause != null ? lockCause : brew.error);

  const details = pod.pod_details || null;
  let recipes = [];
  let brand = null;
  let variety = null;
  if (details) {
    recipes = Array.isArray(details.recipes) ? details.recipes : [];
    brand = pickLocalized(details.brand, 'brand_name_');
    variety = pickLocalized(details.variety, 'variety_name_');
  }

  const applianceStatus = appl.current || null;
  const brewerStatus = brew.current || null;
  const podStatus = pod.pm_content || null;

  return {
    applianceStatus,
    brewerStatus,
    podStatus,
    errors,
    swVersion: sw.appliance || null,
    podBrand: brand,
    podVariety: variety,
    recipes,
    // derived
    isOn: applianceStatus === C.STATUS_ON || applianceStatus === C.STATUS_BREWING,
    isBrewing: applianceStatus === C.STATUS_BREWING || brewerStatus === C.BREWER_BREWING,
    isReady: brewerStatus === C.BREWER_READY,
    needsWater: errors.includes(C.ERR_ADD_WATER) || errors.includes(C.ERR_OUT_OF_WATER),
    lidOpen: errors.includes(C.ERR_LID_OPEN),
    podNotRemoved: errors.includes(C.ERR_POD_NOT_REMOVED),
    podLoaded: podStatus === C.POD_LOADED || podStatus === C.POD_PUNCHED || podStatus === C.POD_BAD_IMAGE,
    podUsed: podStatus === C.POD_PUNCHED,
  };
}

function describeStatus(s) {
  if (!s) {
    return 'unknown';
  }
  if (s.applianceStatus === C.STATUS_OFF) {
    return 'off';
  }
  if (s.isBrewing) {
    return 'brewing';
  }
  if (s.brewerStatus === C.BREWER_READY) {
    return 'ready';
  }
  if (s.brewerStatus === C.BREWER_COMPLETE) {
    return 'brew complete';
  }
  if (s.brewerStatus === C.BREWER_CANCELING) {
    return 'canceling';
  }
  if (s.needsWater) {
    return 'needs water';
  }
  if (s.podNotRemoved) {
    return 'used pod not removed';
  }
  if (s.lidOpen) {
    return 'lid open';
  }
  return [s.brewerStatus, ...s.errors].filter(Boolean).join(', ') || 'unknown';
}

module.exports = {
  KeurigApi,
  KeurigError,
  UnauthorizedError,
  RateLimitError,
  parseProperties,
  describeStatus,
  C,
  TEMPERATURES,
  INTENSITIES,
  SIZES,
  DEFAULT_API_URL,
  DEFAULT_SUBSCRIPTION_KEY,
};
