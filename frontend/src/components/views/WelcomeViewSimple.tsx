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
            {/* App Icon */}
            <div style={{ 
                width: '80px', 
                height: '80px', 
                borderRadius: '20px',
                background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: '1.5rem',
                boxShadow: 'var(--shadow-glow-primary)'
            }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                marginBottom: '0.5rem',
                textAlign: 'center'
            }}>
                AIWisper
            </h1>
            <p style={{ 
                fontSize: '0.95rem', 
                color: 'var(--text-secondary)',
                marginBottom: '2rem',
                textAlign: 'center'
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
                <FeatureCard icon="🎯" text="Точное распознавание" />
                <FeatureCard icon="👥" text="Разделение спикеров" />
                <FeatureCard icon="📝" text="AI-сводка" />
                <FeatureCard icon="🔒" text="Локальная обработка" />
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
    icon: string;
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
        gap: '0.5rem'
    }}>
        <span style={{ fontSize: '1.1rem' }}>{icon}</span>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{text}</span>
    </div>
);

export default WelcomeViewSimple;
