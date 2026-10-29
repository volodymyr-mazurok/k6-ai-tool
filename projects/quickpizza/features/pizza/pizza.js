// k6 script of the QuickPizza pizza feature: one visitor reads a quote, looks at the doughs and the tools, and asks for a
// pizza recommendation. Step names, routes and optional shares come from journey.yaml through the run config
// (PERF_CONFIG_FILE); this file adds the request bodies, the auth header and the content checks.
// Start it only through `npm run perf -- run quickpizza pizza ...`, never with a plain `k6 run`.
//
// The checks look at the shape of an answer only: QuickPizza makes up a new pizza (name, dough, toppings, tool) for every
// request, so an exact name would fail at random. See context.md.
import { loadRunConfig, loadSecrets, buildOptions } from '../../../../core/config.js';
import { staticHeaders } from '../../../../core/auth/static.js';
import { step, think } from '../../../../core/request.js';

export { handleSummary } from '../../../../core/summary.js';

const cfg = loadRunConfig();

// The top level runs once per virtual user, so each VU makes its own `Authorization: token <16 random characters>` here
// and keeps it for all its requests. QuickPizza maps a token it does not know to its shared default user.
const AUTH = staticHeaders(loadSecrets());

export const options = buildOptions(cfg);

// The restrictions of the recommendation. QuickPizza compares names exactly (slices.Contains in pkg/http/http.go), and its
// catalog spells them with a capital letter, so the names here are written that way: "pepperoni" would exclude nothing.
const RESTRICTIONS = {
  maxCaloriesPerSlice: 500,
  mustBeVegetarian: false,
  excludedIngredients: ['Pepperoni'],
  excludedTools: ['Knife'],
  maxNumberOfToppings: 6,
  minNumberOfToppings: 2,
};

// A pizza is olive oil, tomato and mozzarella plus 2 to 6 toppings, with duplicates removed: 4 to 9 ingredients.
const BASE_INGREDIENTS = 3;
const MIN_INGREDIENTS = BASE_INGREDIENTS + 1; // two toppings drawn the same are one ingredient
const MAX_INGREDIENTS = BASE_INGREDIENTS + RESTRICTIONS.maxNumberOfToppings;

/** Parsed JSON body, or null for an answer that is not JSON: an error page must fail a check, not crash the script. */
function json(res) {
  try {
    return res.json();
  } catch (_err) {
    return null;
  }
}

/** A check that the answer holds a non-empty list under `key`. Never throws. */
const nonEmptyList = (key) => (res) => {
  const body = json(res);
  return body !== null && typeof body === 'object' && Array.isArray(body[key]) && body[key].length > 0;
};

/** The recommended pizza, or null when the answer has none. */
function pizzaOf(res) {
  const body = json(res);
  const pizza = body !== null && typeof body === 'object' ? body.pizza : null;
  return pizza !== null && typeof pizza === 'object' ? pizza : null;
}

const ingredientsOf = (pizza) => (pizza && Array.isArray(pizza.ingredients) ? pizza.ingredients : null);

const PIZZA_CHECKS = {
  'pizza has an id': (res) => {
    const pizza = pizzaOf(res);
    return pizza !== null && typeof pizza.id === 'number';
  },
  [`${MIN_INGREDIENTS} to ${MAX_INGREDIENTS} ingredients`]: (res) => {
    const list = ingredientsOf(pizzaOf(res));
    return list !== null && list.length >= MIN_INGREDIENTS && list.length <= MAX_INGREDIENTS;
  },
  'no excluded ingredient': (res) => {
    const list = ingredientsOf(pizzaOf(res));
    return list !== null && list.every((i) => i && typeof i.name === 'string' && i.name.toLowerCase() !== 'pepperoni');
  },
  'no excluded tool': (res) => {
    const pizza = pizzaOf(res);
    return pizza !== null && typeof pizza.tool === 'string' && pizza.tool.toLowerCase() !== 'knife';
  },
};

// The function name is journey.yaml `exec`. The step id passed to step() is <journey key>.<step name>.
export function pizzaShopper() {
  step('pizza.quotes', {
    method: 'GET',
    url: cfg.apiUrl + '/api/quotes', // public: no token
    checks: { 'has quotes': nonEmptyList('quotes') },
  });
  think(cfg);

  step('pizza.catalog_doughs', {
    method: 'GET',
    url: cfg.apiUrl + '/api/doughs',
    headers: AUTH,
    checks: { 'has doughs': nonEmptyList('doughs') },
  });
  think(cfg);

  step('pizza.catalog_tools', {
    method: 'GET',
    url: cfg.apiUrl + '/api/tools',
    headers: AUTH,
    checks: { 'has tools': nonEmptyList('tools') },
  });
  think(cfg);

  step('pizza.recommend', {
    method: 'POST',
    url: cfg.apiUrl + '/api/pizza',
    body: RESTRICTIONS,
    headers: AUTH,
    checks: PIZZA_CHECKS,
  });
}
