import { useEffect, useRef, useState, type JSX } from 'react';
import { track } from '../analytics/tracker';
import { useReducedMotion } from '../hooks/useReducedMotion';

export function PromoVideo(props: {
  src: string;
  poster: string;
  transcript: string;
  title: string;
}): JSX.Element {
  const { src, poster, transcript, title } = props;
  const [errored, setErrored] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const startedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pausedOffscreenRef = useRef(false);
  // Poster-first: the video source is attached only once the player is near the viewport.
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === 'undefined');
  const reducedMotion = useReducedMotion();
  // A failed/missing video must never hide the story: the poster and transcript take over.
  const showTranscript = transcriptOpen || errored;

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const video = videoRef.current;
          if (entry.isIntersecting) {
            setNearViewport(true);
            if (video && pausedOffscreenRef.current) {
              pausedOffscreenRef.current = false;
              void video.play()?.catch(() => undefined);
            }
          } else if (video && !video.paused) {
            // Do not keep decoding a looping video nobody can see.
            pausedOffscreenRef.current = true;
            video.pause();
          }
        }
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="promo-video" ref={containerRef}>
      <video
        ref={(node) => {
          videoRef.current = node;
          if (node) {
            node.muted = true;
          }
        }}
        className="promo-video__player"
        aria-label={title}
        src={nearViewport ? src : undefined}
        poster={poster}
        muted
        autoPlay={!reducedMotion}
        playsInline
        controls
        loop
        preload="none"
        onError={() => setErrored(true)}
        onPlay={() => {
          if (!startedRef.current) {
            startedRef.current = true;
            track('video_started');
          }
        }}
      />
      {errored ? (
        <div className="promo-video__fallback" role="status">
          <img className="promo-video__fallback-poster" src={poster} alt={`${title} (poster)`} />
          <p>Watch the demonstration in the transcript below while the video is unavailable.</p>
        </div>
      ) : null}
      {errored ? null : (
        <button
          type="button"
          className="promo-video__transcript-toggle"
          aria-expanded={transcriptOpen}
          onClick={() => setTranscriptOpen((open) => !open)}
        >
          {transcriptOpen ? 'Hide transcript' : 'Show transcript'}
        </button>
      )}
      {showTranscript ? (
        <div id="promo-video-transcript" className="promo-video__transcript" data-testid="promo-video-transcript">
          {transcript}
        </div>
      ) : null}
    </div>
  );
}
