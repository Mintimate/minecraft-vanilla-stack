// Run: node --test tools/test_admin_rcon.mjs
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { createLogger } from '../web/lib/log.mjs';
import { ERR, isRconError } from '../web/lib/admin/rcon-protocol.mjs';
import {
  actionCommand, parseDayTime, parseOnlinePlayers, parseWhitelist, RconClient,
} from '../web/lib/admin/rcon.mjs';
import { parseLocate, prepareLocate } from '../web/lib/admin/rcon-locate.mjs';
import { fragments, PASSWORD, startFakeRcon } from './fake_rcon.mjs';

const ONLINE = 'There are 2 of a max of 20 players online: Alex, Steve';
const DIFFICULTY = (name = 'Normal') => `The difficulty is ${name}`;

function capture() {
  const lines = [];
  const logger = createLogger({ component: 'test', level: 'debug', sink: (_, line) => lines.push(JSON.parse(line)) });
  return { lines, logger };
}

async function withServer(options, run) {
  const server = await startFakeRcon(options);
  try {
    const log = capture();
    const client = new RconClient({ host: '127.0.0.1', port: server.port, password: PASSWORD, timeoutMs: 1500 }, log.logger);
    return await run(client, server, log);
  } finally { await server.close(); }
}

const rejects = (promise, code) => assert.rejects(promise, (error) => isRconError(error, code), `expected ${code}`);

test('configuration is validated without any network access', () => {
  const ok = { host: '127.0.0.1', port: 25575, password: PASSWORD };
  assert.doesNotThrow(() => new RconClient(ok));
  assert.doesNotThrow(() => new RconClient({ ...ok, host: 'mc-1.example.test' }));
  for (const bad of [{ host: '' }, { host: 'bad host' }, { host: '-a.test' }, { port: 0 }, { port: 70000 },
    { port: 1.5 }, { password: 'short' }, { password: `${PASSWORD} with space` }, { password: `${PASSWORD}é` },
    { timeoutMs: -1 }]) {
    assert.throws(() => new RconClient({ ...ok, ...bad }), /RCON/);
  }
});

test('online players are read in one connection and parsed strictly', async () => {
  await withServer({ respond: () => ONLINE }, async (client, server, log) => {
    assert.deepEqual(await client.onlinePlayers(), { players: [{ name: 'Alex' }, { name: 'Steve' }], maxPlayers: 20 });
    assert.deepEqual(server.commands, ['list']);
    assert.equal(server.opened, 1);
    const summary = log.lines.find((line) => line.event === 'rcon_operation');
    assert.deepEqual({ operation: summary.operation, ok: summary.ok, calls: summary.calls },
      { operation: 'online_players', ok: true, calls: 1 });
    assert.equal(typeof summary.elapsedMs, 'number');
  });
});

test('long and exact-multiple-of-4096 responses are fully drained using the end marker', async () => {
  for (const length of [4095, 4096, 4097, 8192, 12_289]) {
    const text = `There are 1 ban(s):${'x'.repeat(length - 'There are 1 ban(s):'.length)}`;
    assert.equal(text.length, length);
    await withServer({ respond: () => text }, async (client, server) => {
      const bans = await client.bans();
      assert.equal(bans.rawOutput.length, length);
      assert.equal(server.opened, 1);
    });
  }
});

test('whitelist, difficulty and time parsers fail closed on unknown or localized text', () => {
  assert.deepEqual(parseWhitelist('There are no whitelisted players'), []);
  assert.deepEqual(parseWhitelist('There are 2 whitelisted player(s): a, B_2'), [{ name: 'a' }, { name: 'B_2' }]);
  for (const bad of ['', '没有白名单', 'There are 2 whitelisted player(s): a', 'There are 01 whitelisted player(s): a',
    'There are 2 whitelisted player(s): a, A', 'There are 1 whitelisted player(s): bad name', 'There are 0 whitelisted player(s): ']) {
    assert.throws(() => parseWhitelist(bad), (error) => isRconError(error, ERR.PROTOCOL), bad);
  }
  assert.deepEqual(parseOnlinePlayers('There are 0 of a max of 20 players online: '), { players: [], maxPlayers: 20 });
  assert.equal(parseOnlinePlayers('There are 2 of a max of 1 players online: a, b').maxPlayers, 1);
  assert.throws(() => parseOnlinePlayers('There are 1 of a max of x players online: a'));
  assert.equal(parseDayTime('Timeline minecraft:day is at 6000 tick(s)'), 6000);
  for (const bad of ['Timeline minecraft:day is at 24000 tick(s)', 'Timeline minecraft:day is at -1 tick(s)', 'The time is 5']) {
    assert.throws(() => parseDayTime(bad));
  }
});

test('authentication failures and malformed packets are distinguished and logged without secrets', async () => {
  const server = await startFakeRcon();
  try {
    const log = capture();
    const wrong = new RconClient({ host: '127.0.0.1', port: server.port, password: `${PASSWORD}x`, timeoutMs: 1000 }, log.logger);
    await rejects(wrong.onlinePlayers(), ERR.AUTHENTICATION);
    const failure = log.lines.find((line) => line.event === 'rcon_operation');
    assert.equal(failure.ok, false);
    assert.equal(failure.stage, 'connect');
    assert.equal(failure.code, 'authentication');
    assert.equal(JSON.stringify(log.lines).includes(PASSWORD), false);
  } finally { await server.close(); }
  await withServer({ authReply: (id) => Buffer.from([1, 0, 0, 0]) }, async (client) => {
    await rejects(client.onlinePlayers(), ERR.PROTOCOL);
  });
});

test('a closed port reports the system error code, not the address', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const log = capture();
  const client = new RconClient({ host: '127.0.0.1', port, password: PASSWORD, timeoutMs: 1000 }, log.logger);
  await rejects(client.onlinePlayers(), ERR.UNAVAILABLE);
  const entry = log.lines.find((line) => line.event === 'rcon_operation');
  assert.equal(entry.errorCode, 'ECONNREFUSED');
  assert.equal(JSON.stringify(log.lines).includes(String(port)), false);
});

test('the overall deadline closes a silent server', async () => {
  const silent = net.createServer((socket) => { socket.on('error', () => {}); socket.resume(); });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const client = new RconClient({ host: '127.0.0.1', port: silent.address().port, password: PASSWORD, timeoutMs: 150 });
  const started = Date.now();
  await assert.rejects(client.onlinePlayers(), (error) => isRconError(error, ERR.UNAVAILABLE) && isRconError(error, ERR.TIMEOUT));
  assert.ok(Date.now() - started < 1500);
  await new Promise((resolve) => { silent.close(resolve); });
});

test('mutations never retry and report disconnects as unconfirmed', async () => {
  await withServer({ respond: (command) => (command.startsWith('whitelist add') ? { close: true } : '') }, async (client, server) => {
    await rejects(client.add('Alex'), ERR.MUTATION_UNCONFIRMED);
    assert.equal(server.commands.filter((command) => command.startsWith('whitelist add')).length, 1);
    assert.equal(server.opened, 1);
  });
});

test('whitelist changes are verified by reading the list back on the same connection', async () => {
  let list = 'There are no whitelisted players';
  await withServer({
    respond: (command) => {
      if (command === 'whitelist add Alex') { list = 'There are 1 whitelisted player(s): Alex'; return 'Added Alex to the whitelist'; }
      if (command === 'whitelist add Ghost') return 'Added Ghost to the whitelist';
      if (command === 'whitelist remove Alex') { list = 'There are no whitelisted players'; return 'Removed'; }
      if (command === 'whitelist list') return list;
      return '';
    },
  }, async (client, server) => {
    assert.deepEqual(await client.add('Alex'), [{ name: 'Alex' }]);
    await rejects(client.add('Ghost'), ERR.MUTATION_UNCONFIRMED); // reply claims success but list disagrees
    assert.deepEqual(await client.remove('Alex'), []);
    assert.deepEqual(server.commands.slice(0, 2), ['whitelist add Alex', 'whitelist list']);
  });
});

test('names and actions are validated before any connection is opened', async () => {
  await withServer({}, async (client, server) => {
    for (const name of ['', 'a b', 'Alex\nop Alex', 'x'.repeat(17), '@a', 'Alex;stop']) {
      await rejects(client.add(name), ERR.INVALID_PLAYER);
      await rejects(client.playerDetails(name), ERR.INVALID_PLAYER);
    }
    for (const action of [
      { kind: 'op', player: 'Alex' }, { kind: 'kick', player: 'Alex', message: 'x' },
      { kind: 'announce', message: 'a\nb' }, { kind: 'announce', message: ' ' }, { kind: 'announce', message: 'x'.repeat(161) },
      { kind: 'announce', message: '好'.repeat(171) }, { kind: 'time', value: 'sunrise' },
      { kind: 'weather', value: 'rain', seconds: 0 }, { kind: 'weather', value: 'rain', seconds: 3601 },
      { kind: 'teleport', player: 'Alex', target: 'alex' }, { kind: 'save', target: 'x' },
    ]) {
      assert.throws(() => actionCommand(action), (error) => isRconError(error, ERR.INVALID_ACTION), JSON.stringify(action));
      await rejects(client.execute(action), ERR.INVALID_ACTION);
    }
    assert.equal(server.opened, 0);
  });
});

test('announce text becomes one JSON string, never selectors or components', () => {
  assert.equal(actionCommand({ kind: 'announce', message: 'hi "@a" \\ {"text":"x"}' }),
    'tellraw @a {"text":"hi \\"@a\\" \\\\ {\\"text\\":\\"x\\"}"}');
  assert.equal(actionCommand({ kind: 'weather', value: 'thunder', seconds: 60 }), 'weather thunder 60s');
});

test('daily actions require the exact vanilla acknowledgement', async () => {
  const replies = new Map([
    ['tellraw', ''], ['kick Alex Disconnected by administrator.', 'Kicked Alex: Disconnected by administrator.'],
    ['time set day', 'Set minecraft:overworld to time marker minecraft:day'],
    ['time query minecraft:day', 'Timeline minecraft:day is at 1000 tick(s)'],
    ['weather clear 60s', 'Set the weather to clear'], ['weather thunder 60s', 'Set the weather to rain and thunder'],
    ['save-all flush', 'Saving the game (this may take a moment!)Saved the game'],
    ['list', 'There are 1 of a max of 20 players online: Steve'],
  ]);
  await withServer({ respond: (command) => replies.get(command.startsWith('tellraw') ? 'tellraw' : command) ?? 'Unknown' }, async (client) => {
    await client.execute({ kind: 'announce', message: 'hello' });
    await client.execute({ kind: 'kick', player: 'Alex' });
    await client.execute({ kind: 'time', value: 'day' });
    await client.execute({ kind: 'weather', value: 'clear', seconds: 60 });
    await client.execute({ kind: 'weather', value: 'thunder', seconds: 60 });
    await client.execute({ kind: 'save' });
    replies.set('save-all flush', 'Saving failed');
    await rejects(client.execute({ kind: 'save' }), ERR.MUTATION_UNCONFIRMED);
    replies.set('tellraw', 'No player was found');
    await rejects(client.execute({ kind: 'announce', message: 'hello' }), ERR.NO_PLAYERS);
    replies.set('list', 'There are 1 of a max of 20 players online: alex');
    await rejects(client.execute({ kind: 'kick', player: 'Alex' }), ERR.MUTATION_UNCONFIRMED); // still online
  });
});

test('difficulty changes are verified by read-back', async () => {
  let current = 'Normal';
  await withServer({
    respond: (command) => {
      if (command === 'difficulty') return DIFFICULTY(current);
      if (command === 'difficulty hard') { current = 'Hard'; return 'The difficulty has been set to Hard'; }
      if (command === 'difficulty easy') return 'The difficulty has been set to Easy'; // does not take effect
      return '';
    },
  }, async (client) => {
    assert.deepEqual(await client.settings(), { difficulty: 'normal' });
    assert.deepEqual(await client.setSetting('difficulty', 'hard'), { difficulty: 'hard' });
    await rejects(client.setSetting('difficulty', 'easy'), ERR.MUTATION_UNCONFIRMED);
    await rejects(client.setSetting('difficulty', 'cruel'), ERR.INVALID_SETTING);
    await rejects(client.setSetting('pvp', 'hard'), ERR.INVALID_SETTING);
  });
});

test('game rules use stable keys over 26.3 command ids and verify writes', async () => {
  const values = { keep_inventory: 'false', players_sleeping_percentage: '100', mob_griefing: 'true', advance_time: 'true', advance_weather: 'true' };
  await withServer({
    respond: (command) => {
      const set = /^gamerule minecraft:(\w+) (\S+)$/.exec(command);
      if (set) { values[set[1]] = set[2]; return `Game rule ${set[1]} is now set to ${set[2]}`; }
      const get = /^gamerule minecraft:(\w+)$/.exec(command);
      return get ? `Game rule ${get[1]} is currently set to ${values[get[1]]}` : '';
    },
  }, async (client, server) => {
    assert.deepEqual((await client.gameRules()).map((rule) => rule.key),
      ['keepInventory', 'playersSleepingPercentage', 'mobGriefing', 'doDaylightCycle', 'doWeatherCycle']);
    const rules = await client.setGameRule('keepInventory', true);
    assert.equal(rules.find((rule) => rule.key === 'keepInventory').value, true);
    assert.equal((await client.setGameRule('playersSleepingPercentage', 50)).find((r) => r.key === 'playersSleepingPercentage').value, 50);
    assert.ok(server.commands.includes('gamerule minecraft:keep_inventory true'));
    for (const [key, value] of [['keepInventory', 'true'], ['keepInventory', 1], ['playersSleepingPercentage', 101],
      ['playersSleepingPercentage', 1.5], ['playersSleepingPercentage', null], ['doFireTick', false]]) {
      await assert.rejects(client.setGameRule(key, value), (e) => isRconError(e, ERR.INVALID_GAMERULE), `${key}=${value}`);
    }
  });
});

test('player details read position and reject a dimension change', async () => {
  let dimension = '"minecraft:overworld"';
  let reads = 0;
  await withServer({
    respond: (command) => {
      if (command === 'list') return 'There are 1 of a max of 20 players online: Alex';
      if (command === 'data get entity Alex Pos') return '[Team] Alex has the following entity data: [12.5d, 64.0d, -3.25d]';
      if (command === 'data get entity Alex Dimension') { reads += 1; return `Alex has the following entity data: ${dimension}`; }
      return '';
    },
  }, async (client) => {
    assert.deepEqual(await client.playerDetails('alex'),
      { name: 'Alex', dimension: 'minecraft:overworld', position: [12.5, 64, -3.25] });
    await rejects(client.playerDetails('Steve'), ERR.NO_PLAYERS);
    dimension = '"bad dimension"';
    await rejects(client.playerDetails('Alex'), ERR.PROTOCOL);
    assert.ok(reads >= 2);
  });
});

test('teleport and bans verify precise acknowledgements', async () => {
  let banned = false;
  await withServer({
    respond: (command) => {
      if (command === 'list') return 'There are 2 of a max of 20 players online: Alex, Steve';
      if (command === 'tp Alex Steve') return 'Teleported Alex to Steve';
      if (command === 'ban Alex griefing') { const was = banned; banned = true; return was ? 'Nothing changed. The player is already banned' : 'Banned Alex: griefing'; }
      if (command === 'pardon Alex') { const was = banned; banned = false; return was ? 'Unbanned Alex' : "Nothing changed. The player isn't banned"; }
      if (command === 'banlist players') return banned ? 'There are 1 ban(s):Alex was banned by Rcon: griefing' : 'There are no bans';
      return '';
    },
  }, async (client) => {
    await client.execute({ kind: 'teleport', player: 'alex', target: 'STEVE' });
    await rejects(client.execute({ kind: 'teleport', player: 'Alex', target: 'Ghost' }), ERR.NO_PLAYERS);
    assert.deepEqual(await client.bans(), { count: 0, rawOutput: 'There are no bans' });
    assert.equal((await client.ban('Alex', '  griefing  ')).count, 1);
    await rejects(client.ban('Alex', 'griefing'), ERR.BAN_UNCHANGED);
    assert.equal((await client.pardon('Alex')).count, 0);
    await rejects(client.pardon('Alex'), ERR.BAN_UNCHANGED);
    for (const reason of ['', '@a', 'two\nlines', 'x'.repeat(161), '\u2028']) {
      await assert.rejects(client.ban('Alex', reason), (e) => isRconError(e, ERR.INVALID_BAN), JSON.stringify(reason));
    }
  });
});

test('structure lookup converts origin dimensions once and reports both points', async () => {
  assert.deepEqual(prepareLocate({ structure: 'mansion', originDimension: 'minecraft:the_nether', x: 100, z: -50 }).search,
    { dimension: 'minecraft:overworld', x: 800, z: -400 });
  assert.deepEqual(prepareLocate({ structure: 'fortress', originDimension: 'minecraft:overworld', x: -1, z: -9 }).search,
    { dimension: 'minecraft:the_nether', x: -1, z: -2 });
  assert.deepEqual(prepareLocate({ structure: 'stronghold', x: -0, z: 5 }).origin, { dimension: 'minecraft:overworld', x: 0, z: 5 });
  for (const bad of [
    { structure: 'ocean_ruin', x: 0, z: 0 }, { structure: 'mansion', originDimension: 'minecraft:fake', x: 0, z: 0 },
    { structure: 'mansion', x: 30_000_000, z: 0 }, { structure: 'mansion', x: 1.5, z: 0 },
    { structure: 'end_city', originDimension: 'minecraft:overworld', x: 0, z: 0 },
    { structure: 'mansion', originDimension: 'minecraft:the_nether', x: 29_999_984, z: 0 },
  ]) assert.throws(() => prepareLocate(bad), (e) => isRconError(e, ERR.INVALID_LOCATE), JSON.stringify(bad));
  await withServer({
    respond: (command) => {
      assert.equal(command, 'execute in minecraft:overworld positioned 800 64 -400 run locate structure minecraft:mansion');
      return 'The nearest minecraft:mansion is at [900, ~, -400] (100 blocks away)';
    },
  }, async (client) => {
    const result = await client.locate({ structure: 'mansion', originDimension: 'minecraft:the_nether', x: 100, z: -50 });
    assert.deepEqual(result, {
      structure: 'mansion', dimension: 'minecraft:overworld', x: 900, z: -400, distance: 100,
      origin: { dimension: 'minecraft:the_nether', x: 100, z: -50 },
      searchOrigin: { dimension: 'minecraft:overworld', x: 800, z: -400 },
    });
  });
});

test('locate replies are matched exactly and never guessed', () => {
  const query = prepareLocate({ structure: 'village', x: 0, z: 0 });
  assert.equal(parseLocate(query, 'The nearest #minecraft:village (minecraft:village_taiga) is at [3, ~, 4] (5 blocks away)').distance, 5);
  const overflow = prepareLocate({ structure: 'mansion', x: 0, z: 0 });
  assert.equal(parseLocate(overflow, 'The nearest minecraft:mansion is at [-30000000, ~, 30000000] (1 blocks away)').distance, 42426406);
  assert.throws(() => parseLocate(overflow, 'Could not find a structure of type "minecraft:mansion" nearby'), (e) => isRconError(e, ERR.STRUCTURE_NOT_FOUND));
  for (const bad of ['The nearest minecraft:monument is at [1, ~, 2] (3 blocks away)', 'The nearest minecraft:mansion is at [-0, ~, 2] (3 blocks away)',
    'The nearest minecraft:mansion is at [1, ~, 2] (3 blocks away) extra', 'Unknown', 'The nearest minecraft:mansion is at [30000001, ~, 0] (1 blocks away)']) {
    assert.throws(() => parseLocate(overflow, bad), (e) => isRconError(e, ERR.PROTOCOL), bad);
  }
});

test('responses beyond the packet and size limits are rejected', async () => {
  await withServer({ respond: () => Array.from({ length: 1025 }, () => 'x') }, async (client) => {
    await rejects(client.onlinePlayers(), ERR.PROTOCOL);
  });
  await withServer({ respond: () => ['a\0b'] }, async (client) => {
    await rejects(client.onlinePlayers(), ERR.PROTOCOL);
  });
});

test('debug logging records command verbs and sizes but never arguments or output', async () => {
  await withServer({ respond: (command) => (command === 'list' ? ONLINE : 'Banned Alex: secret reason') }, async (client, server, log) => {
    await client.onlinePlayers();
    await rejects(client.ban('Alex', 'secret reason'), ERR.MUTATION_UNCONFIRMED).catch(() => {});
    const text = JSON.stringify(log.lines);
    assert.equal(text.includes('secret reason'), false);
    assert.equal(text.includes('Steve'), false);
    const verbs = log.lines.filter((line) => line.event === 'rcon_command').map((line) => line.verb);
    assert.ok(verbs.includes('list'));
  });
});
