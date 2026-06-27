const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const read = (row, names) => {
    const key = Object.keys(row || {}).find((candidate) => names.includes(candidate.trim().toLowerCase()));
    return key ? row[key] : null;
};

export const isIntradayInterval = (interval) => ['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h'].includes(interval);

export function normalizeTradeCandles(rows, startDate = '', endDate = '') {
    const start = startDate ? new Date(startDate).getTime() : null;
    const end = endDate ? new Date(`${endDate}T23:59:59`).getTime() : null;
    const seen = new Set();
    return (rows || []).map((row) => {
        const timestamp = new Date(read(row, ['date', 'datetime', 'time', 'timestamp'])).getTime();
        const open = num(read(row, ['open']));
        const high = num(read(row, ['high']));
        const low = num(read(row, ['low']));
        const close = num(read(row, ['close']));
        const volume = num(read(row, ['volume'])) || 0;
        if (!Number.isFinite(timestamp) || [open, high, low, close].some((value) => value === null)) return null;
        return { time: Math.floor(timestamp / 1000), open, high, low, close, volume };
    }).filter(Boolean).sort((a, b) => a.time - b.time).filter((bar) => {
        const key = String(bar.time);
        if (seen.has(key) || (start && bar.time * 1000 < start) || (end && bar.time * 1000 > end)) return false;
        seen.add(key);
        return true;
    });
}

const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function sma(candles, period) {
    if (candles.length < period) return null;
    return average(candles.slice(-period).map((bar) => bar.close));
}

function ema(candles, period) {
    if (candles.length < period) return null;
    const multiplier = 2 / (period + 1);
    return candles.slice(-(period * 3)).reduce((value, bar, index) => index === 0 ? bar.close : ((bar.close - value) * multiplier) + value, candles[candles.length - (period * 3)]?.close || candles[0].close);
}

function rsi(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const changes = candles.slice(-(period + 1)).slice(1).map((bar, index) => bar.close - candles[candles.length - period - 1 + index].close);
    const gains = average(changes.map((value) => Math.max(value, 0)));
    const losses = average(changes.map((value) => Math.max(-value, 0)));
    if (losses === 0) return 100;
    return 100 - (100 / (1 + gains / losses));
}

function atr(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const sample = candles.slice(-(period + 1));
    return average(sample.slice(1).map((bar, index) => Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - sample[index].close),
        Math.abs(bar.low - sample[index].close),
    )));
}

function vwap(candles) {
    const session = candles.filter((bar) => new Date(bar.time * 1000).toDateString() === new Date(candles[candles.length - 1]?.time * 1000).toDateString());
    const volume = session.reduce((sum, bar) => sum + bar.volume, 0);
    return volume ? session.reduce((sum, bar) => sum + (((bar.high + bar.low + bar.close) / 3) * bar.volume), 0) / volume : null;
}

function pivots(candles, radius) {
    const highs = [], lows = [];
    for (let index = radius; index < candles.length - radius; index += 1) {
        const window = candles.slice(index - radius, index + radius + 1);
        if (candles[index].high === Math.max(...window.map((bar) => bar.high))) highs.push({ ...candles[index], price: candles[index].high, index });
        if (candles[index].low === Math.min(...window.map((bar) => bar.low))) lows.push({ ...candles[index], price: candles[index].low, index });
    }
    return { highs, lows };
}

function clusteredLevels(points, type, tolerance) {
    const clusters = [];
    [...points].sort((a, b) => a.price - b.price).forEach((point) => {
        const cluster = clusters.find((item) => Math.abs(item.price - point.price) <= tolerance);
        if (cluster) {
            cluster.points.push(point);
            cluster.price = average(cluster.points.map((entry) => entry.price));
        } else clusters.push({ type, price: point.price, points: [point] });
    });
    return clusters.filter((cluster) => cluster.points.length >= 2).map((cluster) => ({
        id: `${type}-${round(cluster.price, 4)}`,
        type,
        price: round(cluster.price),
        touches: cluster.points.length,
        label: `${type === 'support' ? 'Support' : 'Resistance'} ${round(cluster.price)} (${cluster.points.length} touches)`,
    }));
}

function trendline(points, type, tolerance) {
    if (points.length < 2) return null;
    const [first, second] = points.slice(-2);
    const slope = (second.price - first.price) / Math.max(1, second.index - first.index);
    const touches = points.filter((point) => Math.abs((first.price + slope * (point.index - first.index)) - point.price) <= tolerance).length;
    const rising = slope > 0;
    if ((type === 'support' && !rising) || (type === 'resistance' && rising)) return null;
    return {
        id: `${type}-trend-${first.time}`,
        type,
        points: [{ time: first.time, value: first.price }, { time: second.time, value: second.price }],
        touches,
        validated: touches >= 3,
        label: `${type === 'support' ? 'Rising support' : 'Falling resistance'} (${touches >= 3 ? `${touches} touches` : '2-pivot candidate'})`,
    };
}

function structures(pivotHighs, pivotLows, candles, tolerance) {
    const result = [];
    const highs = pivotHighs.slice(-3);
    const lows = pivotLows.slice(-3);
    if (highs.length >= 2 && lows.length >= 2) {
        const higherHighs = highs.at(-1).price > highs.at(-2).price;
        const higherLows = lows.at(-1).price > lows.at(-2).price;
        const lowerHighs = highs.at(-1).price < highs.at(-2).price;
        const lowerLows = lows.at(-1).price < lows.at(-2).price;
        if (higherHighs && higherLows) result.push({ type: 'uptrend', label: 'Higher highs / higher lows', confidence: 'confirmed' });
        if (lowerHighs && lowerLows) result.push({ type: 'downtrend', label: 'Lower highs / lower lows', confidence: 'confirmed' });
        if (Math.abs(highs.at(-1).price - highs.at(-2).price) <= tolerance) result.push({ type: 'double_top', label: 'Possible double top', confidence: 'candidate' });
        if (Math.abs(lows.at(-1).price - lows.at(-2).price) <= tolerance) result.push({ type: 'double_bottom', label: 'Possible double bottom', confidence: 'candidate' });
        const highSlope = highs.at(-1).price - highs.at(-2).price;
        const lowSlope = lows.at(-1).price - lows.at(-2).price;
        if (highSlope < 0 && lowSlope > 0) result.push({ type: 'triangle', label: 'Contracting triangle', confidence: 'candidate' });
    }
    const recent = candles.slice(-20);
    if (recent.length >= 10) {
        const high = Math.max(...recent.map((bar) => bar.high));
        const low = Math.min(...recent.map((bar) => bar.low));
        const latest = recent.at(-1).close;
        if ((high - low) / low < 0.08) result.push({ type: 'range', label: 'Recent consolidation range', confidence: 'confirmed' });
        if (latest > high - tolerance) result.push({ type: 'breakout', label: 'Testing recent range high', confidence: 'candidate' });
        if (latest < low + tolerance) result.push({ type: 'breakdown', label: 'Testing recent range low', confidence: 'candidate' });
    }
    return result;
}

const check = (label, pass, watch, detail) => ({ label, status: pass ? 'pass' : watch ? 'watch' : 'fail', detail });

function buildSetup(name, metrics) {
    const { price, ema20, sma50, rsi14, volumeRatio, atr14, support, resistance, mode } = metrics;
    const stopBuffer = atr14 || price * 0.02;
    if (name === 'pullback') {
        const entry = ema20 || support;
        const stop = Math.min(support || entry - stopBuffer, entry - stopBuffer);
        const target = resistance || entry + (entry - stop) * 2;
        return {
            title: 'Trend Pullback', entry: round(entry), stop: round(stop), target: round(target), stretchTarget: round(entry + (entry - stop) * 2),
            checks: [check('Trend aligned', price > (sma50 || 0), price >= (ema20 || 0), `Price ${round(price)}; 50 MA ${round(sma50)}`), check('Pullback near 20 EMA', Math.abs(price - (ema20 || price)) <= stopBuffer, price > (ema20 || 0), `20 EMA ${round(ema20)}`), check('RSI reset', rsi14 >= 40 && rsi14 <= 60, rsi14 >= 35 && rsi14 <= 65, `RSI ${round(rsi14, 1)}`)],
        };
    }
    if (name === 'breakout') {
        const entry = resistance;
        const stop = Math.max(support || entry - stopBuffer, entry - stopBuffer);
        const target = entry + (entry - stop) * 2;
        return {
            title: 'Breakout', entry: round(entry), stop: round(stop), target: round(target), stretchTarget: round(entry + (entry - stop) * 3),
            checks: [check('Near range high', price >= entry - stopBuffer * 0.5, price >= entry - stopBuffer, `Resistance ${round(entry)}`), check('Volume confirmation', volumeRatio >= 1.2, volumeRatio >= 1, `Volume ${round(volumeRatio, 2)}x average`), check('Momentum healthy', rsi14 >= 50 && rsi14 <= 75, rsi14 >= 45 && rsi14 <= 80, `RSI ${round(rsi14, 1)}`)],
        };
    }
    const entry = support;
    const stop = entry - stopBuffer;
    const target = resistance || entry + (entry - stop) * 2;
    return {
        title: 'Range Reversal', entry: round(entry), stop: round(stop), target: round(target), stretchTarget: round(entry + (entry - stop) * 2),
        checks: [check('Near support', price <= entry + stopBuffer * 0.5, price <= entry + stopBuffer, `Support ${round(entry)}`), check('Momentum washed out', rsi14 <= 40, rsi14 <= 48, `RSI ${round(rsi14, 1)}`), check('Room to range high', target > price, target > entry, `Resistance ${round(resistance)}`)],
    };
}

export function calculateTradeAnalysis(rows, interval, mode, startDate = '', endDate = '') {
    const candles = normalizeTradeCandles(rows, startDate, endDate);
    const required = mode === 'day' ? 35 : 60;
    if (candles.length < required || (mode === 'day' && !isIntradayInterval(interval))) return { available: false, reason: mode === 'day' && !isIntradayInterval(interval) ? 'Day mode needs an intraday chart interval.' : `Need at least ${required} candles for this mode.`, candles };
    const price = candles.at(-1).close;
    const atr14 = atr(candles);
    const radius = mode === 'day' ? 2 : 4;
    const pivotSet = pivots(candles, radius);
    const tolerance = Math.max((atr14 || price * 0.02) * 0.65, price * 0.003);
    const supports = clusteredLevels(pivotSet.lows, 'support', tolerance);
    const resistances = clusteredLevels(pivotSet.highs, 'resistance', tolerance);
    const support = supports.filter((level) => level.price <= price).at(-1)?.price || Math.min(...candles.slice(-20).map((bar) => bar.low));
    const resistance = resistances.filter((level) => level.price >= price)[0]?.price || Math.max(...candles.slice(-20).map((bar) => bar.high));
    const volume20 = average(candles.slice(-20).map((bar) => bar.volume));
    const metrics = { price, ema20: ema(candles, 20), sma50: sma(candles, 50), sma200: sma(candles, 200), rsi14: rsi(candles), atr14, vwap: mode === 'day' ? vwap(candles) : null, volumeRatio: volume20 ? candles.at(-1).volume / volume20 : null, support, resistance, mode };
    const setups = ['pullback', 'breakout', 'reversal'].map((name) => {
        const setup = buildSetup(name, metrics);
        const risk = setup.entry - setup.stop;
        return { id: name, ...setup, rewardRisk: risk > 0 ? round((setup.target - setup.entry) / risk, 2) : null };
    });
    const lines = [trendline(pivotSet.lows, 'support', tolerance), trendline(pivotSet.highs, 'resistance', tolerance)].filter(Boolean);
    return {
        available: true, candles, metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, round(value, key === 'rsi14' || key === 'volumeRatio' ? 2 : 2)])),
        levels: { supports, resistances }, trendlines: lines, structures: structures(pivotSet.highs, pivotSet.lows, candles, tolerance), setups,
        asOf: new Date(candles.at(-1).time * 1000).toISOString(), interval, mode,
    };
}
