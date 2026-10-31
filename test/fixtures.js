'use strict';
// Response shapes reconstructed from the fields pykeurig 1.4.4.x reads.
// (No real captures: field names come from the reference code, values are illustrative.)

const tokenResponse = (n = 1) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: 3600,
  token_type: 'bearer',
});

const profile = { customerID: 'cust-123', email: 'someone@example.com' };

const devices = {
  devices: [
    {
      id: 'dev-abc',
      serialNumber: 'K29SN0001',
      model: 'K29',
      registration: { name: 'Kitchen Keurig' },
    },
  ],
};

function properties({ appl = 'IDLE', brew = 'BREW_READY', lock = null, error = null, pod = 'POD', details = true } = {}) {
  return [
    { name: 'appl_state', value: { current: appl } },
    { name: 'brew_state', value: { current: brew, lock_cause: lock, error } },
    {
      name: 'lid_recog_result',
      value: {
        pm_content: pod,
        pod_details: details && pod !== 'EMPTY' ? {
          brand: { brand_id: 12, brand_name_us: 'Green Mountain' },
          variety: {
            variety_id: 34,
            variety_name_en_us: 'Breakfast Blend',
            roast: 'LIGHT',
            is_tea: false,
            is_iced: false,
            is_flavored: false,
            is_powdered: false,
          },
          recipes: [
            { size: 8, temp: 192, flow_rate: 3942 },
            { size: 10, temp: 194, flow_rate: 4435 },
          ],
        } : null,
      },
    },
    { name: 'sw_info', value: { appliance: '1.2.3' } },
  ];
}

module.exports = { tokenResponse, profile, devices, properties };
