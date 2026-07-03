// Minimal stub of the 'vscode' module for unit tests.
// Only the surface used by src modules under test is implemented.

const configStore = new Map<string, unknown>();

export function __setConfig(key: string, value: unknown): void {
  configStore.set(key, value);
}

export function __resetConfig(): void {
  configStore.clear();
}

export const workspace = {
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, defaultValue: T): T {
        const fullKey = section ? `${section}.${key}` : key;
        return configStore.has(fullKey) ? (configStore.get(fullKey) as T) : defaultValue;
      },
    };
  },
};

export const Uri = {
  file(fsPath: string) {
    return { fsPath, scheme: 'file' };
  },
};

export const commands = {
  async executeCommand(): Promise<void> {
    /* no-op in tests */
  },
};
