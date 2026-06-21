/**
 * Root — shows the story landing over a warm (always-mounted) terminal.
 * The terminal mounts immediately so its polls are live by the time the
 * visitor enters; the Landing overlays and fades out on "Enter the terminal".
 */
import { useState } from 'react';
import App from './App';
import { Landing } from './Landing';

export default function Root() {
  const [entered, setEntered] = useState(false);
  return (
    <>
      <App />
      {!entered && <Landing onEnter={() => setEntered(true)} />}
    </>
  );
}
