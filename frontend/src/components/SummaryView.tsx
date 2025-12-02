import { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';

interface SummaryViewProps {
    summary: string | null;
    isGenerating: boolean;
    error: string | null;
    onGenerate: () => void;
    hasTranscription: boolean;
    sessionDate?: string; // Для имени файла при скачивании
}

export default function SummaryView({
    summary,
    isGenerating,
    error,
    onGenerate,
    hasTranscription,
    sessionDate
}: SummaryViewProps) {
    const [copySuccess, setCopySuccess] = useState(false);
    const [showExportMenu, setShowExportMenu] = useState(false);

    // Копирование в буфер обмена
    const handleCopyToClipboard = useCallback(async () => {
        if (!summary) return;
        
        try {
            await navigator.clipboard.writeText(summary);
            setCopySuccess(true);
            setShowExportMenu(false);
            setTimeout(() => setCopySuccess(false), 2000);
        } catch (err) {
            console.error('Copy failed:', err);
        }
    }, [summary]);

    // Скачивание как файл
    const handleDownloadFile = useCallback(() => {
        if (!summary) return;
        
        const date = sessionDate ? new Date(sessionDate) : new Date();
        const dateStr = date.toISOString().slice(0, 10);
        const timeStr = date.toTimeString().slice(0, 5).replace(':', '-');
        const filename = `summary_${dateStr}_${timeStr}.md`;
        
        const blob = new Blob([summary], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        setShowExportMenu(false);
    }, [summary, sessionDate]);
    if (!hasTranscription) {
        return (
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '3rem',
                color: '#666'
            }}>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📋</div>
                <div>Нет транскрипции для создания summary</div>
            </div>
        );
    }

    if (isGenerating) {
        return (
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '3rem',
                color: '#888'
            }}>
                <div style={{ 
                    fontSize: '3rem', 
                    marginBottom: '1rem',
                    animation: 'pulse 1s infinite'
                }}>
                    🤖
                </div>
                <div style={{ marginBottom: '0.5rem' }}>Генерация summary...</div>
                <div style={{ fontSize: '0.8rem', color: '#666' }}>
                    Это может занять некоторое время
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                padding: '2rem'
            }}>
                <div style={{
                    padding: '1rem',
                    backgroundColor: 'rgba(244, 67, 54, 0.1)',
                    border: '1px solid rgba(244, 67, 54, 0.3)',
                    borderRadius: '8px',
                    color: '#f44336',
                    marginBottom: '1rem',
                    maxWidth: '500px',
                    textAlign: 'center'
                }}>
                    <div style={{ marginBottom: '0.5rem' }}>❌ Ошибка генерации</div>
                    <div style={{ fontSize: '0.85rem' }}>{error}</div>
                </div>
                <button
                    onClick={onGenerate}
                    style={{
                        padding: '0.6rem 1.5rem',
                        backgroundColor: '#6c5ce7',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontSize: '0.9rem'
                    }}
                >
                    🔄 Попробовать снова
                </button>
            </div>
        );
    }

    if (summary) {
        return (
            <div style={{
                padding: '1rem',
                backgroundColor: '#1a1a2e',
                borderRadius: '8px',
                lineHeight: '1.8'
            }}>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '1rem',
                    paddingBottom: '0.75rem',
                    borderBottom: '1px solid #333'
                }}>
                    <h4 style={{ margin: 0, color: '#888', fontSize: '0.9rem' }}>
                        📋 Summary
                    </h4>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        {/* Кнопка экспорта с выпадающим меню */}
                        <div style={{ position: 'relative' }}>
                            <button
                                onClick={() => setShowExportMenu(!showExportMenu)}
                                title="Экспорт summary"
                                style={{
                                    padding: '0.3rem 0.6rem',
                                    backgroundColor: copySuccess ? '#00b894' : '#6c5ce7',
                                    color: '#fff',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontSize: '0.75rem',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.3rem',
                                    transition: 'background-color 0.2s'
                                }}
                            >
                                {copySuccess ? '✓ Скопировано' : '📤 Экспорт'}
                            </button>
                            
                            {showExportMenu && (
                                <div style={{
                                    position: 'absolute',
                                    top: '100%',
                                    right: 0,
                                    marginTop: '0.3rem',
                                    backgroundColor: '#1a1a2e',
                                    border: '1px solid #333',
                                    borderRadius: '6px',
                                    overflow: 'hidden',
                                    zIndex: 100,
                                    minWidth: '160px',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
                                }}>
                                    <button
                                        onClick={handleCopyToClipboard}
                                        style={{
                                            width: '100%',
                                            padding: '0.6rem 1rem',
                                            backgroundColor: 'transparent',
                                            border: 'none',
                                            color: '#fff',
                                            cursor: 'pointer',
                                            textAlign: 'left',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.5rem',
                                            fontSize: '0.85rem'
                                        }}
                                        onMouseEnter={e => e.currentTarget.style.backgroundColor = '#2a2a4e'}
                                        onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                                    >
                                        📋 Копировать
                                    </button>
                                    <button
                                        onClick={handleDownloadFile}
                                        style={{
                                            width: '100%',
                                            padding: '0.6rem 1rem',
                                            backgroundColor: 'transparent',
                                            border: 'none',
                                            borderTop: '1px solid #333',
                                            color: '#fff',
                                            cursor: 'pointer',
                                            textAlign: 'left',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.5rem',
                                            fontSize: '0.85rem'
                                        }}
                                        onMouseEnter={e => e.currentTarget.style.backgroundColor = '#2a2a4e'}
                                        onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                                    >
                                        💾 Скачать .md
                                    </button>
                                </div>
                            )}
                        </div>
                        
                        <button
                            onClick={onGenerate}
                            title="Перегенерировать summary"
                            style={{
                                padding: '0.3rem 0.6rem',
                                backgroundColor: '#333',
                                color: '#888',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '0.75rem'
                            }}
                        >
                            🔄 Обновить
                        </button>
                    </div>
                </div>
                <div className="markdown-content" style={{
                    color: '#ddd',
                    fontSize: '0.95rem'
                }}>
                    <ReactMarkdown
                        components={{
                            h2: ({children}) => (
                                <h2 style={{ 
                                    color: '#fff', 
                                    fontSize: '1.1rem', 
                                    marginTop: '1.2rem', 
                                    marginBottom: '0.6rem',
                                    borderBottom: '1px solid #333',
                                    paddingBottom: '0.4rem'
                                }}>
                                    {children}
                                </h2>
                            ),
                            h3: ({children}) => (
                                <h3 style={{ 
                                    color: '#ccc', 
                                    fontSize: '1rem', 
                                    marginTop: '1rem', 
                                    marginBottom: '0.5rem' 
                                }}>
                                    {children}
                                </h3>
                            ),
                            ul: ({children}) => (
                                <ul style={{ 
                                    margin: '0.5rem 0', 
                                    paddingLeft: '1.5rem',
                                    listStyleType: 'disc'
                                }}>
                                    {children}
                                </ul>
                            ),
                            li: ({children}) => (
                                <li style={{ 
                                    marginBottom: '0.4rem',
                                    color: '#bbb'
                                }}>
                                    {children}
                                </li>
                            ),
                            p: ({children}) => (
                                <p style={{ 
                                    margin: '0.5rem 0',
                                    color: '#ccc'
                                }}>
                                    {children}
                                </p>
                            ),
                            strong: ({children}) => (
                                <strong style={{ color: '#fff' }}>
                                    {children}
                                </strong>
                            ),
                            em: ({children}) => (
                                <em style={{ color: '#aaa' }}>
                                    {children}
                                </em>
                            )
                        }}
                    >
                        {summary}
                    </ReactMarkdown>
                </div>
            </div>
        );
    }

    // Нет summary - показываем кнопку генерации
    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '3rem'
        }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📋</div>
            <div style={{ color: '#888', marginBottom: '1.5rem', textAlign: 'center' }}>
                <div style={{ marginBottom: '0.5rem' }}>Summary ещё не создан</div>
                <div style={{ fontSize: '0.85rem', color: '#666' }}>
                    Нажмите кнопку чтобы сгенерировать краткое содержание записи
                </div>
            </div>
            <button
                onClick={onGenerate}
                style={{
                    padding: '0.8rem 2rem',
                    backgroundColor: '#6c5ce7',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    fontSize: '1rem',
                    fontWeight: 'bold',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    boxShadow: '0 4px 12px rgba(108, 92, 231, 0.3)'
                }}
            >
                <span>🤖</span>
                <span>Создать Summary</span>
            </button>
            <div style={{ 
                marginTop: '1rem', 
                fontSize: '0.75rem', 
                color: '#555',
                textAlign: 'center'
            }}>
                Используется модель GPT-OSS для анализа текста
            </div>
        </div>
    );
}
