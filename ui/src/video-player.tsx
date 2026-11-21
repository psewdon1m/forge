import { useEffect, useRef, useState } from 'react';
import type { AssetFormat, VideoFormat, VideoSelection } from './project-api';

export function videoFormat(format: AssetFormat): format is VideoFormat {
  return format === 'webm' || format === 'mp4';
}

function supportedSize({ videoWidth: width, videoHeight: height }: HTMLVideoElement) {
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_777_216;
}

function firstFrame(src: string, signal: AbortSignal) {
  return new Promise<string | null>(resolve => {
    if (signal.aborted) { resolve(null); return; }
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true;
    let complete = false;
    const timer = window.setTimeout(() => finish(null), 6500);
    const abort = () => finish(null);
    function finish(image: string | null) {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      video.onloadeddata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
      resolve(image);
    }
    signal.addEventListener('abort', abort, { once: true });
    video.onerror = () => finish(null);
    video.onloadeddata = () => {
      if (!supportedSize(video)) { finish(null); return; }
      const scale = Math.min(1, 360 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      try {
        const context = canvas.getContext('2d');
        if (!context) { finish(null); return; }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/png'));
      } catch { finish(null); }
    };
    video.src = src;
  });
}

export async function loadVideoPoster(input: VideoSelection, signal: AbortSignal) {
  const api = window.forge?.project;
  if (!api || signal.aborted) return null;
  let src: string | undefined;
  try {
    const reply = await api.videoOpen(input);
    if (!reply.ok) return null;
    src = reply.value.src;
    return await firstFrame(src, signal);
  } catch {
    return null;
  } finally {
    if (src) await api.videoRelease(src).catch(() => {});
  }
}

export function VideoPlayer({ projectId, nodeId, versionId, format, sourceRevision, name, poster, onClose }:
  VideoSelection & { name: string; poster?: string | null; onClose: () => void }) {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const lease = useRef<string | undefined>(undefined);
  const api = window.forge?.project;
  useEffect(() => {
    if (!api) return;
    let current = true;
    setSrc(undefined);
    setError('');
    void api.videoOpen({ projectId, nodeId, versionId, format, sourceRevision }).then(reply => {
      if (!reply.ok) {
        if (current) setError(reply.error.message);
        return;
      }
      if (!current) { void api.videoRelease(reply.value.src).catch(() => {}); return; }
      lease.current = reply.value.src;
      setSrc(reply.value.src);
    }).catch(() => { if (current) setError('The video could not be opened.'); });
    return () => {
      current = false;
      if (lease.current) void api.videoRelease(lease.current).catch(() => {});
      lease.current = undefined;
    };
  }, [api, projectId, nodeId, versionId, format, sourceRevision]);

  function failed(message: string) {
    setError(message);
    setSrc(undefined);
    if (lease.current) void api?.videoRelease(lease.current).catch(() => {});
    lease.current = undefined;
  }

  async function close() {
    if (closing) return;
    setClosing(true);
    setSrc(undefined);
    const active = lease.current;
    lease.current = undefined;
    if (active) await api?.videoRelease(active).catch(() => {});
    onClose();
  }

  return <section className="video-player" aria-label="Video player">
    <div className="file-actions"><strong>{name}</strong><button disabled={closing} onClick={() => { void close(); }}>Close video</button></div>
    {error && <p role="alert">{error}</p>}
    {!src && !error && <p role="status">{closing ? 'Closing video…' : 'Opening video…'}</p>}
    {src && <video aria-label={name} controls playsInline preload="metadata" poster={poster ?? undefined} src={src}
      disablePictureInPicture disableRemotePlayback controlsList="nodownload noremoteplayback"
      onLoadedMetadata={event => {
        if (!supportedSize(event.currentTarget)) failed('The video has no supported picture or exceeds the playback dimensions.');
      }}
      onError={() => failed('The local decoder could not play this video.')} />}
  </section>;
}
