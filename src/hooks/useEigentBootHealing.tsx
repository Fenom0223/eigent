// ========= Copyright 2025-2026 @ Eigent.ai All Rights Reserved. =========
// Eigent-Boot-Healing-marker-do-not-remove
// Eigent-Boot-Healing-version: 2 (with most-recent fallback)
//
// Boot healing hook for Eigent. Persisted by autostart.sh 5.12.
//
// What this hook does, in order:
//   1) Auto-login via /api/v1/user/auto-login if no token is in the
//      zustand-persist localStorage. The server creates a default admin
//      user on first call (see server/app/domains/user/api/login_controller.py).
//   2) If no active project exists in the runtime store, create a fresh
//      "New Chat" project. projectStore.createProject() auto-spawns an
//      empty task and marks it active, which unlocks the chat input box
//      (isInputDisabled requires chatStore.activeTaskId to be set).
//   3) On subsequent loads, try to restore the last active project from
//      localStorage. This is the "memory" the user sees across reloads —
//      the underlying chat history is already in Postgres at
//      /persistent/data/postgres/12-main/ (cluster bootstrapped by
//      autostart.sh 5.4), so this hook just remembers which conversation
//      to reopen.
//
// Why the default agent sometimes froze before this hook:
//   On a cold boot the project store had no active project, so
//   activeTaskId stayed null, so isInputDisabled returned true and the
//   InputBox was disabled. The user had to manually click "+ New Chat"
//   in the sidebar to get a writable input. Now the hook does it for them.
//
// Persistence summary (post-rebuild):
//   - Chat messages: Postgres at /persistent/data/postgres/12-main/
//   - Providers (Kimchi, model prefs): Postgres `provider` table
//   - Auth token: zustand-persist localStorage (browser-local)
//   - Last-active project pointer: this hook writes localStorage key
//     'eigent:lastActiveProjectId' and re-opens it on next load.
//
// Safe to apply multiple times: this file is fully replaced atomically by
// autostart.sh 5.12 (it uses a unique marker to detect an already-patched
// version and skips the rewrite).

import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useProjectRuntimeStore } from '@/store/projectRuntimeStore';
import { useSpaceStore } from '@/store/spaceStore';

const LAST_PROJECT_KEY = 'eigent:lastActiveProjectId';
const RESTORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface AutoLoginResponse {
  token?: string;
  email?: string;
  redirect_url?: string | null;
}

async function ensureAuth(): Promise<string | null> {
  const { token, setAuth } = useAuthStore.getState();
  if (token) return token;

  const apply = (data: AutoLoginResponse) => {
    if (data?.token) {
      setAuth({
        token: data.token,
        email: data.email || 'admin@local.eigent.ai',
        username: data.email || 'admin',
        user_id: 1,
      });
      return data.token;
    }
    return null;
  };

  try {
    const { proxyFetchPost } = await import('@/api/http');
    const res = (await proxyFetchPost('/api/v1/user/auto-login', {})) as AutoLoginResponse;
    const t = apply(res);
    if (t) return t;
  } catch (err) {
    console.warn('[Eigent-Boot] proxyFetchPost auto-login failed, falling back to raw fetch:', err);
  }
  try {
    const r = await fetch('/api/v1/user/auto-login', { method: 'POST' });
    const data = (await r.json()) as AutoLoginResponse;
    return apply(data);
  } catch (err) {
    console.warn('[Eigent-Boot] raw fetch auto-login failed:', err);
    return null;
  }
}

async function fetchRecentProjects(_token: string): Promise<any[]> {
  try {
    const { proxyFetchGet } = await import('@/api/http');
    const res = await proxyFetchGet('/api/v1/chat/histories/grouped', {
      include_tasks: 'true',
    });
    return Array.isArray(res?.projects) ? res.projects : [];
  } catch (err) {
    console.warn('[Eigent-Boot] history fetch failed:', err);
    return [];
  }
}

export function useEigentBootHealing(): void {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      const token = await ensureAuth();
      if (!token) return;

      const projectStore = useProjectRuntimeStore();
      const spaceStore = useSpaceStore();

      try {
        if (!spaceStore.activeSpaceId) {
          spaceStore.ensureLegacySpace(1);
        }
      } catch (err) {
        console.warn('[Eigent-Boot] ensureLegacySpace failed:', err);
      }

      const activeId = projectStore.activeProjectId;
      if (activeId) {
        try {
          localStorage.setItem(LAST_PROJECT_KEY, activeId);
        } catch {
          /* private mode */
        }
        return;
      }

      const lastId = (() => {
        try {
          return localStorage.getItem(LAST_PROJECT_KEY) || '';
        } catch {
          return '';
        }
      })();

      // Always fetch recent projects from the server so we can recover even
      // when localStorage is empty (rebuild + fresh browser profile — the
      // canonical memory is in Postgres at /persistent/data/postgres/12-main/,
      // so we don't need localStorage to find it).
      const projects = await fetchRecentProjects(token);

      // (a) Prefer the exact last-active project if it still exists and is recent.
      if (lastId) {
        const hit = projects.find((p: any) => p?.project_id === lastId);
        if (hit) {
          const anchor = (() => {
            const t = Date.parse(hit.latest_task_date || '');
            return Number.isFinite(t) ? t : 0;
          })();
          const fresh = anchor && Date.now() - anchor < RESTORE_MAX_AGE_MS;
          if (fresh) {
            try {
              projectStore.setActiveProject(lastId);
              return;
            } catch (err) {
              console.warn('[Eigent-Boot] auto-restore by lastId failed:', err);
            }
          }
        }
      }

      // (b) Fallback: pick the most-recently-active project from the server.
      // This is the path that fires after a rebuild when localStorage is
      // gone but the chat_history table still has the user's projects.
      const sorted = [...projects].sort((a: any, b: any) => {
        const ta = Date.parse(a?.latest_task_date || '') || 0;
        const tb = Date.parse(b?.latest_task_date || '') || 0;
        return tb - ta;
      });
      const mostRecent = sorted[0];
      if (mostRecent) {
        try {
          projectStore.setActiveProject(mostRecent.project_id);
          try {
            localStorage.setItem(LAST_PROJECT_KEY, mostRecent.project_id);
          } catch {
            /* non-fatal */
          }
          return;
        } catch (err) {
          console.warn('[Eigent-Boot] auto-restore by most-recent failed:', err);
        }
      }

      // (c) Last resort: create a fresh default project. createProject()
      // always spawns an empty task and marks it active, which unlocks the
      // chat input. This is what happens on a TRULY fresh install where the
      // chat_history table is empty.
      try {
        const newId = projectStore.createProject('New Chat');
        try {
          localStorage.setItem(LAST_PROJECT_KEY, newId);
        } catch {
          /* non-fatal */
        }
      } catch (err) {
        console.error('[Eigent-Boot] failed to create default project:', err);
      }
    })();
  }, []);
}

export default useEigentBootHealing;
