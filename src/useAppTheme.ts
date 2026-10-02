import { useEffect, useRef, useState } from 'react';
import { api } from './api';
export function useAppTheme(onError: (e: unknown) => void) {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [ready, setReady] = useState(false),
    [saving, setSaving] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let alive = true;
    void api<{ appTheme: 'light' | 'dark' }>('/settings')
      .then((settings) => {
        if (alive) setTheme(settings.appTheme === 'light' ? 'light' : 'dark');
      })
      .catch(onError)
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [onError]);
  useEffect(() => {
    document.documentElement.dataset.appTheme = theme;
  }, [theme]);
  async function changeTheme(next: 'light' | 'dark') {
    if (pending.current || !ready) return;
    pending.current = true;
    setSaving(true);
    const previous = theme;
    setTheme(next);
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify({ appTheme: next }) });
    } catch (e) {
      setTheme(previous);
      onError(e);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  return { theme, changeTheme, disabled: !ready || saving };
}
