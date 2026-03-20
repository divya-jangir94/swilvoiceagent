"use client";

import React from "react";
import { VoiceRecorder } from "@/components/VoiceRecorder";

// Main single-page UI that hosts the voice assistant experience.
export default function Page() {
  return (
    <div className="flex h-[calc(100vh-2rem)] w-full max-w-5xl items-stretch" style={{ maxHeight: "760px" }}>
      <VoiceRecorder />
    </div>
  );
}