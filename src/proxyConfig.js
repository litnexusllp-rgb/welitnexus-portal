'use strict';
function trustProxy(env = process.env) {
  const value = env.TRUST_PROXY;
  // Railway's ingress must append/overwrite X-Forwarded-For. Direct local access ignores it.
  if (value === undefined) return env.RAILWAY_ENVIRONMENT_ID ? 1 : false;
  if (value === 'false' || value === '0') return false;
  if (value === 'true') throw new Error('TRUST_PROXY=true is unsafe; configure trusted CIDRs or an exact hop count');
  if (/^[1-9]\d*$/.test(value) && Number(value) <= 8) return Number(value);
  const entries = value.split(',').map(v => v.trim()).filter(Boolean);
  if (!entries.length) throw new Error('TRUST_PROXY must not be empty');
  require('proxy-addr').compile(entries); // reject invalid network configuration at startup
  return entries;
}
module.exports = { trustProxy };
