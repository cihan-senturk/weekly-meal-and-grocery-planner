// Weekly balance tips based on public dietary guidelines (no DOM; testable in Node).
// The planner covers dinners, so rules count dinners (days), not every meal of the day.
// Dishes on eating-out days count too: they are left out of the shopping list only.
// Every rule is returned with `met`, so the UI can list all guidelines and tick the ones the week follows.
//
// Sources (see docs/nutrition.md):
//  - Fish twice a week: American Heart Association; Turkish university dietetics guides based on TÜBER.
//  - Legumes 2–3 times a week: Turkish dietetics guidance (TÜBER-based).
//  - Red meat at most ~3 portions a week, processed meat as little as possible: World Cancer Research Fund.
//  - Vegetables with every meal: WHO (at least 400 g fruit and vegetables a day).

export const NUTRITION_RULES = [
  { id: 'fish', kind: 'atLeast', categories: ['fish'], target: 2 },
  { id: 'legume', kind: 'atLeast', categories: ['legume'], target: 2 },
  { id: 'vegetables', kind: 'everyDay', categories: ['vegetable', 'olive-oil'], courses: ['salad'] },
  { id: 'redMeat', kind: 'atMost', categories: ['meat'], limit: 3 },
  { id: 'processedMeat', kind: 'atMost', ingredientIds: ['sucuk', 'salami', 'sausages'], limit: 1 },
];

/** Dishes eaten on a day (leftovers and dishes eaten out included: they are eaten too). */
function dishesOfDay(day, dishesById) {
  return Object.entries(day.slots ?? {})
    .filter(([, slot]) => slot?.dishId && dishesById.has(slot.dishId))
    .map(([course, slot]) => ({ course, dish: dishesById.get(slot.dishId) }));
}

function dayMatches(entries, rule) {
  return entries.some(({ course, dish }) =>
    rule.categories?.includes(dish.category) ||
    rule.courses?.includes(course) ||
    dish.ingredients.some((line) => !line.optional && rule.ingredientIds?.includes(line.ingredientId)));
}

/**
 * @param {Array<{iso:string, eatingOut:boolean, slots:object}>} days  the 7 days of the week
 * @param {Map<string,object>} dishesById
 * @returns {Array<{id:string, kind:string, met:boolean, count?:number, target?:number, limit?:number, missingDays?:string[]}>}
 *          one entry per rule, in rule order
 */
export function evaluateWeek(days, dishesById) {
  const planned = days.map((day) => ({ iso: day.iso, eatingOut: Boolean(day.eatingOut), entries: dishesOfDay(day, dishesById) }));
  return NUTRITION_RULES.map((rule) => {
    if (rule.kind === 'everyDay') {
      // Every dinner of the week counts; an eating-out day counts only if what was eaten is entered.
      const dinners = planned.filter((d) => !d.eatingOut || d.entries.length > 0);
      const missingDays = dinners.filter((d) => !dayMatches(d.entries, rule)).map((d) => d.iso);
      const count = dinners.length - missingDays.length;
      return { id: rule.id, kind: rule.kind, met: dinners.length > 0 && missingDays.length === 0, missingDays, count, target: dinners.length };
    }
    const count = planned.filter((d) => dayMatches(d.entries, rule)).length;
    if (rule.kind === 'atLeast') return { id: rule.id, kind: rule.kind, met: count >= rule.target, count, target: rule.target };
    return { id: rule.id, kind: rule.kind, met: count <= rule.limit, count, limit: rule.limit };
  });
}

const MACROS = ['kcal', 'protein', 'carbs', 'fat'];

/**
 * Approximate energy and macros of one portion of a dish (catalog quantities are for `catalogServings`;
 * a dish with `portions` — a tray of baklava — is divided by that instead).
 * Optional lines are left out. Returns null when an ingredient has no nutrition values.
 * @returns {{kcal:number, protein:number, carbs:number, fat:number} | null}
 */
export function dishNutrition(dish, ingredientsById, catalogServings) {
  const total = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const line of dish.ingredients) {
    if (line.optional) continue;
    const ingredient = ingredientsById.get(line.ingredientId);
    const per100 = ingredient?.nutritionPer100g;
    if (!per100) return null;
    const grams = line.quantity * (ingredient.unit === 'g' ? 1 : ingredient.gramsPerUnit ?? 0) *
      (ingredient.ediblePortion ?? 1) * (line.eatenShare ?? 1);
    for (const key of MACROS) total[key] += (grams * per100[key]) / 100;
  }
  const portions = dish.portions ?? catalogServings; // trays and cakes yield more portions than the 4 servings
  for (const key of MACROS) total[key] /= portions;
  return total;
}

/** Sums nutrition values; null entries are skipped. */
export function sumNutrition(values) {
  const total = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const value of values) {
    if (!value) continue;
    for (const key of MACROS) total[key] += value[key];
  }
  return total;
}
