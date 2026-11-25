// Persists the user's plan in localStorage. Storage may be unavailable
// (private mode, sandboxed frames), so every access is guarded and the app
// keeps working in memory.

export const STORAGE_KEY = 'ne-pisirsem:v1';

export function createEmptyState() {
  return {
    schemaVersion: 1,
    settings: { servings: 4, includeOptional: false },
    days: {},          // { "2026-11-24": { eatingOut: false, slots: { main: { dishId, leftoverFrom } } } }
    shopping: {},      // { "2026-11-23": { bought: { ingredientId: true }, pantryNeeded: { ingredientId: true } } } keyed by week start
    groceries: { items: {} }, // Alışveriş tab: { items: { productId: { qty, bought, at } } }
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyState();
    const parsed = JSON.parse(raw);
    const empty = createEmptyState();
    return {
      ...empty,
      ...parsed,
      settings: sanitizeSettings({ ...empty.settings, ...(parsed.settings ?? {}) }),
    };
  } catch {
    return createEmptyState();
  }
}

/** A stored head count outside 1–200 (hand-edited or from an older version) falls back into range. */
function sanitizeSettings(settings) {
  const servings = Math.round(Number(settings.servings));
  return { ...settings, servings: Number.isFinite(servings) ? Math.min(200, Math.max(1, servings)) : 4 };
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
