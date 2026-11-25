// Pure shopping-list logic (no DOM), so it can be unit-tested in Node.

export const AISLE_ORDER = ['produce', 'butcher', 'fishmonger', 'dairy', 'deli', 'breakfast', 'dry-goods', 'bakery', 'frozen', 'beverages', 'pantry'];

/**
 * Collects ingredients for the cooked (non-leftover) dishes of the given days.
 * @param {object} params
 * @param {Array<{date:string, eatingOut:boolean, slots:object}>} params.days
 * @param {Map<string,object>} params.dishesById
 * @param {Map<string,object>} params.ingredientsById
 * @param {number} params.servings          household size
 * @param {number} params.catalogServings   servings the catalog quantities are written for
 * @param {boolean} params.includeOptional
 * @param {Object<string, number>} [params.extras]  items the user added by hand: { ingredientId: quantity }
 *        (quantity 0 = no amount, e.g. spices). Extras always go to the list, pantry or not.
 * @returns {{ items: Array, pantryItems: Array, dishCount: number }}
 *          entries: { ingredient, quantity, dishIds, extraQuantity? }
 */
export function buildShoppingList({ days, dishesById, ingredientsById, servings, catalogServings, includeOptional, extras = {}, locale = 'tr' }) {
  const scale = servings / catalogServings;
  const totals = new Map();
  let dishCount = 0;

  for (const day of days) {
    if (day.eatingOut) continue;
    for (const slot of Object.values(day.slots ?? {})) {
      if (!slot?.dishId || slot.leftoverFrom) continue;
      const dish = dishesById.get(slot.dishId);
      if (!dish) continue;
      dishCount += 1;
      for (const line of dish.ingredients) {
        if (line.optional && !includeOptional) continue;
        const ingredient = ingredientsById.get(line.ingredientId);
        if (!ingredient) continue;
        const entry = totals.get(ingredient.id) ?? { ingredient, quantity: 0, dishIds: [] };
        entry.quantity += line.quantity * scale;
        if (!entry.dishIds.includes(dish.id)) entry.dishIds.push(dish.id);
        totals.set(ingredient.id, entry);
      }
    }
  }

  for (const [ingredientId, extraQuantity] of Object.entries(extras)) {
    const ingredient = ingredientsById.get(ingredientId);
    if (!ingredient) continue;
    const entry = totals.get(ingredientId) ?? { ingredient, quantity: 0, dishIds: [] };
    entry.quantity += extraQuantity;
    entry.extraQuantity = extraQuantity;
    totals.set(ingredientId, entry);
  }

  const all = [...totals.values()];
  const isExtra = (e) => e.extraQuantity !== undefined;
  // Alphabetical within each aisle (and among pantry staples), so an item is easy to find in the shop.
  const nameOf = (e) => e.ingredient.name?.[locale] ?? Object.values(e.ingredient.name ?? {})[0] ?? '';
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), locale);
  const byAisleThenName = (a, b) =>
    AISLE_ORDER.indexOf(a.ingredient.aisle) - AISLE_ORDER.indexOf(b.ingredient.aisle) || byName(a, b);

  return {
    items: all.filter((e) => !e.ingredient.pantry || isExtra(e)).sort(byAisleThenName),
    pantryItems: all.filter((e) => e.ingredient.pantry && !isExtra(e)).sort(byName),
    dishCount,
  };
}

const COUNTABLE_UNITS = new Set(['piece', 'clove', 'bunch', 'slice', 'pack', 'can', 'jar']);

/**
 * Rounds a quantity into something you can buy and returns { value, unit }.
 * Unit stays a code; the caller translates it.
 */
export function normalizeQuantity(quantity, unit) {
  if (unit === 'g') {
    if (quantity >= 1000) return { value: roundTo(quantity / 1000, 0.1), unit: 'kg' };
    return { value: Math.max(10, roundTo(quantity, quantity < 100 ? 10 : 50)), unit: 'g' };
  }
  if (unit === 'ml') {
    if (quantity >= 1000) return { value: roundTo(quantity / 1000, 0.1), unit: 'l' };
    return { value: Math.max(10, roundTo(quantity, 50)), unit: 'ml' };
  }
  if (COUNTABLE_UNITS.has(unit)) {
    // Whole items to buy; only less than one item may be a half (half a cabbage, half a bunch).
    return { value: quantity <= 0.5 ? 0.5 : Math.ceil(quantity - 1e-9), unit };
  }
  return { value: Math.max(0.5, Math.round(quantity * 2) / 2), unit }; // tbsp, tsp
}

function roundTo(value, step) {
  return Math.round(Math.ceil(value / step) * step * 1000) / 1000;
}
