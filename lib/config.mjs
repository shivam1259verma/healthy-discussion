// Runtime configuration. Read lazily (per request) so the image can build and
// pass health checks before Kainostore's managed bindings are active.
export function getConfig() {
  const appId = (process.env.KAINO_APP_ID ?? '').trim();
  const marketplaceUrl = (process.env.KAINO_MARKETPLACE_URL ?? '').trim().replace(/\/+$/, '');
  const appSlug = (process.env.KAINO_APP_SLUG ?? process.env.NEXT_PUBLIC_KAINO_APP_REF ?? '').trim();
  return {
    appId,
    appSlug,
    marketplaceUrl,
    clientId: (process.env.KAINO_INTEGRATION_CLIENT_ID ?? '').trim(),
    clientSecret: (process.env.KAINO_INTEGRATION_CLIENT_SECRET ?? '').trim(),
    issuer: (process.env.KAINO_INTEGRATED_SESSION_ISSUER ?? '').trim() || 'kaino-marketplace',
    deploymentUrl: (process.env.KAINO_DEPLOYMENT_URL ?? '').trim(),
    // Plaintext database access is allowed only for loopback development outside
    // Kainostore hosting; the SDK helper enforces this and refuses otherwise.
    localDevelopment: process.env.KAINO_LOCAL_DEV === '1',
  };
}

export function launchUrl(cfg = getConfig()) {
  if (!cfg.marketplaceUrl || !cfg.appSlug) return null;
  return `${cfg.marketplaceUrl}/integrations/launch/${encodeURIComponent(cfg.appSlug)}`;
}
