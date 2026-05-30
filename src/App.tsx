/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from "react";
import { 
  Laptop, 
  Smartphone, 
  Tablet, 
  Monitor, 
  Wifi, 
  WifiOff, 
  RefreshCw, 
  File, 
  Download, 
  CheckCircle2, 
  X, 
  AlertCircle, 
  Loader2, 
  QrCode, 
  Check, 
  Plus, 
  Edit3, 
  TrendingUp, 
  SlidersHorizontal,
  ChevronRight,
  ShieldCheck,
  Send,
  Sparkles,
  Info
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { ActiveTransfer, Peer, DeviceType, WSMessage } from "./types";
import { formatBytes, formatSpeed, formatRemainingTime, getFileIconColor } from "./utils/fileHelpers";
import QRCodeGenerator from "./components/QRCodeGenerator";

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const WEBRTC_SETUP_TIMEOUT = 5000; // 5s timeout to trigger WebSocket fallback

export default function App() {
  // Connection states
  const [socketConnected, setSocketConnected] = useState(false);
  const [self, setSelf] = useState<Peer | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [roomCode, setRoomCode] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [customName, setCustomName] = useState("");
  const [displayIp, setDisplayIp] = useState("Local Network");
  
  // Transfer states
  const [activeTransfers, setActiveTransfers] = useState<ActiveTransfer[]>([]);
  const [incomingRequest, setIncomingRequest] = useState<{
    transferId: string;
    senderId: string;
    senderName: string;
    fileName: string;
    fileSize: number;
    fileType: string;
  } | null>(null);

  // UI state
  const [dragActive, setDragActive] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [showRoomSettings, setShowRoomSettings] = useState(false);
  const [showNameModal, setShowNameModal] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [hoveredPeer, setHoveredPeer] = useState<string | null>(null);
  const [selectedFileForPrompt, setSelectedFileForPrompt] = useState<File | null>(null);
  const [showTargetSelectModal, setShowTargetSelectModal] = useState(false);

  // Connection refs
  const wsRef = useRef<WebSocket | null>(null);
  const pcRefs = useRef<{ [txId: string]: RTCPeerConnection }>({});
  const dcRefs = useRef<{ [txId: string]: RTCDataChannel }>({});
  const fileRefs = useRef<{ [txId: string]: File }>({});
  
  // Receival assembly structures
  const receivedChunks = useRef<{ [txId: string]: ArrayBuffer[] }>({});
  const receivedWSChunks = useRef<{ [txId: string]: { [index: number]: ArrayBuffer } }>({});
  const receivedWSLengths = useRef<{ [txId: string]: number }>({});
  
  // Cancellation handles
  const cancelRefs = useRef<{ [txId: string]: boolean }>({});
  
  // Stats tracking for download speeds
  const lastProgressTime = useRef<{ [txId: string]: number }>({});
  const lastProgressBytes = useRef<{ [txId: string]: number }>({});

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const targetPeerIdRef = useRef<string | null>(null);

  // Helper: send socket messages
  const sendWS = (msg: WSMessage) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  };

  // Convert ArrayBuffer to Base64 in chunks
  const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  };

  const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
  };

  // Establish live server-side WebSocket on cold start
  useEffect(() => {
    const initWS = () => {
      const loc = window.location;
      const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${loc.host}/ws`;

      console.log("Connecting browser file-share socket on URL:", wsUrl);
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        setSocketConnected(true);
      };

      socket.onclose = () => {
        setSocketConnected(false);
        setSelf(null);
        setPeers([]);
        // Trigger auto reconnect
        setTimeout(initWS, 3000);
      };

      socket.onerror = (err) => {
        console.error("LAN channel connection failed:", err);
        socket.close();
      };

      socket.onmessage = async (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);
          
          switch (message.type) {
            case "welcome": {
              const { id, name, deviceType, displayIp, roomCode: rCode } = message.payload;
              setSelf({ id, name, deviceType, userAgent: "", displayIp, roomCode: rCode, isSelf: true });
              setRoomCode(rCode);
              setRoomInput(rCode);
              setCustomName(name);
              setNameInput(name);
              setDisplayIp(displayIp);

              // Auto-join if standard URL room query is present (sharespace capability)
              const params = new URLSearchParams(window.location.search);
              const paramRoom = params.get("sharedRoom");
              if (paramRoom && paramRoom !== rCode) {
                socket.send(JSON.stringify({
                  type: "join-room",
                  payload: { roomCode: paramRoom, customName: name }
                }));
                setRoomCode(paramRoom);
                setRoomInput(paramRoom);
              }
              break;
            }

            case "peer-list": {
              const { peers: peerList } = message.payload;
              // Safely extract our record
              const selfInList = peerList.find((p: any) => p.isSelf);
              if (selfInList) {
                setSelf(selfInList);
                setRoomCode(selfInList.roomCode);
                setCustomName(selfInList.name);
              }
              // Set other peers
              setPeers(peerList.filter((p: any) => !p.isSelf));
              break;
            }

            case "transfer-request": {
              const { transferId, fileName, fileSize, fileType } = message.payload;
              setIncomingRequest({
                transferId,
                senderId: message.senderId!,
                senderName: peers.find(p => p.id === message.senderId)?.name || "Unknown Device",
                fileName,
                fileSize,
                fileType,
              });
              break;
            }

            case "transfer-response": {
              const { transferId, accepted } = message.payload;
              handleTransferAuthorized(transferId, accepted, message.senderId!);
              break;
            }

            case "signal": {
              const { transferId, sdp, candidate, fallbackToWebSocket } = message.payload;
              if (fallbackToWebSocket) {
                switchToWebSocketRelay(transferId, "webrtc-handshake-failure");
              } else {
                handleWebRTCSignal(transferId, message.senderId!, sdp, candidate);
              }
              break;
            }

            case "relay-chunk": {
              const { transferId, chunkIndex, totalChunks, data } = message.payload;
              handleWebSocketChunkReceived(transferId, message.senderId!, chunkIndex, totalChunks, data);
              break;
            }

            case "relay-complete": {
              const { transferId } = message.payload;
              handleWebSocketTransferCompleted(transferId);
              break;
            }

            case "relay-cancel": {
              const { transferId } = message.payload;
              handleTransferCanceledByRemote(transferId, "Canceled by peer");
              break;
            }

            case "heartbeat":
              // Heartbeat verified
              break;
          }
        } catch (error) {
          console.error("Critical failure during client packet parse:", error);
        }
      };
    };

    initWS();

    // Setup active websocket heartbeat to stay open on Cloud Run paths
    const keepalive = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 25000);

    return () => {
      clearInterval(keepalive);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Update room URL query params when roomCode changes
  useEffect(() => {
    if (roomCode) {
      const url = new URL(window.location.href);
      url.searchParams.set("sharedRoom", roomCode);
      window.history.replaceState({}, "", url.toString());
    }
  }, [roomCode]);

  // Handle Drag & Drop triggers across full HTML view
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only deactivate if leaving visual container
    if (e.currentTarget.id === "body-wrapper") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      handleFileSelectedToPrepare(file);
    }
  };

  const handleFileSelectedToPrepare = (file: File) => {
    if (peers.length === 0) {
      alert("No active nearby devices found to target. Scan the QR code or share the link with another device to join!");
      return;
    }

    setSelectedFileForPrompt(file);

    // If exactly one peer nearby, default target immediately
    if (peers.length === 1) {
      startTransferProcess(peers[0].id, file);
      setSelectedFileForPrompt(null);
    } else {
      setShowTargetSelectModal(true);
    }
  };

  // Triggers manual device file browser click
  const triggerPeerFileSelect = (peerId: string) => {
    targetPeerIdRef.current = peerId;
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleManualFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0] && targetPeerIdRef.current) {
      const file = e.target.files[0];
      startTransferProcess(targetPeerIdRef.current, file);
      e.target.value = ""; // reset
    }
  };

  // Begin outgoing sharing handshake
  const startTransferProcess = (recipientId: string, file: File) => {
    const txId = `tx-${Math.random().toString(36).substring(2, 11)}`;
    const recipient = peers.find(p => p.id === recipientId);
    if (!recipient) return;

    // Cache local File handle securely in React Ref mapping
    fileRefs.current[txId] = file;
    cancelRefs.current[txId] = false;

    // Save transfer entry
    const newTx: ActiveTransfer = {
      transferId: txId,
      peerId: recipientId,
      peerName: recipient.name,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      progress: 0,
      status: "pending-auth",
      direction: "outgoing",
      method: "webrtc",
    };

    setActiveTransfers(prev => [newTx, ...prev]);

    // Send transfer proposal overlay via WebSockets
    sendWS({
      type: "transfer-request",
      targetId: recipientId,
      payload: {
        transferId: txId,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
      },
    });
  };

  // Accept incoming transfer request
  const acceptIncomingTransfer = () => {
    if (!incomingRequest) return;
    const { transferId, senderId, senderName, fileName, fileSize, fileType } = incomingRequest;

    cancelRefs.current[transferId] = false;

    const newTx: ActiveTransfer = {
      transferId,
      peerId: senderId,
      peerName: senderName,
      fileName,
      fileSize,
      fileType,
      progress: 0,
      status: "connecting",
      direction: "incoming",
      method: "webrtc",
    };

    setActiveTransfers(prev => [newTx, ...prev]);
    setIncomingRequest(null);

    // Send acceptance payload back
    sendWS({
      type: "transfer-response",
      targetId: senderId,
      payload: {
        transferId,
        accepted: true,
      },
    });
  };

  // Decline incoming transfer
  const declineIncomingTransfer = () => {
    if (!incomingRequest) return;
    const { transferId, senderId } = incomingRequest;

    sendWS({
      type: "transfer-response",
      targetId: senderId,
      payload: {
        transferId,
        accepted: false,
      },
    });

    setIncomingRequest(null);
  };

  // Handler on receiving authorization response
  const handleTransferAuthorized = (transferId: string, accepted: boolean, remotePeerId: string) => {
    setActiveTransfers(prev =>
      prev.map(t => {
        if (t.transferId === transferId) {
          return {
            ...t,
            status: accepted ? "connecting" : "rejected",
          };
        }
        return t;
      })
    );

    if (accepted) {
      // Start WebRTC Negotiation Pipeline immediately!
      initiateWebRTCConnection(transferId, remotePeerId);
    }
  };

  // WebRTC SENDER Initiation
  const initiateWebRTCConnection = async (transferId: string, recipientId: string) => {
    try {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      pcRefs.current[transferId] = pc;

      // Handle candidate exchange
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendWS({
            type: "signal",
            targetId: recipientId,
            payload: { transferId, candidate: event.candidate },
          });
        }
      };

      // Create outbound WebRTC Data channel
      const channel = pc.createDataChannel("file-transfer", { ordered: true });
      channel.binaryType = "arraybuffer";
      dcRefs.current[transferId] = channel;

      channel.onopen = () => {
        console.log(`WebRTC RTCDataChannel opened successfully for transfer: ${transferId}`);
        startSendingWebRTCChunks(transferId, channel);
      };

      channel.onerror = (err) => {
        console.error("RTC channel crashed:", err);
        switchToWebSocketRelay(transferId, "webrtc-channel-crash");
      };

      channel.onclose = () => {
        console.log("RTC Channel connection closed");
      };

      // Set fallback timer - if WebRTC fails to connect in 4.5 seconds, run WebSocket relay instead
      setTimeout(() => {
        const tx = activeTransfers.find(t => t.transferId === transferId);
        if (tx && channel.readyState !== "open" && tx.status === "connecting") {
          console.warn(`WebRTC handover timed out for ${transferId}. Directing client fallback to WebSocket Relay!`);
          switchToWebSocketRelay(transferId, "connection-timeout");
        }
      }, WEBRTC_SETUP_TIMEOUT);

      // Create Local WebRTC Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendWS({
        type: "signal",
        targetId: recipientId,
        payload: { transferId, sdp: offer },
      });

    } catch (e) {
      console.error("Failed to bootstrap outbound RTCPeerConnection, fallback immediately", e);
      switchToWebSocketRelay(transferId, "initiation-exception");
    }
  };

  // WebRTC Signal Packet routing (Offer SDP -> Answer -> Ice Candidate)
  const handleWebRTCSignal = async (transferId: string, remoteId: string, sdp: any, candidate: any) => {
    try {
      let pc = pcRefs.current[transferId];

      // If receiver doesn't have WebRTC initialized, create it (handles Offer SDP)
      if (!pc) {
        pc = new RTCPeerConnection(ICE_CONFIG);
        pcRefs.current[transferId] = pc;

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            sendWS({
              type: "signal",
              targetId: remoteId,
              payload: { transferId, candidate: event.candidate },
            });
          }
        };

        // Listen for incoming dynamic DataChannel on receiver side
        pc.ondatachannel = (event) => {
          const channel = event.channel;
          channel.binaryType = "arraybuffer";
          dcRefs.current[transferId] = channel;

          receivedChunks.current[transferId] = [];
          let bytesReceived = 0;

          // Target file size mapping
          const meta = activeTransfers.find(t => t.transferId === transferId);
          const expectedSize = meta?.fileSize || 0;

          channel.onmessage = (msgEvent) => {
            const data = msgEvent.data;
            if (typeof data === "string") {
              if (data === "EOF") {
                // Signal completion assembly
                assembleAndDownloadFile(transferId, receivedChunks.current[transferId]);
                cleanUpConnection(transferId);
                
                setActiveTransfers(prev =>
                  prev.map(t => (t.transferId === transferId ? { ...t, status: "completed", progress: 100 } : t))
                );
              }
            } else {
              // Sliced ArrayBuffer chunk
              receivedChunks.current[transferId].push(data);
              bytesReceived += data.byteLength;

              calculateProgressAndSpeed(transferId, bytesReceived, expectedSize);
            }
          };

          channel.onclose = () => {
             console.log("Receiver RTCDatachannel closed");
          };
        };
      }

      if (sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        if (sdp.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendWS({
            type: "signal",
            targetId: remoteId,
            payload: { transferId, sdp: answer },
          });
        }
      }

      if (candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }

    } catch (e) {
      console.error("WebRTC signal integration crashed, switching receiver fallback to socket state:", e);
      // Wait for sender to issue fallback signal
    }
  };

  // Outgoing WebRTC chunk sender
  const startSendingWebRTCChunks = (transferId: string, channel: RTCDataChannel) => {
    const file = fileRefs.current[transferId];
    if (!file) return;

    // WebRTC works optimal at smaller blocks to prevent UDP buffer overflow
    const WEBRTC_CHUNK_SIZE = 16384; // 16KB
    let offset = 0;
    
    const fileReader = new FileReader();

    const readNextSlice = () => {
      if (cancelRefs.current[transferId]) {
        channel.close();
        return;
      }
      const slice = file.slice(offset, offset + WEBRTC_CHUNK_SIZE);
      fileReader.readAsArrayBuffer(slice);
    };

    fileReader.onload = (e) => {
      const buffer = e.target?.result as ArrayBuffer;
      if (!buffer) return;

      // Ensure data limits do not clog RTC pipeline
      if (channel.bufferedAmount > 2000000) { // 2MB safety ceiling
        channel.onbufferedamountlow = () => {
          channel.onbufferedamountlow = null;
          safelySendBuffer();
        };
      } else {
        safelySendBuffer();
      }

      function safelySendBuffer() {
        try {
          channel.send(buffer);
          offset += buffer.byteLength;

          calculateProgressAndSpeed(transferId, offset, file.size);

          if (offset < file.size) {
            readNextSlice();
          } else {
            channel.send("EOF");
            cleanUpConnection(transferId);
            setActiveTransfers(prev =>
              prev.map(t => (t.transferId === transferId ? { ...t, status: "completed", progress: 100 } : t))
            );
          }
        } catch (err) {
          console.error("Data channel frame failed:", err);
          switchToWebSocketRelay(transferId, "channel-send-error");
        }
      }
    };

    readNextSlice();
  };

  // Calculate transfer stats, throttling render updates to save CPU
  const calculateProgressAndSpeed = (transferId: string, currentBytes: number, totalBytes: number) => {
    if (totalBytes === 0) return;

    const percentage = Math.min(100, Math.floor((currentBytes / totalBytes) * 100));
    const now = Date.now();

    const lastTime = lastProgressTime.current[transferId] || 0;
    const lastBytes = lastProgressBytes.current[transferId] || 0;

    let currentSpeed = 0;
    if (lastTime > 0) {
      const timeElapsed = (now - lastTime) / 1000; // in seconds
      if (timeElapsed >= 0.4) { // Throttle calculations to every 400ms for stable readings
        const bytesDiff = currentBytes - lastBytes;
        currentSpeed = bytesDiff / timeElapsed;
        
        lastProgressTime.current[transferId] = now;
        lastProgressBytes.current[transferId] = currentBytes;

        setActiveTransfers(prev =>
          prev.map(t => {
            if (t.transferId === transferId) {
              return {
                ...t,
                progress: percentage,
                bytesTransferred: currentBytes,
                speed: currentSpeed,
                status: "transferring",
              };
            }
            return t;
          })
        );
      }
    } else {
      // First tick initialize
      lastProgressTime.current[transferId] = now;
      lastProgressBytes.current[transferId] = currentBytes;

      setActiveTransfers(prev =>
        prev.map(t => (t.transferId === transferId ? { ...t, progress: percentage, bytesTransferred: currentBytes, status: "transferring" } : t))
      );
    }
  };

  // SWITCH TO WEBSOCKET FALLBACK (triggered transparently on RTC connection timeout or block)
  const switchToWebSocketRelay = async (transferId: string, reason: string) => {
    // Prevent double fallback triggers
    const tx = activeTransfers.find(t => t.transferId === transferId);
    if (!tx || tx.method === "websocket") return;

    console.log(`Failing back transfer: ${transferId} to WebSocket Relay. Reason: ${reason}`);

    // Update state to WebSocket
    setActiveTransfers(prev =>
      prev.map(t => {
        if (t.transferId === transferId) {
          return {
            ...t,
            method: "websocket",
            status: "transferring",
            progress: 0,
            bytesTransferred: 0,
            speed: 0
          };
        }
        return t;
      })
    );

    // Clean up any stale WebRTC connections
    cleanUpConnection(transferId);

    // If we are SENDER, inform receiver and start loading base64 chunks
    if (tx.direction === "outgoing") {
      // Send signal to receiver to align fallback
      sendWS({
        type: "signal",
        targetId: tx.peerId,
        payload: { transferId, fallbackToWebSocket: true },
      });

      startWebSocketRelayLoop(transferId, tx.peerId);
    } else {
      // Receiver prepares for WS chunks
      receivedWSChunks.current[transferId] = {};
    }
  };

  // WebSocket Outbound Slicing transfer
  const startWebSocketRelayLoop = async (transferId: string, recipientId: string) => {
    const file = fileRefs.current[transferId];
    if (!file) return;

    // Stable 48KB base64 chunk sizing (compatible with JSON bounds and server processing)
    const WS_CHUNK_SIZE = 48 * 1024;
    const totalChunks = Math.ceil(file.size / WS_CHUNK_SIZE);
    
    lastProgressTime.current[transferId] = Date.now();
    lastProgressBytes.current[transferId] = 0;

    for (let i = 0; i < totalChunks; i++) {
      if (cancelRefs.current[transferId]) {
        sendWS({ type: "relay-cancel", targetId: recipientId, payload: { transferId } });
        return;
      }

      const start = i * WS_CHUNK_SIZE;
      const end = Math.min(file.size, start + WS_CHUNK_SIZE);
      const slice = file.slice(start, end);

      try {
        const buffer = await slice.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);

        // Send base64 package through websocket
        sendWS({
          type: "relay-chunk",
          targetId: recipientId,
          payload: {
            transferId,
            chunkIndex: i,
            totalChunks,
            data: base64,
          }
        });

        calculateProgressAndSpeed(transferId, end, file.size);

        // 10ms pacing timeout allows browser UI event loops to operate smoothly
        await new Promise(resolve => setTimeout(resolve, 10));

      } catch (err) {
        console.error("Webpack slice loop error:", err);
        markTransferFailed(transferId, "Relay chunk preparation failed");
        return;
      }
    }

    // Finished sending all fragments, send complete packet
    sendWS({
      type: "relay-complete",
      targetId: recipientId,
      payload: { transferId }
    });

    setActiveTransfers(prev =>
      prev.map(t => (t.transferId === transferId ? { ...t, status: "completed", progress: 100 } : t))
    );
  };

  // Receiver handles inbound WebSocket fragment
  const handleWebSocketChunkReceived = (
    transferId: string,
    senderId: string,
    chunkIndex: number,
    totalChunks: number,
    base64Data: string
  ) => {
    // If incoming profile doesn't exist, instantiate
    let tx = activeTransfers.find(t => t.transferId === transferId);
    if (!tx) {
      // In worst-case race condition, add it
      const sender = peers.find(p => p.id === senderId);
      const newTx: ActiveTransfer = {
        transferId,
        peerId: senderId,
        peerName: sender?.name || "Unknown Device",
        fileName: "Relayed File",
        fileSize: 0,
        fileType: "application/octet-stream",
        progress: 0,
        status: "transferring",
        direction: "incoming",
        method: "websocket"
      };
      setActiveTransfers(prev => [newTx, ...prev]);
      tx = newTx;
    }

    if (!receivedWSChunks.current[transferId]) {
      receivedWSChunks.current[transferId] = {};
    }

    // Decode and push
    const decoded = base64ToArrayBuffer(base64Data);
    receivedWSChunks.current[transferId][chunkIndex] = decoded;

    // Increment absolute sizes
    const currentLength = (receivedWSLengths.current[transferId] || 0) + decoded.byteLength;
    receivedWSLengths.current[transferId] = currentLength;

    calculateProgressAndSpeed(transferId, currentLength, tx.fileSize || currentLength * (totalChunks - chunkIndex));
  };

  // Receiver processes completed WebSocket relay and triggers browser download
  const handleWebSocketTransferCompleted = (transferId: string) => {
    const tx = activeTransfers.find(t => t.transferId === transferId);
    const chunksObj = receivedWSChunks.current[transferId];
    
    if (!tx || !chunksObj) {
      markTransferFailed(transferId, "Relayed blocks lost or unavailable");
      return;
    }

    // Sort index map to guarantee perfect binary order
    const sortedIndices = Object.keys(chunksObj)
      .map(Number)
      .sort((a, b) => a - b);
    
    const partsArray: ArrayBuffer[] = sortedIndices.map(idx => chunksObj[idx]);

    assembleAndDownloadFile(transferId, partsArray);

    // Clean dictionary memory
    delete receivedWSChunks.current[transferId];
    delete receivedWSLengths.current[transferId];

    setActiveTransfers(prev =>
      prev.map(t => (t.transferId === transferId ? { ...t, status: "completed", progress: 100 } : t))
    );
  };

  // Cancels outbound or inbound transmission forcefully from our side
  const cancelTransfer = (transferId: string) => {
    cancelRefs.current[transferId] = true;
    
    // Send socket cancel signal to other client
    const tx = activeTransfers.find(t => t.transferId === transferId);
    if (tx) {
      sendWS({
        type: "relay-cancel",
        targetId: tx.peerId,
        payload: { transferId },
      });
    }

    cleanUpConnection(transferId);
    
    setActiveTransfers(prev =>
      prev.map(t => (t.transferId === transferId ? { ...t, status: "canceled" } : t))
    );
  };

  // Handles cancellations sent from the remote party
  const handleTransferCanceledByRemote = (transferId: string, reason: string) => {
    cleanUpConnection(transferId);
    setActiveTransfers(prev =>
      prev.map(t => (t.transferId === transferId ? { ...t, status: "canceled", errorReason: reason } : t))
    );
  };

  // Force local state failure
  const markTransferFailed = (transferId: string, reason: string) => {
    cleanUpConnection(transferId);
    setActiveTransfers(prev =>
      prev.map(t => (t.transferId === transferId ? { ...t, status: "failed", errorReason: reason } : t))
    );
  };

  // Final Assembler and Downloader
  const assembleAndDownloadFile = (transferId: string, parts: ArrayBuffer[]) => {
    const meta = activeTransfers.find(t => t.transferId === transferId);
    const fName = meta?.fileName || "shared-file";
    const fType = meta?.fileType || "application/octet-stream";

    try {
      const blob = new Blob(parts, { type: fType });
      const dlUrl = URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = dlUrl;
      link.download = fName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Free window memory allocate
      URL.revokeObjectURL(dlUrl);
    } catch (err) {
      console.error("Assembly downloader failed:", err);
    }
  };

  // Connection close and cleanup refs
  const cleanUpConnection = (transferId: string) => {
    if (dcRefs.current[transferId]) {
      try { dcRefs.current[transferId].close(); } catch {}
      delete dcRefs.current[transferId];
    }
    if (pcRefs.current[transferId]) {
      try { pcRefs.current[transferId].close(); } catch {}
      delete pcRefs.current[transferId];
    }
    delete lastProgressTime.current[transferId];
    delete lastProgressBytes.current[transferId];
  };

  // Join custom room code or customize display name
  const handleJoinCustomSettings = (e: React.FormEvent) => {
    e.preventDefault();
    
    const standardRoom = roomInput.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const finalName = nameInput.trim();

    if (standardRoom.length > 0) {
      sendWS({
        type: "join-room",
        payload: {
          roomCode: standardRoom,
          customName: finalName.length > 0 ? finalName : undefined,
        },
      });

      setRoomCode(standardRoom);
      setShowRoomSettings(false);
      setShowNameModal(false);
    }
  };

  // Quick join clean helper
  const handleQuickResetToLocalNetwork = () => {
    window.location.search = ""; // clear triggers
  };

  // Helper Device Icon Resolver
  const renderDeviceIcon = (type: DeviceType, className = "w-6 h-6") => {
    switch (type) {
      case "mobile":
        return <Smartphone className={className} />;
      case "tablet":
        return <Tablet className={className} />;
      case "laptop":
        return <Laptop className={className} />;
      case "desktop":
        return <Monitor className={className} />;
      default:
        return <Laptop className={className} />;
    }
  };

  // Select target device popup confirmation (multiple devices flow)
  const handleSelectPeerFromModal = (pId: string) => {
    if (selectedFileForPrompt) {
      startTransferProcess(pId, selectedFileForPrompt);
    }
    setSelectedFileForPrompt(null);
    setShowTargetSelectModal(false);
  };

  return (
    <div
      id="body-wrapper"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`min-h-screen bg-[#070313] text-purple-50 flex flex-col font-sans transition-all duration-500 relative overflow-x-hidden select-none outline-none ${
        dragActive ? "drop-zone-active" : ""
      }`}
    >
      {/* BACKGROUND GRAPHIC GRADIENTS (Vibrant Palette Theme) */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute -top-[30%] -left-[20%] w-[70%] h-[70%] rounded-full bg-gradient-to-br from-[#fc466b]/15 via-[#3f5efb]/5 to-transparent blur-[120px] animate-pulse" style={{ animationDuration: '14s' }} />
        <div className="absolute top-[20%] -right-[25%] w-[60%] h-[60%] rounded-full bg-gradient-to-bl from-[#ec4899]/12 via-[#8b5cf6]/8 to-transparent blur-[140px] animate-pulse" style={{ animationDuration: '20s' }} />
        <div className="absolute -bottom-[20%] left-[10%] w-[50%] h-[50%] rounded-full bg-gradient-to-tr from-[#06b6d4]/10 via-[#ec4899]/5 to-transparent blur-[110px] animate-pulse" style={{ animationDuration: '16s' }} />
      </div>

      {/* Hidden file input for triggering device browser select */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleManualFileInput}
      />

      {/* DRAG AND DROP ACTIVE FULLSCREEN OVERLAY */}
      <AnimatePresence>
        {dragActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-55 bg-[#0e071c]/95 backdrop-blur-md flex flex-col items-center justify-center border-4 border-dashed border-[#ec4899] m-4 rounded-3xl"
          >
            <motion.div
              initial={{ scale: 0.9, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 10 }}
              className="text-center p-8 max-w-md flex flex-col items-center"
            >
              <div className="w-20 h-20 bg-gradient-to-tr from-[#ec4899]/30 to-[#8b5cf6]/20 rounded-full flex items-center justify-center mb-6 border border-[#ec4899]/40 animate-pulse">
                <Download className="w-10 h-10 text-[#ec4899]" />
              </div>
              <h2 className="text-3xl font-display font-bold text-white mb-2 bg-gradient-to-r from-[#fc466b] to-[#3f5efb] bg-clip-text text-transparent">Drop it here!</h2>
              <p className="text-sm text-purple-200/80 leading-relaxed">
                Drop your file to instantly distribute and share with other devices on your local group.
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* TOP DECK HEADER BANNER */}
      <header className="border-b border-purple-950/50 bg-[#070313]/85 backdrop-blur-xl sticky top-0 z-40 px-6 py-4">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          
          {/* Logo Brand */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#fc466b] via-[#ec4899] to-[#8b5cf6] flex items-center justify-center shadow-lg shadow-pink-950/40">
              <RefreshCw className="w-5 h-5 text-white stroke-[2.5px] animate-[spin_8s_linear_infinite]" />
            </div>
            <div>
              <h1 className="text-xl font-display font-black leading-none tracking-tight bg-gradient-to-r from-pink-400 via-[#ec4899] to-indigo-300 bg-clip-text text-transparent">
                Local Share
              </h1>
              <div className="flex items-center gap-1.5 mt-1">
                <span className={`w-1.5 h-1.5 rounded-full ${socketConnected ? "bg-[#ec4899] animate-pulse shadow-[0_0_8px_#ec4899]" : "bg-rose-500"}`} />
                <span className="text-[10px] text-purple-300/70 uppercase tracking-widest font-mono">
                  {socketConnected ? "Local Network Discovery Active" : "Searching Network..."}
                </span>
              </div>
            </div>
          </div>

          {/* Network Settings & Quick Actions */}
          <div className="flex flex-wrap items-center gap-3">
            
            {/* Quick stats network room */}
            <div className="bg-[#120824]/65 border border-purple-900/20 rounded-xl px-3.5 py-1.5 flex items-center gap-2.5">
              <div className="p-1.5 bg-[#070313] rounded-lg text-[#ec4899]">
                <Wifi className="w-3.5 h-3.5" />
              </div>
              <div className="text-left">
                <div className="text-[10px] text-purple-300/40 uppercase tracking-widest font-mono leading-none">Space ID</div>
                <div className="text-xs font-mono font-medium text-purple-200 max-w-[130px] truncate">{roomCode || "loading..."}</div>
              </div>
            </div>

            {/* Rename tool */}
            {self && (
              <button
                id="btn-trigger-name"
                onClick={() => {
                  setNameInput(self.name);
                  setShowNameModal(true);
                }}
                className="bg-[#120824]/65 hover:bg-[#1a0e33]/90 text-purple-200 border border-purple-900/20 hover:border-purple-500/30 transition-all rounded-xl px-3 py-2 flex items-center gap-2 cursor-pointer text-xs active:scale-95"
              >
                {renderDeviceIcon(self.deviceType, "w-3.5 h-3.5 text-pink-400")}
                <span className="font-semibold max-w-[100px] truncate">{self.name}</span>
                <Edit3 className="w-3 h-3 text-purple-400" />
              </button>
            )}

            {/* Room setup tool */}
            <button
              id="btn-room-opts"
              onClick={() => setShowRoomSettings(!showRoomSettings)}
              className="bg-[#120824]/65 hover:bg-[#1a0e33]/90 text-purple-200 border border-purple-900/20 hover:border-purple-500/30 transition-all rounded-xl p-2.5 cursor-pointer active:scale-95 text-xs flex items-center justify-center"
              title="Change Share Room Code"
            >
              <SlidersHorizontal className="w-4 h-4 text-[#ec4899]" />
            </button>

            {/* QR Scanner tool */}
            <button
              id="btn-qr-display"
              onClick={() => setShowQrModal(true)}
              className="bg-gradient-to-r from-[#fc466b] to-[#ec4899] hover:from-[#f05c74] hover:to-[#f05c9f] text-white font-semibold transition-all shadow-[0_4px_12px_rgba(236,72,153,0.25)] rounded-xl px-4 py-2 flex items-center gap-1.5 cursor-pointer text-xs active:scale-95 border-none"
            >
              <QrCode className="w-3.5 h-3.5" />
              <span>Invite</span>
            </button>

          </div>
        </div>
      </header>

      <AnimatePresence>
        {showRoomSettings && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-b border-purple-950/40 bg-[#0c061a]/40 overflow-hidden"
          >
            <div className="max-w-xl mx-auto p-6">
              <form onSubmit={handleJoinCustomSettings} className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-display font-bold tracking-wide uppercase text-[#ec4899]">Join Custom Share Room</h3>
                  <button
                    type="button"
                    onClick={() => setShowRoomSettings(false)}
                    className="p-1 hover:bg-purple-950/50 rounded-lg text-purple-400 hover:text-purple-200"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                
                <p className="text-xs text-purple-300/70 leading-relaxed">
                  By default, everyone on your Wi-Fi or Local network automatically joins the same discovery group. Enter a customized Space ID below to partition and create a private file sharing room.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-purple-300/50 uppercase tracking-widest font-mono">Custom Room Code</label>
                    <input
                      type="text"
                      value={roomInput}
                      onChange={(e) => setRoomInput(e.target.value)}
                      placeholder="e.g. board-room-alpha"
                      className="w-full bg-[#070313] border border-purple-900/35 focus:border-[#ec4899]/85 focus:ring-1 focus:ring-[#ec4899]/50 rounded-xl px-3 py-2 text-xs font-mono text-purple-100 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-purple-300/50 uppercase tracking-widest font-mono">My Display Name</label>
                    <input
                      type="text"
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      placeholder="Customize device name"
                      className="w-full bg-[#070313] border border-purple-900/35 focus:border-[#ec4899]/85 focus:ring-1 focus:ring-[#ec4899]/50 rounded-xl px-3 py-2 text-xs text-purple-100 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="submit"
                    className="bg-gradient-to-r from-[#fc466b] to-[#ec4899] hover:from-[#fe5677] hover:to-[#f566a7] text-white font-bold px-4 py-2 rounded-xl text-xs cursor-pointer active:scale-95 flex items-center gap-1.5 border-none shadow-[0_2px_8px_rgba(236,72,153,0.15)]"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Apply Settings</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleQuickResetToLocalNetwork}
                    className="bg-[#120824]/60 border border-purple-900/30 text-purple-300 hover:bg-[#1a0e33] px-4 py-2 rounded-xl text-xs cursor-pointer"
                  >
                    Default Local Net
                  </button>
                </div>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* MAIN LAYOUT CANVAS */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-6 flex flex-col lg:flex-row gap-6 relative z-10">
        
        {/* DISCOVERY ORBIT TARGET CONSOLE (LEFT OR MIDDLE) */}
        <div className="flex-1 bg-[#120824]/30 backdrop-blur-md border border-purple-950/40 rounded-[2rem] p-8 flex flex-col items-center justify-center min-h-[460px] relative shadow-[0_8px_32px_0_rgba(139,92,246,0.05)]">
          
          {/* Diagnostic Overlay Info */}
          <div className="absolute top-4 left-6 flex items-center gap-1.5 text-[11px] text-purple-400/50 font-mono">
            <span>External IP Range:</span>
            <span className="text-purple-300/80">{displayIp}</span>
          </div>

          <div className="absolute top-4 right-6 flex items-center gap-1.5 text-[11px] text-purple-400/50 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-[#ec4899] animate-pulse shadow-[0_0_6px_#ec4899]" />
            <span>{peers.length} nearby</span>
          </div>

          <div className="w-full max-w-3xl flex flex-col items-center justify-center text-center">
            
            {/* CENTRAL RADAR LAYOUT */}
            <div className="relative w-72 h-72 mb-8 flex items-center justify-center">
              
              {/* Sonar Radar concentric lines */}
              <div className="absolute inset-0 rounded-full border border-purple-950/15 pointer-events-none" />
              <div className="absolute inset-6 rounded-full border border-purple-900/20 ring-1 ring-purple-950/10 pointer-events-none" />
              <div className="absolute inset-16 rounded-full border border-[#ec4899]/10 pointer-events-none" />
              <div className="absolute inset-28 rounded-full border border-[#8b5cf6]/20 pointer-events-none" />

              {/* Dynamic pulsing radar frames */}
              <div className="absolute inset-16 rounded-full border border-[#ec4899]/30 radar-ring-1 pointer-events-none" />
              <div className="absolute inset-16 rounded-full border border-[#8b5cf6]/30 radar-ring-2 pointer-events-none" />
              <div className="absolute inset-16 rounded-full border border-[#06b6d4]/25 radar-ring-3 pointer-events-none" />

              {/* CENTER: YOU PROFILE */}
              <div className="relative z-20 flex flex-col items-center justify-center">
                <div className="w-20 h-20 bg-[#0d071d] border-2 border-[#ec4899] rounded-full flex flex-col items-center justify-center shadow-xl shadow-pink-950/30">
                  <div className="p-1.5 bg-[#ec4899]/10 text-[#ec4899] rounded-xl mb-1">
                    {self ? renderDeviceIcon(self.deviceType, "w-6 h-6") : <Loader2 className="w-6 h-6 animate-spin text-[#ec4899]" />}
                  </div>
                  <span className="text-[10px] font-bold font-mono tracking-wider text-[#ec4899] uppercase">You</span>
                </div>
              </div>

              {/* ORBITING/NEARBY DISCOVERED DEVICES */}
              {peers.map((peer, i) => {
                // Compute mathematical layouts corresponding to elegant circle distribution
                const angle = (i * (360 / peers.length) * Math.PI) / 180;
                const radius = 104; // pixel offset from circle center
                const x = Math.round(Math.sin(angle) * radius);
                const y = Math.round(-Math.cos(angle) * radius);

                return (
                  <motion.div
                    key={peer.id}
                    id={`peer-avatar-${peer.id}`}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1, x, y }}
                    exit={{ scale: 0, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 100, damping: 15 }}
                    onMouseEnter={() => setHoveredPeer(peer.id)}
                    onMouseLeave={() => setHoveredPeer(null)}
                    onClick={() => triggerPeerFileSelect(peer.id)}
                    className="absolute z-30 cursor-pointer group focus:outline-none"
                    style={{ left: "calc(50% - 40px)", top: "calc(50% - 40px)" }}
                  >
                    <div className="flex flex-col items-center text-center w-20">
                      
                      {/* Avatar design */}
                      <div className="relative">
                        <div className="w-14 h-14 bg-[#140a2c] hover:bg-[#1f103f] border border-purple-950/50 group-hover:border-[#ec4899] rounded-2xl flex items-center justify-center shadow-lg transition-all duration-300 transform group-hover:scale-110 group-active:scale-95">
                          {renderDeviceIcon(peer.deviceType, "w-6 h-6 text-purple-200 group-hover:text-[#ec4899] transition-colors")}
                        </div>
                        
                        {/* Glow halo */}
                        <div className="absolute -inset-1.5 border border-[#ec4899]/0 group-hover:border-[#ec4899]/20 rounded-3xl transition-all duration-300 pointer-events-none shadow-[0_0_15px_rgba(236,72,153,0)] group-hover:shadow-[0_0_15px_rgba(236,72,153,0.15)]" />
                      </div>

                      {/* Info layout */}
                      <span className="text-[11px] font-semibold text-purple-150 mt-2 truncate w-full font-sans group-hover:text-pink-300">
                        {peer.name}
                      </span>
                      
                      {/* Sub IP text display */}
                      <span className="text-[9px] text-purple-400/40 font-mono">
                        {peer.displayIp}
                      </span>

                    </div>
                  </motion.div>
                );
              })}

            </div>

            {/* DECK CONTROLLER / EXPLAINERS */}
            {peers.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                className="max-w-md p-6 bg-[#120824]/40 rounded-3xl border border-purple-900/30 shadow-lg"
              >
                <div className="flex justify-center mb-4">
                  <div className="p-3 bg-[#070313] rounded-2xl text-purple-400 ring-2 ring-purple-900/20">
                    <WifiOff className="w-6 h-6 animate-pulse text-[#ec4899]" />
                  </div>
                </div>
                <h4 className="text-sm font-display font-bold text-purple-100 mb-1.5">No other devices found on network</h4>
                <p className="text-xs text-purple-300/70 leading-relaxed mb-4">
                  Open this application URL on another smartphone, computer, or tablet running on the same network to start immediate sharing!
                </p>

                {/* QR Code trigger layout */}
                <div className="flex flex-col items-center justify-center p-3.5 bg-[#070313]/95 rounded-2xl border border-purple-950/50">
                  <span className="text-[10px] font-mono font-medium text-[#ec4899] mb-3 block uppercase tracking-widest">Instant Scan Access</span>
                  <QRCodeGenerator url={window.location.href} />
                </div>
              </motion.div>
            ) : (
              <div className="max-w-md">
                <div className="inline-flex items-center gap-1.5 py-1 px-3 bg-[#ec4899]/10 border border-[#ec4899]/20 text-[#ec4899] text-xs rounded-full font-medium font-mono mb-3">
                  <Sparkles className="w-3 h-3 animate-spin text-[#ec4899]" />
                  <span>Interactive Sonar Deck Active</span>
                </div>
                <p className="text-xs text-purple-300/80 leading-relaxed">
                  To send a file, simply <strong className="text-pink-300">click on any discovered device card</strong> orbiting the radar scan above, or just <strong className="text-pink-300">drag and drop a file anywhere</strong> on this screen.
                </p>
              </div>
            )}

          </div>
        </div>

        {/* SIDEBAR CONSOLE: LOGS, OUTBOX & DETAILS (RIGHT) */}
        <div className="w-full lg:w-96 flex flex-col gap-6">
          
          {/* ACTIVE & HISTORIC FILE SHARING HUB */}
          <div className="bg-[#120824]/30 backdrop-blur-md border border-purple-950/40 rounded-[2rem] p-6 flex-1 flex flex-col min-h-[300px]">
            <h3 className="text-xs font-display font-bold text-purple-400/80 uppercase tracking-widest mb-4 flex items-center justify-between">
              <span>Transfer Manager</span>
              <span className="bg-[#070313] text-[#ec4899] text-[10px] font-mono px-2 py-0.5 rounded-lg border border-purple-950/50">
                {activeTransfers.length} jobs
              </span>
            </h3>

            {activeTransfers.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-6 border border-dashed border-purple-900/30 rounded-2xl">
                <File className="w-8 h-8 text-purple-900/40 mb-3" />
                <h4 className="text-xs font-bold text-purple-200/90 mb-1">Queue is empty</h4>
                <p className="text-[11px] text-purple-400/70 leading-relaxed max-w-[210px]">
                  Files being sent or received will show up here in real-time.
                </p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-3.5 max-h-[460px] pr-1">
                <AnimatePresence initial={false}>
                  {activeTransfers.map((tx) => {
                    const isOutgoing = tx.direction === "outgoing";
                    const isCompleted = tx.status === "completed";
                    const isFailed = tx.status === "failed";
                    const isRejected = tx.status === "rejected";
                    const isCanceled = tx.status === "canceled";
                    const isPending = tx.status === "pending-auth";
                    const isConnecting = tx.status === "connecting";
                    const isTransferring = tx.status === "transferring";
                    
                    const timeRemainingString = isTransferring && tx.speed
                      ? formatRemainingTime(tx.fileSize, tx.bytesTransferred || 0, tx.speed)
                      : "";

                    return (
                      <motion.div
                        key={tx.transferId}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="p-4 bg-[#0e071c]/60 border border-purple-900/25 rounded-2xl flex flex-col gap-3 relative overflow-hidden transition-all duration-300"
                      >
                        {/* Glowing progress accent halo */}
                        {isTransferring && (
                          <div 
                            className="absolute bottom-0 left-0 h-1 bg-gradient-to-r from-[#fc466b] via-[#ec4899] to-[#8b5cf6] transition-all duration-300" 
                            style={{ width: `${tx.progress}%` }}
                          />
                        )}

                        {/* Top Metadata row */}
                        <div className="flex items-start justify-between gap-2.5">
                          
                          <div className="flex items-center gap-2.5">
                            <div className={`p-2 border rounded-xl flex items-center justify-center ${getFileIconColor(tx.fileType)}`}>
                              <File className="w-5 h-5 animate-pulse text-[#ec4899]" />
                            </div>
                            <div className="text-left w-48">
                              <h4 className="text-xs font-bold text-purple-100 truncate" title={tx.fileName}>
                                {tx.fileName}
                              </h4>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[10px] text-purple-350 font-mono font-medium">
                                  {formatBytes(tx.fileSize)}
                                </span>
                                <span className="text-[9px] text-purple-400/30">•</span>
                                <span className="text-[10px] text-purple-350 font-mono capitalize">
                                  {isOutgoing ? "To" : "From"}: <strong className="text-pink-400 font-bold">{tx.peerName}</strong>
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Close/Cancel Trigger */}
                          {(isPending || isConnecting || isTransferring) && (
                            <button
                              id={`cancel-tx-${tx.transferId}`}
                              onClick={() => cancelTransfer(tx.transferId)}
                              className="p-1 hover:bg-[#1a0e33] rounded-lg text-purple-450 hover:text-[#ec4899] transition-colors cursor-pointer"
                              title="Cancel Transfer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>

                        {/* Middle Stat bar indicators */}
                        {isTransferring && (
                          <div className="flex items-center justify-between text-[10px] font-mono text-purple-300 bg-[#070313]/90 p-2 rounded-lg border border-purple-950/40">
                            <span className="flex items-center gap-1">
                              <TrendingUp className="w-3 h-3 text-[#ec4899]" />
                              <span>{tx.speed ? formatSpeed(tx.speed) : "0 B/s"}</span>
                            </span>
                            <span>{timeRemainingString}</span>
                            <span className="text-pink-400 font-bold">{tx.progress}%</span>
                          </div>
                        )}

                        {/* Status Label Tags */}
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-purple-400/65 font-mono text-[9px] uppercase tracking-wider">
                            Method: {tx.method === "webrtc" ? "P2P WebRTC" : "Server Relay"}
                          </span>
                          
                          <div className="flex items-center gap-1">
                            {isCompleted && (
                              <span className="text-[#ec4899] font-semibold flex items-center gap-1 bg-[#ec4899]/10 px-2.5 py-0.5 rounded-lg border border-[#ec4899]/20">
                                <CheckCircle2 className="w-3 h-3" />
                                <span>Completed</span>
                              </span>
                            )}
                            {isFailed && (
                              <span className="text-rose-400 font-medium flex items-center gap-1 bg-rose-950/30 px-2 py-0.5 rounded-lg border border-rose-900/40" title={tx.errorReason}>
                                <AlertCircle className="w-3 h-3" />
                                <span>Failed</span>
                              </span>
                            )}
                            {isRejected && (
                              <span className="text-rose-400 font-medium flex items-center gap-1 bg-rose-950/30 px-2 py-0.5 rounded-lg border border-rose-850">
                                <AlertCircle className="w-3 h-3" />
                                <span>Declined</span>
                              </span>
                            )}
                            {isCanceled && (
                              <span className="text-purple-400 font-medium flex items-center gap-1 bg-[#070313] px-2 py-0.5 rounded-lg border border-purple-900/30">
                                <X className="w-3 h-3" />
                                <span>Canceled</span>
                              </span>
                            )}
                            {isPending && (
                              <span className="text-amber-400 text-[10px] font-mono font-semibold animate-pulse flex items-center gap-1 bg-amber-500/5 px-2 py-0.5 rounded-lg border border-amber-500/10">
                                <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
                                <span>Waiting for Acceptance</span>
                              </span>
                            )}
                            {isConnecting && (
                              <span className="text-pink-400/80 text-[10px] font-mono font-semibold animate-pulse flex items-center gap-1 bg-pink-500/5 px-2 py-0.5 rounded-lg border border-pink-500/10">
                                <Loader2 className="w-3 h-3 animate-spin text-[#ec4899] animate-spin-slow" />
                                <span>Negotiating P2P...</span>
                              </span>
                            )}
                          </div>
                        </div>

                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}
          </div>

          {/* SHARED SECURITY EXPLAINER CARDS */}
          <div className="bg-[#120824]/30 border border-purple-950/40 rounded-[2rem] p-6 space-y-4 shadow-[0_8px_32px_0_rgba(139,92,246,0.02)]">
            <h4 className="text-xs font-display font-black text-purple-200 uppercase tracking-widest flex items-center gap-1">
              <ShieldCheck className="w-4 h-4 text-[#ec4899]" />
              <span>Direct Link Security</span>
            </h4>
            <ul className="text-xs text-purple-300/80 space-y-2.5 leading-relaxed font-sans">
              <li className="flex gap-2">
                <ChevronRight className="w-3 px-0 text-[#ec4899] flex-shrink-0" />
                <span><strong className="text-pink-300/80">P2P WebRTC (Direct)</strong>: Files stream directly browser-to-browser. Your files are never uploaded or retained on any third-party disk server.</span>
              </li>
              <li className="flex gap-2">
                <ChevronRight className="w-3 px-0 text-[#ec4899] flex-shrink-0" />
                <span><strong className="text-pink-300/80">Express WebSocket Relay</strong>: If symmetric cellular NAT blocks P2P, we stream chunk-by-chunk in-memory over websockets. Data exists only transiently in RAM.</span>
              </li>
              <li className="flex gap-2">
                <ChevronRight className="w-3 px-0 text-[#ec4899] flex-shrink-0" />
                <span><strong className="text-pink-300/80">IPv4 Automatic Discovery</strong>: Group boundaries are defined inside our secure Express backend using sandboxed public gateway signatures.</span>
              </li>
            </ul>
          </div>

        </div>
      </main>

      {/* MODAL: INCOMING FILE TRANSFER AUTHORIZATION REQUEST */}
      <AnimatePresence>
        {incomingRequest && (
          <div className="fixed inset-0 bg-[#070313]/90 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0e071c] border border-[#ec4899]/35 rounded-3xl p-6 max-w-sm w-full shadow-2xl shadow-pink-950/20 relative"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-14 h-14 bg-pink-950/40 border border-[#ec4899]/40 rounded-full flex items-center justify-center mb-4">
                  <Download className="w-6 h-6 text-[#ec4899] animate-bounce" />
                </div>
                
                <h3 className="text-base font-display font-bold text-purple-100 mb-1">
                  Incoming File Share
                </h3>
                <p className="text-xs text-purple-350/80 leading-relaxed max-w-[240px]">
                  <b className="text-[#ec4899] font-black">{incomingRequest.senderName}</b> wants to send you a file:
                </p>

                {/* File box */}
                <div className="w-full bg-[#070313] rounded-2xl border border-purple-950/50 p-3.5 my-4 flex items-center gap-3">
                  <div className={`p-2 border rounded-xl ${getFileIconColor(incomingRequest.fileType)}`}>
                    <File className="w-5 h-5 text-[#ec4899]" />
                  </div>
                  <div className="text-left overflow-hidden flex-1">
                    <h4 className="text-xs font-bold text-purple-100 truncate" title={incomingRequest.fileName}>
                      {incomingRequest.fileName}
                    </h4>
                    <span className="text-[10px] text-purple-400 font-mono mt-0.5 block">
                      {formatBytes(incomingRequest.fileSize)}
                    </span>
                  </div>
                </div>

                <p className="text-[10px] text-purple-400/50 text-center mb-4 leading-normal">
                  Click accept to start direct browser-to-browser download.
                </p>

                {/* Confirm buttons */}
                <div className="grid grid-cols-2 gap-3.5 w-full">
                  <button
                    id="btn-incoming-decline"
                    onClick={declineIncomingTransfer}
                    className="py-2.5 px-4 text-xs font-bold bg-[#070313] border border-purple-900/30 hover:bg-[#1a0e33] text-purple-400 hover:text-rose-400 rounded-xl cursor-pointer active:scale-95 transition-all"
                  >
                    Decline
                  </button>
                  <button
                    id="btn-incoming-accept"
                    onClick={acceptIncomingTransfer}
                    className="py-2.5 px-4 text-xs font-bold bg-gradient-to-r from-[#fc466b] to-[#ec4899] hover:from-[#fe5677] hover:to-[#f566a7] text-white rounded-xl border-none cursor-pointer active:scale-95 transition-all flex items-center justify-center gap-1.5 shadow-[0_4px_12px_rgba(236,72,153,0.25)]"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Accept</span>
                  </button>
                </div>

              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL: QR INVITE SCAN OVERLAY */}
      <AnimatePresence>
        {showQrModal && (
          <div className="fixed inset-0 bg-[#070313]/90 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0e071c] border border-purple-950/50 rounded-3xl p-6 max-w-sm w-full shadow-2xl relative"
            >
              <button
                onClick={() => setShowQrModal(false)}
                className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-purple-950/50 text-purple-400 hover:text-purple-150 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex flex-col items-center">
                <div className="mb-4 p-2 bg-white rounded-2xl">
                  <QRCodeGenerator url={window.location.href} />
                </div>
                
                <h3 className="text-sm font-display font-bold text-purple-200 text-center mb-1">
                  Join Room: <span className="font-mono text-[#ec4899] font-black">{roomCode}</span>
                </h3>
                <p className="text-[11px] text-purple-400/80 text-center leading-relaxed">
                  Have teammates or other devices scan this code to make them instantly discoverable on this web page.
                </p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL: RENAME DISPLAY NAME */}
      <AnimatePresence>
        {showNameModal && (
          <div className="fixed inset-0 bg-[#070313]/95 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0e071c] border border-[#ec4899]/30 rounded-3xl p-6 max-w-xs w-full shadow-2xl relative"
            >
              <button
                onClick={() => setShowNameModal(false)}
                className="absolute top-4 right-4 p-1 rounded-lg hover:bg-[#140a2c] text-purple-400 hover:text-purple-200"
              >
                <X className="w-4 h-4" />
              </button>

              <form onSubmit={handleJoinCustomSettings} className="space-y-4">
                <h3 className="text-sm font-display font-black tracking-wide uppercase text-[#ec4899] block mb-1">Rename Device Profile</h3>
                
                <div className="space-y-1.5">
                  <label className="text-[10px] text-purple-400/60 uppercase tracking-widest font-mono">Profile Screen Name</label>
                  <input
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    placeholder="Enter screen name"
                    autoFocus
                    className="w-full bg-[#070313] border border-purple-900/40 focus:border-[#ec4899] focus:ring-1 focus:ring-[#ec4899]/50 rounded-xl px-3 py-2 text-xs text-purple-100 focus:outline-none"
                    maxLength={20}
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-gradient-to-r from-[#fc466b] to-[#ec4899] hover:from-[#fe5677] text-white font-bold py-2.5 rounded-xl border-none text-xs cursor-pointer active:scale-95 transition-all text-center"
                >
                  Save Profile Name
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL: MULTIPLE ACTIVE PEERS RECIPIENT SELECTION */}
      <AnimatePresence>
        {showTargetSelectModal && selectedFileForPrompt && (
          <div className="fixed inset-0 bg-[#070313]/90 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0e071c] border border-purple-950/50 rounded-3xl p-6 max-w-sm w-full shadow-2xl relative"
            >
              <button
                onClick={() => {
                  setSelectedFileForPrompt(null);
                  setShowTargetSelectModal(false);
                }}
                className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-purple-950/50 text-purple-400 hover:text-purple-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex flex-col">
                <h3 className="text-sm font-display font-black mb-1.5 text-purple-250 flex items-center gap-1.5">
                  <Send className="w-4 h-4 text-[#ec4899]" />
                  <span>Choose Recipient Device</span>
                </h3>
                <p className="text-xs text-purple-400/80 leading-relaxed mb-4">
                  Select which discovered device nearby you'd like to share this file with:
                </p>

                {/* Selected file card */}
                <div className="bg-[#070313]/90 rounded-xl border border-purple-950/50 p-2.5 mb-4 flex items-center gap-2.5">
                  <div className="p-1 px-1 text-[#ec4899] bg-[#ec4899]/10 border border-purple-950/30 rounded-lg">
                    <File className="w-4 h-4" />
                  </div>
                  <div className="overflow-hidden">
                    <div className="text-xs text-purple-100 font-bold truncate max-w-xs">{selectedFileForPrompt.name}</div>
                    <div className="text-[10px] text-purple-400/60 font-mono">{formatBytes(selectedFileForPrompt.size)}</div>
                  </div>
                </div>

                {/* Peers selection list */}
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {peers.map((peer) => (
                    <button
                      key={peer.id}
                      onClick={() => handleSelectPeerFromModal(peer.id)}
                      className="w-full bg-[#070313]/80 hover:bg-[#1c0f38]/90 hover:border-[#ec4899]/70 transition-colors border border-purple-950/50 p-3 rounded-xl flex items-center justify-between text-left cursor-pointer text-xs active:scale-98"
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-1.5 bg-[#0e071c] border border-purple-950/50 rounded-lg text-purple-300">
                          {renderDeviceIcon(peer.deviceType, "w-4 h-4 text-[#ec4899]/70")}
                        </div>
                        <div>
                          <div className="font-bold text-purple-100">{peer.name}</div>
                          <div className="text-[10px] text-purple-400/50 font-mono">{peer.displayIp}</div>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-purple-400/45" />
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* SIMPLE BOT DECK CREDITS LINE */}
      <footer className="py-6 border-t border-purple-950/35 text-center text-[11px] text-purple-400/40 font-sans gap-2 max-w-6xl w-full mx-auto px-6">
        <p className="flex justify-center items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-[#ec4899]" />
          <span>Secured by browser-direct network transport pipelines.</span>
        </p>
      </footer>
    </div>
  );
}
