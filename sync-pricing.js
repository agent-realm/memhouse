#!/usr/bin/env node
/**
 * Sync pricing.json from models.dev/api.json
 *
 * Usage:
 *   node sync-pricing.js           # dry-run: show diff only
 *   node sync-pricing.js --write   # write changes to pricing.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const MODELS_DEV_URL = 'https://models.dev/api.json';
const PRICING_PATH = path.join(__dirname, 'pricing.json');

// Providers we care about (others are either free or irrelevant)
const PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'deepseek'];

// ── Fetch models.dev/api.json ──────────────────────────────────
function fetchModels() {
  return new Promise((resolve, reject) => {
    https.get(MODELS_DEV_URL, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Convert model id → pricing.json key ─────────────────────────
// "claude-opus-4-5-20251101" → "claude-opus-4-5-20251101"
// "gpt-5.2-pro"              → "gpt-5-2-pro"
// "gemini-2.5-flash"         → "gemini-2-5-flash"
function toPricingKey(id) {
  // Dots → dashes (gpt-5.2 → gpt-5-2)
  return id.replace(/\./g, '-').toLowerCase();
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const writeMode = process.argv.includes('--write');

  console.log('Fetching models.dev/api.json...');
  const apiData = await fetchModels();

  // Load current pricing.json
  const current = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf-8'));
  const meta = current._meta;

  // Build new pricing map from models.dev
  // API shape: { providerName: { models: { modelId: { cost: {...}, ... } } } }
  const remote = {};
  let totalModels = 0;
  let skipped = 0;

  for (const provider of PROVIDERS) {
    const providerData = apiData[provider];
    if (!providerData || !providerData.models) continue;

    for (const [modelId, m] of Object.entries(providerData.models)) {
      totalModels++;
      if (!m.cost) { skipped++; continue; }

      const input = m.cost.input || 0;
      const output = m.cost.output || 0;
      if (input === 0 && output === 0) { skipped++; continue; }

      const key = toPricingKey(modelId);
      const entry = {
        input, output,
        // Only include cache fields when the API actually provides them
        // (many providers don't report cache_write / cache_read)
        cacheRead: m.cost.cache_read != null ? m.cost.cache_read : undefined,
        cacheWrite: m.cost.cache_write != null ? m.cost.cache_write : undefined,
      };

      // Skip preview/experimental variants if the base model already exists
      if (key.endsWith('-preview') || key.endsWith('-experimental')) {
        const base = key.replace(/-(preview|experimental)$/, '');
        if (!remote[base]) {
          remote[key] = entry;
        }
        continue;
      }

      remote[key] = entry;
    }
  }

  console.log(`  ${totalModels} models from ${PROVIDERS.join(', ')}`);

  console.log(`  ${Object.keys(remote).length} priced models (${skipped} skipped)\n`);

  // Compare with current
  const added = [];
  const updated = [];
  const removed = [];
  const unchanged = [];

  // Check remote models against current
  for (const [key, pricing] of Object.entries(remote)) {
    if (key.startsWith('_')) continue;
    const cur = current[key];
    const merged = mergePricing(cur, pricing, key);
    if (!cur) {
      added.push({ key, pricing: merged });
    } else {
      const diff = pricingDiff(cur, pricing);
      if (diff) {
        updated.push({ key, old: cur, new: merged, diff });
      } else {
        unchanged.push(key);
      }
    }
  }

  // Check current models not in remote (potential removals)
  for (const key of Object.keys(current)) {
    if (key.startsWith('_')) continue;
    if (!remote[key]) {
      removed.push(key);
    }
  }

  // Report
  if (added.length > 0) {
    console.log(`\x1b[32m+ ${added.length} new models:\x1b[0m`);
    for (const { key, pricing } of added) {
      console.log(`    ${key}  in=$${pricing.input}  out=$${pricing.output}  cr=$${pricing.cacheRead}  cw=$${pricing.cacheWrite}`);
    }
    console.log('');
  }

  if (updated.length > 0) {
    console.log(`\x1b[33m~ ${updated.length} price changes:\x1b[0m`);
    for (const u of updated) {
      console.log(`    ${u.key}  ${u.diff}`);
    }
    console.log('');
  }

  if (removed.length > 0) {
    console.log(`\x1b[31m- ${removed.length} models in pricing.json but not in models.dev (keeping):\x1b[0m`);
    for (const key of removed) {
      console.log(`    ${key}`);
    }
    console.log('');
  }

  console.log(`  ${unchanged.length} unchanged`);

  if (added.length === 0 && updated.length === 0) {
    console.log('\npricing.json is up to date!');
    return;
  }

  if (!writeMode) {
    console.log('\nDry run — use --write to apply changes');
    return;
  }

  // Build new pricing.json
  const result = { _meta: meta };

  // Merge: keep current (including manually-added aliases), apply updates, add new
  for (const key of Object.keys(current)) {
    if (key.startsWith('_')) continue;
    const upd = updated.find(u => u.key === key);
    result[key] = upd ? upd.new : current[key];
  }
  for (const { key, pricing } of added) {
    result[key] = pricing;
  }

  // Update lastVerified date
  result._meta = { ...meta, lastVerified: new Date().toISOString().slice(0, 7) };

  fs.writeFileSync(PRICING_PATH, JSON.stringify(result, null, 2) + '\n');
  if (unknownRates.length) {
    console.log(`\n\x1b[33m! ${unknownRates.length} new model(s) have no published cache rate — those tokens will cost $0:\x1b[0m`);
    for (const u of unknownRates) console.log(`    ${u.key} — ${u.missing.join(', ')} unknown, recorded as 0`);
    console.log('  That is the source\'s gap, not a price of zero. Set them by hand in pricing.json if you know them.');
  }
  console.log(`\n\x1b[32m✓ pricing.json updated (${added.length} added, ${updated.length} updated)\x1b[0m`);
}

function pricingDiff(a, b) {
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const diffs = [];
  for (const f of fields) {
    // Skip comparison when remote doesn't provide this field
    if (b[f] === undefined) continue;
    const av = a[f] || 0;
    const bv = b[f] || 0;
    if (av !== bv) diffs.push(`${f}: $${av} → $${bv}`);
  }
  return diffs.length > 0 ? diffs.join(', ') : null;
}

// Merge remote pricing into existing, preserving local cache values when remote is undefined
// Keep a rate we already know when the remote omits it — 80 of 97 remote models publish no
// cache_write and 27 no cache_read, so taking the remote at face value would overwrite a
// good number with zero. For a model we have never seen, zero is what the source says, but
// zero MEANS "these tokens are free" everywhere downstream. Record which ones so --write
// can say so out loud instead of quietly under-reporting, the same failure mode as an
// unpriced model.
const unknownRates = [];
function mergePricing(existing, remote, key) {
  const out = {
    input: remote.input,
    output: remote.output,
    cacheRead: remote.cacheRead !== undefined ? remote.cacheRead : (existing?.cacheRead || 0),
    cacheWrite: remote.cacheWrite !== undefined ? remote.cacheWrite : (existing?.cacheWrite || 0),
  };
  if (key && !existing) {
    const missing = [];
    if (remote.cacheRead === undefined) missing.push('cacheRead');
    if (remote.cacheWrite === undefined) missing.push('cacheWrite');
    if (missing.length) unknownRates.push({ key, missing });
  }
  return out;
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
