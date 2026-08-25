import axios from 'axios';
import crypto from 'node:crypto';
import WebSocket from 'ws';

import { getRobloxIdByHwid, initDatabase } from './database.js';

const MAX_MESSAGE_LENGTH = 200;
const MAX_PAYLOAD_BYTES = 1024;

const SPAM_WINDOW_MS = 3000;
const MAX_IDENTICAL_MESSAGES = 3;

const channels = new Map();

const recentMessages = new Map();

function normalizeText(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isMessageAllowed(text, identifier) {
  if (typeof text !== 'string') {
    return {
      allowed: false,
      reason: 'invalid_message'
    };
  }

  const normalized = normalizeText(text);

  if (!normalized) {
    return {
      allowed: false,
      reason: 'empty_message'
    };
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    return {
      allowed: false,
      reason: 'message_too_long'
    };
  }

  const now = Date.now();

  let history = recentMessages.get(identifier) || [];

  history = history.filter(
    entry => now - entry.time < SPAM_WINDOW_MS
  );

  history.push({
    text: normalized,
    time: now
  });

  recentMessages.set(identifier, history);

  const identicalCount = history.filter(
    entry => entry.text === normalized
  ).length;

  if (identicalCount > MAX_IDENTICAL_MESSAGES) {
    return {
      allowed: false,
      reason: 'spam'
    };
  }

  return {
    allowed: true
  };
}

async function getRobloxUsername(robloxId) {
  try {
    const response = await axios.get(
      `https://users.roblox.com/v1/users/${robloxId}`,
      {
        timeout: 10000
      }
    );

    return response.data?.name || `User ${robloxId}`;
  } catch {
    return `User ${robloxId}`;
  }
}

async function identifyUser(hwid, guestName) {
  if (!hwid) {
    return {
      senderName: guestName,
      isVerified: false
    };
  }

  const robloxId = await getRobloxIdByHwid(hwid);

  if (!robloxId) {
    return {
      senderName: guestName,
      isVerified: false
    };
  }

  const username = await getRobloxUsername(robloxId);

  return {
    senderName: username,
    isVerified: true
  };
}

function broadcastToChannel(channelId, data) {
  const clients = channels.get(channelId);

  if (!clients) {
    return;
  }

  const message = JSON.stringify(data);

  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Broadcast error:', error);
      }
    }
  });
}

function removeFromChannel(ws) {
  if (!ws.currentChannel) {
    return;
  }

  const channelId = ws.currentChannel;

  const clients = channels.get(channelId);

  if (clients) {
    clients.delete(ws);

    if (clients.size === 0) {
      channels.delete(channelId);
    }
  }

  ws.currentChannel = null;
}

export function setupRclWebSocket(wss) {
  initDatabase().catch(error => {
    console.error('Initial database setup failed:', error);
  });

  wss.on('connection', (ws, req) => {
    const connectionId = crypto.randomUUID();

    const remotePort =
      req?.socket?.remotePort ||
      Math.floor(Math.random() * 9000) + 1000;

    ws.senderName = `Guest ${remotePort}`;
    ws.isVerified = false;
    ws.currentChannel = null;
    ws.connectionId = connectionId;

    console.log(
      `RCL client connected: ${ws.senderName} (${connectionId})`
    );

    ws.send(
      JSON.stringify({
        type: 'connected',
        message: 'RCL WebSocket connection established'
      })
    );

    ws.on('message', async rawData => {
      try {
        if (rawData.length > MAX_PAYLOAD_BYTES) {
          ws.send(
            JSON.stringify({
              status: 'rejected',
              reason: 'message_too_large'
            })
          );

          return;
        }

        const payload = JSON.parse(rawData.toString());

        // ------------------------------------------
        // JOIN
        // ------------------------------------------

        if (payload.type === 'join') {
          const channelId = payload.channelId;

          if (
            typeof channelId !== 'string' ||
            channelId.length === 0
          ) {
            ws.send(
              JSON.stringify({
                status: 'rejected',
                reason: 'invalid_channel'
              })
            );

            return;
          }

          removeFromChannel(ws);

          const identity = await identifyUser(
            payload.hwid,
            ws.senderName
          );

          ws.senderName = identity.senderName;
          ws.isVerified = identity.isVerified;

          if (!channels.has(channelId)) {
            channels.set(channelId, new Set());
          }

          channels.get(channelId).add(ws);
          ws.currentChannel = channelId;

          console.log(
            `${ws.senderName} joined ${channelId}`
          );

          ws.send(
            JSON.stringify({
              type: 'joined',
              channelId,
              sender: ws.senderName,
              verified: ws.isVerified
            })
          );

          return;
        }

        // ------------------------------------------
        // NORMAL CHAT MESSAGE
        // ------------------------------------------

        if (payload.type === 'message') {
          if (!ws.currentChannel) {
            return;
          }

          const moderation = isMessageAllowed(
            payload.text,
            ws.connectionId
          );

          if (!moderation.allowed) {
            ws.send(
              JSON.stringify({
                status: 'rejected',
                reason: moderation.reason,
                message:
                  'Message not sent due to community guidelines or server limits.'
              })
            );

            return;
          }

          broadcastToChannel(
            ws.currentChannel,
            {
              type: 'message',
              text: payload.text,
              sender: ws.senderName,
              verified: ws.isVerified,
              attributeScores: null
            }
          );

          return;
        }

        // ------------------------------------------
        // WHISPER
        // ------------------------------------------

        if (payload.type === 'whisper') {
          if (!ws.currentChannel) {
            return;
          }

          const moderation = isMessageAllowed(
            payload.text,
            ws.connectionId
          );

          if (!moderation.allowed) {
            ws.send(
              JSON.stringify({
                status: 'rejected',
                reason: moderation.reason
              })
            );

            return;
          }

          const targetName = payload.target;

          const clients = channels.get(
            ws.currentChannel
          );

          if (!clients) {
            return;
          }

          const whisperPayload = {
            type: 'whisper',
            text: payload.text,
            sender: ws.senderName,
            target: targetName,
            attributeScores: null
          };

          let found = false;

          clients.forEach(client => {
            if (client.senderName === targetName) {
              client.send(
                JSON.stringify({
                  ...whisperPayload,
                  isTo: false
                })
              );

              found = true;
            }
          });

          ws.send(
            JSON.stringify({
              ...whisperPayload,
              isTo: true
            })
          );

          if (!found) {
            ws.send(
              JSON.stringify({
                status: 'rejected',
                reason: 'not_found',
                target: targetName
              })
            );
          }

          return;
        }
      } catch (error) {
        console.error(
          'RCL WebSocket message error:',
          error
        );
      }
    });

    ws.on('close', () => {
      removeFromChannel(ws);

      console.log(
        `RCL client disconnected: ${ws.senderName}`
      );
    });

    ws.on('error', error => {
      console.error(
        `RCL WebSocket error (${ws.senderName}):`,
        error
      );
    });
  });
}
