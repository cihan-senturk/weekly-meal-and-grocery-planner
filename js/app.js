import { loadLocale, t, localized, formatDate, formatNumber, searchKey, getLocale } from './i18n.js';
import { loadState, saveState, STORAGE_KEY } from './storage.js';
import { toIsoDate, fromIsoDate, addDays, startOfWeek, weekDays, daysBetween } from './dates.js';
import { buildShoppingList, normalizeQuantity, AISLE_ORDER } from './shopping.js';
import { evaluateWeek, dishNutrition, sumNutrition } from './nutrition.js';
import { drawMenu } from './export.js';
import { qrSvg } from './qr.js';
import { createSync, codeFromText, pairingLink, SYNC_KEY } from './sync.js';
import { createFirebaseBackend } from './sync-firebase.js';
import { FIREBASE_CONFIG } from './firebase-config.js';

// The board plans dinners; breakfast dishes stay in the catalog but are not planned yet.
const PLAN_COURSES = ['soup', 'main', 'side', 'salad', 'dessert'];
const PICKER_COURSES = PLAN_COURSES;
const MIN_SERVINGS = 1;
const MAX_SERVINGS = 200;
const LOCALE = 'tr';
// Recipes are not stored in the catalog; the recipe button opens a web search for the dish.
const RECIPE_SEARCH_URL = 'https://www.google.com/search?q=';
const UNDO_MS = 5000;
const TOAST_MS = 2400;
// Shared list text is meant for messaging apps; a small mark per aisle makes it easy to scan there.
const AISLE_MARKS = {
  produce: '🥬', butcher: '🥩', fishmonger: '🐟', dairy: '🧀', deli: '🥓', breakfast: '🫒', 'dry-goods': '🌾',
  bakery: '🥖', frozen: '🧊', beverages: '🧃', pantry: '🧂',
};
// Hand-added items: [default amount, step] per unit; 0 = no amount (spices by the spoon are bought as a pack).
const EXTRA_AMOUNTS = {
  g: [500, 250], ml: [1000, 250], piece: [1, 1], clove: [10, 5], bunch: [1, 1], slice: [10, 5],
  pack: [1, 1], can: [1, 1], jar: [1, 1], tbsp: [0, 0], tsp: [0, 0],
};
const MAX_ADD_RESULTS = 8;

const ICONS = {
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>',
  leftover: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 2-2 6 0 8v10"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  recipe: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 0 2 2h13v-4"/><path d="M9 7h6M9 11h4"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19l7-7"/></svg>',
};

const app = {
  catalog: null,
  dishesById: new Map(),
  nutritionByDish: new Map(), // dish id -> approximate values per serving
  ingredientsById: new Map(),
  labels: {},
  state: loadState(),
  weekStart: startOfWeek(new Date()),
  picker: { date: null, course: 'main', category: 'all', query: '', inSeasonOnly: false },
  // UI-only state (not persisted)
  openItems: new Set(),      // shopping items whose "for which dishes" line is open
  justAdded: null,           // "iso:course" of the dish just picked, for a short entrance animation
  previousMet: null,         // tip ids met on the last render; null = no animation on next render
  storageWarned: false,
  suppressClick: false,
  justAddedItem: null,       // ingredient just added by hand, for a short entrance animation
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const categoryLabel = (code) => app.labels.category?.[code] ?? code;
const courseLabel = (code) => {
  const key = `course.${code}`;
  return t(key) === key ? app.labels.course?.[code] ?? code : t(key);
};

// ---------- state helpers ----------

function getDay(iso) {
  return app.state.days[iso] ?? { eatingOut: false, slots: {} };
}

function updateDay(iso, update) {
  const day = structuredClone(getDay(iso));
  update(day);
  const isEmpty = !day.eatingOut && Object.values(day.slots).every((s) => !s);
  if (isEmpty) delete app.state.days[iso];
  else app.state.days[iso] = day;
}

function weekKey() {
  return toIsoDate(app.weekStart);
}

function shoppingChecks() {
  const key = weekKey();
  app.state.shopping[key] ??= { bought: {}, pantryNeeded: {} };
  app.state.shopping[key].extras ??= {};
  return app.state.shopping[key];
}

function persist() {
  app.sync?.push();
  if (saveState(app.state) || app.storageWarned) return;
  app.storageWarned = true;
  showToast(t('storage.failed'), { duration: 6000 });
}

function currentWeekDays() {
  return weekDays(app.weekStart).map((date) => ({ date, iso: toIsoDate(date), ...getDay(toIsoDate(date)) }));
}

function referenceMonth() {
  const today = new Date();
  const weekEnd = addDays(app.weekStart, 6);
  const reference = today >= app.weekStart && today <= weekEnd ? today : addDays(app.weekStart, 3);
  return reference.getMonth() + 1;
}

function isSeasonal(dish, month) {
  return dish.months.length > 0 && dish.months.length < 12 && dish.months.includes(month);
}

/** Most recent date each dish was cooked (leftovers excluded), up to the end of the shown week. */
function lastCookedDates() {
  const limit = toIsoDate(addDays(app.weekStart, 6));
  const result = new Map();
  for (const [iso, day] of Object.entries(app.state.days)) {
    if (iso > limit || day.eatingOut) continue;
    for (const slot of Object.values(day.slots)) {
      if (!slot?.dishId || slot.leftoverFrom) continue;
      const previous = result.get(slot.dishId);
      if (!previous || iso > previous) result.set(slot.dishId, iso);
    }
  }
  return result;
}

/** How many times each dish was planned (leftovers excluded), across all saved weeks. */
function timesCooked() {
  const counts = new Map();
  for (const day of Object.values(app.state.days)) {
    for (const slot of Object.values(day.slots)) {
      if (!slot?.dishId || slot.leftoverFrom) continue;
      counts.set(slot.dishId, (counts.get(slot.dishId) ?? 0) + 1);
    }
  }
  return counts;
}

// ---------- header ----------

function renderHeader() {
  const end = addDays(app.weekStart, 6);
  const sameMonth = end.getMonth() === app.weekStart.getMonth();
  const startText = formatDate(app.weekStart, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
  const endText = formatDate(end, { day: 'numeric', month: sameMonth ? 'long' : 'short' });
  $('#week-title').textContent = `${startText}–${endText}`;
  $('#this-week').hidden = toIsoDate(startOfWeek(new Date())) === weekKey();
  const field = $('#servings');
  if (document.activeElement !== field) field.value = String(app.state.settings.servings);
  field.style.setProperty('--digits', String(field.value.length || 1));
  $('#servings-down').disabled = app.state.settings.servings <= MIN_SERVINGS;
  $('#servings-up').disabled = app.state.settings.servings >= MAX_SERVINGS;
  $('#include-optional').checked = app.state.settings.includeOptional;
}

// ---------- week board ----------

function renderWeek() {
  const todayIso = toIsoDate(new Date());
  $('#week').innerHTML = currentWeekDays().map((day) => {
    const weekday = formatDate(day.date, { weekday: 'long' });
    const isToday = day.iso === todayIso;
    const label = `
      <div class="day-label">
        <span class="day-name">${escapeHtml(weekday)}</span>
        <span class="day-date">${escapeHtml(formatDate(day.date, { day: 'numeric' }))}${day.eatingOut ? ` · <span class="day-out-tag">${escapeHtml(t('day.eatingOut'))}</span>` : ''}</span>
        <button class="icon-button ghost day-out${day.eatingOut ? ' is-on' : ''}" type="button" data-action="toggle-out" data-date="${day.iso}"
          aria-pressed="${day.eatingOut}" aria-label="${escapeHtml(day.eatingOut ? t('day.toggleIn') : t('day.toggleOut'))}"
          title="${escapeHtml(day.eatingOut ? t('day.toggleIn') : t('day.toggleOut'))}" data-hint="${escapeHtml(t('hint.out'))}">${ICONS.out}</button>
      </div>`;
    // Eating-out days keep their cells: what was eaten out counts for the balance tips, not for the shopping list.
    const cells = PLAN_COURSES.map((course) => renderCell(day, course)).join('');
    return `<article class="day${isToday ? ' is-today' : ''}${day.eatingOut ? ' is-out' : ''}">${label}${cells}</article>`;
  }).join('') + renderCopyCta();
  app.justAdded = null;
  // First visits: the icons of the first dish and of Monday carry a small word underneath.
  if (app.showHints) {
    $('#week .cell.filled .cell-actions')?.classList.add('has-hints');
    $('#week .day-out')?.classList.add('has-hint');
  }
}

const HINT_VISITS = 3;
const VISITS_KEY = 'ne-pisirsem:visits';

/** Counts visits; icon labels show during the first few. */
function countVisit() {
  try {
    const visits = Number(localStorage.getItem(VISITS_KEY) ?? 0) + 1;
    localStorage.setItem(VISITS_KEY, String(visits));
    return visits;
  } catch {
    return 1;
  }
}

/** On an empty week, offer last week's menu, but only if last week has at least one dish. */
function renderCopyCta() {
  if (weekHasPlans(app.weekStart) || !weekHasDishes(addDays(app.weekStart, -7))) return '';
  return `
    <div class="week-cta">
      <button class="button primary" type="button" data-action="copy-previous">${ICONS.copy}${escapeHtml(t('week.copyPrevious'))}</button>
    </div>`;
}

function renderCell(day, course) {
  const slot = day.slots[course];
  const weekday = formatDate(day.date, { weekday: 'long' });
  const courseText = courseLabel(course);
  if (!slot?.dishId || !app.dishesById.has(slot.dishId)) {
    return `
      <div class="cell" data-date="${day.iso}" data-course="${course}" data-course-label="${escapeHtml(courseText)}">
        <button class="add" type="button" data-action="add" data-date="${day.iso}" data-course="${course}"
          aria-label="${escapeHtml(t('slot.addTo', { day: weekday, course: courseText }))}">${ICONS.plus}<span class="add-label" aria-hidden="true">${escapeHtml(courseText)}</span></button>
      </div>`;
  }
  const dish = app.dishesById.get(slot.dishId);
  const name = localized(dish.name);
  const nextIso = toIsoDate(addDays(day.date, 1));
  const nextDay = getDay(nextIso);
  let leftoverHint = t('slot.makeLeftover');
  if (slot.leftoverFrom) leftoverHint = t('slot.isLeftover');
  else if (day.eatingOut) leftoverHint = t('slot.cannotLeftoverOut');
  else if (dish.keepsDays < 1) leftoverHint = t('slot.cannotLeftoverKeeps');
  else if (nextDay.slots[course] || nextDay.eatingOut) leftoverHint = t('slot.cannotLeftoverBusy');
  const canLeftover = leftoverHint === t('slot.makeLeftover');
  const leftoverTitle = slot.leftoverFrom
    ? t('slot.leftoverOf', { day: formatDate(fromIsoDate(slot.leftoverFrom), { weekday: 'long' }) })
    : '';
  const recipeUrl = RECIPE_SEARCH_URL + encodeURIComponent(`${name} ${t('slot.recipeQuery')}`);
  return `
    <div class="cell filled cat-${dish.category}${slot.leftoverFrom ? ' is-leftover' : ''}${app.justAdded === `${day.iso}:${course}` ? ' is-new' : ''}" data-date="${day.iso}" data-course="${course}" data-course-label="${escapeHtml(courseText)}">
      <button class="dish" type="button" data-action="add" data-date="${day.iso}" data-course="${course}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        title="${escapeHtml([leftoverTitle || categoryLabel(dish.category), nutritionSummary(app.nutritionByDish.get(dish.id))].filter(Boolean).join(' · '))}"
        aria-label="${escapeHtml(t('slot.change', { dish: name }))}${leftoverTitle ? ` (${escapeHtml(leftoverTitle)})` : ''}">
        ${slot.leftoverFrom ? `<span class="leftover-mark">${ICONS.leftover}</span>` : ''}${escapeHtml(name)}
      </button>
      <span class="cell-actions">
        <button class="icon-button ghost small" type="button" data-action="leftover" data-date="${day.iso}" data-course="${course}"
          ${canLeftover ? '' : 'disabled'} aria-label="${escapeHtml(leftoverHint)}" title="${escapeHtml(leftoverHint)}" data-hint="${escapeHtml(t('hint.leftover'))}">${ICONS.leftover}</button>
        <a class="icon-button ghost small" href="${escapeHtml(recipeUrl)}" target="_blank" rel="noopener noreferrer"
          aria-label="${escapeHtml(t('slot.recipe', { dish: name }))}" title="${escapeHtml(t('slot.recipe', { dish: name }))}" data-hint="${escapeHtml(t('hint.recipe'))}">${ICONS.recipe}</a>
        <button class="icon-button ghost small" type="button" data-action="remove" data-date="${day.iso}" data-course="${course}" aria-label="${escapeHtml(t('slot.remove'))}" title="${escapeHtml(t('slot.remove'))}" data-hint="${escapeHtml(t('hint.remove'))}">${ICONS.close}</button>
      </span>
    </div>`;
}

const TIP_DOT = { fish: 'fish', legume: 'legume', vegetables: 'vegetable', redMeat: 'meat', processedMeat: 'meat' };

const TIP_CATEGORY = { fish: 'fish', legume: 'legume' };

/** Days of the shown week to suggest first: from today on (this week), then the rest; eating-out days skipped. */
function suggestionDays() {
  const todayIso = toIsoDate(new Date());
  const days = currentWeekDays().filter((d) => !d.eatingOut);
  return [...days.filter((d) => d.iso >= todayIso), ...days.filter((d) => d.iso < todayIso)];
}

/** Where a tip's "add" should go: { date, course, category } or null. */
function tipTarget(tip) {
  const days = suggestionDays();
  if (tip.id === 'vegetables') {
    const day = days.find((d) => tip.missingDays.includes(d.iso)) ?? days[0];
    if (!day) return null;
    const course = !day.slots.salad ? 'salad' : !day.slots.side ? 'side' : 'salad';
    return { date: day.iso, course, category: course === 'side' ? 'vegetable' : 'all' };
  }
  const category = TIP_CATEGORY[tip.id];
  if (!category) return null;
  const hasCategory = (d) => Object.values(d.slots).some((slot) => app.dishesById.get(slot?.dishId)?.category === category);
  const day = days.find((d) => !d.slots.main && !hasCategory(d)) ?? days.find((d) => !hasCategory(d));
  return day ? { date: day.iso, course: 'main', category } : null;
}

/** Balance guidelines under the board: all are listed, the ones the week follows get a tick. */
function renderTips() {
  const tips = evaluateWeek(currentWeekDays(), app.dishesById);
  const metIds = new Set(tips.filter((tip) => tip.met).map((tip) => tip.id));
  const previous = app.previousMet;
  const scoreBumped = previous && metIds.size > previous.size;
  const items = tips.map((tip) => {
    let detail = '';
    if (tip.kind === 'atLeast') detail = t('tip.progress', { count: tip.count, target: tip.target });
    if (tip.kind === 'atMost' && tip.count > 0) detail = t('tip.overLimit', { count: tip.count });
    if (tip.kind === 'everyDay' && tip.missingDays.length) {
      // a few missing evenings are named; otherwise "3/7", like the other tips
      detail = tip.missingDays.length <= 2
        ? t('tip.vegetablesDays', { days: tip.missingDays.map((iso) => formatDate(fromIsoDate(iso), { weekday: 'long' })).join(', ') })
        : t('tip.progress', { count: tip.count, target: tip.target });
    }
    const justMet = tip.met && previous && !previous.has(tip.id);
    const actionable = !tip.met && tip.kind !== 'atMost' && tipTarget(tip);
    const classes = ['tip', `cat-${TIP_DOT[tip.id]}`, `tip-${tip.kind}`, tip.met ? 'is-met' : 'is-open', justMet ? 'just-met' : '', actionable ? 'is-actionable' : ''].filter(Boolean).join(' ');
    const body = `
        <span class="tip-mark">${tip.met ? ICONS.check : ''}</span>
        <span class="visually-hidden">${escapeHtml(t(tip.met ? 'tip.met' : 'tip.notMet'))}:</span>
        <span class="tip-text">${escapeHtml(t(`tip.${tip.id}`))}</span>
        ${detail ? `<span class="tip-detail">${escapeHtml(detail)}</span>` : ''}`;
    const source = escapeHtml(t(`tip.source.${tip.id}`));
    return actionable
      ? `<li class="${classes}"><button type="button" class="tip-body" data-tip="${tip.id}" title="${source}">${body}<span class="tip-add">${ICONS.plus}<span class="visually-hidden">${escapeHtml(t('tip.add'))}</span></span></button></li>`
      : `<li class="${classes}" title="${source}"><span class="tip-body">${body}</span></li>`;
  }).join('');
  $('#tips').innerHTML = `
    <h2>${escapeHtml(t('tips.title'))} <span class="tips-score${scoreBumped ? ' is-bumped' : ''}">${escapeHtml(t('tips.score', { met: metIds.size, total: tips.length }))}</span></h2>
    <ul>${items}</ul>`;
  app.previousMet = metIds;
}

const roundKcal = (kcal) => Math.round(kcal / 10) * 10;

/** "~420 kcal · 18 g protein · 40 g karbonhidrat · 20 g yağ" for tooltips. */
function nutritionSummary(values) {
  if (!values) return '';
  return t('nutrition.summary', {
    kcal: formatNumber(roundKcal(values.kcal), 0), protein: formatNumber(Math.round(values.protein), 0),
    carbs: formatNumber(Math.round(values.carbs), 0), fat: formatNumber(Math.round(values.fat), 0),
  });
}

/** Per-person values of each day's dinner (leftovers and dishes eaten out included) and the daily average. */
function renderNutrition() {
  const rows = currentWeekDays()
    .map((day) => {
      const values = Object.values(day.slots)
        .filter((slot) => slot?.dishId && app.dishesById.has(slot.dishId))
        .map((slot) => app.nutritionByDish.get(slot.dishId));
      return { day, count: values.length, total: sumNutrition(values) };
    })
    .filter((row) => row.count > 0);
  const section = $('#nutrition');
  section.hidden = rows.length === 0;
  if (!rows.length) {
    section.innerHTML = '';
    return;
  }
  const average = sumNutrition(rows.map((row) => row.total));
  for (const key of Object.keys(average)) average[key] /= rows.length;
  const cells = (v) => `
      <td>${escapeHtml(t('nutrition.kcal', { n: formatNumber(roundKcal(v.kcal), 0) }))}</td>
      <td>${escapeHtml(t('nutrition.grams', { n: formatNumber(Math.round(v.protein), 0) }))}</td>
      <td>${escapeHtml(t('nutrition.grams', { n: formatNumber(Math.round(v.carbs), 0) }))}</td>
      <td>${escapeHtml(t('nutrition.grams', { n: formatNumber(Math.round(v.fat), 0) }))}</td>`;
  section.innerHTML = `
    <h2>${escapeHtml(t('nutrition.title'))}</h2>
    <p class="nutrition-note">${escapeHtml(t('nutrition.note'))}</p>
    <div class="nutrition-scroll">
      <table>
        <thead><tr>
          <th scope="col"><span class="visually-hidden">${escapeHtml(t('nutrition.day'))}</span></th>
          ${['energy', 'protein', 'carbs', 'fat'].map((key) => `<th scope="col">${longShort(t(`nutrition.${key}`), t(`nutrition.${key}Short`))}</th>`).join('')}
        </tr></thead>
        <tbody>${rows.map(({ day, total }) => `
          <tr><th scope="row">${longShort(formatDate(day.date, { weekday: 'long' }), formatDate(day.date, { weekday: 'short' }))}</th>${cells(total)}</tr>`).join('')}
        </tbody>
        ${rows.length > 1 ? `<tfoot><tr><th scope="row">${escapeHtml(t('nutrition.average'))}</th>${cells(average)}</tr></tfoot>` : ''}
      </table>
    </div>`;
}

/** A label with a shorter form for narrow screens (CSS shows one of the two; screen readers get the long one). */
function longShort(long, short) {
  return `<span class="long">${escapeHtml(long)}</span><span class="short" aria-hidden="true">${escapeHtml(short)}</span>`;
}

/** Leftovers planned later than their dish usually keeps; one polite sentence each. */
function renderStorageNotes() {
  const notes = [];
  for (const day of currentWeekDays()) {
    for (const course of PLAN_COURSES) {
      const slot = day.slots[course];
      const dish = slot?.leftoverFrom && app.dishesById.get(slot.dishId);
      if (!dish) continue;
      const daysLater = daysBetween(fromIsoDate(slot.leftoverFrom), day.date);
      if (daysLater <= dish.keepsDays) continue;
      const params = { dish: localized(dish.name), days: dish.keepsDays, day: formatDate(day.date, { weekday: 'long' }) };
      notes.push(t(dish.keepsDays === 0 ? 'storage.noteSameDay' : 'storage.note', params));
    }
  }
  const section = $('#storage-notes');
  section.hidden = notes.length === 0;
  section.innerHTML = notes.length ? `
    <h2>${escapeHtml(t('storage.title'))}${notes.length > 1 ? ` <span class="tips-score">${notes.length}</span>` : ''}</h2>
    <ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : '';
}

function handleTipClick(event) {
  const button = event.target.closest('[data-tip]');
  if (!button) return;
  const tip = evaluateWeek(currentWeekDays(), app.dishesById).find((item) => item.id === button.dataset.tip);
  const target = tip && tipTarget(tip);
  if (target) openPicker(target.date, target.course, target.category);
}

// ---------- shopping list (receipt) ----------

function formatAmount(quantity, unit) {
  const normalized = normalizeQuantity(quantity, unit);
  const unitLabel =
    normalized.unit === 'kg' ? t('unit.kg') :
    normalized.unit === 'l' ? t('unit.l') :
    app.labels.unit?.[normalized.unit] ?? normalized.unit;
  return `${formatNumber(normalized.value, 1)} ${unitLabel}`;
}

/** Produce, meat and fish counted in pieces are still weighed at the counter: show roughly how much. */
const WEIGHED_AISLES = new Set(['produce', 'butcher', 'fishmonger']);
function approxWeight(entry) {
  const { unit, aisle, gramsPerUnit } = entry.ingredient;
  if (unit !== 'piece' || !WEIGHED_AISLES.has(aisle) || !gramsPerUnit || !(entry.quantity > 0)) return '';
  const grams = entry.quantity * gramsPerUnit;
  if (grams < 100) return '';
  const text = grams >= 1000
    ? `${formatNumber(Math.round(grams / 100) / 10, 1)} ${t('unit.kg')}`
    : `${Math.round(grams / 50) * 50} g`;
  return `<span class="item-weight">≈ ${escapeHtml(text)}</span>`;
}

function currentShoppingList() {
  return buildShoppingList({
    days: currentWeekDays(),
    dishesById: app.dishesById,
    ingredientsById: app.ingredientsById,
    servings: app.state.settings.servings,
    catalogServings: app.catalog.servings,
    includeOptional: app.state.settings.includeOptional,
    extras: shoppingChecks().extras,
    locale: getLocale(),
  });
}

function itemsToBuy(list, checks) {
  return [...list.items, ...list.pantryItems.filter((e) => checks.pantryNeeded[e.ingredient.id])];
}

function renderShopping() {
  const list = currentShoppingList();
  const checks = shoppingChecks();
  const buyItems = itemsToBuy(list, checks);
  const boughtCount = buyItems.filter((e) => checks.bought[e.ingredient.id]).length;
  const remaining = buyItems.length - boughtCount;
  const hideBought = Boolean(app.state.settings.hideBought) && boughtCount > 0;

  const jump = $('#list-jump');
  jump.hidden = buyItems.length === 0;
  jump.textContent = t('list.jump', { count: remaining });

  const share = canShare();
  const shareLabel = t(share ? 'list.share' : 'list.copy');
  $('#shopping-head').innerHTML = `
    <header class="receipt-head">
      <h2 id="list-title">${escapeHtml(t('list.title'))}</h2>
      ${buyItems.length ? `<button class="icon-button ghost" type="button" data-action="copy-list" aria-label="${escapeHtml(shareLabel)}" title="${escapeHtml(shareLabel)}">${share ? ICONS.share : ICONS.copy}</button>` : ''}
    </header>
    ${buyItems.length ? renderProgress(boughtCount, buyItems.length, hideBought) : ''}`;

  if (buyItems.length === 0 && list.pantryItems.length === 0) {
    $('#shopping-body').innerHTML = `<p class="receipt-empty">${escapeHtml(t('list.empty'))}</p>`;
    return;
  }

  const groups = AISLE_ORDER
    .map((aisle) => ({ aisle, entries: buyItems.filter((e) => e.ingredient.aisle === aisle && !(hideBought && checks.bought[e.ingredient.id])) }))
    .filter((g) => g.entries.length)
    .map((g) => `
      <section class="aisle">
        <h3>${escapeHtml(app.labels.aisle?.[g.aisle] ?? g.aisle)}</h3>
        <ul>${sortBoughtLast(g.entries, checks).map((e) => renderItem(e, checks)).join('')}</ul>
      </section>`)
    .join('');

  const pantry = list.pantryItems.length ? `
    <section class="pantry">
      <h3>${escapeHtml(t('list.pantryTitle'))}</h3>
      <div class="pantry-tags">
        ${list.pantryItems.map((e) => {
          const name = localized(e.ingredient.name);
          const needed = Boolean(checks.pantryNeeded[e.ingredient.id]);
          return `<button type="button" class="tag${needed ? ' is-needed' : ''}" aria-pressed="${needed}" data-action="toggle-pantry" data-id="${escapeHtml(e.ingredient.id)}"
            aria-label="${escapeHtml(needed ? t('list.pantryNeeded', { name }) : t('list.pantryHave', { name }))}">${escapeHtml(name)}</button>`;
        }).join('')}
      </div>
    </section>` : '';

  const allDone = hideBought && remaining === 0 ? `<p class="receipt-done">${escapeHtml(t('list.allBought'))}</p>` : '';
  $('#shopping-body').innerHTML = `${allDone}${groups}${pantry}`;
  app.justAddedItem = null;
}

/** "8/21 alındı" with a thin bar, and a switch that hides what is already in the basket. */
function renderProgress(bought, total, hideBought) {
  const toggle = bought ? `
      <button class="progress-toggle" type="button" data-action="toggle-hide-bought" aria-pressed="${hideBought}">
        ${escapeHtml(t(hideBought ? 'list.showBought' : 'list.hideBought'))}</button>` : '';
  return `
    <div class="receipt-progress">
      <span class="progress-text">${escapeHtml(t('list.progress', { bought, total }))}</span>${toggle}
      <span class="progress-bar" aria-hidden="true"><span style="width: ${(bought / total) * 100}%"></span></span>
    </div>`;
}

/** Bought items move to the end of their aisle; otherwise the list keeps its order. */
function sortBoughtLast(entries, checks) {
  return [...entries].sort((a, b) => Number(Boolean(checks.bought[a.ingredient.id])) - Number(Boolean(checks.bought[b.ingredient.id])));
}

function renderItem(entry, checks) {
  const id = entry.ingredient.id;
  const name = localized(entry.ingredient.name);
  const bought = Boolean(checks.bought[id]);
  const open = app.openItems.has(id);
  const usedIn = entry.dishIds.map((dishId) => localized(app.dishesById.get(dishId)?.name)).join(' · ');
  const isExtra = entry.extraQuantity !== undefined;
  const isNew = app.justAddedItem === id;
  return `
    <li class="item${bought ? ' is-bought' : ''}${open ? ' is-open' : ''}${isExtra ? ' is-extra' : ''}${isNew ? ' is-new' : ''}" style="view-transition-name: item-${escapeHtml(id)}">
      <label class="item-check">
        <input type="checkbox" data-action="toggle-bought" data-id="${escapeHtml(id)}" ${bought ? 'checked' : ''}>
        <span class="visually-hidden">${escapeHtml(t('list.bought', { name }))}</span>
      </label>
      <button class="item-main" type="button" data-action="toggle-details" data-id="${escapeHtml(id)}" aria-expanded="${open}">
        <span class="item-name">${escapeHtml(name)}</span>
        <span class="item-qty"><span class="item-amount">${entry.quantity > 0 ? escapeHtml(formatAmount(entry.quantity, entry.ingredient.unit)) : ''}</span>${approxWeight(entry)}</span>
      </button>
      ${open ? renderItemDetails(entry, usedIn) : ''}
    </li>`;
}

/** Opened item: which dishes need it, and for hand-added amounts a stepper and a remove button. */
function renderItemDetails(entry, usedIn) {
  const id = escapeHtml(entry.ingredient.id);
  const dishes = usedIn ? `<p class="item-for">${escapeHtml(usedIn)}</p>` : '';
  if (entry.extraQuantity === undefined) return dishes;
  const [, step] = EXTRA_AMOUNTS[entry.ingredient.unit] ?? [0, 0];
  const amount = entry.extraQuantity > 0 ? formatAmount(entry.extraQuantity, entry.ingredient.unit) : '';
  const stepper = step ? `
      <button class="icon-button ghost small" type="button" data-action="extra-less" data-id="${id}" aria-label="${escapeHtml(t('list.extraLess'))}"
        ${entry.extraQuantity <= step ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button>
      <span class="extra-amount">${escapeHtml(amount)}</span>
      <button class="icon-button ghost small" type="button" data-action="extra-more" data-id="${id}" aria-label="${escapeHtml(t('list.extraMore'))}">${ICONS.plus}</button>` : '';
  return `${dishes}
    <div class="item-extra">
      <span class="extra-label">${escapeHtml(t(usedIn ? 'list.extraAlso' : 'list.extraOnly'))}</span>${stepper}
      <button class="extra-remove" type="button" data-action="extra-remove" data-id="${id}">${escapeHtml(t('list.extraRemove'))}</button>
    </div>`;
}

// ---------- adding items by hand ----------

function addExtra(ingredientId) {
  const ingredient = app.ingredientsById.get(ingredientId);
  if (!ingredient) return;
  const checks = shoppingChecks();
  const [amount, step] = EXTRA_AMOUNTS[ingredient.unit] ?? [0, 0];
  checks.extras[ingredientId] = ingredientId in checks.extras ? checks.extras[ingredientId] + step : amount;
  delete checks.bought[ingredientId];
  app.justAddedItem = ingredientId;
  persist();
  renderShopping();
  showToast(t('list.extraAdded', { name: localized(ingredient.name) }));
}

function changeExtra(ingredientId, direction) {
  const checks = shoppingChecks();
  const ingredient = app.ingredientsById.get(ingredientId);
  const [, step] = EXTRA_AMOUNTS[ingredient?.unit] ?? [0, 0];
  if (!(ingredientId in checks.extras) || !step) return;
  checks.extras[ingredientId] = Math.max(step, checks.extras[ingredientId] + direction * step);
  persist();
  renderShopping();
}

function removeExtra(ingredientId) {
  const name = localized(app.ingredientsById.get(ingredientId)?.name ?? '');
  withUndo(t('undo.removed', { dish: name }), () => {
    delete shoppingChecks().extras[ingredientId];
  });
}

function renderAddResults() {
  const query = searchKey($('#list-add-input').value.trim());
  const results = $('#list-add-results');
  if (!query) {
    results.hidden = true;
    results.innerHTML = '';
    return;
  }
  const extras = shoppingChecks().extras;
  const matches = app.catalog.ingredients
    .map((ingredient) => ({ ingredient, key: searchKey(localized(ingredient.name)) }))
    .filter(({ key }) => key.includes(query))
    .sort((a, b) => Number(b.key.startsWith(query)) - Number(a.key.startsWith(query)) ||
      localized(a.ingredient.name).localeCompare(localized(b.ingredient.name), getLocale()))
    .slice(0, MAX_ADD_RESULTS);
  results.hidden = false;
  results.innerHTML = matches.length
    ? matches.map(({ ingredient }) => `
        <li><button type="button" class="add-result" data-ingredient="${escapeHtml(ingredient.id)}">
          <span>${escapeHtml(localized(ingredient.name))}</span>
          <span class="add-result-aisle">${escapeHtml(ingredient.id in extras ? t('list.extraInList') : app.labels.aisle?.[ingredient.aisle] ?? '')}</span>
        </button></li>`).join('')
    : `<li class="add-empty">${escapeHtml(t('list.addEmpty'))}</li>`;
}

function chooseAddResult(ingredientId) {
  addExtra(ingredientId);
  $('#list-add-input').value = '';
  renderAddResults();
  $('#list-add-input').focus();
}

function shoppingListAsText() {
  const list = currentShoppingList();
  const checks = shoppingChecks();
  const buyItems = itemsToBuy(list, checks).filter((e) => !checks.bought[e.ingredient.id]);
  const servings = t('week.servingsValue', { n: app.state.settings.servings });
  const lines = [`🛒 ${t('list.shareTitle')} · ${$('#week-title').textContent} · ${servings}`];
  for (const aisle of AISLE_ORDER) {
    const entries = buyItems.filter((e) => e.ingredient.aisle === aisle);
    if (!entries.length) continue;
    lines.push('', `${AISLE_MARKS[aisle] ?? '•'} *${app.labels.aisle?.[aisle] ?? aisle}*`);
    for (const e of entries) lines.push(`• ${localized(e.ingredient.name)} — ${formatAmount(e.quantity, e.ingredient.unit)}`);
  }
  return lines.join('\n');
}

/** Phones and tablets get the system share sheet; desktops copy to the clipboard. */
function canShare() {
  return typeof navigator.share === 'function' && window.matchMedia('(hover: none)').matches;
}

async function shareList() {
  const text = shoppingListAsText();
  if (canShare()) {
    try {
      await navigator.share({ title: t('list.shareTitle'), text });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return; // user closed the share sheet
    }
  }
  const copied = await copyText(text);
  showToast(t(copied ? 'list.copied' : 'list.copyFailed'));
}

/** Animates list reordering where the browser supports view transitions. */
function withListTransition(update) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof document.startViewTransition !== 'function' || reduceMotion) return update();
  document.startViewTransition(update);
}

// ---------- dish picker ----------

function openPicker(date, course, category = 'all') {
  app.picker = { ...app.picker, date, course, category, query: '', chosenCourse: null };
  app.pickerOpener = document.activeElement;
  $('#picker-search').value = '';
  renderPickerFilters();
  renderPickerResults();
  $('#picker').showModal();
  $('#picker-search').focus();
}

function renderPickerTitle() {
  const { date, course } = app.picker;
  const weekday = formatDate(fromIsoDate(date), { weekday: 'long' });
  const title = t('picker.title', { day: weekday, course: courseLabel(course) });
  $('#picker-title').textContent = getDay(date).eatingOut ? `${title} · ${t('day.eatingOut')}` : title;
}

function renderPickerFilters() {
  renderPickerTitle(); // switching the course tab changes where the dish goes
  $('#picker-courses').innerHTML = PICKER_COURSES.map((course) => {
    const active = app.picker.course === course;
    return `<button type="button" class="tab${active ? ' is-active' : ''}" aria-pressed="${active}" data-course="${course}">${escapeHtml(courseLabel(course))}</button>`;
  }).join('');

  const categories = [...new Set(app.catalog.dishes.filter((d) => d.course === app.picker.course).map((d) => d.category))];
  if (!categories.includes(app.picker.category)) app.picker.category = 'all';
  const seasonButton = `<button type="button" class="filter season${app.picker.inSeasonOnly ? ' is-active' : ''}" aria-pressed="${app.picker.inSeasonOnly}" data-season>${ICONS.leaf}${escapeHtml(t('picker.inSeason'))}</button>`;
  $('#picker-categories').innerHTML = seasonButton + ['all', ...categories].map((category) => {
    const active = app.picker.category === category;
    const label = category === 'all' ? t('picker.allCategories') : categoryLabel(category);
    return `<button type="button" class="filter cat-${category}${active ? ' is-active' : ''}" aria-pressed="${active}" data-category="${category}">${escapeHtml(label)}</button>`;
  }).join('');
}

function renderPickerResults() {
  const month = referenceMonth();
  const lastCooked = lastCookedDates();
  const cooked = timesCooked();
  const query = searchKey(app.picker.query.trim());
  const weekStartIso = weekKey();

  const candidates = app.catalog.dishes
    .filter((dish) => (query ? true : dish.course === app.picker.course))
    .filter((dish) => query || app.picker.category === 'all' || dish.category === app.picker.category)
    .filter((dish) => !app.picker.inSeasonOnly || dish.months.includes(month))
    .filter((dish) => !query || searchKey(localized(dish.name)).includes(query))
    .map((dish) => ({
      dish,
      cookedIso: lastCooked.get(dish.id),
      cookedThisWeek: Boolean(lastCooked.get(dish.id) >= weekStartIso),
      times: cooked.get(dish.id) ?? 0,
      seasonal: isSeasonal(dish, month),
    }))
    // Dishes the household has planned before rise to the top (most often first, then most recent),
    // everything else is alphabetical. With the in-season filter on, in-season dishes come first.
    .sort((a, b) =>
      (app.picker.inSeasonOnly ? Number(b.seasonal) - Number(a.seasonal) : 0) ||
      b.times - a.times ||
      (b.cookedIso ?? '').localeCompare(a.cookedIso ?? '') ||
      localized(a.dish.name).localeCompare(localized(b.dish.name), getLocale()));

  if (!candidates.length) {
    $('#picker-results').innerHTML = `<li class="results-empty">${escapeHtml(t('picker.empty'))}</li>`;
    return;
  }

  const firstAllYear = app.picker.inSeasonOnly ? candidates.findIndex((c) => !c.seasonal) : -1;
  $('#picker-results').innerHTML = candidates.map(({ dish, cookedIso, cookedThisWeek, seasonal }, index) => {
    const divider = index === firstAllYear && index > 0
      ? `<li class="results-divider" role="presentation">${escapeHtml(t('picker.allYear'))}</li>`
      : '';
    let history = '';
    if (cookedIso) {
      const weeks = Math.floor(daysBetween(fromIsoDate(cookedIso), app.weekStart) / 7) + 1;
      history = cookedThisWeek ? t('picker.thisWeek') : t('picker.weeksAgo', { weeks: Math.max(1, weeks) });
    }
    return `${divider}
      <li>
        <button type="button" class="result cat-${dish.category}" data-dish="${escapeHtml(dish.id)}" title="${escapeHtml(categoryLabel(dish.category))}">
          <span class="result-name">${escapeHtml(localized(dish.name))}</span>
          <span class="result-meta">
            ${seasonal ? `<span class="result-season" aria-label="${escapeHtml(t('picker.inSeason'))}" title="${escapeHtml(t('picker.inSeason'))}">${ICONS.leaf}</span>` : ''}
            ${history ? `<span class="result-history">${escapeHtml(history)}</span>` : ''}
            ${kcalText(dish)}
          </span>
        </button>
      </li>`;
  }).join('');
}

function kcalText(dish) {
  const values = app.nutritionByDish.get(dish.id);
  if (!values) return '';
  return `<span class="result-kcal" title="${escapeHtml(nutritionSummary(values))}">${escapeHtml(t('nutrition.kcalShort', { n: formatNumber(roundKcal(values.kcal), 0) }))}</span>`;
}

function chooseDish(dishId) {
  const { date } = app.picker;
  // A dessert found by search always goes to the dessert column; other dishes go where the picker points.
  const course = app.dishesById.get(dishId)?.course === 'dessert' ? 'dessert' : app.picker.course;
  updateDay(date, (day) => {
    day.slots[course] = { dishId };
  });
  removeOrphanLeftovers();
  persist();
  app.picker.chosenCourse = course;
  $('#picker').close();
  app.justAdded = `${date}:${course}`;
  renderAll();
}

/** After the picker closes, focus goes back to the cell it was opened for (re-rendered, so found again). */
function restorePickerFocus() {
  const { date, course, chosenCourse } = app.picker;
  const cell = $(`#week [data-action="add"][data-date="${date}"][data-course="${chosenCourse ?? course}"]`);
  const opener = app.pickerOpener;
  app.pickerOpener = null;
  if (!chosenCourse && opener?.isConnected) opener.focus();
  else cell?.focus();
}

/** A sideways-scrolling strip (course tabs, filters on a narrow window) also scrolls with a mouse wheel. */
function scrollStripWithWheel(event) {
  const strip = event.currentTarget;
  if (strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  event.preventDefault();
  strip.scrollLeft += event.deltaY;
}

/** Arrow keys move between the search box and the results. */
function handlePickerArrows(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const results = [...document.querySelectorAll('#picker-results [data-dish]')];
  if (!results.length) return;
  const inSearch = event.target === $('#picker-search');
  if (inSearch && event.key !== 'ArrowDown') return;
  event.preventDefault();
  const index = results.indexOf(event.target);
  let next;
  if (inSearch) next = results[0];
  else if (event.key === 'Home') next = results[0];
  else if (event.key === 'End') next = results[results.length - 1];
  else if (event.key === 'ArrowDown') next = results[Math.min(results.length - 1, index + 1)];
  else next = index <= 0 ? $('#picker-search') : results[index - 1];
  next.focus();
  if (next !== $('#picker-search')) next.scrollIntoView({ block: 'nearest' });
}

/** Alt+↑/↓ on a dish: the keyboard way to drag it to the previous or next day (same rules as dragging). */
function handleWeekKeys(event) {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
  const button = event.target.closest('.dish');
  if (!button) return;
  event.preventDefault();
  const { date: fromIso, course } = button.dataset;
  const source = getDay(fromIso).slots[course];
  if (!source) return;
  const step = event.key === 'ArrowDown' ? 1 : -1;
  const days = currentWeekDays().map((d) => d.iso);
  for (let i = days.indexOf(fromIso) + step; i >= 0 && i < days.length; i += step) {
    if (!canDropOn(source, days[i], course, fromIso)) continue;
    moveDish(fromIso, days[i], course);
    $(`#week .dish[data-date="${days[i]}"][data-course="${course}"]`)?.focus();
    return;
  }
}

/** Leftover slots whose source slot no longer holds the same dish are removed. */
/** Slots for courses the board does not show (older versions let breakfast in) would count unseen. */
function dropHiddenSlots() {
  let changed = false;
  for (const [iso, day] of Object.entries(app.state.days)) {
    for (const course of Object.keys(day.slots)) {
      if (PLAN_COURSES.includes(course)) continue;
      updateDay(iso, (d) => { delete d.slots[course]; });
      changed = true;
    }
  }
  if (changed) persist();
}

function removeOrphanLeftovers() {
  for (const [iso, day] of Object.entries(app.state.days)) {
    for (const [course, slot] of Object.entries(day.slots)) {
      if (!slot?.leftoverFrom) continue;
      const source = getDay(slot.leftoverFrom).slots[course];
      if (!source || source.dishId !== slot.dishId) updateDay(iso, (d) => { delete d.slots[course]; });
    }
  }
}

// ---------- drag a dish to another day (same course only) ----------

const DRAG_THRESHOLD_PX = 6;
const LONG_PRESS_MS = 300;   // touch: hold to pick up, so normal swipes still scroll the page
let drag = null;

/** Removes the leftovers cooked on (iso, course) and returns them as [{ dishId, offset }] (offset = days after cooking). */
function takeLeftoversOf(iso, course) {
  const taken = [];
  for (const [dayIso, day] of Object.entries(app.state.days)) {
    const slot = day.slots[course];
    if (slot?.leftoverFrom !== iso) continue;
    taken.push({ dishId: slot.dishId, offset: daysBetween(fromIsoDate(iso), fromIsoDate(dayIso)) });
    updateDay(dayIso, (d) => { delete d.slots[course]; });
  }
  return taken;
}

/** Puts leftovers back at the same distance from their new cooking day, where that slot is free. */
function placeLeftovers(iso, course, leftovers) {
  for (const { dishId, offset } of leftovers) {
    const dayIso = toIsoDate(addDays(fromIsoDate(iso), offset));
    if (getDay(dayIso).slots[course]) continue;
    updateDay(dayIso, (d) => { d.slots[course] = { dishId, leftoverFrom: iso }; });
  }
}

/** Can the slot being dragged go to (toIso, course)? */
function canDropOn(source, toIso, course, fromIso) {
  if (toIso === fromIso) return false;
  const target = getDay(toIso).slots[course];
  // A leftover goes to a free slot after the day it was cooked; storage limits only produce a notice.
  if (source.leftoverFrom) return !target && toIso > source.leftoverFrom;
  return !target?.leftoverFrom;
}

/**
 * Moves a dish to another day in the same course.
 * A cooked dish swaps with a dish already there, and its leftovers keep their distance to it.
 * A leftover moves to any free slot after its cooking day.
 */
function moveDish(fromIso, toIso, course) {
  const source = getDay(fromIso).slots[course];
  if (!source?.dishId || !canDropOn(source, toIso, course, fromIso)) return;
  const name = localized(app.dishesById.get(source.dishId)?.name ?? '');
  const day = formatDate(fromIsoDate(toIso), { weekday: 'long' });
  if (source.leftoverFrom) {
    withUndo(t('move.leftoverDone', { dish: name, day }), () => {
      updateDay(fromIso, (d) => { delete d.slots[course]; });
      updateDay(toIso, (d) => { d.slots[course] = { dishId: source.dishId, leftoverFrom: source.leftoverFrom }; });
    });
    return;
  }
  const target = getDay(toIso).slots[course];
  withUndo(t('move.done', { dish: name, day }), () => {
    const sourceLeftovers = takeLeftoversOf(fromIso, course);
    const targetLeftovers = target ? takeLeftoversOf(toIso, course) : [];
    updateDay(toIso, (d) => { d.slots[course] = { dishId: source.dishId }; });
    updateDay(fromIso, (d) => {
      if (target) d.slots[course] = { dishId: target.dishId };
      else delete d.slots[course];
    });
    placeLeftovers(toIso, course, sourceLeftovers);
    placeLeftovers(fromIso, course, targetLeftovers);
    removeOrphanLeftovers();
  });
}

function onDragStart(event) {
  const dishButton = event.target.closest('.dish');
  if (!dishButton || event.button > 0) return;
  const cell = dishButton.closest('.cell');
  drag = {
    pointerId: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType !== 'mouse',
    date: cell.dataset.date, course: cell.dataset.course, source: cell, active: false, over: null, ghost: null,
  };
  if (drag.touch) drag.timer = setTimeout(() => activateDrag(), LONG_PRESS_MS);
}

function activateDrag() {
  if (!drag || drag.active) return;
  drag.active = true;
  const ghost = document.createElement('div');
  ghost.className = `drag-ghost ${[...drag.source.classList].find((c) => c.startsWith('cat-')) ?? ''}`;
  ghost.textContent = drag.source.querySelector('.dish').textContent.trim();
  document.body.append(ghost);
  drag.ghost = ghost;
  moveGhost(drag.x, drag.y);
  document.body.classList.add('is-dragging');
  drag.source.classList.add('is-drag-source');
  const source = getDay(drag.date).slots[drag.course];
  document.querySelectorAll(`#week .cell[data-course="${drag.course}"]`).forEach((cell) => {
    if (canDropOn(source, cell.dataset.date, drag.course, drag.date)) cell.classList.add('is-drop-ok');
  });
  navigator.vibrate?.(12);
}

function moveGhost(x, y) {
  drag.ghost.style.transform = `translate(${x + 12}px, ${y - 18}px)`;
}

function onDragMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD_PX) return;
    if (drag.touch) return endDrag(); // moved before the long press: the user is scrolling
    activateDrag();
  }
  moveGhost(event.clientX, event.clientY);
  const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('.cell.is-drop-ok') ?? null;
  if (over !== drag.over) {
    drag.over?.classList.remove('is-drop-over');
    over?.classList.add('is-drop-over');
    drag.over = over;
  }
}

function onDragEnd(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (drag.active) {
    app.suppressClick = true; // the click that follows a drop must not open the picker
    setTimeout(() => { app.suppressClick = false; }, 0);
    const { date, course, over } = drag;
    endDrag();
    if (over && event.type === 'pointerup') moveDish(date, over.dataset.date, course);
    return;
  }
  endDrag();
}

function endDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  drag.ghost?.remove();
  app.dragEndedAt = Date.now();
  document.body.classList.remove('is-dragging');
  document.querySelectorAll('.is-drag-source, .is-drop-ok, .is-drop-over')
    .forEach((el) => el.classList.remove('is-drag-source', 'is-drop-ok', 'is-drop-over'));
  drag = null;
}

// ---------- actions ----------

function handleWeekClick(event) {
  if (app.suppressClick) return;
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, date, course } = target.dataset;
  if (action === 'add') return openPicker(date, course);
  if (action === 'copy-previous') return copyPreviousWeek();
  if (action === 'remove') {
    const name = localized(app.dishesById.get(getDay(date).slots[course]?.dishId)?.name ?? '');
    return withUndo(t('undo.removed', { dish: name }), () => {
      updateDay(date, (day) => { delete day.slots[course]; });
      removeOrphanLeftovers();
    });
  } else if (action === 'leftover') {
    const slot = getDay(date).slots[course];
    const nextIso = toIsoDate(addDays(fromIsoDate(date), 1));
    updateDay(nextIso, (day) => { day.slots[course] = { dishId: slot.dishId, leftoverFrom: date }; });
  } else if (action === 'toggle-out') {
    updateDay(date, (day) => { day.eatingOut = !day.eatingOut; });
  } else {
    return;
  }
  persist();
  renderAll();
}

/** True when the week has anything planned (a dish or an eating-out day). */
function weekHasPlans(start) {
  return weekDays(start).some((d) => {
    const day = getDay(toIsoDate(d));
    return day.eatingOut || Object.values(day.slots).some(Boolean);
  });
}

/** True when at least one dish is chosen in the week (eating-out days alone do not count). */
function weekHasDishes(start) {
  return weekDays(start).some((d) => Object.values(getDay(toIsoDate(d)).slots).some((slot) => slot?.dishId));
}

/** Applies a change, saves it and offers "Undo" for a few seconds instead of asking first. */
function withUndo(message, change) {
  const snapshot = structuredClone(app.state);
  change();
  persist();
  renderAll();
  showToast(message, {
    duration: UNDO_MS,
    actionLabel: t('undo.action'),
    onAction: () => {
      app.state = snapshot;
      persist();
      renderAll();
    },
  });
}

function copyPreviousWeek() {
  closeMenu();
  const previousStart = addDays(app.weekStart, -7);
  if (!weekHasDishes(previousStart)) return showToast(t('week.copiedNothing'));
  withUndo(t('week.copied'), () => {
    for (let i = 0; i < 7; i++) {
      const fromIso = toIsoDate(addDays(previousStart, i));
      const toIso = toIsoDate(addDays(app.weekStart, i));
      const source = structuredClone(getDay(fromIso));
      for (const slot of Object.values(source.slots)) {
        if (slot?.leftoverFrom) slot.leftoverFrom = toIsoDate(addDays(fromIsoDate(slot.leftoverFrom), 7));
      }
      delete app.state.days[toIso];
      if (source.eatingOut || Object.values(source.slots).some(Boolean)) app.state.days[toIso] = source;
    }
    delete app.state.shopping[weekKey()];
  });
}

function clearWeek() {
  closeMenu();
  if (!weekHasPlans(app.weekStart)) return;
  withUndo(t('week.cleared'), () => {
    for (const date of weekDays(app.weekStart)) delete app.state.days[toIsoDate(date)];
    delete app.state.shopping[weekKey()];
  });
}

async function handleShoppingEvent(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, id } = target.dataset;
  const checks = shoppingChecks();
  if (action === 'toggle-bought' && event.type === 'change') {
    if (target.checked) checks.bought[id] = true;
    else delete checks.bought[id];
    persist();
    withListTransition(renderShopping);
    return;
  } else if (action === 'toggle-details' && event.type === 'click') {
    if (app.openItems.has(id)) app.openItems.delete(id);
    else app.openItems.add(id);
    renderShopping();
    return;
  } else if (action === 'toggle-pantry' && event.type === 'click') {
    if (checks.pantryNeeded[id]) delete checks.pantryNeeded[id];
    else checks.pantryNeeded[id] = true;
  } else if (action === 'extra-more' && event.type === 'click') {
    return changeExtra(id, 1);
  } else if (action === 'extra-less' && event.type === 'click') {
    return changeExtra(id, -1);
  } else if (action === 'extra-remove' && event.type === 'click') {
    return removeExtra(id);
  } else if (action === 'toggle-hide-bought' && event.type === 'click') {
    app.state.settings.hideBought = !app.state.settings.hideBought;
    persist();
    withListTransition(renderShopping);
    return;
  } else if (action === 'copy-list' && event.type === 'click') {
    await shareList();
    return;
  } else {
    return;
  }
  persist();
  renderShopping();
}

function changeServings(delta) {
  setServings(app.state.settings.servings + delta);
}

/** Typed or stepped head count, kept within 1–200. */
function setServings(value) {
  const next = Math.min(MAX_SERVINGS, Math.max(MIN_SERVINGS, Math.round(value)));
  if (!Number.isFinite(next) || next === app.state.settings.servings) {
    renderHeader();
    return;
  }
  app.state.settings.servings = next;
  persist();
  renderHeader();
  renderShopping();
}

/** Typing keeps digits only; the value is applied on Enter or when the field loses focus. */
function handleServingsInput(event) {
  const field = event.target;
  const digits = field.value.replace(/\D/g, '').slice(0, 3);
  if (digits !== field.value) field.value = digits;
  field.style.setProperty('--digits', String(digits.length || 1));
}

function commitServings(event) {
  const field = event.target;
  const value = Number.parseInt(field.value, 10);
  if (Number.isNaN(value)) {
    field.value = String(app.state.settings.servings);
    renderHeader();
    return;
  }
  setServings(value);
  field.value = String(app.state.settings.servings);
}

// ---------- export: printable image and text ----------

let exportBlob = null;

function categoryColor(category) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${category}`).trim() || '#7a5a50';
}

function menuForExport() {
  return {
    title: t('export.imageTitle'),
    subtitle: $('#week-title').textContent,
    courses: PLAN_COURSES.map(courseLabel),
    brand: t('app.title'),
    signoff: t('export.signoff'),
    leftoverMark: t('export.leftover'),
    days: currentWeekDays().map((day) => ({
      name: formatDate(day.date, { weekday: 'long' }).replace(/^./, (c) => c.toLocaleUpperCase(getLocale())),
      date: formatDate(day.date, { day: 'numeric', month: 'long' }),
      note: day.eatingOut ? t('day.eatingOut') : '',
      muted: day.eatingOut,
      cells: PLAN_COURSES.map((course) => {
        const slot = day.slots[course];
        const dish = slot?.dishId && app.dishesById.get(slot.dishId);
        return dish ? { text: localized(dish.name), color: categoryColor(dish.category), leftover: Boolean(slot.leftoverFrom) } : null;
      }),
    })),
  };
}

function menuAsText() {
  const lines = [`📅 ${t('export.imageTitle')} · ${$('#week-title').textContent}`, ''];
  for (const day of currentWeekDays()) {
    const name = formatDate(day.date, { weekday: 'long' }).replace(/^./, (c) => c.toLocaleUpperCase(getLocale()));
    const dishes = PLAN_COURSES
      .map((course) => {
        const slot = day.slots[course];
        const dish = slot?.dishId && app.dishesById.get(slot.dishId);
        if (!dish) return null;
        return slot.leftoverFrom ? `${localized(dish.name)} (${t('export.leftover')})` : localized(dish.name);
      })
      .filter(Boolean);
    const parts = [day.eatingOut ? t('day.eatingOut') : '', dishes.join(', ')].filter(Boolean);
    lines.push(`*${name}:* ${parts.join(' · ') || '—'}`);
  }
  return lines.join('\n');
}

function exportFileName() {
  return `${t('export.fileName')}-${weekKey()}.png`;
}

async function openExport() {
  closeMenu();
  const dialog = $('#export');
  const preview = $('#export-preview');
  preview.querySelector('canvas')?.remove();
  preview.classList.add('is-loading');
  preview.classList.remove('has-error');
  $('#export-download').removeAttribute('href');
  $('#export-share').hidden = true;
  dialog.showModal();
  try {
    const canvas = await drawMenu(menuForExport());
    // The canvas itself is the preview: some hosts block blob: and object URLs in <img>.
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', t('export.imageAlt'));
    preview.append(canvas);
    const download = $('#export-download');
    download.href = canvas.toDataURL('image/png');
    download.download = exportFileName();
    exportBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const file = exportBlob && new File([exportBlob], exportFileName(), { type: 'image/png' });
    $('#export-share').hidden = !(file && navigator.canShare?.({ files: [file] }));
  } catch {
    preview.classList.add('has-error');
  } finally {
    preview.classList.remove('is-loading');
  }
}

async function shareExportImage() {
  const file = new File([exportBlob], exportFileName(), { type: 'image/png' });
  try {
    await navigator.share({ files: [file], title: t('export.imageTitle') });
  } catch {
    // closed the share sheet
  }
}

async function copyMenuText() {
  const copied = await copyText(menuAsText());
  showToast(t(copied ? 'export.copied' : 'list.copyFailed'));
}

// ---------- small UI helpers ----------

/** Clipboard API first; falls back to a hidden textarea + execCommand where the API is blocked (sandboxed frames). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

let toastTimer;
let toastAction = null;

/** Short message at the bottom; with `actionLabel` it carries one button (e.g. "Undo"). */
function showToast(message, { duration = TOAST_MS, actionLabel = '', onAction = null } = {}) {
  const toast = $('#toast');
  $('#toast-text').textContent = message;
  const button = $('#toast-action');
  button.hidden = !actionLabel;
  button.textContent = actionLabel;
  toastAction = onAction;
  toast.classList.toggle('has-action', Boolean(actionLabel));
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  $('#toast').classList.remove('is-visible', 'has-action');
  $('#toast-action').hidden = true;
  toastAction = null;
}

function openMenu() {
  $('#menu').hidden = false;
  $('#menu-button').setAttribute('aria-expanded', 'true');
  $('#menu [role="menuitem"]').focus();
}

function closeMenu() {
  $('#menu').hidden = true;
  $('#menu-button').setAttribute('aria-expanded', 'false');
}

function applyStaticTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel));
    el.title = t(el.dataset.i18nLabel);
  });
  document.querySelectorAll('[data-i18n-alt]').forEach((el) => { el.alt = t(el.dataset.i18nAlt); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.title = t('app.title');
}

// ---------- offline use and home-screen install ----------

let installPrompt = null;

function setUpInstall() {
  // sw.js keeps a copy of the site so it opens without signal; only on real hosting (https or localhost).
  if ('serviceWorker' in navigator && window.isSecureContext && /^https?:$/.test(window.location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* not allowed here (e.g. some previews) */ });
  }
  const button = $('#install-app');
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Chrome, Edge, Samsung Internet: their own install dialog. Safari on iPhone has none: explain the steps.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    button.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    button.hidden = true;
  });
  if (isIos && !standalone) button.hidden = false;
  button.addEventListener('click', async () => {
    closeMenu();
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === 'accepted') button.hidden = true;
      installPrompt = null;
    } else {
      showToast(t('app.installIos'), { duration: 9000 });
    }
  });
}

// ---------- device sync ----------
//
// Pairing: one device creates a code and shows it as a QR code; scanning it opens the site with
// #sync=<code>, and that device takes over the shared plan. js/sync.js has the data side.

function setUpSync() {
  const testBackend = window.__neSyncBackend; // tests inject a fake backend
  if (!FIREBASE_CONFIG && !testBackend) return; // sync is off until Firebase is configured
  app.syncUi = { view: 'main', pendingCode: null, confirmReset: false, busy: false, message: '' };
  app.sync = createSync({
    loadBackend: () => (testBackend ? Promise.resolve(testBackend) : createFirebaseBackend(FIREBASE_CONFIG)),
    getState: () => app.state,
    applyRemote: applyRemoteState,
    onStatus: renderSync,
    onEnded: (reason) => {
      app.syncUi.view = 'main';
      renderSync();
      showToast(t(reason === 'invalid' ? 'sync.invalid' : 'sync.ended'), { duration: 8000 });
    },
  });
  $('#sync-button').hidden = false;
  $('#sync-button').addEventListener('click', () => openSync());
  $('#sync-close').addEventListener('click', () => $('#sync').close());
  $('#sync').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
  $('#sync').addEventListener('close', () => { app.syncUi.confirmReset = false; app.syncUi.message = ''; });
  $('#sync-body').addEventListener('click', handleSyncClick);
  $('#sync-body').addEventListener('submit', handleSyncSubmit);
  window.addEventListener('online', () => { if (app.sync.connected && app.sync.status === 'error') app.sync.start(); });
  window.addEventListener('hashchange', checkPairingLink);
  app.sync.start();
  renderSync();
  checkPairingLink();
}

/** The shared plan arrived (or changed on another device): adopt it without sending it back. */
function applyRemoteState(shared) {
  if (app.syncUi.joining) {
    app.syncUi.joining = false;
    showToast(t('sync.joined'));
  }
  const next = { ...app.state, ...shared, settings: { ...app.state.settings, ...shared.settings } };
  if (JSON.stringify(next) === JSON.stringify(app.state)) return;
  app.state = next;
  saveState(app.state);
  app.previousMet = null;
  renderAll();
}

function hasOwnPlan() {
  return Object.values(app.state.days ?? {}).some((day) => day?.eatingOut || Object.values(day?.slots ?? {}).some(Boolean));
}

/** A scanned QR code opens the site with #sync=<code>. */
function checkPairingLink() {
  const code = codeFromText(window.location.hash);
  if (!code) return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  if (code === app.sync.code) {
    showToast(t('sync.already'));
    return;
  }
  if (!hasOwnPlan() && !app.sync.connected) {
    joinSync(code);
    return;
  }
  app.syncUi.view = 'join';
  app.syncUi.pendingCode = code;
  openSync();
}

async function joinSync(code) {
  app.syncUi.view = 'main';
  app.syncUi.pendingCode = null;
  app.syncUi.joining = true;
  try {
    localStorage.setItem(`${SYNC_KEY}:before-join`, JSON.stringify(app.state)); // a way back, should it be needed
  } catch { /* storage unavailable */ }
  await app.sync.join(code);
  if (app.syncUi.joining && !app.sync.receivedData && app.sync.connected) showToast(t('sync.joining'), { duration: 6000 });
}

function openSync() {
  closeMenu();
  renderSync();
  const dialog = $('#sync');
  if (!dialog.open) dialog.showModal();
  if (!app.sync.connected && app.syncUi.view === 'main') $('[data-sync="create"]')?.focus();
}

function renderSync() {
  if (!app.sync) return;
  const { status, code, connected } = app.sync;
  const button = $('#sync-button');
  button.dataset.status = connected ? status : 'off';
  // Visible word: "Cihaz ekle" until paired, then "Eşli" (the dot shows whether it is up to date).
  const label = t(connected ? 'sync.labelOn' : 'sync.labelOff');
  button.querySelector('.sync-label').textContent = label;
  button.setAttribute('aria-label', connected ? `${label} · ${t(`sync.status.${status}`)}` : label);

  const ui = app.syncUi;
  const message = ui.message ? `<p class="sync-message" role="alert">${escapeHtml(ui.message)}</p>` : '';
  let body;
  if (ui.view === 'join') {
    body = `
      <h3 class="sync-subtitle">${escapeHtml(t('sync.joinTitle'))}</h3>
      <p class="sync-text">${escapeHtml(t(connected ? 'sync.joinSwitch' : 'sync.joinReplace'))}</p>
      ${connected ? `<p class="sync-text">${escapeHtml(t('sync.joinReplace'))}</p>` : ''}
      <div class="sync-actions">
        <button class="button primary" type="button" data-sync="join-confirm">${escapeHtml(t('sync.joinConfirm'))}</button>
        <button class="button" type="button" data-sync="join-cancel">${escapeHtml(t('sync.joinCancel'))}</button>
      </div>`;
  } else if (!connected) {
    body = `
      <p class="sync-text">${escapeHtml(t('sync.intro'))}</p>
      <div class="sync-actions">
        <button class="button primary" type="button" data-sync="create" ${ui.busy ? 'disabled' : ''}>${escapeHtml(t(ui.busy ? 'sync.creating' : 'sync.create'))}</button>
      </div>
      ${message}
      <form class="sync-join" novalidate>
        <label for="sync-code">${escapeHtml(t('sync.joinLabel'))}</label>
        <div class="sync-join-row">
          <input id="sync-code" name="code" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="button" type="submit">${escapeHtml(t('sync.join'))}</button>
        </div>
      </form>`;
  } else {
    const link = pairingLink(code);
    const share = canShare();
    body = `
      <p class="sync-status" data-status="${escapeHtml(status)}"><span class="sync-dot" aria-hidden="true"></span>${escapeHtml(t(`sync.status.${status}`))}</p>
      <figure class="sync-qr">
        ${qrSvg(link, { dark: '#8E1523', light: '#ffffff', label: escapeHtml(t('sync.qrAlt')) })}
        <figcaption>${escapeHtml(t('sync.scan'))}</figcaption>
      </figure>
      <div class="sync-actions">
        <button class="button" type="button" data-sync="copy">${escapeHtml(t(share ? 'sync.shareLink' : 'sync.copyLink'))}</button>
      </div>
      <p class="sync-note">${escapeHtml(t('sync.linkNote'))}</p>
      ${message}
      <div class="sync-manage">
        <div>
          <button class="link-button" type="button" data-sync="leave">${escapeHtml(t('sync.leave'))}</button>
          <p>${escapeHtml(t('sync.leaveHint'))}</p>
        </div>
        <div>
          ${ui.confirmReset
            ? `<button class="link-button danger" type="button" data-sync="reset-confirm">${escapeHtml(t('sync.resetConfirm'))}</button>`
            : `<button class="link-button danger" type="button" data-sync="reset">${escapeHtml(t('sync.reset'))}</button>`}
          <p>${escapeHtml(t('sync.resetHint'))}</p>
        </div>
      </div>`;
  }
  $('#sync-body').innerHTML = body;
}

async function handleSyncClick(event) {
  const action = event.target.closest('[data-sync]')?.dataset.sync;
  if (!action) return;
  const ui = app.syncUi;
  ui.message = '';
  if (action === 'create') {
    ui.busy = true;
    renderSync();
    try {
      await app.sync.create();
    } catch {
      ui.message = t('sync.failed');
    }
    ui.busy = false;
    renderSync();
  } else if (action === 'copy') {
    const link = pairingLink(app.sync.code);
    if (canShare()) {
      try { await navigator.share({ title: t('app.title'), url: link }); } catch { /* cancelled */ }
    } else {
      try {
        await navigator.clipboard.writeText(link);
        showToast(t('sync.linkCopied'));
      } catch {
        showToast(t('list.copyFailed'));
      }
    }
  } else if (action === 'leave') {
    app.sync.leave();
    $('#sync').close();
    showToast(t('sync.left'), { duration: 6000 });
  } else if (action === 'reset') {
    ui.confirmReset = true;
    renderSync();
  } else if (action === 'reset-confirm') {
    ui.confirmReset = false;
    try {
      await app.sync.reset();
      showToast(t('sync.resetDone'), { duration: 6000 });
    } catch {
      ui.message = t('sync.failed');
    }
    renderSync();
  } else if (action === 'join-confirm') {
    const code = ui.pendingCode;
    $('#sync').close();
    if (app.sync.connected) app.sync.leave();
    await joinSync(code);
  } else if (action === 'join-cancel') {
    ui.view = 'main';
    ui.pendingCode = null;
    $('#sync').close();
  }
}

async function handleSyncSubmit(event) {
  event.preventDefault();
  const code = codeFromText(event.target.elements.code.value);
  if (!code) {
    app.syncUi.message = t('sync.badCode');
    renderSync();
    $('#sync-code')?.focus();
    return;
  }
  $('#sync').close();
  if (hasOwnPlan()) {
    app.syncUi.view = 'join';
    app.syncUi.pendingCode = code;
    openSync();
  } else {
    await joinSync(code);
  }
}

function renderAll() {
  renderHeader();
  renderWeek();
  renderTips();
  renderStorageNotes();
  renderNutrition();
  renderShopping();
}

function changeWeek(offsetDays, { swiped = false } = {}) {
  app.weekStart = offsetDays === 0 ? startOfWeek(new Date()) : addDays(app.weekStart, offsetDays);
  app.previousMet = null; // no "just met" animation when switching weeks
  app.openItems.clear();
  renderAll();
  if (swiped) {
    const week = $('#week');
    week.classList.remove('swipe-next', 'swipe-prev');
    void week.offsetWidth; // restart the animation
    week.classList.add(offsetDays > 0 ? 'swipe-next' : 'swipe-prev');
    const card = $('.board-card');
    if (card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: 'start' });
  } else if (offsetDays === 0) {
    scrollToToday({ smooth: true });
  }
}

// ---------- phone: today first, swipe between weeks ----------

const NARROW_SCREEN = window.matchMedia('(max-width: 600px)');
const SWIPE_MIN_PX = 70;
const SWIPE_MAX_MS = 600;

/** On a phone the days stack, so later days are far down: open at today. */
function scrollToToday({ smooth = false } = {}) {
  if (!NARROW_SCREEN.matches) return;
  const today = $('#week .day.is-today');
  if (!today || today === $('#week .day')) return; // Monday is already in view
  today.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

/** A quick horizontal swipe on the board shows the next or previous week (not after dragging a dish). */
function bindSwipe() {
  let start = null;
  const board = $('#week');
  board.addEventListener('touchstart', (event) => {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    start = touch && { x: touch.clientX, y: touch.clientY, at: Date.now() };
  }, { passive: true });
  board.addEventListener('touchend', (event) => {
    const from = start;
    start = null;
    if (!from || drag || Date.now() - (app.dragEndedAt ?? 0) < 500) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - from.x;
    const dy = touch.clientY - from.y;
    if (Date.now() - from.at > SWIPE_MAX_MS || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    changeWeek(dx < 0 ? 7 : -7, { swiped: true });
  });
  board.addEventListener('touchcancel', () => { start = null; });
}

function bindEvents() {
  $('#prev-week').addEventListener('click', () => changeWeek(-7));
  $('#next-week').addEventListener('click', () => changeWeek(7));
  $('#this-week').addEventListener('click', () => changeWeek(0));
  bindSwipe();
  $('#servings-down').addEventListener('click', () => changeServings(-1));
  $('#servings-up').addEventListener('click', () => changeServings(1));
  $('#servings').addEventListener('input', handleServingsInput);
  $('#servings').addEventListener('change', commitServings);
  $('#servings').addEventListener('focus', (event) => event.target.select());
  $('#servings').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.target.blur();
    else if (event.key === 'Escape') { event.target.value = String(app.state.settings.servings); event.target.blur(); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      changeServings(event.key === 'ArrowUp' ? 1 : -1);
      event.target.value = String(app.state.settings.servings);
      event.target.select();
    }
  });

  $('#menu-button').addEventListener('click', () => ($('#menu').hidden ? openMenu() : closeMenu()));
  document.addEventListener('click', (e) => {
    if (!$('#menu').hidden && !e.target.closest('.menu-wrap')) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#menu').hidden) { closeMenu(); $('#menu-button').focus(); }
  });
  $('#copy-previous').addEventListener('click', copyPreviousWeek);
  $('#clear-week').addEventListener('click', clearWeek);
  // Printing lives in the share dialog: the board on one page, the shopping list on the next.
  $('#export-print').addEventListener('click', () => {
    $('#export').close();
    setTimeout(() => { try { window.print(); } catch { /* blocked in some frames */ } }, 50);
  });
  $('#include-optional').addEventListener('change', (e) => {
    app.state.settings.includeOptional = e.target.checked;
    persist();
    renderShopping();
  });

  $('#week').addEventListener('click', handleWeekClick);
  $('#week').addEventListener('pointerdown', onDragStart);
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragEnd);
  // While a dish is held on a touch screen, the finger moves the dish, not the page.
  document.addEventListener('touchmove', (e) => { if (drag?.active) e.preventDefault(); }, { passive: false });
  $('#week').addEventListener('contextmenu', (e) => { if (drag) e.preventDefault(); });
  $('#tips').addEventListener('click', handleTipClick);
  $('#export-button').addEventListener('click', openExport);
  $('#export-close').addEventListener('click', () => $('#export').close());
  $('#export').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $('#export-share').addEventListener('click', shareExportImage);
  $('#export-copy').addEventListener('click', copyMenuText);
  $('#list-add-input').addEventListener('input', renderAddResults);
  $('#list-add-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = $('#list-add-results [data-ingredient]');
      if (first) chooseAddResult(first.dataset.ingredient);
    } else if (e.key === 'Escape') {
      e.target.value = '';
      renderAddResults();
    }
  });
  $('#list-add-results').addEventListener('click', (e) => {
    const button = e.target.closest('[data-ingredient]');
    if (button) chooseAddResult(button.dataset.ingredient);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.list-add')) $('#list-add-results').hidden = true;
  });
  $('#list-add-input').addEventListener('focus', renderAddResults);
  $('#toast-action').addEventListener('click', () => {
    const action = toastAction;
    hideToast();
    action?.();
  });
  // Another tab changed the plan: load it, so tabs never overwrite each other with stale data.
  window.addEventListener('storage', (event) => {
    if (event.key === SYNC_KEY) { app.sync?.reloadRecord(); renderSync(); return; }
    if (event.key !== STORAGE_KEY) return;
    app.state = loadState();
    app.previousMet = null;
    renderAll();
  });
  $('#shopping').addEventListener('click', handleShoppingEvent);
  $('#shopping').addEventListener('change', handleShoppingEvent);

  $('#picker-close').addEventListener('click', () => $('#picker').close());
  $('#picker').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close(); // backdrop click
  });
  $('#picker-search').addEventListener('input', (e) => {
    app.picker.query = e.target.value;
    renderPickerResults();
  });
  $('#picker').addEventListener('close', restorePickerFocus);
  // Dialogs opened from the top bar hand focus back to their button (if focus would otherwise fall to the page).
  for (const [dialog, opener] of [['#export', '#export-button'], ['#sync', '#sync-button']]) {
    $(dialog).addEventListener('close', () => {
      if (!document.activeElement || document.activeElement === document.body) $(opener)?.focus();
    });
  }
  $('#picker-search').addEventListener('keydown', handlePickerArrows);
  $('#picker-results').addEventListener('keydown', handlePickerArrows);
  $('#week').addEventListener('keydown', handleWeekKeys);
  $('#picker-search').addEventListener('keydown', (e) => {
    // Enter picks the first result.
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = $('#picker-results [data-dish]');
    if (first) chooseDish(first.dataset.dish);
  });
  for (const strip of ['#picker-courses', '#picker-categories']) {
    $(strip).addEventListener('wheel', scrollStripWithWheel, { passive: false });
  }
  $('#picker-courses').addEventListener('click', (e) => {
    const button = e.target.closest('[data-course]');
    if (!button) return;
    app.picker.course = button.dataset.course;
    app.picker.category = 'all';
    renderPickerFilters();
    renderPickerResults();
  });
  $('#picker-categories').addEventListener('click', (e) => {
    const button = e.target.closest('[data-category], [data-season]');
    if (!button) return;
    if (button.hasAttribute('data-season')) app.picker.inSeasonOnly = !app.picker.inSeasonOnly;
    else app.picker.category = button.dataset.category;
    renderPickerFilters();
    renderPickerResults();
  });
  $('#picker-results').addEventListener('click', (e) => {
    const button = e.target.closest('[data-dish]');
    if (button) chooseDish(button.dataset.dish);
  });
}

async function init() {
  await loadLocale(LOCALE);
  applyStaticTranslations();
  try {
    const response = await fetch('data/catalog.json');
    if (!response.ok) throw new Error(response.statusText);
    app.catalog = await response.json();
  } catch {
    $('#week').innerHTML = `<p class="loading">${escapeHtml(t('app.loadError'))}</p>`;
    return;
  }
  app.labels = app.catalog.labels[LOCALE] ?? {};
  dropHiddenSlots();
  app.catalog.dishes.forEach((d) => app.dishesById.set(d.id, d));
  app.catalog.ingredients.forEach((i) => app.ingredientsById.set(i.id, i));
  app.catalog.dishes.forEach((d) => app.nutritionByDish.set(d.id, dishNutrition(d, app.ingredientsById, app.catalog.servings)));
  app.showHints = countVisit() <= HINT_VISITS;
  bindEvents();
  renderAll();
  scrollToToday();
  setUpSync();
  setUpInstall();
}

init();
