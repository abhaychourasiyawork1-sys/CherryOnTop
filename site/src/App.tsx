import { useEffect, type JSX } from 'react';
import { flushOnPageHide } from './analytics/tracker';
import { Section } from './components/Section';
import { Reveal } from './components/Reveal';
import { HeroSection } from './sections/HeroSection';
import { PromoVideo } from './components/PromoVideo';
import { ProblemSection } from './sections/ProblemSection';
import { OrganizationSection } from './sections/OrganizationSection';
import { MandateSection } from './sections/MandateSection';
import { ExecutionSection } from './sections/ExecutionSection';
import { AccountabilitySection } from './sections/AccountabilitySection';
import { LongRunningMemorySection } from './sections/LongRunningMemorySection';
import { BenchmarkSection } from './sections/BenchmarkSection';
import { ArchitectureSection } from './sections/ArchitectureSection';
import { TrustSection } from './sections/TrustSection';
import { LaunchSection } from './sections/LaunchSection';
import { SiteHeader } from './components/SiteHeader';
import { SiteFooter } from './components/SiteFooter';
import { DemoControllerProvider } from './demo/controller';
import { PageDepthIndicator } from './components/DepthIndicator';
import { SITE_CONTENT } from './content';

const PROMO_VIDEO_SRC = import.meta.env.VITE_PROMO_VIDEO_URL || '/media/cherryontop-promo.mp4';
const PROMO_VIDEO_POSTER = '/media/cherryontop-promo-poster.jpg';
const PROMO_VIDEO_TRANSCRIPT_URL = '/media/cherryontop-promo-transcript.txt';
const PROMO_VIDEO_TRANSCRIPT =
  'A single goal, "Build a customer platform," resolves into an accountable organization ' +
  '(Frontend, Backend, Data, Verification) operating under a budget and authority boundary. ' +
  'Execution runs, a verification check fails, the system investigates and corrects it, then ' +
  're-validates. The run ends VERIFIED with a Decision Receipt recording what happened.';

export default function App(): JSX.Element {
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') flushOnPageHide();
    }
    window.addEventListener('pagehide', flushOnPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushOnPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return (
    <div className="site-shell">
      <SiteHeader />

      <main>
        <DemoControllerProvider>
          <div className="demo-story" data-demo-root>
          <section
            id="product"
            className="hero-section"
            aria-label="AI teams you can hold accountable."
            data-depth="story"
            data-rhythm="sparse"
          >
            <div className="container">
              <HeroSection />
            </div>
          </section>

          <Section id="how-it-works" title="See how it works" depth="story" rhythm="sparse">
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

          <section id="problem" className="site-section" data-depth="story" data-rhythm="still">
            <div className="container">
              <Reveal>
                <ProblemSection />
              </Reveal>
            </div>
          </section>

          <Section
            id="organization"
            title="One goal. An accountable AI organization."
            body={SITE_CONTENT.organization.body}
            depth="product"
            rhythm="dense"
          >
            <Reveal>
              <OrganizationSection />
            </Reveal>
          </Section>

          <Section
            id="mandate"
            title={SITE_CONTENT.mandate.headline}
            depth="product"
            rhythm="focused"
          >
            <Reveal>
              <MandateSection />
            </Reveal>
          </Section>

          <Section id="execution" title={SITE_CONTENT.execution.headline} depth="product" rhythm="active">
            <Reveal>
              <ExecutionSection />
            </Reveal>
          </Section>

          <Section id="proof" title={SITE_CONTENT.receipt.headline} depth="product" rhythm="rich">
            <Reveal>
              <AccountabilitySection />
            </Reveal>
          </Section>

          <Section id="memory" title={SITE_CONTENT.longRunning.headline} depth="product" rhythm="quiet">
            <Reveal>
              <LongRunningMemorySection />
            </Reveal>
          </Section>

          <Section id="benchmarks" title={SITE_CONTENT.benchmarks.headline} depth="technical" rhythm="analytical">
            <Reveal>
              <BenchmarkSection />
            </Reveal>
          </Section>

          <Section id="architecture" title={SITE_CONTENT.architecture.headline} depth="technical" rhythm="technical">
            <Reveal>
              <ArchitectureSection />
            </Reveal>
          </Section>

          <Section id="trust" title={SITE_CONTENT.trust.headline} depth="technical" rhythm="clean">
            <Reveal>
              <TrustSection />
            </Reveal>
          </Section>

          <Section id="launch" title={SITE_CONTENT.launch.headline} rhythm="quiet">
            <Reveal>
              <LaunchSection />
            </Reveal>
          </Section>
          </div>
        </DemoControllerProvider>
      </main>

      <PageDepthIndicator />
      <SiteFooter />
    </div>
  );
}
