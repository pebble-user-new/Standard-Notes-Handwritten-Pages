// Where the note text lives. Inside Standard Notes that's the sn-extension-api bridge; when the page
// is opened on its own (development / quick demo) it falls back to localStorage.

import snApi from 'sn-extension-api';

export interface NoteHost {
  /** true when running outside Standard Notes */
  readonly standalone: boolean;
  /** start talking to the host; `onUpdate` fires whenever the note (or its lock state) changes */
  init(onUpdate: () => void): void;
  readonly text: string;
  readonly locked: boolean;
  write(text: string, preview: string): void;
  /**
   * Settings stored with the plugin itself (Standard Notes' "component data"): shared by every note
   * that uses the plugin and synced between devices. Null when unavailable.
   */
  readSettings(): Record<string, unknown> | null;
  writeSettings(data: Record<string, unknown>): void;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

class SnHost implements NoteHost {
  readonly standalone = false;

  init(onUpdate: () => void): void {
    snApi.initialize({ debounceSave: 300 });
    snApi.subscribe(() => onUpdate());
  }

  get text(): string {
    return snApi.text || '';
  }

  get locked(): boolean {
    return !!snApi.locked;
  }

  write(text: string, preview: string): void {
    snApi.text = text;
    snApi.preview = preview;
  }

  readSettings(): Record<string, unknown> | null {
    try {
      return asObject(snApi.extensionMeta);
    } catch {
      return null;
    }
  }

  writeSettings(data: Record<string, unknown>): void {
    try {
      snApi.extensionMeta = data;
    } catch {
      /* ignore */
    }
  }
}

const LOCAL_KEY = 'handwritten-pages:standalone-note';

class LocalHost implements NoteHost {
  readonly standalone = true;

  init(onUpdate: () => void): void {
    setTimeout(onUpdate, 0);
  }

  get text(): string {
    try {
      return localStorage.getItem(LOCAL_KEY) || '';
    } catch {
      return '';
    }
  }

  get locked(): boolean {
    return false;
  }

  write(text: string): void {
    try {
      localStorage.setItem(LOCAL_KEY, text);
    } catch {
      /* ignore */
    }
  }

  // standalone: the per-device preferences in localStorage are all there is
  readSettings(): Record<string, unknown> | null {
    return null;
  }

  writeSettings(): void {}
}

export function createHost(): NoteHost {
  return window.parent !== window ? new SnHost() : new LocalHost();
}
