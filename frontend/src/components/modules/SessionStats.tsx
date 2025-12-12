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

// ============================================
// SVG ИКОНКИ (монохромные, компактные)
// ============================================

const IconWords = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7h16M4 12h10M4 17h14" />
    </svg>
);

const IconMessages = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
);

const IconSpeakers = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
);

const IconSpeed = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
);

const IconChart = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
);

const IconClock = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
    </svg>
);

const IconWarning = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
);

const IconCheck = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

const IconUser = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
    </svg>
);

const IconMic = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
);

/**
 * Компонент статистики сессии
 * Минималистичный дизайн со строками
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

        let totalWords = 0;
        let lowConfidenceWords = 0;
        let totalConfidence = 0;
        let confidenceCount = 0;

        const speakerStats: Map<string, { words: number; segments: number; duration: number }> = new Map();

        for (const seg of dialogue) {
            const speaker = seg.speaker || 'unknown';
            const segDuration = (seg.end || 0) - (seg.start || 0);
            
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
                const wordCount = seg.text.trim().split(/\s+/).filter(w => w.length > 0).length;
                totalWords += wordCount;
            }

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

        const speakers = Array.from(speakerStats.entries()).map(([name, data]) => ({
            name: formatSpeakerName(name),
            ...data,
        }));

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
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            fontSize: '0.8rem',
            color: 'var(--text-muted)',
        }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Количество слов">
                <IconWords /> {stats.totalWords.toLocaleString()}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Количество спикеров">
                <IconSpeakers /> {stats.speakersCount}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Слов в минуту">
                <IconSpeed /> {stats.avgWordsPerMinute}/мин
            </span>
        </div>
    );
};

/**
 * Полная версия статистики — минималистичные строки
 */
const FullStats: React.FC<{ stats: StatsData; totalDuration: number }> = ({ stats, totalDuration }) => {
    if (stats.totalWords === 0) {
        return (
            <div style={{ 
                padding: '3rem 1.5rem', 
                textAlign: 'center', 
                color: 'var(--text-muted)' 
            }}>
                <div style={{ marginBottom: '0.5rem', opacity: 0.5 }}>
                    <IconChart />
                </div>
                <div>Нет данных для отображения</div>
            </div>
        );
    }

    const formatDuration = (ms: number): string => {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        
        if (hours > 0) {
            return `${hours}ч ${minutes % 60}м ${seconds % 60}с`;
        }
        return `${minutes}м ${seconds % 60}с`;
    };

    const statRows = [
        { icon: <IconClock />, label: 'Длительность', value: formatDuration(totalDuration) },
        { icon: <IconWords />, label: 'Всего слов', value: stats.totalWords.toLocaleString() },
        { icon: <IconMessages />, label: 'Реплик', value: stats.totalSegments.toString() },
        { icon: <IconSpeakers />, label: 'Спикеров', value: stats.speakersCount.toString() },
        { icon: <IconSpeed />, label: 'Темп речи', value: `${stats.avgWordsPerMinute} сл/мин` },
        { icon: <IconChart />, label: 'Ср. длина реплики', value: `${stats.avgSegmentLength} сл.` },
    ];

    return (
        <div style={{ padding: '1rem 1.5rem' }}>
            {/* Основная статистика — строки */}
            <div style={{ marginBottom: '1.5rem' }}>
                    {statRows.map((row, idx) => (
                    <div
                        key={idx}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '10px 0',
                            borderBottom: idx < statRows.length - 1 ? '1px solid var(--glass-border-subtle)' : 'none',
                        }}
                    >
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            color: 'var(--text-muted)',
                            fontSize: '0.85rem',
                        }}>
                            <span style={{ opacity: 0.5 }}>{row.icon}</span>
                            {row.label}
                        </div>
                        <div style={{
                            fontSize: '0.85rem',
                            fontWeight: 500,
                            color: 'var(--text-muted)',
                            fontVariantNumeric: 'tabular-nums',
                        }}>
                            {row.value}
                        </div>
                    </div>
                ))}
            </div>

            {/* Активность спикеров */}
            {stats.speakers.length > 0 && (
                <div style={{ marginBottom: '1.5rem' }}>
                    <div style={{
                        fontSize: '0.8rem',
                        color: 'var(--text-muted)',
                        marginBottom: '12px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        fontWeight: 500,
                    }}>
                        Активность спикеров
                    </div>
                    {stats.speakers.map((speaker, idx) => {
                        const percentage = stats.totalWords > 0 
                            ? Math.round((speaker.words / stats.totalWords) * 100) 
                            : 0;
                        
                        // Определяем иконку для спикера
                        const speakerIcon = speaker.name === 'Вы' ? <IconMic /> : <IconUser />;
                        
                        return (
                            <div 
                                key={idx}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '10px',
                                    padding: '8px 0',
                                }}
                            >
                                <span style={{ 
                                    opacity: 0.5,
                                    color: 'var(--text-muted)',
                                    display: 'flex',
                                    alignItems: 'center',
                                }}>
                                    {speakerIcon}
                                </span>
                                <span style={{ 
                                    minWidth: '100px', 
                                    fontSize: '0.85rem',
                                    color: 'var(--text-muted)',
                                    fontWeight: 500,
                                }}>
                                    {speaker.name}
                                </span>
                                <div style={{ 
                                    flex: 1, 
                                    height: '4px', 
                                    backgroundColor: 'var(--glass-bg)',
                                    borderRadius: '2px',
                                    overflow: 'hidden',
                                }}>
                                    <div style={{
                                        width: `${percentage}%`,
                                        height: '100%',
                                        background: `linear-gradient(90deg, ${getSpeakerColor(idx)}, ${getSpeakerColorLight(idx)})`,
                                        borderRadius: '2px',
                                        transition: 'width 0.5s ease',
                                    }} />
                                </div>
                                <span style={{ 
                                    minWidth: '90px', 
                                    fontSize: '0.85rem',
                                    color: 'var(--text-muted)',
                                    textAlign: 'right',
                                    fontVariantNumeric: 'tabular-nums',
                                }}>
                                    {speaker.words} сл. ({percentage}%)
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Качество распознавания — компактно */}
            {stats.avgConfidence > 0 && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    backgroundColor: 'var(--glass-bg)',
                    borderRadius: 'var(--radius-md)',
                    fontSize: '0.9rem',
                }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        color: 'var(--text-secondary)',
                    }}>
                        {stats.avgConfidence >= 0.8 ? (
                            <span style={{ color: 'var(--success)' }}><IconCheck /></span>
                        ) : (
                            <span style={{ color: 'var(--warning)' }}><IconWarning /></span>
                        )}
                        Уверенность распознавания
                    </div>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                    }}>
                        <span style={{
                            fontWeight: 600,
                            color: getConfidenceColor(stats.avgConfidence),
                        }}>
                            {Math.round(stats.avgConfidence * 100)}%
                        </span>
                        {stats.lowConfidenceWords > 0 && (
                            <span style={{
                                fontSize: '0.8rem',
                                color: 'var(--text-muted)',
                            }}>
                                ({stats.lowConfidenceWords} неуверенных)
                            </span>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

function formatSpeakerName(speaker: string): string {
    if (speaker === 'mic') return 'Вы';
    if (speaker === 'sys') return 'Собеседник';
    if (speaker.startsWith('Speaker ')) {
        const num = parseInt(speaker.replace('Speaker ', ''), 10);
        return `Собеседник ${num + 1}`;
    }
    return speaker;
}

function getSpeakerColor(index: number): string {
    const colors = ['#8b5cf6', '#4de1c1', '#3b82f6', '#f59e0b', '#ec4899', '#10b981'];
    return colors[index % colors.length];
}

function getSpeakerColorLight(index: number): string {
    const colors = ['#a78bfa', '#6ee7c7', '#60a5fa', '#fbbf24', '#f472b6', '#34d399'];
    return colors[index % colors.length];
}

function getConfidenceColor(confidence: number): string {
    if (confidence >= 0.8) return 'var(--success)';
    if (confidence >= 0.6) return 'var(--warning)';
    return 'var(--danger)';
}

export default SessionStats;
