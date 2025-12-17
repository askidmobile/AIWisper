import React, { useState } from 'react';

interface ConsoleFooterProps {
    logs: string[];
}

export const ConsoleFooter: React.FC<ConsoleFooterProps> = ({ logs }) => {
    const [expanded, setExpanded] = useState(false);

    return (
        <footer style={{
            height: expanded ? '150px' : '32px',
            borderTop: '1px solid #333',
            backgroundColor: '#0a0a14',
            transition: 'height 0.2s ease-out',
            overflow: 'hidden'
        }}>
            <div
                onClick={() => setExpanded(!expanded)}
                style={{
                    padding: '0.3rem 1rem',
                    backgroundColor: '#12121f',
                    fontSize: '0.75rem',
                    color: '#666',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    userSelect: 'none'
                }}
            >
                <span>
                    {expanded ? '▼' : '▶'} Console
                    {!expanded && logs.length > 0 && (
                        <span style={{ marginLeft: '0.5rem', color: '#444' }}>
                            — {logs[0]?.substring(0, 50)}{logs[0]?.length > 50 ? '...' : ''}
                        </span>
                    )}
                </span>
                <span style={{ fontSize: '0.65rem', color: '#444' }}>{logs.length} записей</span>
            </div>
            {expanded && (
                <div style={{ padding: '0.5rem 1rem', overflowY: 'auto', height: 'calc(100% - 28px)', fontSize: '0.7rem', fontFamily: 'monospace' }}>
                    {logs.map((log, i) => <div key={i} style={{ color: '#555' }}>{log}</div>)}
                </div>
            )}
        </footer>
    );
};
