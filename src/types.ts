/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type DeviceType = "desktop" | "laptop" | "tablet" | "mobile" | "unknown";

export interface Peer {
  id: string;
  name: string;
  deviceType: DeviceType;
  userAgent: string;
  displayIp: string;
  roomCode: string;
  isSelf?: boolean;
}

export type TransferStatus =
  | "pending-auth" // Waiting for receiver to accept the file transfer
  | "connecting"   // Trying to connect WebRTC or preparing transfer
  | "transferring" // Chunks are currently flying
  | "completed"    // Success!
  | "rejected"     // Recipient said no thanks
  | "failed"       // Connection dropped or transfer failed
  | "canceled";    // Canceled by sender or receiver

export interface ActiveTransfer {
  transferId: string;
  peerId: string; // ID of the other party (sender/receiver)
  peerName: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  progress: number; // 0 to 100
  status: TransferStatus;
  direction: "incoming" | "outgoing";
  method: "webrtc" | "websocket";
  speed?: number; // Bytes per second
  bytesTransferred?: number;
  errorReason?: string;
}

export interface WSMessage {
  type: string;
  senderId?: string;
  targetId?: string;
  roomCode?: string;
  payload?: any;
}
