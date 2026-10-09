// A scripted Minecraft RCON server for tests. It speaks the real wire format:
// little-endian frames, type 3 login, type 2 command, replies split at 4096
// characters, and a distinct frame id echoed for the end-marker request. It
// only ever listens on loopback.
import net from 'node:net';

export const PASSWORD = 'test-rcon-password-0123456789-abcdef';

function frame(id, kind, body) {
  const bytes = Buffer.from(body, 'utf8');
  const buffer = Buffer.alloc(bytes.length + 14);
  buffer.writeUInt32LE(bytes.length + 10, 0);
  buffer.writeInt32LE(id, 4);
  buffer.writeInt32LE(kind, 8);
  bytes.copy(buffer, 12);
  return buffer;
}

export function fragments(text, size = 4096) {
  const chars = [...text];
  if (!chars.length) return [''];
  const parts = [];
  for (let at = 0; at < chars.length; at += size) parts.push(chars.slice(at, at + size).join(''));
  return parts;
}

// respond(command, state) returns a string (framed like vanilla), an array of
// raw fragments, or { close: true } to drop the connection without answering.
export async function startFakeRcon({ password = PASSWORD, respond = () => '', difficulty = 'Normal',
  authReply, rawReply } = {}) {
  const commands = [];
  const connections = new Set();
  let opened = 0;
  const server = net.createServer((socket) => {
    opened += 1;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let chain = Promise.resolve(); // respond() may be async; keep frames in order
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const size = buffer.readUInt32LE(0);
        const id = buffer.readInt32LE(4);
        const kind = buffer.readInt32LE(8);
        const body = buffer.subarray(12, 4 + size - 2).toString('utf8');
        buffer = buffer.subarray(4 + size);
        chain = chain.then(async () => {
          if (socket.destroyed) return;
          if (kind === 3) {
            if (authReply) socket.write(authReply(id));
            else socket.write(frame(body === password ? id : -1, 2, ''));
            return;
          }
          if (body === 'difficulty' && id % 2 === 1) {
            socket.write(frame(id, 0, `The difficulty is ${difficulty}`));
            return;
          }
          commands.push(body);
          const answer = await respond(body, { commands });
          if (socket.destroyed) return;
          if (answer && answer.close) { socket.destroy(); return; }
          if (rawReply) { socket.write(rawReply(id, answer)); return; }
          const parts = Array.isArray(answer) ? answer : fragments(String(answer ?? ''));
          for (const part of parts) socket.write(frame(id, 0, part));
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    commands,
    get opened() { return opened; },
    close: () => new Promise((resolve) => {
      for (const socket of connections) socket.destroy();
      server.close(resolve);
    }),
  };
}
