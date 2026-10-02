// netlify/functions/_lib/stripe-client.js
// NOT a deployed function — the only place a Stripe client is created.
//
// The four payment functions used to build their client ONCE, at load time, from the
// deployment's STRIPE_SECRET_KEY. With several workspaces on one deployment that would
// have charged every client's tenants through the platform owner's Stripe account.
// The client is now built per request from the CURRENT workspace's key: for the default
// workspace that is still STRIPE_SECRET_KEY, for any other workspace only its own key —
// and if it has none this throws, rather than ever using someone else's.
//
// Clients are cached by key (a client is just a key plus settings, so reusing one is safe,
// and there is one per workspace at most).

const { getConfig } = require('./workspace');

const _clients = new Map();

function getStripe() {
  const key = getConfig('STRIPE_SECRET_KEY');
  if (!key) throw new Error('Stripe is not configured for this workspace');
  let client = _clients.get(key);
  if (!client) {
    client = require('stripe')(key);
    _clients.set(key, client);
  }
  return client;
}

module.exports = { getStripe };
