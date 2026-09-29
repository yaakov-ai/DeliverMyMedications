// Extracts the catalog and pricing constants from public/index.html so the Worker charges the same prices the site shows.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const grab = (re, what) => { const m = html.match(re); if (!m) throw new Error(`build: couldn't find ${what} in public/index.html`); return m[1]; };
const catalog = JSON.parse(grab(/const CATALOG = (\[.*?\]);\n/s, "CATALOG"));
const grid = JSON.parse(grab(/\/\*GRID_START\*\/const PRICE_GRID = (\{.*?\});\/\*GRID_END\*\//s, "PRICE_GRID"));
const supplySubs = JSON.parse(grab(/const SUPPLY_SUBS=new Set\((\[.*?\])\);/s, "SUPPLY_SUBS"));
const num = (re, what) => Number(grab(re, what));
const constants = {
  PROVIDER_FEE: num(/const PROVIDER_FEE = (\d+(?:\.\d+)?);/, "PROVIDER_FEE"),
  EXCLUDED_STATES: JSON.parse(grab(/const EXCLUDED_STATES = (\[.*?\]);/, "EXCLUDED_STATES")),
  SHIP: {
    standardFee: num(/standardFee:\s*(\d+(?:\.\d+)?)/, "SHIP.standardFee"),
    nextDayFee: num(/nextDayFee:\s*(\d+(?:\.\d+)?)/, "SHIP.nextDayFee"),
    coldFee: num(/coldFee:\s*(\d+(?:\.\d+)?)/, "SHIP.coldFee")
  },
  PLAN_DISCOUNT: JSON.parse(grab(/const PLAN_DISCOUNT = (\{.*?\});/, "PLAN_DISCOUNT").replace(/(\d+):/g, '"$1":'))
};
mkdirSync(new URL("../src/generated/", import.meta.url), { recursive: true });
writeFileSync(new URL("../src/generated/catalog.json", import.meta.url), JSON.stringify({ catalog, grid, supplySubs, constants }));
console.log(`build: ${catalog.length} products, ${Object.keys(grid).length} price grids, review fee $${constants.PROVIDER_FEE}, cold chain $${constants.SHIP.coldFee}`);
