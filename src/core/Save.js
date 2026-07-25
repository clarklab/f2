/**
 * Save — persisted records and settings.
 *
 * localStorage can be unavailable (private mode, disabled cookies, an iframe
 * with a restrictive sandbox), and a demo that throws on load because it could
 * not save a lap time is a bad demo. Every access is guarded and the game runs
 * identically without persistence.
 */

const KEY = 'velocity-zero/v1';

const DEFAULTS = {
  records: {},          // trackId -> best lap seconds
  raceRecords: {},      // trackId -> best total race time
  settings: {
    muted: false,
    autoAccelerate: true,
    difficulty: 1,
    machineId: 'blue-falcon',
  },
  cupCleared: {},
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      settings: { ...DEFAULTS.settings, ...(parsed.settings ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

let state = null;

export const Save = {
  get data() {
    if (!state) state = read();
    return state;
  },

  flush() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Storage unavailable or full; records are simply not persisted.
    }
  },

  bestLap(trackId) {
    return this.data.records[trackId] ?? null;
  },

  /** @returns {boolean} true if this is a new record. */
  submitLap(trackId, seconds) {
    if (!isFinite(seconds) || seconds <= 0) return false;
    const prev = this.data.records[trackId];
    if (prev != null && prev <= seconds) return false;
    this.data.records[trackId] = seconds;
    this.flush();
    return true;
  },

  submitRace(trackId, seconds) {
    if (!isFinite(seconds) || seconds <= 0) return false;
    const prev = this.data.raceRecords[trackId];
    if (prev != null && prev <= seconds) return false;
    this.data.raceRecords[trackId] = seconds;
    this.flush();
    return true;
  },

  setSetting(key, value) {
    this.data.settings[key] = value;
    this.flush();
  },
};
