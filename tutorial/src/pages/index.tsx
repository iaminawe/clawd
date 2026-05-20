import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="/00-overview">
            Start the Tutorial →
          </Link>
        </div>
      </div>
    </header>
  );
}

function Pitch() {
  return (
    <section className={styles.pitch}>
      <div className="container">
        <div className="row">
          <div className="col col--6">
            <h2>What this is</h2>
            <p>
              A 9-article walkthrough of replacing the OpenClaw third-party
              Claude harness with first-party tools — Claude Code CLI, the
              Claude Agent SDK, a hand-rolled Slack bot, scheduled
              <code> launchd </code> jobs, Paperclip orchestration, and
              <code> bw serve </code> secrets — while keeping the same
              persistent &quot;AI familiar&quot; experience.
            </p>
          </div>
          <div className="col col--6">
            <h2>Who it&apos;s for</h2>
            <p>
              Solo developers running a long-lived agentic assistant on macOS
              who got hit by Anthropic&apos;s restriction on third-party
              harnesses using paid subscriptions, or who want a more
              decoupled, debuggable, future-proof stack than what the bundled
              gateway approach offers.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description={siteConfig.tagline}>
      <HomepageHeader />
      <main>
        <Pitch />
      </main>
    </Layout>
  );
}
