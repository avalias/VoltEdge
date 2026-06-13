/**
 * Root — shows the Hero landing over a warm (always-mounted) terminal.
 * The terminal mounts immediately so its polls are live by the time the
 * visitor enters; the Hero overlays and fades out on "Enter terminal".
 */
import { useState } from 'react';
import App from './App';
import { Hero } from './components/Hero';

export default function Root() {
  const [entered, setEntered] = useState(false);
  return (
    <>
      <App />
      {!entered && <Hero onEnter={() => setEntered(true)} />}
    </>
  );
}
