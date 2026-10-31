'use strict';

const { KeurigSmartPlatform, PLUGIN_NAME, PLATFORM_NAME } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, KeurigSmartPlatform);
};
