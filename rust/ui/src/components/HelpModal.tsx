import React, { useState } from 'react';

type HelpTab = 'guide' | 'shortcuts' | 'about';

interface HelpModalProps {
    isOpen: boolean;
    onClose: () => void;
    initialTab?: HelpTab;
    appVersion?: string;
}

const SHORTCUTS = [
    { category: 'Запись', items: [
        { keys: ['⌘', 'N'], description: 'Начать новую запись' },
        { keys: ['⌘', '.'], description: 'Остановить запись' },
        { keys: ['Space'], description: 'Воспроизвести/Пауза (когда не в поле ввода)' },
    ]},
    { category: 'Файлы', items: [
        { keys: ['⌘', 'O'], description: 'Импорт аудиофайла' },
        { keys: ['⌘', 'E'], description: 'Экспорт транскрипции' },
        { keys: ['⌘', '⇧', 'O'], description: 'Открыть папку с записями' },
        { keys: ['⌘', '⇧', 'C'], description: 'Копировать транскрипцию' },
    ]},
    { category: 'Сессия', items: [
        { keys: ['⌘', 'R'], description: 'Перетранскрибировать сессию' },
        { keys: ['⌘', 'S'], description: 'Создать AI-сводку' },
        { keys: ['⌘', '⌫'], description: 'Удалить сессию' },
    ]},
    { category: 'Приложение', items: [
        { keys: ['⌘', ','], description: 'Открыть настройки' },
        { keys: ['F1'], description: 'Справка' },
        { keys: ['⌘', '/'], description: 'Горячие клавиши' },
        { keys: ['⌘', 'Q'], description: 'Выход из приложения' },
    ]},
    { category: 'Навигация', items: [
        { keys: ['⌘', '+'], description: 'Увеличить масштаб' },
        { keys: ['⌘', '-'], description: 'Уменьшить масштаб' },
        { keys: ['⌘', '0'], description: 'Сбросить масштаб' },
        { keys: ['⌘', 'F'], description: 'Полноэкранный режим' },
    ]},
];

export const HelpModal: React.FC<HelpModalProps> = ({
    isOpen,
    onClose,
    initialTab = 'guide',
    appVersion = '2.0.2',
}) => {
    const [activeTab, setActiveTab] = useState<HelpTab>(initialTab);

    if (!isOpen) return null;

    const tabStyle = (tab: HelpTab): React.CSSProperties => ({
        padding: '0.6rem 1.2rem',
        background: activeTab === tab ? 'var(--primary)' : 'transparent',
        color: activeTab === tab ? 'white' : 'var(--text-secondary)',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        fontSize: '0.9rem',
        fontWeight: 500,
        transition: 'all 0.2s ease',
    });

    const renderGuide = () => (
        <div style={{ lineHeight: 1.7 }}>
            <section style={{ marginBottom: '2rem' }}>
                <h3 style={{ 
                    fontSize: '1.1rem', 
                    fontWeight: 600, 
                    marginBottom: '1rem',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                }}>
                    <span style={{ fontSize: '1.3rem' }}>🎙️</span>
                    Быстрый старт
                </h3>
                <ol style={{ 
                    paddingLeft: '1.5rem', 
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem',
                }}>
                    <li><strong>Начните запись</strong> — нажмите большую красную кнопку или <kbd>⌘N</kbd></li>
                    <li><strong>Говорите</strong> — AIWisper автоматически распознаёт речь в реальном времени</li>
                    <li><strong>Остановите запись</strong> — нажмите кнопку снова или <kbd>⌘.</kbd></li>
                    <li><strong>Просмотрите результат</strong> — транскрипция появится в правой панели</li>
                </ol>
            </section>

            <section style={{ marginBottom: '2rem' }}>
                <h3 style={{ 
                    fontSize: '1.1rem', 
                    fontWeight: 600, 
                    marginBottom: '1rem',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                }}>
                    <span style={{ fontSize: '1.3rem' }}>🎧</span>
                    Режимы записи
                </h3>
                <div style={{ 
                    display: 'grid', 
                    gap: '1rem',
                    color: 'var(--text-secondary)',
                }}>
                    <div style={{
                        padding: '1rem',
                        background: 'var(--glass-bg)',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--glass-border)',
                    }}>
                        <strong style={{ color: 'var(--text-primary)' }}>Микрофон + Системный звук</strong>
                        <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem' }}>
                            Записывает вашу речь и звук из приложений (Zoom, Meet, Teams). 
                            Идеально для записи онлайн-встреч с автоматическим разделением спикеров.
                        </p>
                    </div>
                    <div style={{
                        padding: '1rem',
                        background: 'var(--glass-bg)',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--glass-border)',
                    }}>
                        <strong style={{ color: 'var(--text-primary)' }}>Только микрофон</strong>
                        <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem' }}>
                            Записывает только вашу речь. Подходит для диктовки заметок, 
                            голосовых сообщений или записи в тихом помещении.
                        </p>
                    </div>
                </div>
            </section>

            <section style={{ marginBottom: '2rem' }}>
                <h3 style={{ 
                    fontSize: '1.1rem', 
                    fontWeight: 600, 
                    marginBottom: '1rem',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                }}>
                    <span style={{ fontSize: '1.3rem' }}>🤖</span>
                    AI-функции
                </h3>
                <div style={{ 
                    display: 'grid', 
                    gap: '0.75rem',
                    color: 'var(--text-secondary)',
                }}>
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                        <span style={{ 
                            background: 'var(--primary)', 
                            color: 'white', 
                            padding: '0.2rem 0.5rem', 
                            borderRadius: 'var(--radius-sm)',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                        }}>Сводка</span>
                        <span>Автоматическое создание краткого содержания записи с ключевыми моментами</span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                        <span style={{ 
                            background: 'var(--success)', 
                            color: 'white', 
                            padding: '0.2rem 0.5rem', 
                            borderRadius: 'var(--radius-sm)',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                        }}>Диаризация</span>
                        <span>Автоматическое определение говорящих (кто что сказал)</span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                        <span style={{ 
                            background: 'var(--warning)', 
                            color: 'white', 
                            padding: '0.2rem 0.5rem', 
                            borderRadius: 'var(--radius-sm)',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                        }}>Улучшение</span>
                        <span>AI-коррекция текста: исправление ошибок, пунктуация, форматирование</span>
                    </div>
                </div>
            </section>

            <section style={{ marginBottom: '2rem' }}>
                <h3 style={{ 
                    fontSize: '1.1rem', 
                    fontWeight: 600, 
                    marginBottom: '1rem',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                }}>
                    <span style={{ fontSize: '1.3rem' }}>💡</span>
                    Рекомендации
                </h3>
                <ul style={{ 
                    paddingLeft: '1.5rem', 
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                }}>
                    <li>Используйте качественный микрофон для лучшего распознавания</li>
                    <li>Говорите чётко и не слишком быстро</li>
                    <li>Для длинных записей включите диаризацию в настройках</li>
                    <li>Модель <strong>large-v3-turbo</strong> даёт лучшее качество для русского языка</li>
                    <li>Для быстрой работы на слабых устройствах используйте модель <strong>base</strong></li>
                    <li>Drag & Drop аудиофайлы прямо в окно приложения для импорта</li>
                </ul>
            </section>

            <section>
                <h3 style={{ 
                    fontSize: '1.1rem', 
                    fontWeight: 600, 
                    marginBottom: '1rem',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                }}>
                    <span style={{ fontSize: '1.3rem' }}>📤</span>
                    Экспорт
                </h3>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                    Доступные форматы экспорта транскрипции:
                </p>
                <div style={{ 
                    display: 'flex', 
                    gap: '0.5rem', 
                    flexWrap: 'wrap',
                }}>
                    {['TXT', 'SRT', 'VTT', 'JSON', 'Буфер обмена'].map(format => (
                        <span key={format} style={{
                            padding: '0.3rem 0.75rem',
                            background: 'var(--glass-bg)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: '0.85rem',
                            color: 'var(--text-secondary)',
                        }}>
                            {format}
                        </span>
                    ))}
                </div>
            </section>
        </div>
    );

    const renderShortcuts = () => (
        <div>
            {SHORTCUTS.map(category => (
                <div key={category.category} style={{ marginBottom: '1.5rem' }}>
                    <h4 style={{ 
                        fontSize: '0.85rem', 
                        fontWeight: 600, 
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        marginBottom: '0.75rem',
                    }}>
                        {category.category}
                    </h4>
                    <div style={{ 
                        display: 'flex', 
                        flexDirection: 'column', 
                        gap: '0.5rem',
                    }}>
                        {category.items.map((item, idx) => (
                            <div key={idx} style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                padding: '0.6rem 0.75rem',
                                background: 'var(--glass-bg)',
                                borderRadius: 'var(--radius-sm)',
                                border: '1px solid var(--glass-border)',
                            }}>
                                <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                                    {item.description}
                                </span>
                                <div style={{ display: 'flex', gap: '0.25rem' }}>
                                    {item.keys.map((key, keyIdx) => (
                                        <kbd key={keyIdx} style={{
                                            padding: '0.25rem 0.5rem',
                                            background: 'var(--surface-strong)',
                                            border: '1px solid var(--border)',
                                            borderRadius: '4px',
                                            fontSize: '0.8rem',
                                            fontFamily: 'SF Mono, Monaco, monospace',
                                            color: 'var(--text-primary)',
                                            minWidth: '1.5rem',
                                            textAlign: 'center',
                                            boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                                        }}>
                                            {key}
                                        </kbd>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
            <p style={{ 
                fontSize: '0.85rem', 
                color: 'var(--text-muted)', 
                marginTop: '1rem',
                fontStyle: 'italic',
            }}>
                На Windows/Linux используйте Ctrl вместо ⌘
            </p>
        </div>
    );

    const renderAbout = () => (
        <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <div style={{
                width: '80px',
                height: '80px',
                margin: '0 auto 1.5rem',
                background: 'linear-gradient(135deg, var(--primary) 0%, #6366f1 100%)',
                borderRadius: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 8px 32px rgba(99, 102, 241, 0.3)',
            }}>
                <span style={{ fontSize: '2.5rem' }}>🎙️</span>
            </div>
            
            <h2 style={{ 
                fontSize: '1.5rem', 
                fontWeight: 700, 
                marginBottom: '0.5rem',
                color: 'var(--text-primary)',
            }}>
                AIWisper
            </h2>
            
            <p style={{ 
                color: 'var(--text-muted)', 
                marginBottom: '1.5rem',
                fontSize: '0.95rem',
            }}>
                Версия {appVersion}
            </p>

            <p style={{ 
                color: 'var(--text-secondary)', 
                marginBottom: '2rem',
                lineHeight: 1.6,
                maxWidth: '400px',
                margin: '0 auto 2rem',
            }}>
                Интеллектуальное приложение для транскрипции речи с поддержкой 
                распознавания говорящих, AI-сводок и экспорта в различные форматы.
            </p>

            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '1rem',
                marginBottom: '2rem',
            }}>
                <div style={{
                    padding: '1rem',
                    background: 'var(--glass-bg)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--glass-border)',
                }}>
                    <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🚀</div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        Whisper AI
                    </div>
                </div>
                <div style={{
                    padding: '1rem',
                    background: 'var(--glass-bg)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--glass-border)',
                }}>
                    <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🍎</div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        macOS Native
                    </div>
                </div>
                <div style={{
                    padding: '1rem',
                    background: 'var(--glass-bg)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--glass-border)',
                }}>
                    <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🔒</div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        Локальная обработка
                    </div>
                </div>
            </div>

            <div style={{ 
                borderTop: '1px solid var(--glass-border)', 
                paddingTop: '1.5rem',
                color: 'var(--text-muted)',
                fontSize: '0.85rem',
            }}>
                <p style={{ marginBottom: '0.5rem' }}>
                    Разработано с ❤️ командой AIWisper
                </p>
                <p>
                    © 2024-2025 AIWisper. Все права защищены.
                </p>
            </div>
        </div>
    );

    return (
        <div
            className="animate-scale-in"
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.5)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
            }}
            onClick={onClose}
        >
            <div
                style={{
                    background: 'var(--glass-bg-elevated)',
                    backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                    WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturation))',
                    borderRadius: 'var(--radius-xl)',
                    width: '640px',
                    maxHeight: '85vh',
                    boxShadow: 'var(--shadow-elevated)',
                    border: '1px solid var(--glass-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '1.5rem',
                    paddingBottom: '1rem',
                    borderBottom: '1px solid var(--glass-border-subtle)',
                    flexShrink: 0,
                }}>
                    <h2 style={{
                        margin: 0,
                        fontSize: '1.2rem',
                        fontWeight: 'var(--font-weight-bold)',
                    }}>
                        Справка
                    </h2>
                    <button
                        className="btn-icon"
                        onClick={onClose}
                        style={{ width: '32px', height: '32px' }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {/* Tabs */}
                <div style={{
                    display: 'flex',
                    gap: '0.5rem',
                    padding: '0 1.5rem',
                    paddingTop: '1rem',
                    flexShrink: 0,
                }}>
                    <button style={tabStyle('guide')} onClick={() => setActiveTab('guide')}>
                        📖 Руководство
                    </button>
                    <button style={tabStyle('shortcuts')} onClick={() => setActiveTab('shortcuts')}>
                        ⌨️ Горячие клавиши
                    </button>
                    <button style={tabStyle('about')} onClick={() => setActiveTab('about')}>
                        ℹ️ О программе
                    </button>
                </div>

                {/* Content */}
                <div style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '1.5rem',
                }}>
                    {activeTab === 'guide' && renderGuide()}
                    {activeTab === 'shortcuts' && renderShortcuts()}
                    {activeTab === 'about' && renderAbout()}
                </div>

                {/* Footer */}
                <div style={{
                    textAlign: 'right',
                    padding: '1rem 1.5rem',
                    borderTop: '1px solid var(--glass-border-subtle)',
                    flexShrink: 0,
                }}>
                    <button
                        className="btn-capsule btn-capsule-primary"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1.5rem' }}
                    >
                        Закрыть
                    </button>
                </div>
            </div>
        </div>
    );
};

export default HelpModal;
