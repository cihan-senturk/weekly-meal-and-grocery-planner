// Minimal i18n: UI strings come from /locales/<locale>.json,
// catalog content (dish/ingredient names, labels) comes from catalog.json.

let strings = {};
let currentLocale = 'tr';

export async function loadLocale(locale) {
  const response = await fetch(`locales/${locale}.json`);
  if (!response.ok) throw new Error(`Locale ${locale} not found`);
  strings = await response.json();
  currentLocale = locale;
  document.documentElement.lang = locale;
}

export function getLocale() {
  return currentLocale;
}

/** Translate a key, replacing {name} placeholders with params. Falls back to the key. */
export function t(key, params = {}) {
  const template = strings[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/** Pick the best name from a localized map like { tr: "Kuru fasulye", en: "..." }. */
export function localized(nameMap, fallbackLocale = 'tr') {
  if (!nameMap) return '';
  return nameMap[currentLocale] ?? nameMap[fallbackLocale] ?? Object.values(nameMap)[0] ?? '';
}

export function formatDate(date, options) {
  return new Intl.DateTimeFormat(currentLocale, options).format(date);
}

export function formatNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat(currentLocale, { maximumFractionDigits }).format(value);
}

/** Lowercase, accent- and dotless-i-insensitive key for search. */
export function searchKey(text) {
  return text
    .toLocaleLowerCase(currentLocale)
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}
