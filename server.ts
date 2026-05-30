/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import { DeviceType, Peer, WSMessage } from "./src/types";

// Setup random name components
const adjectives = [
  "Cosmic", "Solar", "Lunar", "Emerald", "Golden", "Silver", "Neon", "Aqua",
  "Swift", "Mystic", "Crimson", "Amber", "Cobalt", "Shadow", "Stellar",
  "Wild", "Quiet", "Frosty", "Flaring", "Zephyr", "Alpine", "Vibrant", "Jolly"
];

const animals = [
  "Fox", "Bear", "Panda", "Otter", "Falcon", "Eagle", "Koala", "Dolphin",
  "Cheetah", "Sloth", "Owl", "Wolf", "Tiger", "Rabbit", "Deer", "Squirrel",
  "Octopus", "Lynx", "Badger", "Puffin", "Penguin", "Seal", "Koala"
];

function generateRandomName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  return `${adj} ${animal}`;
}

function getDeviceType(userAgent: string): DeviceType {
  const ua = userAgent.toLowerCase();
  if (/mobile/i.test(ua)) {
    if (/ipad|tablet/i.test(ua)) return "tablet";
    return "mobile";
  }
  if (/tablet|ipad|playbook|silk/i.test(ua)) return "tablet";
  if (/macintosh|windows|linux|cros/i.test(ua)) {
    return "desktop";
  }
  return "unknown";
}

// Obfuscate IP for visual representation on client side
function obfuscateIp(ip: string): string {
  if (ip === "Localhost" || ip === "::1" || ip === "127.0.0.1") return "Localhost";
  
  // Clean IPv4 mapped IPv6
  const clean = ip.replace(/^::ffff:/, "");
  if (clean.includes(".")) {
    const parts = clean.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.***`;
    }
  }
  // Shorten IPv6
  if (clean.includes(":")) {
    const parts = clean.split(":");
    return `${parts.slice(0, Math.min(3, parts.length)).join(":")}::***`;
  }
  return "Local Network";
}

interface ConnectedPeer {
  id: string;
  name: string;
  deviceType: DeviceType;
  userAgent: string;
  joinedAt: number;
  ip: string;
  displayIp: string;
  roomCode: string;
  socket: WebSocket;
}

const peers = new Map<string, ConnectedPeer>();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Create standard HTTP server
  const server = http.createServer(app);

  // Initialize WebSocket Server
  const wss = new WebSocketServer({ noServer: true });

  // API router/endpoints
  app.get("/api/health", (req, res) => {
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
  });

  // Expose endpoint for clients to get their raw IP and automatic room code
  app.get("/api/ip-discovery", (req, res) => {
    // Resolve peer IP
    const forwarded = req.headers["x-forwarded-for"];
    let clientIp = "127.0.0.1";
    if (forwarded) {
      const list = Array.isArray(forwarded) ? forwarded : forwarded.split(",");
      clientIp = list[0].trim();
    } else {
      clientIp = req.socket.remoteAddress || "127.0.0.1";
    }
    
    // Clean mapped v6 address
    clientIp = clientIp.replace(/^::ffff:/, "");
    if (clientIp === "::1") clientIp = "127.0.0.1";

    const displayIp = obfuscateIp(clientIp);
    // Create automatic network-based room code
    const ipClean = clientIp.replace(/[^a-zA-Z0-9]/g, "-");
    const networkRoomCode = clientIp === "127.0.0.1" ? "local-sandbox" : `net-${ipClean}`;

    res.json({
      clientIp,
      displayIp,
      networkRoomCode,
    });
  });

  // Client IP Resolution helper for WebSockets
  function resolveSocketIp(req: http.IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      const list = Array.isArray(forwarded) ? forwarded : forwarded.split(",");
      return list[0].trim();
    }
    return req.socket.remoteAddress || "127.0.0.1";
  }

  // Handle active rooms state sync the instant someone joins or updates
  function broadcastPeerList(roomCode: string) {
    if (!roomCode) return;
    
    // Collect all peers in the same room
    const roomPeers: Peer[] = [];
    peers.forEach((peer) => {
      if (peer.roomCode === roomCode) {
        roomPeers.push({
          id: peer.id,
          name: peer.name,
          deviceType: peer.deviceType,
          userAgent: peer.userAgent,
          displayIp: peer.displayIp,
          roomCode: peer.roomCode,
        });
      }
    });

    // Send the structured peer list to all websockets in this room
    peers.forEach((peer) => {
      if (peer.roomCode === roomCode) {
        if (peer.socket.readyState === WebSocket.OPEN) {
          peer.socket.send(
            JSON.stringify({
              type: "peer-list",
              payload: {
                peers: roomPeers.map((p) => ({
                  ...p,
                  isSelf: p.id === peer.id,
                })),
              },
            })
          );
        }
      }
    });
  }

  // WebSocket Connection Handler
  wss.on("connection", (socket: WebSocket, req: http.IncomingMessage) => {
    const rawIp = resolveSocketIp(req);
    const clientIp = rawIp.replace(/^::ffff:/, "");
    const displayIp = obfuscateIp(clientIp);
    const ipClean = clientIp === "::1" || clientIp === "127.0.0.1" ? "local-sandbox" : clientIp.replace(/[^a-zA-Z0-9]/g, "-");
    const defaultRoomCode = clientIp === "::1" || clientIp === "127.0.0.1" ? "local-sandbox" : `net-${ipClean}`;

    const peerId = `p-${Math.random().toString(36).substring(2, 11)}`;
    const peerName = generateRandomName();
    const userAgent = req.headers["user-agent"] || "";
    const devType = getDeviceType(userAgent);

    const peerObj: ConnectedPeer = {
      id: peerId,
      name: peerName,
      deviceType: devType,
      userAgent,
      joinedAt: Date.now(),
      ip: clientIp,
      displayIp,
      roomCode: defaultRoomCode,
      socket,
    };

    peers.set(peerId, peerObj);

    // Immediately send greeting details to the joined device
    socket.send(
      JSON.stringify({
        type: "welcome",
        payload: {
          id: peerId,
          name: peerName,
          deviceType: devType,
          displayIp,
          roomCode: defaultRoomCode,
        },
      })
    );

    // Join room & notify existing users
    broadcastPeerList(defaultRoomCode);

    // Socket message routes
    socket.on("message", (rawMessage) => {
      try {
        const message: WSMessage = JSON.parse(rawMessage.toString());
        
        switch (message.type) {
          case "join-room": {
            const { roomCode, customName } = message.payload || {};
            const oldRoom = peerObj.roomCode;
            
            // Clear or update details
            if (customName && customName.trim().length > 0) {
              peerObj.name = customName.trim().substring(0, 30);
            }
            
            if (roomCode && roomCode.trim().length > 0) {
              // Standardize roomCode to lowercase visual string
              const newRoom = roomCode.trim().toLowerCase().substring(0, 40);
              peerObj.roomCode = newRoom;

              // Broadcast old room update
              if (oldRoom !== newRoom) {
                broadcastPeerList(oldRoom);
              }
              broadcastPeerList(newRoom);
            } else {
              // Just a name update in the current room
              broadcastPeerList(peerObj.roomCode);
            }
            break;
          }

          // Relay dynamic WebRTC Signaling / Client-to-Client File Signaling
          case "signal":
          case "transfer-request":
          case "transfer-response":
          case "relay-chunk":
          case "relay-complete":
          case "relay-cancel": {
            if (!message.targetId) return;
            const targetPeer = peers.get(message.targetId);
            if (targetPeer && targetPeer.socket.readyState === WebSocket.OPEN) {
              // Forward exact event with the sender's dynamic info populated
              targetPeer.socket.send(
                JSON.stringify({
                  ...message,
                  senderId: peerId, // Lock the real peerId as the true sender field
                })
              );
            }
            break;
          }

          case "heartbeat": {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "heartbeat" }));
            }
            break;
          }

          default:
            console.log(`Unmatched ws message type: ${message.type}`);
        }
      } catch (err) {
        console.error("Socket signal decoding error", err);
      }
    });

    socket.on("close", () => {
      const room = peerObj.roomCode;
      peers.delete(peerId);
      broadcastPeerList(room);
    });

    socket.on("error", (err) => {
      console.error(`Socket error error on ${peerId}:`, err);
      const room = peerObj.roomCode;
      peers.delete(peerId);
      broadcastPeerList(room);
    });
  });

  // Upgrade active Express HTTP requests to WebSockets gracefully on port 3000
  server.on("upgrade", (request, reqSocket, head) => {
    const pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname;
    
    if (pathname === "/ws") {
      wss.handleUpgrade(request, reqSocket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      reqSocket.destroy();
    }
  });

  // Set up development or production environment
  if (process.env.NODE_ENV !== "production") {
    // Vite middleware for real-time asset rendering and hot modules during developer flow
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production static folder serving
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Bind server strictly on 0.0.0.0 and port 3000, as dictated by infrastructure
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server launched and listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Express initialization crashed during cold-start:", error);
});
