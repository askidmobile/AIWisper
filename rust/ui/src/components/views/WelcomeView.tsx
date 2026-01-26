import React from 'react';

interface WelcomeViewProps {
    // Drag & Drop состояние
    isDragging: boolean;
    isImporting: boolean;
    importProgress: string | null;
    
    // Drag & Drop обработчики
    onDragOver: (e: React.DragEvent) => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
}

/**
 * Welcome Screen - экран приветствия с onboarding и drag-drop зоной
 * Отображается когда нет активной записи и не выбрана сессия
 */
export const WelcomeView: React.FC<WelcomeViewProps> = ({
    isDragging,
    isImporting,
    importProgress,
    onDragOver,
    onDragEnter,
    onDragLeave,
    onDrop,
}) => {
    return (
        <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            justifyContent: 'center',
            height: '100%',
            padding: '2rem',
            textAlign: 'center',
        }}>
            {/* Hero Section */}
            <div style={{
                marginBottom: '2.5rem',
            }}>
                {/* App Icon / Logo */}
                <div style={{
                    width: '80px',
                    height: '80px',
                    borderRadius: '24px',
                    background: 'linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 1.5rem',
                    boxShadow: 'var(--shadow-glow-primary)',
                }}>
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="23"/>
                        <line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                </div>
                
                <h1 style={{
                    fontSize: '1.75rem',
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                    margin: '0 0 0.5rem',
                    letterSpacing: '-0.02em',
                }}>
                    Добро пожаловать в AIWisper
                </h1>
                <p style={{
                    fontSize: '1rem',
                    color: 'var(--text-secondary)',
                    margin: 0,
                    maxWidth: '400px',
                }}>
                    Интеллектуальная транскрипция с распознаванием говорящих
                </p>
            </div>

            {/* Quick Start Guide */}
            <div style={{
                background: 'var(--surface)',
                borderRadius: 'var(--radius-xl)',
                padding: '1.5rem',
                width: '100%',
                maxWidth: '420px',
                border: '1px solid var(--glass-border-subtle)',
            }}>
                <h3 style={{
                    fontSize: '0.9rem',
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    margin: '0 0 1rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                }}>
                    Быстрый старт
                </h3>

                {/* Step 1 */}
                <QuickStartStep 
                    number={1}
                    title="Нажмите «Новая запись»"
                    description="Кнопка в левой панели запустит запись микрофона и системного звука"
                />

                {/* Step 2 */}
                <QuickStartStep 
                    number={2}
                    title="Говорите или проиграйте аудио"
                    description="AI автоматически разделит речь по говорящим"
                />

                {/* Step 3 */}
                <QuickStartStep 
                    number={3}
                    title="Остановите и получите текст"
                    description="Транскрипция с таймкодами и диаризацией готова к экспорту"
                    isLast
                />
            </div>

            {/* Drop Zone for Audio Import */}
            <DropZone
                isDragging={isDragging}
                isImporting={isImporting}
                importProgress={importProgress}
                onDragOver={onDragOver}
                onDragEnter={onDragEnter}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
            />
        </div>
    );
};

/**
 * Шаг быстрого старта
 */
interface QuickStartStepProps {
    number: number;
    title: string;
    description: string;
    isLast?: boolean;
}

const QuickStartStep: React.FC<QuickStartStepProps> = ({ number, title, description, isLast }) => (
    <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '1rem',
        marginBottom: isLast ? 0 : '1rem',
        textAlign: 'left',
    }}>
        <div style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.85rem',
            fontWeight: 700,
            flexShrink: 0,
        }}>{number}</div>
        <div>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                {title}
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {description}
            </div>
        </div>
    </div>
);

/**
 * Зона для drag & drop импорта аудио
 */
interface DropZoneProps {
    isDragging: boolean;
    isImporting: boolean;
    importProgress: string | null;
    onDragOver: (e: React.DragEvent) => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
}

const DropZone: React.FC<DropZoneProps> = ({
    isDragging,
    isImporting,
    importProgress,
    onDragOver,
    onDragEnter,
    onDragLeave,
    onDrop,
}) => (
    <div
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
            marginTop: '1.5rem',
            padding: '1.25rem 2rem',
            border: `2px dashed ${isDragging ? 'var(--primary)' : 'var(--glass-border)'}`,
            borderRadius: 'var(--radius-xl)',
            background: isDragging ? 'rgba(139, 92, 246, 0.1)' : 'var(--surface)',
            textAlign: 'center',
            transition: 'all 0.2s ease',
            width: '100%',
            maxWidth: '420px',
            cursor: 'pointer',
            transform: isDragging ? 'scale(1.02)' : 'scale(1)',
        }}
    >
        {isImporting ? (
            <ImportingState progress={importProgress} />
        ) : (
            <div style={{ 
                fontSize: '0.95rem', 
                color: isDragging ? 'var(--primary)' : 'var(--text-muted)',
                fontWeight: isDragging ? 600 : 400,
            }}>
                {isDragging ? 'Отпустите для импорта' : 'Перетащите сюда MP3, WAV, M4A, OGG или FLAC'}
            </div>
        )}
    </div>
);

/**
 * Состояние импорта с прогресс-баром
 */
const ImportingState: React.FC<{ progress: string | null }> = ({ progress }) => (
    <>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.75rem' }}>
            {progress || 'Идет транскрибирование'}
        </div>
        <div style={{
            width: '100%',
            height: '4px',
            background: 'var(--glass-border)',
            borderRadius: '2px',
            overflow: 'hidden',
        }}>
            <div style={{
                width: '30%',
                height: '100%',
                background: 'linear-gradient(90deg, var(--primary), var(--primary-dark))',
                borderRadius: '2px',
                animation: 'importProgress 1.5s ease-in-out infinite',
            }} />
        </div>
        <style>{`
            @keyframes importProgress {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(400%); }
            }
        `}</style>
    </>
);

export default WelcomeView;
