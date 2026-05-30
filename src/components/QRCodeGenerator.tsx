/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { QrCode, Copy, Check } from "lucide-react";

interface QRCodeGeneratorProps {
  url: string;
}

export default function QRCodeGenerator({ url }: QRCodeGeneratorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !url) return;

    QRCode.toCanvas(
      canvasRef.current,
      url,
      {
        width: 148,
        margin: 1,
        color: {
          dark: "#090d16", // Deep space dark tone
          light: "#ecfdf5", // Emerald light off-white
        },
      },
      (err) => {
        if (err) {
          console.error("QR Code rendering error", err);
          setError("Failed to render QR Code");
        } else {
          setError(null);
        }
      }
    );
  }, [url]);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy", err);
    }
  };

  return (
    <div id="qr-code-section" className="flex flex-col items-center bg-slate-900/60 backdrop-blur-md rounded-2xl border border-slate-800 p-5 w-full max-w-xs shadow-xl shadow-black/30">
      <div className="flex items-center gap-2 mb-3 text-slate-300">
        <QrCode className="w-4 h-4 text-emerald-400" />
        <span className="text-xs font-semibold tracking-wider uppercase font-mono">Scan to Join Group</span>
      </div>

      <div className="bg-emerald-50 rounded-xl p-2.5 shadow-inner flex items-center justify-center border border-emerald-950/20">
        {error ? (
          <div className="text-xs text-rose-500 font-mono text-center w-36 h-36 flex items-center justify-center">
            {error}
          </div>
        ) : (
          <canvas ref={canvasRef} className="rounded-lg w-[148px] h-[148px]" />
        )}
      </div>

      <p className="text-[11px] text-slate-400 text-center mt-3 leading-relaxed font-sans px-2">
        Open this app on other mobile devices or laptops connected to the same network.
      </p>

      <button
        id="btn-copy-address"
        onClick={copyToClipboard}
        className="mt-4 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg text-xs font-mono font-medium transition-all duration-300 w-full border border-slate-700/60 bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-emerald-400 cursor-pointer active:scale-95"
      >
        {copied ? (
          <>
            <Check className="w-3.5 h-3.5 text-emerald-400 animate-bounce" />
            <span className="text-emerald-400">Address Copied!</span>
          </>
        ) : (
          <>
            <Copy className="w-3.5 h-3.5" />
            <span>Copy App Link</span>
          </>
        )}
      </button>
    </div>
  );
}
