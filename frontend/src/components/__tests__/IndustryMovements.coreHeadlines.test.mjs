import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(__dirname, '../IndustryMovements.jsx');
const source = readFileSync(sourcePath, 'utf8');
const backendSource = readFileSync(resolve(__dirname, '../../../../backend/main.py'), 'utf8');

test('core headline scan key is not state that can retrigger and abort its own effect', () => {
    assert.equal(
        source.includes('const [newsKey, setNewsKey] = useState'),
        false,
        'newsKey state changes retrigger the core-headline effect cleanup while requests are in flight',
    );
    assert.equal(
        /\}, \[activeTab,\s*coreMovers,\s*newsKey\]\);/.test(source),
        false,
        'the core-headline effect must not depend on a key it mutates during startup',
    );
});

test('core headline cards render when headlines are loaded even if movers are still refreshing', () => {
    assert.equal(
        source.includes("{loading ? (\n                        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Finish loading movers to identify core news.</div>"),
        false,
        'headline rendering must not be blocked by the global movers loading flag once newsItems exist',
    );
    assert.match(source, /coreMovers\.length === 0 \? \(/);
    assert.match(source, /newsItems\.length > 0 \? \(/);
});

test('market mover prices are fetched in chunks so loading progress can advance', () => {
    assert.match(source, /const MOVEMENT_CHUNK_SIZE = 8;/);
    assert.match(source, /const MOVEMENT_CHUNK_CONCURRENCY = 3;/);
    assert.match(source, /const chunks = chunkArray\(activeTickers, MOVEMENT_CHUNK_SIZE\);/);
    assert.equal(
        source.includes('axios.post(`${INTELLIGENCE_SERVICE}/batch-price-changes?${params}`, activeTickers'),
        false,
        'posting the full ticker universe in one request prevents incremental progress and partial rendering',
    );
});

test('market mover refresh bypasses stale frontend cache safely', () => {
    assert.match(source, /const MOVEMENT_CACHE_TTL_MS = 60_000;/);
    assert.match(source, /const forceRefresh = Boolean\(options\?\.force\);/);
    assert.match(source, /Date\.now\(\) - cachedPayload\.savedAt < MOVEMENT_CACHE_TTL_MS/);
    assert.match(source, /onClick=\{\(\) => fetchData\(\{ force: true \}\)\}/);
    assert.equal(
        source.includes('onClick={fetchData}'),
        false,
        'Refresh must not pass the click event as the fetch options/controller argument',
    );
});

test('core mover ranking does not reuse an array sorted in the opposite direction', () => {
    assert.match(source, /const highest = \[\.\.\.byChange\]\.sort\(\(a, b\) => b\.change_percent - a\.change_percent\)\.slice\(0, 3\);/);
    assert.match(source, /const lowest = \[\.\.\.byChange\]\.sort\(\(a, b\) => a\.change_percent - b\.change_percent\)\.slice\(0, 3\);/);
});

test('trading signal input uses autocomplete and rejects exchange-suffixed peer symbols', () => {
    assert.match(source, /const \[signalSuggestions, setSignalSuggestions\] = useState\(\[\]\);/);
    assert.match(source, /params: \{ q: query \}/);
    assert.match(source, /isPrimarySignalTicker\(item\.symbol\)/);
    assert.match(source, /replaceCurrentSignalToken\(signalInput, item\.symbol\)/);
    assert.match(source, /\.filter\(t => t !== symbol && isPrimarySignalTicker\(t\)\)/);
});

test('trading signal exposes day-trading and swing-trading candle intervals', () => {
    for (const interval of ['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1d']) {
        assert.match(source, new RegExp(`value: '${interval}'`));
    }
    assert.match(source, /normalizeSignalPeriod\(options\.period \|\| signalPeriod, requestedInterval\)/);
    assert.match(source, /disabled=\{!getSignalIntervalOption\(signalInterval\)\.periods\.includes\(option\.value\)\}/);
});

test('backend peer resolver avoids broad web-search ticker extraction', () => {
    assert.match(backendSource, /ticker_peers:\{symbol\}:\{safe_limit\}:v3/);
    assert.match(backendSource, /return candidate_industry == industry/);
    assert.match(backendSource, /_is_primary_us_symbol\(normalized\)/);
    assert.equal(
        backendSource.includes('web search ticker mention'),
        false,
        'web-search token extraction treated unrelated symbols as peers',
    );
});

test('backend market movers report cumulative intraday volume and use fresh cache key', () => {
    assert.match(backendSource, /batch_price_changes:\{period\}:\{interval or 'auto'\}:ext=\{int\(extended\)\}:v2:/);
    assert.match(backendSource, /volume = vol_vals\.sum\(\) if len\(vol_vals\) > 0 else None/);
    assert.equal(
        backendSource.includes('volume = vol_vals[-1] if len(vol_vals) > 0 else None'),
        false,
        '1D movers should not display only the last one-minute candle volume',
    );
});

test('backend market overview index cards use bulk price-change calculation', () => {
    assert.match(backendSource, /prices = await _bulk_price_changes\(list\(indices\.keys\(\)\), period, interval, False\)/);
    assert.match(backendSource, /latest intraday price versus previous daily close for 1D/);
    assert.equal(
        backendSource.includes('async def get_market_overview(period: str = "1d", interval: str = None):\n    """Get market overview with indices"""\n    return _sanitize_nan(market_intel.get_market_movers(period, interval))'),
        false,
        'market overview should not rely directly on the older quote snapshot path for index cards',
    );
});
