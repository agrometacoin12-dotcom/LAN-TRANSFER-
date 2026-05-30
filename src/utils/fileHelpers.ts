/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DeviceType } from "../types";

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec === 0) return "0 B/s";
  return `${formatBytes(bytesPerSec, 1)}/s`;
}

export function formatRemainingTime(bytesTotal: number, bytesDone: number, bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return "Calculating...";
  const remainingBytes = bytesTotal - bytesDone;
  const sec = Math.ceil(remainingBytes / bytesPerSec);
  if (sec < 60) return `${sec}s remaining`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s remaining`;
}

export function getFileIconColor(fileType: string): string {
  const t = fileType.toLowerCase();
  if (t.startsWith("image/")) return "text-emerald-400 bg-emerald-950/40 border-emerald-800/40";
  if (t.startsWith("video/")) return "text-violet-400 bg-violet-950/40 border-violet-800/40";
  if (t.startsWith("audio/")) return "text-fuchsia-400 bg-fuchsia-950/40 border-fuchsia-800/40";
  if (t.includes("pdf") || t.includes("document") || t.includes("text/")) {
    return "text-cyan-400 bg-cyan-950/40 border-cyan-800/40";
  }
  if (t.includes("zip") || t.includes("tar") || t.includes("rar") || t.includes("compressed")) {
    return "text-amber-400 bg-amber-950/40 border-amber-800/40";
  }
  return "text-slate-400 bg-slate-950/40 border-slate-800/40";
}
