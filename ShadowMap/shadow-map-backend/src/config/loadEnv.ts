import fs from 'fs';
import path from 'path';

type LoadState = {
  loaded: boolean;
  files: string[];
};

const assignmentPattern = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const loadState: LoadState = {
  loaded: false,
  files: [],
};

const parseAssignedValue = (rawValue: string): string => {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return '';
  }

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    let value = '';
    let escaped = false;

    for (let index = 1; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (char === undefined) {
        break;
      }

      if (quote === '"' && escaped) {
        if (char === 'n') {
          value += '\n';
        } else if (char === 'r') {
          value += '\r';
        } else if (char === 't') {
          value += '\t';
        } else {
          value += char;
        }
        escaped = false;
        continue;
      }

      if (quote === '"' && char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) {
        return value;
      }

      value += char;
    }

    return value;
  }

  return trimmed.replace(/\s+#.*$/, '').trim();
};

const expandValue = (value: string, scope: Record<string, string | undefined>) =>
  value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
    const key = String(braced ?? plain ?? '');
    return scope[key] ?? '';
  });

const parseEnvFile = (filePath: string, baseScope: Record<string, string | undefined>) => {
  const parsed: Record<string, string> = {};
  const scope: Record<string, string | undefined> = {
    ...baseScope,
  };

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = line.match(assignmentPattern);
    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2] ?? '';
    if (!key) {
      continue;
    }

    const value = expandValue(parseAssignedValue(rawValue), scope);
    parsed[key] = value;
    scope[key] = value;
  }

  return parsed;
};

const resolveShadowMapPaths = () => {
  const backendRoot = path.resolve(__dirname, '../..');
  const repoRoot = path.resolve(__dirname, '../../../');
  return {
    backendRoot,
    repoRoot,
    backendEnvPath: path.join(backendRoot, '.env'),
    defaultProfilePath: path.join(repoRoot, '.shadowmap.env'),
  };
};

const applyEnvFile = (
  filePath: string,
  initialEnvKeys: Set<string>,
  allowOverrideFromFile: boolean,
): boolean => {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const parsed = parseEnvFile(filePath, process.env);
  for (const [key, value] of Object.entries(parsed)) {
    if (initialEnvKeys.has(key)) {
      continue;
    }

    if (!allowOverrideFromFile && process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = value;
  }

  loadState.files.push(filePath);
  return true;
};

export const loadShadowMapEnv = (): void => {
  if (loadState.loaded) {
    return;
  }

  const initialEnvKeys = new Set(Object.keys(process.env));
  const { backendEnvPath, defaultProfilePath, repoRoot } = resolveShadowMapPaths();
  const requestedProfile = process.env['SHADOWMAP_ENV_FILE'];

  if (requestedProfile !== '/dev/null') {
    const profilePath = requestedProfile
      ? path.isAbsolute(requestedProfile)
        ? requestedProfile
        : path.resolve(repoRoot, requestedProfile)
      : defaultProfilePath;
    applyEnvFile(profilePath, initialEnvKeys, false);
  }

  applyEnvFile(backendEnvPath, initialEnvKeys, true);
  loadState.loaded = true;

  if (process.env['NODE_ENV'] !== 'test' && loadState.files.length > 0) {
    console.log(`[Config] Loaded environment files: ${loadState.files.join(', ')}`);
  }
};
