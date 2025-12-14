import { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';

interface SummaryViewProps {
    summary: string | null;
    isGenerating: boolean;
    error: string | null;
    onGenerate: () => void;
    hasTranscription: boolean;
    sessionDate?: string; // Для имени файла при скачивании
    ollamaModel?: string; // Модель для отображения
}

export default function SummaryView({
    summary,
    isGenerating,
    error,
    onGenerate,
    hasTranscription,
    sessionDate,
    ollamaModel = 'GPT-OSS'
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
                backgroundColor: 'var(--surface)',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--glass-border)',
                lineHeight: '1.8',
                width: '100%',
                maxWidth: '100%',
                overflow: 'hidden',
                overflowX: 'hidden',
                wordWrap: 'break-word',
                overflowWrap: 'break-word',
                boxSizing: 'border-box'
            }}>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '1rem',
                    paddingBottom: '0.75rem',
                    borderBottom: '1px solid var(--glass-border)'
                }}>
                    <h4 style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                            <polyline points="10 9 9 9 8 9"/>
                        </svg>
                        Summary
                    </h4>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        {/* Кнопка экспорта с выпадающим меню */}
                        <div style={{ position: 'relative' }}>
                            <button
                                onClick={() => setShowExportMenu(!showExportMenu)}
                                title="Экспорт summary"
                                style={{
                                    padding: '0.3rem 0.6rem',
                                    backgroundColor: copySuccess ? 'var(--success)' : 'var(--primary)',
                                    color: '#fff',
                                    border: 'none',
                                    borderRadius: 'var(--radius-sm)',
                                    cursor: 'pointer',
                                    fontSize: '0.75rem',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.3rem',
                                    transition: 'background-color 0.2s'
                                }}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                    <polyline points="17 8 12 3 7 8"/>
                                    <line x1="12" y1="3" x2="12" y2="15"/>
                                </svg>
                                {copySuccess ? 'Скопировано' : 'Экспорт'}
                            </button>
                            
                            {showExportMenu && (
                                <div style={{
                                    position: 'absolute',
                                    top: '100%',
                                    right: 0,
                                    marginTop: '0.3rem',
                                    backgroundColor: 'var(--surface-elevated)',
                                    border: '1px solid var(--glass-border)',
                                    borderRadius: 'var(--radius-md)',
                                    overflow: 'hidden',
                                    zIndex: 100,
                                    minWidth: '160px',
                                    boxShadow: 'var(--shadow-lg)'
                                }}>
                                    <button
                                        onClick={handleCopyToClipboard}
                                        style={{
                                            width: '100%',
                                            padding: '0.6rem 1rem',
                                            backgroundColor: 'transparent',
                                            border: 'none',
                                            color: 'var(--text-primary)',
                                            cursor: 'pointer',
                                            textAlign: 'left',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.5rem',
                                            fontSize: '0.85rem'
                                        }}
                                        onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--glass-bg)'}
                                        onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                        </svg>
                                        Копировать
                                    </button>
                                    <button
                                        onClick={handleDownloadFile}
                                        style={{
                                            width: '100%',
                                            padding: '0.6rem 1rem',
                                            backgroundColor: 'transparent',
                                            border: 'none',
                                            borderTop: '1px solid var(--glass-border)',
                                            color: 'var(--text-primary)',
                                            cursor: 'pointer',
                                            textAlign: 'left',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.5rem',
                                            fontSize: '0.85rem'
                                        }}
                                        onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--glass-bg)'}
                                        onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                            <polyline points="7 10 12 15 17 10"/>
                                            <line x1="12" y1="15" x2="12" y2="3"/>
                                        </svg>
                                        Скачать .md
                                    </button>
                                </div>
                            )}
                        </div>
                        
                        <button
                            onClick={onGenerate}
                            title="Перегенерировать summary"
                            style={{
                                padding: '0.3rem 0.6rem',
                                backgroundColor: 'var(--surface-strong)',
                                color: 'var(--text-muted)',
                                border: '1px solid var(--glass-border)',
                                borderRadius: 'var(--radius-sm)',
                                cursor: 'pointer',
                                fontSize: '0.75rem',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.3rem'
                            }}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M23 4v6h-6"/>
                                <path d="M1 20v-6h6"/>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                            </svg>
                            Обновить
                        </button>
                    </div>
                </div>
                <div className="markdown-content" style={{
                    color: 'var(--text-secondary)',
                    fontSize: '0.95rem',
                    overflow: 'hidden',
                    overflowWrap: 'break-word',
                    wordBreak: 'break-word'
                }}>
                    <ReactMarkdown
                        components={{
                            h2: ({children}) => (
                                <h2 style={{ 
                                    color: 'var(--text-primary)', 
                                    fontSize: '1.1rem', 
                                    marginTop: '1.2rem', 
                                    marginBottom: '0.6rem',
                                    borderBottom: '1px solid var(--glass-border)',
                                    paddingBottom: '0.4rem'
                                }}>
                                    {children}
                                </h2>
                            ),
                            h3: ({children}) => (
                                <h3 style={{ 
                                    color: 'var(--text-secondary)', 
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
                                    color: 'var(--text-secondary)',
                                    overflowWrap: 'break-word',
                                    wordBreak: 'break-word'
                                }}>
                                    {children}
                                </li>
                            ),
                            p: ({children}) => (
                                <p style={{ 
                                    margin: '0.5rem 0',
                                    color: 'var(--text-secondary)',
                                    overflowWrap: 'break-word',
                                    wordBreak: 'break-word'
                                }}>
                                    {children}
                                </p>
                            ),
                            strong: ({children}) => (
                                <strong style={{ color: 'var(--text-primary)' }}>
                                    {children}
                                </strong>
                            ),
                            em: ({children}) => (
                                <em style={{ color: 'var(--text-muted)' }}>
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

    // Нет summary - показываем кнопку генерации в стиле Welcome Screen
    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
            maxWidth: '600px',
            margin: '0 auto',
            height: '100%'
        }}>
            <h1 style={{ 
                fontSize: '1.5rem', 
                fontWeight: 'var(--font-weight-bold)',
                color: 'var(--text-primary)',
                marginBottom: '0.5rem',
                marginTop: '1rem',
                textAlign: 'center'
            }}>
                Summary ещё не создан
            </h1>
            
            <p style={{ 
                fontSize: '0.95rem', 
                color: 'var(--text-secondary)',
                marginBottom: '2rem',
                textAlign: 'center'
            }}>
                Нажмите кнопку чтобы сгенерировать краткое содержание записи
            </p>

            <button
                onClick={onGenerate}
                style={{
                    padding: '0.8rem 2rem',
                    backgroundColor: 'var(--primary)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 'var(--radius-lg)',
                    cursor: 'pointer',
                    fontSize: '1rem',
                    fontWeight: 'var(--font-weight-semibold)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    boxShadow: 'var(--shadow-glow-primary)',
                    transition: 'all 0.2s ease',
                    marginBottom: '1.5rem'
                }}
                onMouseEnter={e => {
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 8px 24px rgba(139, 92, 246, 0.4)';
                }}
                onMouseLeave={e => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'var(--shadow-glow-primary)';
                }}
            >
                <span>🤖</span>
                <span>Создать Summary</span>
            </button>

            {/* Info Card */}
            <div style={{ 
                width: '100%',
                background: 'var(--glass-bg)',
                backdropFilter: 'blur(var(--glass-blur-light))',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--glass-border)',
                padding: '1.25rem',
            }}>
                <h3 style={{ 
                    fontSize: '0.85rem', 
                    fontWeight: 'var(--font-weight-semibold)',
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    marginBottom: '1rem'
                }}>
                    Информация
                </h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                        <div style={{ 
                            width: '28px', 
                            height: '28px', 
                            borderRadius: '50%',
                            background: 'var(--glass-bg-elevated)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                            fontSize: '0.85rem',
                        }}>🤖</div>
                        <div>
                            <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 'var(--font-weight-medium)' }}>
                                Модель: {ollamaModel || 'GPT-OSS'}
                            </div>
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '2px' }}>
                                Используется для анализа текста
                            </div>
                        </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                        <div style={{ 
                            width: '28px', 
                            height: '28px', 
                            borderRadius: '50%',
                            background: 'var(--glass-bg-elevated)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                            fontSize: '0.85rem',
                        }}>⚡</div>
                        <div>
                            <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 'var(--font-weight-medium)' }}>
                                Структурированный анализ
                            </div>
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '2px' }}>
                                Тема, ключевые моменты, решения, следующие шаги
                            </div>
                        </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                        <div style={{ 
                            width: '28px', 
                            height: '28px', 
                            borderRadius: '50%',
                            background: 'var(--glass-bg-elevated)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                            fontSize: '0.85rem',
                        }}>📤</div>
                        <div>
                            <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 'var(--font-weight-medium)' }}>
                                Экспорт в Markdown
                            </div>
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '2px' }}>
                                Копирование или скачивание файла
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
