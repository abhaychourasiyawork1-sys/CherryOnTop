import type { JSX } from 'react';
import type { DemoTimelineEvent } from '../demo/data';

export function ExecutionTimeline(props: {
  events: DemoTimelineEvent[];
  activeIndex: number;
}): JSX.Element {
  const { events, activeIndex } = props;
  const visibleEvents = events.filter((_, index) => index <= activeIndex);

  return (
    <ol className="execution-timeline">
      {visibleEvents.map((event, index) => (
        <li
          key={event.id}
          className={`execution-timeline__event${
            index === activeIndex ? ' execution-timeline__event--active' : ''
          }`}
        >
          <span className="execution-timeline__time">{event.time}</span>
          <span className="execution-timeline__label">{event.label}</span>
          {event.detail ? <span className="execution-timeline__detail">{event.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}
