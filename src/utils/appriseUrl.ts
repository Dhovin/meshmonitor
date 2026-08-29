/**
 * Apprise URL normalization utilities.
 *
 * Apprise expects notification service URLs with their respective schemes
 * (e.g. `discord://<webhook_id>/<webhook_token>`). Users commonly copy and
 * paste native HTTPS webhook URLs (e.g. `https://discord.com/api/webhooks/<id>/<token>`)
 * directly from service integration dashboards.
 *
 * This utility converts standard webhook URLs into their Apprise equivalent
 * so users can paste URLs without manual reformatting.
 */

// Matches standard Discord webhook URLs:
// https://discord.com/api/webhooks/<id>/<token>
// https://discordapp.com/api/webhooks/<id>/<token>
// https://ptb.discord.com/api/webhooks/<id>/<token>
// https://canary.discord.com/api/webhooks/<id>/<token>
const DISCORD_WEBHOOK_REGEX =
  /^\s*https?:\/\/(?:[a-zA-Z0-9-]+\.)*discord(?:app)?\.com\/api\/webhooks\/([0-9]+)\/([^/?\s]+).*\s*$/i;

/**
 * Normalizes a single notification URL for Apprise.
 * If the URL is a Discord HTTPS webhook URL, it converts it to `discord://<id>/<token>`.
 * Other URLs are returned trimmed.
 */
export function normalizeAppriseUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }

  const trimmed = rawUrl.trim();
  const discordMatch = trimmed.match(DISCORD_WEBHOOK_REGEX);
  if (discordMatch) {
    const [, webhookId, webhookToken] = discordMatch;
    return `discord://${webhookId}/${webhookToken}`;
  }

  return trimmed;
}

/**
 * Normalizes an array of notification URLs, filtering out empty entries.
 */
export function normalizeAppriseUrls(urls: string[]): string[] {
  if (!Array.isArray(urls)) {
    return [];
  }

  return urls
    .map(normalizeAppriseUrl)
    .filter(url => url.length > 0);
}
