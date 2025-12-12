import React, { useMemo } from 'react';
import { TranscriptSegment } from '../../types/session';

interface SessionStatsProps {
    dialogue: TranscriptSegment[];
    totalDuration: number; // в миллисекундах
    isCompact?: boolean;
}

interface StatsData {
    totalWords: number;
    totalSegments: number;
    speakersCount: number;
    speakers: { name: string; words: number; segments: number; duration: number }[];
    avgSegmentLength: number;
    avgWordsPerMinute: number;
    lowConfidenceWords: number;
    avgConfidence: number;
}

/**
 * Компонент статистики сессии
 * Показывает количество слов, спикеров, среднюю длину реплик и т.д.
 */
export const SessionStats: React.FC<SessionStatsProps> = ({
    dialogue,
    totalDuration,
    isCompact = false,
}) => {
    const stats = useMemo<StatsData>(() => {
        if (!dialogue || dialogue.length === 0) {
            return {
                totalWords: 0,
                totalSegments: 0,
                speakersCount: 0,
                speakers: [],
                avgSegmentLength: 0,
                avgWordsPerMinute: 0,
                lowConfidenceWords: 0,
                avgConfidence: 0,
            };
        }

        // Подсчёт слов
        let totalWords = 0;
        let lowConfidenceWords = 0;
        let totalConfidence = 0;
        let confidenceCount = 0;

        // Статистика по спикерам
        const speakerStats: Map<string, { words: number; segments: number; duration: number }> = new Map();

        for (const seg of dialogue) {
            const speaker = seg.speaker || 'unknown';
            const segDuration = (seg.end || 0) - (seg.start || 0);
            
            // Считаем слова
            if (seg.words && seg.words.length > 0) {
                totalWords += seg.words.length;
                for (const word of seg.words) {
                    if (word.p && word.p > 0) {
                        totalConfidence += word.p;
                        confidenceCount++;
                        if (word.p < 0.7) {
                            lowConfidenceWords++;
                        }
                    }
                }
            } else if (seg.text) {
                // Если нет word-level данных, считаем по пробелам
                const wordCount = seg.text.trim().split(/\s+/).filter(w => w.length > 0).length;
                totalWords += wordCount;
            }

            // Статистика по спикерам
            const existing = speakerStats.get(speaker) || { words: 0, segments: 0, duration: 0 };
            existing.segments++;
            existing.duration += segDuration;
            if (seg.words && seg.words.length > 0) {
                existing.words += seg.words.length;
            } else if (seg.text) {
                existing.words += seg.text.trim().split(/\s+/).filter(w => w.length > 0).length;
            }
            speakerStats.set(speaker, existing);
        }

        // Преобразуем Map в массив
        const speakers = Array.from(speakerStats.entries()).map(([name, data]) => ({
            name: formatSpeakerName(name),
            ...data,
        }));

        // Сортируем по количеству слов
        speakers.sort((a, b) => b.words - a.words);

        const durationMinutes = totalDuration / 60000;
        const avgWordsPerMinute = durationMinutes > 0 ? Math.round(totalWords / durationMinutes) : 0;

        return {
            totalWords,
            totalSegments: dialogue.length,
            speakersCount: speakerStats.size,
            speakers,
            avgSegmentLength: dialogue.length > 0 ? Math.round(totalWords / dialogue.length) : 0,
            avgWordsPerMinute,
            lowConfidenceWords,
            avgConfidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
        };
    }, [dialogue, totalDuration]);

    if (isCompact) {
        return <CompactStats stats={stats} />;
    }

    return <FullStats stats={stats} totalDuration={totalDuration} />;
};

/**
 * Компактная версия статистики (для заголовка)
 */
const CompactStats: React.FC<{ stats: StatsData }> = ({ stats }) => {
    if (stats.totalWords === 0) {
        return null;
    }

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
            }}
        >
            <span title="Количество слов">
                📝 {stats.totalWords.toLocaleString()}
            </span>
            <span title="Количество спикеров">
                👥 {stats.speakersCount}
            </span>
            <span title="Слов в минуту">
                ⚡ {stats.avgWordsPerMinute}/мин
            </span>
            {stats.lowConfidenceWords > 0 && (
                <span 
                    title={`Слов с низкой уверенностью (<70%): ${stats.lowConfidenceWords}`}
                    style={{ color: 'var(--warning)' }}
                >
                    ⚠️ {stats.lowConfidenceWords}
                </span>
            )}
        </div>
    );
};

/**
 * Полная версия статистики (для отдельной панели)
 */
const FullStats: React.FC<{ stats: StatsData; totalDuration: number }> = ({ stats, totalDuration }) => {
    if (stats.totalWords === 0) {
        return (
            <div style={{ 
                padding: '2rem', 
                textAlign: 'center', 
                color: 'var(--text-muted)' 
            }}>
                Нет данных для отображения статистики
            </div>
        );
    }

    const formatDuration = (ms: number): string => {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        
        if (hours > 0) {
            return `${hours}ч ${minutes % 60}м`;
        }
        return `${minutes}м ${seconds % 60}с`;
    };

    return (
        <div style={{ padding: '1rem' }}>
            {/* Основная статистика */}
            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    gap: '12px',
                    marginBottom: '1.5rem',
                }}
            >
                <StatCard
                    icon="📝"
                    label="Всего слов"
                    value={stats.totalWords.toLocaleString()}
                />
                <StatCard
                    icon="💬"
                    label="Реплик"
                    value={stats.totalSegments.toString()}
                />
                <StatCard
                    icon="👥"
                    label="Спикеров"
                    value={stats.speakersCount.toString()}
                />
                <StatCard
                    icon="⚡"
                    label="Слов/мин"
                    value={stats.avgWordsPerMinute.toString()}
                />
                <StatCard
                    icon="📊"
                    label="Ср. длина реплики"
                    value={`${stats.avgSegmentLength} сл.`}
                />
                <StatCard
                    icon="⏱️"
                    label="Длительность"
                    value={formatDuration(totalDuration)}
                />
            </div>

            {/* Статистика по спикерам */}
            {stats.speakers.length > 0 && (
                <div>
                    <h4 style={{ 
                        fontSize: '0.85rem', 
                        color: 'var(--text-secondary)', 
                        marginBottom: '0.75rem',
                        fontWeight: 500,
                    }}>
                        Активность спикеров
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {stats.speakers.map((speaker, idx) => {
                            const percentage = stats.totalWords > 0 
                                ? Math.round((speaker.words / stats.totalWords) * 100) 
                                : 0;
                            
                            return (
                                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                    <span style={{ 
                                        minWidth: '100px', 
                                        fontSize: '0.85rem',
                                        color: 'var(--text-primary)',
                                        fontWeight: 500,
                                    }}>
                                        {speaker.name}
                                    </span>
                                    <div style={{ 
                                        flex: 1, 
                                        height: '8px', 
                                        backgroundColor: 'var(--glass-bg)',
                                        borderRadius: '4px',
                                        overflow: 'hidden',
                                    }}>
                                        <div style={{
                                            width: `${percentage}%`,
                                            height: '100%',
                                            backgroundColor: getSpeakerColor(idx),
                                            borderRadius: '4px',
                                            transition: 'width 0.3s ease',
                                        }} />
                                    </div>
                                    <span style={{ 
                                        minWidth: '80px', 
                                        fontSize: '0.75rem',
                                        color: 'var(--text-muted)',
                                        textAlign: 'right',
                                    }}>
                                        {speaker.words} сл. ({percentage}%)
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Качество распознавания */}
            {stats.avgConfidence > 0 && (
                <div style={{ marginTop: '1.5rem' }}>
                    <h4 style={{ 
                        fontSize: '0.85rem', 
                        color: 'var(--text-secondary)', 
                        marginBottom: '0.75rem',
                        fontWeight: 500,
                    }}>
                        Качество распознавания
                    </h4>
                    <div style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '16px',
                        padding: '12px',
                        backgroundColor: 'var(--glass-bg)',
                        borderRadius: '8px',
                    }}>
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ 
                                fontSize: '1.5rem', 
                                fontWeight: 600,
                                color: getConfidenceColor(stats.avgConfidence),
                            }}>
                                {Math.round(stats.avgConfidence * 100)}%
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                Ср. уверенность
                            </div>
                        </div>
                        {stats.lowConfidenceWords > 0 && (
                            <div style={{ 
                                flex: 1,
                                fontSize: '0.8rem',
                                color: 'var(--text-secondary)',
                            }}>
                                <span style={{ color: 'var(--warning)' }}>⚠️ {stats.lowConfidenceWords}</span>
                                {' '}слов с низкой уверенностью
                                <br />
                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                    Включите "🎯 Confidence" для подсветки
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

/**
 * Карточка статистики
 */
const StatCard: React.FC<{ icon: string; label: string; value: string }> = ({ icon, label, value }) => (
    <div
        style={{
            padding: '12px',
            backgroundColor: 'var(--glass-bg)',
            borderRadius: '8px',
            border: '1px solid var(--glass-border-subtle)',
        }}
    >
        <div style={{ fontSize: '1.2rem', marginBottom: '4px' }}>{icon}</div>
        <div style={{ 
            fontSize: '1.1rem', 
            fontWeight: 600, 
            color: 'var(--text-primary)',
            marginBottom: '2px',
        }}>
            {value}
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {label}
        </div>
    </div>
);

/**
 * Форматирование имени спикера
 */
function formatSpeakerName(speaker: string): string {
    if (speaker === 'mic') return 'Вы';
    if (speaker === 'sys') return 'Собеседник';
    if (speaker.startsWith('Speaker ')) {
        const num = parseInt(speaker.replace('Speaker ', ''), 10);
        return `Собеседник ${num + 1}`;
    }
    return speaker;
}

/**
 * Цвет для спикера
 */
function getSpeakerColor(index: number): string {
    const colors = [
        '#4caf50', // Зелёный (Вы)
        '#2196f3', // Синий
        '#00bcd4', // Голубой
        '#9c27b0', // Фиолетовый
        '#ff9800', // Оранжевый
        '#e91e63', // Розовый
    ];
    return colors[index % colors.length];
}

/**
 * Цвет для уровня уверенности
 */
function getConfidenceColor(confidence: number): string {
    if (confidence >= 0.8) return 'var(--success)';
    if (confidence >= 0.6) return 'var(--warning)';
    return 'var(--error)';
}

export default SessionStats;
