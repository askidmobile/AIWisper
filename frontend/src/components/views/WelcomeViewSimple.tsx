import React from 'react';

/**
 * Упрощённый Welcome Screen без drag-drop пропсов
 * Используется в TranscriptionView когда нет активной записи и не выбрана сессия
 * Drag-drop обрабатывается на уровне MainLayout
 */
export const WelcomeViewSimple: React.FC = () => {
    return (
        <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            justifyContent: 'center',
            height: '100%',
            padding: '2rem',
            maxWidth: '600px',
            margin: '0 auto'
        }}>
            {/* App Icon - Pill shape like reference */}
            <div style={{ 
                width: '120px', 
                height: '56px', 
                borderRadius: '28px',
                background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: '1rem',
                marginBottom: '1.5rem',
                boxShadow: 'var(--shadow-glow-primary)'
            }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/>
                    <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
            </div>

            <h1 style={{ 
                fontSize: '1.5rem', 
                fontWeight: 'var(--font-weight-bold)',
                color: 'var(--text-primary)',
                marginBottom: '0.15rem',
                textAlign: 'center',
                lineHeight: 1.1
            }}>
                AIWisper
            </h1>
            <p style={{ 
                fontSize: '0.95rem', 
                color: 'var(--text-secondary)',
                marginBottom: '2rem',
                marginTop: 0,
                textAlign: 'center',
                lineHeight: 1.2
            }}>
                Умный транскрибатор с разделением спикеров
            </p>

            {/* Quick Start Guide */}
            <div style={{ 
                width: '100%',
                background: 'var(--glass-bg)',
                backdropFilter: 'blur(var(--glass-blur-light))',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--glass-border)',
                padding: '1.25rem',
                marginBottom: '1.5rem'
            }}>
                <h3 style={{ 
                    fontSize: '0.85rem', 
                    fontWeight: 'var(--font-weight-semibold)',
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    marginBottom: '1rem'
                }}>
                    Быстрый старт
                </h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <QuickStartStep 
                        number={1}
                        title="Нажмите «Новая запись»"
                        description="Кнопка внизу боковой панели"
                    />
                    <QuickStartStep 
                        number={2}
                        title="Говорите или включите звонок"
                        description="Записывается микрофон и системный звук"
                    />
                    <QuickStartStep 
                        number={3}
                        title="Остановите для получения текста"
                        description="Транскрипция с разделением «Вы» / «Собеседник»"
                    />
                </div>
            </div>

            {/* Features */}
            <div style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(2, 1fr)', 
                gap: '0.75rem',
                width: '100%'
            }}>
                <FeatureCard 
                    icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>}
                    text="Точное распознавание" 
                />
                <FeatureCard 
                    icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
                    text="Разделение спикеров" 
                />
                <FeatureCard 
                    icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>}
                    text="AI-сводка" 
                />
                <FeatureCard 
                    icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>}
                    text="Локальная обработка" 
                />
            </div>

            <p style={{ 
                fontSize: '0.75rem', 
                color: 'var(--text-muted)',
                marginTop: '1.5rem',
                textAlign: 'center'
            }}>
                Выберите запись слева или начните новую
            </p>
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
}

const QuickStartStep: React.FC<QuickStartStepProps> = ({ number, title, description }) => (
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
            fontWeight: 'var(--font-weight-semibold)',
            color: 'var(--primary)'
        }}>{number}</div>
        <div>
            <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 'var(--font-weight-medium)' }}>
                {title}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '2px' }}>
                {description}
            </div>
        </div>
    </div>
);

/**
 * Карточка фичи
 */
interface FeatureCardProps {
    icon: React.ReactNode;
    text: string;
}

const FeatureCard: React.FC<FeatureCardProps> = ({ icon, text }) => (
    <div style={{ 
        padding: '0.75rem 1rem',
        background: 'var(--glass-bg)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--glass-border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        color: 'var(--text-muted)'
    }}>
        <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{icon}</span>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{text}</span>
    </div>
);

export default WelcomeViewSimple;
