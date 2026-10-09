// Environment configuration for the administration console and the public
// status probe. Both read the same RCON_* variables; only the console needs
// ADMIN_KEY. Messages are safe to show to an unauthenticated visitor: they name
// variables but never include a value.
import { validateRconConfig } from './rcon-protocol.mjs';

export class ConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

function present(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value : '';
}

export function loadRconConfig(env) {
  const missing = ['RCON_HOST', 'RCON_PASSWORD'].filter((name) => !present(env, name));
  if (missing.length) {
    throw new ConfigError(`缺少服务端环境变量：${missing.join('、')}。保存后请重新部署。`, 'STATUS_PROBE_NOT_CONFIGURED');
  }
  let port = 25575;
  const portText = present(env, 'RCON_PORT');
  if (portText) {
    port = /^[0-9]{1,5}$/.test(portText) ? Number(portText) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError('RCON_PORT 必须是 1–65535 之间的整数，也可留空使用默认端口。', 'rcon_port_invalid');
    }
  }
  try {
    return validateRconConfig({ host: present(env, 'RCON_HOST'), port, password: present(env, 'RCON_PASSWORD') });
  } catch {
    throw new ConfigError(
      'RCON 配置格式错误：RCON_HOST 只能填写 IP 或主机名；RCON_PASSWORD 必须为 32–128 位可打印 ASCII，不能含空格或换行。',
      'rcon_config_invalid');
  }
}

export function loadAdminConfig(env) {
  const missing = ['ADMIN_KEY', 'RCON_HOST', 'RCON_PASSWORD'].filter((name) => !present(env, name));
  if (missing.length) {
    throw new ConfigError(`缺少服务端环境变量：${missing.join('、')}。保存后请重新部署。`, 'admin_env_missing');
  }
  const adminKey = present(env, 'ADMIN_KEY');
  if (adminKey === present(env, 'RCON_PASSWORD')) {
    throw new ConfigError('ADMIN_KEY 与 RCON_PASSWORD 必须使用不同的密钥。', 'admin_key_reused');
  }
  const rcon = loadRconConfig(env);
  if (Buffer.byteLength(adminKey) < 32 || adminKey.trim() === '') {
    throw new ConfigError('ADMIN_KEY 至少需要 32 字节，且不能全为空白；建议使用 openssl rand -hex 32 生成。', 'admin_key_weak');
  }
  return { adminKey, rcon };
}
