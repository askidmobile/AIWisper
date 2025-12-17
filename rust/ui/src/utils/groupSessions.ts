import { SessionInfo } from '../types/session';

export interface SessionGroup {
  label: string;
  sessions: SessionInfo[];
}

export const groupSessionsByTime = (sessions: SessionInfo[]): SessionGroup[] => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const thisWeekStart = new Date(today);
  thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const groups: Record<string, SessionInfo[]> = {};
  const groupOrder: string[] = [];

  const addToGroup = (key: string, session: SessionInfo) => {
    if (!groups[key]) {
      groups[key] = [];
      groupOrder.push(key);
    }
    groups[key].push(session);
  };

  // Sort sessions by date (newest first)
  const sortedSessions = [...sessions].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );

  sortedSessions.forEach((session) => {
    const date = new Date(session.startTime);
    const sessionDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (sessionDay.getTime() === today.getTime()) {
      addToGroup('Сегодня', session);
    } else if (sessionDay.getTime() === yesterday.getTime()) {
      addToGroup('Вчера', session);
    } else if (sessionDay >= thisWeekStart) {
      addToGroup('На этой неделе', session);
    } else if (sessionDay >= thisMonthStart) {
      addToGroup('В этом месяце', session);
    } else {
      // Group by month
      const monthName = date.toLocaleDateString('ru-RU', { month: 'long' });
      const year = date.getFullYear();
      const currentYear = now.getFullYear();
      const key = year === currentYear ? `в ${monthName}` : `${monthName} ${year}`;
      addToGroup(key, session);
    }
  });

  return groupOrder.map((label) => ({
    label,
    sessions: groups[label],
  }));
};

export const formatDuration = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

export const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
};

export const formatTime = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
};
