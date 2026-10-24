'use strict';
const ipaddr = require('ipaddr.js');
function ipKey(req) {
  let address;
  try { address = ipaddr.process(req.ip); }
  catch (_) { throw Object.assign(new Error('Invalid client IP address'), { status: 400 }); }
  if (address.kind() === 'ipv4') return address.toString();
  // Group IPv6 privacy addresses by /56 so rotating addresses cannot reset a budget.
  const bytes = address.toByteArray();
  bytes.fill(0, 7);
  return ipaddr.fromByteArray(bytes).toNormalizedString() + '/56';
}
module.exports = { ipKey };
