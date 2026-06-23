import React from 'react';

const titleize = (value) => String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());

export const normalizeReadableContent = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.replace(/\\n/g, '\n');
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        return value.map(item => normalizeReadableContent(item)).filter(Boolean).join('\n');
    }
    if (typeof value === 'object') {
        return Object.entries(value)
            .map(([key, nestedValue]) => {
                const content = normalizeReadableContent(nestedValue);
                if (!content) return '';
                return content.includes('\n')
                    ? `**${titleize(key)}**\n${content}`
                    : `**${titleize(key)}:** ${content}`;
            })
            .filter(Boolean)
            .join('\n\n');
    }
    return String(value);
};

const renderInline = (text) => {
    const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((part, index) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) {
            return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        if (/^`[^`]+`$/.test(part)) {
            return (
                <code key={index} style={{ padding: '0.05rem 0.25rem', borderRadius: '4px', background: 'rgba(148,163,184,0.14)', color: '#cbd5e1' }}>
                    {part.slice(1, -1)}
                </code>
            );
        }
        return part;
    });
};

const parseTableRows = (rows) => rows
    .map(row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()))
    .filter(cells => cells.some(Boolean));

const isTableSeparator = (row) => {
    const clean = row.replace(/[|\s:-]/g, '');
    return clean.length === 0 && row.includes('-');
};

export const renderReadableMarkdown = (value, emptyText = '') => {
    const text = normalizeReadableContent(value).trim();
    if (!text) return <span style={{ opacity: 0.65 }}>{emptyText}</span>;

    const lines = text.split('\n');
    const blocks = [];
    let codeBuffer = [];
    let inCode = false;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
            if (inCode) {
                blocks.push({ type: 'code', content: codeBuffer.join('\n'), key: `code-${index}` });
                codeBuffer = [];
            }
            inCode = !inCode;
            continue;
        }

        if (inCode) {
            codeBuffer.push(line);
            continue;
        }

        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
            const tableLines = [];
            while (index < lines.length && lines[index].trim().startsWith('|') && lines[index].trim().endsWith('|')) {
                tableLines.push(lines[index]);
                index += 1;
            }
            index -= 1;
            blocks.push({ type: 'table', rows: parseTableRows(tableLines), key: `table-${index}` });
            continue;
        }

        if (!trimmed) {
            blocks.push({ type: 'space', key: `space-${index}` });
        } else if (/^-{3,}$/.test(trimmed)) {
            blocks.push({ type: 'rule', key: `rule-${index}` });
        } else if (/^#{1,4}\s+/.test(trimmed)) {
            blocks.push({ type: 'heading', content: trimmed.replace(/^#{1,4}\s+/, ''), key: `heading-${index}` });
        } else if (/^\*\*[^*]+\*\*:?\s*$/.test(trimmed)) {
            blocks.push({ type: 'heading', content: trimmed.replace(/^\*\*/, '').replace(/\*\*:?\s*$/, ''), key: `bold-heading-${index}` });
        } else if (/^\s*(?:[-*]|•)\s+/.test(line)) {
            blocks.push({ type: 'bullet', content: line.replace(/^\s*(?:[-*]|•)\s+/, ''), key: `bullet-${index}` });
        } else if (/^\s*\d+[.)]\s+/.test(line)) {
            const match = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
            blocks.push({ type: 'numbered', number: match?.[1] || '', content: match?.[2] || trimmed, key: `numbered-${index}` });
        } else {
            blocks.push({ type: 'text', content: line, key: `text-${index}` });
        }
    }

    if (codeBuffer.length) blocks.push({ type: 'code', content: codeBuffer.join('\n'), key: 'code-final' });

    return blocks.map(block => {
        if (block.type === 'code') {
            return <pre key={block.key} style={{ margin: '0.65rem 0', padding: '0.75rem', borderRadius: '8px', background: 'rgba(15,23,42,0.85)', color: '#cbd5e1', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{block.content}</pre>;
        }
        if (block.type === 'table') {
            const rows = block.rows.filter(row => !isTableSeparator(row.join('|')));
            const [header = [], ...bodyRows] = rows;
            return (
                <div key={block.key} style={{ overflowX: 'auto', margin: '0.65rem 0' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                        <thead>
                            <tr>
                                {header.map((cell, index) => (
                                    <th key={index} style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid rgba(148,163,184,0.28)', color: '#cbd5e1' }}>{renderInline(cell)}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {bodyRows.map((row, rowIndex) => (
                                <tr key={rowIndex}>
                                    {row.map((cell, cellIndex) => (
                                        <td key={cellIndex} style={{ padding: '0.5rem', borderBottom: '1px solid rgba(148,163,184,0.12)', verticalAlign: 'top' }}>{renderInline(cell)}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
        }
        if (block.type === 'heading') return <div key={block.key} style={{ margin: '0.8rem 0 0.35rem', fontWeight: 800, color: '#e2e8f0' }}>{renderInline(block.content)}</div>;
        if (block.type === 'bullet') return <div key={block.key} style={{ margin: '0.28rem 0', paddingLeft: '1rem' }}>• {renderInline(block.content)}</div>;
        if (block.type === 'numbered') return <div key={block.key} style={{ margin: '0.28rem 0', paddingLeft: '1rem' }}>{block.number}. {renderInline(block.content)}</div>;
        if (block.type === 'rule') return <div key={block.key} style={{ height: '1px', background: 'rgba(148,163,184,0.18)', margin: '0.8rem 0' }} />;
        if (block.type === 'space') return <div key={block.key} style={{ height: '0.45rem' }} />;
        return <div key={block.key} style={{ margin: '0.28rem 0' }}>{renderInline(block.content)}</div>;
    });
};
