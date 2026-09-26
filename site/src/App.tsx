import type { JSX } from 'react';
import { Section } from './components/Section';
import { Reveal } from './components/Reveal';
import { HeroSection } from './sections/HeroSection';
import { PromoVideo } from './components/PromoVideo';
import { ProblemSection } from './sections/ProblemSection';
import { OrganizationSection } from './sections/OrganizationSection';
import { DemoControllerProvider } from './demo/controller';
import { SITE_CONTENT } from './content';

const PROMO_VIDEO_SRC = import.meta.env.VITE_PROMO_VIDEO_URL ?? '/media/cherryontop-promo.mp4';
const PROMO_VIDEO_POSTER = '/media/cherryontop-promo-poster.jpg';
const PROMO_VIDEO_TRANSCRIPT_URL = '/media/cherryontop-promo-transcript.txt';
const PROMO_VIDEO_TRANSCRIPT =
  'A single goal, "Build a customer platform," resolves into an accountable organization ' +
  '(Frontend, Backend, Data, Verification) operating under a budget and authority boundary. ' +
  'Execution runs, a verification check fails, the system investigates and corrects it, then ' +
  're-validates. The run ends VERIFIED with a Decision Receipt recording what happened.';

export default function App(): JSX.Element {
  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="container">CherryOnTop</div>
      </header>

      <main>
        <DemoControllerProvider>
          <section id="product" className="hero-section" aria-label="AI teams you can hold accountable.">
            <div className="container">
              <HeroSection />
            </div>
          </section>

          <Section id="how-it-works" title="See how it works">
            <Reveal>
              <PromoVideo
                src={PROMO_VIDEO_SRC}
                poster={PROMO_VIDEO_POSTER}
                transcript={PROMO_VIDEO_TRANSCRIPT}
                title="CherryOnTop product demonstration"
              />
              <a className="promo-video__transcript-link" href={PROMO_VIDEO_TRANSCRIPT_URL}>
                Open full transcript
              </a>
            </Reveal>
          </Section>

          <Section
            id="organization"
            title="One goal. An accountable AI organization."
            body={SITE_CONTENT.organization.body}
          >
            <Reveal>
              <ProblemSection />
            </Reveal>
            <Reveal>
              <OrganizationSection />
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
        </DemoControllerProvider>
      </main>

      <footer className="site-footer">
        <div className="container">CherryOnTop</div>
      </footer>
    </div>
  );
}
