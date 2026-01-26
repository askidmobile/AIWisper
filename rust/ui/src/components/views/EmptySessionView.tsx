import React from 'react';

/**
 * Экран для пустой сессии без транскрипции
 * Отображается когда selectedSession !== null, но chunks.length === 0
 */
export const EmptySessionView: React.FC = () => {
    return (
        <div style={{ 
            color: 'var(--text-muted)', 
            textAlign: 'center', 
            marginTop: '3rem' 
        }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📭</div>
            <div>Эта запись не содержит транскрипции</div>
            <div style={{ fontSize: '0.85rem', marginTop: '0.5rem', opacity: 0.7 }}>
                Возможно, запись была прервана до создания чанков
            </div>
        </div>
    );
};

export default EmptySessionView;
