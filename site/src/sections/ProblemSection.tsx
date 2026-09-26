import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';

export function ProblemSection(): JSX.Element {
  const { problem } = SITE_CONTENT;
  return (
    <div className="problem">
      <h2 className="problem__headline">{problem.headline}</h2>
      <ul className="problem__questions">
        {problem.questions.map((question) => (
          <li key={question} className="problem__question">
            {question}
          </li>
        ))}
      </ul>
    </div>
  );
}
