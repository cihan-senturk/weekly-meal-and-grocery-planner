// Keeps the plan the same on every paired device.
//
// One shared document per pairing code holds { days, shopping, settings }. Each device keeps its own
// localStorage copy (so it works offline and without sync) and sends only what changed, as small
// field-level updates: one day, one ticked item, one setting. Two devices editing different things
// at the same time therefore never overwrite each other; the same field edited on both keeps the
// later write.
//
// The backend is injected (Firebase in production, a fake in tests):
//   create(code, data) → Promise
//   subscribe(code, { onData(data, status), onMissing(), onError(error) }) → unsubscribe()
//       status: 'synced' | 'pending' (local writes not yet confirmed) | 'offline' (served from cache)
//   update(code, changes) → Promise   changes: [[pathArray, value | undefined (= delete)]]
//   remove(code) → Promise

export const SYNC_KEY = 'ne-pisirsem:sync';
const SHARED = ['days', 'shopping', 'settings'];
// How deep a change is tracked: a whole day, one key of a week's bought/pantry/extras map, one setting.
const DEPTH = { days: 1, shopping: 3, settings: 1 };
const CODE_LENGTH = 22;

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isValidCode(code) {
  return typeof code === 'string' && code.length === CODE_LENGTH && /^[A-Za-z0-9_-]+$/.test(code);
}

/** Accepts a pasted pairing link or a bare code. */
export function codeFromText(text) {
  const value = String(text ?? '').trim();
  const match = value.match(/[#&?]sync=([A-Za-z0-9_-]+)/);
  const code = match ? match[1] : value;
  return isValidCode(code) ? code : null;
}

export function pairingLink(code, location = window.location) {
  return `${location.origin}${location.pathname}#sync=${code}`;
}

/** The shared part of the state, as plain JSON (no undefined, safe for any backend). */
export function sharedPart(state) {
  const part = {};
  for (const key of SHARED) part[key] = state?.[key] ?? {};
  return JSON.parse(JSON.stringify(part));
}

/** Field-level differences between two shared parts. */
export function diffShared(before, after) {
  const changes = [];
  const walk = (a, b, path, depth) => {
    const objects = depth > 0 && isPlainObject(a ?? {}) && isPlainObject(b ?? {});
    if (!objects) {
      if (JSON.stringify(a) !== JSON.stringify(b)) changes.push([path, b === undefined ? undefined : b]);
      return;
    }
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const key of keys) walk(a?.[key], b?.[key], [...path, key], depth - 1);
  };
  for (const key of SHARED) walk(before?.[key], after?.[key], [key], DEPTH[key]);
  return changes;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** localStorage, or a stand-in for this visit where it is blocked (sandboxed frames, some private modes). */
function safeStorage() {
  try {
    const storage = window.localStorage;
    storage.getItem(SYNC_KEY);
    return storage;
  } catch {
    const memory = new Map();
    return { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) };
  }
}

function readRecord(storage) {
  try {
    const record = JSON.parse(storage.getItem(SYNC_KEY) ?? 'null');
    return record && isValidCode(record.code) ? record : null;
  } catch {
    return null;
  }
}

function writeRecord(storage, record) {
  try {
    if (record) storage.setItem(SYNC_KEY, JSON.stringify(record));
    else storage.removeItem(SYNC_KEY);
  } catch { /* storage unavailable: sync lasts for this visit only */ }
}

/**
 * @param {object} options
 * @param {() => Promise<object>} options.loadBackend   resolves the backend (lazy: the SDK loads only when needed)
 * @param {() => object} options.getState               the app's current state
 * @param {(shared: object) => void} options.applyRemote replace the app's shared part and re-render
 * @param {(info: {status: string, code: string|null}) => void} options.onStatus
 * @param {(reason: 'missing'|'invalid') => void} options.onEnded  the shared document is gone
 * @param {Storage} [options.storage]
 */
export function createSync({ loadBackend, getState, applyRemote, onStatus, onEnded, storage = safeStorage() }) {
  let record = readRecord(storage); // { code, base, joined: boolean }
  let backend = null;
  let unsubscribe = null;
  let status = record ? 'connecting' : 'off';
  let gotData = false;
  let starting = null;

  const setStatus = (next) => {
    status = next;
    onStatus({ status, code: record?.code ?? null });
  };
  const saveBase = (base) => {
    if (!record) return;
    record = { ...record, base };
    writeRecord(storage, record);
  };

  async function ensureBackend() {
    if (backend) return backend;
    starting ??= loadBackend().then((b) => { backend = b; return b; }).finally(() => { starting = null; });
    return starting;
  }

  function listen() {
    unsubscribe?.();
    gotData = false;
    const code = record.code;
    unsubscribe = backend.subscribe(code, {
      onData(data, nextStatus) {
        if (!record || record.code !== code) return;
        gotData = true;
        const remote = sharedPart(data);
        // Changes made here while the SDK was not loaded yet (offline start) are sent before adopting the remote copy.
        if (!record.joined) {
          record = { ...record, joined: true };
          writeRecord(storage, record);
        }
        saveBase(remote);
        applyRemote(sharedPart(remote)); // a separate copy: the app mutates its state in place
        setStatus(nextStatus);
      },
      onMissing() {
        if (!record || record.code !== code) return;
        const reason = record.joined ? 'missing' : 'invalid';
        stop();
        onEnded(reason);
      },
      onError() {
        if (record?.code === code) setStatus('error');
      },
    });
  }

  async function start() {
    if (!record) return;
    setStatus('connecting');
    try {
      await ensureBackend();
    } catch {
      setStatus('error'); // SDK could not load (offline, blocked); retried when the browser is back online
      return;
    }
    if (!record) return;
    // Edits made while disconnected: send them first, so the remote copy includes them.
    if (record.joined && record.base) push();
    listen();
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = null;
    record = null;
    writeRecord(storage, null);
    setStatus('off');
  }

  /** Called after every local change. */
  function push() {
    if (!record?.joined || !backend) return;
    const current = sharedPart(getState());
    const changes = diffShared(record.base ?? {}, current);
    if (!changes.length) return;
    saveBase(sharedPart(current));
    backend.update(record.code, changes).catch(() => setStatus('error'));
  }

  return {
    get status() { return status; },
    get code() { return record?.code ?? null; },
    get connected() { return Boolean(record); },
    start,
    push,

    /** This device shares its current plan under a new code. */
    async create() {
      const code = newCode();
      await ensureBackend();
      const data = sharedPart(getState());
      await backend.create(code, data);
      record = { code, base: sharedPart(data), joined: true };
      writeRecord(storage, record);
      listen();
      setStatus('synced');
      return code;
    },

    /** This device takes over the plan shared under `code` (its own plan is replaced once the data arrives). */
    async join(code) {
      unsubscribe?.();
      record = { code, base: null, joined: false };
      writeRecord(storage, record);
      setStatus('connecting');
      await start();
    },

    /** Stop syncing on this device only. Its local copy stays as it is. */
    leave() {
      stop();
    },

    /** New code with the same plan; the old one stops working, so every other device is disconnected. */
    async reset() {
      if (!record) return null;
      const oldCode = record.code;
      unsubscribe?.();
      unsubscribe = null;
      const code = newCode();
      await ensureBackend();
      const data = sharedPart(getState());
      await backend.create(code, data);
      record = { code, base: sharedPart(data), joined: true };
      writeRecord(storage, record);
      listen();
      setStatus('synced');
      backend.remove(oldCode).catch(() => { /* already gone */ });
      return code;
    },

    /** Another tab changed the sync record (paired, left or reset there). */
    reloadRecord() {
      const next = readRecord(storage);
      if (next?.code === record?.code) {
        if (next) record = next;
        return;
      }
      unsubscribe?.();
      unsubscribe = null;
      record = next;
      if (record) start();
      else setStatus('off');
    },

    get receivedData() { return gotData; },
  };
}
