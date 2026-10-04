// Single place for notifications: activity log + live UI + Discord (bot channel or webhook).
import { logEvent } from './db.js';
import { broadcast } from './ui.js';
import { sendDiscord } from './discord.js';

/**
 * @param {string} text Markdown (Discord-flavoured).
 * @param {{hostId?: string, level?: 'info'|'warn'|'error', approval?: object, quiet?: boolean}} opts
 *   quiet: log + UI only, no Discord message.
 */
export function notify(text, { hostId = null, level = 'info', approval = null, quiet = false } = {}) {
  const event = logEvent(hostId, level, text);
  broadcast({ type: 'event', event });
  if (!quiet) sendDiscord(text, approval).catch((e) => console.error('discord:', e.message));
}
