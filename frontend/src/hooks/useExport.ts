import { useCallback } from 'react';
import { Session } from '../types/session';

// Форматирование времени для SRT/VTT
const formatSRTTime = (ms: number): string => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const milliseconds = ms % 1000;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`;
};

const formatVTTTime = (ms: number): string => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const milliseconds = ms % 1000;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
};

// Получение имени спикера
const getSpeakerName = (speaker?: string): string => {
    if (speaker === 'mic' || speaker === 'Вы') return 'Вы';
    if (speaker === 'sys' || speaker === 'Собеседник') return 'Собеседник';
    if (speaker?.startsWith('Speaker ')) {
        const num = parseInt(speaker.replace('Speaker ', ''), 10);
        return `Собеседник ${num + 1}`;
    }
    return speaker || 'Собеседник';
};

export const useExport = () => {
    // Копирование текста в буфер обмена
    const copyToClipboard = useCallback(async (session: Session): Promise<boolean> => {
        if (!session?.chunks) return false;
        
        const dialogue = session.chunks
            .filter(c => c.status === 'completed' && c.dialogue)
            .flatMap(c => c.dialogue || [])
            .sort((a, b) => (a.start || 0) - (b.start || 0));
        
        if (dialogue.length === 0) return false;
        
        const text = dialogue
            .map(seg => `${getSpeakerName(seg.speaker)}: ${seg.text}`)
            .join('\n');
        
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
            return false;
        }
    }, []);

    // Экспорт в TXT
    const exportTXT = useCallback((session: Session): void => {
        if (!session?.chunks) return;
        
        const dialogue = session.chunks
            .filter(c => c.status === 'completed' && c.dialogue)
            .flatMap(c => c.dialogue || [])
            .sort((a, b) => (a.start || 0) - (b.start || 0));
        
        const text = dialogue
            .map(seg => {
                const mins = Math.floor((seg.start || 0) / 60000);
                const secs = Math.floor(((seg.start || 0) % 60000) / 1000);
                const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                return `[${timeStr}] ${getSpeakerName(seg.speaker)}: ${seg.text}`;
            })
            .join('\n');
        
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${session.title || 'transcription'}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, []);

    // Экспорт в SRT
    const exportSRT = useCallback((session: Session): void => {
        if (!session?.chunks) return;
        
        const dialogue = session.chunks
            .filter(c => c.status === 'completed' && c.dialogue)
            .flatMap(c => c.dialogue || [])
            .sort((a, b) => (a.start || 0) - (b.start || 0));
        
        const srt = dialogue
            .map((seg, idx) => {
                const startTime = formatSRTTime(seg.start || 0);
                const endTime = formatSRTTime(seg.end || seg.start || 0);
                return `${idx + 1}\n${startTime} --> ${endTime}\n${getSpeakerName(seg.speaker)}: ${seg.text}\n`;
            })
            .join('\n');
        
        const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${session.title || 'transcription'}.srt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, []);

    // Экспорт в VTT
    const exportVTT = useCallback((session: Session): void => {
        if (!session?.chunks) return;
        
        const dialogue = session.chunks
            .filter(c => c.status === 'completed' && c.dialogue)
            .flatMap(c => c.dialogue || [])
            .sort((a, b) => (a.start || 0) - (b.start || 0));
        
        const vtt = ['WEBVTT\n']
            .concat(dialogue.map((seg, idx) => {
                const startTime = formatVTTTime(seg.start || 0);
                const endTime = formatVTTTime(seg.end || seg.start || 0);
                return `${idx + 1}\n${startTime} --> ${endTime}\n${getSpeakerName(seg.speaker)}: ${seg.text}\n`;
            }))
            .join('\n');
        
        const blob = new Blob([vtt], { type: 'text/vtt;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${session.title || 'transcription'}.vtt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, []);

    // Экспорт в JSON
    const exportJSON = useCallback((session: Session): void => {
        if (!session?.chunks) return;
        
        const dialogue = session.chunks
            .filter(c => c.status === 'completed' && c.dialogue)
            .flatMap(c => c.dialogue || [])
            .sort((a, b) => (a.start || 0) - (b.start || 0));
        
        const data = {
            session: {
                id: session.id,
                title: session.title,
                startTime: session.startTime,
                endTime: session.endTime,
                totalDuration: session.totalDuration,
                language: session.language,
                model: session.model,
            },
            dialogue: dialogue.map(seg => ({
                start: seg.start,
                end: seg.end,
                speaker: getSpeakerName(seg.speaker),
                text: seg.text,
            })),
            summary: session.summary || null,
        };
        
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${session.title || 'transcription'}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, []);

    // Экспорт в Markdown
    const exportMarkdown = useCallback((session: Session): void => {
        if (!session?.chunks) return;
        
        const dialogue = session.chunks
            .filter(c => c.status === 'completed' && c.dialogue)
            .flatMap(c => c.dialogue || [])
            .sort((a, b) => (a.start || 0) - (b.start || 0));
        
        const date = new Date(session.startTime).toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
        
        const durationSec = (session.totalDuration || 0) / 1000;
        const durationMin = Math.floor(durationSec / 60);
        const durationSecRem = Math.floor(durationSec % 60);
        
        let md = `# ${session.title || 'Транскрипция'}\n\n`;
        md += `**Дата:** ${date}\n`;
        md += `**Длительность:** ${durationMin}:${durationSecRem.toString().padStart(2, '0')}\n\n`;
        
        if (session.summary) {
            md += `## Сводка\n\n${session.summary}\n\n`;
        }
        
        md += `## Диалог\n\n`;
        
        dialogue.forEach(seg => {
            const mins = Math.floor((seg.start || 0) / 60000);
            const secs = Math.floor(((seg.start || 0) % 60000) / 1000);
            const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
            md += `**[${timeStr}] ${getSpeakerName(seg.speaker)}:** ${seg.text}\n\n`;
        });
        
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${session.title || 'transcription'}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, []);

    return {
        copyToClipboard,
        exportTXT,
        exportSRT,
        exportVTT,
        exportJSON,
        exportMarkdown,
    };
};
