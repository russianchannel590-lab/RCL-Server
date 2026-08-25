import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const app = express();

app.get('/', (_req, res) => {
  res.json({
    status: 'RCL WebSocket server',
    websocket: 'ready'
  });
});

const server = createServer(app);

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('RCL client connected');

  ws.send(JSON.stringify({
    type: 'connected',
    message: 'RCL WebSocket connection established'
  }));

  ws.on('message', (data) => {
    const message = data.toString();

    console.log('Received:', message);

    // Пока просто возвращаем сообщение обратно.
    ws.send(JSON.stringify({
      type: 'echo',
      message
    }));
  });

  ws.on('close', () => {
    console.log('RCL client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

export default server;
