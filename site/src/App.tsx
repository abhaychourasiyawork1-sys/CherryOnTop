import type { JSX } from 'react';
import { Section } from './components/Section';
import { Reveal } from './components/Reveal';

export default function App(): JSX.Element {
  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="container">CherryOnTop</div>
      </header>

      <main>
        <Section id="product" title="AI teams you can hold accountable.">
          <h1>AI teams you can hold accountable.</h1>
        </Section>

        <Section id="how-it-works" title="See how it works">
          <Reveal>
            <p>Promo video placeholder.</p>
          </Reveal>
        </Section>

        <Section id="organization" title="One goal. An accountable AI organization.">
          <Reveal>
            <p>Organization exploration placeholder.</p>
          </Reveal>
        </Section>

        <Section id="mandate" title="Autonomy without a blank cheque.">
          <Reveal>
            <p>Mandate placeholder.</p>
          </Reveal>
        </Section>

        <Section id="execution" title="Real work doesn't always go perfectly.">
          <Reveal>
            <p>Execution placeholder.</p>
          </Reveal>
        </Section>

        <Section id="proof" title="Every important decision leaves a receipt.">
          <Reveal>
            <p>Decision receipt placeholder.</p>
          </Reveal>
        </Section>

        <Section id="memory" title="The organization remembers what it learned.">
          <Reveal>
            <p>Memory placeholder.</p>
          </Reveal>
        </Section>

        <Section id="benchmarks" title="Spend intelligence where it matters.">
          <Reveal>
            <p>Benchmark placeholder.</p>
          </Reveal>
        </Section>

        <Section id="architecture" title="Under the interface is a real execution system.">
          <Reveal>
            <p>Architecture placeholder.</p>
          </Reveal>
        </Section>

        <Section id="trust" title="Built to be inspected.">
          <Reveal>
            <p>Trust placeholder.</p>
          </Reveal>
        </Section>

        <Section id="launch" title="CherryOnTop is launching soon.">
          <Reveal>
            <p>Launch placeholder.</p>
          </Reveal>
        </Section>
      </main>

      <footer className="site-footer">
        <div className="container">CherryOnTop</div>
      </footer>
    </div>
  );
}
