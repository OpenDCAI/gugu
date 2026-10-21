/**
 * #6264 这台电脑上端口占用的两种真探法(port-forward.ts 的 isLocalPortFree 用它们):
 * 能不能占住(没有 IPv6 的机器上 ::1 / :: 不存在,不算占用)、连不连得上(有人在听就连得上)。
 */
import net from 'node:net';
import type { LocalPortProbes } from './port-forward';

export const localPortProbes: LocalPortProbes = {
  canListen: (port, host) =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', (error: NodeJS.ErrnoException) => {
        resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT');
      });
      server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
    }),
  canConnect: (port, host) =>
    new Promise((resolve) => {
      const socket = net.connect({ port, host });
      const done = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(1_000, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    }),
};
