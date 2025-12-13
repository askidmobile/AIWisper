import React from 'react';

/**
 * Экран во время записи, когда ещё нет транскрипции
 * Отображается когда isRecording = true и chunks.length === 0
 */
export const RecordingView: React.FC = () => {
    return (
        <div style={{ 
            color: 'var(--text-muted)', 
            textAlign: 'center', 
            marginTop: '3rem' 
        }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔴</div>
            <div>Идёт запись... Транскрипция появится после остановки</div>
        </div>
    );
};

export default RecordingView;
