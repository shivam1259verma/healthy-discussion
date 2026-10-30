import { createKainoServerClient } from '@kainostore/sdk/server';
import { getConfig } from './config.mjs';

let cached;
let cachedKey;

// Server client, created lazily from the managed bindings. Credentials never
// reach the browser.
export function getKaino() {
  const cfg = getConfig();
  const key = [cfg.marketplaceUrl, cfg.clientId, cfg.clientSecret, cfg.issuer].join('\u0000');
  if (!cached || key !== cachedKey) {
    cached = createKainoServerClient({
      marketplaceUrl: cfg.marketplaceUrl,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      assertionIssuer: cfg.issuer,
    });
    cachedKey = key;
  }
  return cached;
}
