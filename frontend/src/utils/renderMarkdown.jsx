import React from 'react';

const renderMarkdown = (text) => {
    if (text === null || text === undefined) return null;
    if (typeof text !== 'string') text = String(text);
    if (!text.trim()) return null;
    const lines = text.split('\n');
    const elements = [];
    let i = 0;

    const inlineFormat = (str, key) => {
        if (str === null || str === undefined) return null;
        if (typeof str !== 'string') str = String(str);
        const parts = [];
        const re = /(\[([^\]]+)\]\(([^)]+)\)|\\text\{([^}]+)\}|\\frac\{([^}]+)\}\{([^}]+)\}|\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|~~(.+?)~~|\*([^*]+)\*|_([^_]+)_)/g;
        let last = 0, m;
        while ((m = re.exec(str)) !== null) {
            if (m.index > last) parts.push(str.slice(last, m.index));
            if (m[1] && m[2] && m[3]) {
                parts.push(
                    <a key={m.index} href={m[3]} target="_blank" rel="noopener noreferrer"
                       style={{ color: 'var(--brand-blue)', textDecoration: 'underline', cursor: 'pointer' }}>
                        {m[2]}
                    </a>
                );
            } else if (m[4]) {
                parts.push(
                    <span key={m.index} style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
                        fontSize: '0.9em'
                    }}>
                        {m[4]}
                    </span>
                );
            } else if (m[5] && m[6]) {
                parts.push(
                    <span key={m.index} style={{
                        display: 'inline-flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        fontSize: '0.85em',
                        verticalAlign: 'middle',
                        margin: '0 0.2em'
                    }}>
                        <span style={{ borderBottom: '1px solid currentColor', paddingBottom: '1px' }}>{m[5]}</span>
                        <span style={{ paddingTop: '1px' }}>{m[6]}</span>
                    </span>
                );
            } else if (m[7] || m[8]) {
                parts.push(<strong key={m.index} style={{ fontWeight: 700 }}>{m[7] || m[8]}</strong>);
            } else if (m[9]) {
                parts.push(
                    <code key={m.index} style={{
                        background: 'rgba(255,255,255,0.12)',
                        borderRadius: '4px',
                        padding: '2px 6px',
                        fontSize: '0.88em',
                        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
                        color: 'rgba(255,255,255,0.95)',
                        border: '1px solid rgba(255,255,255,0.08)'
                    }}>
                        {m[9]}
                    </code>
                );
            } else if (m[10]) {
                parts.push(<del key={m.index} style={{ opacity: 0.6 }}>{m[10]}</del>);
            } else if (m[11] || m[12]) {
                parts.push(<em key={m.index} style={{ fontStyle: 'italic' }}>{m[11] || m[12]}</em>);
            }
            last = m.index + m[0].length;
        }
        if (last < str.length) parts.push(str.slice(last));
        return <span key={key}>{parts}</span>;
    };

    while (i < lines.length) {
        const line = lines[i];

        if (line.trim().startsWith('\\[')) {
            const mathLines = [line.replace('\\[', '').trim()];
            i++;
            while (i < lines.length && !lines[i].includes('\\]')) {
                mathLines.push(lines[i]);
                i++;
            }
            if (i < lines.length) {
                mathLines.push(lines[i].replace('\\]', '').trim());
            }
            elements.push(
                <div key={i} style={{
                    background: 'rgba(59,130,246,0.08)',
                    borderRadius: '8px',
                    padding: '0.75rem 1rem',
                    margin: '0.6rem 0',
                    border: '1px solid rgba(59,130,246,0.2)',
                    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
                    fontSize: '0.9rem',
                    textAlign: 'center',
                    color: 'rgba(255,255,255,0.95)'
                }}>
                    {mathLines.join(' ')}
                </div>
            );
            i++;
            continue;
        }

        if (line.startsWith('```')) {
            const lang = line.slice(3).trim();
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
            elements.push(
                <pre key={i} style={{
                    background: 'rgba(0,0,0,0.4)',
                    borderRadius: '8px',
                    padding: '0.75rem 1rem',
                    overflowX: 'auto',
                    fontSize: '0.85rem',
                    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
                    margin: '0.6rem 0',
                    border: '1px solid rgba(255,255,255,0.08)',
                    lineHeight: 1.5
                }}>
                    {lang && (
                        <div style={{
                            fontSize: '0.7rem',
                            opacity: 0.5,
                            marginBottom: '6px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                            fontWeight: 600
                        }}>
                            {lang}
                        </div>
                    )}
                    <code style={{ color: 'rgba(255,255,255,0.9)' }}>{codeLines.join('\n')}</code>
                </pre>
            );
            i++;
            continue;
        }

        if (line.startsWith('> ')) {
            const quoteLines = [];
            while (i < lines.length && lines[i].startsWith('> ')) {
                quoteLines.push(lines[i].slice(2));
                i++;
            }
            elements.push(
                <div key={i} style={{
                    borderLeft: '3px solid var(--brand-blue)',
                    paddingLeft: '0.85rem',
                    marginLeft: '0.25rem',
                    opacity: 0.85,
                    fontStyle: 'italic',
                    margin: '0.5rem 0'
                }}>
                    {quoteLines.map((q, idx) => (
                        <div key={idx} style={{ lineHeight: 1.6 }}>{inlineFormat(q, `${i}-${idx}`)}</div>
                    ))}
                </div>
            );
            continue;
        }

        if (line.includes('|') && lines[i + 1]?.match(/^\|?[\s:-]+\|/)) {
            const tableLines = [line];
            i++;
            tableLines.push(lines[i]);
            i++;
            while (i < lines.length && lines[i].includes('|')) {
                tableLines.push(lines[i]);
                i++;
            }

            const rows = tableLines.map(l =>
                l.split('|').map(cell => cell.trim()).filter(cell => cell)
            );

            if (rows.length >= 2) {
                elements.push(
                    <div key={i} style={{ overflowX: 'auto', margin: '0.6rem 0' }}>
                        <table style={{
                            width: '100%',
                            borderCollapse: 'collapse',
                            fontSize: '0.85rem',
                            background: 'rgba(0,0,0,0.2)',
                            borderRadius: '6px',
                            overflow: 'hidden'
                        }}>
                            <thead>
                                <tr style={{ background: 'rgba(255,255,255,0.05)' }}>
                                    {rows[0].map((cell, idx) => (
                                        <th key={idx} style={{
                                            padding: '0.5rem 0.75rem',
                                            textAlign: 'left',
                                            fontWeight: 700,
                                            borderBottom: '2px solid rgba(255,255,255,0.1)'
                                        }}>
                                            {inlineFormat(cell, `th-${idx}`)}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.slice(2).map((row, rowIdx) => (
                                    <tr key={rowIdx} style={{
                                        borderBottom: rowIdx < rows.length - 3 ? '1px solid rgba(255,255,255,0.05)' : 'none'
                                    }}>
                                        {row.map((cell, cellIdx) => (
                                            <td key={cellIdx} style={{
                                                padding: '0.5rem 0.75rem',
                                                lineHeight: 1.5
                                            }}>
                                                {inlineFormat(cell, `td-${rowIdx}-${cellIdx}`)}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                );
            }
            continue;
        }

        const hMatch = line.match(/^(#{1,6})\s+(.+)/);
        if (hMatch) {
            const level = hMatch[1].length;
            const sizes = ['1.25rem', '1.1rem', '1rem', '0.95rem', '0.9rem', '0.85rem'];
            const weights = [800, 700, 700, 600, 600, 600];
            const margins = ['0.8rem 0 0.4rem', '0.7rem 0 0.35rem', '0.6rem 0 0.3rem', '0.5rem 0 0.25rem', '0.4rem 0 0.2rem', '0.3rem 0 0.15rem'];
            elements.push(
                <div key={i} style={{
                    fontWeight: weights[level - 1],
                    fontSize: sizes[level - 1],
                    margin: margins[level - 1],
                    color: 'rgba(255,255,255,0.95)',
                    letterSpacing: level <= 2 ? '0.01em' : '0'
                }}>
                    {inlineFormat(hMatch[2], i)}
                </div>
            );
            i++;
            continue;
        }

        if (/^[-*_]{3,}$/.test(line.trim())) {
            elements.push(
                <hr key={i} style={{
                    border: 'none',
                    borderTop: '2px solid rgba(255,255,255,0.12)',
                    margin: '0.75rem 0',
                    borderRadius: '1px'
                }} />
            );
            i++;
            continue;
        }

        if (/^[\-\*]\s/.test(line)) {
            const items = [];
            while (i < lines.length && /^[\-\*]\s/.test(lines[i])) {
                items.push(
                    <li key={i} style={{
                        marginBottom: '0.3rem',
                        lineHeight: 1.6,
                        paddingLeft: '0.25rem'
                    }}>
                        {inlineFormat(lines[i].replace(/^[\-\*]\s/, ''), i)}
                    </li>
                );
                i++;
            }
            elements.push(
                <ul key={`ul-${i}`} style={{
                    paddingLeft: '1.5rem',
                    margin: '0.5rem 0',
                    listStyle: 'disc',
                    listStylePosition: 'outside'
                }}>
                    {items}
                </ul>
            );
            continue;
        }

        if (/^\d+\.\s/.test(line)) {
            const items = [];
            while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
                items.push(
                    <li key={i} style={{
                        marginBottom: '0.3rem',
                        lineHeight: 1.6,
                        paddingLeft: '0.25rem'
                    }}>
                        {inlineFormat(lines[i].replace(/^\d+\.\s/, ''), i)}
                    </li>
                );
                i++;
            }
            elements.push(
                <ol key={`ol-${i}`} style={{
                    paddingLeft: '1.5rem',
                    margin: '0.5rem 0',
                    listStylePosition: 'outside'
                }}>
                    {items}
                </ol>
            );
            continue;
        }

        if (line.trim() === '') {
            elements.push(<div key={i} style={{ height: '0.5rem' }} />);
            i++;
            continue;
        }

        elements.push(
            <div key={i} style={{
                lineHeight: 1.65,
                marginBottom: '0.25rem',
                color: 'rgba(255,255,255,0.9)'
            }}>
                {inlineFormat(line, i)}
            </div>
        );
        i++;
    }
    return elements;
};

export default renderMarkdown;
