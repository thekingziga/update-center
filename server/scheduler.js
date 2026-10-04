// Policy scheduler: scheduled upgrades and periodic update checks. Runs in hub local time.
import { listHosts, setHostJson, now } from './db.js';
import { isOnline } from './agents.js';
import { startJob, refreshHost } from './actions.js';
import { notify } from './notify.js';

const LATE_WINDOW_MIN = 60; // a missed slot (hub was down) still runs within this many minutes

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const localDate = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

function tick() {
  const d = new Date();
  const today = localDate(d);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  for (const host of listHosts()) {
    const { policy: p, state } = host;
    if (p.auto_update && p.days.includes(d.getDay()) && state.last_auto_update !== today) {
      const diff = nowMin - minutes(p.time);
      if (diff >= 0 && diff <= LATE_WINDOW_MIN) {
        setHostJson(host.id, 'state', { ...state, last_auto_update: today });
        try {
          startJob(host.id, 'upgrade', { security_only: p.security_only }, 'schedule');
        } catch (e) {
          notify(`⚠️ **${host.name}**: scheduled update skipped — ${e.message}`, { hostId: host.id, level: 'warn' });
        }
        continue;
      }
    }
    const checked = host.inventory.checked_at || 0;
    const asked = state.refresh_requested_at || 0;
    if (isOnline(host.id) && now() - checked > p.check_hours * 3600e3 && now() - asked > 15 * 60e3) {
      try { refreshHost(host.id); } catch { /* went offline meanwhile */ }
    }
  }
}

export function startScheduler() {
  setInterval(() => { try { tick(); } catch (e) { console.error('scheduler:', e); } }, 30_000).unref();
}
