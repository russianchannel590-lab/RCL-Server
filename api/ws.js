import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { setupRclWebSocket } from '../server/rclWebSocket.js';

const app = express();

app.get('/', (_req, res) => {
  res.json({
    status: 'RCL WebSocket server',
    websocket: 'ready'
  });
});

const server = createServer(app);

const wss = new WebSocketServer({
  server,
  maxPayload: 1024
});

setupRclWebSocket(wss);

export default server;
