import { useRef, useState, type JSX } from 'react';
import { track } from '../analytics/tracker';

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

  return (
    <div className="promo-video">
      <video
        ref={(node) => {
          if (node) {
            node.muted = true;
          }
        }}
        className="promo-video__player"
        aria-label={title}
        src={src}
        poster={poster}
        muted
        autoPlay
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
        <p className="promo-video__fallback">
          Watch the demonstration in the transcript below while the video is unavailable.
        </p>
      ) : null}
      <button
        type="button"
        className="promo-video__transcript-toggle"
        aria-expanded={transcriptOpen}
        onClick={() => setTranscriptOpen((open) => !open)}
      >
        {transcriptOpen ? 'Hide transcript' : 'Show transcript'}
      </button>
      {transcriptOpen ? (
        <div className="promo-video__transcript" data-testid="promo-video-transcript">
          {transcript}
        </div>
      ) : null}
    </div>
  );
}
