import React, { useRef, useState } from "react";

interface AudioPlayerProps {
  src?: string;
  autoPlay?: boolean;
}

export function AudioPlayer({ src, autoPlay = false }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const handlePlayPause = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      el.play().catch(() => {});
    }
  };

  if (!src) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-violet-600/20 ring-1 ring-violet-500/20">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-violet-400/50" viewBox="0 0 24 24" fill="currentColor">
            <path fillRule="evenodd" d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653z" clipRule="evenodd" />
          </svg>
        </div>
        <div>
          <p className="text-xs text-slate-400">No audio</p>
          <p className="text-[10px] text-slate-600">0:00</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <audio
        ref={audioRef}
        src={src}
        autoPlay={autoPlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        className="hidden"
        aria-label="Assistant response audio"
      />

      {/* Play / Pause button */}
      <button
        type="button"
        onClick={handlePlayPause}
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-violet-600/30 ring-1 ring-violet-500/40 transition hover:bg-violet-600/50"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-violet-300" viewBox="0 0 24 24" fill="currentColor">
            <path fillRule="evenodd" d="M6.75 5.25a.75.75 0 01.75-.75H9a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H7.5a.75.75 0 01-.75-.75V5.25zm7 0a.75.75 0 01.75-.75H16a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75h-1.5a.75.75 0 01-.75-.75V5.25z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-violet-300" viewBox="0 0 24 24" fill="currentColor">
            <path fillRule="evenodd" d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653z" clipRule="evenodd" />
          </svg>
        )}
      </button>

      {/* Time display */}
      <div className="flex flex-col">
        <p className="text-xs text-slate-300">Assistant audio</p>
        <p className="font-mono text-[10px] text-slate-500">
          {formatTime(currentTime)}{duration > 0 ? ` / ${formatTime(duration)}` : ""}
        </p>
      </div>
    </div>
  );
}
