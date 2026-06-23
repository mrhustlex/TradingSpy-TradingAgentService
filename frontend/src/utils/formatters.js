const EXCHANGE_SUFFIXES = [
    '.hk', '.l', '.to', '.ax', '.de', '.pa', '.mi', '.mc',
    '.st', '.co', '.ol', '.he', '.ss', '.sz', '.t', '.ks', '.tw', '.ns', '.bo'
];

export const cleanTicker = (ticker) => {
    const lower = ticker.toLowerCase();
    for (const suffix of EXCHANGE_SUFFIXES) {
        if (lower.endsWith(suffix)) {
            return ticker.slice(0, -suffix.length);
        }
    }
    return ticker;
};

export const formatDatasetName = (filename) => {
    if (!filename) return 'Select Dataset';

    // Pattern: ticker-interval-range.txt or .csv
    // e.g. tsla-1d-max.txt -> TSLA (1d, Max)

    const clean = filename.split('.')[0];
    const parts = clean.split('-');

    if (parts.length >= 2) {
        const ticker = cleanTicker(parts[0].toUpperCase());
        const interval = parts[1];
        const range = parts.length > 2 ? parts[2].charAt(0).toUpperCase() + parts[2].slice(1) : '';

        return `${ticker} [${interval}] ${range ? `(${range})` : ''}`;
    }

    return filename;
};
